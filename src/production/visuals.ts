import { existsSync } from "node:fs";
import path from "node:path";
import { config, ROOT } from "../server/config.ts";
import type { Story, Category, VisualPreview, PreviewFrame } from "../types.ts";
import type { RenderPlan, Shot, Truth, Motion, Caption } from "../render/types.ts";
import type { StoryWorld, ResearchPackage } from "./pipelineTypes.ts";
import type { Narration } from "./narration.ts";
import { PRICING, round } from "../server/pricing.ts";
import { groupBeats, words } from "./text.ts";
import { buildCues } from "./subtitles.ts";
import { inStory, mediaRel } from "./paths.ts";
import { writePlaceholderStill, referenceFrame } from "./mockAssets.ts";
import { copyFileSync } from "node:fs";
import { generateImageFile, respondJson } from "../providers/openai.ts";
import { generateMotion } from "../providers/runway.ts";
import { fetchArchive } from "./wikimedia.ts";

export const FPS = 30;

const ACCENTS: Record<Category, string> = {
  "Conflicts & Standoffs": "#d9a066",
  "Money & Deception": "#cda24e",
  Disasters: "#c76b4a",
  "Escapes & Operations": "#5c6b3c", // PB1's Operation Paul Bunyan olive

  "Strange Everyday History": "#b98a5e",
};

export function accentFor(category: Category): string {
  return ACCENTS[category] ?? "#d9a066";
}

// One planned shot, kept plain so it can live in the job scratch and survive a
// restart. `path` (still) and `motionPath` (clip) are filled during acquisition.
export interface PlannedShot {
  index: number;
  truth: Truth;
  motion: Motion;
  wantsMotion: boolean;
  prompt: string;
  // Planning intent: why this visual exists and what it must / must not show.
  // Every shot must answer "what should the viewer understand from this visual?".
  purpose: string;
  mustShow: string[];
  mustNotShow: string[];
  archiveQuery?: string;
  useMaster?: boolean; // pass the master still as a reference only where continuity helps
  caption?: Caption;
  source?: string;
  wordStart: number;
  wordEnd: number;
  path?: string;
  mediaType?: "image" | "video";
  motionPath?: string;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

// ---------------------------------------------------------------------------
// v1A.2 Visual Director
//
// ONE structured planning call decides what the viewer should SEE across BOTH
// films. The model answers, for every narration beat, "what should the viewer
// understand from this image?" and returns the medium (archive / reconstruction
// / graphic), a concrete purpose, must-show / must-not-show constraints grounded
// in the verified facts, whether motion helps, and a specific scene.
//
// Timing stays local: narration beats are built here from the script with the
// existing sentence grouping, only the beat id + excerpt is sent to the model,
// and word ranges / shot indexes are mapped back locally afterwards. Everything
// after planning is ordinary deterministic code. Mock mode never calls a
// provider - it uses a tiny deterministic fallback planner.
// ---------------------------------------------------------------------------

// Roughly how many meaningful visual beats a film should have, from the narration
// length. buildBeats splits long sentences on punctuation to actually reach this
// density (a static, sentence-bounded plan was the v1A.2 weakness), but never
// manufactures empty fragments to hit the number.
function targetBeats(kind: "long" | "short", durationSec: number): number {
  return kind === "long" ? clamp(Math.round(durationSec / 8), 30, 40) : clamp(Math.round(durationSec / 4), 14, 18);
}

// One narration beat: an excerpt of the script tied to its word range. The model
// only ever sees id + excerpt; the word range is mapped back locally afterwards.
export interface Beat {
  id: number;
  excerpt: string;
  wordStart: number;
  wordEnd: number;
}

export function buildBeats(kind: "long" | "short", script: string, narration: Narration): Beat[] {
  const groups = groupBeats(script, targetBeats(kind, narration.durationSec));
  return groups.map((g, id) => ({ id, excerpt: g.text, wordStart: g.wordStart, wordEnd: g.wordEnd }));
}

// What the Visual Director decides for one beat. Deliberately small - just enough
// to build a PlannedShot. Timing and shot index are added locally, never by the
// model.
export interface DirectorShot {
  beatId: number;
  purpose: string;
  truth: Truth;
  mustShow: string[];
  mustNotShow: string[];
  wantsMotion: boolean;
  motion: Motion;
  prompt: string; // a specific scene / framing for this beat (the creative seed)
  archiveQuery: string; // empty unless truth === "archive"
  useMaster: boolean;
  // v1A.4, internal only (never reaches PlannedShot or the DB). When true on a
  // LATER beat, this beat introduces no new concrete drawable visual, so assembly
  // keeps showing the previous shot and extends its word range instead of
  // inventing filler. Ignored on beat 0, which must always create a real visual.
  reusePrevious?: boolean;
}

export interface DirectorPlans {
  long: DirectorShot[];
  short: DirectorShot[];
}

export interface DirectorInput {
  story: Story;
  research: ResearchPackage;
  scripts: { long: string; short: string };
  beats: { long: Beat[]; short: Beat[] };
}

// A Visual Director turns the story + beats into both plans in one shot. Injected
// in tests; the default picks the live OpenAI director or the offline fallback.
export type VisualDirector = (input: DirectorInput, respond?: typeof respondJson) => Promise<DirectorPlans>;

const TRUTHS: readonly Truth[] = ["archive", "reconstruction", "graphic"];
const MOTIONS: readonly Motion[] = ["hold", "push", "pan-left", "pan-right"];

const directorShotSchema = {
  type: "object",
  additionalProperties: false,
  required: ["beatId", "purpose", "truth", "mustShow", "mustNotShow", "wantsMotion", "motion", "prompt", "archiveQuery", "useMaster", "reusePrevious"],
  properties: {
    beatId: { type: "integer" },
    purpose: { type: "string" },
    truth: { type: "string", enum: TRUTHS as unknown as string[] },
    mustShow: { type: "array", items: { type: "string" } },
    mustNotShow: { type: "array", items: { type: "string" } },
    wantsMotion: { type: "boolean" },
    motion: { type: "string", enum: MOTIONS as unknown as string[] },
    prompt: { type: "string" },
    archiveQuery: { type: "string" },
    useMaster: { type: "boolean" },
    reusePrevious: { type: "boolean" },
  },
};

const DIRECTOR_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["long", "short"],
  properties: {
    long: { type: "array", items: directorShotSchema },
    short: { type: "array", items: directorShotSchema },
  },
};

