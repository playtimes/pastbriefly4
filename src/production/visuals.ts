import { existsSync } from "node:fs";
import path from "node:path";
import { config, ROOT } from "../server/config.ts";
import type { Story, Category, VisualPreview, PreviewFrame } from "../types.ts";
import type { RenderPlan, Shot, Truth, Motion, Caption, Framing } from "../render/types.ts";
import type { StoryWorld, ResearchPackage } from "./pipelineTypes.ts";
import type { Narration } from "./narration.ts";
import { PRICING, MOTION_CLIP_SECONDS, round } from "../server/pricing.ts";
import { breakStrength, words } from "./text.ts";
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

// The film holds on its last slot for this long after the narration ends.
export const END_TAIL_SEC = 0.5;

// Film Grammar v2E: one planned shot is one fixed local EDIT SLOT on the timeline,
// kept plain so it can live in the job scratch and survive a restart. PB4 owns
// every cut: the slots (and so the shot index, screen time and word range) are
// built locally from the timed phrase beats. A Coverage Director proposes the
// film's media library, PB4 derives every legal presentation of it, and an Editor
// picks one presentation per slot. Each slot shows one PRESENTATION (`base` or a
// detail crop) of one validated MEDIA ASSET (`assetId`, e.g. "L03").
//
// Every used asset is acquired exactly once, by one "new" slot that owns it (the
// slot that carries its motion clip, if one was selected, otherwise its first
// use): `path` (still) and `motionPath` (clip) are filled there during acquisition.
// Every other slot showing that asset is a "reuse": it points at the owner's still
// (`assetShot`, the owner's slot id) and never triggers provider work.
export type EditAction = "new" | "reuse";

export interface PlannedShot {
  index: number; // equals the edit slot id
  edit: EditAction;
  assetId: string; // the validated media asset this slot shows (L00.. / S00..)
  presentation: PresentationKind; // how this slot presents that asset
  assetShot?: number; // reuse only: the slot that owns (acquires) this asset
  focus?: string; // detail presentations: the mustShow elements in that region
  framing: Framing;
  startBeat?: number; // the phrase beats this slot covers (inclusive)
  endBeat?: number;
  startSec: number; // screen time on the film timeline, contiguous across slots
  endSec: number;
  truth: Truth;
  motion: Motion;
  wantsMotion: boolean; // true only on the slot PB4 selected for this asset's one clip
  motionPriority?: number; // the Editor's 0-3 motion priority for this slot
  motionCandidate?: boolean; // this slot was eligible for motion under the local rules
  prompt: string;
  // Planning intent: why this visual exists and what it must / must not show.
  // Every asset must answer "what should the viewer understand from this visual?".
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

// ---------------------------------------------------------------------------
// v2E visual planning: Coverage Director -> presentations -> Editor
//
// TWO structured planning calls, both covering both films:
// 1. The COVERAGE DIRECTOR answers "what useful documentary media should exist
//    for this film?" and returns a media library per film. It assigns nothing to
//    slots. PB4 validates it and gives each asset a local id (L00.., S00..).
//    Candidates rejected only for an either/or mustShow element may get ONE
//    shared Coverage repair call (mustShow and prompt only), then are re-screened.
// 2. PB4 derives every LEGAL PRESENTATION of that library locally: a base view of
//    every asset, plus one detail crop per distinct mustShow region of a
//    reconstruction. The model never chooses or tracks crop framings.
// 3. The EDITOR answers "what legal piece of available media should appear in
//    this fixed slot?": exactly one presentation id per slot, plus a motion
//    priority. It creates no asset, no crop, no timing and no cut.
// Motion is then chosen locally under a per-film budget. Timing comes only from
// the slots. Everything after planning is ordinary deterministic code. Mock mode
// never calls a provider - it uses tiny deterministic fallback planners.
// ---------------------------------------------------------------------------

// One timed phrase beat: an excerpt of the script tied to its word range and to
// its real screen time. Beats partition the whole film timeline contiguously:
// beat 0 starts at 0s, each later beat starts on its first word's spoken onset,
// and the last beat runs to the end of the film (narration + END_TAIL_SEC).
export interface Beat {
  id: number;
  excerpt: string;
  wordStart: number;
  wordEnd: number; // exclusive
  startSec: number;
  endSec: number;
  durationSec: number;
}

// Phrase-length targets per film. `min` is where a beat stops feeling like a
// fragment, `ideal` is the natural pull, `soft` is the usual upper edge. No beat
// may exceed BEAT_HARD_MAX_SEC unless it is a single word that alone runs longer.
const PHRASE: Record<"long" | "short", { min: number; ideal: number; soft: number }> = {
  long: { min: 3, ideal: 4, soft: 5 },
  short: { min: 2.5, ideal: 3.2, soft: 4 },
};

// One frame under the motion clip length, so a beat's rendered frame count can
// never exceed the clip's frames after rounding. This is what lets any beat
// carry a motion clip without a frozen final frame.
export const BEAT_HARD_MAX_SEC = MOTION_CLIP_SECONDS - 1 / FPS;


// Words a phrase should not end on when there is no punctuation to cut at.
const DANGLING = new Set(["a", "an", "the", "and", "or", "but", "nor", "of", "to", "into", "in", "on", "at", "by", "for", "from", "with", "as", "than", "that", "which", "who", "its", "their", "his", "her", "our", "was", "were", "is", "had", "has"]);

// Build timed phrase beats from the ACTUAL narration word timings. Boundaries
// are chosen by a small dynamic program over word positions: every cut costs
// something unless it lands on punctuation (sentence end best, then a clause
// break, then a real pause), and every beat costs something the further its real
// duration strays from the phrase targets, with fragments under `min` costing a
// lot. The cheapest contiguous segmentation under the hard maximum wins. This
// never divides the duration into equal chunks and never targets a beat count.
export function buildBeats(kind: "long" | "short", script: string, narration: Narration): Beat[] {
  const toks = words(script);
  const n = toks.length;
  if (n === 0) return [];
  const spoken = narration.words ?? [];
  const filmEnd = narration.durationSec + END_TAIL_SEC;

  // at[k]: when a beat starting on word k takes the screen. at[n] is the film end.
  const at: number[] = new Array(n + 1);
  at[0] = 0;
  for (let k = 1; k < n; k++) at[k] = Math.max(at[k - 1], Math.min(filmEnd, spoken[k]?.start ?? spoken.at(-1)?.end ?? filmEnd));
  at[n] = Math.max(at[n - 1], filmEnd);

  const p = PHRASE[kind];
  const durationCost = (d: number): number => {
    if (d < p.min) return 3 * (p.min - d) ** 2 + (d < p.min / 2 ? 6 : 0);
    if (d > p.soft) return 3 * (d - p.soft) ** 2;
    return 0.15 * (d - p.ideal) ** 2;
  };
  // Cost of cutting after word i (between i and i + 1). Without punctuation, the
  // narrator's real pause decides: the longer the pause, the cheaper the cut. A cut
  // that leaves a dangling "and" / "the" / "of", or splits a name or number
  // ("U | 137", "Prime Minister | Thorbjorn"), costs more.
  const cutCost = (i: number): number => {
    const strength = breakStrength(toks[i]);
    if (strength === 2) return 0;
    if (strength === 1) return 0.8;
    const gap = Math.max(0, (spoken[i + 1]?.start ?? 0) - (spoken[i]?.end ?? 0));
    const dangling = DANGLING.has(toks[i].toLowerCase().replace(/[^a-z]/g, "")) ? 3 : 0;
    const next = toks[i + 1] ?? "";
    const joined = /^\d/.test(next) || (/^\p{Lu}/u.test(toks[i]) && /^\p{Lu}/u.test(next)) ? 2 : 0;
    return Math.max(1.5, 4 - 12 * gap) + dangling + joined;
  };
  // A beat that runs across a sentence end mixes two thoughts; allowed, but costed.
  const sentenceEnds: number[] = [0];
  for (let k = 0; k < n; k++) sentenceEnds.push(sentenceEnds[k] + (breakStrength(toks[k]) === 2 ? 1 : 0));
  const inside = (a: number, b: number): number => sentenceEnds[b - 1] - sentenceEnds[a];

  const best: number[] = new Array(n + 1).fill(Infinity);
  const from: number[] = new Array(n + 1).fill(0);
  best[0] = 0;
  for (let b = 1; b <= n; b++) {
    for (let a = b - 1; a >= 0; a--) {
      const d = at[b] - at[a];
      // Over the hard maximum only a single word (which cannot be split) may stand.
      if (d > BEAT_HARD_MAX_SEC && a < b - 1) break;
      const cost = best[a] + durationCost(d) + 1.5 * inside(a, b) + (b < n ? cutCost(b - 1) : 0);
      if (cost < best[b]) {
        best[b] = cost;
        from[b] = a;
      }
    }
  }

  const bounds: number[] = [];
  for (let b = n; b > 0; b = from[b]) bounds.unshift(b);
  let start = 0;
  return bounds.map((end, id): Beat => {
    const beat = {
      id,
      excerpt: toks.slice(start, end).join(" "),
      wordStart: start,
      wordEnd: end,
      startSec: at[start],
      endSec: at[end],
      durationSec: at[end] - at[start],
    };
    start = end;
    return beat;
  });
}

// ---------------------------------------------------------------------------
// Film Grammar v2D local cut grid
//
// PB4 owns every cut. Consecutive phrase beats are grouped into fixed EDIT SLOTS
// locally and deterministically; the planners only decide what the viewer
// sees during each slot, and never choose a cut, a grouping or a duration.
// ---------------------------------------------------------------------------

// One fixed edit slot: one or more consecutive phrase beats (startBeatId-endBeatId,
// inclusive) under one visual, with the real screen time of those beats.
export interface EditSlot {
  id: number;
  startBeatId: number;
  endBeatId: number;
  wordStart: number;
  wordEnd: number; // exclusive
  startSec: number;
  endSec: number;
  durationSec: number;
  // A Runway clip is MOTION_CLIP_SECONDS long, so only a slot that ends inside it
  // may carry motion: the slot ends, the film cuts, nothing freezes.
  motionAllowed: boolean;
  excerpt: string; // the narration this slot covers
}

// The longest a slot may stay on screen, per film. A single phrase beat is never
// split further, so one that alone ran longer would still stand as its own slot
// (phrase beats are capped under the clip length, so this never happens today).
export const SLOT_MAX_SEC: Record<"long" | "short", number> = { long: 7, short: 6 };

// The comfortable slot length per film: inside [lo, hi] a slot costs nothing.
const SLOT_PACE: Record<"long" | "short", { lo: number; hi: number }> = {
  long: { lo: 4, hi: 6 },
  short: { lo: 3, hi: 4.5 },
};

// Cost of keeping two adjacent phrase beats inside ONE slot, by the punctuation
// between them: a sentence end is strongly kept as a cut, a clause break mildly,
// and beats split only by a pause in one clause join freely.
const JOIN_COST = { sentence: 6, clause: 0.5, none: 0 };

// Tolerance for comparing summed word timings against the limits.
const LIMIT_EPS = 1e-6;

// Group phrase beats into edit slots with a small cost-minimising partition. A
// slot's cost is how far its real duration falls outside the comfortable pace
// band plus the cost of every phrase join inside it; the cheapest contiguous
// partition under SLOT_MAX_SEC wins. There is no per-slot cost, so it never merges
// merely to reduce the slot count, and it never targets a count. Deterministic:
// the same beats always give the same slots (ties keep the earlier choice).
export function buildEditSlots(kind: "long" | "short", beats: Beat[]): EditSlot[] {
  const n = beats.length;
  if (n === 0) return [];
  const pace = SLOT_PACE[kind];
  const max = SLOT_MAX_SEC[kind];
  const paceCost = (d: number): number => (d < pace.lo ? (pace.lo - d) ** 2 : d > pace.hi ? 0.5 * (d - pace.hi) ** 2 : 0);
  // join[i]: cost of keeping beat i and beat i + 1 in the same slot.
  const join = beats.map((b) => {
    const strength = breakStrength(words(b.excerpt).at(-1) ?? "");
    return strength === 2 ? JOIN_COST.sentence : strength === 1 ? JOIN_COST.clause : JOIN_COST.none;
  });

  const best: number[] = new Array(n + 1).fill(Infinity);
  const from: number[] = new Array(n + 1).fill(0);
  best[0] = 0;
  for (let b = 1; b <= n; b++) {
    let joins = 0;
    for (let a = b - 1; a >= 0; a--) {
      if (a < b - 1) joins += join[a];
      const d = beats[b - 1].endSec - beats[a].startSec;
      if (d > max + LIMIT_EPS && a < b - 1) break;
      const cost = best[a] + paceCost(d) + joins;
      if (cost < best[b]) {
        best[b] = cost;
        from[b] = a;
      }
    }
  }

  const bounds: number[] = [];
  for (let b = n; b > 0; b = from[b]) bounds.unshift(b);
  let start = 0;
  return bounds.map((end, id): EditSlot => {
    const first = beats[start];
    const last = beats[end - 1];
    const durationSec = last.endSec - first.startSec;
    const slot: EditSlot = {
      id,
      startBeatId: first.id,
      endBeatId: last.id,
      wordStart: first.wordStart,
      wordEnd: last.wordEnd,
      startSec: first.startSec,
      endSec: last.endSec,
      durationSec,
      motionAllowed: durationSec <= MOTION_CLIP_SECONDS + LIMIT_EPS,
      excerpt: beats.slice(start, end).map((x) => x.excerpt).join(" "),
    };
    start = end;
    return slot;
  });
}

// Check a slot grid against its phrase beats: slots start at beat 0, end at the
// final beat, cover every beat exactly once in order, and stay inside the format
// maximum. Returns every problem found (empty = sound). The grid is PB4's own, so a
// problem here is a bug, never something a planner could cause or fix.
export function slotGridProblems(kind: "long" | "short", beats: Beat[], slots: EditSlot[]): string[] {
  const problems: string[] = [];
  let next = 0;
  slots.forEach((s, i) => {
    if (s.id !== i) problems.push(`${kind} slot ${i} has id ${s.id}`);
    if (s.startBeatId !== next) problems.push(`${kind} slot ${i} starts at beat ${s.startBeatId}, expected ${next}`);
    if (s.endBeatId < s.startBeatId) problems.push(`${kind} slot ${i} is reversed`);
    if (s.startBeatId < s.endBeatId && s.durationSec > SLOT_MAX_SEC[kind] + LIMIT_EPS) {
      problems.push(`${kind} slot ${i} runs ${s.durationSec.toFixed(2)}s, over the ${SLOT_MAX_SEC[kind]}s maximum`);
    }
    next = s.endBeatId + 1;
  });
  if (next !== beats.length) problems.push(`${kind} slots end at beat ${next - 1}, not the final beat ${beats.length - 1}`);
  return problems;
}

// ---------------------------------------------------------------------------
// Coverage Director: the media library
// ---------------------------------------------------------------------------

// Where a mustShow element sits in the frame. "whole" spans the frame (water, sky,
// a coastline) and yields no detail crop.
export type Region = "left" | "center" | "right" | "whole";

export interface MustShowElement {
  description: string;
  region: Region;
}

// One media asset as the Coverage Director proposes it. It carries no slot, no
// timing and no crop: the Editor decides where it is used, PB4 derives its crops.
export interface CoverageAsset {
  truth: Truth;
  purpose: string;
  mustShow: MustShowElement[];
  mustNotShow: string[];
  prompt: string; // the specific single-frame scene (for archive: the reconstruction fallback)
  archiveQuery: string; // "" unless truth === "archive"
  useMaster: boolean;
  baseFraming: "wide" | "medium";
  motionCapable: boolean;
}

// A validated asset with its local id: L00, L01.. for the Long, S00.. for the Short.
export interface MediaAsset extends CoverageAsset {
  id: string;
}

export interface CoveragePlans {
  longAssets: CoverageAsset[];
  shortAssets: CoverageAsset[];
}

export interface CoverageInput {
  story: Story;
  research: ResearchPackage;
  scripts: { long: string; short: string };
  slots: { long: EditSlot[]; short: EditSlot[] };
}

// A Coverage Director turns the story + fixed slots into both media libraries in
// one call. Injected in tests; the default picks the live call or the offline fallback.
export type CoverageDirector = (input: CoverageInput, respond?: typeof respondJson) => Promise<CoveragePlans>;

const TRUTHS: readonly Truth[] = ["archive", "reconstruction", "graphic"];
const REGIONS: readonly Region[] = ["left", "center", "right", "whole"];
const BASE_FRAMINGS = ["wide", "medium"] as const;
const FRAMINGS: readonly Framing[] = ["wide", "medium", "detail-left", "detail-center", "detail-right"];

// The most mustShow elements one asset may carry; more than this is a scene
// summary, not a frame whose elements can be cropped.
export const MAX_MUST_SHOW = 4;

const coverageAssetSchema = {
  type: "object",
  additionalProperties: false,
  required: ["truth", "purpose", "mustShow", "mustNotShow", "prompt", "archiveQuery", "useMaster", "baseFraming", "motionCapable"],
  properties: {
    truth: { type: "string", enum: TRUTHS as unknown as string[] },
    purpose: { type: "string" },
    mustShow: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["description", "region"],
        properties: { description: { type: "string" }, region: { type: "string", enum: REGIONS as unknown as string[] } },
      },
    },
    mustNotShow: { type: "array", items: { type: "string" } },
    prompt: { type: "string" },
    archiveQuery: { type: "string" },
    useMaster: { type: "boolean" },
    baseFraming: { type: "string", enum: BASE_FRAMINGS as unknown as string[] },
    motionCapable: { type: "boolean" },
  },
};

