import { describe, test, expect, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";

// runJob must switch the job to the "rendering" step before Remotion starts, and
// move on to "finishing" only after both films are rendered. Finishing checks BOTH
// finished files against the output contract before registering either. renderFilms
// and probeVideo are stubbed, so no real render happens: the probe answers from each
// film's RenderPlan, unless a test breaks one film.
const tmp = mkdtempSync(path.join(os.tmpdir(), "pb4-rendering-step-"));
process.env.PROVIDER_MODE = "mock";
process.env.PB4_DATA_DIR = path.join(tmp, "data");
process.env.PB4_MEDIA_DIR = path.join(tmp, "media");

const h = vi.hoisted(() => ({
  jobId: "",
  stepAtRender: [] as string[],
  messageAtRender: [] as string[],
  progressSeen: [] as unknown[],
  plans: {} as Record<string, { kind: string; width: number; height: number; fps: number; durationInFrames: number }>,
  broken: {} as Record<string, Record<string, unknown>>,
  probed: [] as string[],
}));

vi.mock("../src/render/renderVideo.ts", () => ({
  renderFilms: vi.fn(async (_dir: string, films: Array<{ plan: any; outPath: string }>, onProgress?: (fraction: number) => void) => {
    for (const f of films) h.plans[f.outPath] = f.plan;
    const { getJob } = await import("../src/server/store.ts");
    const { jobProgress } = await import("../src/production/generate.ts");
    const job = getJob(h.jobId)!;
    h.stepAtRender.push(job.step);
    h.messageAtRender.push(job.message);
    h.progressSeen.push(jobProgress(getJob(h.jobId)!));
    // Renderer ticks: fractions across both films; only whole-percent changes matter.
    for (const f of [0.004, 0.25, 0.251, 0.8, 1]) {
      onProgress?.(f);
      h.progressSeen.push(jobProgress(getJob(h.jobId)!));
    }
  }),
  probeVideo: vi.fn((file: string) => {
    const p = h.plans[file];
    h.probed.push(p.kind);
    return { width: p.width, height: p.height, durationSec: p.durationInFrames / p.fps + 0.03, fps: 30, hasAudio: true, ...h.broken[p.kind] };
  }),
}));

// Skip the ffmpeg placeholder stills; a stub file is enough for this test.
vi.mock("../src/production/mockAssets.ts", async (importOriginal) => {
  const { mkdirSync, writeFileSync } = await import("node:fs");
  const nodePath = await import("node:path");
  return {
    ...(await importOriginal<typeof import("../src/production/mockAssets.ts")>()),
    writePlaceholderStill: (outPath: string) => {
      mkdirSync(nodePath.dirname(outPath), { recursive: true });
      writeFileSync(outPath, "img");
    },
  };
});

const { runJob, newJobId } = await import("../src/production/generate.ts");
const { createJob, getJob, upsertStory, videosForStory } = await import("../src/server/store.ts");
const { paulBunyanStory } = await import("../src/production/fixtures/paulBunyan.ts");

describe("runJob rendering step", () => {
  test("switches to rendering before renderFilms and finishes after it", async () => {
    const story = { ...paulBunyanStory, createdAt: new Date().toISOString() };
    upsertStory(story);
    const job = createJob({ id: newJobId(), storyId: story.id, mock: true, estimatedCost: 0, approvedMax: 0 });
    h.jobId = job.id;

    await runJob(job.id, { autoApproveText: true, autoApprovePreview: true });

    expect(h.stepAtRender).toEqual(["rendering"]);
    expect(h.messageAtRender).toEqual(["Rendering the films"]);
    const done = getJob(job.id)!;
    expect(done.state).toBe("done");
    expect(done.step).toBe("finishing");
    // Render progress is a plain percentage while rendering, then cleared.
    expect(h.progressSeen).toEqual([0, 0, 25, 25, 80, 100].map((current) => ({ current, total: 100, percent: true })));
    expect((done.scratch as any).renderPercent).toBeUndefined();
  });

  test("J. two files that meet the contract are both registered and the job is done", async () => {
    const story = { ...paulBunyanStory, createdAt: new Date().toISOString() };
    upsertStory(story);
    const job = createJob({ id: newJobId(), storyId: story.id, mock: true, estimatedCost: 0, approvedMax: 0 });
    h.jobId = job.id;
    h.probed.length = 0;

    await runJob(job.id, { autoApproveText: true, autoApprovePreview: true });

    expect(getJob(job.id)!.state).toBe("done");
    expect(h.probed).toEqual(["long", "short"]);
    const videos = videosForStory(story.id).filter((v) => v.jobId === job.id);
    expect(videos.map((v) => [v.kind, v.width, v.height, v.fps, v.hasAudio]).sort()).toEqual([["long", 1920, 1080, 30, true], ["short", 1080, 1920, 30, true]]);
  });

  test("I. both films are checked before either is registered: a broken Short fails the job with nothing registered", async () => {
    const story = { ...paulBunyanStory, createdAt: new Date().toISOString() };
    upsertStory(story);
    const job = createJob({ id: newJobId(), storyId: story.id, mock: true, estimatedCost: 0, approvedMax: 0 });
    h.jobId = job.id;
    h.probed.length = 0;
    h.broken = { short: { hasAudio: false } }; // the Long is valid

    try {
      await expect(runJob(job.id, { autoApproveText: true, autoApprovePreview: true })).rejects.toThrow("Final file check failed for Short: audio stream is missing.");
    } finally {
      h.broken = {};
    }

    const failed = getJob(job.id)!;
    expect(failed.state).toBe("failed");
    expect(failed.step).toBe("finishing");
    expect(failed.error).toBe("Final file check failed for Short: audio stream is missing.");
    expect(h.probed).toEqual(["long", "short"]); // both probed before any check or registration
    expect(videosForStory(story.id).filter((v) => v.jobId === job.id)).toEqual([]); // not even the valid Long
  });
});