export const DIRECTOR_INSTRUCTIONS = `You are the Visual Director for PastBriefly, a factual historical documentary. You are given one story, its FINAL verified research (facts, moments, sources, story world), the Long and Short scripts, and a list of narration beats for each film. Decide, for every beat, what the viewer should SEE. Return strict JSON: one decision object per beat id, for both films.

THE CENTRAL RULE - for every beat answer: "What should the viewer understand from this image?" The purpose must describe a VISIBLE idea a storyboard artist could draw. GOOD: "Establish the Soviet submarine visibly grounded on rocks inside the narrow Swedish archipelago." "Show Swedish patrol boats forming a perimeter around the grounded submarine." "Explain how close the grounding site was to the Karlskrona naval base." BAD (never do this): "Show Cold War", "Show Soviet Sweden", "Create tension", "Espionage suspicions", or any mood/atmosphere label. If a human could not draw it, it is too vague - rewrite it.

ONE FRAME MEANS ONE FRAME - every beat is ONE drawable frame: one location, one moment, one primary action, from a single vantage. Explicitly forbidden: a collage, a montage, a split screen, a split-focus that shows two different actions at once, a "through a window / through a hatch" trick used to depict a second event, a "series of shots", a before/after, or any composite that stitches together separate scenes, locations or actions. A graphic may carry several marks on ONE map or diagram ONLY because they all explain one spatial fact; it must still communicate one concrete piece of information, not a collage of unrelated scenes.

FACTUAL GROUNDING (HARD FACTUAL VISUAL RULE) - the verified facts are hard constraints. Any concrete, event-specific thing you place on screen must be supported by the final fact sheet, the verified research moments, or the audited narration beat itself. Do NOT invent event-specific ships, families, crowds, meetings, equipment upgrades, public reactions, press conferences, documents, weather, military deployments, rooms or interiors, or actions just because they would make a nice image. Generic period/location presentation is acceptable ONLY when it does not claim that a specific historical event happened. If no supported drawable visual exists for a beat, set reusePrevious=true rather than inventing one. mustShow lists only the concrete things needed to communicate the beat. mustNotShow protects against obvious historical mistakes (wrong flag, wrong era, a vessel freely underway when it is aground, active battle when there was none). Keep both lists short and concrete.

NO NEW VISUAL (reusePrevious) - you see every beat in order. Beat 0 must always create a real visual. On any LATER beat where the narration introduces no new concrete, factual, useful thing to show - it merely restates, reflects on, or abstractly comments - set reusePrevious=true. That keeps the previous meaningful visual on screen instead of inventing filler; your other fields for that beat still fill the schema but are ignored. reusePrevious IS THE DEFAULT for a beat whose narration mainly communicates interpretation, suspicion, uncertainty, consequence, policy significance, tension, transition, summary or reflection, when the verified facts and research give NO specific supported drawable event or object for it: in that case reusePrevious MUST be true. Do NOT invent a physical scene just so every beat gets a new image. Do NOT overuse it either: choose a genuinely new visual whenever the story introduces a real new event, object, location, action or piece of evidence.

PLAUSIBLE IS NOT SUPPORTED - historically plausible is not enough. Every event-specific visual must be supported by the verified facts, the research moments, the sources, or the narration itself. You may NOT invent meetings, rooms, confrontations, crowds, reactions, equipment use, public scenes or military actions merely because they sound likely for the period or the situation. If there is no supported drawable event or object for a beat, set reusePrevious=true rather than staging a plausible-looking scene.

DO NOT DRAMATIZE NEGATIONS OR LIMITATIONS - when the narration says something did not happen, was prevented, was limited, was refused, or remained uncertain, do NOT invent a confrontation or action to visualise that absence. For "access was limited", do NOT stage someone physically blocking another person at a hatch. Instead set reusePrevious, or use a supported exterior or detail already established by the facts or research.

MEDIA CHOICE (truth) from story meaning:
- "archive": real historical media could directly show or prove the beat (the actual event, real people, contemporary press/photo/document). Choose archive ONLY when a specific real historical asset (a real photo, document, film or identifiable person/scene) plausibly exists to be found. Provide a specific, event-specific archiveQuery targeting that event/person/object - never generic like "Sweden 1981", and never use archive to outsource a vague idea like "public concern", "defence preparedness" or "national anxiety". Do NOT choose archive for an abstract outcome such as an apology, a reimbursement, a policy change or public concern, unless the research or sources point to a real photo, document or event that captured it. For such abstract narration, use a concrete supported object or event if one exists, a graphic that states a concrete fact, otherwise reusePrevious.
- "reconstruction": a physical event that must be shown but lacks suitable archive material.
- "graphic": information that is clearer spatially or informationally - geography, route, distance, positions, timeline, a simple comparison. Never choose a graphic for atmosphere, and never a generic "military infographic". For a graphic, purpose and mustShow must state the exact information (e.g. purpose "Show the grounding site relative to the Karlskrona naval base", mustShow ["Karlskrona naval base","grounding location","relative distance"]).
archiveQuery is "" for non-archive beats.

ARCHIVE FALLBACK MUST NOT FAKE HISTORY - for an archive beat, archiveQuery seeks the real historical material, but your prompt is the RECONSTRUCTION FALLBACK used only if archive acquisition fails. That fallback must NEVER fabricate a newspaper headline, a communiqué's text, a report's text, a TV broadcast, a logo, a press photograph, or any readable historical document. Instead describe the surrounding physical scene with no readable text: e.g. for a real Soviet communiqué, "a period diplomatic office, officials handling documents, no readable text", NOT an AI-generated fake Soviet communiqué in Cyrillic. The same holds for newspapers and broadcasts.

SCENE (prompt) - a specific single frame for this beat, grounded in purpose + mustShow + mustNotShow + the story world + the beat. Describe a concrete composition suited to the subject (a wide elevated vantage for geography, a medium eye-level shot for people mid-action, a tight detail for an instrument or measurement). Do NOT return generic prompts like "cinematic Cold War scene" or "dramatic military atmosphere", and do not rotate through a fixed set of camera shapes.

PROGRESSION / NO REPETITION - you see the whole sequence, so make it progress. Successive shots must not restate the same composition or information. Do not repeatedly return to the same image (e.g. "the submarine on the rocks with Swedish boats") unless the new shot communicates a genuinely new event. When later narration references an event already shown, use a supported new detail, a map, a document/archive, or reusePrevious - do NOT create a new camera angle merely to claim visual variety. If a previous shot already communicated the same geography or spatial relationship, set reusePrevious rather than generating another similar map from a slightly different angle. A new shot must add new information. Prefer a meaningful arc such as establish -> geography -> discovery -> containment -> interaction -> detail/measurement -> evidence -> departure. This is guidance, not a fixed sequence to copy.

BEAT TARGETS ARE GUIDANCE, NOT A QUOTA - the beat list gives roughly 30-40 beats for Long and 14-18 for Short. These are loose upper-direction targets, not a quota. Do not manufacture extra visual cuts merely to hit a number: a smaller number of meaningful, supported visuals (with reusePrevious covering the rest) is better than filler.

MOTION - set wantsMotion true only when REAL movement improves the beat (a vessel moving, people approaching or interacting, refloating or towing, a physical operation). Keep it false for an archive photo, a document, a map/graphic, a static instrument detail, a portrait or static evidence. When wantsMotion is true, pick a motion that matches the movement (push for approach, pan-left/pan-right for lateral movement); otherwise motion is "hold". Never add motion just to make the film feel busy.

MASTER (useMaster) - true only where visual continuity genuinely helps (a recurring person, a recurring vessel/object, the same environment where consistency matters). Most shots do NOT use the master. Never on a graphic.

INDEPENDENCE - plan the Short film independently from the Long film. The Short has a faster rhythm with one immediate beat each; the Long has room for more geography, evidence and context. Do NOT derive the Short by cropping or summarising the Long.

Return one decision per beat id given, for both "long" and "short".`;