export const COVERAGE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["longAssets", "shortAssets"],
  properties: {
    longAssets: { type: "array", items: coverageAssetSchema },
    shortAssets: { type: "array", items: coverageAssetSchema },
  },
};

export const COVERAGE_INSTRUCTIONS = `You are the Coverage Director for PastBriefly, a factual historical documentary. You are given one story, its FINAL verified research (facts, moments, sources, story world), the Long and Short scripts, and each film's FIXED EDIT SLOTS. Your only question is: "What useful documentary media should exist for this film?" Think like a documentary director planning coverage before the edit: the stills, archive items and graphics an editor will need to cut this film well. Return strict JSON: one media library per film, "longAssets" and "shortAssets".

YOU DO NOT EDIT - the edit is already cut into fixed slots with fixed times and narration, and a separate Editor will later choose, for every slot, one presentation of one of your assets. You assign nothing to slots: no slot ids, no timing, no order of use, no crops. The slots are shown only so you know what the narration needs the viewer to see, and for how long.

HOW YOUR ASSETS ARE USED - PastBriefly shows every asset in its full "base" view. For a RECONSTRUCTION it also derives detail crops from your mustShow regions: a "detail-left" crop when an element sits in the left third, "detail-center" for the center, "detail-right" for the right third; "whole" (an element that spans the frame) gives no crop. The Editor can show one asset many times - its base, then a detail, then the base again as a callback - at no extra cost. So one well-composed reconstruction with its key elements in distinct regions can cover several slots: an establishing view and real details of it. Archive and graphics are shown in their base view only; graphics are never cropped.

A LIBRARY, NOT A QUOTA - propose the assets this film genuinely needs: each distinct event, place, person, object or piece of evidence the narration has to show, plus geography or information that is clearer as a graphic. Do not create one asset per slot and do not manufacture near-duplicates: the Editor reuses assets and cuts to their details. Every generated reconstruction or graphic the Editor uses costs an image; an unused asset costs nothing, but a library of near-identical images makes a monotonous film. Every asset must earn its place with visual information no other asset gives.

ASSET FIELDS
- truth: "archive" | "reconstruction" | "graphic" (see MEDIA CHOICE).
- purpose: what the viewer should understand from this asset, as a VISIBLE idea a storyboard artist could draw. GOOD: "Establish the Soviet submarine visibly grounded on rocks inside the narrow Swedish archipelago." "Show Swedish patrol boats forming a perimeter around the grounded submarine." BAD (never): "Show Cold War", "Create tension", "Espionage suspicions", or any mood or atmosphere label.
- mustShow: the concrete elements this one frame shows, each with its region (see MUSTSHOW).
- mustNotShow: short, concrete protections against obvious historical mistakes (wrong flag, wrong era, a vessel freely underway when it is aground, active battle when there was none).
- prompt: the specific single-frame scene (see SCENE). For archive it is the reconstruction fallback (see ARCHIVE FALLBACK).
- archiveQuery: for archive, a specific event query that targets the REAL historical media; "" otherwise.
- useMaster: see MASTER REFERENCE. Most assets do not use it.
- baseFraming: "wide" (the whole composition, the usual choice) or "medium" (a modest push) for the base view.
- motionCapable: true only for a reconstruction whose REAL physical movement would improve it when animated (a vessel moving, water, people physically working, refloating or towing). False for archive, graphics, documents, maps, static instruments, portraits, static evidence, meetings and human-heavy interiors. PastBriefly animates only a few assets per film and chooses them itself.

MUSTSHOW MUST DESCRIBE ACTUAL VISIBLE CONTENT - every mustShow element is ONE concrete, physically visible, atomic thing that is present in this exact frame. PastBriefly derives legal detail crops from these elements, so an element that is not really in the picture would produce a false crop. GOOD: "grounded Soviet submarine", "exposed rocks beneath hull", "Swedish patrol vessel". BAD: "proximity to naval base", "Cold War tension", "Swedish response", "autumn environment", "skeptical expressions", "signage or buoys". MUSTSHOW IS FACTUAL CONTENT, NOT MOOD: never an expression, emotion, lighting, time of day, season, weather or atmosphere (BAD: "skeptical expression", "anxious expression", "tension", "concern", "suspicion", "autumn atmosphere", "early morning light", "dramatic weather"). Lighting or mood may appear in the prompt where appropriate, never as a mustShow element. Every element must be crop-safe: one concrete visible object, person or place feature a detail crop can land on. EXACTLY ONE THING PER ELEMENT - never offer alternatives: no "or", no "/", no "either", no "and/or" (BAD: "naval or coast guard vessel", "gangway/hatch", "table or desk"). Choose the one thing the frame shows. If the research does not say which it was, name the concrete thing it does support at the level it supports it (for "naval or coast guard vessel", "Swedish vessel"): never invent a more specific detail just to avoid an alternative. An element that offers alternatives discards the WHOLE asset. Never a whole-scene summary such as "submarine surrounded by Swedish ships" as one element: name the parts. Usually 1-3 elements, never more than ${MAX_MUST_SHOW}. Give each a region: "left", "center" or "right" for the third of the frame it sits in, or "whole" when it spans the frame. Put different key elements in different regions when the scene naturally allows it, so the Editor gets real, distinct details; the image is composed to match your regions.

ONE ASSET = ONE FRAME - one location, one moment, one primary action, from a single vantage. Never action A plus action B in one frame (BAD: "an officer examines equipment while another questions the captain"), never the current event plus the next event. You are providing SEVERAL pieces of coverage: when a moment has two actions, choose the one the narration needs or make them separate assets; never cram the narration into one image. Explicitly forbidden: a collage, a montage, an inset, a split screen, a split-focus showing two different actions at once, separate moments, a before/after, "in the next moment", a "series of shots", a "through a window / through a hatch" trick used to depict a second event, or any composite that stitches together separate scenes, locations, moments or actions. A graphic may carry several marks on ONE map or diagram ONLY because they all explain one spatial fact.

FACTUAL GROUNDING (HARD FACTUAL VISUAL RULE) - the verified facts are hard constraints. Every concrete, event-specific thing in an asset must be supported by the final fact sheet, the verified research moments, the sources or the audited narration itself. PLAUSIBLE IS NOT SUPPORTED: historically likely is not enough. Unless verified research supports them, do NOT invent event-specific meetings, rooms or interiors, phone calls, handshakes, flags, insignia, signs, hazard markers, military equipment, cranes, sonar equipment, crowds, press conferences, documents, readable labels, extra ships, weather, military deployments, public reactions or actions. NO UNSUPPORTED EVENT-SPECIFIC DETAIL: a reconstruction may depict only event-specific details supported by the verified facts, the research moments or the audited narration. Never invent a specific operations room, conference room, interrogation room, phone-call scene, meeting, handshake, salvage equipment, tug, crane, sonar equipment, patrol zone, military installation, flag, insignia, boundary marker or warning sign unless it is supported. When the narration describes something abstract or unsupported, prefer another supported physical detail, real archive, geography or an already-supported recurring subject: do not stage a fictional event. Generic period or location presentation is acceptable ONLY when it does not claim that a specific historical event happened. Do not dramatize negations or limitations: when the narration says something did not happen, was prevented, limited, refused or remained uncertain, do not stage a confrontation to visualise that absence (for "access was limited", do NOT stage someone physically blocking another person at a hatch). When narration is abstract (interpretation, suspicion, consequence, policy, reflection), do not invent a physical scene for it: the Editor will cover it with an existing asset, an archive item, or a graphic that states a concrete fact.

NO INVENTED READABLE TEXT - a generated reconstruction must never depend on readable historical text: no legible documents, newspaper headlines, communiqués, report text, hull numbers, labels, signs or captions. Never ask image generation for hull numbers, signs, map labels, document text, instrument readings, headlines, insignia text or captions unless the exact visible wording is explicitly verified AND necessary. Where a document matters, show it as a physical object with no readable text. A GRAPHIC communicates only supported information: never invent labelled sonar stations, patrol zones, detection nodes, military positions or routes. If generated text would be needed to make a graphic understandable, choose another visual instead.

MASTER REFERENCE (useMaster) - the master image exists only to keep the recurring MAIN PHYSICAL SUBJECT (for example the grounded vessel) consistent. Set useMaster true only when THAT recurring subject is visibly present in this reconstruction. Never merely because the asset belongs to the same event, and never for an interior without the recurring subject, a people-only scene, an evidence or object-only shot, a graphic, archive or an unrelated environment.

MEDIA CHOICE (truth)
- "archive": when a specific real historical person, vessel, event, photograph, document, newspaper or film plausibly exists and directly supports the story (for example the real vessel at the real event, a real public figure named in the facts, real press coverage). archiveQuery must be specific and event-anchored (names, vessel, place, year), never generic like "Sweden 1981", and never a vague idea like "public concern". Do NOT choose archive for an abstract outcome such as an apology, a reimbursement, a policy change or public concern, unless the research or sources point to a real photo, document or event that captured it. There is no archive quota and never choose archive merely for variety - but when direct historical subjects clearly exist, zero archive is not the automatic answer.
- "reconstruction": a physical event or scene that must be shown but lacks suitable archive material.
- "graphic": information that is clearer spatially or informationally - geography, route, distance, positions, a timeline, a simple comparison. Never for atmosphere, never a generic "military infographic". purpose and mustShow state the exact information (e.g. "Karlskrona naval base" on the left, "grounding location" on the right).

ARCHIVE FALLBACK MUST NOT FAKE HISTORY - for an archive asset, archiveQuery seeks the REAL historical media, but your prompt is the RECONSTRUCTION FALLBACK used only if acquisition finds nothing. That prompt describes a historical editorial RECONSTRUCTION of the physical scene, never the archive item itself: it must NOT ask for a photograph, a news photo, an archival image or a historical photograph. It must NEVER fabricate a newspaper headline, a communiqué's text, a report's text, a TV broadcast, a logo, a press photograph or any readable historical document: describe the surrounding physical scene with no readable text.

SCENE (prompt) - one specific single frame grounded in purpose, mustShow (with its regions), mustNotShow and the story world. Describe a concrete composition suited to the subject (a wide elevated vantage for geography, a medium eye-level shot for people mid-action, a tight view of an instrument). Keep the key subjects well inside the frame, in the regions you gave them. Do NOT return generic prompts like "cinematic Cold War scene" or "dramatic military atmosphere", and do not rotate through a fixed set of camera shapes.

COVERAGE AND VARIETY - for the story's important physical events, give the Editor useful coverage: an establishing view, the action, the evidence or object, the people involved, the geography. Choose only what helps the narration. Avoid a library dominated by one primary subject at a similar scale (for example many submarine-wide or ship-wide compositions): distinct actions involving the same subject should differ in scale, subject or evidence. If one asset already communicates a geography or spatial relationship, do not propose another similar map from a slightly different angle: the Editor reuses it. A new asset must add new information. Give the Editor what it needs for intentional callbacks and for a clear ending.

DETAIL CROPS ARE NOT NEW COVERAGE - an asset's base view and its detail crops are ONE visual family: the same image, the same moment, the same vantage. Detail crops are useful coverage, but they cannot substitute indefinitely for genuinely different documentary material. A film that cuts only between the base and crops of one asset still shows the viewer one picture.

THE LONG NEEDS DEEPER COVERAGE THAN THE SHORT - the Long has sustained narrative sections where the narration stays on one important subject or event for many slots in a row. For each such sustained section, provide multiple materially different assets where the verified facts support them, so the Editor can move between independent visual families rather than cycling one image and its crops. Scale this depth to the Long's duration: as guidance, not a quota, a roughly 4-minute Long will often need around 18-24 genuinely distinct assets, depending on the story, and a sustained 20-40 second section should normally have several materially different visual families when the verified facts support them. Never add near-duplicates to reach a number. Prefer real variation in documentary information: a different subject, the people involved, the action, the evidence, an object, the geography, archive, the environment, the consequence. This is depth, not a quota: there is no fixed asset count. Do not manufacture unsupported scenes just for variety, and do not create near-duplicate assets; every factual safeguard above still applies. When the verified facts genuinely support only one view, fewer assets are correct.

INDEPENDENCE - plan the Short library independently from the Long library. The Short is faster and simpler; the Long has room for more geography, evidence and context. Do not derive the Short by cropping or summarising the Long. Long slots can only use longAssets and Short slots only shortAssets.

THE SHORT IS A COVERAGE KIT, NOT ONE IMAGE PER SLOT - the Short has about 15 fixed slots; do not propose almost one unique asset per slot. Design a compact, reusable coverage kit: roughly 7-10 useful unique assets for a ~50 second Short is usually enough when base and detail reuse can tell the story (guidance, not a quota). Give Short reconstructions useful, distinct left/center/right visible elements so the Editor has legal detail cuts, but never manufacture elements merely to create crops.

Return JSON { "longAssets": [...], "shortAssets": [...] }.`;

