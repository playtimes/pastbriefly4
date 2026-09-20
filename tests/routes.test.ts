import { describe, test, expect, beforeAll } from "vitest";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";

const tmp = mkdtempSync(path.join(os.tmpdir(), "pb4-routes-"));
process.env.PROVIDER_MODE = "mock";
process.env.PB4_DATA_DIR = path.join(tmp, "data");
process.env.PB4_MEDIA_DIR = path.join(tmp, "media");

const Fastify = (await import("fastify")).default;
const { registerRoutes } = await import("../src/server/routes.ts");
const { ensureSeed } = await import("../src/production/seed.ts");
const { getStoryBySlug, createJob } = await import("../src/server/store.ts");
const { newJobId } = await import("../src/production/generate.ts");

let app: FastifyInstance;
beforeAll(async () => {
  app = Fastify();
  await registerRoutes(app);
  ensureSeed();
  await app.ready();
});

describe("story routes", () => {
  test("lists seeded stories", async () => {
    const res = await app.inject({ method: "GET", url: "/api/stories" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.stories.length).toBeGreaterThanOrEqual(8);
  });

  test("returns a story with a cost estimate", async () => {
    const res = await app.inject({ method: "GET", url: "/api/stories/paul-bunyan" });
    expect(res.statusCode).toBe(200);
    expect(res.json().story.title).toContain("Paul Bunyan");
    expect(res.json().estimate.total).toBeGreaterThan(0);
  });

  test("unknown story is 404", async () => {
    expect((await app.inject({ method: "GET", url: "/api/stories/nope" })).statusCode).toBe(404);
  });
});

describe("cost approval gates paid work", () => {
  test("rejects an approval below the estimate", async () => {
    const story = getStoryBySlug("pig-war")!;
    const res = await app.inject({ method: "POST", url: `/api/stories/${story.id}/generate`, payload: { approvedMax: 0.01 } });
    expect(res.statusCode).toBe(400);
  });

  test("rejects an approval above the ceiling", async () => {
    const story = getStoryBySlug("vasa")!;
    const res = await app.inject({ method: "POST", url: `/api/stories/${story.id}/generate`, payload: { approvedMax: 9999 } });
    expect(res.statusCode).toBe(400);
  });
});

describe("one job per story", () => {
  test("a second generate returns the existing job, not a new one", async () => {
    const story = getStoryBySlug("ea-nasir")!;
    // Pre-seed an active job so a real render is never triggered by the test.
    const existing = createJob({ id: newJobId(), storyId: story.id, mock: true, estimatedCost: 1, approvedMax: 15 });
    const res = await app.inject({ method: "POST", url: `/api/stories/${story.id}/generate`, payload: { approvedMax: 15 } });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.duplicate).toBe(true);
    expect(body.job.id).toBe(existing.id);
  });
});

describe("job persistence / resume", () => {
  test("a running job is resumable after a restart", async () => {
    const { updateJob, resumableJobIds } = await import("../src/server/store.ts");
    const story = getStoryBySlug("barings")!;
    const job = createJob({ id: newJobId(), storyId: story.id, mock: true, estimatedCost: 1, approvedMax: 15 });
    updateJob(job.id, { state: "running", step: "stills" });
    expect(resumableJobIds()).toContain(job.id);
  });
});
