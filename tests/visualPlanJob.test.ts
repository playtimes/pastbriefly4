import { describe, test, expect, vi, beforeEach } from "vitest";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Story } from "../src/types.ts";

// The REAL production job must plan both films with exactly ONE structured Visual
// Director call, reuse the plan on resume, and charge the planning call exactly
// once. Every provider is stubbed; these runs stop at the preview gate or fail
// early, never rendering.
const tmp = mkdtempSync(path.join(os.tmpdir(), "pb4-visual-plan-job-"));
process.env.PROVIDER_MODE = "live";
process.env.OPENAI_API_KEY = "test-key";
process.env.ELEVENLABS_API_KEY = "test-key";
process.env.PB4_DATA_DIR = path.join(tmp, "data");
process.env.PB4_MEDIA_DIR = path.join(tmp, "media");

const LONG = "A long narration script. Two short sentences here.";
const SHORT = "A short narration script.";

const h = vi.hoisted(() => ({
  respondCalls: 0,
  failMaster: false,
}));

vi.mock("../src/production/research.ts", () => ({
  researchStory: vi.fn(async () => ({
    summary: "S",
    moments: [{ title: "m", detail: "d" }],
    sources: [],
    facts: [{ fact: "A concrete verified fact.", sourceTitle: "src", sourceUrl: "https://example.org" }],
    productionNote: "",
    world: { period: "1900", place: "X", palette: "p", visualDirection: "v", recurringPeople: [], recurringLocations: [], referenceImages: [] },
  })),
}));

vi.mock("../src/production/scripts.ts", () => ({
  writeScript: vi.fn(async (_s: unknown, _r: unknown, kind: string) => (kind === "long" ? LONG : SHORT)),
  auditScripts: vi.fn(async (_s: unknown, _r: unknown, drafts: { long: string; short: string }) => drafts),
}));

vi.mock("../src/production/narration.ts", () => ({
  recordNarration: vi.fn(async (_slug: string, kind: string) => ({
    audioRel: `audio/${kind}.mp3`,
    audioMediaRel: `m/${kind}`,
    durationSec: 1,
    words: [{ word: "a", start: 0, end: 0.6 }],
  })),
}));

// respondJson is the Visual Director call here (research is stubbed above, so it
// is the only respondJson user in the pipeline). Count it and return a minimal
// valid plan; missing beats are synthesised locally, so the pipeline proceeds.
vi.mock("../src/providers/openai.ts", async () => {
  const { mkdirSync, writeFileSync } = await import("node:fs");
  const nodePath = await import("node:path");
  return {
    respondJson: vi.fn(async () => {
      h.respondCalls++;
      return { long: [], short: [] };
    }),
    imageMimeType: () => "image/png",
    generateImageFile: vi.fn(async (opts: { outPath: string }) => {
      if (h.failMaster && opts.outPath.endsWith("hero.png")) throw new Error("master failed");
      mkdirSync(nodePath.dirname(opts.outPath), { recursive: true });
      writeFileSync(opts.outPath, "img");
    }),
  };
});

vi.mock("../src/production/wikimedia.ts", () => ({ fetchArchive: vi.fn(async () => null) }));
vi.mock("../src/providers/runway.ts", () => ({ generateMotion: vi.fn(async () => {}) }));

const { runJob, newJobId } = await import("../src/production/generate.ts");
const { createJob, getJob, updateJob, upsertStory } = await import("../src/server/store.ts");
const { PRICING, round, ttsUsd } = await import("../src/server/pricing.ts");

let n = 0;
function makeStory(): Story {
  const slug = `visual-plan-${n++}`;
  const story: Story = {
    id: slug,
    slug,
    title: "Test Story",
    hook: "A hook.",
    category: "Disasters",
    year: "1900",
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

beforeEach(() => {
  h.respondCalls = 0;
  h.failMaster = false;
});

describe("runJob plans both films with one Visual Director call", () => {
  test("exactly one structured planning call produces both plans, reused on resume", async () => {
    const story = makeStory();
    const job = createJob({ id: newJobId(), storyId: story.id, mock: false, estimatedCost: 5, approvedMax: 15 });

    await runJob(job.id, { autoApproveText: true }); // stops at the preview gate
    expect(getJob(job.id)!.state).toBe("awaiting_preview");
    expect(h.respondCalls).toBe(1); // ONE call planned both films

    const scratch = getJob(job.id)!.scratch as any;
    expect(scratch.longShots.length).toBeGreaterThan(0);
    expect(scratch.shortShots.length).toBeGreaterThan(0);

    await runJob(job.id, { autoApproveText: true }); // resume: plans are reused
    expect(h.respondCalls).toBe(1); // the director is never called again
  });

  test("the planning call is charged exactly once", async () => {
    h.failMaster = true; // fail right after planning so spend freezes on the plan
    const story = makeStory();
    const job = createJob({ id: newJobId(), storyId: story.id, mock: false, estimatedCost: 5, approvedMax: 15 });

    await expect(runJob(job.id, { autoApproveText: true })).rejects.toThrow(/master failed/);

    expect(h.respondCalls).toBe(1);
    const expected = round(PRICING.openai.research + 3 * PRICING.openai.script + ttsUsd(LONG.length) + ttsUsd(SHORT.length) + PRICING.openai.visualPlan);
    expect(getJob(job.id)!.spent).toBe(expected);

    // Retry the same job: the plan is reused (no second director call, no second
    // planning charge), and the master image now succeeds through to the gate.
    h.failMaster = false;
    updateJob(job.id, { state: "queued", error: null });
    await runJob(job.id, { autoApproveText: true });

    expect(getJob(job.id)!.state).toBe("awaiting_preview");
    expect(h.respondCalls).toBe(1); // still exactly one planning call across both runs
  });
});