// The first live planning call: the story, verified facts, both scripts and both
// fixed slot grids in; both media libraries out.
export const openAiCoverageDirector: CoverageDirector = async (input, respond = respondJson) => {
  return respond<CoveragePlans>({
    instructions: COVERAGE_INSTRUCTIONS,
    input: coveragePayload(input),
    schemaName: "coverage_plan",
    schema: COVERAGE_SCHEMA,
  });
};

// One fixed slot as a planner sees it: id, time, duration, whether motion is
// allowed, and its narration. Nothing it could use to move a cut.
export function slotBlock(s: EditSlot): string {
  return [
    `SLOT #${s.id}`,
    `time: ${s.startSec.toFixed(2)}-${s.endSec.toFixed(2)}`,
    `duration: ${s.durationSec.toFixed(2)}s`,
    `motion allowed: ${s.motionAllowed ? "yes" : "no"}`,
    `narration: "${s.excerpt}"`,
  ].join("\n");
}

// The verified story context both planners share.
function storyContext(story: Story, research: ResearchPackage, scripts: { long: string; short: string }): string[] {
  const w = research.world;
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
  ];
}

const slotBlocks = (ss: EditSlot[]) => ss.map(slotBlock).join("\n\n");

export function coveragePayload(input: CoverageInput): string {
  const { story, research, scripts, slots } = input;
  return [
    ...storyContext(story, research, scripts),
    "",
    "The edit is already cut. The fixed slots below show what the narration needs the viewer to see and for how long; a separate Editor assigns media to them. Do NOT assign anything to slots: propose each film's media library.",
    "",
    `LONG SLOTS (#0-#${slots.long.length - 1}):`,
    "",
    slotBlocks(slots.long),
    "",
    `SHORT SLOTS (#0-#${slots.short.length - 1}; plan the Short library independently - do NOT crop the Long library):`,
    "",
    slotBlocks(slots.short),
    "",
    'Return JSON { "longAssets": [...], "shortAssets": [...] }.',
  ].join("\n");
}

// The Coverage Director returned a library, or the Editor an edit, that fails
// validation. The planning call itself succeeded (and was paid for); nothing
// after it may run.
export class VisualPlanError extends Error {
  override name = "VisualPlanError";
}

const isInt = (n: unknown): n is number => typeof n === "number" && Number.isInteger(n);
const isText = (s: unknown): s is string => typeof s === "string" && s.trim().length > 0;

// Local asset id: film prefix + two-digit position in the validated library.
export function assetId(kind: "long" | "short", i: number): string {
  return `${kind === "long" ? "L" : "S"}${String(i).padStart(2, "0")}`;
}

// A Coverage candidate that failed validation: its film, its position in the raw
// answer, and why. It is discarded whole and gets no local id; only an either/or
// mustShow rejection may get the one bounded Coverage repair (see below).
export interface RejectedCandidate {
  film: "long" | "short";
  index: number;
  reason: string;
}

export interface CoverageScreen {
  assets: MediaAsset[];
  rejected: RejectedCandidate[];
}

class CandidateRejection extends Error {}

// Screen one film's Coverage answer. Every asset is a CANDIDATE: a valid one is
// kept unchanged, an invalid one is discarded whole and recorded with its raw
// index and reason (nothing is repaired or rewritten). Local ids are assigned
// only after filtering, in the order returned, so a rejected candidate has no id,
// no presentation, no acquisition, no cost and no motion. The film fails only
// when its list is missing or empty, or when no candidate survives.
export function screenCoverage(kind: "long" | "short", raw: unknown): CoverageScreen {
  const { assets, rejected } = screenCandidates(kind, coverageList(kind, raw));
  if (!assets.length) {
    const why = rejected.map((r) => `#${r.index} ${r.reason}`).join("; ");
    throw new VisualPlanError(`Invalid coverage plan: ${kind} has no valid candidates (${(raw as unknown[]).length} proposed, all rejected: ${why}).`);
  }
  return { assets, rejected };
}

function coverageList(kind: "long" | "short", raw: unknown): unknown[] {
  const field = kind === "long" ? "longAssets" : "shortAssets";
  if (!Array.isArray(raw) || raw.length === 0) throw new VisualPlanError(`Invalid coverage plan: ${field} is missing or empty; each film needs a media library.`);
  return raw;
}

// The per-candidate screen, without the "no valid candidates" failure, so a film
// whose only defects are repairable can still reach the Coverage repair.
function screenCandidates(kind: "long" | "short", raw: unknown[]): CoverageScreen {
  const assets: MediaAsset[] = [];
  const rejected: RejectedCandidate[] = [];
  raw.forEach((item, index) => {
    try {
      const asset = checkCandidate(item);
      assets.push({ id: assetId(kind, assets.length), ...asset });
    } catch (e) {
      if (!(e instanceof CandidateRejection)) throw e;
      rejected.push({ film: kind, index, reason: e.message });
    }
  });
  return { assets, rejected };
}

// The valid assets of one film's Coverage answer (see screenCoverage).
export function validateCoverage(kind: "long" | "short", raw: unknown): MediaAsset[] {
  return screenCoverage(kind, raw).assets;
}

