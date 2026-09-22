import { describe, test, expect, vi, beforeEach } from "vitest";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Story } from "../src/types.ts";

// The REAL production job (runJob) must run the same Final Text Integrity audit
// the benchmark path does: Long draft, Short draft, then one combined fidelity
// audit, with narration speaking ONLY the audited scripts. Every provider is
// stubbed; these runs stop at the preview gate or fail early, never rendering.
const tmp = mkdtempSync(path.join(os.tmpdir(), "pb4-script-audit-job-"));
process.env.PROVIDER_MODE = "live";
process.env.OPENAI_API_KEY = "test-key";
process.env.ELEVENLABS_API_KEY = "test-key";
process.env.PB4_DATA_DIR = path.join(tmp, "data");
process.env.PB4_MEDIA_DIR = path.join(tmp, "media");

const h = vi.hoisted(() => ({
  writeCalls: [] as string[], // kinds passed to writeScript
  auditCalls: 0,
  auditAttempts: 0,
  failAuditOnce: false,
  narrationLong: [] as string[], // script text handed to long narration
  narrationShort: [] as string[],
  failNarrationLong: false,
}));

vi.mock("../src/production/research.ts", () => ({
  researchStory: vi.fn(async () => ({
    summary: "S",
    moments: [{ title: "m", detail: "d" }],
    sources: [],
    facts: [{ fact: "A concrete fact.", sourceTitle: "src", sourceUrl: "https://example.org" }],
    productionNote: "",
    world: { period: "1900", place: "X", palette: "p", visualDirection: "v", recurringPeople: [], recurringLocations: [], referenceImages: [] },
  })),
}));

// Drafts are plainly labelled; the audit returns clearly different, audited text
// so we can prove narration and storage use the audited scripts, not the drafts.
vi.mock("../src/production/scripts.ts", () => ({
  writeScript: vi.fn(async (_s: unknown, _r: unknown, kind: string) => {
    h.writeCalls.push(kind);
    return kind === "long" ? "Draft long narration. Two short sentences here." : "Draft short narration.";
  }),
  auditScripts: vi.fn(async () => {
    h.auditCalls++;
    if (h.failAuditOnce && h.auditAttempts++ === 0) throw new Error("script audit failed");
    return { long: "Audited long narration. Two short sentences here.", short: "Audited short narration." };
  }),
}));

vi.mock("../src/production/narration.ts", () => ({
  recordNarration: vi.fn(async (_slug: string, kind: string, script: string) => {
    if (kind === "long") h.narrationLong.push(script);
    else h.narrationShort.push(script);
    if (kind === "long" && h.failNarrationLong) throw new Error("narration long failed");
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
      mkdirSync(nodePath.dirname(opts.outPath), { recursive: true });
      writeFileSync(opts.outPath, "img");
    }),
  };
});

vi.mock("../src/production/wikimedia.ts", () => ({ fetchArchive: vi.fn(async () => null) }));
vi.mock("../src/providers/higgsfield.ts", () => ({ generateMotion: vi.fn(async () => {}) }));

const { runJob, newJobId } = await import("../src/production/generate.ts");
const { createJob, getJob, updateJob, upsertStory, getScripts } = await import("../src/server/store.ts");
const { PRICING, round } = await import("../src/server/pricing.ts");

let n = 0;
function makeStory(): Story {
  const slug = `audit-job-${n++}`;
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
  h.writeCalls.length = 0;
  h.auditCalls = 0;
  h.auditAttempts = 0;
  h.failAuditOnce = false;
  h.narrationLong.length = 0;
  h.narrationShort.length = 0;
  h.failNarrationLong = false;
});

