import { describe, test, expect, beforeAll, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";

// The one cost approval is a realistic maximum: the production estimate plus the
// two normal visual-planning calls plus a fixed quality reserve for Autopilot's
// bounded checks and repairs. The reserve is authorization only (see
// filmGrammarCost.test.ts for the proof that it is never recorded as spend). The
// worker queue is stubbed so no job ever runs.
const tmp = mkdtempSync(path.join(os.tmpdir(), "pb4-cost-approval-"));
process.env.PROVIDER_MODE = "mock";
process.env.PB4_DATA_DIR = path.join(tmp, "data");
process.env.PB4_MEDIA_DIR = path.join(tmp, "media");

vi.mock("../src/server/worker.ts", () => ({ enqueueJob: vi.fn() }));

const Fastify = (await import("fastify")).default;
const { registerRoutes } = await import("../src/server/routes.ts");
const { ensureSeed } = await import("../src/production/seed.ts");
const { getStoryBySlug, getJob } = await import("../src/server/store.ts");
const { estimateJob } = await import("../src/production/estimate.ts");
const { PRICING, AUTOPILOT_QUALITY_RESERVE_USD, round } = await import("../src/server/pricing.ts");
const { config } = await import("../src/server/config.ts");
const { costNote } = await import("../src/app/screens/Story.tsx");

let app: FastifyInstance;
beforeAll(async () => {
  app = Fastify();
  await registerRoutes(app);
  ensureSeed();
  await app.ready();
});

const generate = (id: string, approvedMax: unknown) => app.inject({ method: "POST", url: `/api/stories/${id}/generate`, payload: { approvedMax } });
const cents = (n: number) => Math.abs(n * 100 - Math.round(n * 100)) < 1e-6;

describe("estimateJob", () => {
  test("includes exactly the two normal visual-planning calls, as one line", () => {
    const lines = estimateJob(getStoryBySlug("pig-war")!).lines.filter((l) => /planning/i.test(l.label));
    expect(lines).toEqual([{ label: "Visual planning (OpenAI)", usd: round(2 * PRICING.openai.visualPlan), detail: "coverage + edit" }]);
  });

  test("includes the mandatory Final-film QC as its own $1.70 line: two factual and two final visual reviews", () => {
    expect([PRICING.openai.finalFactualReview, PRICING.openai.finalVisualReview]).toEqual([0.1, 0.75]);
    const lines = estimateJob(getStoryBySlug("pig-war")!).lines.filter((l) => /final-film/i.test(l.label));
    expect(lines).toEqual([{ label: "Final-film QC (OpenAI)", usd: 1.7, detail: "2 factual + 2 final visual reviews" }]);
  });

  test("includes a $1.50 quality reserve", () => {
    expect(AUTOPILOT_QUALITY_RESERVE_USD).toBe(1.5);
    const reserve = estimateJob(getStoryBySlug("pig-war")!).lines.filter((l) => l.label === "Quality reserve");
    expect(reserve).toHaveLength(1);
    expect(reserve[0].usd).toBe(1.5);
    expect(reserve[0].detail).toMatch(/unused reserve is not spent/);
  });

  test("the total includes both additions and stays rounded to cents", () => {
    for (const slug of ["pig-war", "paul-bunyan", "vasa"]) {
      const e = estimateJob(getStoryBySlug(slug)!);
      const production = e.lines.filter((l) => !/planning|reserve/i.test(l.label)).reduce((a, l) => a + l.usd, 0);
      expect(e.total).toBe(round(production + 2 * PRICING.openai.visualPlan + AUTOPILOT_QUALITY_RESERVE_USD));
      expect(e.total).toBe(round(e.lines.reduce((a, l) => a + l.usd, 0)));
      expect(cents(e.total)).toBe(true);
      expect(e.total).toBeLessThanOrEqual(config.maxSpendUsd); // a normal story still fits under the ceiling
    }
  });

  test("user-facing lines use no QA-engine terminology", () => {
    const text = estimateJob(getStoryBySlug("pig-war")!).lines.map((l) => `${l.label} ${l.detail ?? ""}`).join("\n");
    expect(text).not.toMatch(/director|asset qa|\bqa\b|coordinated|verification call|sequence/i);
  });
});

describe("Generate accepts the new estimate as the approved maximum", () => {
  test("approvedMax exactly equal to the estimate is accepted, with nothing spent yet", async () => {
    const story = getStoryBySlug("pig-war")!;
    const total = estimateJob(story).total;
    const res = await generate(story.id, total);
    expect(res.statusCode).toBe(200);
    const job = getJob(res.json().job.id)!;
    expect(job.approvedMax).toBe(total);
    expect(job.estimatedCost).toBe(total);
    expect(job.spent).toBe(0);
  });

  test("approvedMax below the new estimate is rejected", async () => {
    const story = getStoryBySlug("vasa")!;
    const total = estimateJob(story).total;
    const res = await generate(story.id, round(total - 0.01));
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/below the estimate/);
    // The old estimate (without planning and reserve) is no longer enough.
    expect((await generate(story.id, round(total - 2 * PRICING.openai.visualPlan - AUTOPILOT_QUALITY_RESERVE_USD))).statusCode).toBe(400);
  });

  test("MAX_SPEND_USD is still enforced", async () => {
    const story = getStoryBySlug("vasa")!;
    const res = await generate(story.id, round(config.maxSpendUsd + 0.01));
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/exceeds the ceiling/);
  });
});

describe("cost dialog copy", () => {
  test("live mode says PB4 may spend less and names no QA machinery; mock mode stays free", () => {
    expect(costNote("live")).toMatch(/^PB4 may spend less than this\. The quality reserve is only used if automatic checks or bounded repairs need it\./);
    expect(costNote("live")).not.toMatch(/director|asset qa|\bqa\b|coordinated|verification/i);
    expect(costNote("mock")).toMatch(/offline and free/);
  });
});