// Validate one candidate. Throws a CandidateRejection with the reason; text is
// only trimmed and mustNotShow deduped.
function checkCandidate(item: unknown): Omit<MediaAsset, "id"> {
  const fail = (reason: string): never => {
    throw new CandidateRejection(reason);
  };
  const a = (item && typeof item === "object" ? item : {}) as Partial<Record<keyof CoverageAsset, unknown>>;
  if (!TRUTHS.includes(a.truth as Truth)) fail(`has truth ${JSON.stringify(a.truth ?? null)}, not archive, reconstruction or graphic`);
  const truth = a.truth as Truth;
  if (!isText(a.purpose)) fail("has no purpose");
  if (!isText(a.prompt)) fail("has no prompt (the scene, or for archive the reconstruction fallback)");
  if (!Array.isArray(a.mustShow) || a.mustShow.length === 0) fail("has no mustShow elements; list the concrete things visible in this frame");
  const els = a.mustShow as unknown[];
  if (els.length > MAX_MUST_SHOW) fail(`has ${els.length} mustShow elements, more than ${MAX_MUST_SHOW}`);
  const mustShow = els.map((el, k): MustShowElement => {
    const e = (el && typeof el === "object" ? el : {}) as { description?: unknown; region?: unknown };
    if (!isText(e.description)) fail(`mustShow[${k}] is not a {description, region} element with a description`);
    const description = (e.description as string).trim();
    if (!REGIONS.includes(e.region as Region)) fail(`mustShow[${k}] "${description}" has region ${JSON.stringify(e.region ?? null)}, not left, center, right or whole`);
    if (/\bor\b|\beither\b|\//i.test(description)) fail(`mustShow[${k}] "${description}" ${EITHER_OR}; each element must be one concrete visible thing`);
    return { description, region: e.region as Region };
  });
  const seen = new Set<string>();
  for (const e of mustShow) {
    const key = e.description.toLowerCase();
    if (seen.has(key)) fail(`repeats the mustShow element "${e.description}"`);
    seen.add(key);
  }
  if (!Array.isArray(a.mustNotShow) || !a.mustNotShow.every((x) => typeof x === "string")) fail("has no mustNotShow list");
  const archiveQuery = typeof a.archiveQuery === "string" ? a.archiveQuery.trim() : "";
  if (truth === "archive" && !archiveQuery) fail("is archive but has no archiveQuery");
  if (!BASE_FRAMINGS.includes(a.baseFraming as "wide")) fail(`has baseFraming ${JSON.stringify(a.baseFraming ?? null)}, not wide or medium`);
  if (typeof a.motionCapable !== "boolean") fail("has no motionCapable flag");
  if (typeof a.useMaster !== "boolean") fail("has no useMaster flag");
  return {
    truth,
    purpose: (a.purpose as string).trim(),
    mustShow,
    mustNotShow: dedupe((a.mustNotShow as string[]).map((x) => x.trim()).filter(Boolean)).slice(0, 6),
    prompt: (a.prompt as string).trim(),
    archiveQuery: truth === "archive" ? archiveQuery : "",
    // Continuity and motion only mean something for a reconstruction.
    useMaster: truth === "reconstruction" && (a.useMaster as boolean),
    baseFraming: a.baseFraming as "wide" | "medium",
    motionCapable: truth === "reconstruction" && (a.motionCapable as boolean),
  };
}

// ---------------------------------------------------------------------------
// Bounded Coverage repair: either/or mustShow elements only
// ---------------------------------------------------------------------------

const EITHER_OR = "is an either/or element";

// Only a candidate rejected for an either/or mustShow element ("or", "either", "/")
// may be repaired; every other rejection is final.
export const isRepairableRejection = (r: RejectedCandidate): boolean => r.reason.includes(EITHER_OR);

export interface CoverageRepairTarget extends RejectedCandidate {
  candidate: unknown; // the original raw candidate, exactly as Coverage returned it
}

export interface CoverageRepairInput {
  story: Story;
  research: ResearchPackage;
  targets: CoverageRepairTarget[];
}

// The only fields a repair may change.
export interface CoverageRepairPatch {
  mustShow: MustShowElement[];
  prompt: string;
}

// The answer, per film: raw candidate index -> its patch.
export type CoverageRepairAnswer = Partial<Record<"long" | "short", Record<string, CoverageRepairPatch>>>;

export type CoverageRepairDirector = (input: CoverageRepairInput, respond?: typeof respondJson) => Promise<CoverageRepairAnswer>;

// One repair target's outcome after the normal re-screen. A candidate that is not
// recovered stays in coverageRejected with its final reason.
export interface RepairedCandidate extends RejectedCandidate {
  recovered: boolean;
  id?: string; // its local id when recovered
}

export const COVERAGE_REPAIR_INSTRUCTIONS = `You are the Coverage Director for PastBriefly, repairing one local defect in media candidates you already proposed. This is NOT a new coverage plan. Each TARGET candidate was rejected only because a mustShow element offers alternatives ("or", "either" or "/") instead of naming one concrete visible thing. The candidate's intent is already clear: keep it the same asset. For each target return only its corrected mustShow and its prompt. Its truth, purpose, mustNotShow, archiveQuery, useMaster, baseFraming and motionCapable are fixed and are not yours to change.

MUSTSHOW - keep every element that already names one concrete visible thing exactly as it is, with its region. Rewrite each element that offers alternatives as ONE concrete, physically visible thing, in exactly one of two ways: (1) choose ONE of the alternatives, only when the verified facts support that choice; or (2) otherwise generalize to the narrowest concrete common description the verified facts support (for "Swedish Navy or Coast Guard vessel", "Swedish vessel"). Never replace "X or Y" with "X and Y" (or "X with Y", "X plus Y", "both X and Y") merely to pass validation: an alternative means the original was uncertain, and combining the options claims both are in the frame. Never add both alternatives when the original uncertainty did not establish both, and never split them into two elements. Never invent a more specific type, rank, name, object or detail just to remove an alternative. Keep each element's region and do not add new elements. No element may contain the word "or", the word "either" or "/".

PROMPT - return the original prompt unchanged, unless it names the same alternatives or would contradict the corrected mustShow. When it must change, rewrite the complete scene prompt as natural, fluent prose: do not splice the corrected mustShow wording into the old sentence by mechanical word substitution (for example "A Swedish vessel patrol boat" or "Swedish vessel ship" are wrong; write "A Swedish vessel" or describe the same scene in a clean sentence). The rewritten prompt must agree with the corrected mustShow, and must contain no leftover "or", "either", "/", "and/or" or other alternative wording about the ambiguity the repair resolved, including any wording that still offers the alternatives the corrected mustShow resolved (for example "tow or escort", "statements or files"). Resolve such wording the same way as mustShow: one supported option, or the narrowest common description; never both alternatives. Do not add new facts, people, objects, actions or specificity, and do not remove or restage anything else: keep the same subject, setting, framing, lighting, period and composition, so the asset keeps its original purpose and scene identity.

Return exactly one repair per target candidate, nothing else.`;

// A description with at least one visible character and no "/". Strict schemas
// cannot portably express "not the word or / either", so those are stated in the
// instructions and caught by the normal re-screen, which stays authoritative.
export const REPAIR_DESCRIPTION_PATTERN = "^[^/]*[^/\\s][^/]*$";

const filmsOf = (targets: CoverageRepairTarget[]) => (["long", "short"] as const).filter((k) => targets.some((t) => t.film === k));

// Keyed by film and raw candidate index, so every target is returned exactly once
// and no other candidate can be; a patch holds only mustShow and prompt.
export function coverageRepairSchema(targets: CoverageRepairTarget[]) {
  const patch = {
    type: "object",
    additionalProperties: false,
    required: ["mustShow", "prompt"],
    properties: {
      mustShow: {
        type: "array",
        minItems: 1,
        maxItems: MAX_MUST_SHOW,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["description", "region"],
          properties: {
            description: { type: "string", pattern: REPAIR_DESCRIPTION_PATTERN },
            region: { type: "string", enum: REGIONS as unknown as string[] },
          },
        },
      },
      prompt: { type: "string" },
    },
  };
  const film = (kind: "long" | "short") => {
    const keys = targets.filter((t) => t.film === kind).map((t) => String(t.index));
    return { type: "object", additionalProperties: false, required: keys, properties: Object.fromEntries(keys.map((k) => [k, patch])) };
  };
  const films = filmsOf(targets);
  return { type: "object", additionalProperties: false, required: films, properties: Object.fromEntries(films.map((k) => [k, film(k)])) };
}

// Only what the repair needs: the verified facts it must stay within, and each
// target with its rejection and original candidate. No scripts, no slots.
export function coverageRepairPayload(input: CoverageRepairInput): string {
  const { story, research, targets } = input;
  const w = research.world;
  const films = filmsOf(targets);
  return [
    `STORY: ${story.title} (${story.year}, ${story.place})`,
    `SUMMARY: ${research.summary}`,
    "",
    "VERIFIED FACTS (hard visual constraints - do not go beyond these):",
    (research.facts ?? []).map((f) => `- ${f.fact}`).join("\n") || "- (none provided)",
    "",
    "MOMENTS:",
    research.moments.map((m) => `- ${m.title}: ${m.detail}`).join("\n") || "- (none)",
    "",
    `STORY WORLD: ${w.period}; ${w.place}`,
    "",
    "REPAIR TARGETS:",
    "",
    targets
      .map((t) => [`TARGET ${t.film} candidate #${t.index}`, `rejected: ${t.reason}`, "original candidate:", JSON.stringify(t.candidate, null, 2)].join("\n"))
      .join("\n\n"),
    "",
    `Return JSON { ${films.map((k) => `"${k}": { ${targets.filter((t) => t.film === k).map((t) => `"${t.index}": { "mustShow", "prompt" }`).join(", ")} }`).join(", ")} }: exactly one repair per target.`,
  ].join("\n");
}

export const openAiCoverageRepair: CoverageRepairDirector = async (input, respond = respondJson) => {
  return respond<CoverageRepairAnswer>({
    instructions: COVERAGE_REPAIR_INSTRUCTIONS,
    input: coverageRepairPayload(input),
    schemaName: "coverage_repair",
    schema: coverageRepairSchema(input.targets),
  });
};

