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

// awaiting_final: both final mp4s exist and passed the file contract, all four
// Final-film QC specialists answered, and at least one concrete issue remains.
// The films are kept untouched and nothing is registered until a person decides.
export type JobState = "queued" | "running" | "awaiting_text" | "awaiting_preview" | "awaiting_final" | "done" | "failed";

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
  // (scripts/narration/archive/stills/build), or a plain percentage while rendering
  // (percent: true, current of 100). Absent for research/finishing.
  progress?: { current: number; total: number; percent?: boolean };
  textQa?: TextQaState; // Automatic Director Text QA, around the text gate only (server memory, never persisted)
  assetQa?: AssetQaState; // Pixel-aware Asset QA at the visual preview: its phase, then the latest result (persisted)
  directorQa?: DirectorQaRuns; // Run Director QA per film at the visual preview: its phase, then the latest result (persisted)
  visualAutopilot?: VisualAutopilotState; // the Visual Autopilot chain around the visual gate (server memory, never persisted)
  finalQa?: FinalQaState; // the finished-film concerns, only while awaiting_final
  // "long-first" for a Long-first job (Stage 16A): it makes and finishes only the
  // Long. Absent for a pair-first job (every job created before Long-first).
  flow?: JobFlow;
  createdAt: string;
  updatedAt: string;
}

export type JobFlow = "long-first";

// A Long-first job's media live in their own workspace inside the story folder,
// jobs/<jobId>/, so producing a story again can never overwrite or delete an
// earlier production's files. A pair-first job keeps the story-root paths it has
// always used: an empty prefix. Decided by the flow alone, never by a path's shape.
export function productionMediaPrefix(jobId: string, longFirst: boolean): string {
  if (!longFirst) return "";
  if (!/^[A-Za-z0-9_-]+$/.test(jobId)) throw new Error(`Job id ${JSON.stringify(jobId)} cannot name a media folder.`);
  return `jobs/${jobId}`;
}

// A story-folder-relative production path ("images/hero.png") inside a job's
// media prefix: "jobs/<jobId>/images/hero.png", or unchanged for a legacy job.
export function productionRel(prefix: string, rel: string): string {
  return prefix ? `${prefix}/${rel}` : rel;
}

// ---- Final-film QC (the finished-film gate) ----
// Only the concrete publishing concern reaches the browser: which film, fact or
// visual, why, and for a fact the short narration fragment it is about. The
// specialists' evidence stays in the job's private scratch.
export interface FinalQaIssue {
  film: "long" | "short";
  area: "fact" | "visual";
  reason: string;
  text?: string;
}
export interface FinalQaState {
  issues: FinalQaIssue[];
}

// ---- Automatic Director Text QA (the text gate autopilot) ----
// One Director review of the saved draft, at most one automatic repair through
// the existing revision path, and one read-only verification after a repair.
// PASS approves through the existing approval path; anything else stops at the
// Story Review with the reason.
export type TextQaSection = "story" | "hook" | "spine" | "facts" | "long" | "short";
export const TEXT_QA_SECTIONS: TextQaSection[] = ["story", "hook", "spine", "facts", "long", "short"];
// A Long-first draft has no Short, so its Text QA can never name one.
export const LONG_TEXT_QA_SECTIONS: TextQaSection[] = ["story", "hook", "spine", "facts", "long"];
export interface TextQaIssue {
  section: TextQaSection;
  reason: string;
}
export interface TextQaReview {
  decision: "PASS" | "REPAIR" | "HUMAN_REVIEW";
  summary: string;
  repairFeedback: string | null; // only for REPAIR
  humanReview: TextQaIssue[]; // only for HUMAN_REVIEW
}
export interface TextQaVerify {
  decision: "PASS" | "HUMAN_REVIEW";
  summary: string;
  humanReview: TextQaIssue[];
}
export type TextQaPhase = "review" | "repair" | "verify";
export type TextQaStage = "director_review" | "revision" | "final_verify";
export type TextQaState =
  | { status: "running"; phase: TextQaPhase }
  | { status: "passed" }
  | { status: "stopped"; stage: TextQaStage; message: string; summary: string; issues: TextQaIssue[]; feedback?: string; error?: string };

// ---- Pixel-aware Asset QA (v1: the current owner stills at the visual preview) ----
// One pixel review of every unique current owner still, at most one automatic
// regeneration of a clearly repairable GENERATED still through the existing
// regenerateStill path, then one read-only verification of the regenerated
// stills. Archive stills are read only. Whatever remains is a human exception.
export type AssetQaDecision = "PASS" | "REGENERATE" | "HUMAN_REVIEW";
export type AssetQaStage = "review" | "regenerate" | "verify";
export interface AssetQaIssue {
  kind: "long" | "short";
  assetId: string;
  truth: "archive" | "reconstruction" | "graphic";
  stage: AssetQaStage; // the step that left it with a person
  reason: string;
  incomplete?: boolean; // the pixel review of this asset could not complete
}
export type AssetQaPhase = "review" | "repair" | "verify";
export type AssetQaState =
  | { status: "running"; phase: AssetQaPhase; current?: number; total?: number }
  // clean: every current still was reviewed (and any regeneration verified) with nothing left for a person.
  | { status: "done"; reviewed: number; regenerated: number; incomplete: number; message: string; issues: AssetQaIssue[]; clean: boolean };

// ---- Visual Autopilot (fresh visuals only) ----
// Asset QA, then Director QA for Long and for Short, then the existing visual
// approval when all three are clean. Which job is in the chain is server memory
// only; each stage's own persisted state stays the record of what happened.
export type VisualAutopilotState = { status: "running" } | { status: "passed" } | { status: "failed"; error: string };

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
  shortScript?: string; // absent for a Long-first job: it has no Short
}

