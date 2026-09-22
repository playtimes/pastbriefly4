import { existsSync } from "node:fs";
import { config } from "../server/config.ts";
import type { Story, Category, VisualPreview, PreviewFrame } from "../types.ts";
import type { RenderPlan, Shot, Truth, Motion, Caption } from "../render/types.ts";
import type { StoryWorld } from "./pipelineTypes.ts";
import type { Narration } from "./narration.ts";
import { PRICING, round } from "../server/pricing.ts";
import { groupSentences, words } from "./text.ts";
import { buildCues } from "./subtitles.ts";
import { inStory, mediaRel } from "./paths.ts";
import { writePlaceholderStill, referenceFrame } from "./mockAssets.ts";
import { copyFileSync } from "node:fs";
import { generateImageFile } from "../providers/openai.ts";
import { generateMotion } from "../providers/higgsfield.ts";
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

function targetShots(kind: "long" | "short", durationSec: number): number {
  return kind === "long" ? clamp(Math.round(durationSec / 11), 12, 26) : clamp(Math.round(durationSec / 5), 8, 12);
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

// Decide what the viewer should see across the narration, tied to the words so
// visuals land with the story. Sparse editorial captions; a mix of media.
export function planShots(kind: "long" | "short", script: string, story: Story, world: StoryWorld, narration: Narration): PlannedShot[] {
  const count = targetShots(kind, narration.durationSec);
  const groups = groupSentences(script, count);
  const archiveEvery = kind === "long" ? 5 : 9; // a few archive candidates
  const graphicEvery = kind === "long" ? 6 : 7;

  // Which groups carry a story-moment caption (spread across the film).
  const momentAt = new Map<number, number>();
  story.moments.forEach((_, m) => {
    const g = Math.min(groups.length - 1, Math.round(((m + 0.7) / story.moments.length) * (groups.length - 1)));
    if (!momentAt.has(g)) momentAt.set(g, m);
  });

  let recon = 0; // advances only on reconstruction shots, so the shape cycle never repeats back-to-back
  let graphic = 0;

  return groups.map((group, i): PlannedShot => {
    let truth: Truth = "reconstruction";
    if (i > 0 && i % graphicEvery === 0) truth = "graphic";
    else if (i > 0 && i % archiveEvery === 0) truth = "archive";

    const wantsMotion = truth === "reconstruction" && i % 3 === 1;
    const motion: Motion = truth === "graphic" ? "hold" : wantsMotion ? pickMotion(i) : i % 4 === 0 ? "push" : "hold";

    let caption: Caption | undefined;
    if (i === 0) caption = { kicker: story.year, text: story.title, emphasis: kind === "short" ? story.place : undefined, variant: "opener" };
    else if (momentAt.has(i)) {
      const m = story.moments[momentAt.get(i)!];
      caption = { kicker: story.place, text: m.title, variant: "moment" };
    }

    let prompt: string;
    let useMaster = false;
    if (truth === "graphic") prompt = graphicPrompt(world, story, graphic++);
    else {
      const shape = SHOT_SHAPES[recon++ % SHOT_SHAPES.length];
      prompt = reconstructionPrompt(kind, world, group.text, shape);
      useMaster = shape.continuity; // the master helps recurring people/look, not every wide
    }

    return {
      index: i,
      truth,
      motion,
      wantsMotion,
      prompt,
      archiveQuery: truth === "archive" ? archiveQueryFor(story, groups.length, i) : undefined,
      useMaster,
      caption,
      source: undefined,
      wordStart: group.wordStart,
      wordEnd: group.wordEnd,
    };
  });
}

function pickMotion(i: number): Motion {
  return (["push", "pan-left", "pan-right"] as Motion[])[i % 3];
}

// Generic composition shapes rotated across reconstruction shots so successive
// stills differ in scale, camera and subject instead of restating one framing.
// `continuity` shapes depict recurring people/look, where the master reference
// genuinely helps; the rest are composed freely to avoid near-duplicate frames.
const SHOT_SHAPES: { look: string; continuity: boolean }[] = [
  { look: "wide establishing shot from a high vantage, the location dominant and any figures small", continuity: false },
  { look: "medium shot of the people mid-action at eye level, shallow depth of field", continuity: true },
  { look: "tight close-up of a single object, surface or detail central to this moment", continuity: false },
  { look: "low-angle shot looking upward, emphasising scale and tension", continuity: false },
  { look: "over-the-shoulder view from behind a figure looking toward the main subject", continuity: true },
  { look: "elevated three-quarter view showing movement across the location", continuity: false },
  { look: "quiet, sparse aftermath wide, still and nearly empty", continuity: false },
];

function reconstructionPrompt(kind: "long" | "short", world: StoryWorld, text: string, shape: { look: string }): string {
  const frame = kind === "short" ? "vertical 9:16 composition" : "wide 16:9 composition";
  return `${world.visualDirection} Shot: ${shape.look}. Scene: ${text.slice(0, 160)} Palette: ${world.palette}. Cinematic editorial historical reconstruction, ${frame}, strong subject separation, premium material rendering, not glossy or plastic.`;
}

// Informational graphics rotated so a `graphic` shot reads as a map/document/
// diagram, never another cinematic reconstruction. Kept almost entirely visual:
// image models render text unreliably, so the readable explanation is left to the
// app's captions. Still one image the current renderer can place - no new engine.
const GRAPHIC_KINDS = [
  "a clean historical map of the region: coastline, water and land in muted blocks with a few small marker dots, no text blocks or paragraphs",
  "an abstract timeline: a single horizontal line with a handful of evenly spaced marker dots, no sentences",
  "an aged paper document shown as texture and form only, any writing blurred and illegible, no readable paragraphs",
  "a simple schematic of plain shapes and connecting arrows, no labels beyond the occasional single word",
];

function graphicPrompt(world: StoryWorld, story: Story, n: number): string {
  const kind = GRAPHIC_KINDS[n % GRAPHIC_KINDS.length];
  return `Flat editorial information graphic, not a photographic scene: ${kind}. Region and period: ${story.place}, ${world.period}. Keep it almost entirely visual with minimal or no text - the app adds captions separately, so do not render paragraphs, labels or legends. Muted palette ${world.palette}, no cinematic lighting and no posed actors.`;
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
export async function acquireStill(story: Story, kind: "long" | "short", shot: PlannedShot, masterRef: string | null): Promise<void> {
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
        return;
      }
      console.warn(`[archive] no usable material for ${kind} shot ${shot.index}; using reconstruction`);
    }
    shot.truth = "reconstruction"; // no usable archive - do not fake it
  }

  if (existsSync(abs)) {
    shot.path = rel;
    shot.mediaType = "image";
    return;
  }

  if (config.mode === "live") {
    // Only continuity shots borrow the master; most stills are composed freely so
    // the film is a coherent world of different frames, not one repeated framing.
    const useRef = shot.useMaster && masterRef && existsSync(inStory(story.slug, masterRef));
    const refs = useRef ? [inStory(story.slug, masterRef!)] : undefined;
    await generateImageFile({ prompt: shot.prompt, size: size.oa, outPath: abs, referencePaths: refs });
  } else {
    const ref = referenceFrame(inStory(story.slug, "refs"), shot.index);
    if (ref) {
      copyFileSync(ref, abs);
    } else {
      const label = shot.caption?.text ?? story.title;
      writePlaceholderStill(abs, { width: size.w, height: size.h, index: shot.index, label, truth: shot.truth, accent: accentFor(story.category) });
    }
  }
  shot.path = rel;
  shot.mediaType = "image";
}

