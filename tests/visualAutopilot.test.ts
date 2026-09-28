import { describe, test, expect, vi, beforeAll, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";

// The Visual Autopilot: fresh visuals -> Asset QA -> Director QA Long -> Director
// QA Short -> the existing visual approval, only when all three are clean. Every
// provider is a fake that records the order of calls; the approval and the
// worker requeue are recorded too. Nothing live runs.
const tmp = mkdtempSync(path.join(os.tmpdir(), "pb4-visual-autopilot-"));
process.env.PROVIDER_MODE = "mock";
process.env.OPENAI_API_KEY = "test-key";
process.env.PB4_DATA_DIR = path.join(tmp, "data");
process.env.PB4_MEDIA_DIR = path.join(tmp, "media");

const h = vi.hoisted(() => ({
  order: [] as string[], // "<schema>:<FILM>", "approve", "enqueue"
  answers: {} as Record<string, (o: any) => unknown>, // "<schema>:<FILM>" -> answer (an Error is thrown)
  images: 0,
  other: 0,
  approveFail: false,
}));

function passAll(o: any) {
  const ids = Object.keys(o.schema.properties.assets.properties);
  return { assets: Object.fromEntries(ids.map((id) => [id, { decision: "PASS", reason: "", repairFeedback: null }])), summary: "" };
}

vi.mock("../src/providers/openai.ts", () => ({
  respondJson: vi.fn(async (o: any) => {
    const key = `${o.schemaName}:${/FILM: (LONG|SHORT)/.exec(o.input)?.[1] ?? "?"}`;
    h.order.push(key);
    const custom = h.answers[key]?.(o);
    if (custom instanceof Error) throw custom;
    if (custom !== undefined) return custom;
    if (o.schemaName === "asset_qa") return passAll(o);
    if (o.schemaName === "director_qa") return { repairs: {}, humanReview: {}, summary: "Nothing notable." };
    if (o.schemaName === "director_verify") return { humanReview: {}, summary: "Final." };
    throw new Error(`unexpected provider call ${o.schemaName}`);
  }),
  imageMimeType: () => "image/png",
  generateImageFile: vi.fn(async () => void h.images++),
}));
vi.mock("../src/providers/runway.ts", () => ({ generateMotion: vi.fn(async () => void h.other++) }));
vi.mock("../src/production/wikimedia.ts", () => ({ fetchArchive: vi.fn(async () => (h.other++, null)) }));
vi.mock("../src/server/worker.ts", () => ({ enqueueJob: vi.fn(() => void h.order.push("enqueue")) }));
vi.mock("../src/server/store.ts", async (importOriginal) => {
  const real: any = await importOriginal();
  return {
    ...real,
    approvePreview: vi.fn((id: string) => {
      h.order.push("approve");
      if (h.approveFail) throw new Error("database is locked");
      real.approvePreview(id);
    }),
  };
});

const Fastify = (await import("fastify")).default;
const { registerRoutes } = await import("../src/server/routes.ts");
const g = await import("../src/production/generate.ts");
const v = await import("../src/production/visuals.ts");
const aq = await import("../src/production/assetQa.ts");
const dq = await import("../src/production/directorQaRun.ts");
const { enqueueJob } = await import("../src/server/worker.ts");
const { recordNarration } = await import("../src/production/narration.ts");
const { createJob, getJob, updateJob, upsertStory } = await import("../src/server/store.ts");
const { ensureStoryDirs, inStory } = await import("../src/production/paths.ts");
const { setMode } = await import("../src/server/config.ts");
const { PRICING, assetReviewUsd, round } = await import("../src/server/pricing.ts");
const { paulBunyanStory, paulBunyanResearch, paulBunyanScripts } = await import("../src/production/fixtures/paulBunyan.ts");
type Shot = import("../src/production/visuals.ts").PlannedShot;

let app: FastifyInstance;
let planned: { narration: any; plans: { long: Shot[]; short: Shot[] } };
beforeAll(async () => {
  app = Fastify();
  await registerRoutes(app);
  await app.ready();
  const slug = "visual-autopilot-plan";
  const story = { ...paulBunyanStory, id: slug, slug, title: "A Neutral Story", createdAt: new Date().toISOString() };
  ensureStoryDirs(slug);
  const narration = { long: await recordNarration(slug, "long", paulBunyanScripts.long), short: await recordNarration(slug, "short", paulBunyanScripts.short) };
  planned = { narration, plans: await v.planVisuals(story, paulBunyanResearch, paulBunyanScripts, narration) };
});
beforeEach(() => {
  h.order = [];
  h.answers = {};
  h.images = 0;
  h.other = 0;
  h.approveFail = false;
  vi.mocked(enqueueJob).mockClear();
  setMode("live");
});
afterEach(() => {
  setMode("mock");
  vi.restoreAllMocks();
});

// A job whose visuals were just acquired, at the point runJob stops at the gate.
// Every slot is its own owner still on the planner's slot grid, so the edit has
// none of the deterministic repetition patterns and Director QA can be clean.
let seq = 0;
function seed(opts: { approvedMax?: number } = {}) {
  const slug = `visual-autopilot-${seq++}`;
  const story = { ...paulBunyanStory, id: slug, slug, title: "A Neutral Story", createdAt: new Date().toISOString() };
  upsertStory(story);
  ensureStoryDirs(slug);
  writeFileSync(inStory(slug, "images/hero.png"), "master");
  const plans = structuredClone(planned.plans);
  for (const kind of ["long", "short"] as const) {
    plans[kind] = plans[kind].map((s): Shot => {
      const own = { ...s, edit: "new", assetId: `${kind === "long" ? "L" : "S"}${String(s.index).padStart(2, "0")}`, presentation: "base", framing: "wide", path: `images/${kind}-${String(s.index).padStart(2, "0")}.png`, mediaType: "image" } as Shot;
      delete own.assetShot;
      delete own.focus;
      writeFileSync(inStory(slug, own.path!), `still ${kind} ${s.index}`);
      return own;
    });
  }
  const job = createJob({ id: g.newJobId(), storyId: story.id, mock: false, estimatedCost: 5, approvedMax: opts.approvedMax ?? 10 });
  const scratch = { research: paulBunyanResearch, scripts: paulBunyanScripts, textApproved: true, narration: planned.narration, masterRef: "images/hero.png", spent: 1, longShots: plans.long, shortShots: plans.short };
  updateJob(job.id, { scratch: scratch as any, spent: 1, state: "queued", step: "queued", previewApproved: false });
  return { job, story, slug };
}
// Production reaches the gate naturally: runJob acquires nothing new here and
// reports the fresh preview gate, as the worker sees it.
async function atGate(opts: { approvedMax?: number } = {}) {
  const s = seed(opts);
  expect(await g.runJob(s.job.id)).toBe("preview_gate");
  return s;
}
const scratchOf = (id: string) => getJob(id)!.scratch as any;
const assetCalls = (film: "LONG" | "SHORT") => h.order.filter((o) => o === `asset_qa:${film}`);
const batches = (n: number) => Math.ceil(n / aq.ASSET_QA_BATCH);
const expectedOrder = (id: string) => [
  ...Array(batches(scratchOf(id).longShots.length)).fill("asset_qa:LONG"),
  ...Array(batches(scratchOf(id).shortShots.length)).fill("asset_qa:SHORT"),
  "director_qa:LONG",
  "director_verify:LONG",
  "director_qa:SHORT",
  "director_verify:SHORT",
  "approve",
  "enqueue",
];
const assetSpend = (id: string) =>
  (["longShots", "shortShots"] as const).reduce((sum, k) => sum + aq.chunk(scratchOf(id)[k] as unknown[]).reduce((s, b) => s + assetReviewUsd(b.length), 0), 0);
const quiet = () => vi.spyOn(console, "error").mockImplementation(() => {});

describe("Visual Autopilot: the clean path", () => {
  test("Asset QA, Long QA, Short QA, then the existing approval and requeue, once each and in that order", async () => {
    const { job } = await atGate();
    expect(await g.autoVisualQaForJob(job.id, enqueueJob)).toBe("approved");
    expect(h.order).toEqual(expectedOrder(job.id));
    expect(enqueueJob).toHaveBeenCalledOnce();
    expect(enqueueJob).toHaveBeenCalledWith(job.id);
    const after = getJob(job.id)!;
    expect(after.previewApproved).toBe(true);
    expect(after.state).toBe("awaiting_preview"); // the worker resumes it, exactly as after Continue
    expect(scratchOf(job.id).assetQa).toMatchObject({ status: "done", clean: true });
    expect(scratchOf(job.id).directorQa.long).toMatchObject({ status: "complete", clean: true });
    expect(scratchOf(job.id).directorQa.short).toMatchObject({ status: "complete", clean: true });
    // No extra call: only the existing stages, at their existing prices.
    expect(after.spent).toBeCloseTo(round(1 + assetSpend(job.id) + 4 * PRICING.openai.visualPlan));
    expect(h.images + h.other).toBe(0);
    expect(g.visualAutopilotState(job.id)).toEqual({ status: "passed" });
  });

  test("the approval is the same one manual Continue makes: the same saved job and the same requeue", async () => {
    const auto = await atGate();
    await g.autoVisualQaForJob(auto.job.id, enqueueJob);
    const manual = await atGate();
    await g.autoAssetQaForJob(manual.job.id);
    await g.startDirectorQaForJob(manual.job.id, "long").done;
    await g.startDirectorQaForJob(manual.job.id, "short").done;
    h.order = [];
    const res = await app.inject({ method: "POST", url: `/api/jobs/${manual.job.id}/continue` });
    expect(res.statusCode).toBe(200);
    expect(h.order).toEqual(["approve", "enqueue"]);
    const pick = (id: string) => {
      const j = getJob(id)!;
      return { state: j.state, step: j.step, previewApproved: j.previewApproved, message: j.message, error: j.error, spent: j.spent, qa: [scratchOf(id).assetQa.clean, scratchOf(id).directorQa.long.clean, scratchOf(id).directorQa.short.clean] };
    };
    expect(pick(auto.job.id)).toEqual(pick(manual.job.id));
    expect(vi.mocked(enqueueJob).mock.calls).toEqual([[auto.job.id], [manual.job.id]]);
  });

  test("the page shows the passed line while production continues", async () => {
    const { job } = await atGate();
    await g.autoVisualQaForJob(job.id, enqueueJob);
    updateJob(job.id, { state: "running", step: "build" }); // the worker picked it up
    const pub = (await app.inject({ method: "GET", url: `/api/jobs/${job.id}` })).json().job;
    expect(pub.visualAutopilot).toEqual({ status: "passed" });
    const React = (await import("react")).default;
    const { renderToStaticMarkup } = await import("react-dom/server");
    const { CreatingProgress } = await import("../src/app/screens/Creating.tsx");
    expect(renderToStaticMarkup(React.createElement(CreatingProgress, { job: pub }))).toContain("Visual QA passed. Continuing production…");
  });

  test("mock mode runs the whole chain with no provider or media call, and approves", async () => {
    const { job } = await atGate();
    setMode("mock");
    expect(await g.autoVisualQaForJob(job.id, enqueueJob)).toBe("approved");
    expect(h.order).toEqual(["approve", "enqueue"]);
    expect(h.images + h.other).toBe(0);
    expect(getJob(job.id)!.spent).toBe(1);
    expect(getJob(job.id)!.previewApproved).toBe(true);
  });
});

describe("Director QA clean describes the final saved film", () => {
  const cleanNone = { ran: false, changed: [], unresolved: [], remaining: [] };
  const verified = { summary: "Final.", humanReview: [], patterns: [] };
  const review = (over: Record<string, unknown> = {}) => ({ summary: "Initial.", repairs: [], humanReview: [], ...over }) as any;
  const result = (over: Record<string, unknown>) => dq.directorQaResult({ status: "complete", qa: review(), repair: null, cleanup: cleanNone, coordinated: null, verify: verified, ...over } as any);

  test("1. no repairs, verified, no exceptions: clean", () => {
    expect(result({})).toMatchObject({ clean: true, automaticChanges: 0, cleanupChanges: 0, coordinatedChanges: 0 });
  });
  test("2. a successful Director repair, verified, no exceptions: clean (the change is informational)", () => {
    expect(result({ qa: review({ repairs: [{ slotId: 4, reason: "r", instruction: "i" }] }), repair: { changed: [4, 5, 9, 12, 20], unresolved: [] } })).toMatchObject({ clean: true, automaticChanges: 5 });
  });
  test("3. a successful cleanup, verified, no exceptions: clean", () => {
    expect(result({ cleanup: { ran: true, changed: [7, 11], unresolved: [], remaining: [] } })).toMatchObject({ clean: true, cleanupChanges: 2 });
  });
  test("4. a successful coordinated repair, verified, no exceptions: clean (the example from the brief)", () => {
    const r = result({
      qa: review({ repairs: [{ slotId: 6, reason: "r", instruction: "i" }] }),
      repair: { changed: [1, 2, 3, 4, 5], unresolved: [{ slotId: 6, reason: "No legal alternative existing presentation is available." }] },
      cleanup: { ran: true, changed: [8, 9], unresolved: [], remaining: [] },
      coordinated: { target: 6, changed: [6], humanReview: [], remaining: [] },
    });
    expect(r).toMatchObject({ clean: true, automaticChanges: 5, cleanupChanges: 2, coordinatedChanges: 1, unresolvedRepairs: [], humanReview: [], verified: true });
  });
  test("5. a human-review finding: not clean", () => {
    expect(result({ verify: { ...verified, humanReview: [{ slotId: 3, reason: "the graphic shows a later vote" }] } }).clean).toBe(false);
    expect(result({ verify: { ...verified, patterns: [{ slotId: 3, reason: "ADJACENT REUSE remains." }] } }).clean).toBe(false);
  });
  test("6. an unresolved repair: not clean", () => {
    expect(result({ repair: { changed: [], unresolved: [{ slotId: 6, reason: "No legal alternative existing presentation is available." }] } })).toMatchObject({ clean: false, unresolvedRepairs: [{ slotId: 6 }] });
  });
  test("7. a failed final verification (or none): not clean", () => {
    expect(result({ verify: { summary: "", humanReview: [], patterns: [], error: "OpenAI responses 500" } }).clean).toBe(false);
    expect(result({ verify: null }).clean).toBe(false);
  });
  test("the panel still says no repair was needed only when nothing changed", async () => {
    const React = (await import("react")).default;
    const { renderToStaticMarkup } = await import("react-dom/server");
    const { DirectorBoardView } = await import("../src/app/visualReview/DirectorBoard.tsx");
    const { buildDirectorBoard } = await import("../src/app/visualReview/board.ts");
    const { buildFilm } = await import("../src/app/visualReview/model.ts");
    const preview = v.buildPreview({ slug: "x" } as any, structuredClone(planned.plans.long), []);
    const html = (run: any) =>
      renderToStaticMarkup(React.createElement(DirectorBoardView, { board: buildDirectorBoard(buildFilm(preview, "long")), storyTitle: "T", version: 0, dispatch: vi.fn(), filter: "all", onFilter: vi.fn(), copy: { kind: "idle" }, onCopy: vi.fn(), qa: { run: { status: "complete", ...run }, onRun: vi.fn(), onSlot: vi.fn() } } as any)).replace(/<!-- -->/g, "");
    const repaired = html(result({ repair: { changed: [4, 5], unresolved: [] } }));
    expect(repaired).toContain("Automatic Director changes: 2");
    expect(repaired).toContain("Needs human review: 0");
    expect(repaired).not.toContain("No automatic sequence repair was needed.");
    expect(html(result({}))).toContain("No automatic sequence repair was needed.");
  });

  test("8. a failed Director repair, cleanup or coordinated repair: not clean", () => {
    const repairs = [{ slotId: 2, reason: "r", instruction: "i" }];
    expect(dq.directorQaResult({ status: "repairFailed", error: "Invalid edit plan", qa: review({ repairs }), cleanup: cleanNone, coordinated: null, verify: verified } as any).clean).toBe(false);
    expect(result({ cleanup: { ...cleanNone, ran: true, error: "Invalid edit plan" } }).clean).toBe(false);
    expect(result({ coordinated: { target: 6, changed: [], humanReview: [], remaining: [], error: "Invalid edit plan" } }).clean).toBe(false);
  });
});

describe("Visual Autopilot: a film Director QA repaired", () => {
  test("a Long repaired automatically and finally verified clean is approved; calls and cost are the existing ones", async () => {
    const { job } = await atGate();
    const long = scratchOf(job.id).longShots as Shot[];
    const t = long.findIndex((s) => s.startSec > 20 && !s.wantsMotion);
    let picked = "";
    h.answers["director_qa:LONG"] = () => ({ repairs: { [t]: { reason: "The visual does not show the vote.", instruction: "Show the chamber instead." } }, humanReview: {}, summary: "One fix." });
    // A legal existing presentation from well away from the slot, so the repair leaves no repetition pattern behind.
    h.answers["sequence_revision:LONG"] = (o) => {
      picked = o.schema.properties.changes.properties[t].enum.find((id: string | null) => id && Number(id.slice(1, 3)) >= t + 6);
      return { changes: { [t]: picked }, unresolved: [] };
    };
    expect(await g.autoVisualQaForJob(job.id, enqueueJob)).toBe("approved");
    expect(`${scratchOf(job.id).longShots[t].assetId}:base`).toBe(picked);
    expect(scratchOf(job.id).directorQa.long).toMatchObject({ status: "complete", clean: true, automaticChanges: 1, unresolvedRepairs: [], humanReview: [], verified: true });
    expect(h.order.filter((o) => o.startsWith("director_") || o.startsWith("sequence_"))).toEqual(["director_qa:LONG", "sequence_revision:LONG", "director_verify:LONG", "director_qa:SHORT", "director_verify:SHORT"]);
    expect(h.order.slice(-2)).toEqual(["approve", "enqueue"]);
    expect(getJob(job.id)!.spent).toBeCloseTo(round(1 + assetSpend(job.id) + 5 * PRICING.openai.visualPlan));
    expect(getJob(job.id)!.previewApproved).toBe(true);
  });
});

describe("Visual Autopilot: Asset QA stops the chain", () => {
  test("an asset exception: no Sequence QA, no approval, the job waits at Visual Review", async () => {
    const { job } = await atGate();
    h.answers["asset_qa:LONG"] = (o) => ({ ...passAll(o), assets: { ...passAll(o).assets, L00: { decision: "HUMAN_REVIEW", reason: "Unsupported lettering.", repairFeedback: null } } });
    expect(await g.autoVisualQaForJob(job.id, enqueueJob)).toBe("stopped");
    expect(h.order.every((o) => o.startsWith("asset_qa:"))).toBe(true);
    expect(scratchOf(job.id).directorQa).toBeUndefined();
    expect(getJob(job.id)!.previewApproved).toBe(false);
    expect(enqueueJob).not.toHaveBeenCalled();
    expect(g.visualAutopilotState(job.id)).toBeUndefined();
  });

  test("a failed Asset QA review: no Sequence QA, no approval", async () => {
    const { job } = await atGate();
    quiet();
    h.answers["asset_qa:SHORT"] = () => new Error("OpenAI responses 500");
    expect(await g.autoVisualQaForJob(job.id, enqueueJob)).toBe("stopped");
    expect(scratchOf(job.id).assetQa).toMatchObject({ clean: false, incomplete: scratchOf(job.id).shortShots.length });
    expect(h.order.some((o) => o.startsWith("director_"))).toBe(false);
    expect(h.order).not.toContain("approve");
  });

  test("an interrupted (or any earlier) Asset QA: the chain starts nothing at all", async () => {
    const { job } = await atGate();
    updateJob(job.id, { scratch: { ...scratchOf(job.id), assetQa: { status: "started" } } });
    expect(await g.autoVisualQaForJob(job.id, enqueueJob)).toBeUndefined();
    expect(h.order).toEqual([]);
  });
});

describe("Visual Autopilot: the sequence stages", () => {
  test("Long with human exceptions still runs Short, so every exception arrives in one stop; no approval", async () => {
    const { job } = await atGate();
    h.answers["director_verify:LONG"] = () => ({ humanReview: { 3: "The graphic shows a later vote." }, summary: "One mismatch." });
    expect(await g.autoVisualQaForJob(job.id, enqueueJob)).toBe("stopped");
    expect(h.order.filter((o) => o.startsWith("director_"))).toEqual(["director_qa:LONG", "director_verify:LONG", "director_qa:SHORT", "director_verify:SHORT"]);
    expect(scratchOf(job.id).directorQa.long).toMatchObject({ status: "complete", clean: false, humanReview: [{ slotId: 3, reason: "The graphic shows a later vote." }] });
    expect(scratchOf(job.id).directorQa.short).toMatchObject({ status: "complete", clean: true });
    expect(h.order).not.toContain("approve");
    const pub = (await app.inject({ method: "GET", url: `/api/jobs/${job.id}` })).json().job;
    expect(pub.directorQa.long.humanReview).toHaveLength(1);
    expect(pub.directorQa.short.clean).toBe(true);
    expect(pub.visualAutopilot).toBeUndefined();
  });

  test("a failed Long QA stops before any more paid QA: no Short, no approval", async () => {
    const { job } = await atGate();
    quiet();
    h.answers["director_qa:LONG"] = () => new Error("OpenAI responses 500");
    expect(await g.autoVisualQaForJob(job.id, enqueueJob)).toBe("stopped");
    expect(scratchOf(job.id).directorQa.long).toEqual({ status: "failed", error: "OpenAI responses 500" });
    expect(h.order.some((o) => o.endsWith(":SHORT") && o.startsWith("director_"))).toBe(false);
    expect(h.order).not.toContain("approve");
  });

  test("an interrupted Long result is never treated as done: no Short, no approval", async () => {
    const { job } = await atGate();
    updateJob(job.id, { scratch: { ...scratchOf(job.id), directorQa: { long: { status: "running", phase: "cleaning" } } } });
    expect(await g.autoVisualQaForJob(job.id, enqueueJob)).toBe("stopped");
    expect(h.order.some((o) => o.startsWith("director_"))).toBe(false); // Long is not started again
    expect(h.order).not.toContain("approve");
  });

  test("Short with human exceptions: no approval", async () => {
    const { job } = await atGate();
    h.answers["director_verify:SHORT"] = () => ({ humanReview: { 1: "Needs the image." }, summary: "" });
    expect(await g.autoVisualQaForJob(job.id, enqueueJob)).toBe("stopped");
    expect(scratchOf(job.id).directorQa.short).toMatchObject({ status: "complete", clean: false });
    expect(h.order).not.toContain("approve");
    expect(enqueueJob).not.toHaveBeenCalled();
  });

  test("a failed Short QA: no approval", async () => {
    const { job } = await atGate();
    quiet();
    h.answers["director_qa:SHORT"] = () => new Error("OpenAI responses 503");
    expect(await g.autoVisualQaForJob(job.id, enqueueJob)).toBe("stopped");
    expect(scratchOf(job.id).directorQa.short.status).toBe("failed");
    expect(h.order).not.toContain("approve");
  });

  test("the spend cap stops a stage before its call; nothing approves", async () => {
    const probe = await atGate();
    const cap = round(1 + assetSpend(probe.job.id) + 0.04); // Asset QA fits; the Long review ($0.05) does not
    const { job } = await atGate({ approvedMax: cap });
    quiet();
    expect(await g.autoVisualQaForJob(job.id, enqueueJob)).toBe("stopped");
    expect(scratchOf(job.id).directorQa.long.status).toBe("failed");
    expect(scratchOf(job.id).directorQa.long.error).toMatch(/Approved maximum/);
    expect(h.order.some((o) => o.startsWith("director_"))).toBe(false);
    expect(getJob(job.id)!.approvedMax).toBe(cap); // never raised
    expect(h.order).not.toContain("approve");
  });
});

describe("Visual Autopilot: safety", () => {
  test("a stale clean result never counts: a manual Long revision after a clean run makes the gate unclean", async () => {
    const { job } = await atGate();
    setMode("mock");
    await g.autoAssetQaForJob(job.id);
    await g.startDirectorQaForJob(job.id, "long").done;
    await g.startDirectorQaForJob(job.id, "short").done;
    expect(g.visualGateClean(job.id)).toBe(true);
    const slot = scratchOf(job.id).longShots.findIndex((s: Shot, i: number) => i > 0 && !s.wantsMotion);
    await g.reviseSequenceForJob(job.id, "long", `Replace slot ${slot}.`, async (inp: any) => ({ changes: { [slot]: inp.choices.get(slot)[0] }, unresolved: [] }));
    expect(scratchOf(job.id).directorQa.long).toBeUndefined();
    expect(g.visualGateClean(job.id)).toBe(false);
    // And the Autopilot never restarts on reviewed visuals, so it cannot approve them.
    expect(await g.autoVisualQaForJob(job.id, enqueueJob)).toBeUndefined();
    expect(h.order).not.toContain("approve");
  });

  test("repeat notices start nothing twice: one Asset QA, one Long, one Short, one approval", async () => {
    const { job } = await atGate();
    const [a, b] = await Promise.all([g.autoVisualQaForJob(job.id, enqueueJob), g.autoVisualQaForJob(job.id, enqueueJob)]);
    expect([a, b].sort()).toEqual(["approved", undefined].sort());
    expect(await g.autoVisualQaForJob(job.id, enqueueJob)).toBeUndefined();
    expect(h.order).toEqual(expectedOrder(job.id));
  });

  test("a failed approval is not retried: the job stays at the valid visual gate and manual Continue still works", async () => {
    const { job } = await atGate();
    const log = quiet();
    h.approveFail = true;
    expect(await g.autoVisualQaForJob(job.id, enqueueJob)).toBe("stopped");
    expect(h.order.filter((o) => o === "approve")).toHaveLength(1);
    expect(enqueueJob).not.toHaveBeenCalled();
    expect(getJob(job.id)!.state).toBe("awaiting_preview");
    expect(getJob(job.id)!.previewApproved).toBe(false);
    expect(log.mock.calls.map((c) => c[0])).toEqual([`Visual Autopilot failed job=${job.id} stage=continue error=database is locked`]);
    const pub = (await app.inject({ method: "GET", url: `/api/jobs/${job.id}` })).json().job;
    expect(pub.visualAutopilot).toEqual({ status: "failed", error: "database is locked" });
    h.approveFail = false;
    expect((await app.inject({ method: "POST", url: `/api/jobs/${job.id}/continue` })).statusCode).toBe(200);
    expect(getJob(job.id)!.previewApproved).toBe(true);
  });

  test("the chain needs no page: no request is made from acquisition to approval", async () => {
    const inject = vi.spyOn(app, "inject");
    const { job } = await atGate();
    expect(await g.autoVisualQaForJob(job.id, enqueueJob)).toBe("approved");
    expect(inject).not.toHaveBeenCalled();
  });

  test("reading an old job at the visual preview starts nothing and spends nothing", async () => {
    const { job } = seed();
    updateJob(job.id, { state: "awaiting_preview", step: "preview", preview: v.buildPreview({ slug: "x" } as any, scratchOf(job.id).longShots, scratchOf(job.id).shortShots) });
    for (let i = 0; i < 3; i++) expect((await app.inject({ method: "GET", url: `/api/jobs/${job.id}` })).statusCode).toBe(200);
    expect(h.order).toEqual([]);
    expect(getJob(job.id)!.spent).toBe(1);
  });

  test("while the Autopilot is reviewing, the page shows its phase instead of the review", async () => {
    const React = (await import("react")).default;
    const { renderToStaticMarkup } = await import("react-dom/server");
    const { CreatingProgress } = await import("../src/app/screens/Creating.tsx");
    const base = { state: "awaiting_preview", step: "preview", visualAutopilot: { status: "running" } } as any;
    const long = renderToStaticMarkup(React.createElement(CreatingProgress, { job: { ...base, directorQa: { long: { status: "running", phase: "reviewing" } } } })).replace(/<!-- -->/g, "");
    expect(long).toContain("Reviewing Long sequence…");
    expect(long).toContain('aria-label="Visual QA"');
    const short = renderToStaticMarkup(React.createElement(CreatingProgress, { job: { ...base, directorQa: { long: { status: "complete" }, short: { status: "running", phase: "verifying" } } } })).replace(/<!-- -->/g, "");
    expect(short).toContain("Reviewing Short sequence…");
    const assets = renderToStaticMarkup(React.createElement(CreatingProgress, { job: { ...base, assetQa: { status: "running", phase: "review" } } })).replace(/<!-- -->/g, "");
    expect(assets).toContain("Inspecting visual assets…");
  });

  test("Visual Review names each film's Director QA state beside the Asset QA result", async () => {
    const React = (await import("react")).default;
    const { renderToStaticMarkup } = await import("react-dom/server");
    const { VisualQaSummary } = await import("../src/app/visualReview/AssetQaNotice.tsx");
    const html = renderToStaticMarkup(
      React.createElement(VisualQaSummary, {
        runs: { long: { status: "complete", humanReview: [{ slotId: 3, reason: "x" }, { slotId: 5, reason: "y" }], clean: false } as any, short: { status: "failed", error: "e" } },
        dispatch: vi.fn(),
      }),
    ).replace(/<!-- -->/g, "");
    expect(html).toContain("Long Director QA</span> Needs human review: 2");
    expect(html).toContain("Short Director QA</span> Failed");
    expect(html.match(/Open board/g)).toHaveLength(2);
    const failed = renderToStaticMarkup(React.createElement(VisualQaSummary, { pilot: { status: "failed", error: "database is locked" }, dispatch: vi.fn() }));
    expect(failed).toContain("the automatic approval could not continue: database is locked Continue remains available.");
    expect(renderToStaticMarkup(React.createElement(VisualQaSummary, { dispatch: vi.fn() }))).toBe("");
  });
});
