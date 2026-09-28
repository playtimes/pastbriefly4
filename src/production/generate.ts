import crypto from "node:crypto";
import { existsSync, readFileSync, renameSync, rmSync } from "node:fs";
import { config } from "../server/config.ts";
import { PRICING, assetReviewUsd, round, ttsUsd } from "../server/pricing.ts";
import { getJob, getStory, upsertStory, updateJob, addVideo, setScripts, approvePreview, type JobRecord } from "../server/store.ts";
import type { AssetQaIssue, AssetQaPhase, AssetQaStage, AssetQaState, DirectorQaRun, DirectorQaRuns, VisualAutopilotState, CoordinatedRepairReport, DirectorQaFinding, DirectorQaReport, DirectorRepairIntent, DirectorVerifyReport, JobStep, SequenceCleanupReport, Story, TextQaPhase, TextQaReview, TextQaStage, TextQaState, TextQaVerify, Video } from "../types.ts";
import { imageMimeType } from "../providers/openai.ts";
import {
  assetQaTargets,
  assetImageLabel,
  chunk,
  readAssetQa,
  openAiAssetReview,
  openAiAssetVerify,
  fallbackAssetReview,
  fallbackAssetVerify,
  type AppliedRepair,
  type AssetQaTarget,
  type AssetReviewer,
} from "./assetQa.ts";

import { runDirectorQa, directorQaResult } from "./directorQaRun.ts";

type AssetQaResult = Extract<AssetQaState, { status: "done" }>;

// Passed by Run Director QA to its own sequence repairs: a revision made INSIDE
// the running QA must not clear that run's own state. Any other sequence change
// (a manual revision, or a QA step called on its own) invalidates the film's result.
interface QaRunContext {
  qaRun?: boolean;
}
import { buildFilm } from "../app/visualReview/model.ts";
import { sequenceAttentionFlags, sequenceCleanup, OPENING_SEC, ENDING_SEC, type CleanupPattern } from "../app/visualReview/board.ts";
import { now } from "../server/db.ts";
import { clearWorkingVisuals, ensureStoryDirs, inStory, mediaRel, storyDir } from "./paths.ts";
import { researchStory } from "./research.ts";
import { writeScript, auditScripts, reviseStoryText, reviewStoryDraft, verifyStoryDraft, textQaCallsProvider } from "./scripts.ts";
import { recordNarration, type Narration } from "./narration.ts";
import { plainDashes } from "./text.ts";
import {
  planVisuals,
  acquireStill,
  seedArchiveLedger,
  ensureMaster,
  acquireMotion,
  buildPreview,
  buildRenderPlan,
  resolveReuse,
  assertFilmGrammarPlan,
  accentFor,
  planSlots,
  storedPresentations,
  retainPresentations,
  storedEdit,
  keptSlots,
  applySequenceRevision,
  sequenceSlotChoices,
  validateEdit,
  reassembleStoredEdit,
  openAiSequenceRevision,
  fallbackSequenceRevision,
  NO_LEGAL_ALTERNATIVE,
  openAiDirectorQa,
  openAiCoordinatedRevision,
  openAiDirectorVerify,
  fallbackDirectorVerify,
  readDirectorVerify,
  type DirectorQaInput,
  type SequenceRevisionInput,
  fallbackDirectorQa,
  readDirectorQa,
  directorRepairFeedback,
  type DirectorQaReviewer,
  type SequenceReviser,
  type SequenceUnresolved,
  type PlannedShot,
  type RetainedPresentation,
  type RejectedCandidate,
  type RepairedCandidate,
} from "./visuals.ts";
import type { ResearchPackage } from "./pipelineTypes.ts";
import type { Scripts } from "./scripts.ts";
import { renderFilms, probeVideo } from "../render/renderVideo.ts";
import { validateFinalVideo } from "../render/finalCheck.ts";

interface Scratch {
  research?: ResearchPackage;
  scriptParts?: { long?: string; short?: string };
  scripts?: Scripts;
  textApproved?: boolean; // the story review gate: set once the user approves the text
  narration?: { long?: Narration; short?: Narration };
  masterRef?: string;
  longShots?: PlannedShot[];
  shortShots?: PlannedShot[];
  coverageRejected?: RejectedCandidate[]; // Coverage candidates discarded by validation (film, raw index, reason)
  coverageRepaired?: RepairedCandidate[]; // either/or candidates sent to the one Coverage repair, and whether each was recovered
  // Per film, every presentation a saved edit has shown with its acquired still,
  // kept when a sequence revision drops its last slot (retainPresentations).
  retainedPresentations?: { long?: RetainedPresentation[]; short?: RetainedPresentation[] };
  // Pixel Asset QA of these visuals: "started" once it begins (so a restart never
  // runs it, or its regenerations, again), then its latest result.
  assetQa?: { status: "started" } | AssetQaResult;
  // Per film, the latest Run Director QA: its phase while it runs, then its
  // result. Valid only for the edit it checked: a later manual change clears it.
  directorQa?: DirectorQaRuns;
  spent?: number;
  renderPercent?: number; // whole-percent render progress across both films, only while rendering
}

// Preflight only: refuse to START a paid provider call that would push tracked
// spend past the approved ceiling. Never mutates spend. No-op in mock.
function budget(job: JobRecord, usd: number, scratch: Scratch): void {
  if (config.mode !== "live") return;
  const next = round((scratch.spent ?? 0) + usd);
  if (next > job.approvedMax + 1e-9) throw new Error(`Approved maximum $${job.approvedMax} would be exceeded ($${next}).`);
}

// Record the estimated spend after a paid call has succeeded, persisting the
// updated scratch and spend together so a crash can't keep the charge yet lose
// the work it paid for. PRICING stays the conservative budgeting model, not a bill.
function record(jobId: string, usd: number, scratch: Scratch): void {
  if (config.mode === "live") scratch.spent = round((scratch.spent ?? 0) + usd);
  updateJob(jobId, { scratch, spent: scratch.spent ?? 0 });
}

function step(jobId: string, step: JobStep, message: string, scratch: Scratch): void {
  updateJob(jobId, { state: "running", step, message, scratch });
}

// The final script fidelity audit as one resumable, separately-charged call: the
// same preflight/record pattern as the two draft writes. It runs only after both
// drafts exist. If it throws, the drafts stay in scratch and nothing is charged,
// so Retry re-runs only the audit; on success it is charged exactly once.
async function runScriptAudit(job: JobRecord, story: Story, research: ResearchPackage, drafts: Scripts, scratch: Scratch): Promise<Scripts> {
  budget(job, PRICING.openai.script, scratch);
  const audited = await auditScripts(story, research, drafts);
  record(job.id, PRICING.openai.script, scratch);
  return audited;
}