// Director feedback for a text-gate revision: checked the same way by the review
// screen (before any request) and by the server. Never truncated.
export const DIRECTOR_FEEDBACK_MAX = 20000;
export function directorFeedbackError(feedback: string): string | null {
  const f = feedback.trim();
  if (!f) return "Director feedback is required.";
  if (f.length > DIRECTOR_FEEDBACK_MAX) return "Director feedback must be 20,000 characters or fewer.";
  return null;
}

// Optional Director feedback for one still regeneration. It is appended to an
// image prompt, so its cap is far below the text-revision one. Blank means none.
export const STILL_FEEDBACK_MAX = 2000;
export function stillFeedbackError(feedback: string): string | null {
  return feedback.trim().length > STILL_FEEDBACK_MAX ? "Director feedback must be 2,000 characters or fewer." : null;
}

// Director feedback for one film's sequence revision: required, and sized for an
// editing instruction rather than a script. Checked by the board and the server.
export const SEQUENCE_FEEDBACK_MAX = 4000;
export function sequenceFeedbackError(feedback: string): string | null {
  const f = feedback.trim();
  if (!f) return "Director feedback is required.";
  if (f.length > SEQUENCE_FEEDBACK_MAX) return "Director feedback must be 4,000 characters or fewer.";
  return null;
}

// What a successful sequence revision did: the slot ids it changed, and each
// requested change it could not make (those slots kept their visual).
export interface SequenceRevisionReport {
  changed: number[];
  unresolved: { slotId: number; reason: string }[];
}

// The reason a sequence revision gives for a slot no existing presentation can
// legally fill on its own.
export const NO_LEGAL_ALTERNATIVE = "No legal alternative existing presentation is available.";

// The original Director finding behind an automatic repair that stayed
// unresolved, carried (in memory only) into the coordinated repair of that slot.
export interface DirectorRepairIntent {
  reason: string;
  instruction: string;
}

// The one coordinated-neighbourhood repair Director QA may make last: a small
// window around one unresolved slot, re-picked together from existing media.
export interface CoordinatedRepairReport {
  target: number;
  changed: number[];
  humanReview: { slotId: number; reason: string }[]; // the target when it stayed unresolved, and any slot not attempted
  remaining: { slotId: number; reason: string }[]; // the deterministic patterns still present afterwards
  error?: string; // the coordinated revision failed; the edit before it stays saved
}

// The final read-only Director verification of the CURRENT saved film, after all
// automatic repairs. Its findings are the definitive semantic exceptions; the
// deterministic patterns are recomputed on that same saved film.
export interface DirectorVerifyReport {
  summary: string;
  humanReview: { slotId: number; reason: string }[];
  patterns: { slotId: number; reason: string }[];
  error?: string; // the verification failed; the repaired edit is kept
}

// Director sequence QA (v1): one editorial review of one film's stored edit.
// A repair can be applied automatically with existing media; a human-review
// finding is only shown. Slots in neither list are implicitly kept.
export interface DirectorQaFinding {
  slotId: number;
  reason: string;
  instruction: string;
}
export interface DirectorQaReport {
  summary: string;
  repairs: DirectorQaFinding[];
  humanReview: { slotId: number; reason: string }[];
}

// The deterministic cleanup after Director QA: at most one more bounded sequence
// revision, aimed only at repetition patterns PB4 can see in its own metadata.
// `remaining` is every such pattern still present afterwards, as human exceptions.
export interface SequenceCleanupReport {
  ran: boolean; // a cleanup revision was attempted
  changed: number[];
  unresolved: { slotId: number; reason: string }[];
  remaining: { slotId: number; reason: string }[];
  error?: string; // the cleanup revision failed; the edit before it stays saved
}

// ---- Run Director QA, orchestrated on the server ----
// One film's latest Director QA run, persisted in the job: its phase while it
// runs, then the final result the Director panel shows. Only the outcome is kept:
// no prompts, provider answers or history. The initial review's semantic findings
// are never kept once a final verification ran (they may describe replaced visuals).
export type DirectorQaPhase = "reviewing" | "repairing" | "cleaning" | "coordinating" | "verifying";
export interface DirectorQaSlotNote {
  slotId: number;
  reason: string;
}
export interface DirectorQaResult {
  repairError?: string; // the Director's repairs were not applied
  cleanupError?: string; // the edit before the cleanup stays saved
  coordinatedError?: { target: number; error: string }; // the edit before it stays saved
  verified: boolean; // the final verification completed
  verifyError?: string; // the repaired edit is kept; the final semantic check did not complete
  automaticChanges: number;
  cleanupChanges: number;
  coordinatedChanges: number;
  changed: number[]; // every slot an automatic step changed
  unresolvedRepairs: DirectorQaSlotNote[];
  requestedRepairs: DirectorQaSlotNote[]; // only when the Director's repairs failed
  humanReview: DirectorQaSlotNote[];
  summary: string;
  clean: boolean; // the FINAL film: verified, nothing for a person, no unresolved repair, no failed step (automatic changes allowed)
}
export type DirectorQaRun =
  | { status: "running"; phase: DirectorQaPhase }
  | { status: "failed"; error: string } // the review failed: nothing changed
  | { status: "interrupted" } // a restart stopped it; the last completed valid step is saved
  | ({ status: "complete" } & DirectorQaResult);
export type DirectorQaRuns = { long?: DirectorQaRun; short?: DirectorQaRun };

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