// The one live planning call. Builds a single payload with the story, verified
// facts, both scripts and both beat lists, and returns both plans in one call.
export const openAiVisualDirector: VisualDirector = async (input, respond = respondJson) => {
  return respond<DirectorPlans>({
    instructions: DIRECTOR_INSTRUCTIONS,
    input: directorPayload(input),
    schemaName: "visual_plan",
    schema: DIRECTOR_SCHEMA,
  });
};

function directorPayload(input: DirectorInput): string {
  const { story, research, scripts, beats } = input;
  const w = research.world;
  const beatLines = (bs: Beat[]) => bs.map((b) => `#${b.id}: ${b.excerpt}`).join("\n");
  return [
    `STORY: ${story.title}`,
    `YEAR: ${story.year}`,
    `PLACE: ${story.place}`,
    `HOOK: ${story.hook}`,
    `SUMMARY: ${research.summary}`,
    "",
    "VERIFIED FACTS (hard visual constraints - do not contradict these):",
    (research.facts ?? []).map((f) => `- ${f.fact}`).join("\n") || "- (none provided)",
    "",
    "MOMENTS:",
    research.moments.map((m) => `- ${m.title}: ${m.detail}`).join("\n") || "- (none)",
    "",
    "SOURCES:",
    research.sources.map((s) => `- ${s.title}`).join("\n") || "- (none)",
    "",
    "STORY WORLD:",
    `- period: ${w.period}`,
    `- place: ${w.place}`,
    `- palette: ${w.palette}`,
    `- visual direction: ${w.visualDirection}`,
    `- recurring people: ${w.recurringPeople.join("; ") || "(none)"}`,
    `- recurring locations: ${w.recurringLocations.join("; ") || "(none)"}`,
    "",
    `LONG SCRIPT:\n${scripts.long}`,
    "",
    `SHORT SCRIPT:\n${scripts.short}`,
    "",
    "LONG BEATS (return one decision per beat id, in order):",
    beatLines(beats.long),
    "",
    "SHORT BEATS (plan the Short film independently - do NOT crop the Long plan):",
    beatLines(beats.short),
    "",
    'Return JSON { "long": [...], "short": [...] } with one decision object per beat id above.',
  ].join("\n");
}

// Offline, deterministic planner for mock mode, tests and the demo. It is NOT the
// production brain - just a tiny valid plan so the pipeline runs without any
// provider. It never derives meaning from keywords.
export const fallbackVisualDirector: VisualDirector = async (input) => ({
  long: fallbackDecisions("long", input.beats.long, input.research),
  short: fallbackDecisions("short", input.beats.short, input.research),
});

function fallbackDecisions(_kind: "long" | "short", beats: Beat[], research: ResearchPackage): DirectorShot[] {
  const w = research.world;
  const place = w.place || "the location";
  return beats.map((beat, i): DirectorShot => {
    const graphic = i > 0 && i % 5 === 4;
    const truth: Truth = graphic ? "graphic" : "reconstruction";
    const moving = truth === "reconstruction" && i > 0 && i % 6 === 3;
    return {
      beatId: beat.id,
      purpose: graphic
        ? `Show where this happened at ${place} and how the places relate.`
        : `Show the key action of this moment at ${place}.`,
      truth,
      mustShow: graphic
        ? [place, "the spatial relationship between them"]
        : [w.recurringPeople[0], `the ${w.period} ${place} setting`].filter(Boolean) as string[],
      mustNotShow: ["modern vehicles, equipment or clothing"],
      wantsMotion: moving,
      motion: moving ? "push" : "hold",
      prompt: beat.excerpt.slice(0, 120),
      archiveQuery: "",
      useMaster: truth === "reconstruction" && i > 0 && i % 4 === 2,
    };
  });
}