// Resolves "text_gate" when this run wrote a NEW draft and stopped at the text
// gate, which is where the worker starts Automatic Director Text QA, and
// "preview_gate" when it stopped at the visual preview with visuals no Asset QA
// has looked at yet, which is where the worker starts Pixel Asset QA.
export async function runJob(jobId: string, opts: { autoApprovePreview?: boolean; autoApproveText?: boolean } = {}): Promise<"text_gate" | "preview_gate" | void> {
  const job = getJob(jobId);
  if (!job || job.state === "done" || job.state === "failed") return;
  const story = getStory(job.storyId);
  if (!story) return;

  const scratch: Scratch = { ...(job.scratch as Scratch) };
  ensureStoryDirs(story.slug);
  const accent = accentFor(story.category);
  const drafted = !scratch.scripts;

  try {
    // 1. Research
    if (!scratch.research) {
      step(jobId, "research", "Researching the story", scratch);
      budget(job, PRICING.openai.research, scratch);
      scratch.research = await researchStory(story);
      record(jobId, PRICING.openai.research, scratch);
    }
    const research = scratch.research;

    // 2. Scripts - Long and Short are separate paid writes, then one combined
    //    fidelity audit (Final Text Integrity). Each of the three calls is
    //    resumable: the drafts live in scriptParts and survive an audit failure,
    //    and scratch.scripts is only set (and setScripts only stores) the audited
    //    result, so narration always speaks the audited scripts.
    if (!scratch.scripts) {
      step(jobId, "scripts", "Writing the films", scratch);
      scratch.scriptParts ??= {};
      const parts = scratch.scriptParts;
      if (parts.long === undefined) {
        budget(job, PRICING.openai.script, scratch);
        parts.long = await writeScript(story, research, "long");
        record(jobId, PRICING.openai.script, scratch);
      }
      if (parts.short === undefined) {
        budget(job, PRICING.openai.script, scratch);
        parts.short = await writeScript(story, research, "short");
        record(jobId, PRICING.openai.script, scratch);
      }
      const drafts = { long: parts.long!, short: parts.short! };
      // The audit is the third script call. It runs only for live, non-fixture
      // stories - the same gate writeScripts uses - so mock and Paul Bunyan keep
      // their deterministic drafts. On a later resume scratch.scripts already
      // exists, so this whole block is skipped and the audit is never re-charged.
      const final = story.slug !== "paul-bunyan" && config.mode === "live" ? await runScriptAudit(job, story, research, drafts, scratch) : drafts;
      // The finalized scripts are stored and narrated with plain hyphens only.
      scratch.scripts = { long: plainDashes(final.long), short: plainDashes(final.short) };
      setScripts(story.id, scratch.scripts);
      updateJob(jobId, { scratch });
    }
    const scripts = scratch.scripts;

    // Story review gate: the final research and audited scripts now exist, and no
    // media has been paid for yet. Stop here for an editorial review (is the story
    // clear and interesting?) before any narration, image, motion or render spend.
    // The flag lives in scratch, so the job survives a restart and never continues
    // past the gate on its own; approve-text sets it and requeues the SAME job.
    if (!scratch.textApproved && !opts.autoApproveText) {
      updateJob(jobId, { state: "awaiting_text", message: "Ready for story review", scratch });
      return drafted ? "text_gate" : undefined; // wait for Approve & continue (by Text QA or the user)
    }

    // 3. Narration - Long and Short are separate paid calls, each resumable.
    if (!scratch.narration?.long || !scratch.narration?.short) {
      step(jobId, "narration", "Recording narration", scratch);
      scratch.narration ??= {};
      const nar = scratch.narration;
      if (!nar.long) {
        budget(job, ttsUsd(scripts.long.length), scratch);
        nar.long = await recordNarration(story.slug, "long", scripts.long);
        record(jobId, ttsUsd(scripts.long.length), scratch);
      }
      if (!nar.short) {
        budget(job, ttsUsd(scripts.short.length), scratch);
        nar.short = await recordNarration(story.slug, "short", scripts.short);
        record(jobId, ttsUsd(scripts.short.length), scratch);
      }
    }
    const narration = scratch.narration as { long: Narration; short: Narration };

    // 4. Plan shots - TWO planning calls cover both films: the Coverage Director
    //    (media library), then the Editor (one presentation per fixed slot). Each
    //    call (and the optional Coverage repair and Editor repair calls) is preflighted
    //    and charged once it returns, even if its answer then
    //    fails validation (which stops the job before any acquisition). Reused on
    //    resume: once both plans are in scratch this block is skipped.
    if (!scratch.longShots || !scratch.shortShots) {
      step(jobId, "stills", "Planning the visuals", scratch);
      const plans = await planVisuals(story, research, scripts, narration, undefined, {
        before: () => budget(job, PRICING.openai.visualPlan, scratch),
        after: () => record(jobId, PRICING.openai.visualPlan, scratch),
      });
      scratch.longShots = plans.long;
      scratch.shortShots = plans.short;
      scratch.coverageRejected = plans.coverageRejected;
      scratch.coverageRepaired = plans.coverageRepaired;
      updateJob(jobId, { scratch });
    }
    // A plan stored by an older planner (e.g. a v1 shot list) is never reinterpreted.
    for (const [kind, shots] of films(scratch)) assertFilmGrammarPlan(kind, shots);

    // Master reference still - one OpenAI image per job. Generated once and reused
    // on resume/Continue: keyed off scratch, not hero.png existing (which may be a
    // discovery placeholder). Labelled as still work so a failure here reads as
    // image generation rather than the preceding narration step.
    // No masterRef yet means this job has not started visual assets. Shot files
    // are story-scoped, so clear an older job's shot stills, archive stills and
    // motion first; otherwise acquireStill would find and reuse them. Once
    // masterRef exists (resume, rebuild-visuals) this never runs again.
    if (!scratch.masterRef) {
      clearWorkingVisuals(story.slug);
      step(jobId, "stills", "Creating the reference image", scratch);
      budget(job, PRICING.openai.image, scratch);
      scratch.masterRef = await ensureMaster(story, research.world);
      record(jobId, PRICING.openai.image, scratch);
    }
    const master = scratch.masterRef;

    // Archive files already bound to owner assets (a resume) seed the duplicate
    // check, so no two distinct assets can end up with the same archive bytes.
    const ledger = seedArchiveLedger(story, films(scratch));
    step(jobId, "archive", "Finding historical material", scratch);
    for (const [kind, shots] of films(scratch)) {
      for (const shot of shots) {
        if (shot.edit === "new" && shot.truth === "archive" && !shot.path) {
          // Preflight the possible reconstruction fallback so a failed archive
          // search can never push spend past the cap; charge only if it generated.
          if (config.mode === "live") budget(job, PRICING.openai.image, scratch);
          const result = await acquireStill(story, kind, shot, master, ledger);
          if (result === "generated") record(jobId, PRICING.openai.image, scratch);
          else updateJob(jobId, { scratch });
        }
      }
    }

    step(jobId, "stills", "Creating missing scenes", scratch);
    for (const [kind, shots] of films(scratch)) {
      for (const shot of shots) {
        // Only the owning ("new") slot acquires an asset; its reuses share that still below.
        if (shot.edit === "new" && !shot.path) {
          if (config.mode === "live") budget(job, PRICING.openai.image, scratch);
          const result = await acquireStill(story, kind, shot, master, ledger);
          if (result === "generated") record(jobId, PRICING.openai.image, scratch);
          else updateJob(jobId, { scratch });
        }
      }
    }

    // Reuses point at their asset owner's still: no provider work and no charge.
    // The saved edit's presentations then enter each film's retained pool, before
    // any sequence revision can drop one.
    for (const [kind, shots] of films(scratch)) resolveReuse(story, kind, shots);
    for (const [kind, shots] of films(scratch)) retain(scratch, kind, shots);
    updateJob(jobId, { scratch });

    // 5. Visual preview gate
    const preview = buildPreview(story, scratch.longShots!, scratch.shortShots!);
    updateJob(jobId, { step: "preview", preview, scratch, message: "Reviewing visual direction" });

    const approved = opts.autoApprovePreview || getJob(jobId)!.previewApproved;
    if (!approved) {
      updateJob(jobId, { state: "awaiting_preview" });
      return scratch.assetQa ? undefined : "preview_gate"; // wait for the user to Continue
    }

    // 6. Motion (only after the preview is approved)
    step(jobId, "build", "Adding motion", scratch);
    for (const [kind, shots] of films(scratch)) {
      for (const shot of shots) {
        if (shot.edit === "new" && shot.wantsMotion && !shot.motionPath) {
          if (config.mode === "live") budget(job, PRICING.runway.video5s, scratch);
          await acquireMotion(story, kind, shot);
          if (shot.motionPath) record(jobId, PRICING.runway.video5s, scratch);
          else updateJob(jobId, { scratch });
        }
      }
    }

    // 7. Render both films
    scratch.renderPercent = 0;
    step(jobId, "rendering", "Rendering the films", scratch);
    const longPlan = buildRenderPlan("long", story, scratch.longShots!, narration.long, accent);
    const shortPlan = buildRenderPlan("short", story, scratch.shortShots!, narration.short, accent);
    await renderFilms(storyDir(story.slug), [
      { plan: longPlan, compositionId: "LongVideo", outPath: inStory(story.slug, "renders/long.mp4") },
      { plan: shortPlan, compositionId: "ShortVideo", outPath: inStory(story.slug, "renders/short.mp4") },
    ], (fraction) => {
      // Persist only whole-percent changes, so the poll sees progress without a write per frame.
      const pct = Math.min(100, Math.floor(fraction * 100));
      if (pct === scratch.renderPercent) return;
      scratch.renderPercent = pct;
      updateJob(jobId, { scratch });
    });
    delete scratch.renderPercent;

    // 8. Finish: probe both films and check each against the output contract, and
    // only when BOTH pass register them. A broken file fails the job with nothing
    // registered; the renders stay on disk for diagnosis.
    step(jobId, "finishing", "Finishing", scratch);
    const finals = ([["long", longPlan], ["short", shortPlan]] as const).map(([kind, plan]) => {
      const rel = `renders/${kind}.mp4`;
      return { kind, plan, rel, p: probeVideo(inStory(story.slug, rel)) };
    });
    for (const f of finals) validateFinalVideo(f.plan, f.p);
    for (const { kind, rel, p } of finals) {
      const video: Video = {
        id: `${job.id}-${kind}`,
        storyId: story.id,
        jobId: job.id,
        kind,
        path: mediaRel(story.slug, rel),
        width: p.width,
        height: p.height,
        durationSec: p.durationSec,
        fps: p.fps,
        hasAudio: p.hasAudio,
        createdAt: now(),
      };
      addVideo(video);
    }

    updateJob(jobId, { state: "done", step: "finishing", message: "Finished", scratch });
  } catch (e: any) {
    updateJob(jobId, { state: "failed", error: e?.message || String(e), scratch });
    throw e;
  }
}

function films(s: Scratch): Array<["long" | "short", PlannedShot[]]> {
  return [
    ["long", s.longShots ?? []],
    ["short", s.shortShots ?? []],
  ];
}

// One film's retained pool as saved, or for an older job without one, seeded from
// its CURRENT shots only (anything dropped before this existed stays lost).
function retainedPool(s: Scratch, kind: "long" | "short"): RetainedPresentation[] {
  return s.retainedPresentations?.[kind] ?? retainPresentations(undefined, (kind === "long" ? s.longShots : s.shortShots) ?? []);
}

