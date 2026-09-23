import { describe, test, expect, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Story } from "../src/types.ts";

// Live-mode spend/resume behaviour, with every paid provider stubbed. None of
// these tests reach the render step: they fail early or stop at the preview gate.
const tmp = mkdtempSync(path.join(os.tmpdir(), "pb4-spend-"));
process.env.PROVIDER_MODE = "live";
process.env.OPENAI_API_KEY = "test-key";
process.env.ELEVENLABS_API_KEY = "test-key";
process.env.PB4_DATA_DIR = path.join(tmp, "data");
process.env.PB4_MEDIA_DIR = path.join(tmp, "media");

// Shared, hoisted state the mock factories can safely read.
const h = vi.hoisted(() => ({
  imageCalls: [] as string[],
  narrationCalls: [] as string[],
  failShortOnce: false,
  shortAttempts: 0,
}));

vi.mock("../src/production/research.ts", () => ({
  researchStory: vi.fn(async () => ({
    summary: "S",
    moments: [{ title: "m", detail: "d" }],
    sources: [],
    // Live visual planning now requires verified facts, so the research fixture
    // carries one; the value is irrelevant to these spend/resume assertions.
    facts: [{ fact: "A concrete verified fact.", sourceTitle: "src", sourceUrl: "https://example.org" }],
    productionNote: "",
    world: { period: "1900", place: "X", palette: "p", visualDirection: "v", recurringPeople: [], recurringLocations: [], referenceImages: [] },
  })),
}));

vi.mock("../src/production/scripts.ts", () => ({
  writeScript: vi.fn(async (_s: unknown, _r: unknown, kind: string) => (kind === "long" ? "A long narration script. Two short sentences here." : "A short narration script.")),
  // The scripts step now runs a third call, the fidelity audit. Return the drafts
  // unchanged so these spend/resume tests keep asserting the same script text.
  auditScripts: vi.fn(async (_s: unknown, _r: unknown, drafts: { long: string; short: string }) => drafts),
}));

vi.mock("../src/production/narration.ts", () => ({
  recordNarration: vi.fn(async (_slug: string, kind: string) => {
    h.narrationCalls.push(kind);
    if (kind === "short" && h.failShortOnce && h.shortAttempts++ === 0) throw new Error("short narration failed");
    return { audioRel: `audio/${kind}.mp3`, audioMediaRel: `m/${kind}`, durationSec: 1, words: [{ word: "a", start: 0, end: 0.6 }] };
  }),
}));

vi.mock("../src/providers/openai.ts", async () => {
  const { mkdirSync, writeFileSync } = await import("node:fs");
  const nodePath = await import("node:path");
  return {
    respondJson: vi.fn(async () => ({})),
    imageMimeType: () => "image/png",
    generateImageFile: vi.fn(async (opts: { outPath: string }) => {
      h.imageCalls.push(opts.outPath);
      mkdirSync(nodePath.dirname(opts.outPath), { recursive: true });
      writeFileSync(opts.outPath, "img");
    }),
  };
});

vi.mock("../src/production/wikimedia.ts", () => ({ fetchArchive: vi.fn(async () => null) }));
vi.mock("../src/providers/higgsfield.ts", () => ({ generateMotion: vi.fn(async () => {}) }));

const { runJob, newJobId } = await import("../src/production/generate.ts");
const { createJob, getJob, updateJob, upsertStory } = await import("../src/server/store.ts");
const research = await import("../src/production/research.ts");

let n = 0;
function makeStory(): Story {
  const slug = `spend-story-${n++}`;
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

const heroCount = () => h.imageCalls.filter((p) => p.endsWith("hero.png")).length;
const narrCount = (kind: string) => h.narrationCalls.filter((k) => k === kind).length;

describe("budget guard", () => {
  test("is enforced before the first paid provider call", async () => {
    const story = makeStory();
    vi.mocked(research.researchStory).mockClear();
    // approvedMax below the research price: the preflight must throw before the call.
    const job = createJob({ id: newJobId(), storyId: story.id, mock: false, estimatedCost: 1, approvedMax: 0.05 });

    await expect(runJob(job.id, { autoApprovePreview: true })).rejects.toThrow(/Approved maximum/);
    expect(research.researchStory).not.toHaveBeenCalled();

    const after = getJob(job.id)!;
    expect(after.state).toBe("failed");
    expect(after.spent).toBe(0);
  });
});

describe("master image", () => {
  test("is generated once and reused on resume", async () => {
    const story = makeStory();
    h.imageCalls.length = 0;
    const job = createJob({ id: newJobId(), storyId: story.id, mock: false, estimatedCost: 5, approvedMax: 15 });

    await runJob(job.id, { autoApproveText: true }); // stops at the preview gate
    expect(getJob(job.id)!.state).toBe("awaiting_preview");
    expect(heroCount()).toBe(1);

    await runJob(job.id, { autoApproveText: true }); // resume: the master must not be regenerated
    expect(heroCount()).toBe(1);
  });
});

describe("partial narration resume", () => {
  test("a format that already succeeded is not re-recorded on retry", async () => {
    const story = makeStory();
    h.narrationCalls.length = 0;
    h.failShortOnce = true;
    h.shortAttempts = 0;
    const job = createJob({ id: newJobId(), storyId: story.id, mock: false, estimatedCost: 5, approvedMax: 15 });

    // Long succeeds, Short fails: the job fails after one call of each.
    await expect(runJob(job.id, { autoApproveText: true })).rejects.toThrow(/short narration failed/);
    expect(getJob(job.id)!.state).toBe("failed");
    expect(narrCount("long")).toBe(1);
    expect(narrCount("short")).toBe(1);

    // Retry the same job: Long is reused from scratch, only Short is re-recorded.
    updateJob(job.id, { state: "queued", error: null });
    await runJob(job.id, { autoApproveText: true });
    expect(narrCount("long")).toBe(1);
    expect(narrCount("short")).toBe(2);

    h.failShortOnce = false;
  });
});