const defaultDirector: VisualDirector = (input) => (config.mode === "live" ? openAiVisualDirector(input) : fallbackVisualDirector(input));

// Plan both films in ONE Visual Director call. Beats (and therefore timing and
// shot indexes) are built and mapped locally; the director only decides what each
// beat should show. Returns the Long and Short PlannedShot lists together.
export async function planVisuals(
  story: Story,
  research: ResearchPackage,
  scripts: { long: string; short: string },
  narration: { long: Narration; short: Narration },
  director: VisualDirector = defaultDirector,
): Promise<{ long: PlannedShot[]; short: PlannedShot[] }> {
  // Live planning is only as truthful as its inputs. A ResearchPackage with no
  // verified facts (e.g. legacy research from before the fact sheet) defeats
  // factual visual grounding, so refuse rather than plan ungrounded live visuals.
  // Mock mode keeps its deterministic fallback, which needs no facts.
  if (config.mode === "live" && !(research.facts && research.facts.length > 0)) {
    throw new Error("Visual planning requires verified facts. Re-run the current research/text pipeline before planning visuals.");
  }
  const beats = {
    long: buildBeats("long", scripts.long, narration.long),
    short: buildBeats("short", scripts.short, narration.short),
  };
  const plans = await director({ story, research, scripts, beats });
  return {
    long: assembleShots("long", beats.long, plans?.long ?? [], story, research),
    short: assembleShots("short", beats.short, plans?.short ?? [], story, research),
  };
}

// Map the director's per-beat decisions back onto the local beats: one shot per
// beat, in narration order, with the word range and shot index assigned locally
// (never by the model). Every value is validated and the final image prompt is
// composed deterministically from purpose + constraints + the model's scene, so
// prompt hygiene (aspect ratio, palette, anachronism guards) can never be lost.
// Only the opener carries a headline caption; later beats carry none.
function assembleShots(
  kind: "long" | "short",
  beats: Beat[],
  decisions: DirectorShot[],
  story: Story,
  research: ResearchPackage,
): PlannedShot[] {
  const world = research.world;
  const byId = new Map<number, DirectorShot>();
  for (const d of decisions) if (d && typeof d.beatId === "number" && !byId.has(d.beatId)) byId.set(d.beatId, d);

  const shots: PlannedShot[] = [];
  beats.forEach((beat, beatPos) => {
    const d = byId.get(beat.id);

    // v1A.4 "no new visual": a LATER beat that introduces nothing new to show
    // reuses the previous shot. We create NO new PlannedShot (so no extra media
    // spend) and simply extend the previous shot's word range to cover this beat,
    // preserving its visual. Beat 0 always creates a real visual, and reuse needs
    // a previous shot to extend - otherwise we fall through and create one.
    if (beatPos > 0 && d?.reusePrevious && shots.length > 0) {
      shots[shots.length - 1].wordEnd = beat.wordEnd;
      return;
    }

    const index = shots.length;
    const truth = validTruth(d?.truth);
    const purpose = cleanPurpose(d?.purpose, story, world, truth);
    const { mustShow, mustNotShow } = cleanConstraints(d, truth, story, world);
    const useMaster = truth === "reconstruction" && !!d?.useMaster;
    const wantsMotion = truth === "reconstruction" && !!d?.wantsMotion;
    let motion: Motion = "hold";
    if (wantsMotion) {
      const m = validMotion(d?.motion);
      motion = m === "hold" ? "push" : m;
    }
    const scene = (d?.prompt ?? "").trim() || beat.excerpt;
    const prompt =
      truth === "graphic"
        ? graphicPrompt(world, story, purpose, mustShow, scene)
        : reconstructionPrompt(kind, world, story, purpose, mustShow, mustNotShow, scene, useMaster);
    const archiveQuery = truth === "archive" ? (d?.archiveQuery?.trim() || archiveQueryFor(story, beats.length, beatPos)) : undefined;
    const caption: Caption | undefined =
      index === 0 ? { kicker: story.year, text: story.title, emphasis: kind === "short" ? story.place : undefined, variant: "opener" } : undefined;

    shots.push({
      index,
      truth,
      motion,
      wantsMotion,
      prompt,
      purpose,
      mustShow,
      mustNotShow,
      archiveQuery,
      useMaster,
      caption,
      source: undefined,
      wordStart: beat.wordStart,
      wordEnd: beat.wordEnd,
    });
  });
  return shots;
}

function validTruth(t: unknown): Truth {
  return TRUTHS.includes(t as Truth) ? (t as Truth) : "reconstruction";
}

function validMotion(m: unknown): Motion {
  return MOTIONS.includes(m as Motion) ? (m as Motion) : "push";
}

// A purpose must state a visible idea. Trust a real one from the director; only
// synthesise a concrete fallback when it is missing.
function cleanPurpose(p: string | undefined, story: Story, world: StoryWorld, truth: Truth): string {
  const s = (p ?? "").trim();
  if (s.length >= 6) return s;
  const place = world.place || story.place;
  if (truth === "graphic") return `Show where this happened at ${place} and how the places relate.`;
  if (truth === "archive") return `Show genuine historical material from ${story.title}.`;
  return `Show the key action of this moment at ${place}.`;
}

// Universal generated-image hygiene that can never contradict a scene: it forbids
// only artefacts no beat would ever legitimately need to SHOW. Scene-specific
// restrictions (era, flags, behaviour) are owned by the director's mustNotShow,
// so we never append deterministic content guards that could fight its mustShow.
const IMAGE_HYGIENE = "logos, watermarks, signatures or any unintended readable text";