// Add what the film's saved edit shows now to its pool; nothing is ever removed.
function retain(s: Scratch, kind: "long" | "short", shots: PlannedShot[]): void {
  s.retainedPresentations = { ...s.retainedPresentations, [kind]: retainPresentations(retainedPool(s, kind), shots) };
}

// The retained presentations a revision may offer: only those whose existing still
// is still on disk. A missing one is simply unavailable; it is never regenerated.
function availablePool(story: Story, pool: RetainedPresentation[]): RetainedPresentation[] {
  return pool.filter((r) => existsSync(inStory(story.slug, r.path)));
}

export function newJobId(): string {
  return crypto.randomUUID();
}

// Real per-unit progress for the current step, derived from the work already in
// scratch. Returns null for steps without a meaningful count (research, finishing)
// so the UI keeps the plain spinner. The pipeline persists scratch after each unit,
// so the existing poll reflects this without any extra writes.
export function jobProgress(job: { step: JobStep; scratch: Record<string, any> }): { current: number; total: number; percent?: boolean } | null {
  const s = (job.scratch ?? {}) as Scratch;
  // Progress counts the assets being made: a reuse shares its owner's still.
  const shots = [...(s.longShots ?? []), ...(s.shortShots ?? [])].filter((sh) => sh.edit !== "reuse");
  switch (job.step) {
    case "scripts": {
      const p = s.scriptParts ?? {};
      return { current: (p.long !== undefined ? 1 : 0) + (p.short !== undefined ? 1 : 0), total: 2 };
    }
    case "narration": {
      const n = s.narration ?? {};
      return { current: (n.long ? 1 : 0) + (n.short ? 1 : 0), total: 2 };
    }
    case "archive": {
      const archive = shots.filter((sh) => sh.truth === "archive");
      return archive.length ? { current: archive.filter((sh) => sh.path).length, total: archive.length } : null;
    }
    case "stills": {
      return shots.length ? { current: shots.filter((sh) => sh.path).length, total: shots.length } : null;
    }
    case "rendering": {
      return typeof s.renderPercent === "number" ? { current: s.renderPercent, total: 100, percent: true } : null;
    }
    case "build": {
      const motion = shots.filter((sh) => sh.wantsMotion);
      return motion.length ? { current: motion.filter((sh) => sh.motionPath).length, total: motion.length } : null;
    }
    default:
      return null;
  }
}

// Raise the approved spending ceiling for an existing job and requeue the SAME
// job so runJob resumes from where the budget guard stopped it. The ceiling may
// only increase, and never past config.maxSpendUsd. Tracked spend and all the
// completed work in scratch are left untouched.
export function raiseApprovedMax(jobId: string, newApprovedMax: number): JobRecord {
  const job = getJob(jobId);
  if (!job) throw new Error("Job not found.");
  const next = round(newApprovedMax);
  if (next + 1e-9 < job.approvedMax) throw new Error(`New approved maximum $${next.toFixed(2)} is below the current $${job.approvedMax.toFixed(2)}.`);
  if (next > config.maxSpendUsd + 1e-9) throw new Error(`New approved maximum $${next.toFixed(2)} exceeds the ceiling $${config.maxSpendUsd.toFixed(2)}.`);
  updateJob(jobId, { approvedMax: next, state: "queued", step: "queued", message: "Queued", error: null });
  return getJob(jobId)!;
}

// Approve the story text of an awaiting_text job and requeue the SAME job so
// runJob resumes at narration (the first unfinished production work). Research,
// scripts and tracked spend in scratch are untouched, so no text provider call
// repeats and no media spend happened before this approval.
export function approveTextForJob(jobId: string): JobRecord {
  const job = getJob(jobId);
  if (!job) throw new Error("Job not found.");
  const scratch = { ...(job.scratch as Scratch), textApproved: true };
  updateJob(jobId, { scratch, state: "queued", step: "queued", message: "Queued", error: null });
  return getJob(jobId)!;
}

// Jobs with a Director revision in flight. The job stays awaiting_text while it
// runs, so approve-text must wait for it (see the routes).
const revising = new Set<string>();
export function isRevisingText(jobId: string): boolean {
  return revising.has(jobId);
}

// At the text gate, revise the CURRENT story draft from explicit Director
// feedback: one bounded revision call, then the same script fidelity audit the
// pipeline runs, both preflighted and charged like any script call. No research,
// no media, no approval. Nothing is written until both calls succeed, so a
// failure leaves the review exactly as it was (only a completed call's spend is
// recorded). On success the revised title/hook, spine, facts and scripts replace
// the draft in the same places Generate stored them, and the job stays
// awaiting_text for another review.
export async function reviseTextForJob(jobId: string, feedback: string): Promise<JobRecord> {
  const job = getJob(jobId);
  if (!job) throw new Error("Job not found.");
  if (job.state !== "awaiting_text") throw new Error("The story can only be revised at the story review.");
  const story = getStory(job.storyId);
  if (!story) throw new Error("Story not found.");
  const scratch: Scratch = { ...(job.scratch as Scratch) };
  const { research, scripts } = scratch;
  if (!research || !scripts) throw new Error("This job has no story draft to revise.");
  if (revising.has(jobId)) throw new Error("A revision is already running for this story.");

  revising.add(jobId);
  try {
    budget(job, PRICING.openai.script, scratch);
    const revised = await reviseStoryText(story, research, scripts, feedback);
    record(jobId, PRICING.openai.script, scratch);

    const nextStory = { ...story, title: revised.title, hook: revised.hook };
    const nextResearch: ResearchPackage = { ...research, moments: revised.moments, facts: revised.facts };
    const drafts = { long: revised.long, short: revised.short };
    const final = story.slug !== "paul-bunyan" && config.mode === "live" ? await runScriptAudit(job, nextStory, nextResearch, drafts, scratch) : drafts;

    scratch.research = nextResearch;
    scratch.scripts = { long: plainDashes(final.long), short: plainDashes(final.short) };
    upsertStory(nextStory);
    setScripts(story.id, scratch.scripts);
    updateJob(jobId, { scratch, spent: scratch.spent ?? 0, state: "awaiting_text", message: "Ready for story review", error: null });
    return getJob(jobId)!;
  } finally {
    revising.delete(jobId);
  }
}

// ---- Automatic Director Text QA (Autopilot v1: the text gate only) ----
// Server memory only, never persisted: a running phase (the job stays
// awaiting_text, so the routes refuse manual Approve / Revise until it ends),
// then either "passed" or the reason it stopped at the Story Review. A restart
// forgets it; the saved draft and job state stay authoritative.
const textQa = new Map<string, TextQaState>();
export function textQaState(jobId: string): TextQaState | undefined {
  return textQa.get(jobId);
}
export function isTextQaRunning(jobId: string): boolean {
  return textQa.get(jobId)?.status === "running";
}

// One Director call priced like any script call, preflighted against the
// approved maximum and charged once it returns (no charge without a provider call).
async function textQaCall<T>(jobId: string, call: (story: Story, research: ResearchPackage, scripts: Scripts) => Promise<T>): Promise<T> {
  const job = getJob(jobId);
  if (!job) throw new Error("Job not found.");
  if (job.state !== "awaiting_text") throw new Error("The job is no longer at the story review.");
  const story = getStory(job.storyId);
  const scratch: Scratch = { ...(job.scratch as Scratch) };
  if (!story || !scratch.research || !scratch.scripts) throw new Error("This job has no story draft to review.");
  const paid = textQaCallsProvider(story);
  if (paid) budget(job, PRICING.openai.script, scratch);
  const out = await call(story, scratch.research, scratch.scripts);
  if (paid) record(jobId, PRICING.openai.script, scratch);
  return out;
}

