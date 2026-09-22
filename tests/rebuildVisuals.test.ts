import { describe, test, expect } from "vitest";
import { mkdtempSync, writeFileSync, existsSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Story } from "../src/types.ts";

const tmp = mkdtempSync(path.join(os.tmpdir(), "pb4-rebuild-"));
process.env.PROVIDER_MODE = "mock";
process.env.PB4_DATA_DIR = path.join(tmp, "data");
process.env.PB4_MEDIA_DIR = path.join(tmp, "media");

const { clearVisualsForRebuild, newJobId } = await import("../src/production/generate.ts");
const { createJob, getJob, updateJob, upsertStory } = await import("../src/server/store.ts");
const { ensureStoryDirs, inStory } = await import("../src/production/paths.ts");

function makeStory(slug: string): Story {
  const story: Story = {
    id: slug,
    slug,
    title: "Rebuild Story",
    hook: "A hook.",
    category: "Disasters",
    year: "1981",
    place: "Somewhere",
    summary: "A summary.",
    heroImage: null,
    moments: [{ title: "m", detail: "d" }],
    sources: [],
    productionNote: "",
    createdAt: new Date().toISOString(),
  };
  upsertStory(story);
  return story;
}

// A job parked at the preview gate with completed non-visual work, a master
// reference, tracked spend, shot plans and their generated files on disk.
function seed(slug: string) {
  const story = makeStory(slug);
  ensureStoryDirs(slug);
  const files = {
    hero: "images/hero.png",
    longStill: "images/long-00.png",
    longMotion: "motion/long-00.mp4",
    shortStill: "images/short-00.png",
  };
  for (const rel of Object.values(files)) writeFileSync(inStory(slug, rel), "x");

  const job = createJob({ id: newJobId(), storyId: story.id, mock: true, estimatedCost: 5, approvedMax: 15 });
  const scratch = {
    research: { summary: "R" },
    scriptParts: { long: "L", short: "S" },
    scripts: { long: "L", short: "S" },
    narration: { long: { audioRel: "audio/long.mp3" }, short: { audioRel: "audio/short.mp3" } },
    masterRef: files.hero,
    spent: 1.23,
    longShots: [{ index: 0, path: files.longStill, motionPath: files.longMotion }],
    shortShots: [{ index: 0, path: files.shortStill }],
  };
  updateJob(job.id, { scratch: scratch as any, spent: 1.23, state: "awaiting_preview", previewApproved: true, preview: { moments: 2, archive: 0, reconstruction: 2, motionSelected: 1, remainingMotionCost: 0, frames: [] } as any });
  return { job, files };
}

describe("rebuild visuals", () => {
  test("preserves research, scripts, narration, masterRef and spend", () => {
    const { job } = seed("rebuild-a");
    clearVisualsForRebuild(job.id);

    const after = getJob(job.id)!;
    expect(after.scratch.research).toEqual({ summary: "R" });
    expect(after.scratch.scriptParts).toEqual({ long: "L", short: "S" });
    expect(after.scratch.scripts).toEqual({ long: "L", short: "S" });
    expect(after.scratch.narration.long.audioRel).toBe("audio/long.mp3");
    expect(after.scratch.narration.short.audioRel).toBe("audio/short.mp3");
    expect(after.scratch.masterRef).toBe("images/hero.png");
    expect(after.spent).toBe(1.23); // spend is never reset
  });

  test("clears the shot plans, preview and approval, and requeues the same job", () => {
    const { job } = seed("rebuild-b");
    clearVisualsForRebuild(job.id);

    const after = getJob(job.id)!;
    expect(after.id).toBe(job.id); // same job
    expect(after.scratch.longShots).toBeUndefined();
    expect(after.scratch.shortShots).toBeUndefined();
    expect(after.preview).toBeNull();
    expect(after.previewApproved).toBe(false);
    expect(after.state).toBe("queued");
  });

  test("removes the files the shots referenced but keeps the master image", () => {
    const { job, files } = seed("rebuild-c");
    // Precondition: everything exists.
    for (const rel of Object.values(files)) expect(existsSync(inStory("rebuild-c", rel))).toBe(true);

    clearVisualsForRebuild(job.id);

    expect(existsSync(inStory("rebuild-c", files.longStill))).toBe(false);
    expect(existsSync(inStory("rebuild-c", files.longMotion))).toBe(false);
    expect(existsSync(inStory("rebuild-c", files.shortStill))).toBe(false);
    expect(existsSync(inStory("rebuild-c", files.hero))).toBe(true); // master preserved
  });

  test("ignores missing files safely", () => {
    const { job } = seed("rebuild-d");
    // Remove a referenced file first so deletion must tolerate a missing path.
    rmSync(inStory("rebuild-d", "images/long-00.png"), { force: true });
    expect(() => clearVisualsForRebuild(job.id)).not.toThrow();
  });
});
