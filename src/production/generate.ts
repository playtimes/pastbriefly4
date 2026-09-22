import crypto from "node:crypto";
import { rmSync } from "node:fs";
import { config } from "../server/config.ts";
import { PRICING, round, ttsUsd } from "../server/pricing.ts";
import { getJob, getStory, updateJob, addVideo, setScripts, type JobRecord } from "../server/store.ts";
import type { JobStep, Story, Video } from "../types.ts";
import { now } from "../server/db.ts";
import { ensureStoryDirs, inStory, mediaRel, storyDir } from "./paths.ts";
import { researchStory } from "./research.ts";
import { writeScript, auditScripts } from "./scripts.ts";
import { recordNarration, type Narration } from "./narration.ts";
import {
  planShots,
  acquireStill,
  ensureMaster,
  acquireMotion,
  buildPreview,
  buildRenderPlan,
  accentFor,
  type PlannedShot,
} from "./visuals.ts";
import type { ResearchPackage } from "./pipelineTypes.ts";
import type { Scripts } from "./scripts.ts";
import { renderFilms, probeVideo } from "../render/renderVideo.ts";

interface Scratch {
  research?: ResearchPackage;
  scriptParts?: { long?: string; short?: string };
  scripts?: Scripts;
  textApproved?: boolean; // the story review gate: set once the user approves the text
  narration?: { long?: Narration; short?: Narration };
  masterRef?: string;
  longShots?: PlannedShot[];
  shortShots?: PlannedShot[];
  spent?: number;
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

export async function runJob(jobId: string, opts: { autoApprovePreview?: boolean; autoApproveText?: boolean } = {}): Promise<void> {
  const job = getJob(jobId);
  if (!job || job.state === "done" || job.state === "failed") return;
  const story = getStory(job.storyId);
  if (!story) return;

  const scratch: Scratch = { ...(job.scratch as Scratch) };
  ensureStoryDirs(story.slug);
  const accent = accentFor(story.category);

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
      scratch.scripts = story.slug !== "paul-bunyan" && config.mode === "live" ? await runScriptAudit(job, story, research, drafts, scratch) : drafts;
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
      return; // wait for the user to Approve & continue
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

    // 4. Plan shots
    if (!scratch.longShots || !scratch.shortShots) {
      scratch.longShots = planShots("long", scripts.long, story, research.world, narration.long);
      scratch.shortShots = planShots("short", scripts.short, story, research.world, narration.short);
      updateJob(jobId, { scratch });
    }

    // Master reference still - one OpenAI image per job. Generated once and reused
    // on resume/Continue: keyed off scratch, not hero.png existing (which may be a
    // discovery placeholder). Labelled as still work so a failure here reads as
    // image generation rather than the preceding narration step.
    if (!scratch.masterRef) {
      step(jobId, "stills", "Creating the reference image", scratch);
      budget(job, PRICING.openai.image, scratch);
      scratch.masterRef = await ensureMaster(story, research.world);
      record(jobId, PRICING.openai.image, scratch);
    }
    const master = scratch.masterRef;

    step(jobId, "archive", "Finding historical material", scratch);
    for (const [kind, shots] of films(scratch)) {
      for (const shot of shots) {
        if (shot.truth === "archive" && !shot.path) {
          await acquireStill(story, kind, shot, master);
          updateJob(jobId, { scratch });
        }
      }
    }

    step(jobId, "stills", "Creating missing scenes", scratch);
    for (const [kind, shots] of films(scratch)) {
      for (const shot of shots) {
        if (!shot.path) {
          if (config.mode === "live" && shot.truth !== "archive") budget(job, PRICING.openai.image, scratch);
          await acquireStill(story, kind, shot, master);
          if (config.mode === "live" && shot.mediaType === "image" && shot.truth !== "archive") record(jobId, PRICING.openai.image, scratch);
          else updateJob(jobId, { scratch });
        }
      }
    }

    // 5. Visual preview gate
    const preview = buildPreview(story, scratch.longShots!, scratch.shortShots!);
    updateJob(jobId, { step: "preview", preview, scratch, message: "Reviewing visual direction" });

    const approved = opts.autoApprovePreview || getJob(jobId)!.previewApproved;
    if (!approved) {
      updateJob(jobId, { state: "awaiting_preview" });
      return; // wait for the user to Continue
    }

    // 6. Motion (only after the preview is approved)
    step(jobId, "build", "Building the films", scratch);
    for (const [kind, shots] of films(scratch)) {
      for (const shot of shots) {
        if (shot.wantsMotion && !shot.motionPath) {
          if (config.mode === "live") budget(job, PRICING.higgsfield.video, scratch);
          await acquireMotion(story, kind, shot);
          if (shot.motionPath) record(jobId, PRICING.higgsfield.video, scratch);
          else updateJob(jobId, { scratch });
        }
      }
    }

    // 7. Render both films
    const longPlan = buildRenderPlan("long", story, scratch.longShots!, narration.long, accent);
    const shortPlan = buildRenderPlan("short", story, scratch.shortShots!, narration.short, accent);
    await renderFilms(storyDir(story.slug), [
      { plan: longPlan, compositionId: "LongVideo", outPath: inStory(story.slug, "renders/long.mp4") },
      { plan: shortPlan, compositionId: "ShortVideo", outPath: inStory(story.slug, "renders/short.mp4") },
    ]);

    // 8. Finish: probe + register
    step(jobId, "finishing", "Finishing", scratch);
    for (const kind of ["long", "short"] as const) {
      const rel = `renders/${kind}.mp4`;
      const p = probeVideo(inStory(story.slug, rel));
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

export function newJobId(): string {
  return crypto.randomUUID();
}

// Real per-unit progress for the current step, derived from the work already in
// scratch. Returns null for steps without a meaningful count (research, finishing)
// so the UI keeps the plain spinner. The pipeline persists scratch after each unit,
// so the existing poll reflects this without any extra writes.
export function jobProgress(job: { step: JobStep; scratch: Record<string, any> }): { current: number; total: number } | null {
  const s = (job.scratch ?? {}) as Scratch;
  const shots = [...(s.longShots ?? []), ...(s.shortShots ?? [])];
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

// Reject only the visual work of an awaiting_preview job and rebuild it under the
// SAME job. Research, scripts, narration, the master reference and tracked spend
// stay in scratch, so runJob skips them and only replans/reacquires visuals. The
// budget guard still enforces approvedMax against the existing spend.
export function clearVisualsForRebuild(jobId: string): void {
  const job = getJob(jobId);
  if (!job) return;
  const story = getStory(job.storyId);
  const scratch = { ...(job.scratch as Scratch) };

  // Delete only the files these shots reference - never the master/reference image.
  const shots = [...(scratch.longShots ?? []), ...(scratch.shortShots ?? [])];
  if (story) {
    for (const s of shots) {
      for (const rel of [s.path, s.motionPath]) {
        if (rel) rmSync(inStory(story.slug, rel), { force: true });
      }
    }
  }

  delete scratch.longShots;
  delete scratch.shortShots;

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
