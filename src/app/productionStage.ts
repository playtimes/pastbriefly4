// Presentation-only reading of the unchanged job state for the Production
// screen and the Story page: which face to show, which of six human stages is
// current, whether a progress figure is honest, and which finished job the Ready
// face shows. Pure, so it is unit-tested like route.ts. The pipeline, its steps,
// states and QA phases are not touched.
import { visualIssuesForJob } from "./visualReview/visualIssues.ts";
import type { Job, JobStep, Video } from "../types.ts";

export type DisplayStage = "research" | "writing" | "narration" | "visuals" | "checking" | "rendering";

export const DISPLAY_STAGES: [DisplayStage, string][] = [
  ["research", "Researching"],
  ["writing", "Writing"],
  ["narration", "Recording narration"],
  ["visuals", "Creating visuals"],
  ["checking", "Checking films"],
  ["rendering", "Rendering"],
];

type StageJob = Pick<Job, "state" | "step"> & Partial<Pick<Job, "preview" | "message" | "textQa" | "progress">>;

// Text QA (review, repair, final verification) runs while the job waits at the
// text gate: that is Writing. Asset QA, the Visual Autopilot and Director QA for
// Long and Short (with their bounded repairs) run at the visual gate: that is
// Checking films. `previous` is the stage last shown for this job, used only
// for a requeued job, whose step reads "queued" wherever it resumes.
export function displayStage(job: StageJob, previous?: DisplayStage): DisplayStage {
  if (job.state === "awaiting_text") return "writing";
  if (job.state === "awaiting_preview") return "checking";
  switch (job.step) {
    case "queued":
      return resumeStage(job, previous);
    case "research":
      return "research";
    case "scripts":
      return "writing";
    case "narration":
      return "narration";
    case "archive":
    case "stills":
      return "visuals";
    case "preview":
      return "checking";
    case "build":
    case "rendering":
    case "finishing":
      return "rendering";
  }
}

// Approving the text, approving more spend or rebuilding the visuals requeue the
// same job with step "queued". Where it resumes follows from what it already has.
function resumeStage(job: StageJob, previous?: DisplayStage): DisplayStage {
  if (job.preview) return "rendering"; // approved visuals go on to motion and render
  if (job.message === "Rebuilding visuals") return "visuals";
  if (job.textQa?.status === "passed") return "narration";
  return previous ?? "research";
}

export function stageIndex(job: StageJob, previous?: DisplayStage): number {
  if (job.state === "done") return DISPLAY_STAGES.length;
  return DISPLAY_STAGES.findIndex(([s]) => s === displayStage(job, previous));
}

// Once both films are rendered, finishing is the file check and Final-film QC:
// still the last stage (the bar never jumps back), but not "Rendering".
export function stageLabel(job: StageJob, previous?: DisplayStage): string {
  const stage = displayStage(job, previous);
  if (job.state === "queued" && stage === "research") return "Starting";
  if (stage === "rendering" && job.step === "finishing") return "Checking final films";
  return DISPLAY_STAGES.find(([s]) => s === stage)![1];
}

// The steps whose count describes their whole stage. Archive (only part of
// Creating visuals) and motion (only part of Rendering) would make the bar jump
// backwards when the next step's count takes over, so they show a spinner.
const COUNTED: JobStep[] = ["scripts", "narration", "stills", "rendering"];

// A percentage for the current stage, or null for a spinner. Only a RUNNING job
// counts: at the text and visual gates the job still carries the finished
// Scripts or Stills count, which says nothing about the QA running there. A full
// count means that step's own work is done and something uncounted (the script
// audit, the hand-off to the next step) is running, so it shows a spinner too.
export function stageProgress(job: StageJob): number | null {
  const p = job.progress;
  if (job.state !== "running" || !p || !(p.total > 0) || !COUNTED.includes(job.step)) return null;
  if (!p.percent && p.current >= p.total) return null;
  return Math.max(0, Math.min(100, Math.round((p.current / p.total) * 100)));
}

// ---- Faces

export type ProductionFace = "running" | "text" | "visuals" | "final" | "failed" | "done";

type FaceJob = Pick<Job, "state" | "review" | "preview" | "textQa" | "assetQa" | "directorQa" | "visualAutopilot" | "updatedAt">;

// The worker starts the automatic check a moment AFTER the job reaches a gate,
// so a poll can land in between. A gate with no check result that stays that
// way this long is not waiting for one: its in-memory Text QA or Autopilot was
// lost to a restart, or this job never gets one. Then the user decides.
export const GATE_GRACE_MS = 10_000;
const pastGrace = (job: Pick<Job, "updatedAt">, now: number): boolean => {
  const at = Date.parse(job.updatedAt);
  return !Number.isFinite(at) || now - at > GATE_GRACE_MS;
};

