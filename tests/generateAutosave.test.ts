import { describe, test, expect, beforeAll, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";

// Generate saves the story to the Stories library, whether it starts a new job
// or returns the active one. The worker queue is stubbed so no job ever runs.
const tmp = mkdtempSync(path.join(os.tmpdir(), "pb4-autosave-"));
process.env.PROVIDER_MODE = "mock";
process.env.PB4_DATA_DIR = path.join(tmp, "data");
process.env.PB4_MEDIA_DIR = path.join(tmp, "media");

const h = vi.hoisted(() => ({ enqueued: [] as string[] }));
vi.mock("../src/server/worker.ts", () => ({ enqueueJob: vi.fn((id: string) => void h.enqueued.push(id)) }));

const Fastify = (await import("fastify")).default;
const { registerRoutes } = await import("../src/server/routes.ts");
const { ensureSeed } = await import("../src/production/seed.ts");
const { getStory, getStoryBySlug, setStorySaved, createJob, getJob } = await import("../src/server/store.ts");
const { newJobId } = await import("../src/production/generate.ts");
const { db } = await import("../src/server/db.ts");

let app: FastifyInstance;
beforeAll(async () => {
  app = Fastify();
  await registerRoutes(app);
  ensureSeed();
  await app.ready();
});

// A seeded story forced to unsaved, plus an approval that covers its estimate.
async function unsavedStory(slug: string) {
  const story = getStoryBySlug(slug)!;
  setStorySaved(story.id, false);
  expect(getStory(story.id)!.saved).toBe(false);
  const approvedMax = (await app.inject({ method: "GET", url: `/api/stories/${slug}` })).json().estimate.total;
  return { story, approvedMax };
}

const generate = (id: string, approvedMax: number) => app.inject({ method: "POST", url: `/api/stories/${id}/generate`, payload: { approvedMax } });

describe("Generate saves the story", () => {
  test("an unsaved story is saved when Generate starts a new job", async () => {
    const { story, approvedMax } = await unsavedStory("pig-war");
    const res = await generate(story.id, approvedMax);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.duplicate).toBe(false);
    expect(getStory(story.id)!.saved).toBe(true);
    // Job behaviour is unchanged: one queued job with the approved maximum, enqueued once.
    const job = getJob(body.job.id)!;
    expect(job.storyId).toBe(story.id);
    expect(job.approvedMax).toBe(approvedMax);
    expect(job.state).toBe("queued");
    expect(h.enqueued.filter((id) => id === job.id)).toHaveLength(1);
    // The story API now reports it saved, so the Story page shows "Saved".
    expect((await app.inject({ method: "GET", url: `/api/stories/pig-war` })).json().story.saved).toBe(true);
  });

  test("an unsaved story is saved when Generate returns the existing active job", async () => {
    const { story, approvedMax } = await unsavedStory("ea-nasir");
    const existing = createJob({ id: newJobId(), storyId: story.id, mock: true, estimatedCost: 1, approvedMax: 15 });
    const queued = h.enqueued.length;
    const res = await generate(story.id, approvedMax);
    expect(res.statusCode).toBe(200);
    expect(res.json().duplicate).toBe(true);
    expect(res.json().job.id).toBe(existing.id);
    expect(getStory(story.id)!.saved).toBe(true);
    expect(h.enqueued.length).toBe(queued); // nothing new queued
  });

  test("a rejected Generate does not save the story", async () => {
    const { story } = await unsavedStory("vasa");
    expect((await generate(story.id, 0.01)).statusCode).toBe(400); // below the estimate
    expect((await generate(story.id, 9999)).statusCode).toBe(400); // above the ceiling
    const invalid = await app.inject({ method: "POST", url: `/api/stories/${story.id}/generate`, payload: { approvedMax: "lots" } });
    expect(invalid.statusCode).toBe(400);
    const missing = await app.inject({ method: "POST", url: `/api/stories/${story.id}/generate`, payload: {} });
    expect(missing.statusCode).toBe(400);
    expect((await generate("no-such-story", 5)).statusCode).toBe(404);
    expect(getStory(story.id)!.saved).toBe(false);
  });

  test("a failed job creation does not save the story", async () => {
    const { story, approvedMax } = await unsavedStory("molasses-flood");
    // Make the jobs insert itself fail, as a real database error would.
    db.exec(`CREATE TEMP TRIGGER fail_job_insert BEFORE INSERT ON jobs BEGIN SELECT RAISE(ABORT, 'insert failed'); END`);
    try {
      const queued = h.enqueued.length;
      expect((await generate(story.id, approvedMax)).statusCode).toBe(500);
      expect(getStory(story.id)!.saved).toBe(false);
      expect(h.enqueued.length).toBe(queued);
    } finally {
      db.exec(`DROP TRIGGER fail_job_insert`);
    }
  });

  test("Save story still works on its own before any generation", async () => {
    const { story } = await unsavedStory("barings");
    const save = await app.inject({ method: "POST", url: `/api/stories/${story.id}/saved`, payload: { saved: true } });
    expect(save.statusCode).toBe(200);
    expect(save.json().story.saved).toBe(true);
    const unsave = await app.inject({ method: "POST", url: `/api/stories/${story.id}/saved`, payload: { saved: false } });
    expect(unsave.json().story.saved).toBe(false);
  });
});
