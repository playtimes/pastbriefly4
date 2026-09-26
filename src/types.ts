// Shared types across server, production, render and app.

import type { Framing } from "./render/types.ts";

export const CATEGORIES = [
  "Conflicts & Standoffs",
  "Money & Deception",
  "Disasters",
  "Escapes & Operations",
  "Strange Everyday History",
] as const;

export type Category = (typeof CATEGORIES)[number];

export interface Source {
  title: string;
  url: string;
  note: string; // what this source supports
}

export interface StoryMoment {
  title: string;
  detail: string;
}

// One concrete, production-relevant fact - the factual spine of the film. Any
// date, actor, location, sequence or attribution the scripts rely on lives here,
// each tied to a real supporting source in the final ResearchPackage.
export interface Fact {
  fact: string;
  sourceTitle: string;
  sourceUrl: string;
}

export interface Story {
  id: string;
  slug: string;
  title: string;
  hook: string;
  category: Category;
  year: string;
  place: string;
  summary: string;
  heroImage: string | null; // media-relative path
  moments: StoryMoment[];
  sources: Source[];
  productionNote: string;
  createdAt: string;
  // Derived for the client:
  published?: boolean; // whether its finished films are marked published
  saved?: boolean; // whether the user explicitly saved it to the Stories page
  hasVideos?: boolean;
  activeJobId?: string | null;
  activeJobStep?: JobStep | null;
}

export type JobState = "queued" | "running" | "awaiting_text" | "awaiting_preview" | "done" | "failed";

export type JobStep =
  | "queued"
  | "research"
  | "scripts"
  | "archive"
  | "stills"
  | "preview"
  | "narration"
  | "build"
  | "rendering"
  | "finishing";

// Human-facing labels for each step, in order.
export const STEP_LABELS: Record<JobStep, string> = {
  queued: "Queued",
  research: "Researching the story",
  scripts: "Writing the films",
  archive: "Finding historical material",
  stills: "Creating missing scenes",
  preview: "Reviewing visual direction",
  narration: "Recording narration",
  build: "Adding motion",
  rendering: "Rendering the films",
  finishing: "Finishing",
};

// The steps shown in the Creating screen, in the order they run.
export const STEP_ORDER: JobStep[] = ["research", "scripts", "narration", "archive", "stills", "build", "rendering", "finishing"];

export interface Job {
  id: string;
  storyId: string;
  state: JobState;
  step: JobStep;
  message: string;
  error: string | null;
  mock: boolean;
  estimatedCost: number;
  approvedMax: number;
  spent: number;
  preview: VisualPreview | null; // present once the visual direction is ready
  review?: StoryReview | null; // present only while awaiting the text review gate
  // Real per-unit progress for the current step, when it has a meaningful count
  // (scripts/narration/archive/stills/build). Absent for research/finishing.
  progress?: { current: number; total: number };
  createdAt: string;
  updatedAt: string;
}

export interface CostLine {
  label: string;
  usd: number;
  detail?: string;
}

export interface CostEstimate {
  total: number;
  lines: CostLine[];
}

// The editorial review shown after the audited scripts exist and before any
// media spend. Read straight from the job's scratch - never a new DB table. The
// user judges clarity and interest only; PB4 owns the facts.
export interface StoryReview {
  title: string;
  hook: string;
  facts: Fact[];
  moments: StoryMoment[];
  sources: Source[];
  longScript: string;
  shortScript: string;
}

// The taste gate shown before spending on motion.
export interface VisualPreview {
  moments: number; // edit slots, both films
  uniqueAssets?: number; // media assets actually acquired (each used asset once)
  reusedPresentations?: number; // slots that show an already-acquired asset again (no cost)
  archive: number;
  reconstruction: number;
  graphic: number;
  motionCandidates?: number; // slots eligible for motion under the local rules
  motionSelected: number;
  remainingMotionCost: number;
  frames: PreviewFrame[];
}

export interface PreviewFrame {
  kind: "long" | "short";
  slot?: number; // the edit slot id within its film
  path: string; // media-relative
  truth: "archive" | "reconstruction" | "graphic";
  motion: boolean;
  caption: string;
  // Film Grammar v2E: every frame is one fixed local edit slot (its index is the
  // slot id) covering phrase beats startBeat-endBeat. It shows one presentation
  // (base or a detail crop) of one media asset; a "reuse" frame shows an asset
  // that another slot (its owner) acquired. focus names a detail's elements.
  edit?: "new" | "reuse";
  framing?: Framing;
  asset?: string;
  presentation?: "base" | "detail-left" | "detail-center" | "detail-right";
  focus?: string;
  startBeat?: number;
  endBeat?: number;
  startSec?: number;
  durationSec?: number;
}

export type VideoKind = "long" | "short";

export interface Video {
  id: string;
  storyId: string;
  jobId: string;
  kind: VideoKind;
  path: string; // media-relative mp4
  width: number;
  height: number;
  durationSec: number;
  fps: number;
  hasAudio: boolean;
  createdAt: string;
}

// ---- Discovery niches (Create dashboard) ----
// Real, cached signals about what history/documentary subjects are drawing
// interest right now. Never fabricated: when the real sources are unavailable a
// group is marked unavailable rather than filled with invented names.

export type NicheKind = "trending" | "popular" | "recommended";

export interface NicheItem {
  name: string; // human-readable niche, e.g. "Cold War espionage"
  why: string; // one line on why it belongs in this group
  evidence: string[]; // real signals behind it (e.g. actual video titles)
}

export interface NicheGroup {
  available: boolean; // false when the real source data could not be produced
  updatedAt: string | null; // ISO timestamp of the underlying data, null if unavailable
  niches: NicheItem[];
  note?: string; // shown when unavailable (how to enable it)
}

export interface NichesResponse {
  trending: NicheGroup;
  popular: NicheGroup;
  recommended: NicheGroup;
}