// One shared reconstruction ruleset for EVERY generated reconstruction: the per-shot
// stills, the archive reconstruction fallback, and the master. The successful PB1
// proof showed the strongest direction is a historical editorial illustration, not a
// fake archival photograph, so this opens with that PB1 language. It then KEEPS every
// factual / anti-slop safeguard learned in Still Generation v1 (minimum people, no
// line-ups or ceremonial posing, no invented flags/emblems/insignia, no modern
// PPE/equipment, period-appropriate plain clothing). The symbol/insignia rule defers
// to the scene's own "Must show" list, so it can never suppress a symbol a beat needs.
const RECON_REALISM =
  "Historical editorial illustration in the PastBriefly reconstruction style: painterly but detailed, with textured physical materials, a restrained muted palette, atmospheric natural light and strong subject separation; slightly imperfect and hand-rendered rather than photoreal, serious and grounded, not cartoonish. This is a documentary reconstruction illustration, not a fake archival photograph: no glossy finish, no concept art, no propaganda-poster styling, no hyper-real AI photography. Candid and imperfect, with natural asymmetry and ordinary real-world posture; the people are occupied by the real action, not posing or facing the viewer. Use only the minimum number of people the action needs: no line-ups, no rows of people facing the same way, no symmetrical or ceremonial groupings, no crowd all looking toward the viewer, no unnecessary background figures. Do not add flags, banners, emblems, insignia, national symbols, medals, uniform patches, logos or readable markings, and do not decorate vehicles, hulls, walls or uniforms with them, unless such an item is explicitly named in Must show above. Do not invent modern PPE, modern tactical clothing, modern electronics, contemporary patches or badges, or modern helmets or equipment unless Must show requires them; when exact clothing or equipment is unspecified, use plain, plausible period-appropriate workwear or uniforms without decorative insignia.";

// The one canonical PB1 style reference: the tracked frame that produced the
// successful U 137 PB1 proof. EVERY generated reconstruction (per-shot stills, the
// archive reconstruction fallback, and the master) uses ONLY this single image for
// visual style. Deliberately boring and predictable - no per-scene/category/story
// selection, and StoryWorld.referenceImages is not repurposed here. Resolved against
// the repo root (not MEDIA_DIR) because it is a tracked asset, not generated media.
export const PB1_STYLE_REFERENCE = path.join(ROOT, "media", "style", "pb1", "tambora-summer-snow.png");

// Resolve the canonical PB1 style reference for a live generation. If the tracked
// file is missing, fail clearly rather than silently generating in a different
// visual style.
function pb1StyleReference(): string {
  if (!existsSync(PB1_STYLE_REFERENCE)) {
    throw new Error(`PB1 style reference missing at ${PB1_STYLE_REFERENCE}. Restore media/style/pb1/tambora-summer-snow.png before generating reconstructions.`);
  }
  return PB1_STYLE_REFERENCE;
}

// The PB1 reference is style ONLY. This concise, shared note tells the image model how
// to use the reference image(s), so the same instruction is not duplicated across the
// reconstruction and master prompts. When a master continuity reference is also passed
// (useMaster), a second sentence marks it as subject/world continuity only, so the
// master can never displace the PB1 style reference.
const PB1_STYLE_ROLE =
  "Use the provided style reference image only for its illustration treatment, texture, palette, lighting, atmosphere and visual character; do not copy its people, landscape, objects, composition or historical content.";
const PB1_MASTER_ROLE =
  "A second reference image, when present, is a subject and world continuity reference only: match the recurring subject and setting it shows, not its composition.";
const PB1_SCENE_SOURCE = "The factual scene is defined only by this prompt's Purpose, Scene, Must show and Do not show.";

function pb1ReferenceNote(useMaster: boolean): string {
  return useMaster ? `${PB1_STYLE_ROLE} ${PB1_MASTER_ROLE} ${PB1_SCENE_SOURCE}` : `${PB1_STYLE_ROLE} ${PB1_SCENE_SOURCE}`;
}

// Reference images for a live reconstruction still. Reconstructions get the canonical
// PB1 style reference FIRST; a useMaster shot adds the existing master SECOND for
// subject/world continuity (order fixed so the master never replaces the PB1 style
// reference). Graphics and real archive stills get no PB1 reference. acquireStill has
// already converted a failed-archive shot to "reconstruction" before this is called,
// so an archive fallback is treated like any other reconstruction.
export function stillReferencePaths(story: Story, shot: PlannedShot, masterRef: string | null): string[] | undefined {
  if (shot.truth !== "reconstruction") return undefined;
  const refs = [pb1StyleReference()];
  if (shot.useMaster && masterRef && existsSync(inStory(story.slug, masterRef))) refs.push(inStory(story.slug, masterRef));
  return refs;
}

// The master/hero is itself a PB1-style reconstruction, so it generates through the
// edit/reference path using only the canonical PB1 style reference.
export function masterReferencePaths(): string[] {
  return [pb1StyleReference()];
}

// Keep the director's concrete constraints verbatim (only trimmed, deduped and
// capped) and guarantee a non-empty must-show. mustNotShow is the director's own
// fact-grounded list - no deterministic guards are injected, so it can never
// contradict a scene-specific mustShow. Universal image hygiene lives in the
// prompt envelope instead.
function cleanConstraints(d: DirectorShot | undefined, truth: Truth, story: Story, world: StoryWorld): { mustShow: string[]; mustNotShow: string[] } {
  const place = world.place || story.place;
  let mustShow = dedupe((d?.mustShow ?? []).map((x) => String(x).trim()).filter(Boolean)).slice(0, 6);
  if (!mustShow.length) {
    mustShow =
      truth === "graphic"
        ? [place, "the spatial relationship between them"]
        : ([world.recurringPeople[0], `the ${world.period} ${place} setting`].filter(Boolean) as string[]);
  }
  const mustNotShow = dedupe((d?.mustNotShow ?? []).map((x) => String(x).trim()).filter(Boolean)).slice(0, 6);
  return { mustShow, mustNotShow };
}

