import { describe, test, expect, vi, beforeAll, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";

// Run Director QA orchestrated on the server: the existing chain (review, Director
// repair, cleanup, coordinated repair, final verification) from ONE trigger, with
// its phase and result persisted per film. A real stored plan (mock narration,
// the fallback planners, mock stills); every provider is a fake that counts calls.
const tmp = mkdtempSync(path.join(os.tmpdir(), "pb4-director-qa-server-"));
process.env.PROVIDER_MODE = "mock";
process.env.PB4_DATA_DIR = path.join(tmp, "data");
process.env.PB4_MEDIA_DIR = path.join(tmp, "media");

const h = vi.hoisted(() => ({
  calls: [] as any[],
  seen: [] as unknown[], // the job's persisted Long Director QA state at each provider call
  jobId: "",
  qa: null as any,
  answer: null as any, // sequence_revision answers, in order (the Director repair, then the cleanup)
  coord: null as any,
  verify: null as any,
  fail: {} as Record<string, unknown>, // schemaName -> Error to throw / malformed answer
  hold: null as null | Promise<void>,
  images: 0,
  other: 0,
}));
vi.mock("../src/providers/openai.ts", async () => {
  const { getJob } = await import("../src/server/store.ts");
  return {
    respondJson: vi.fn(async (o: any) => {
      h.calls.push(o);
      h.seen.push(structuredClone(getJob(h.jobId)?.scratch.directorQa?.long));
      if (h.hold) await h.hold;
      const failure = h.fail[o.schemaName];
      if (failure instanceof Error) throw failure;
      if (failure !== undefined) return failure;
      if (o.schemaName === "director_qa") return h.qa;
      if (o.schemaName === "coordinated_revision") return h.coord;
      if (o.schemaName === "director_verify") return h.verify;
      if (o.schemaName === "sequence_revision") return typeof h.answer === "function" ? h.answer(o) : h.answer;
      throw new Error(`unexpected provider call ${o.schemaName}`);
    }),
    imageMimeType: () => "image/png",
    generateImageFile: vi.fn(async () => void h.images++),
  };
});
vi.mock("../src/providers/runway.ts", () => ({ generateMotion: vi.fn(async () => void h.other++) }));
vi.mock("../src/production/wikimedia.ts", () => ({ fetchArchive: vi.fn(async () => (h.other++, null)) }));

const Fastify = (await import("fastify")).default;
const { registerRoutes } = await import("../src/server/routes.ts");
const g = await import("../src/production/generate.ts");
const v = await import("../src/production/visuals.ts");
const { buildFilm } = await import("../src/app/visualReview/model.ts");
const { buildDirectorBoard } = await import("../src/app/visualReview/board.ts");
const { recordNarration } = await import("../src/production/narration.ts");
const { createJob, getJob, updateJob, upsertStory } = await import("../src/server/store.ts");
const { ensureStoryDirs, inStory } = await import("../src/production/paths.ts");
const { setMode } = await import("../src/server/config.ts");
const { PRICING } = await import("../src/server/pricing.ts");
const { paulBunyanStory, paulBunyanResearch, paulBunyanScripts } = await import("../src/production/fixtures/paulBunyan.ts");
type Shot = import("../src/production/visuals.ts").PlannedShot;

let app: FastifyInstance;
let planned: { narration: any; plans: { long: Shot[]; short: Shot[] } };
beforeAll(async () => {
  app = Fastify();
  await registerRoutes(app);
  await app.ready();
  const slug = "director-qa-server-plan";
  const story = { ...paulBunyanStory, id: slug, slug, title: "A Neutral Story", createdAt: new Date().toISOString() };
  ensureStoryDirs(slug);
  const narration = { long: await recordNarration(slug, "long", paulBunyanScripts.long), short: await recordNarration(slug, "short", paulBunyanScripts.short) };
  planned = { narration, plans: await v.planVisuals(story, paulBunyanResearch, paulBunyanScripts, narration) };
});
beforeEach(() => {
  h.calls = [];
  h.seen = [];
  h.qa = { repairs: {}, humanReview: {}, summary: "Nothing notable." };
  h.answer = { changes: {}, unresolved: [] };
  h.coord = { changes: {}, unresolved: [] };
  h.verify = { humanReview: {}, summary: "Final." };
  h.fail = {};
  h.hold = null;
  h.images = 0;
  h.other = 0;
  setMode("live");
});
afterEach(() => {
  setMode("mock");
  vi.restoreAllMocks();
});

let seq = 0;
function seed() {
  const slug = `director-qa-server-${seq++}`;
  const story = { ...paulBunyanStory, id: slug, slug, title: "A Neutral Story", createdAt: new Date().toISOString() };
  upsertStory(story);
  ensureStoryDirs(slug);
  const plans = structuredClone(planned.plans);
  for (const kind of ["long", "short"] as const) {
    for (const s of plans[kind]) {
      if (s.edit !== "new") continue;
      s.path = `images/${kind}-${String(s.index).padStart(2, "0")}.png`;
      s.mediaType = "image";
      writeFileSync(inStory(slug, s.path), `still ${kind} ${s.index}`);
    }
    v.resolveReuse(story, kind, plans[kind]);
  }
  const job = createJob({ id: g.newJobId(), storyId: story.id, mock: false, estimatedCost: 5, approvedMax: 10 });
  const scratch = { research: paulBunyanResearch, scripts: paulBunyanScripts, textApproved: true, narration: planned.narration, masterRef: "images/hero.png", spent: 1, longShots: plans.long, shortShots: plans.short };
  updateJob(job.id, { scratch: scratch as any, spent: 1, state: "awaiting_preview", step: "preview", previewApproved: false, preview: v.buildPreview(story, plans.long, plans.short) });
  h.jobId = job.id;
  return { job, story, slug };
}
const shots = (id: string, kind: "long" | "short" = "long"): Shot[] => getJob(id)!.scratch[kind === "long" ? "longShots" : "shortShots"];
const pres = (s: Shot) => `${s.assetId}:${s.presentation}`;
const saved = (id: string, kind: "long" | "short" = "long") => getJob(id)!.scratch.directorQa?.[kind];
const pub = async (id: string) => (await app.inject({ method: "GET", url: `/api/jobs/${id}` })).json().job;
const post = (id: string, url: string, payload?: unknown) => app.inject({ method: "POST", url: `/api/jobs/${id}/${url}`, ...(payload === undefined ? {} : { payload }) });
const settled = async (id: string) => {
  for (let i = 0; i < 500 && g.isDirectorQaRunning(id); i++) await new Promise((r) => setTimeout(r, 5));
  expect(g.isDirectorQaRunning(id)).toBe(false);
};
const names = () => h.calls.map((c) => c.schemaName);
// An editable Long slot with room either side.
const target = (id: string) => shots(id).findIndex((s, i) => i > 1 && !s.wantsMotion);
// Director repair: pick this slot's first legal change (the first sequence_revision only).
const pickFirstFor = (t: number) => {
  let n = 0;
  return (o: any) => (n++ === 0 ? { changes: { [t]: o.schema.properties.changes.properties[t].enum[0] }, unresolved: [] } : { changes: {}, unresolved: [] });
};

const GRAPHIC = { reason: "The narration gives the earlier referendum result; the graphic shows the later parliamentary vote.", instruction: "Use the existing referendum-result graphic." };

describe("Run Director QA on the server: the full chain", () => {
  test("one trigger runs review, repair, cleanup, coordinate and verify in order: five calls, the same spend, no media", async () => {
    const { job } = seed();
    const t = target(job.id);
    const shortBefore = JSON.stringify(shots(job.id, "short"));
    h.qa = { repairs: { [t]: GRAPHIC }, humanReview: {}, summary: "One factual graphic mismatch." };
    h.verify = { humanReview: { [t]: "current: the graphic still shows the later vote" }, summary: "Final summary of the current edit." };

    const res = await post(job.id, "director-qa/long/run");
    expect(res.statusCode).toBe(200);
    expect(res.json().job.directorQa.long).toEqual({ status: "running", phase: "reviewing" }); // returned at once
    await settled(job.id); // no further request from the page

    expect(names()).toEqual(["director_qa", "sequence_revision", "sequence_revision", "coordinated_revision", "director_verify"]);
    expect(getJob(job.id)!.spent).toBeCloseTo(1 + 5 * PRICING.openai.visualPlan);
    expect(h.images + h.other).toBe(0);
    // The coordinated repair carries the original Director finding exactly as the browser used to send it.
    expect(h.calls[3].input).toContain(`DIRECTOR REPAIR INTENT\n\nReason:\n${GRAPHIC.reason}\n\nRequested correction:\n${GRAPHIC.instruction}\n\nWhy the one-slot repair could not complete:\nThe repair kept the current presentation.\n`);
    expect(h.calls[4].instructions).toBe(v.DIRECTOR_VERIFY_INSTRUCTIONS);
    // Long only: the other film is never sent or changed.
    for (const c of h.calls) expect(c.input).toContain("FILM: LONG");
    expect(JSON.stringify(shots(job.id, "short"))).toBe(shortBefore);

    const run = saved(job.id)!;
    expect(run).toMatchObject({ status: "complete", verified: true, automaticChanges: 0, coordinatedChanges: 0, summary: "Final summary of the current edit.", clean: false });
    expect(run.humanReview.find((x: any) => x.slotId === t).reason).toBe("current: the graphic still shows the later vote Coordinated repair left Slot " + String(t).padStart(2, "0") + " unchanged. The repair kept the current presentation.");
    expect(JSON.stringify(run)).not.toContain("One factual graphic mismatch."); // the initial summary is never kept
    expect(getJob(job.id)!.state).toBe("awaiting_preview");
    expect(getJob(job.id)!.previewApproved).toBe(false);
    // A reload shows the same result.
    expect((await pub(job.id)).directorQa.long).toEqual(run);
  });

  test("no Director repair: review, the cleanup the fixture's repetition patterns require, then verify; no coordinate", async () => {
    const { job } = seed();
    const done = g.startDirectorQaForJob(job.id, "long").done;
    const run: any = await done;
    expect(names()).toEqual(["director_qa", "sequence_revision", "director_verify"]);
    expect(run).toMatchObject({ status: "complete", automaticChanges: 0, coordinatedChanges: 0, verified: true, summary: "Final." });
    expect(getJob(job.id)!.spent).toBeCloseTo(1 + 3 * PRICING.openai.visualPlan);
  });

  test("persistence: running is saved before the first call and each phase as it starts", async () => {
    const { job } = seed();
    const t = target(job.id);
    h.qa = { repairs: { [t]: GRAPHIC }, humanReview: {}, summary: "" };
    await g.startDirectorQaForJob(job.id, "long").done;
    expect(h.seen).toEqual([
      { status: "running", phase: "reviewing" },
      { status: "running", phase: "repairing" },
      { status: "running", phase: "cleaning" },
      { status: "running", phase: "coordinating" },
      { status: "running", phase: "verifying" },
    ]);
    expect(saved(job.id)!.status).toBe("complete");
  });

  test("stale regression: the initial finding about visual A never survives its repair to B", async () => {
    const { job } = seed();
    const t = target(job.id);
    const before = pres(shots(job.id)[t]);
    h.qa = { repairs: { [t]: { reason: "group photo is repetitive", instruction: "show the landscape" } }, humanReview: { [t + 3]: "an old finding about the old edit" }, summary: "Initial summary about the old edit." };
    h.answer = pickFirstFor(t);
    h.verify = { humanReview: { [t]: "current: the new visual does not name the vote" }, summary: "Final summary." };
    const run: any = await g.startDirectorQaForJob(job.id, "long").done;
    const now = pres(shots(job.id)[t]);
    expect(now).not.toBe(before);
    expect(h.calls.at(-1).input).toContain(`current: ${now} - `); // the verifier reviewed B
    expect(run.automaticChanges).toBe(1);
    expect(run.changed).toContain(t);
    expect(run.humanReview.find((x: any) => x.slotId === t).reason).toBe("current: the new visual does not name the vote");
    for (const stale of ["group photo", "an old finding about the old edit", "Initial summary about the old edit."]) expect(JSON.stringify(run)).not.toContain(stale);
  });

  test("source of truth: saved edit, persisted result, Director Board (and its copy) and the verifier agree", async () => {
    const { job } = seed();
    const t = target(job.id);
    h.qa = { repairs: { [t]: { reason: "r", instruction: "i" } }, humanReview: {}, summary: "" };
    h.answer = pickFirstFor(t);
    const run: any = await g.startDirectorQaForJob(job.id, "long").done;
    const savedIds = shots(job.id).map(pres);
    const boardIds = buildDirectorBoard(buildFilm((await pub(job.id)).preview, "long")).cards.map((c) => `${c.frame.asset}:${c.frame.presentation}`);
    const verifyIds = [...h.calls.at(-1).input.matchAll(/^current: (\S+) - /gm)].map((m: any) => m[1]);
    expect(boardIds).toEqual(savedIds);
    expect(verifyIds).toEqual(savedIds);
    expect(run.changed.every((slot: number) => savedIds[slot] !== undefined)).toBe(true);
    expect((await pub(job.id)).directorQa.long).toEqual(run);
  });
});

describe("Run Director QA on the server: failures keep today's semantics", () => {
  const quiet = () => vi.spyOn(console, "error").mockImplementation(() => {});

  test("a failed review changes nothing, runs no later step, is logged once and not retried", async () => {
    const { job } = seed();
    const log = quiet();
    const before = JSON.stringify(shots(job.id));
    h.fail.director_qa = new Error("OpenAI responses 500");
    const run: any = await g.startDirectorQaForJob(job.id, "long").done;
    expect(run).toEqual({ status: "failed", error: "OpenAI responses 500" });
    expect(names()).toEqual(["director_qa"]);
    expect(JSON.stringify(shots(job.id))).toBe(before);
    expect(log.mock.calls.map((c) => c[0])).toEqual([`Director QA failed job=${job.id} kind=long stage=review error=OpenAI responses 500`]);
  });

  test("a failed Director repair keeps the edit before it; cleanup and verify still run once; the requested repairs are listed", async () => {
    const { job } = seed();
    const log = quiet();
    const t = target(job.id);
    h.qa = { repairs: { [t]: { reason: "wrong subject", instruction: "i" } }, humanReview: {}, summary: "" };
    let n = 0;
    h.answer = () => (n++ === 0 ? { changes: [], unresolved: [] } : { changes: {}, unresolved: [] }); // the repair's answer is malformed
    const before = pres(shots(job.id)[t]);
    const run: any = await g.startDirectorQaForJob(job.id, "long").done;
    expect(names()).toEqual(["director_qa", "sequence_revision", "sequence_revision", "director_verify"]);
    expect(run.repairError).toMatch(/Invalid sequence revision/);
    expect(run.requestedRepairs).toEqual([{ slotId: t, reason: "wrong subject" }]);
    expect(pres(shots(job.id)[t])).toBe(before);
    expect(log.mock.calls[0][0]).toMatch(new RegExp(`^Director QA failed job=${job.id} kind=long stage=repair error=Invalid sequence revision`));
  });

  test("a failed cleanup keeps the edit before it and is reported in the result", async () => {
    const { job } = seed();
    const log = quiet();
    h.answer = { changes: [], unresolved: [] }; // the cleanup's answer is malformed
    const before = JSON.stringify(shots(job.id));
    const run: any = await g.startDirectorQaForJob(job.id, "long").done;
    expect(run.cleanupError).toMatch(/Invalid sequence revision/);
    expect(JSON.stringify(shots(job.id))).toBe(before);
    expect(names()).toEqual(["director_qa", "sequence_revision", "director_verify"]);
    expect(log.mock.calls.map((c) => c[0]).filter((l: string) => l.includes("stage=cleanup"))).toHaveLength(1);
  });

  test("a failed coordinated repair keeps the edit before it and leaves the target for a person", async () => {
    const { job } = seed();
    quiet();
    const t = target(job.id);
    h.qa = { repairs: { [t]: GRAPHIC }, humanReview: {}, summary: "" };
    h.fail.coordinated_revision = { changes: [], unresolved: [] };
    const run: any = await g.startDirectorQaForJob(job.id, "long").done;
    expect(names()).toEqual(["director_qa", "sequence_revision", "sequence_revision", "coordinated_revision", "director_verify"]);
    expect(run.coordinatedError).toMatchObject({ target: t });
    expect(run.humanReview.find((x: any) => x.slotId === t).reason).toContain(`Coordinated repair could not resolve Slot ${String(t).padStart(2, "0")}. The previous valid edit is kept.`);
  });

  test("a failed verification keeps the repaired edit, restores no stale finding and keeps the current patterns", async () => {
    const { job } = seed();
    quiet();
    const t = target(job.id);
    h.qa = { repairs: { [t]: { reason: "group photo is repetitive", instruction: "i" } }, humanReview: {}, summary: "Initial." };
    h.answer = pickFirstFor(t);
    h.fail.director_verify = new Error("OpenAI responses 503");
    const run: any = await g.startDirectorQaForJob(job.id, "long").done;
    const repaired = pres(shots(job.id)[t]);
    expect(run).toMatchObject({ status: "complete", verified: false, verifyError: "OpenAI responses 503", automaticChanges: 1, summary: "" });
    expect(JSON.stringify(run)).not.toContain("group photo");
    expect(pres(shots(job.id)[t])).toBe(repaired);
    expect(names().filter((n) => n === "director_verify")).toHaveLength(1);
  });
});

describe("Run Director QA on the server: restart, invalidation and concurrency", () => {
  test("a stored running state without a live run reads as interrupted; nothing replays; a new run can start", async () => {
    const { job } = seed();
    const before = JSON.stringify(shots(job.id));
    updateJob(job.id, { scratch: { ...getJob(job.id)!.scratch, directorQa: { long: { status: "running", phase: "cleaning" } } } });
    expect((await pub(job.id)).directorQa.long).toEqual({ status: "interrupted" });
    expect(h.calls).toEqual([]);
    expect(JSON.stringify(shots(job.id))).toBe(before);
    expect((await post(job.id, "director-qa/long/run")).statusCode).toBe(200);
    await settled(job.id);
    expect(saved(job.id)!.status).toBe("complete");
  });

  test("a manual revision clears only its own film's result; a rebuild clears both; a still regeneration clears nothing", async () => {
    const { job } = seed();
    setMode("mock"); // the fallback reviewers, and a real placeholder still for the regeneration
    await g.startDirectorQaForJob(job.id, "long").done;
    await g.startDirectorQaForJob(job.id, "short").done;
    expect(saved(job.id, "long")!.status).toBe("complete");
    expect(saved(job.id, "short")!.status).toBe("complete");

    const owner = shots(job.id).find((s) => s.edit === "new" && s.truth !== "archive" && s.path?.startsWith("images/"))!;
    await g.regenerateStill(job.id, "long", owner.index); // new bytes, same presentations
    expect(saved(job.id, "long")!.status).toBe("complete");

    const edit = (kind: "long" | "short") => {
      const slot = shots(job.id, kind).findIndex((s, i) => i > 0 && !s.wantsMotion);
      return g.reviseSequenceForJob(job.id, kind, `Replace slot ${slot}.`, async (inp: any) => ({ changes: { [slot]: inp.choices.get(slot)[0] }, unresolved: [] }));
    };
    await edit("long");
    expect(saved(job.id, "long")).toBeUndefined();
    expect(saved(job.id, "short")!.status).toBe("complete");
    await g.startDirectorQaForJob(job.id, "long").done;
    await edit("short");
    expect(saved(job.id, "short")).toBeUndefined();
    expect(saved(job.id, "long")!.status).toBe("complete");
    g.clearVisualsForRebuild(job.id);
    expect(getJob(job.id)!.scratch.directorQa).toBeUndefined();
  });

  test("only the explicit in-run context keeps a film's QA state through a sequence repair", async () => {
    const { job } = seed();
    const t = target(job.id);
    const running = { long: { status: "running", phase: "repairing" } };
    const reviser = async (inp: any) => ({ changes: { [t]: inp.choices.get(t)[0] }, unresolved: [] });
    updateJob(job.id, { scratch: { ...getJob(job.id)!.scratch, directorQa: running } });
    await g.directorRepairForJob(job.id, "long", [{ slotId: t, reason: "r", instruction: "i" }], reviser, { qaRun: true });
    expect(saved(job.id)).toEqual(running.long); // a repair inside the run keeps the run's state
    await g.directorRepairForJob(job.id, "long", [{ slotId: t, reason: "r", instruction: "i" }], async (inp: any) => ({ changes: { [t]: inp.choices.get(t)[0] }, unresolved: [] }));
    expect(saved(job.id)).toBeUndefined(); // the same step called on its own is a sequence change like any other
  });

  test("while it runs, a second run (either film) and every conflicting visual action are refused", async () => {
    const { job } = seed();
    let release!: () => void;
    h.hold = new Promise((r) => (release = r));
    expect((await post(job.id, "director-qa/long/run")).statusCode).toBe(200);
    const busy = "Director QA is running. Wait for it to finish.";
    for (const [url, payload] of [
      ["director-qa/long/run", undefined],
      ["director-qa/short/run", undefined],
      ["revise-sequence", { kind: "long", directorFeedback: "Replace slot 01." }],
      ["continue", {}],
      ["rebuild-visuals", {}],
      ["regenerate-still", { kind: "long", slot: 0 }],
      ["director-qa", { kind: "short" }],
    ] as const) {
      const res = await post(job.id, url, payload);
      expect(res.statusCode).toBe(409);
      expect(res.json().error).toBe(busy);
    }
    expect(() => g.startDirectorQaForJob(job.id, "short")).toThrow(/already running/);
    release();
    await settled(job.id);
    expect(names().filter((n) => n === "director_qa")).toHaveLength(1);
  });

  test("the run refuses a bad film, and a job away from the visual preview", async () => {
    const { job } = seed();
    expect((await post(job.id, "director-qa/wide/run")).statusCode).toBe(400);
    updateJob(job.id, { state: "running" });
    expect((await post(job.id, "director-qa/long/run")).statusCode).toBe(409);
    expect(h.calls).toEqual([]);
  });
});

describe("Run Director QA on the server: mock mode", () => {
  test("the server-side chain completes with no provider call and no spend", async () => {
    const { job } = seed();
    setMode("mock");
    const run: any = await g.startDirectorQaForJob(job.id, "long").done;
    expect(h.calls).toEqual([]);
    expect(run).toMatchObject({ status: "complete", verified: true });
    expect(getJob(job.id)!.spent).toBe(1);
    expect((await pub(job.id)).directorQa.long).toEqual(run);
  });
});