describe("runJob wires the script fidelity audit into the scripts step", () => {
  test("generates Long + Short + exactly one fidelity audit", async () => {
    const story = makeStory();
    const job = createJob({ id: newJobId(), storyId: story.id, mock: false, estimatedCost: 5, approvedMax: 15 });

    await runJob(job.id, { autoApproveText: true }); // stops at the preview gate
    expect(getJob(job.id)!.state).toBe("awaiting_preview");

    expect(h.writeCalls).toEqual(["long", "short"]);
    expect(h.auditCalls).toBe(1);
  });

  test("narration receives the audited scripts, not the drafts", async () => {
    const story = makeStory();
    const job = createJob({ id: newJobId(), storyId: story.id, mock: false, estimatedCost: 5, approvedMax: 15 });

    await runJob(job.id, { autoApproveText: true });

    expect(h.narrationLong[0]).toContain("Audited long narration");
    expect(h.narrationShort[0]).toContain("Audited short narration");
  });

  test("setScripts stores the audited scripts", async () => {
    const story = makeStory();
    const job = createJob({ id: newJobId(), storyId: story.id, mock: false, estimatedCost: 5, approvedMax: 15 });

    await runJob(job.id, { autoApproveText: true });

    const stored = getScripts(story.id)!;
    expect(stored.long).toBe("Audited long narration. Two short sentences here.");
    expect(stored.short).toBe("Audited short narration.");
  });

  test("an audit failure fails the job but preserves both drafts", async () => {
    h.failAuditOnce = true;
    const story = makeStory();
    const job = createJob({ id: newJobId(), storyId: story.id, mock: false, estimatedCost: 5, approvedMax: 15 });

    await expect(runJob(job.id)).rejects.toThrow(/script audit failed/);

    const after = getJob(job.id)!;
    expect(after.state).toBe("failed");
    // Both drafts survive in scratch; the audited result was never stored.
    const scratch = after.scratch as { scriptParts?: { long?: string; short?: string }; scripts?: unknown };
    expect(scratch.scriptParts?.long).toBe("Draft long narration. Two short sentences here.");
    expect(scratch.scriptParts?.short).toBe("Draft short narration.");
    expect(scratch.scripts).toBeUndefined();
    expect(h.writeCalls).toEqual(["long", "short"]);
  });

  test("retry after an audit failure re-runs only the audit, not the drafts", async () => {
    h.failAuditOnce = true;
    const story = makeStory();
    const job = createJob({ id: newJobId(), storyId: story.id, mock: false, estimatedCost: 5, approvedMax: 15 });

    await expect(runJob(job.id)).rejects.toThrow(/script audit failed/);
    expect(h.writeCalls).toEqual(["long", "short"]);
    expect(h.auditCalls).toBe(1);

    // Retry the SAME job: drafts are reused from scratch, only the audit re-runs.
    updateJob(job.id, { state: "queued", error: null });
    await runJob(job.id, { autoApproveText: true });

    expect(getJob(job.id)!.state).toBe("awaiting_preview");
    expect(h.writeCalls).toEqual(["long", "short"]); // still just the two draft writes
    expect(h.auditCalls).toBe(2); // the failed attempt plus the successful retry
    expect(getScripts(story.id)!.long).toContain("Audited long narration");
  });

  test("a completed audit is reused on a later resume, never re-run", async () => {
    const story = makeStory();
    const job = createJob({ id: newJobId(), storyId: story.id, mock: false, estimatedCost: 5, approvedMax: 15 });

    await runJob(job.id, { autoApproveText: true }); // to the preview gate: audit runs once
    expect(h.auditCalls).toBe(1);

    await runJob(job.id, { autoApproveText: true }); // resume: scripts step is skipped entirely
    expect(h.writeCalls).toEqual(["long", "short"]);
    expect(h.auditCalls).toBe(1);
  });

  test("spend tracks all three script calls exactly once", async () => {
    // Fail the step right after scripts so tracked spend is exactly research plus
    // the three script calls (long draft, short draft, audit).
    h.failNarrationLong = true;
    const story = makeStory();
    const job = createJob({ id: newJobId(), storyId: story.id, mock: false, estimatedCost: 5, approvedMax: 15 });

    await expect(runJob(job.id, { autoApproveText: true })).rejects.toThrow(/narration long failed/);

    expect(h.writeCalls).toEqual(["long", "short"]);
    expect(h.auditCalls).toBe(1);
    expect(getJob(job.id)!.spent).toBe(round(PRICING.openai.research + 3 * PRICING.openai.script));
  });
});