// Apply the repair locally: per target that got a patch object, a COPY of the
// original candidate with ONLY mustShow and prompt taken from the patch; every
// other field stays the original's, whatever the answer holds. Anything that is
// not a target is ignored, a target without a patch stays as rejected, and the raw
// Coverage answer is never mutated. Nothing is checked or rewritten here: the
// copies go through the normal candidate screen.
export function applyCoverageRepair(targets: CoverageRepairTarget[], raw: unknown): { long: Map<number, unknown>; short: Map<number, unknown> } {
  const out = { long: new Map<number, unknown>(), short: new Map<number, unknown>() };
  const answer = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  for (const t of targets) {
    const film = answer[t.film];
    const patch = film && typeof film === "object" ? (film as Record<string, unknown>)[String(t.index)] : undefined;
    if (!patch || typeof patch !== "object" || Array.isArray(patch)) continue;
    const { mustShow, prompt } = patch as Partial<CoverageRepairPatch>;
    const original = (t.candidate && typeof t.candidate === "object" ? t.candidate : {}) as Record<string, unknown>;
    out[t.film].set(t.index, { ...original, mustShow, prompt });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Presentation library (local, deterministic)
// ---------------------------------------------------------------------------

export type PresentationKind = "base" | "detail-left" | "detail-center" | "detail-right";

// One legal way to show one asset. The id is "<assetId>:<kind>".
export interface Presentation {
  id: string;
  assetId: string;
  kind: PresentationKind;
  framing: Framing;
  description: string;
  elements: string[]; // what this presentation shows (a detail: only its region's elements)
  truth: Truth; // the underlying asset's truth
  // Derived locally: only the base of a motion-capable reconstruction can ever move.
  motionEligible: boolean;
}

const DETAIL_REGIONS = ["left", "center", "right"] as const;

// Every asset gets "<id>:base" at its base framing. A RECONSTRUCTION also gets one
// detail crop per distinct left/center/right region among its mustShow elements;
// "whole" gives no crop. Archive and graphics are base only (graphics are never
// reframed; archive details can come later). Order: assets in library order, base
// first, then details left -> center -> right.
export function buildPresentations(assets: MediaAsset[]): Presentation[] {
  const out: Presentation[] = [];
  for (const a of assets) {
    out.push({
      id: `${a.id}:base`,
      assetId: a.id,
      kind: "base",
      framing: a.baseFraming,
      description: `${a.truth}, ${a.baseFraming}: ${a.purpose}`,
      elements: a.mustShow.map((e) => e.description),
      truth: a.truth,
      motionEligible: a.truth === "reconstruction" && a.motionCapable,
    });
    if (a.truth !== "reconstruction") continue;
    for (const region of DETAIL_REGIONS) {
      const elements = a.mustShow.filter((e) => e.region === region).map((e) => e.description);
      if (!elements.length) continue;
      const kind = `detail-${region}` as const;
      out.push({ id: `${a.id}:${kind}`, assetId: a.id, kind, framing: kind, description: `crop on ${elements.join("; ")}`, elements, truth: a.truth, motionEligible: false });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Editor: one presentation per fixed slot
// ---------------------------------------------------------------------------

export interface EditorAssignment {
  slotId: number;
  presentationId: string;
  motionPriority: number; // 0 none, 1 useful, 2 strong, 3 standout
}

export interface EditorPlans {
  long: EditorAssignment[];
  short: EditorAssignment[];
}

export interface EditorInput {
  story: Story;
  research: ResearchPackage;
  scripts: { long: string; short: string };
  slots: { long: EditSlot[]; short: EditSlot[] };
  library: { long: MediaAsset[]; short: MediaAsset[] };
  presentations: { long: Presentation[]; short: Presentation[] };
}

export type EditorDirector = (input: EditorInput, respond?: typeof respondJson) => Promise<EditorPlans>;

export const MOTION_PRIORITIES = [0, 1, 2, 3] as const;

// The Editor's schema is built per job: presentationId is an enum of that film's
// legal presentation ids, so a strict response can only name listed presentations.
export function editorSchema(presentations: { long: Presentation[]; short: Presentation[] }) {
  const assignment = (list: Presentation[]) => ({
    type: "object",
    additionalProperties: false,
    required: ["slotId", "presentationId", "motionPriority"],
    properties: {
      slotId: { type: "integer" },
      presentationId: { type: "string", enum: list.map((p) => p.id) },
      motionPriority: { type: "integer", enum: [...MOTION_PRIORITIES] },
    },
  });
  return {
    type: "object",
    additionalProperties: false,
    required: ["long", "short"],
    properties: {
      long: { type: "array", items: assignment(presentations.long) },
      short: { type: "array", items: assignment(presentations.short) },
    },
  };
}

// The local motion budget per film: Runway clips PB4 may select.
export const MOTION_BUDGET: Record<"long" | "short", number> = { long: 5, short: 3 };

// The longest allowed archive hold: two adjacent slots, combined (see archiveHolds).
export const ARCHIVE_HOLD_MAX_SEC = 10;

export const EDITOR_INSTRUCTIONS = `You are the Editor for PastBriefly, a factual historical documentary. The edit is already cut into FIXED SLOTS, each with a fixed time, duration and narration, and a validated MEDIA LIBRARY already exists for each film, with every LEGAL PRESENTATION of it listed. Your only question for every slot is: "What legal piece of available media should appear in this fixed slot?" Return strict JSON: exactly one assignment for every slot of each film.

WHAT YOU RETURN - for each slot: slotId, presentationId (one of that film's listed presentation ids, exactly as written) and motionPriority. You do NOT create assets, create crops, alter timing, choose cuts or estimate cost. Every slotId exactly once: no missing slot, no duplicate slot, no unknown slot, and no presentation that is not listed. A plan that breaks any of this is rejected whole; nothing will repair it.

PRESENTATIONS - "<asset>:base" shows the whole asset. "<asset>:detail-left", ":detail-center" and ":detail-right" crop the SAME image onto the listed elements of that region. Every presentation of one asset is the same underlying picture, so reusing an asset, in any presentation, costs nothing. A detail shows only the elements it lists: never pick a detail for something it does not list. You do not need to use every asset; an unused asset is simply never made.

EVERY CUT SERVES THE NARRATION - each slot's presentation must show what that slot's narration is about, or be a deliberate, supported cutaway. Every cut should earn its place: reveal new information, change scale, introduce a person, object or place, show evidence, reset geography, escalate the action, make an intentional callback, or give a deliberate visual breath.

SEQUENCES - you see the whole timeline: edit it as small sequences, not as isolated slot islands. Think in mini-sequences of roughly 20-40 seconds of slots, each with an intentional arc, for example establish -> detail -> person/evidence -> escalation -> payoff, or establishing base -> supported detail -> different subject or evidence -> archive -> callback, rather than new asset -> new asset -> new asset -> new asset. A base followed by one of its details is a natural documentary cut; so is returning to an earlier base as a callback. Reuse is desirable when it creates coverage, continuity, a callback or a scale change, but do not overuse one asset just because it has many presentations.

EVERY SLOT IS AN ACTUAL CUT - the exact same presentationId may NEVER appear in two adjacent slots: that is a hidden hold, not a cut, and the whole plan is rejected. This applies equally to reconstruction, archive, graphic and detail presentations, with ONE exception: a presentation marked "adjacent repeat: one deliberate hold" (the base of a base-only archive) may fill TWO adjacent slots when the narration genuinely stays on it, if those two slots last ${ARCHIVE_HOLD_MAX_SEC}s or less together; it plays as one continuous held image, and a third adjacent slot is still rejected. Each presentation in the library lists its capabilities: "detail views: none" means it is base only, so you cannot cut within it. If a base-only archive or graphic stays relevant across several phrases, cut away to another supported presentation and return to it later; do NOT fake a hold by repeating it. BAD: slot 20 -> L07:base, slot 21 -> L07:base, slot 22 -> L07:base. GOOD: slot 20 -> L07:base, slot 21 -> L04:detail-center, slot 22 -> L07:base (only when each choice genuinely supports its slot's narration). A base followed by one of its own details is a real cut. The same presentation later, after other slots, is allowed. Before returning JSON, explicitly check every adjacent pair: assignment[n].presentationId must not equal assignment[n - 1].presentationId.

ARCHIVE MUST MATCH THE WORDS - an archive presentation must directly support the CURRENT slot's narration. Do not place a related famous person or event merely because it belongs to the story (BAD: a prime minister's archive image starting on narration about a diplomatic protest). Put archive where that person, event or media is actually being spoken about.

TEMPORAL ALIGNMENT - do not anticipate later facts, evidence or events. A visual about information the film introduces later must not be placed earlier merely because it belongs to the same story or sequence. Every presentation must support the CURRENT slot's narration or be a genuinely supported cutaway for that current thought.

ABSTRACT NARRATION - when a slot mainly carries interpretation, suspicion, consequence, policy, transition or reflection, use a supported asset that fits: a detail or callback of an earlier asset, an archive item, or a graphic that states a concrete fact. Do not pick an unrelated scene just because it is new.

REPETITION AND OVERUSE - track the recent sequence as you go. Avoid three consecutive slots dominated by the same primary subject at a similar scale. Different presentation ids do not make a run varied: submarine wide -> submarine detail -> submarine wide -> submarine detail -> submarine wide is still one subject. Break long same-subject runs with a supported reset where the narration allows: a person, an object or evidence, geography, archive, the environment or another action. Do not lean on one asset for most of a sequence when other supported assets fit: reuse is a tool for detail and callbacks, not a way to avoid variety. Prefer useful alternation where the narration supports it (environment, subject, person, evidence, geography, archive, detail, action, intentional return), without rotating categories mechanically.

CALLBACKS AND ENDING - reuse an earlier asset when the narration returns to it, so the callback reads as intentional. Exact presentation reuse must be intentional: when returning to an asset shortly after it appeared, prefer another of its legal presentations where that is meaningful; an exact earlier crop should return only when the repeated composition itself serves the story. Give each film a deliberate ending: a final image that closes the story, not an arbitrary last asset.

MOTION PRIORITY - 0 none, 1 useful, 2 strong, 3 standout. PastBriefly chooses the actual motion itself: only a base presentation of a motion-capable reconstruction, on a slot marked "motion allowed: yes", can move; at most ${MOTION_BUDGET.long} clips in the Long and ${MOTION_BUDGET.short} in the Short; at most one clip per asset; highest priority first, earlier slots winning ties. A priority above 0 is useful ONLY when all three hold: the slot is 5s or shorter ("motion allowed: yes"), the chosen presentation is the base of a motion-capable reconstruction, and visible physical movement would improve the shot (a vessel moving, refloating or towing, water, a physical operation). Never give a priority, least of all 3, to a slot that cannot move (a long slot, a detail, archive, a graphic). Every slot lists "motion allowed": if it says no, motionPriority MUST be 0; a priority there can never take effect. Every presentation lists "motion eligible": if it says no, motionPriority MUST be 0, or the whole plan is rejected. Give 3 only for the few standout moments. Most slots are 0. Never raise a priority just to make the film feel busy.

INDEPENDENCE - Long slots use only Long presentations (L..), Short slots only Short presentations (S..). Edit the Short on its own faster rhythm; do not mirror the Long.

FINAL CHECK - before returning, verify for each film: every slot appears exactly once; no two adjacent slots share the same presentationId (except one allowed two-slot archive hold); and every motionPriority above 0 is on a "motion eligible: yes" presentation AND on a slot marked "motion allowed: yes".

Return, for both "long" and "short", exactly one assignment per slot, in slot order.`;

// The second live planning call: context, fixed slots, and the validated library
// with every legal presentation in; one assignment per slot out.
export const openAiEditor: EditorDirector = async (input, respond = respondJson) => {
  return respond<EditorPlans>({
    instructions: EDITOR_INSTRUCTIONS,
    input: editorPayload(input),
    schemaName: "edit_plan",
    schema: editorSchema(input.presentations),
  });
};

// One presentation's capabilities, derived locally from the asset and its crops,
// so the Editor sees what each presentation can and cannot do.
export function presentationCapabilities(p: Presentation, own: Presentation[]): string[] {
  const details = own.filter((q) => q.kind !== "base").map((q) => q.id);
  const hold = p.kind === "base" && p.truth === "archive" && own.length === 1; // see archiveHolds
  return [
    `    type: ${p.truth}${p.kind === "base" ? "" : " detail"}`,
    ...(p.kind === "base"
      ? details.length
        ? ["    detail views:", ...details.map((id) => `    - ${id}`)]
        : hold
          ? ["    detail views: none (base only)"]
          : ["    detail views: none (base only: cut away and return later, never hold it on adjacent slots)"]
      : [`    source asset: ${p.assetId}`]),
    hold ? `    adjacent repeat: one deliberate hold (2 adjacent slots at most, ${ARCHIVE_HOLD_MAX_SEC}s combined at most)` : "    adjacent repeat: FORBIDDEN",
    `    motion eligible: ${p.motionEligible ? "yes (only on a slot with motion allowed: yes)" : "no (motionPriority must be 0)"}`,
  ];
}

// One asset and its legal presentations, as the Editor sees them.
export function libraryBlock(asset: MediaAsset, presentations: Presentation[]): string {
  const own = presentations.filter((p) => p.assetId === asset.id);
  return [
    `ASSET ${asset.id} - ${asset.truth}${asset.motionCapable ? ", motion-capable" : ""}: ${asset.purpose}`,
    `  shows: ${asset.mustShow.map((e) => `${e.description} (${e.region})`).join("; ")}`,
    ...own.flatMap((p) => [`  ${p.id} - ${p.description}`, ...presentationCapabilities(p, own)]),
  ].join("\n");
}

export function editorPayload(input: EditorInput): string {
  const { story, research, scripts, slots, library, presentations } = input;
  const libraryBlocks = (kind: "long" | "short") => library[kind].map((a) => libraryBlock(a, presentations[kind])).join("\n\n");
  return [
    ...storyContext(story, research, scripts),
    "",
    `LONG MEDIA LIBRARY (${library.long.length} assets, ${presentations.long.length} legal presentations):`,
    "",
    libraryBlocks("long"),
    "",
    `SHORT MEDIA LIBRARY (${library.short.length} assets, ${presentations.short.length} legal presentations):`,
    "",
    libraryBlocks("short"),
    "",
    "The edit is already cut. For every slot below choose one listed presentation of that film's library, and a motion priority.",
    "",
    `LONG SLOTS (#0-#${slots.long.length - 1}):`,
    "",
    slotBlocks(slots.long),
    "",
    `SHORT SLOTS (#0-#${slots.short.length - 1}; edit the Short independently):`,
    "",
    slotBlocks(slots.short),
    "",
    'Return JSON { "long": [...], "short": [...] }: for each film, exactly one assignment per slot, each slotId exactly once.',
  ].join("\n");
}

// Local, deterministic cleanup before validation: a motionPriority of 1-3 on a slot
// with motion allowed: no could never carry a clip, so it becomes 0. Nothing else in
// any assignment changes. Returns the cleaned answer and the slot ids it touched.
export function normalizeMotionPriorities(slots: EditSlot[], raw: unknown): { plan: unknown; normalized: number[] } {
  if (!Array.isArray(raw)) return { plan: raw, normalized: [] };
  const normalized: number[] = [];
  const plan = raw.map((item) => {
    const a = (item && typeof item === "object" ? item : {}) as Partial<EditorAssignment>;
    const slot = isInt(a.slotId) ? slots.find((s) => s.id === a.slotId) : undefined;
    if (!slot || slot.motionAllowed || !MOTION_PRIORITIES.includes(a.motionPriority as 0) || a.motionPriority === 0) return item;
    normalized.push(slot.id);
    return { ...a, motionPriority: 0 };
  });
  return { plan, normalized };
}

// The one exception to "every slot is an actual cut": a deliberate archive HOLD.
// A slot may repeat the previous slot's presentation only when it is the base of
// an archive asset that has no other legal presentation, the run is exactly two
// slots (the slot before the pair shows something else), and the two slots last
// at most ARCHIVE_HOLD_MAX_SEC together. The renderer plays such a pair as one
// continuous still. Returns the later slot id of every allowed hold.
export function archiveHolds(slots: EditSlot[], ids: unknown[], presentations: Presentation[]): Set<number> {
  const holds = new Set<number>();
  for (let i = 1; i < ids.length; i++) {
    if (ids[i] !== ids[i - 1] || (i > 1 && ids[i - 2] === ids[i])) continue;
    const p = presentations.find((q) => q.id === ids[i]);
    if (!p || p.kind !== "base" || p.truth !== "archive" || presentations.some((q) => q.assetId === p.assetId && q.id !== p.id)) continue;
    if (slots[i - 1].durationSec + slots[i].durationSec > ARCHIVE_HOLD_MAX_SEC + 1e-9) continue;
    holds.add(slots[i].id);
  }
  return holds;
}

// Validate one film's Editor answer against its fixed slots and legal
// presentations. Returns the assignments in slot order. Nothing is repaired:
// coverage (every slot exactly once), then each presentation and priority, and no
// two adjacent slots with the identical presentation (a later callback is fine),
// except an allowed archive hold (archiveHolds).
// allowAdjacentRepeats skips only that last check, so planVisuals can tell an
// answer whose only defect is a hidden hold (repairable) from any other failure.
export function validateEdit(kind: "long" | "short", slots: EditSlot[], raw: unknown, presentations: Presentation[], allowAdjacentRepeats = false): EditorAssignment[] {
  const last = slots.length - 1;
  const reject = (reason: string): never => {
    throw new VisualPlanError(`Invalid edit plan: ${kind} ${reason}.`);
  };
  if (!Array.isArray(raw) || raw.length === 0) return reject(`has no slot assignments; the Editor must return exactly one assignment for each of slots 0-${last}`);
  const bySlot = new Map<number, Partial<EditorAssignment>>();
  raw.forEach((item, i) => {
    const a = (item && typeof item === "object" ? item : {}) as Partial<EditorAssignment>;
    const id = a.slotId;
    if (!isInt(id)) return reject(`item ${i}: slotId ${JSON.stringify(id ?? null)} is not an integer`);
    if (id < 0 || id > last) return reject(`item ${i}: slotId ${id} is unknown (slots are 0-${last})`);
    if (bySlot.has(id)) return reject(`item ${i}: slotId ${id} is duplicated; every slot gets exactly one assignment`);
    bySlot.set(id, a);
  });
  const missing = slots.filter((s) => !bySlot.has(s.id)).map((s) => s.id);
  if (missing.length) return reject(`is missing an assignment for slot${missing.length > 1 ? "s" : ""} ${missing.join(", ")}; every slot gets exactly one assignment`);
  const legal = new Map(presentations.map((p) => [p.id, p]));
  const holds = archiveHolds(slots, slots.map((s) => bySlot.get(s.id)!.presentationId), presentations);
  return slots.map((slot): EditorAssignment => {
    const a = bySlot.get(slot.id)!;
    const label = `slot ${slot.id} (beats ${slot.startBeatId}-${slot.endBeatId}, ${slot.durationSec.toFixed(2)}s)`;
    if (typeof a.presentationId !== "string" || !legal.has(a.presentationId)) {
      return reject(`${label}: presentationId ${JSON.stringify(a.presentationId ?? null)} is not a legal ${kind} presentation`);
    }
    if (!MOTION_PRIORITIES.includes(a.motionPriority as 0)) return reject(`${label}: motionPriority ${JSON.stringify(a.motionPriority ?? null)} is not 0, 1, 2 or 3`);
    if ((a.motionPriority as number) > 0 && !legal.get(a.presentationId)!.motionEligible) {
      return reject(`${label}: motionPriority ${a.motionPriority} on "${a.presentationId}", which is not motion eligible; its priority must be 0`);
    }
    if ((a.motionPriority as number) > 0 && !slot.motionAllowed) {
      return reject(`${label}: motionPriority ${a.motionPriority} on a slot with motion allowed: no; its priority must be 0`);
    }
    // The same presentation on two adjacent slots is a hidden hold, not a cut,
    // unless it is an allowed archive hold.
    if (!allowAdjacentRepeats && slot.id > 0 && bySlot.get(slot.id - 1)!.presentationId === a.presentationId && !holds.has(slot.id)) {
      return reject(`${label}: presentationId "${a.presentationId}" repeats slot ${slot.id - 1}; adjacent slots must not show the identical presentation`);
    }
    return { slotId: slot.id, presentationId: a.presentationId, motionPriority: a.motionPriority as number };
  });
}

// ---------------------------------------------------------------------------
// Targeted repair: adjacent identical presentations only
// ---------------------------------------------------------------------------

// Which slots to re-pick so no two adjacent slots share a presentation: the later
// slot of each repeated pair, except when the slot before it is already a target
// (in a run of three, re-picking the middle slot clears both pairs) and except an
// allowed archive hold (`holds`, from archiveHolds), which is valid and never
// sent to repair. Targets are therefore never adjacent, and every target's
// neighbours stay fixed.
export function adjacentRepeatTargets(edit: EditorAssignment[], holds: Set<number> = new Set()): number[] {
  const targets: number[] = [];
  for (let i = 1; i < edit.length; i++) {
    if (holds.has(edit[i].slotId)) continue;
    if (edit[i].presentationId === edit[i - 1].presentationId && targets.at(-1) !== i - 1) targets.push(edit[i].slotId);
  }
  return targets;
}

export interface EditRepairInput {
  story: Story;
  slots: { long: EditSlot[]; short: EditSlot[] };
  library: { long: MediaAsset[]; short: MediaAsset[] };
  presentations: { long: Presentation[]; short: Presentation[] };
  edit: EditorPlans; // the Editor's answer after motion normalization, in slot order
  targets: { long: number[]; short: number[] };
}

// The answer, per film: target slot id -> its replacement.
export type EditRepairAnswer = Partial<Record<"long" | "short", Record<string, { presentationId: string; motionPriority: number }>>>;

export type EditRepairDirector = (input: EditRepairInput, respond?: typeof respondJson) => Promise<EditRepairAnswer>;

export const EDIT_REPAIR_INSTRUCTIONS = `You are the Editor for PastBriefly, repairing one defect in an edit that is otherwise final. Each TARGET slot shows the exact same presentation as a neighbouring slot: a hidden hold, not a cut. For each target slot only, choose one replacement presentation from that film's listed library. The replacement must directly support the target slot's narration (or be a genuinely supported cutaway for it) and must differ from every presentationId listed under "must differ from". Every other slot is fixed and is not yours to change: do not return it. motionPriority is 0 unless the replacement is "motion eligible: yes" AND the target slot says "motion allowed: yes". Return exactly one replacement per target slot, nothing else.`;

// Per film, per target: every legal presentation of that film except the ids of
// the target's two neighbours (which stay fixed), so the answer can never repeat
// an adjacent slot; that includes the target's own current id. Which of them to
// use is still the model's choice. A target with nothing left fails here, before
// any provider call.
export type RepairAllowed = { long: Record<number, string[]>; short: Record<number, string[]> };

export function repairAllowedIds(input: Pick<EditRepairInput, "presentations" | "edit" | "targets">): RepairAllowed {
  const film = (kind: "long" | "short") => {
    const edit = input.edit[kind];
    return Object.fromEntries(
      input.targets[kind].map((t) => {
        const forbidden = [edit[t - 1], edit[t + 1]].filter(Boolean).map((e) => e.presentationId);
        const allowed = input.presentations[kind].map((p) => p.id).filter((id) => !forbidden.includes(id));
        if (!allowed.length) {
          throw new VisualPlanError(`Invalid edit repair: ${kind} slot ${t} has no legal presentation left that differs from its neighbours (${forbidden.join(", ")}).`);
        }
        return [t, allowed];
      }),
    );
  };
  return { long: film("long"), short: film("short") };
}

// Keyed by target slot id, so every target is returned exactly once and nothing
// else can be; each target's presentationId enum holds only its own allowed ids.
export function editRepairSchema(input: EditRepairInput) {
  const allowed = repairAllowedIds(input);
  const films = (["long", "short"] as const).filter((k) => input.targets[k].length);
  const replacement = (ids: string[]) => ({
    type: "object",
    additionalProperties: false,
    required: ["presentationId", "motionPriority"],
    properties: {
      presentationId: { type: "string", enum: ids },
      motionPriority: { type: "integer", enum: [...MOTION_PRIORITIES] },
    },
  });
  const replacements = (kind: "long" | "short") => ({
    type: "object",
    additionalProperties: false,
    required: input.targets[kind].map(String),
    properties: Object.fromEntries(input.targets[kind].map((t) => [String(t), replacement(allowed[kind][t])])),
  });
  return { type: "object", additionalProperties: false, required: films, properties: Object.fromEntries(films.map((k) => [k, replacements(k)])) };
}

// Only what one re-pick needs: the film's library, and per target its slot, the
// problem, the ids it must differ from, and the nearby slots with their assignments.
export function editRepairPayload(input: EditRepairInput): string {
  const { story, slots, library, presentations, edit, targets } = input;
  const film = (kind: "long" | "short") => {
    const name = kind.toUpperCase();
    const at = (id: number) => edit[kind][id].presentationId;
    const target = (t: number) => {
      const near = slots[kind].filter((s) => Math.abs(s.id - t) <= 3);
      const neighbours = [t - 1, t + 1].filter((n) => n >= 0 && n < slots[kind].length);
      const repeats = neighbours.filter((n) => at(n) === at(t));
      return [
        `TARGET ${slotBlock(slots[kind][t])}`,
        `current: ${at(t)}`,
        `problem: "${at(t)}" is identical to slot${repeats.length > 1 ? "s" : ""} ${repeats.join(" and ")}; adjacent slots must not show the identical presentation`,
        `must differ from: ${neighbours.map((n) => `${at(n)} (slot ${n})`).join(", ")}`,
        "nearby slots:",
        ...near.map((s) => `  #${s.id} ${at(s.id)}${s.id === t ? "  <- TARGET" : ""}: "${s.excerpt}"`),
      ].join("\n");
    };
    return [
      `${name} MEDIA LIBRARY (${library[kind].length} assets, ${presentations[kind].length} legal presentations):`,
      "",
      library[kind].map((a) => libraryBlock(a, presentations[kind])).join("\n\n"),
      "",
      `${name} REPAIR TARGETS (${targets[kind].join(", ")}):`,
      "",
      targets[kind].map(target).join("\n\n"),
    ];
  };
  const films = (["long", "short"] as const).filter((k) => targets[k].length);
  return [
    `STORY: ${story.title} (${story.year}, ${story.place})`,
    "",
    ...films.flatMap((k) => [...film(k), ""]),
    `Return JSON { ${films.map((k) => `"${k}": { ${targets[k].map((t) => `"${t}": { "presentationId", "motionPriority" }`).join(", ")} }`).join(", ")} }: exactly one replacement per target slot.`,
  ].join("\n");
}

export const openAiEditRepair: EditRepairDirector = async (input, respond = respondJson) => {
  return respond<EditRepairAnswer>({
    instructions: EDIT_REPAIR_INSTRUCTIONS,
    input: editRepairPayload(input),
    schemaName: "edit_repair",
    schema: editRepairSchema(input),
  });
};

// Apply one film's repair answer: exactly one replacement per target, each one of
// that target's allowed ids, nothing for any other slot. Every untouched assignment
// is returned as it was; the result is then normalized and fully validated again
// by the caller.
export function applyEditRepair(kind: "long" | "short", edit: EditorAssignment[], allowed: Record<number, string[]>, raw: unknown): unknown[] {
  const reject = (reason: string): never => {
    throw new VisualPlanError(`Invalid edit repair: ${kind} ${reason}.`);
  };
  const targets = Object.keys(allowed).map(Number);
  const answer = raw === undefined && !targets.length ? {} : raw;
  if (!answer || typeof answer !== "object" || Array.isArray(answer)) return reject("replacements are not an object keyed by target slot");
  const byTarget = new Map<number, unknown>();
  for (const [key, item] of Object.entries(answer)) {
    const slotId = Number(key);
    if (!targets.includes(slotId)) return reject(`slot ${key} is not a repair target (targets: ${targets.join(", ") || "none"})`);
    const pick = (item && typeof item === "object" ? item : {}) as Partial<EditorAssignment>;
    if (!allowed[slotId].includes(pick.presentationId as string)) {
      return reject(`slot ${slotId}: presentationId ${JSON.stringify(pick.presentationId ?? null)} is not allowed there; it must differ from its neighbours (${allowed[slotId].length} allowed ids)`);
    }
    byTarget.set(slotId, { slotId, presentationId: pick.presentationId, motionPriority: pick.motionPriority });
  }
  const missing = targets.filter((t) => !byTarget.has(t));
  if (missing.length) return reject(`has no replacement for target slot${missing.length > 1 ? "s" : ""} ${missing.join(", ")}`);
  return edit.map((e) => byTarget.get(e.slotId) ?? e);
}

// ---------------------------------------------------------------------------
// Local motion budget
// ---------------------------------------------------------------------------

export interface MotionChoice {
  candidates: number[]; // slot ids eligible for motion, in slot order
  selected: number[]; // slot ids PB4 selected, in slot order
}

// A slot is a motion candidate only if the Editor gave it a priority above 0, the
// slot fits inside one clip (motionAllowed, <= 5s), it shows a BASE presentation,
// and the asset is a motion-capable reconstruction. Details, archive and graphics
// never move. Selection: highest priority first, then the earlier slot, at most
// MOTION_BUDGET[kind] clips and at most ONE clip per underlying asset.
export function selectMotion(kind: "long" | "short", slots: EditSlot[], edit: EditorAssignment[], presentations: Presentation[], assets: MediaAsset[]): MotionChoice {
  const pres = new Map(presentations.map((p) => [p.id, p]));
  const asset = new Map(assets.map((a) => [a.id, a]));
  const candidates = edit.filter((e) => {
    const p = pres.get(e.presentationId);
    const a = p && asset.get(p.assetId);
    const slot = slots[e.slotId];
    return !!p && !!a && !!slot && e.motionPriority > 0 && slot.motionAllowed && p.kind === "base" && a.truth === "reconstruction" && a.motionCapable;
  });
  const ranked = [...candidates].sort((x, y) => y.motionPriority - x.motionPriority || x.slotId - y.slotId);
  const moved = new Set<string>();
  const selected: number[] = [];
  for (const e of ranked) {
    if (selected.length >= MOTION_BUDGET[kind]) break;
    const id = pres.get(e.presentationId)!.assetId;
    if (moved.has(id)) continue;
    moved.add(id);
    selected.push(e.slotId);
  }
  return { candidates: candidates.map((e) => e.slotId), selected: selected.sort((a, b) => a - b) };
}

// ---------------------------------------------------------------------------
// Assembly: slot + assignment + presentation -> planned shot
// ---------------------------------------------------------------------------

// Build one planned shot per slot, in slot order. Timing (beats, word range,
// screen time, index) comes ONLY from the slot; the presentation supplies the
// framing; the asset supplies purpose, prompt and constraints. Each used asset is
// owned (acquired) by exactly one slot: its motion slot if one was selected,
// otherwise its first use. Every other slot using it is a "reuse" of that owner.
export function assembleEdit(
  kind: "long" | "short",
  slots: EditSlot[],
  edit: EditorAssignment[],
  presentations: Presentation[],
  assets: MediaAsset[],
  motion: MotionChoice,
  story: Story,
  research: ResearchPackage,
): PlannedShot[] {
  const world = research.world;
  const pres = new Map(presentations.map((p) => [p.id, p]));
  const assetOf = new Map(assets.map((a) => [a.id, a]));
  const selected = new Set(motion.selected);
  const candidate = new Set(motion.candidates);
  const owner = new Map<string, number>();
  for (const e of edit) {
    const id = pres.get(e.presentationId)!.assetId;
    if (selected.has(e.slotId)) owner.set(id, e.slotId);
  }
  for (const e of edit) {
    const id = pres.get(e.presentationId)!.assetId;
    if (!owner.has(id)) owner.set(id, e.slotId);
  }
  return edit.map((e): PlannedShot => {
    const slot = slots[e.slotId];
    const p = pres.get(e.presentationId)!;
    const a = assetOf.get(p.assetId)!;
    const own = owner.get(a.id)!;
    const moving = selected.has(slot.id);
    const mustShow = a.mustShow.map((m) => m.description);
    const prompt =
      a.truth === "graphic"
        ? graphicPrompt(world, story, a.purpose, a.mustShow, a.prompt)
        : reconstructionPrompt(kind, world, story, a.purpose, a.mustShow, a.mustNotShow, a.prompt, a.useMaster);
    return {
      index: slot.id,
      edit: own === slot.id ? "new" : "reuse",
      assetId: a.id,
      presentation: p.kind,
      ...(own === slot.id ? {} : { assetShot: own }),
      ...(p.kind === "base" ? {} : { focus: p.elements.join("; ") }),
      framing: p.framing,
      startBeat: slot.startBeatId,
      endBeat: slot.endBeatId,
      startSec: slot.startSec,
      endSec: slot.endSec,
      wordStart: slot.wordStart,
      wordEnd: slot.wordEnd,
      truth: a.truth,
      motion: moving ? "push" : "hold",
      wantsMotion: moving,
      motionPriority: e.motionPriority,
      motionCandidate: candidate.has(slot.id),
      prompt,
      purpose: a.purpose,
      mustShow,
      mustNotShow: [...a.mustNotShow],
      archiveQuery: a.truth === "archive" ? a.archiveQuery : undefined,
      useMaster: a.useMaster,
      caption: slot.id === 0 ? { kicker: story.year, text: story.title, emphasis: kind === "short" ? story.place : undefined, variant: "opener" } : undefined,
      source: undefined,
    };
  });
}

// ---------------------------------------------------------------------------
// Offline fallback planners (mock mode, tests, demo)
// ---------------------------------------------------------------------------

// Not the production brain - just a tiny valid library and edit so the pipeline
// runs without any provider. They never derive meaning from keywords, and they
// exercise every path: reconstructions with detail regions, a regular graphic,
// base/detail reuse, a closing callback and motion priorities.
export const fallbackCoverageDirector: CoverageDirector = async (input) => ({
  longAssets: fallbackAssets(input.slots.long, input.research),
  shortAssets: fallbackAssets(input.slots.short, input.research),
});

function fallbackAssets(slots: EditSlot[], research: ResearchPackage): CoverageAsset[] {
  const w = research.world;
  const place = w.place || "the location";
  const count = Math.max(1, Math.ceil(slots.length / 3));
  return Array.from({ length: count }, (_, k): CoverageAsset => {
    const graphic = k % 4 === 3;
    const excerpt = slots[Math.min(slots.length - 1, k * 3)]?.excerpt ?? "";
    return {
      truth: graphic ? "graphic" : "reconstruction",
      purpose: graphic ? `Show where this happened at ${place} and how the places relate.` : `Show the key action of this moment at ${place}.`,
      mustShow: graphic
        ? [{ description: place, region: "center" }]
        : [
            { description: w.recurringPeople[0] || "the main subject", region: "center" },
            { description: `the ${w.period} ${place} setting`, region: "left" },
          ],
      mustNotShow: ["modern vehicles, equipment or clothing"],
      prompt: excerpt.slice(0, 120) || `a moment at ${place}`,
      archiveQuery: "",
      useMaster: !graphic && k % 4 === 1,
      baseFraming: "wide",
      motionCapable: !graphic && k % 2 === 0,
    };
  });
}

export const fallbackEditor: EditorDirector = async (input) => ({
  long: fallbackEdit(input.slots.long, input.presentations.long),
  short: fallbackEdit(input.slots.short, input.presentations.short),
});

// Slot i uses asset floor(i / 3): its base, then its details, then the base again.
// The final slot of a longer film calls back to the first asset's base. A pick that
// would repeat the previous slot's presentation moves on to the next listed one.
function fallbackEdit(slots: EditSlot[], presentations: Presentation[]): EditorAssignment[] {
  const byAsset = new Map<string, Presentation[]>();
  for (const p of presentations) byAsset.set(p.assetId, [...(byAsset.get(p.assetId) ?? []), p]);
  const ids = [...byAsset.keys()];
  let prev = "";
  return slots.map((slot) => {
    const i = slot.id;
    const callback = slots.length > 6 && i === slots.length - 1;
    const own = byAsset.get(ids[callback ? 0 : Math.min(ids.length - 1, Math.floor(i / 3))])!;
    let p = callback ? own[0] : own[(i % 3) % own.length];
    if (p.id === prev && presentations.length > 1) p = presentations[(presentations.indexOf(p) + 1) % presentations.length];
    prev = p.id;
    return { slotId: i, presentationId: p.id, motionPriority: p.motionEligible && slot.motionAllowed && i % 3 === 0 ? 2 : 0 };
  });
}

// ---------------------------------------------------------------------------
// Planning entry point
// ---------------------------------------------------------------------------

export interface VisualDirectors {
  coverage: CoverageDirector;
  editor: EditorDirector;
  repair?: EditRepairDirector; // absent: an adjacent identical presentation simply fails the plan
  coverageRepair?: CoverageRepairDirector; // absent: an either/or candidate simply stays rejected
}

const defaultDirectors = (): VisualDirectors =>
  config.mode === "live"
    ? { coverage: openAiCoverageDirector, coverageRepair: openAiCoverageRepair, editor: openAiEditor, repair: openAiEditRepair }
    : { coverage: fallbackCoverageDirector, editor: fallbackEditor };

// Paid-call hooks: `before` runs before each planning call (budget preflight),
// `after` once each call has returned (the call is paid for even if its answer
// then fails validation).
export interface PlanningHooks {
  before?: () => void;
  after?: () => void;
}

// Plan both films with TWO calls. Phrase beats and the fixed edit slots are built
// locally; Coverage proposes candidate media (screened before the Editor is ever
// called: invalid candidates are discarded and returned as coverageRejected, the
// Editor sees only the valid library; candidates rejected only for an either/or
// mustShow element may get ONE shared Coverage repair call, and are re-screened
// normally, reported as coverageRepaired); PB4 derives the legal presentations; the Editor assigns one per
// slot (validated before anything is acquired; an adjacent identical presentation
// may get one targeted repair call, a third call); PB4 picks motion; assembly makes
// one planned shot per slot. Returns the Long and Short planned shots.
export async function planVisuals(
  story: Story,
  research: ResearchPackage,
  scripts: { long: string; short: string },
  narration: { long: Narration; short: Narration },
  directors: VisualDirectors = defaultDirectors(),
  hooks: PlanningHooks = {},
): Promise<{ long: PlannedShot[]; short: PlannedShot[]; coverageRejected: RejectedCandidate[]; coverageRepaired: RepairedCandidate[] }> {
  // Live planning is only as truthful as its inputs. A ResearchPackage with no
  // verified facts (e.g. legacy research from before the fact sheet) defeats
  // factual visual grounding, so refuse rather than plan ungrounded live visuals.
  // Mock mode keeps its deterministic fallback, which needs no facts.
  if (config.mode === "live" && !(research.facts && research.facts.length > 0)) {
    throw new Error("Visual planning requires verified facts. Re-run the current research/text pipeline before planning visuals.");
  }
  const slots = { long: planSlots("long", scripts.long, narration.long), short: planSlots("short", scripts.short, narration.short) };

  hooks.before?.();
  const coverage = await directors.coverage({ story, research, scripts, slots });
  hooks.after?.();
  if (!coverage || typeof coverage !== "object" || Array.isArray(coverage)) {
    throw new VisualPlanError('Invalid coverage plan: the answer is not a { "longAssets", "shortAssets" } object.');
  }
  const lists = { long: coverageList("long", coverage.longAssets), short: coverageList("short", coverage.shortAssets) };
  // Candidates rejected ONLY for an either/or mustShow element, from both films, get
  // at most ONE shared Coverage repair call (no retry, Coverage is never re-asked).
  // Their patched copies then go through the normal screen with everything else.
  const first = [...screenCandidates("long", lists.long).rejected, ...screenCandidates("short", lists.short).rejected];
  const repairTargets = first.filter(isRepairableRejection).map((r) => ({ ...r, candidate: lists[r.film][r.index] }));
  let patched = { long: new Map<number, unknown>(), short: new Map<number, unknown>() };
  if (directors.coverageRepair && repairTargets.length) {
    hooks.before?.();
    const fix = await directors.coverageRepair({ story, research, targets: repairTargets });
    hooks.after?.();
    patched = applyCoverageRepair(repairTargets, fix);
  }
  const rescreen = (kind: "long" | "short") => screenCoverage(kind, lists[kind].map((c, i) => (patched[kind].has(i) ? patched[kind].get(i) : c)));
  const screened = { long: rescreen("long"), short: rescreen("short") };
  const library = { long: screened.long.assets, short: screened.short.assets };
  const coverageRejected = [...screened.long.rejected, ...screened.short.rejected];
  const coverageRepaired = [...patched.long.keys()].map((i) => repairOutcome("long", i)).concat([...patched.short.keys()].map((i) => repairOutcome("short", i)));
  function repairOutcome(film: "long" | "short", index: number): RepairedCandidate {
    const reason = repairTargets.find((t) => t.film === film && t.index === index)!.reason;
    const rejected = screened[film].rejected.map((r) => r.index);
    if (rejected.includes(index)) return { film, index, reason, recovered: false };
    return { film, index, reason, recovered: true, id: assetId(film, index - rejected.filter((r) => r < index).length) };
  }
  const presentations = { long: buildPresentations(library.long), short: buildPresentations(library.short) };

  hooks.before?.();
  const plans = await directors.editor({ story, research, scripts, slots, library, presentations });
  hooks.after?.();
  // A priority on a slot that cannot move is dropped locally; every other defect
  // except an adjacent identical presentation fails the plan here.
  const checked = {
    long: validateEdit("long", slots.long, normalizeMotionPriorities(slots.long, plans?.long).plan, presentations.long, true),
    short: validateEdit("short", slots.short, normalizeMotionPriorities(slots.short, plans?.short).plan, presentations.short, true),
  };
  // Adjacent identical presentations get at most ONE targeted repair call, which may
  // re-pick only the target slots; no retry. The result is validated in full, so a
  // failed repair stops the plan with the normal validation error.
  const held = (kind: "long" | "short") => archiveHolds(slots[kind], checked[kind].map((e) => e.presentationId), presentations[kind]);
  const targets = { long: adjacentRepeatTargets(checked.long, held("long")), short: adjacentRepeatTargets(checked.short, held("short")) };
  let answer: { long: unknown; short: unknown } = checked;
  if (directors.repair && (targets.long.length || targets.short.length)) {
    const allowed = repairAllowedIds({ presentations, edit: checked, targets }); // a target with no option fails before the call
    hooks.before?.();
    const fix = await directors.repair({ story, slots, library, presentations, edit: checked, targets });
    hooks.after?.();
    answer = {
      long: normalizeMotionPriorities(slots.long, applyEditRepair("long", checked.long, allowed.long, fix?.long)).plan,
      short: normalizeMotionPriorities(slots.short, applyEditRepair("short", checked.short, allowed.short, fix?.short)).plan,
    };
  }
  const edit = {
    long: validateEdit("long", slots.long, answer.long, presentations.long),
    short: validateEdit("short", slots.short, answer.short, presentations.short),
  };

  const film = (kind: "long" | "short") => {
    const motion = selectMotion(kind, slots[kind], edit[kind], presentations[kind], library[kind]);
    return assembleEdit(kind, slots[kind], edit[kind], presentations[kind], library[kind], motion, story, research);
  };
  return { long: film("long"), short: film("short"), coverageRejected, coverageRepaired };
}

// Phrase beats -> fixed edit slots for one film, checked before any planner sees
// them. A broken grid is a PB4 bug, so it fails here, before any provider call.
export function planSlots(kind: "long" | "short", script: string, narration: Narration): EditSlot[] {
  const beats = buildBeats(kind, script, narration);
  const slots = buildEditSlots(kind, beats);
  const problems = slotGridProblems(kind, beats, slots);
  if (problems.length) throw new Error(`Edit slot grid is broken: ${problems.join("; ")}.`);
  return slots;
}

// Universal generated-image hygiene that can never contradict a scene: it forbids
// only artefacts no beat would ever legitimately need to SHOW. Scene-specific
// restrictions (era, flags, behaviour) are owned by the asset's mustNotShow,
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

// Where each mustShow element must sit, so PB4's detail crops land on it.
const REGION_PLACEMENT: Record<Region, string> = {
  left: "in the left third of the frame",
  center: "in the center of the frame",
  right: "in the right third of the frame",
  whole: "across the frame",
};

// The final image prompt for a reconstruction asset. Built from the asset itself -
// its purpose, constraints (each must-show element pinned to its region, because
// the detail presentations crop those regions) and specific scene, the period and
// place - not from a blanket story-world sentence. The story world informs STYLE
// only (palette). This same builder is the clean reconstruction FALLBACK for an
// archive asset when acquisition finds no material, so it never asks the model to
// fake archival footage.
function reconstructionPrompt(
  kind: "long" | "short",
  world: StoryWorld,
  story: Story,
  purpose: string,
  mustShow: MustShowElement[],
  mustNotShow: string[],
  scene: string,
  useMaster: boolean,
): string {
  const frame = kind === "short" ? "Vertical 9:16 composition" : "Wide 16:9 composition";
  const show = mustShow.length ? ` Must show: ${mustShow.map((e) => `${e.description} (${REGION_PLACEMENT[e.region]})`).join("; ")}.` : "";
  const avoid = mustNotShow.length ? ` Do not show: ${mustNotShow.join("; ")}.` : "";
  const setting = [world.place || story.place, world.period].filter(Boolean).join(", ");
  const where = setting ? ` Setting: ${setting}.` : "";
  return `Purpose: ${purpose}${show}${avoid} Scene: ${scene}.${where} ${frame}. Palette: ${world.palette}. ${RECON_REALISM} ${pb1ReferenceNote(useMaster)} Do not include ${IMAGE_HYGIENE}.`;
}

// A graphic describes the information it must convey (purpose + must-show), not a
// generic map/timeline template and never cinematic/reconstruction wording. Kept
// almost entirely visual - the readable explanation is left to the app's captions.
// The full Coverage concept is used; it is never truncated. No new Remotion map
// engine here.
function graphicPrompt(world: StoryWorld, story: Story, purpose: string, mustShow: MustShowElement[], scene: string): string {
  const show = mustShow.length ? ` It must make clear: ${mustShow.map((e) => e.description).join("; ")}.` : "";
  const concept = scene ? ` Concept: ${scene}.` : "";
  return `Flat editorial information graphic, not a photographic scene. Purpose: ${purpose}${show}${concept} Region and period: ${story.place}, ${world.period}. Keep it almost entirely visual with minimal or no text - the app adds captions separately, so do not render paragraphs, labels or legends. Muted palette ${world.palette}, flat even lighting and no posed actors. Do not include ${IMAGE_HYGIENE}.`;
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
  // A reuse shows its asset owner's still (resolveReuse); it never acquires media.
  if (shot.edit === "reuse") throw new Error(`${kind} slot ${shot.index} reuses asset ${shot.assetId} and never acquires its own still.`);
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
  if (shot.edit === "reuse") throw new Error(`${kind} slot ${shot.index} reuses asset ${shot.assetId}; only the asset's owning slot gets motion.`);
  if (config.mode !== "live" || !shot.path) return; // mock keeps the transform motion
  const rel = `motion/${kind}-${String(shot.index).padStart(2, "0")}.mp4`;
  await generateMotion({ prompt: motionPrompt(shot), imagePath: inStory(story.slug, shot.path), kind, outPath: inStory(story.slug, rel) });
  shot.motionPath = rel;
  shot.mediaType = "video";
}

// Refuse a stored plan that is not a Film Grammar v2E media edit (for example a v1
// shot list, or a v2D per-slot plan, from an older job resumed after this change).
// Reading one as the current edit would silently misplace cuts or assets, so fail
// clearly instead. Every used asset must have exactly one owning "new" slot, and
// every "reuse" must point at the owner of the same asset.
export function assertFilmGrammarPlan(kind: "long" | "short", shots: PlannedShot[]): void {
  const bad = (why: string) =>
    new Error(`The ${kind} visual plan was built before Film Grammar v2E media edits (${why}). Rebuild the visuals so they are planned again.`);
  const owners = new Map<string, number>();
  shots.forEach((s, i) => {
    if (s.edit !== "new" && s.edit !== "reuse") throw bad(`slot ${i} has no edit action`);
    if (!Number.isFinite(s.startSec) || !Number.isFinite(s.endSec)) throw bad(`slot ${i} has no screen time`);
    if (!FRAMINGS.includes(s.framing)) throw bad(`slot ${i} has no framing`);
    if (typeof s.assetId !== "string" || !s.presentation) throw bad(`slot ${i} has no media asset`);
    if (s.edit === "new") {
      if (owners.has(s.assetId)) throw bad(`asset ${s.assetId} has two owning slots`);
      owners.set(s.assetId, s.index);
    }
  });
  shots.forEach((s, i) => {
    if (s.edit !== "reuse") return;
    const src = typeof s.assetShot === "number" ? shots[s.assetShot] : undefined;
    if (!src || src.edit !== "new" || src.assetId !== s.assetId) throw bad(`slot ${i} reuses ${s.assetId} without its owning slot`);
  });
}

// Point every "reuse" slot at the still its asset's owner acquired. Never provider
// work: no image generation, no archive lookup, no motion, no charge. The owner
// must be the "new" slot of the same asset, with its still on disk; a missing or
// video-only owner fails clearly rather than generating anything in its place. A
// reuse never plays the owner's motion clip: the clip belongs to the owner's slot.
export function resolveReuse(story: Story, kind: "long" | "short", shots: PlannedShot[]): void {
  for (const shot of shots) {
    if (shot.edit !== "reuse") continue;
    const src = typeof shot.assetShot === "number" ? shots[shot.assetShot] : undefined;
    const label = `${kind} slot ${shot.index} (asset ${shot.assetId}, owner slot ${shot.assetShot})`;
    if (!src || src.edit !== "new" || src.assetId !== shot.assetId) throw new Error(`Cannot resolve ${label}: it must reuse the asset's owning slot.`);
    if (!src.path || !isStillPath(src.path)) throw new Error(`Cannot resolve ${label}: the owner has no still image (only ${src.motionPath ?? "nothing"}).`);
    if (!existsSync(inStory(story.slug, src.path))) throw new Error(`Cannot resolve ${label}: the owner's still ${src.path} is missing.`);
    shot.path = src.path;
    shot.mediaType = "image";
    shot.truth = src.truth; // an archive asset that fell back to reconstruction stays labelled honestly
    shot.source = src.source;
  }
}

function isStillPath(p: string): boolean {
  return /\.(png|jpe?g|webp)$/i.test(p);
}

// The visual preview shows every EDIT SLOT in order, so the gate reflects the
// real cut list, not only the paid assets. Each frame names its asset and
// presentation, so reuse is visible. The truth counts cover the unique used
// assets; every other slot reuses one of them at no cost.
export function buildPreview(story: Story, longShots: PlannedShot[], shortShots: PlannedShot[]): VisualPreview {
  const all = [...longShots, ...shortShots];
  const assets = all.filter((s) => s.edit === "new");
  // Count each truth kind separately so graphics are not lumped into reconstruction.
  const archive = assets.filter((s) => s.truth === "archive").length;
  const graphic = assets.filter((s) => s.truth === "graphic").length;
  const reconstruction = assets.filter((s) => s.truth === "reconstruction").length;
  const selected = all.filter((s) => s.wantsMotion);
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
        edit: s.edit,
        framing: s.framing,
        asset: s.assetId,
        presentation: s.presentation,
        ...(s.focus ? { focus: s.focus } : {}),
        ...(typeof s.startBeat === "number" ? { startBeat: s.startBeat, endBeat: s.endBeat } : {}),
        startSec: s.startSec,
        durationSec: Math.max(0, s.endSec - s.startSec),
      }));
  const frames = [...toFrames("long", longShots), ...toFrames("short", shortShots)];
  return {
    moments: all.length,
    uniqueAssets: assets.length,
    reusedPresentations: all.length - assets.length,
    archive,
    reconstruction,
    graphic,
    motionCandidates: all.filter((s) => s.motionCandidate).length,
    motionSelected: selected.length,
    remainingMotionCost: config.mode === "live" ? round(selected.filter((s) => !s.motionPath).length * PRICING.runway.video5s) : 0,
    frames,
  };
}

// Lay the edit slots across the film timeline and attach subtitles. The local
// SLOT GRID owns every cut: one render shot per slot, placed at the slot's own
// screen time, and the renderer never invents an extra cut because a shot is
// long. A motion clip plays only on its own slot, which only allows motion when it
// ends inside the clip, so no timeline relies on a frozen final frame. The one
// exception: an allowed archive hold (two adjacent slots with the identical still)
// renders as ONE continuous shot across both slots, so the picture never restarts
// (no cut flash, no reset of its slow breath) at the internal boundary. The plan
// keeps both slots; subtitles and narration timing are untouched.
export function buildRenderPlan(kind: "long" | "short", story: Story, shots: PlannedShot[], narration: Narration, accent: string): RenderPlan {
  assertFilmGrammarPlan(kind, shots);
  const width = kind === "short" ? 1080 : 1920;
  const height = kind === "short" ? 1920 : 1080;
  const audioEndFrame = Math.max(1, Math.ceil(narration.durationSec * FPS));
  const durationInFrames = audioEndFrame + Math.round(END_TAIL_SEC * FPS);
  const frameAt = (sec: number) => Math.min(durationInFrames - 1, Math.max(0, Math.round(sec * FPS)));
  const clipFrames = MOTION_CLIP_SECONDS * FPS;

  const ordered = [...shots].sort((a, b) => a.index - b.index);
  const renderShots: Shot[] = ordered.map((s, i) => {
    const start = i === 0 ? 0 : frameAt(s.startSec);
    const end = i === ordered.length - 1 ? durationInFrames : frameAt(ordered[i + 1].startSec);
    // A reuse always shows the owner's STILL, never its motion clip.
    const video = s.edit === "new" && !!s.motionPath;
    const shot: Shot = {
      id: `${kind}-${String(s.index).padStart(2, "0")}`,
      startFrame: start,
      endFrame: Math.max(start + 1, end),
      mediaType: video ? "video" : "image",
      path: (video ? s.motionPath : s.path) ?? "",
      truth: s.truth,
      motion: s.motion,
      framing: s.framing,
      caption: s.caption,
      source: s.source,
    };
    if (video && shot.endFrame - shot.startFrame > clipFrames) {
      throw new Error(`${shot.id} gives a ${MOTION_CLIP_SECONDS}s motion clip ${((shot.endFrame - shot.startFrame) / FPS).toFixed(2)}s of screen time; rebuild the visuals.`);
    }
    return shot;
  });
  const merged: Shot[] = [];
  renderShots.forEach((shot, i) => {
    const prev = ordered[i - 1];
    const s = ordered[i];
    const held = i > 0 && shot.mediaType === "image" && merged.at(-1)!.mediaType === "image" && prev.assetId === s.assetId && prev.presentation === s.presentation;
    if (held) merged.at(-1)!.endFrame = shot.endFrame;
    else merged.push(shot);
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
    shots: merged,
    subtitles: buildCues(narration.words, FPS, kind, durationInFrames),
  };
}