// Generate the master/hero reconstruction used as a continuity reference (live).
export async function ensureMaster(story: Story, world: StoryWorld): Promise<string> {
  const rel = "images/hero.png";
  const abs = inStory(story.slug, rel);
  if (config.mode === "live") {
    const prompt = `${world.visualDirection} A defining establishing reconstruction of ${story.title}. Palette: ${world.palette}. Cinematic editorial, premium, wide 16:9.`;
    await generateImageFile({ prompt, size: "1536x1024", outPath: abs });
  } else if (!existsSync(abs)) {
    writePlaceholderStill(abs, { width: 1600, height: 900, index: 0, label: story.title, truth: "reconstruction", accent: accentFor(story.category) });
  }
  return rel;
}

// Live only: turn a still into motion (after the visual preview is approved).
export async function acquireMotion(story: Story, kind: "long" | "short", shot: PlannedShot): Promise<void> {
  if (config.mode !== "live" || !shot.path) return; // mock keeps the transform motion
  if (!config.higgsfield.publicAssetBase) throw new Error("HIGGSFIELD_PUBLIC_ASSET_BASE not set - cannot give Higgsfield a reachable still URL.");
  const rel = `motion/${kind}-${String(shot.index).padStart(2, "0")}.mp4`;
  const imageUrl = `${config.higgsfield.publicAssetBase.replace(/\/$/, "")}/media/${mediaRel(story.slug, shot.path)}`;
  await generateMotion({ prompt: shot.prompt, imageUrl, outPath: inStory(story.slug, rel) });
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
  const frames: PreviewFrame[] = longShots
    .filter((s) => s.path)
    .map((s) => ({
      path: mediaRel(story.slug, s.path!),
      truth: s.truth,
      motion: s.wantsMotion,
      caption: s.caption?.text ?? "",
    }));
  return {
    moments: all.length,
    archive,
    reconstruction,
    graphic,
    motionSelected,
    remainingMotionCost: config.mode === "live" ? round(motionSelected * PRICING.higgsfield.video) : 0,
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
