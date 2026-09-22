import { describe, test, expect, vi, beforeEach } from "vitest";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import Fastify from "fastify";
import type { Story } from "../src/types.ts";

// The Story Review Gate: runJob must stop after the audited scripts with state
// awaiting_text and spend nothing on media until the text is approved. Every
// provider is stubbed, so nothing live runs and no render happens.
const tmp = mkdtempSync(path.join(os.tmpdir(), "pb4-review-gate-"));
process.env.PROVIDER_MODE = "live";
process.env.OPENAI_API_KEY = "test-key";
process.env.ELEVENLABS_API_KEY = "test-key";
process.env.PB4_DATA_DIR = path.join(tmp, "data");
process.env.PB4_MEDIA_DIR = path.join(tmp, "media");

const h = vi.hoisted(() => ({
  researchCalls: 0,
  writeCalls: [] as string[],
  auditCalls: 0,
  narration: [] as string[],
}));

vi.mock("../src/production/research.ts", () => ({
  researchStory: vi.fn(async () => {
    h.researchCalls++;
    return {
      summary: "A stranded submarine sparks a standoff.",
      moments: [{ title: "The grounding", detail: "Stuck fast near a naval base." }],
      sources: [{ title: "SOU 2001:85", url: "https://example.org", note: "official" }],
      facts: [{ fact: "The submarine ran aground on 27 October 1981.", sourceTitle: "SOU 2001:85", sourceUrl: "https://example.org" }],
      productionNote: "",
      world: { period: "1981", place: "X", palette: "p", visualDirection: "v", recurringPeople: [], recurringLocations: [], referenceImages: [] },
    };
  }),
  // routes.ts imports these; they are never called in these tests.
  findStories: vi.fn(),
  recheckStory: vi.fn(),
}));

vi.mock("../src/production/scripts.ts", () => ({
  writeScript: vi.fn(async (_s: unknown, _r: unknown, kind: string) => {
    h.writeCalls.push(kind);
    return kind === "long" ? "Draft long narration. Two short sentences here." : "Draft short narration.";
  }),
  auditScripts: vi.fn(async () => {
    h.auditCalls++;
    return { long: "Audited long narration. Two short sentences here.", short: "Audited short narration." };
  }),
}));

vi.mock("../src/production/narration.ts", () => ({
  recordNarration: vi.fn(async (_slug: string, kind: string) => {
    h.narration.push(kind);
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

const { runJob, approveTextForJob, newJobId } = await import("../src/production/generate.ts");
const { createJob, getJob, upsertStory, getScripts, resumableJobIds } = await import("../src/server/store.ts");
const { registerRoutes } = await import("../src/server/routes.ts");

let n = 0;
function makeStory(): Story {
  const slug = `review-gate-${n++}`;
  const story: Story = {
    id: slug,
    slug,
    title: "A Soviet Submarine Got Stuck in Sweden",
    hook: "It ran aground yards from a secret naval base.",
    category: "Conflicts & Standoffs",
    year: "1981",
    place: "Karlskrona, Sweden",
    summary: "A stranded submarine sparks a standoff.",
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
  h.researchCalls = 0;
  h.writeCalls.length = 0;
  h.auditCalls = 0;
  h.narration.length = 0;
});

describe("story review gate", () => {
  test("runJob stops after the audited scripts with state awaiting_text and no narration", async () => {
    const story = makeStory();
    const job = createJob({ id: newJobId(), storyId: story.id, mock: false, estimatedCost: 5, approvedMax: 15 });

    await runJob(job.id);

    // Research + both writes + one audit happened; then it stopped at the gate.
    expect(h.writeCalls).toEqual(["long", "short"]);
    expect(h.auditCalls).toBe(1);
    expect(getJob(job.id)!.state).toBe("awaiting_text");
    // No media work started: narration was never called before approval.
    expect(h.narration).toEqual([]);
    // The audited scripts are already stored for the review.
    expect(getScripts(story.id)!.long).toContain("Audited long narration");
  });

  test("the awaiting_text job survives restart logic and is not auto-continued", async () => {
    const story = makeStory();
    const job = createJob({ id: newJobId(), storyId: story.id, mock: false, estimatedCost: 5, approvedMax: 15 });

    await runJob(job.id);
    expect(getJob(job.id)!.state).toBe("awaiting_text");

    // resumeInterrupted only picks up queued/running jobs, never awaiting_text.
    expect(resumableJobIds()).not.toContain(job.id);

    // Running it again without approval does not pass the gate or repeat work.
    await runJob(job.id);
    expect(getJob(job.id)!.state).toBe("awaiting_text");
    expect(h.writeCalls).toEqual(["long", "short"]); // scripts not rewritten
    expect(h.narration).toEqual([]); // still no narration
  });

  test("approve-text resumes the SAME job from narration without rerunning text", async () => {
    const story = makeStory();
    const job = createJob({ id: newJobId(), storyId: story.id, mock: false, estimatedCost: 5, approvedMax: 15 });

    await runJob(job.id);
    expect(h.researchCalls).toBe(1);
    expect(h.writeCalls).toEqual(["long", "short"]);
    expect(h.auditCalls).toBe(1);

    // Approve the text: the same job is requeued with textApproved set.
    const approved = approveTextForJob(job.id);
    expect(approved.state).toBe("queued");
    expect((approved.scratch as any).textApproved).toBe(true);

    await runJob(job.id); // resumes; stops later at the visual preview gate
    const after = getJob(job.id)!;
    expect(after.state).toBe("awaiting_preview");

    // Narration ran only after approval; research/scripts were not rerun.
    expect(h.narration).toEqual(["long", "short"]);
    expect(h.researchCalls).toBe(1);
    expect(h.writeCalls).toEqual(["long", "short"]);
    expect(h.auditCalls).toBe(1);
  });

  test("the public job API exposes the review data but not the raw scratch", async () => {
    const story = makeStory();
    const job = createJob({ id: newJobId(), storyId: story.id, mock: false, estimatedCost: 5, approvedMax: 15 });
    await runJob(job.id);
    expect(getJob(job.id)!.state).toBe("awaiting_text");

    const app = Fastify();
    await registerRoutes(app);
    const res = await app.inject({ method: "GET", url: `/api/jobs/${job.id}` });
    expect(res.statusCode).toBe(200);
    const body = res.json() as any;

    // Only the useful review fields are exposed.
    const review = body.job.review;
    expect(review.title).toBe("A Soviet Submarine Got Stuck in Sweden");
    expect(review.hook).toContain("secret naval base");
    expect(review.facts[0].fact).toContain("27 October 1981");
    expect(review.facts[0].sourceUrl).toBe("https://example.org");
    expect(review.moments[0].title).toBe("The grounding");
    expect(review.sources[0].title).toBe("SOU 2001:85");
    expect(review.longScript).toContain("Audited long narration");
    expect(review.shortScript).toContain("Audited short narration");

    // The private scratch and internal flags are never sent to the client.
    expect(body.job.scratch).toBeUndefined();
    expect(body.job.previewApproved).toBeUndefined();

    await app.close();
  });
});