function dedupe(list: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const x of list) {
    const key = x.toLowerCase().trim();
    if (x && !seen.has(key)) {
      seen.add(key);
      out.push(x);
    }
  }
  return out;
}

// The final image prompt for a reconstruction. Built from the beat itself - the
// purpose, the director's constraints and specific scene, the period and place -
// not from a blanket story-world sentence (that used to inject the same
// submarine-and-coast subjects into indoor, document and aftermath scenes alike).
// The story world informs STYLE only (palette). This same builder is the clean
// reconstruction FALLBACK for an archive beat when acquisition finds no material,
// so it never asks the model to fake archival footage.
function reconstructionPrompt(
  kind: "long" | "short",
  world: StoryWorld,
  story: Story,
  purpose: string,
  mustShow: string[],
  mustNotShow: string[],
  scene: string,
  useMaster: boolean,
): string {
  const frame = kind === "short" ? "Vertical 9:16 composition" : "Wide 16:9 composition";
  const show = mustShow.length ? ` Must show: ${mustShow.join("; ")}.` : "";
  const avoid = mustNotShow.length ? ` Do not show: ${mustNotShow.join("; ")}.` : "";
  const setting = [world.place || story.place, world.period].filter(Boolean).join(", ");
  const where = setting ? ` Setting: ${setting}.` : "";
  return `Purpose: ${purpose}${show}${avoid} Scene: ${scene}.${where} ${frame}. Palette: ${world.palette}. ${RECON_REALISM} ${pb1ReferenceNote(useMaster)} Do not include ${IMAGE_HYGIENE}.`;
}

// A graphic describes the information it must convey (purpose + must-show), not a
// generic map/timeline template and never cinematic/reconstruction wording. Kept
// almost entirely visual - the readable explanation is left to the app's captions.
// The full director concept is used; it is never truncated. No new Remotion map
// engine here.
function graphicPrompt(world: StoryWorld, story: Story, purpose: string, mustShow: string[], scene: string): string {
  const show = mustShow.length ? ` It must make clear: ${mustShow.join("; ")}.` : "";
  const concept = scene ? ` Concept: ${scene}.` : "";
  return `Flat editorial information graphic, not a photographic scene. Purpose: ${purpose}${show}${concept} Region and period: ${story.place}, ${world.period}. Keep it almost entirely visual with minimal or no text - the app adds captions separately, so do not render paragraphs, labels or legends. Muted palette ${world.palette}, flat even lighting and no posed actors. Do not include ${IMAGE_HYGIENE}.`;
}

// A specific archive query per shot: place and year anchored, plus the salient
// words of the nearest story moment, so archive search targets that moment
// instead of one generic story-title query for every archive shot.
function archiveQueryFor(story: Story, groupCount: number, i: number): string {
  const m = story.moments[Math.min(story.moments.length - 1, Math.floor((i / Math.max(1, groupCount)) * story.moments.length))];
  const subject = m ? keyPhrase(`${m.title} ${m.detail}`) : "";
  return [story.place, story.year, subject].filter(Boolean).join(" ").trim();
}

// Candidate queries for one archive shot, ordered specific-to-broad so a narrow
// miss can still find real material before we reconstruct: event identifiers /
// proper nouns first, then the moment query, then title+year, then place+year.
// A bare place-only query is deliberately omitted - it returns unrelated modern
// location photography. Deduped and order-preserving.
export function archiveQueries(story: Story, specific: string): string[] {
  const idents = eventIdentifiers(story).slice(0, 4).join(" ");
  const candidates = [idents, specific, `${story.title} ${story.year}`, `${story.place} ${story.year}`];
  const out: string[] = [];
  for (const c of candidates) {
    const q = c.trim();
    if (q && !out.includes(q)) out.push(q);
  }
  return out;
}

const norm = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, "");
const wordsOf = (s: string): string[] => (s.match(/[A-Za-z0-9]+/g) ?? []).map((t) => t.toLowerCase());

// Distinctive proper nouns and identifiers (vessel/callsign-style tokens like
// "U 137" or "A-12") drawn generically from the story's own words - title, hook
// and moments - never from the bare place. Place tokens are excluded so a generic
// photo of the same city cannot look relevant. These anchor both the first
// archive query and the relevance check.
export function eventIdentifiers(story: Story): string[] {
  const text = [story.title, story.hook, ...story.moments.map((m) => `${m.title} ${m.detail}`)].join(" ");
  const placeTokens = new Set(wordsOf(story.place));
  const proper = text.match(/\b[A-Z][a-z]{2,}\b/g) ?? [];
  const idents = text.match(/\b[A-Za-z]{1,4}[-\s]?\d{1,4}\b/g) ?? [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of [...idents, ...proper]) {
    const clean = raw.trim();
    const key = norm(clean);
    if (key.length < 3 || seen.has(key)) continue;
    if (placeTokens.has(clean.toLowerCase()) || STOPWORDS.has(clean.toLowerCase())) continue;
    seen.add(key);
    out.push(clean);
    if (out.length === 6) break;
  }
  return out;
}

// Terms a Wikimedia result's metadata must plausibly match to count as archive of
// this event: the event identifiers plus the historical year. Not the place alone.
export function relevanceTerms(story: Story): string[] {
  const terms = eventIdentifiers(story);
  const year = story.year?.trim();
  if (year && /\d/.test(year) && !terms.includes(year)) terms.push(year);
  return terms;
}

const STOPWORDS = new Set(["the", "and", "that", "with", "from", "into", "were", "when", "then", "their", "them", "this", "which", "would", "could", "after", "before", "about", "over", "between", "against"]);

