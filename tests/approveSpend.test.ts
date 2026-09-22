import { describe, test, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Story } from "../src/types.ts";

const tmp = mkdtempSync(path.join(os.tmpdir(), "pb4-approve-"));
process.env.PROVIDER_MODE = "mock";
process.env.PB4_DATA_DIR = path.join(tmp, "data");
process.env.PB4_MEDIA_DIR = path.join(tmp, "media");

const { raiseApprovedMax, newJobId } = await import("../src/production/generate.ts");
const { createJob, getJob, updateJob, upsertStory } = await import("../src/server/store.ts");
const { config } = await import("../src/server/config.ts");

function makeStory(slug: string): Story {
  const story: Story = {
    id: slug,
    slug,
    title: "Approve Story",
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

// A job that failed because the next paid call would exceed the approved maximum,
// with completed research and tracked spend recorded in scratch.
function seedFailed(slug: string, approvedMax = 5.75, spent = 5.73) {
  const story = makeStory(slug);
  const job = createJob({ id: newJobId(), storyId: story.id, mock: true, estimatedCost: 5, approvedMax });
  const scratch = { research: { summary: "R" }, spent };
  updateJob(job.id, {
    scratch: scratch as any,
    spent,
    state: "failed",
    step: "stills",
    error: `Approved maximum $${approvedMax} would be exceeded ($5.81).`,
  });
  return getJob(job.id)!;
}

describe("approve additional spend", () => {
  test("the approved maximum can increase", () => {
    const job = seedFailed("approve-a");
    const after = raiseApprovedMax(job.id, 7.75);
    expect(after.approvedMax).toBe(7.75);
  });

  test("the approved maximum cannot decrease", () => {
    const job = seedFailed("approve-b");
    expect(() => raiseApprovedMax(job.id, 5.0)).toThrow(/below/i);
    // The job is left untouched on a rejected decrease.
    const after = getJob(job.id)!;
    expect(after.approvedMax).toBe(5.75);
    expect(after.state).toBe("failed");
  });

  test("the approved maximum cannot exceed config.maxSpendUsd", () => {
    const job = seedFailed("approve-c");
    expect(() => raiseApprovedMax(job.id, config.maxSpendUsd + 1)).toThrow(/ceiling|exceed/i);
    expect(getJob(job.id)!.approvedMax).toBe(5.75);
  });

  test("spend, scratch and job id remain unchanged", () => {
    const job = seedFailed("approve-d");
    const after = raiseApprovedMax(job.id, 8);
    expect(after.id).toBe(job.id); // same job
    expect(after.spent).toBe(5.73); // spend is never reset
    expect(after.scratch.spent).toBe(5.73);
    expect(after.scratch.research).toEqual({ summary: "R" });
  });

  test("the same job resumes (queued, error cleared) after approval", () => {
    const job = seedFailed("approve-e");
    const after = raiseApprovedMax(job.id, 8);
    expect(after.id).toBe(job.id);
    expect(after.state).toBe("queued");
    expect(after.error).toBeNull();
  });
});