// After a NEW draft reaches the text gate: one Director review of the saved
// Story Review; on REPAIR, the existing reviseTextForJob (with its audit) once,
// then one read-only verification of the NEW saved draft. PASS approves through
// approveTextForJob and `advance` requeues the job, exactly as Approve & continue
// does. Anything else stops at the Story Review with the reason, the draft kept.
// No retries. Never throws.
export async function autoTextQaForJob(jobId: string, advance: (jobId: string) => void): Promise<TextQaState | undefined> {
  const job = getJob(jobId);
  if (!job || job.state !== "awaiting_text" || (job.scratch as Scratch).textApproved || isTextQaRunning(jobId) || isRevisingText(jobId)) return undefined;
  const phase = (p: TextQaPhase) => textQa.set(jobId, { status: "running", phase: p });
  const end = (s: TextQaState) => (textQa.set(jobId, s), s);
  const failed = (stage: TextQaStage, e: unknown) => {
    const error = (e as Error)?.message || String(e);
    // One trail per failed step: never scripts, feedback, sources or payloads.
    console.error(`Text QA failed job=${jobId} stage=${stage} error=${error}`);
    return error;
  };
  const pass = (stage: TextQaStage) => {
    try {
      if (getJob(jobId)?.state !== "awaiting_text") throw new Error("The job is no longer at the story review.");
      approveTextForJob(jobId);
      const s = end({ status: "passed" });
      advance(jobId);
      return s;
    } catch (e) {
      return end({ status: "stopped", stage, message: "Text QA could not complete. Review the current draft manually.", summary: "", issues: [], error: failed(stage, e) });
    }
  };

  phase("review");
  let review: TextQaReview;
  try {
    review = await textQaCall(jobId, reviewStoryDraft);
  } catch (e) {
    return end({ status: "stopped", stage: "director_review", message: "Text QA could not complete. Review the current draft manually.", summary: "", issues: [], error: failed("director_review", e) });
  }
  if (review.decision === "PASS") return pass("director_review");
  if (review.decision === "HUMAN_REVIEW") return end({ status: "stopped", stage: "director_review", message: "The Director needs a human decision on this draft.", summary: review.summary, issues: review.humanReview });

  const feedback = review.repairFeedback!;
  phase("repair");
  try {
    await reviseTextForJob(jobId, feedback);
  } catch (e) {
    return end({ status: "stopped", stage: "revision", message: "The automatic text repair could not complete. The current draft was not changed.", summary: review.summary, issues: [], feedback, error: failed("revision", e) });
  }

  phase("verify");
  let verify: TextQaVerify;
  try {
    verify = await textQaCall(jobId, (story, research, scripts) => verifyStoryDraft(story, research, scripts, feedback));
  } catch (e) {
    return end({ status: "stopped", stage: "final_verify", message: "Text repair completed, but final verification failed. Review the current draft manually.", summary: review.summary, issues: [], feedback, error: failed("final_verify", e) });
  }
  if (verify.decision === "PASS") return pass("final_verify");
  return end({ status: "stopped", stage: "final_verify", message: "Text repair completed, but the final verification still needs you.", summary: verify.summary, issues: verify.humanReview, feedback });
}

// Jobs with a Director sequence revision or Director QA in flight. The job stays
// awaiting_preview while it runs, so Continue / Rebuild / Regenerate must wait
// (see the routes).
const revisingSequence = new Set<string>();
export function isRevisingSequence(jobId: string): boolean {
  return revisingSequence.has(jobId);
}

// One film's stored edit at the visual preview gate, with its fixed slots rebuilt
// exactly as planning built them. Refuses a job that is not at the preview, has
// no edit, or whose stored edit no longer matches its slot grid.
function storedFilm(jobId: string, kind: "long" | "short") {
  const job = getJob(jobId);
  if (!job) throw new Error("Job not found.");
  if (job.state !== "awaiting_preview") throw new Error("The sequence can only be revised at the visual preview.");
  const story = getStory(job.storyId);
  if (!story) throw new Error("Story not found.");
  const scratch: Scratch = { ...(job.scratch as Scratch) };
  const shots = kind === "long" ? scratch.longShots : scratch.shortShots;
  const narration = scratch.narration?.[kind];
  if (!shots?.length || !scratch.scripts || !narration) throw new Error(`This job has no ${kind} edit to revise.`);
  assertFilmGrammarPlan(kind, shots);
  const slots = planSlots(kind, scratch.scripts[kind], narration);
  if (slots.length !== shots.length || slots.some((s, i) => shots[i].index !== s.id || Math.abs(shots[i].startSec - s.startSec) > 1e-6 || Math.abs(shots[i].endSec - s.endSec) > 1e-6)) {
    throw new Error(`The stored ${kind} edit no longer matches its fixed slots. Rebuild the visuals instead.`);
  }
  // The film's menu: what it shows now plus its retained presentations on disk.
  const pool = availablePool(story, retainedPool(scratch, kind));
  return { job, story, scratch, shots, slots, pool, presentations: storedPresentations(shots, pool) };
}

const MOTION_LOCK = "a motion slot keeps its visual; changing it needs a visual rebuild";

// The bounded revision itself: one Editor repair call over the stored film. With
// `targets`, every other slot is locked, so only those slots can change (Director
// QA); without, the Director's explicit KEEP lines are locked. Motion slots are
// always locked. Only individually legal presentations are offered; the answer
// goes through the same validateEdit and Film Grammar checks as planning, and
// nothing is saved unless all pass. With targets and no legal choice anywhere,
// every target comes back unresolved without a call.
async function reviseStoredSequence(
  film: ReturnType<typeof storedFilm>,
  kind: "long" | "short",
  feedback: string,
  reviser: SequenceReviser,
  targets?: number[],
  coordinated?: SequenceRevisionInput["coordinated"],
  ctx: QaRunContext = {},
): Promise<{ job: JobRecord; changed: number[]; unresolved: SequenceUnresolved[]; choices: Map<number, string[]> }> {
  const { job, story, scratch, shots, slots, pool, presentations } = film;
  const locked = new Map<number, string>();
  if (targets) for (const s of slots) if (!targets.includes(s.id)) locked.set(s.id, coordinated ? "outside the coordinated window" : "not a Director QA repair target");
  if (!targets) for (const id of keptSlots(feedback, slots.length)) locked.set(id, "the Director asked to keep this slot");
  for (const s of shots) if (s.wantsMotion) locked.set(s.index, MOTION_LOCK);
  if (locked.size >= slots.length) throw new Error("Every slot is locked, so nothing can change.");
  // Normally only presentations the existing checks accept as a one-slot change
  // are offered. In coordinated mode the window's slots move together, so each
  // may take any presentation of the current film; the final checks decide.
  const choices = coordinated
    ? new Map(slots.filter((s) => !locked.has(s.id)).map((s) => [s.id, presentations.map((p) => p.id)] as [number, string[]]))
    : sequenceSlotChoices(kind, slots, shots, presentations, locked, story, pool);
  if (![...choices.values()].some((ids) => ids.length)) {
    if (targets) return { job, changed: [], unresolved: targets.map((slotId) => ({ slotId, reason: NO_LEGAL_ALTERNATIVE })), choices };
    throw new Error("No unlocked slot has a legal alternative existing presentation, so the sequence cannot change.");
  }
  if (config.mode === "live") budget(job, PRICING.openai.visualPlan, scratch);
  const answer = await reviser({ story, kind, slots, shots, presentations, locked, choices, feedback, coordinated });
  record(job.id, PRICING.openai.visualPlan, scratch); // paid even if the answer then fails validation, as in planning
  const current = storedEdit(shots);
  const revised = applySequenceRevision(kind, current, presentations, locked, choices, answer);
  const edit = validateEdit(kind, slots, revised.edit, presentations);
  const next = reassembleStoredEdit(shots, edit, pool);
  assertFilmGrammarPlan(kind, next);
  resolveReuse(story, kind, next);
  retain(scratch, kind, shots); // an older job's pool is seeded from the edit before this revision
  retain(scratch, kind, next);
  if (kind === "long") scratch.longShots = next;
  else scratch.shortShots = next;
  // The film's Director QA result described the edit before this change.
  if (!ctx.qaRun && scratch.directorQa?.[kind]) {
    const { [kind]: _stale, ...other } = scratch.directorQa;
    scratch.directorQa = other;
  }
  const preview = buildPreview(story, scratch.longShots!, scratch.shortShots!);
  updateJob(job.id, { scratch, spent: scratch.spent ?? 0, preview, state: "awaiting_preview", previewApproved: false, error: null });
  return { job: getJob(job.id)!, changed: revised.changed, unresolved: revised.unresolved, choices };
}

const defaultReviser = (): SequenceReviser => (config.mode === "live" ? openAiSequenceRevision : fallbackSequenceRevision);

// At the visual preview gate, revise ONE film's edit from Director feedback: one
// bounded Editor repair call that may only move presentations the film already
// shows, charged like a visual planning call. No Coverage, acquisition, image,
// motion or render work; the other film is never touched. The job stays
// awaiting_preview and unapproved.
export async function reviseSequenceForJob(
  jobId: string,
  kind: "long" | "short",
  feedback: string,
  reviser: SequenceReviser = defaultReviser(),
): Promise<{ job: JobRecord; changed: number[]; unresolved: SequenceUnresolved[] }> {
  const film = storedFilm(jobId, kind);
  if (revisingSequence.has(jobId)) throw new Error("A sequence revision is already running for this job.");
  revisingSequence.add(jobId);
  try {
    const { job, changed, unresolved } = await reviseStoredSequence(film, kind, feedback, reviser);
    return { job, changed, unresolved };
  } finally {
    revisingSequence.delete(jobId);
  }
}

// Director QA, step 1: ONE editorial review of one film's stored edit (narration,
// captions, what each presentation shows, owner/reuse, usage, motion and the
// board's attention flags), charged like a visual planning call. It changes no
// edit. A malformed answer throws after the charge, as in planning.
export async function directorReviewForJob(
  jobId: string,
  kind: "long" | "short",
  reviewer: DirectorQaReviewer = config.mode === "live" ? openAiDirectorQa : fallbackDirectorQa,
): Promise<{ job: JobRecord; qa: DirectorQaReport }> {
  const film = storedFilm(jobId, kind);
  const { job, scratch, shots } = film;
  if (revisingSequence.has(jobId)) throw new Error("A sequence revision is already running for this job.");
  revisingSequence.add(jobId);
  try {
    if (config.mode === "live") budget(job, PRICING.openai.visualPlan, scratch);
    const raw = await reviewer(qaInput(film, kind));
    record(jobId, PRICING.openai.visualPlan, scratch);
    return { job: getJob(jobId)!, qa: readDirectorQa(kind, shots, raw) };
  } finally {
    revisingSequence.delete(jobId);
  }
}