// The most distinctive words of a moment: proper nouns plus longer content
// words, deduped and capped, to steer archive search toward real material.
function keyPhrase(text: string): string {
  const proper = text.match(/\b[A-Z][a-z]{2,}\b/g) ?? [];
  const long = words(text).filter((w) => w.length >= 6 && !STOPWORDS.has(w.toLowerCase()));
  const seen = new Set<string>();
  const picked: string[] = [];
  for (const w of [...proper, ...long]) {
    const clean = w.replace(/[^A-Za-z]/g, "");
    const key = clean.toLowerCase();
    if (clean.length < 3 || seen.has(key)) continue;
    seen.add(key);
    picked.push(clean);
    if (picked.length === 4) break;
  }
  return picked.join(" ");
}

// Resolve one shot's still. Live: OpenAI image (archive tried first for archive
// shots). Mock: a labelled placeholder. Falls back to reconstruction if archive
// is unavailable so a reconstruction never masquerades as archive.
//
// The result says what actually happened, so the caller charges only real
// provider work: "generated" is one new OpenAI image (including an archive shot
// that fell back to reconstruction), "archive" is a real archive still, "existing"
// reused a file already on disk, and "mock" wrote a local placeholder.
export type StillResult = "generated" | "archive" | "existing" | "mock";

export async function acquireStill(story: Story, kind: "long" | "short", shot: PlannedShot, masterRef: string | null): Promise<StillResult> {
  const rel = `images/${kind}-${String(shot.index).padStart(2, "0")}.png`;
  const abs = inStory(story.slug, rel);
  const size = kind === "short" ? { w: 1080, h: 1920, oa: "1024x1536" } : { w: 1920, h: 1080, oa: "1536x1024" };

  if (shot.truth === "archive") {
    if (config.mode === "live" && shot.archiveQuery) {
      const archiveRel = `archive/${kind}-${String(shot.index).padStart(2, "0")}.jpg`;
      const dest = inStory(story.slug, archiveRel);
      // Try the moment-specific query first, then progressively broader ones. A
      // single narrow query (place + year + subject words) often returns nothing,
      // which is why every archive shot was falling back to reconstruction.
      const relevance = relevanceTerms(story);
      let got = null;
      for (const q of archiveQueries(story, shot.archiveQuery)) {
        got = await fetchArchive(q, dest, relevance).catch((e: any) => {
          console.warn(`[archive] query "${q}" errored: ${e?.message || e}`);
          return null;
        });
        if (got) break;
      }
      if (got) {
        shot.path = archiveRel;
        shot.mediaType = "image";
        shot.source = got.credit;
        shot.wantsMotion = false;
        return "archive";
      }
      console.warn(`[archive] no usable material for ${kind} shot ${shot.index}; using reconstruction`);
    }
    shot.truth = "reconstruction"; // no usable archive - do not fake it
  }

  if (existsSync(abs)) {
    shot.path = rel;
    shot.mediaType = "image";
    return "existing";
  }

  if (config.mode === "live") {
    // Every reconstruction (including an archive shot that fell back to
    // reconstruction) generates from the canonical PB1 style reference; a continuity
    // shot adds the master second. Graphics get no reference. See stillReferencePaths.
    const refs = stillReferencePaths(story, shot, masterRef);
    await generateImageFile({ prompt: shot.prompt, size: size.oa, outPath: abs, referencePaths: refs });
    shot.path = rel;
    shot.mediaType = "image";
    return "generated";
  }

  const ref = referenceFrame(inStory(story.slug, "refs"), shot.index);
  if (ref) {
    copyFileSync(ref, abs);
  } else {
    const label = shot.caption?.text ?? story.title;
    writePlaceholderStill(abs, { width: size.w, height: size.h, index: shot.index, label, truth: shot.truth, accent: accentFor(story.category) });
  }
  shot.path = rel;
  shot.mediaType = "image";
  return "mock";
}

// The master/hero prompt. The master is reused as a CONTINUITY reference for later
// shots, so it must be a neutral reference plate of the story's recurring subject,
// NOT another story scene. An earlier version asked for "a defining establishing
// reconstruction of <title>", which invented a whole scene (trucks, crews, shoreline
// activity, a staged composition) that then risked contaminating every shot that
// borrowed the master. So the master now shows only the recurring subject in a plain,
// action-free presentation and explicitly forbids people, vehicles, equipment,
// buildings, staged activity, symbols and readable markings. It keeps the SAME PB1
// reconstruction envelope and style-only reference note (not photographic wording), and
// stays grounded in the story title, place, period and palette without hardcoding any
// one story.
export function masterPrompt(story: Story, world: StoryWorld): string {
  const setting = [world.place || story.place, world.period].filter(Boolean).join(", ");
  const where = setting ? ` Period and place context, for palette and atmosphere only: ${setting}.` : "";
  return (
    `A neutral continuity reference plate of the single defining recurring subject at the center of ${story.title}: the main object, vessel or structure the story keeps returning to, shown on its own so later shots can stay visually consistent. This is a plain reference view of what that subject looks like in the PastBriefly world, NOT a scene or moment from the story. ` +
    `Present the subject by itself in a calm, simple exterior view from a neutral three-quarter or broad side angle, with enough of it visible to read its overall form and proportions, in a restrained, near-empty setting that only situates it. No narrative action and no invented supporting scene. ` +
    `Do not show: people, figures or crowds; vehicles, equipment or props other than the subject itself; buildings or built structures unless the subject itself is one; staged or narrative activity; dramatic action; weapons; flags, banners, emblems, insignia, national symbols, medals or decorative symbols; and no readable markings, text, numbers or signage on the subject or anywhere in the frame. ` +
    `Wide 16:9 composition. Palette: ${world.palette}.${where} ${RECON_REALISM} ${pb1ReferenceNote(false)} Do not include ${IMAGE_HYGIENE}.`
  );
}

// Generate the master/hero reconstruction used as a continuity reference (live).
export async function ensureMaster(story: Story, world: StoryWorld): Promise<string> {
  const rel = "images/hero.png";
  const abs = inStory(story.slug, rel);
  if (config.mode === "live") {
    await generateImageFile({ prompt: masterPrompt(story, world), size: "1536x1024", outPath: abs, referencePaths: masterReferencePaths() });
  } else if (!existsSync(abs)) {
    writePlaceholderStill(abs, { width: 1600, height: 900, index: 0, label: story.title, truth: "reconstruction", accent: accentFor(story.category) });
  }
  return rel;
}

