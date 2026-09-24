import { describe, test, expect, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";

// runJob must switch the job to the "rendering" step before Remotion starts, and
// move on to "finishing" only after both films are rendered. renderFilms and
// probeVideo are stubbed, so no real render happens.
const tmp = mkdtempSync(path.join(os.tmpdir(), "pb4-rendering-step-"));
process.env.PROVIDER_MODE = "mock";
process.env.PB4_DATA_DIR = path.join(tmp, "data");
process.env.PB4_MEDIA_DIR = path.join(tmp, "media");

const h = vi.hoisted(() => ({ jobId: "", stepAtRender: [] as string[], messageAtRender: [] as string[] }));

vi.mock("../src/render/renderVideo.ts", () => ({
  renderFilms: vi.fn(async () => {
    const { getJob } = await import("../src/server/store.ts");
    const job = getJob(h.jobId)!;
    h.stepAtRender.push(job.step);
    h.messageAtRender.push(job.message);
  }),
  probeVideo: vi.fn(() => ({ width: 1920, height: 1080, durationSec: 1, fps: 30, hasAudio: true })),
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
const { createJob, getJob, upsertStory } = await import("../src/server/store.ts");
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
  });
});