// The Director's view of one stored film: every slot with the SAME preview the
// Director board and Copy Director Board are built from, and the same
// deterministic attention flags. Built fresh from the saved job on every call.
function qaInput(film: ReturnType<typeof storedFilm>, kind: "long" | "short"): DirectorQaInput {
  const { story, scratch, shots, slots, presentations } = film;
  const fr = buildFilm(buildPreview(story, scratch.longShots!, scratch.shortShots!), kind);
  const byFrame = sequenceAttentionFlags(fr);
  const flags = shots.map((s) => byFrame[fr.frames.findIndex((f) => f.slot === s.index)] ?? []);
  return { story, kind, slots, shots, presentations, flags, openingSec: OPENING_SEC, endingSec: ENDING_SEC };
}

// Director QA, the FINAL and terminal step: ONE read-only Director verification
// of the film as it is saved now, after every automatic repair. It changes no
// edit and triggers nothing. It returns the verifier's current findings and the
// deterministic patterns recomputed on the same saved film. A failed call
// (provider, cap or malformed answer) is reported inside the result; the
// repaired edit is untouched. Never retried.
export async function directorVerifyForJob(
  jobId: string,
  kind: "long" | "short",
  verifier: DirectorQaReviewer = config.mode === "live" ? openAiDirectorVerify : fallbackDirectorVerify,
): Promise<{ job: JobRecord; verify: DirectorVerifyReport }> {
  const film = storedFilm(jobId, kind);
  if (revisingSequence.has(jobId)) throw new Error("A sequence revision is already running for this job.");
  revisingSequence.add(jobId);
  try {
    const patterns = cleanupExceptions(cleanupIssues(film, kind));
    try {
      if (config.mode === "live") budget(film.job, PRICING.openai.visualPlan, film.scratch);
      const raw = await verifier(qaInput(film, kind));
      record(jobId, PRICING.openai.visualPlan, film.scratch);
      return { job: getJob(jobId)!, verify: { ...readDirectorVerify(kind, film.shots, raw), patterns } };
    } catch (e: any) {
      return { job: getJob(jobId)!, verify: { summary: "", humanReview: [], patterns, error: e?.message || "The final Director verification failed." } };
    }
  } finally {
    revisingSequence.delete(jobId);
  }
}

// Director QA, step 2 (only when step 1 asked for repairs): the existing bounded
// sequence revision, run ONCE with exactly the repair slots as targets and every
// other slot locked. Each target that did not change is reported unresolved.
export async function directorRepairForJob(
  jobId: string,
  kind: "long" | "short",
  repairs: DirectorQaFinding[],
  reviser: SequenceReviser = defaultReviser(),
  ctx: QaRunContext = {},
): Promise<{ job: JobRecord; changed: number[]; unresolved: SequenceUnresolved[] }> {
  const film = storedFilm(jobId, kind);
  const targets = repairs.map((r) => r.slotId);
  if (!targets.length) throw new Error("There are no Director QA repairs to apply.");
  if (new Set(targets).size !== targets.length) throw new Error("A Director QA repair names the same slot twice.");
  for (const t of targets) {
    const shot = film.shots[t];
    if (!Number.isInteger(t) || !shot) throw new Error(`Director QA repair slot ${t} is not a ${kind} slot.`);
    if (shot.wantsMotion) throw new Error(`Director QA repair slot ${t} is a motion slot and cannot be repaired automatically.`);
  }
  if (revisingSequence.has(jobId)) throw new Error("A sequence revision is already running for this job.");
  revisingSequence.add(jobId);
  try {
    const r = await reviseStoredSequence(film, kind, directorRepairFeedback(repairs, film.slots.length), reviser, targets, undefined, ctx);
    // Only the targets are reported: a locked slot the reviser touched was simply not changed.
    const unresolved = r.unresolved.filter((u) => targets.includes(u.slotId));
    for (const t of targets) {
      if (r.changed.includes(t) || unresolved.some((u) => u.slotId === t)) continue;
      unresolved.push({ slotId: t, reason: (r.choices.get(t) ?? []).length ? "The repair kept the current presentation." : NO_LEGAL_ALTERNATIVE });
    }
    unresolved.sort((a, b) => a.slotId - b.slotId);
    return { job: r.job, changed: r.changed, unresolved };
  } finally {
    revisingSequence.delete(jobId);
  }
}

const CLEANUP_REMAINS: Record<CleanupPattern, string> = {
  "ADJACENT REUSE": "ADJACENT REUSE remains. No legal existing alternative resolved this sequence issue.",
  "CONSECUTIVE REUSE": "CONSECUTIVE REUSE remains. Existing media could not break this run.",
  "ALTERNATING REUSE": "ALTERNATING REUSE remains. Existing media could not safely diversify this section.",
  "OPENING REPEAT": "OPENING REPEAT remains. The same asset still repeats inside the opening.",
};

// The mandatory repetition patterns in the film as it is saved now. A slot is
// editable only if it is not a motion slot and has at least one legal change.
function cleanupIssues(film: ReturnType<typeof storedFilm>, kind: "long" | "short") {
  const { story, scratch, shots, slots, pool, presentations } = film;
  const fr = buildFilm(buildPreview(story, scratch.longShots!, scratch.shortShots!), kind);
  const locked = new Map(shots.filter((s) => s.wantsMotion).map((s) => [s.index, MOTION_LOCK] as [number, string]));
  const choices = sequenceSlotChoices(kind, slots, shots, presentations, locked, story, pool);
  const slotOf = (frame: number) => fr.frames[frame].slot ?? frame;
  const issues = sequenceCleanup(fr, (frame) => (choices.get(slotOf(frame)) ?? []).length > 0);
  return { issues, slotOf };
}

// Every pattern still present, one exception per slot: the slot it was aimed at,
// or the pattern's last slot when no member could change.
function cleanupExceptions(found: ReturnType<typeof cleanupIssues>, suffix = ""): { slotId: number; reason: string }[] {
  const out = new Map<number, string>();
  for (const issue of found.issues) {
    const frames = issue.targets.length ? issue.targets : [issue.frames[issue.frames.length - 1]];
    for (const f of frames) {
      const slotId = found.slotOf(f);
      const reason = CLEANUP_REMAINS[issue.pattern] + suffix;
      out.set(slotId, out.has(slotId) ? `${out.get(slotId)} ${reason}` : reason);
    }
  }
  return [...out].sort((a, b) => a[0] - b[0]).map(([slotId, reason]) => ({ slotId, reason }));
}

// The cleanup feedback handed to the existing sequence revision.
function cleanupFeedback(found: ReturnType<typeof cleanupIssues>, targets: number[]): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  const lines = found.issues
    .filter((i) => i.targets.length)
    .map((i) => `- ${i.pattern} across slots ${i.frames.map((f) => pad(found.slotOf(f))).join(", ")}: change slot${i.targets.length === 1 ? "" : "s"} ${i.targets.map((f) => pad(found.slotOf(f))).join(", ")}`);
  return [
    "AUTOMATIC SEQUENCE CLEANUP",
    "",
    "The current film still contains deterministic repetition patterns after Director QA.",
    `Target only these slots: ${targets.map(pad).join(", ")}.`,
    "",
    ...lines,
    "",
    "For each target:",
    "- choose an existing legal presentation that matches its narration",
    "- break the listed repetition pattern",
    "- avoid creating another adjacent or alternating repetition",
    "- prefer a less-used relevant visual",
    "",
    "KEEP ALL OTHER SLOTS.",
  ].join("\n");
}

// Director QA, step 3: after the review and its optional repair, find the
// mandatory repetition patterns in the saved film and run the existing bounded
// sequence revision AT MOST ONCE on the chosen targets (every other slot locked).
// Then look once more, and return whatever remains as human exceptions. Never
// loops. A failed cleanup changes nothing and leaves the earlier edit saved.
export async function directorCleanupForJob(
  jobId: string,
  kind: "long" | "short",
  reviser: SequenceReviser = defaultReviser(),
  ctx: QaRunContext = {},
): Promise<{ job: JobRecord; cleanup: SequenceCleanupReport }> {
  const film = storedFilm(jobId, kind);
  if (revisingSequence.has(jobId)) throw new Error("A sequence revision is already running for this job.");
  revisingSequence.add(jobId);
  try {
    const before = cleanupIssues(film, kind);
    const targets = [...new Set(before.issues.flatMap((i) => i.targets.map(before.slotOf)))].sort((x, y) => x - y);
    if (!targets.length) return { job: film.job, cleanup: { ran: false, changed: [], unresolved: [], remaining: cleanupExceptions(before) } };
    try {
      const r = await reviseStoredSequence(film, kind, cleanupFeedback(before, targets), reviser, targets, undefined, ctx);
      const after = cleanupIssues(storedFilm(jobId, kind), kind);
      const unresolved = r.unresolved.filter((u) => targets.includes(u.slotId));
      return { job: r.job, cleanup: { ran: true, changed: r.changed, unresolved, remaining: cleanupExceptions(after) } };
    } catch (e: any) {
      const error = e?.message || "The automatic cleanup failed.";
      return { job: getJob(jobId)!, cleanup: { ran: true, changed: [], unresolved: [], remaining: cleanupExceptions(before, " Automatic cleanup failed."), error } };
    }
  } finally {
    revisingSequence.delete(jobId);
  }
}