// The Runway motion prompt. The source still already owns composition, subjects,
// clothing, vessels, environment and the PB1 illustration style, so the still
// prompt is NOT resent; this only asks Runway to animate what the frame implies,
// with the shot's purpose as brief context and its planned camera move.
const MOTION_BASE =
  "Animate only the movement already implied by this frame. " +
  "Preserve the exact composition, subjects, vessel design, clothing, environment, lighting, palette and illustrated PastBriefly style of the source image. " +
  "Subtle restrained documentary motion. Natural water, wind and environmental movement where visible. " +
  "Do not add or remove objects or people. No morphing, no new text, no dramatic action, no exaggerated body movement.";
const CAMERA: Record<Motion, string> = {
  hold: "Camera: locked off and still.",
  push: "Camera: a slow, gentle push in.",
  "pan-left": "Camera: a slow, gentle pan to the left.",
  "pan-right": "Camera: a slow, gentle pan to the right.",
};

export function motionPrompt(shot: Pick<PlannedShot, "purpose" | "motion">): string {
  const purpose = (shot.purpose ?? "").trim();
  return [MOTION_BASE, purpose ? `Context: ${purpose}` : "", CAMERA[shot.motion] ?? CAMERA.hold].filter(Boolean).join(" ");
}

// Live only: turn a still into motion (after the visual preview is approved).
// The local still is sent to Runway directly; no public asset URL is involved.
export async function acquireMotion(story: Story, kind: "long" | "short", shot: PlannedShot): Promise<void> {
  if (config.mode !== "live" || !shot.path) return; // mock keeps the transform motion
  const rel = `motion/${kind}-${String(shot.index).padStart(2, "0")}.mp4`;
  await generateMotion({ prompt: motionPrompt(shot), imagePath: inStory(story.slug, shot.path), kind, outPath: inStory(story.slug, rel) });
  shot.motionPath = rel;
  shot.mediaType = "video";
}

export function buildPreview(story: Story, longShots: PlannedShot[], shortShots: PlannedShot[]): VisualPreview {
  const all = [...longShots, ...shortShots];
  // Count each truth kind separately so graphics are not lumped into reconstruction.
  const archive = all.filter((s) => s.truth === "archive").length;
  const graphic = all.filter((s) => s.truth === "graphic").length;
  const reconstruction = all.filter((s) => s.truth === "reconstruction").length;
  const motionSelected = all.filter((s) => s.wantsMotion).length;
  // Both films, Long first, each frame tagged with its film so the preview can
  // show the Short as portrait instead of cropping it into a landscape card.
  const toFrames = (kind: "long" | "short", shots: PlannedShot[]): PreviewFrame[] =>
    shots
      .filter((s) => s.path)
      .map((s) => ({
        kind,
        path: mediaRel(story.slug, s.path!),
        truth: s.truth,
        motion: s.wantsMotion,
        caption: s.caption?.text ?? "",
      }));
  const frames = [...toFrames("long", longShots), ...toFrames("short", shortShots)];
  return {
    moments: all.length,
    archive,
    reconstruction,
    graphic,
    motionSelected,
    remainingMotionCost: config.mode === "live" ? round(motionSelected * PRICING.runway.video5s) : 0,
    frames,
  };
}

// Lay the resolved shots across the narration timeline and attach subtitles.
export function buildRenderPlan(kind: "long" | "short", story: Story, shots: PlannedShot[], narration: Narration, accent: string): RenderPlan {
  const width = kind === "short" ? 1080 : 1920;
  const height = kind === "short" ? 1920 : 1080;
  const audioEndFrame = Math.max(1, Math.ceil(narration.durationSec * FPS));
  const durationInFrames = audioEndFrame + Math.round(0.5 * FPS);
  const words = narration.words;
  const frameAt = (i: number) => (words[i] ? Math.round(words[i].start * FPS) : audioEndFrame);

  const ordered = [...shots].sort((a, b) => a.index - b.index);
  const base: Shot[] = ordered.map((s, i) => {
    const start = i === 0 ? 0 : frameAt(s.wordStart);
    const end = i === ordered.length - 1 ? durationInFrames : frameAt(ordered[i + 1].wordStart);
    return {
      id: `${kind}-${String(s.index).padStart(2, "0")}`,
      startFrame: start,
      endFrame: Math.max(start + 1, end),
      mediaType: s.motionPath ? "video" : "image",
      path: s.motionPath ?? s.path ?? "",
      truth: s.truth,
      motion: s.motion,
      caption: s.caption,
      source: s.source,
    };
  });

  // Never sit on one still too long: re-cut any over-long hold into sub-shots.
  const MAX_HOLD = Math.round(13 * FPS);
  const renderShots: Shot[] = base.flatMap((shot) => {
    const len = shot.endFrame - shot.startFrame;
    if (len <= MAX_HOLD || shot.mediaType === "video") return [shot];
    const parts = Math.ceil(len / MAX_HOLD);
    const per = Math.floor(len / parts);
    return Array.from({ length: parts }, (_, k) => ({
      ...shot,
      id: `${shot.id}-${k}`,
      startFrame: shot.startFrame + k * per,
      endFrame: k === parts - 1 ? shot.endFrame : shot.startFrame + (k + 1) * per,
      caption: k === 0 ? shot.caption : undefined,
      motion: shot.motion === "hold" ? (k % 2 ? "push" : "hold") : shot.motion,
    }));
  });

  return {
    kind,
    width,
    height,
    fps: FPS,
    durationInFrames,
    audio: narration.audioRel,
    audioEndFrame,
    accent,
    title: story.title,
    year: story.year,
    place: story.place,
    shots: renderShots,
    subtitles: buildCues(words, FPS, kind, durationInFrames),
  };
}
