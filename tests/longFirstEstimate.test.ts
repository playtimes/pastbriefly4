import { describe, test, expect, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";

// Stage 16A Slice 2, pricing: a Long-first job is estimated for the work allowed
// before LONG COMPLETE only - no Short line and no Short component - from the
// same PRICING constants and plan counts as the pair estimate, which is unchanged.
const tmp = mkdtempSync(path.join(os.tmpdir(), "pb4-long-first-estimate-"));
process.env.PROVIDER_MODE = "mock";
process.env.PB4_DATA_DIR = path.join(tmp, "data");
process.env.PB4_MEDIA_DIR = path.join(tmp, "media");

vi.mock("../src/server/worker.ts", () => ({ enqueueJob: vi.fn() })); // no job runs here

const { estimateJob, estimateLongFirst, planCounts } = await import("../src/production/estimate.ts");
const { PRICING, AUTOPILOT_QUALITY_RESERVE_USD, ttsUsd, round } = await import("../src/server/pricing.ts");
const { upsertStory, setScripts, getJob, createJob } = await import("../src/server/store.ts");
const { paulBunyanStory } = await import("../src/production/fixtures/paulBunyan.ts");
const Fastify = (await import("fastify")).default;
const { registerRoutes } = await import("../src/server/routes.ts");

let n = 0;
function story() {
  const slug = `estimate-${n++}`;
  const s = { ...paulBunyanStory, id: slug, slug, title: `Estimate ${n}`, createdAt: new Date().toISOString() };
  upsertStory(s);
  return s;
}

describe("the Long-first estimate", () => {
  test("only pre-LONG COMPLETE work, every line from the constants; the default total is $9.39", () => {
    const s = story(); // no saved scripts: the default counts (6200 Long characters, 26 Long slots)
    const e = estimateLongFirst(s);
    expect(e.lines.map((l) => l.label)).toEqual([
      "Research (OpenAI web search)",
      "Long script (OpenAI)",
      "Narration (ElevenLabs)",
      "Reference image (OpenAI images)",
      "Cinematic stills (OpenAI images)",
      "Selective motion (Runway Gen-4.5, 5s)",
      "Visual planning (OpenAI)",
      "Final-film QC (OpenAI)",
      "Quality reserve",
    ]);
    for (const l of e.lines) expect(`${l.label} ${l.detail}`).not.toMatch(/short/i);
    const c = planCounts(s);
    const stills = c.longShots - 4;
    const clips = Math.max(3, Math.min(6, Math.floor(c.longShots / 5)));
    const expected = round(
      PRICING.openai.research +
        2 * PRICING.openai.script +
        ttsUsd(c.longChars) +
        PRICING.openai.image +
        stills * PRICING.openai.image +
        clips * PRICING.runway.video5s +
        2 * PRICING.openai.visualPlan +
        PRICING.openai.finalFactualReview +
        PRICING.openai.finalVisualReview +
        AUTOPILOT_QUALITY_RESERVE_USD,
    );
    expect(e.total).toBe(expected);
    expect(e.total).toBe(9.39); // today's constants and default counts
    expect(e.lines.find((l) => l.label === "Quality reserve")!.usd).toBe(1.5); // unchanged for the first proof
  });

  test("the pair estimate is unchanged: $12.53 by default, with its Short lines", () => {
    const e = estimateJob(story());
    expect(e.total).toBe(12.53);
    expect(e.lines.map((l) => l.label)).toContain("Long + Short scripts (OpenAI)");
  });

  test("a story whose saved scripts are a Long-first job's Long alone: planCounts, both estimates and the story page still work", async () => {
    const s = story();
    setScripts(s.id, { long: "word ".repeat(900) });
    const c = planCounts(s);
    expect(c.longChars).toBe(4500);
    expect(c.shortChars).toBe(850); // the default: there is no Short
    expect(estimateLongFirst(s).total).toBeGreaterThan(0);
    expect(estimateJob(s).total).toBeGreaterThan(0);
    const app = Fastify();
    await registerRoutes(app);
    const res = await app.inject({ method: "GET", url: `/api/stories/${s.slug}` });
    expect(res.statusCode).toBe(200);
    expect(res.json().longCompleteJobIds).toEqual([]);
    await app.close();
  });
});

describe("activation: every new production job is Long-first", () => {
  test("Generate creates a Long-first job (marked by its own insert) approved against the Long-first estimate; the story page offers that estimate", async () => {
    const s = story();
    const app = Fastify();
    await registerRoutes(app);
    const detail = (await app.inject({ method: "GET", url: `/api/stories/${s.slug}` })).json();
    const total = estimateLongFirst(s).total;
    expect(detail.estimate).toEqual(estimateLongFirst(s));
    expect((await app.inject({ method: "POST", url: `/api/stories/${s.id}/generate`, payload: { approvedMax: round(total - 0.01) } })).statusCode).toBe(400);
    const res = await app.inject({ method: "POST", url: `/api/stories/${s.id}/generate`, payload: { approvedMax: total } });
    expect(res.statusCode).toBe(200);
    expect(res.json().job.flow).toBe("long-first");
    const job = getJob(res.json().job.id)!;
    expect(job.scratch).toEqual({ flow: "long-first" });
    expect(job.estimatedCost).toBe(total);
    await app.close();
  });

  test("a job created before activation (no flow) stays pair-first: nothing reinterprets it", async () => {
    const s = story();
    const old = createJob({ id: "before-slice-2", storyId: s.id, mock: true, estimatedCost: 12.53, approvedMax: 12.53 });
    expect(old.scratch).toEqual({});
    const app = Fastify();
    await registerRoutes(app);
    const res = await app.inject({ method: "POST", url: `/api/stories/${s.id}/generate`, payload: { approvedMax: 20 } });
    expect(res.json()).toMatchObject({ duplicate: true, job: { id: "before-slice-2" } }); // the active job, as always
    expect("flow" in res.json().job).toBe(false);
    expect(getJob("before-slice-2")!.scratch).toEqual({});
    await app.close();
  });
});