export const COORDINATED_WINDOW = 2; // slots on each side of the target

// Director QA, step 4 (the last): ONE coordinated repair of the small window
// around one unresolved non-motion slot: up to two slots either side, clamped at
// the film's ends. Every unlocked window slot may take any presentation already
// in the film; everything outside the window and every motion slot is locked.
// The whole proposal is applied atomically and checked by the same validateEdit,
// Film Grammar and resolveReuse as any revision. Then only the deterministic
// pattern check runs again. A failure saves nothing, keeps the edit before it
// and reports the target for human review. Never retried. `intent` is the
// original Director finding when the target was a Director QA repair.
export async function directorCoordinateForJob(
  jobId: string,
  kind: "long" | "short",
  target: number,
  reason: string,
  reviser: SequenceReviser = config.mode === "live" ? openAiCoordinatedRevision : fallbackSequenceRevision,
  intent?: DirectorRepairIntent,
  ctx: QaRunContext = {},
): Promise<{ job: JobRecord; report: CoordinatedRepairReport }> {
  const film = storedFilm(jobId, kind);
  const shot = film.shots[target];
  if (!Number.isInteger(target) || !shot) throw new Error(`Slot ${target} is not a ${kind} slot.`);
  if (shot.wantsMotion) throw new Error(`Slot ${target} is a motion slot and is never repaired automatically.`);
  if (revisingSequence.has(jobId)) throw new Error("A sequence revision is already running for this job.");
  const pad = String(target).padStart(2, "0");
  const first = Math.max(0, target - COORDINATED_WINDOW);
  const last = Math.min(film.slots.length - 1, target + COORDINATED_WINDOW);
  const window = Array.from({ length: last - first + 1 }, (_, k) => first + k);
  const editable = window.filter((i) => !film.shots[i].wantsMotion);
  revisingSequence.add(jobId);
  try {
    const feedback = `COORDINATED LOCAL SEQUENCE REPAIR for slots ${window.join(", ")}. Unresolved target slot ${target}: ${reason}`;
    const r = await reviseStoredSequence(film, kind, feedback, reviser, editable, { target, reason, window, ...(intent ? { intent } : {}) }, ctx);
    const after = cleanupIssues(storedFilm(jobId, kind), kind);
    const humanReview = r.changed.includes(target) ? [] : [{ slotId: target, reason: `Coordinated repair left Slot ${pad} unchanged. ${reason}` }];
    return { job: r.job, report: { target, changed: r.changed, humanReview, remaining: cleanupExceptions(after) } };
  } catch (e: any) {
    const error = e?.message || "The coordinated repair failed.";
    const now = cleanupIssues(storedFilm(jobId, kind), kind);
    return {
      job: getJob(jobId)!,
      report: { target, changed: [], humanReview: [{ slotId: target, reason: `Coordinated repair could not resolve Slot ${pad}. The previous valid edit is kept. ${error}` }], remaining: cleanupExceptions(now), error },
    };
  } finally {
    revisingSequence.delete(jobId);
  }
}

// Jobs with a still regeneration in flight. The job stays awaiting_preview while
// it runs, so Continue / Rebuild visuals must wait for it (see the routes).
const regenerating = new Set<string>();
export function isRegeneratingStill(jobId: string): boolean {
  return regenerating.has(jobId);
}

// At the visual preview gate, regenerate ONE generated owner still from its exact
// stored PlannedShot (prompt, purpose, framing, master rule unchanged): no
// re-planning, no motion, no render, no new job. Only an owning ("new") slot of a
// reconstruction or graphic qualifies - never a reuse slot or a genuine archive
// still. The old still is set aside and restored if generation fails, so a failure
// leaves the preview exactly as it was and charges nothing. On success the one
// image is charged, every reuse of the asset points at the new still, and the
// preview is rebuilt; the job stays awaiting_preview and unapproved.
// Optional Director feedback is a one-off repair note for this image call only:
// same prompt, references, slot and charge, and nothing about it is stored.
export async function regenerateStill(jobId: string, kind: "long" | "short", index: number, directorFeedback?: string): Promise<JobRecord> {
  const job = getJob(jobId);
  if (!job) throw new Error("Job not found.");
  if (job.state !== "awaiting_preview") throw new Error("A still can only be regenerated at the visual preview.");
  const story = getStory(job.storyId);
  if (!story) throw new Error("Story not found.");
  const scratch: Scratch = { ...(job.scratch as Scratch) };
  const shots = kind === "long" ? scratch.longShots : scratch.shortShots;
  const shot = shots?.find((s) => s.index === index);
  if (!shots || !shot) throw new Error(`No ${kind} slot ${index}.`);
  if (shot.edit !== "new") throw new Error(`${kind} slot ${index} reuses asset ${shot.assetId}; regenerate its owner slot ${shot.assetShot} instead.`);
  if (shot.truth !== "reconstruction" && shot.truth !== "graphic") throw new Error(`${kind} slot ${index} is an archive still and is never regenerated.`);
  if (!shot.path || !shot.path.startsWith("images/")) throw new Error(`${kind} slot ${index} has no generated still.`);
  if (regenerating.has(jobId)) throw new Error("A still is already being regenerated for this job.");

  regenerating.add(jobId);
  const oldRel = shot.path;
  const abs = inStory(story.slug, oldRel);
  const backup = `${abs}.prev`;
  try {
    budget(job, PRICING.openai.image, scratch);
    renameSync(abs, backup);
    delete shot.path;
    let result: Awaited<ReturnType<typeof acquireStill>>;
    try {
      // Replace the asset's own stored still, never a path derived from the
      // (possibly moved) owner slot, which could name another asset's file.
      result = await acquireStill(story, kind, shot, scratch.masterRef ?? null, undefined, directorFeedback?.trim() || undefined, oldRel);
    } catch (e) {
      rmSync(abs, { force: true });
      renameSync(backup, abs); // restore; the stored scratch was never changed
      throw e;
    }
    rmSync(backup, { force: true });
    resolveReuse(story, kind, shots);
    retain(scratch, kind, shots); // the asset's retained entries follow its (possibly moved) still
    if (result === "generated") record(jobId, PRICING.openai.image, scratch);
    const preview = buildPreview(story, scratch.longShots!, scratch.shortShots!);
    updateJob(jobId, { scratch, spent: scratch.spent ?? 0, preview, state: "awaiting_preview", previewApproved: false, error: null });
    return getJob(jobId)!;
  } finally {
    regenerating.delete(jobId);
  }
}

// Reject only the visual work of an awaiting_preview job and rebuild it under the
// SAME job. Research, scripts, narration, the master reference and tracked spend
// stay in scratch, so runJob skips them and only replans/reacquires visuals. The
// budget guard still enforces approvedMax against the existing spend.
export function clearVisualsForRebuild(jobId: string): void {
  const job = getJob(jobId);
  if (!job) return;
  const story = getStory(job.storyId);
  const scratch = { ...(job.scratch as Scratch) };

  // Delete only the files these shots and the retained pools reference - never the
  // master/reference image. A new plan reuses asset ids and still paths, so the
  // old pools go too.
  const shots = [...(scratch.longShots ?? []), ...(scratch.shortShots ?? [])];
  const kept = [...(scratch.retainedPresentations?.long ?? []), ...(scratch.retainedPresentations?.short ?? [])];
  if (story) {
    for (const rel of [...shots.flatMap((s) => [s.path, s.motionPath]), ...kept.map((r) => r.path)]) {
      if (rel) rmSync(inStory(story.slug, rel), { force: true });
    }
  }

  delete scratch.longShots;
  delete scratch.shortShots;
  delete scratch.retainedPresentations;
  delete scratch.assetQa; // the rebuilt visuals get their own Asset QA
  delete scratch.directorQa; // and their own Director QA, both films

  updateJob(jobId, {
    scratch,
    spent: scratch.spent ?? 0,
    state: "queued",
    step: "queued",
    message: "Rebuilding visuals",
    error: null,
    preview: null,
    previewApproved: false,
  });
}

// ---- Pixel-aware Asset QA (v1: the visual preview, current owner stills only) ----
// The running phase lives in server memory (the job stays awaiting_preview, so
// the routes refuse every preview action until it ends); the latest result is
// persisted in scratch.assetQa, written as "started" before any call so a
// restart never repeats the run or its regenerations.
const assetQaRunning = new Map<string, Extract<AssetQaState, { status: "running" }>>();
export function isAssetQaRunning(jobId: string): boolean {
  return assetQaRunning.has(jobId);
}

