import crypto from "node:crypto";
import { config } from "../server/config.ts";
import { PRICING, round } from "../server/pricing.ts";
import { getJob, getStory, updateJob, addVideo, setScripts, type JobRecord } from "../server/store.ts";
import type { JobStep, Video } from "../types.ts";
import { now } from "../server/db.ts";
import { ensureStoryDirs, inStory, mediaRel, storyDir } from "./paths.ts";
import { researchStory } from "./research.ts";
import { writeScripts } from "./scripts.ts";
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
  scripts?: Scripts;
  narration?: { long: Narration; short: Narration };
  longShots?: PlannedShot[];
  shortShots?: PlannedShot[];
  spent?: number;
}

// Enforce the approved ceiling before any paid provider call. No-op in mock.
function charge(job: JobRecord, usd: number, scratch: Scratch): void {
  if (config.mode !== "live") return;
  const next = round((scratch.spent ?? 0) + usd);
  if (next > job.approvedMax + 1e-9) throw new Error(`Approved maximum $${job.approvedMax} would be exceeded ($${next}).`);
  scratch.spent = next;
  updateJob(job.id, { spent: next });
}

function step(jobId: string, step: JobStep, message: string, scratch: Scratch): void {
  updateJob(jobId, { state: "running", step, message, scratch });
}

export async function runJob(jobId: string, opts: { autoApprovePreview?: boolean } = {}): Promise<void> {
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
      scratch.research = await researchStory(story);
      charge(job, PRICING.openai.research, scratch);
      updateJob(jobId, { scratch });
    }
    const research = scratch.research;

    // 2. Scripts
    if (!scratch.scripts) {
      step(jobId, "scripts", "Writing the films", scratch);
      scratch.scripts = await writeScripts(story, research);
      setScripts(story.id, scratch.scripts);
      charge(job, 2 * PRICING.openai.script, scratch);
      updateJob(jobId, { scratch });
    }
    const scripts = scratch.scripts;

    // 3. Narration
    if (!scratch.narration) {
      step(jobId, "narration", "Recording narration", scratch);
      const long = await recordNarration(story.slug, "long", scripts.long);
      const short = await recordNarration(story.slug, "short", scripts.short);
      scratch.narration = { long, short };
      charge(job, ttsCost(scripts), scratch);
      updateJob(jobId, { scratch });
    }
    const narration = scratch.narration;

    // 4. Plan + acquire stills / archive
    if (!scratch.longShots || !scratch.shortShots) {
      scratch.longShots = planShots("long", scripts.long, story, research.world, narration.long);
      scratch.shortShots = planShots("short", scripts.short, story, research.world, narration.short);
      updateJob(jobId, { scratch });
    }
    const master = await ensureMaster(story, research.world);

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
          await acquireStill(story, kind, shot, master);
          if (config.mode === "live" && shot.mediaType === "image" && shot.truth !== "archive") charge(job, PRICING.openai.image, scratch);
          updateJob(jobId, { scratch });
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
          await acquireMotion(story, kind, shot);
          if (shot.motionPath) charge(job, PRICING.higgsfield.video, scratch);
          updateJob(jobId, { scratch });
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

function ttsCost(scripts: Scripts): number {
  return round(((scripts.long.length + scripts.short.length) / 1000) * PRICING.elevenlabs.perThousandChars);
}

export function newJobId(): string {
  return crypto.randomUUID();
}