// Which face of the Production screen a job shows. At a gate the automatic
// check running, or not yet begun, is still PB4 working; only a settled check
// (or one that is plainly never coming) hands the gate to the user. The
// finished-film gate is reached only after its checks completed, so it is the
// user's at once.
export function productionFace(job: FaceJob, now: number = Date.now()): ProductionFace {
  if (job.state === "failed") return "failed";
  if (job.state === "done") return "done";
  const face = gateFace(job);
  if (face === "final") return "final";
  if (face === "text") return job.textQa?.status === "stopped" || (!job.textQa && pastGrace(job, now)) ? "text" : "running";
  if (face === "visuals") {
    const settled = job.assetQa?.status === "done" || !!job.directorQa?.long || !!job.directorQa?.short || job.visualAutopilot?.status === "failed";
    return settled || (!job.visualAutopilot && !job.assetQa && pastGrace(job, now)) ? "visuals" : "running";
  }
  return "running";
}

// The gate face a job would show once its automatic check has settled: null
// while that check is running, or away from a gate. The Production screen uses
// it to keep a face it already handed over, whatever a later update does to
// `updatedAt` (a manual revision, say).
export function gateFace(job: FaceJob): "text" | "visuals" | "final" | null {
  if (job.state === "awaiting_text" && job.review && job.textQa?.status !== "running") return "text";
  if (job.state === "awaiting_preview" && job.preview && job.assetQa?.status !== "running" && job.visualAutopilot?.status !== "running") return "visuals";
  if (job.state === "awaiting_final") return "final";
  return null;
}

// How many concrete things the user is asked to look at (0 when PB4 only knows
// it stopped, e.g. the Text QA reason was lost to a restart).
function needsYouCount(job: Job): number {
  const face = productionFace(job);
  if (face === "text") return job.textQa?.status === "stopped" ? job.textQa.issues.length : 0;
  if (face === "visuals") return visualIssuesForJob(job).length;
  if (face === "final") return job.finalQa?.issues.length ?? 0;
  return 0;
}

// The Story page's one-line production state for its active job.
export function storyProductionLabel(job: Job): string {
  const face = productionFace(job);
  if (face === "text" || face === "visuals" || face === "final") {
    const n = needsYouCount(job);
    return n ? `Needs you · ${n} ${n === 1 ? "issue" : "issues"}` : "Needs you";
  }
  return `In production · ${stageLabel(job)}`;
}

// ---- Ready

// A complete production: a pair-first job's Long + Short, or a Long-first job's
// Long alone once it reached LONG COMPLETE (no Short exists yet).
export interface CompletePair {
  jobId: string;
  long: Video;
  short?: Video;
}

// The newest job with BOTH a Long and a Short among the story's videos (newest
// first, as the server returns them). A job adds its videos one at a time and a
// later job can fail between them, so the first video is not proof of anything:
// a newer lone video never hides the last complete pair. With `jobId`, only that
// job's pair. A job in `longComplete` (LONG COMPLETE, from the server) is
// complete with its Long alone; any other lone video still is not.
export function latestCompletePair(videos: Video[], jobId?: string, longComplete: string[] = []): CompletePair | null {
  const byJob = new Map<string, Partial<Record<Video["kind"], Video>>>();
  for (const v of videos) {
    const pair = byJob.get(v.jobId) ?? {};
    pair[v.kind] ??= v; // newest of each kind
    byJob.set(v.jobId, pair);
  }
  for (const [id, pair] of byJob) {
    if (jobId && id !== jobId) continue;
    if (pair.long && pair.short) return { jobId: id, long: pair.long, short: pair.short };
    if (pair.long && longComplete.includes(id)) return { jobId: id, long: pair.long };
  }
  return null;
}

// The job the Production screen follows when it opens: the running or paused
// job, else the latest job when it failed, else the job that rendered the newest
// complete pair (its Ready face, also after a reload). With none of these it
// navigates as it always did.
export type ProductionTarget = { jobId: string } | { navigate: "watch" | "story" };
export function productionTarget(detail: { activeJob: Pick<Job, "id"> | null; failedJob: Pick<Job, "id"> | null; videos: Video[]; longCompleteJobIds?: string[] }): ProductionTarget {
  if (detail.activeJob) return { jobId: detail.activeJob.id };
  if (detail.failedJob) return { jobId: detail.failedJob.id };
  const pair = latestCompletePair(detail.videos, undefined, detail.longCompleteJobIds);
  if (pair) return { jobId: pair.jobId };
  return { navigate: detail.videos.length >= 2 ? "watch" : "story" };
}