// The Asset QA state the page sees: the running phase, else the latest result,
// with only the exceptions for assets the saved film still shows. A run a restart
// interrupted is reported as incomplete, never as passed.
export function assetQaState(jobId: string, raw: Record<string, unknown>): AssetQaState | undefined {
  const running = assetQaRunning.get(jobId);
  if (running) return running;
  const scratch = raw as Scratch;
  const saved = scratch.assetQa;
  if (!saved) return undefined;
  if (saved.status === "started") return { status: "done", reviewed: 0, regenerated: 0, incomplete: 0, message: "Asset QA was interrupted before it finished. Review the visuals manually.", issues: [], clean: false };
  const shown = (i: AssetQaIssue) => ((i.kind === "long" ? scratch.longShots : scratch.shortShots) ?? []).some((s) => s.assetId === i.assetId);
  return { ...saved, issues: saved.issues.filter(shown) };
}

function saveAssetQa(jobId: string, assetQa: Scratch["assetQa"]): void {
  const job = getJob(jobId);
  if (job) updateJob(jobId, { scratch: { ...(job.scratch as Scratch), assetQa } });
}

// A person regenerated this still by hand: its Asset QA exception no longer
// describes the current bytes, so it is dropped. Nothing else changes.
export function clearAssetQaIssue(jobId: string, kind: "long" | "short", assetId: string): void {
  const saved = (getJob(jobId)?.scratch as Scratch | undefined)?.assetQa;
  if (saved?.status !== "done") return;
  saveAssetQa(jobId, { ...saved, issues: saved.issues.filter((i) => !(i.kind === kind && i.assetId === assetId)) });
}

// One vision call over one batch of ONE film's owner stills: the saved bytes are
// read at call time, the call is preflighted against the approved maximum and
// charged once it returns (even if its answer is then rejected, as in planning).
async function assetQaCall(jobId: string, kind: "long" | "short", targets: AssetQaTarget[], reviewer: AssetReviewer, repairs?: Map<string, AppliedRepair>) {
  const job = getJob(jobId);
  if (!job || job.state !== "awaiting_preview") throw new Error("The job is no longer at the visual preview.");
  const story = getStory(job.storyId);
  if (!story) throw new Error("Story not found.");
  const scratch: Scratch = { ...(job.scratch as Scratch) };
  const usd = assetReviewUsd(targets.length);
  const paid = config.mode === "live";
  if (paid) budget(job, usd, scratch);
  const images = targets.map((t) => ({ label: assetImageLabel(t), data: readFileSync(inStory(story.slug, t.path)), mimeType: imageMimeType(t.path) }));
  const raw = await reviewer({ story, kind, targets, images, ...(repairs ? { repairs } : {}) });
  if (paid) record(jobId, usd, scratch);
  return readAssetQa(targets, raw, !!repairs);
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

// After production has just acquired the stills and stopped at the visual
// preview: ONE pixel review of every unique current owner still (per film, in
// fixed batches), at most ONE regeneration of each clearly repairable generated
// still through the existing regenerateStill (its repair feedback as the Director
// note), then ONE read-only verification of the regenerated stills' new bytes.
// Archive stills are never regenerated. Everything else is a human exception.
// The job stays at the visual preview either way: nothing is approved. No retries,
// no loop. Never throws.
export async function autoAssetQaForJob(
  jobId: string,
  reviewer: AssetReviewer = config.mode === "live" ? openAiAssetReview : fallbackAssetReview,
  verifier: AssetReviewer = config.mode === "live" ? openAiAssetVerify : fallbackAssetVerify,
): Promise<AssetQaResult | undefined> {
  const job = getJob(jobId);
  if (!job || job.state !== "awaiting_preview" || job.previewApproved || (job.scratch as Scratch).assetQa) return undefined;
  if (isAssetQaRunning(jobId) || isRegeneratingStill(jobId) || isRevisingSequence(jobId) || isDirectorQaRunning(jobId)) return undefined;
  const phase = (p: AssetQaPhase, current?: number, total?: number) =>
    assetQaRunning.set(jobId, { status: "running", phase: p, ...(current ? { current, total } : {}) });
  const failed = (stage: AssetQaStage, asset: string, e: unknown) => {
    const error = (e as Error)?.message || String(e);
    // One trail per failed step: never image bytes, payloads, prompts or feedback.
    console.error(`Asset QA failed job=${jobId} stage=${stage} asset=${asset} error=${error}`);
    return error;
  };
  const batchName = (kind: string, batch: AssetQaTarget[]) => `${kind}:${batch.map((t) => t.assetId).join(",")}`;
  const issues: AssetQaIssue[] = [];
  const issue = (t: AssetQaTarget, stage: AssetQaStage, reason: string, incomplete = false) =>
    issues.push({ kind: t.kind, assetId: t.assetId, truth: t.truth, stage, reason, ...(incomplete ? { incomplete: true } : {}) });

  phase("review");
  try {
    saveAssetQa(jobId, { status: "started" });
    const scratch = job.scratch as Scratch;
    const films = (["long", "short"] as const).map((kind) => [kind, assetQaTargets(kind, (kind === "long" ? scratch.longShots : scratch.shortShots) ?? [])] as const);

    // 1. Review every current owner still once.
    let reviewed = 0;
    let unreviewed = 0;
    const repairs: (AppliedRepair & { target: AssetQaTarget })[] = [];
    for (const [kind, targets] of films) {
      for (const batch of chunk(targets)) {
        try {
          const { verdicts } = await assetQaCall(jobId, kind, batch, reviewer);
          reviewed += batch.length;
          for (const t of batch) {
            const v = verdicts.get(t.assetId)!;
            if (v.decision === "HUMAN_REVIEW") issue(t, "review", v.reason);
            if (v.decision === "REGENERATE") repairs.push({ target: t, reason: v.reason, feedback: v.repairFeedback! });
          }
        } catch (e) {
          failed("review", batchName(kind, batch), e);
          unreviewed += batch.length;
          for (const t of batch) issue(t, "review", "Asset QA could not review this still. The current still is unchanged.", true);
        }
      }
    }

    // 2. At most one regeneration per repairable asset, through the existing path.
    const regenerated: typeof repairs = [];
    for (const [n, r] of repairs.entries()) {
      phase("repair", n + 1, repairs.length);
      try {
        await regenerateStill(jobId, r.target.kind, r.target.owner, r.feedback);
        regenerated.push(r);
      } catch (e) {
        const error = failed("regenerate", r.target.assetId, e);
        issue(r.target, "regenerate", `${r.reason} The automatic regeneration failed, so the previous still is kept: ${error}`);
      }
    }

    // 3. One read-only verification of the regenerated stills' NEW saved bytes.
    let unverified = 0;
    if (regenerated.length) {
      phase("verify");
      const now = getJob(jobId)!.scratch as Scratch;
      for (const kind of ["long", "short"] as const) {
        const done = new Map(regenerated.filter((r) => r.target.kind === kind).map((r) => [r.target.assetId, { reason: r.reason, feedback: r.feedback }]));
        const targets = assetQaTargets(kind, (kind === "long" ? now.longShots : now.shortShots) ?? []).filter((t) => done.has(t.assetId));
        for (const batch of chunk(targets)) {
          try {
            const { verdicts } = await assetQaCall(jobId, kind, batch, verifier, new Map(batch.map((t) => [t.assetId, done.get(t.assetId)!])));
            for (const t of batch) {
              const v = verdicts.get(t.assetId)!;
              if (v.decision === "HUMAN_REVIEW") issue(t, "verify", v.reason);
            }
          } catch (e) {
            failed("verify", batchName(kind, batch), e);
            unverified += batch.length;
            for (const t of batch) issue(t, "verify", "The still was regenerated, but its final pixel verification could not complete. Review it manually.", true);
          }
        }
      }
    }

    const message = [
      unreviewed ? `Asset QA could not complete for ${plural(unreviewed, "asset")}. The current visuals are unchanged.` : "",
      unverified ? `The final verification could not complete for ${plural(unverified, "regenerated asset")}.` : "",
      !unreviewed && !unverified ? (issues.length ? `Asset QA needs you for ${plural(issues.length, "asset")}.` : "Asset QA passed.") : "",
    ]
      .filter(Boolean)
      .join(" ");
    const result: AssetQaResult = { status: "done", reviewed, regenerated: regenerated.length, incomplete: unreviewed + unverified, message, issues, clean: !issues.length && !unreviewed && !unverified };
    saveAssetQa(jobId, result);
    return result;
  } catch (e) {
    const error = failed("review", "all", e);
    const result: AssetQaResult = { status: "done", reviewed: 0, regenerated: 0, incomplete: 0, message: `Asset QA could not complete. Review the visuals manually. ${error}`, issues, clean: false };
    saveAssetQa(jobId, result);
    return result;
  } finally {
    assetQaRunning.delete(jobId);
  }
}

// ---- Run Director QA (server-side orchestration of the existing steps) ----
// One run per job at a time (it holds the visual gate like any sequence
// operation), for one film. The film's phase and result are persisted in
// scratch.directorQa; which run is live is server memory only, so after a
// restart a stored "running" is reported as interrupted and never resumed.
const directorQaRunning = new Map<string, "long" | "short">();
export function isDirectorQaRunning(jobId: string): boolean {
  return directorQaRunning.has(jobId);
}

// The Director QA runs the page sees, per film.
export function directorQaState(jobId: string, raw: Record<string, unknown>): DirectorQaRuns | undefined {
  const saved = (raw as Scratch).directorQa;
  if (!saved) return undefined;
  const live = directorQaRunning.get(jobId);
  const view = (kind: "long" | "short", run?: DirectorQaRun): DirectorQaRun | undefined =>
    run?.status === "running" && live !== kind ? { status: "interrupted" } : run;
  const out: DirectorQaRuns = {};
  for (const kind of ["long", "short"] as const) {
    const run = view(kind, saved[kind]);
    if (run) out[kind] = run;
  }
  return out;
}

function saveDirectorQa(jobId: string, kind: "long" | "short", run: DirectorQaRun): void {
  const job = getJob(jobId);
  if (!job) return;
  const scratch = job.scratch as Scratch;
  updateJob(jobId, { scratch: { ...scratch, directorQa: { ...scratch.directorQa, [kind]: run } } });
}

// Start Run Director QA for one film and return at once: the run continues on
// the server whatever the page does. Refuses a job that is not at the visual
// preview, has no valid edit for that film, or has any visual operation running.
// "running" is saved before the first provider call.
export function startDirectorQaForJob(jobId: string, kind: "long" | "short"): { job: JobRecord; done: Promise<DirectorQaRun> } {
  storedFilm(jobId, kind);
  if (isDirectorQaRunning(jobId)) throw new Error("Director QA is already running for this job.");
  if (isRevisingSequence(jobId)) throw new Error("A sequence revision is already running for this job.");
  if (isRegeneratingStill(jobId)) throw new Error("A still is being regenerated. Wait for it to finish.");
  if (isAssetQaRunning(jobId)) throw new Error("Automatic Asset QA is running. Wait for it to finish.");
  directorQaRunning.set(jobId, kind);
  saveDirectorQa(jobId, kind, { status: "running", phase: "reviewing" });
  return { job: getJob(jobId)!, done: runDirectorQaForJob(jobId, kind) };
}

// The existing Director QA chain for one film, each step the same production
// function the step routes call: review, the Director repair, the cleanup, the
// coordinated repair and the final verification (runDirectorQa). Its own repairs
// pass qaRun so they keep this run's state. Each phase is persisted as it
// starts; the final result replaces it. Never throws.
async function runDirectorQaForJob(jobId: string, kind: "long" | "short"): Promise<DirectorQaRun> {
  const inRun: QaRunContext = { qaRun: true };
  // One line per failed step: never narration, prompts, feedback or payloads.
  const log = (stage: string, error: string) => console.error(`Director QA failed job=${jobId} kind=${kind} stage=${stage} error=${error}`);
  const step = <T>(stage: string, work: Promise<T>): Promise<T> =>
    work.catch((e) => {
      log(stage, (e as Error)?.message || String(e));
      throw e;
    });
  let run: DirectorQaRun;
  try {
    const outcome = await runDirectorQa(kind, {
      onPhase: (phase) => saveDirectorQa(jobId, kind, { status: "running", phase }),
      review: async (k) => (await step("review", directorReviewForJob(jobId, k))).qa,
      repair: async (k, repairs) => {
        const r = await step("repair", directorRepairForJob(jobId, k, repairs, undefined, inRun));
        return { changed: r.changed, unresolved: r.unresolved };
      },
      cleanup: async (k) => {
        const { cleanup } = await step("cleanup", directorCleanupForJob(jobId, k, undefined, inRun));
        if (cleanup.error) log("cleanup", cleanup.error);
        return cleanup;
      },
      coordinate: async (k, slotId, reason, intent) => {
        const { report } = await step("coordinate", directorCoordinateForJob(jobId, k, slotId, reason, undefined, intent, inRun));
        if (report.error) log("coordinate", report.error);
        return report;
      },
      verify: async (k) => {
        const { verify } = await step("verify", directorVerifyForJob(jobId, k));
        if (verify.error) log("verify", verify.error);
        return verify;
      },
    });
    run = outcome.status === "failed" ? { status: "failed", error: outcome.error } : { status: "complete", ...directorQaResult(outcome) };
  } catch (e) {
    const error = (e as Error)?.message || String(e);
    log("run", error);
    run = { status: "failed", error };
  }
  try {
    saveDirectorQa(jobId, kind, run);
  } finally {
    directorQaRunning.delete(jobId);
  }
  return run;
}

// ---- The visual gate: approval, and the Visual Autopilot that can use it ----

// Approve the visual preview: the ONE state transition manual Continue and the
// Visual Autopilot share. The caller then hands the job back to the worker
// (enqueueJob), which resumes the pipeline after the gate. Refused while any
// visual operation runs.
export function approveVisualsForJob(jobId: string): JobRecord {
  const job = getJob(jobId);
  if (!job) throw new Error("Job not found.");
  if (job.state !== "awaiting_preview") throw new Error("The visuals can only be approved at the visual preview.");
  if (isDirectorQaRunning(jobId)) throw new Error("Director QA is running. Wait for it to finish.");
  if (isRegeneratingStill(jobId)) throw new Error("A still is being regenerated. Wait for it to finish.");
  if (isRevisingSequence(jobId)) throw new Error("The sequence is being revised. Wait for it to finish.");
  if (isAssetQaRunning(jobId)) throw new Error("Automatic Asset QA is running. Wait for it to finish.");
  approvePreview(jobId);
  return getJob(jobId)!;
}

// The whole visual gate is clean, read from the CURRENT saved state only: the
// Asset QA result is clean, and each film's Director QA completed with its
// existing `clean` result. A result a later edit invalidated is gone, so it can
// never count; a stored "running" without a live run reads as interrupted.
export function visualGateClean(jobId: string): boolean {
  const job = getJob(jobId);
  if (!job || job.state !== "awaiting_preview") return false;
  const asset = (job.scratch as Scratch).assetQa;
  if (asset?.status !== "done" || !asset.clean) return false;
  const runs = directorQaState(jobId, job.scratch);
  return (["long", "short"] as const).every((kind) => {
    const run = runs?.[kind];
    return run?.status === "complete" && run.clean;
  });
}

// Which jobs are in the Visual Autopilot chain, and how the last chain ended
// when it approved or failed to approve. Server memory only: the stages' own
// persisted results are the record, and a restart simply leaves the job at the
// visual gate under manual control.
const visualAutopilot = new Map<string, VisualAutopilotState>();
export function visualAutopilotState(jobId: string): VisualAutopilotState | undefined {
  return visualAutopilot.get(jobId);
}

// One film's Director QA as an Autopilot stage: a film that already has a saved
// result is never started again (its current result is used as it stands); a
// start the guards refuse ends the chain.
async function autopilotDirectorQa(jobId: string, kind: "long" | "short"): Promise<DirectorQaRun | undefined> {
  const job = getJob(jobId);
  if (!job) return undefined;
  if ((job.scratch as Scratch).directorQa?.[kind]) return directorQaState(jobId, job.scratch)?.[kind];
  try {
    return await startDirectorQaForJob(jobId, kind).done;
  } catch (e) {
    console.error(`Visual Autopilot stopped job=${jobId} stage=${kind} error=${(e as Error)?.message || String(e)}`);
    return undefined;
  }
}

// After production has just acquired fresh visuals and stopped at the visual
// gate (the worker's "preview_gate"): Asset QA; if clean, Director QA for Long;
// if Long completed (clean or with exceptions, so every exception arrives in one
// stop), Director QA for Short; then, only if the whole gate is clean in the
// saved state, the existing approval and `advance` (the worker's enqueueJob),
// exactly as manual Continue. Any exception, failure or interruption stops at
// the visual gate. Each stage is the existing function with its own guards,
// spend checks and persisted result; nothing is retried. Starts nothing unless
// this call's own Asset QA ran, so a repeat notice, or a job whose visuals were
// already reviewed, never starts or charges anything. Never throws.
export async function autoVisualQaForJob(jobId: string, advance: (jobId: string) => void): Promise<"approved" | "stopped" | undefined> {
  if (visualAutopilot.get(jobId)?.status === "running") return undefined;
  visualAutopilot.set(jobId, { status: "running" });
  const stop = () => (visualAutopilot.delete(jobId), "stopped" as const);
  try {
    const asset = await autoAssetQaForJob(jobId);
    if (!asset) {
      visualAutopilot.delete(jobId);
      return undefined;
    }
    if (!asset.clean) return stop();
    const long = await autopilotDirectorQa(jobId, "long");
    if (long?.status !== "complete") return stop();
    const short = await autopilotDirectorQa(jobId, "short");
    if (short?.status !== "complete") return stop();
    if (!visualGateClean(jobId)) return stop();
    approveVisualsForJob(jobId);
    visualAutopilot.set(jobId, { status: "passed" });
    advance(jobId);
    return "approved";
  } catch (e) {
    const error = (e as Error)?.message || String(e);
    console.error(`Visual Autopilot failed job=${jobId} stage=continue error=${error}`);
    visualAutopilot.set(jobId, { status: "failed", error });
    return "stopped";
  }
}
