import { describe, test, expect, vi, beforeEach } from "vitest";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";

// Stage 14B: Final-film QC in the real production path. Each job goes the normal
// way (text gate, visual gate, motion, render) in mock mode; the render stub then
// switches PB4 to live, so the finish runs exactly as a live production does. No
// provider is reached: renderFilms, probeVideo and the frame sampler are stubbed,
// and respondJson answers each Final-film QC specialist from the test. A
// "crash" is the job row as it was saved when a specialist was called, restored
// and resumed the way the worker resumes a job after a restart.
const tmp = mkdtempSync(path.join(os.tmpdir(), "pb4-final-gate-"));
process.env.PROVIDER_MODE = "mock";
process.env.PB4_DATA_DIR = path.join(tmp, "data");
process.env.PB4_MEDIA_DIR = path.join(tmp, "media");
process.env.OPENAI_API_KEY = "test-key"; // fetch is always stubbed: nothing reaches OpenAI

type Label = "long-factual" | "long-visual" | "short-factual" | "short-visual";
type Answer = "PASS" | "HUMAN_REVIEW" | "malformed" | "down" | "crash" | "network" | "http" | "non-json" | "no-output";

const h = vi.hoisted(() => ({
  jobId: "",
  liveAfterRender: true,
  renders: 0,
  plans: {} as Record<string, { kind: string; width: number; height: number; fps: number; durationInFrames: number }>,
  probed: [] as string[],
  broken: {} as Record<string, Record<string, unknown>>,
  missing: null as string | null,
  samplings: [] as string[],
  answers: {} as Record<string, Answer>,
  calls: [] as { label: string; opts: any; spent: number; saved: string[] }[],
  snapshot: null as any,
  persisted: [] as [number, number][], // [spent, saved specialist results] after each job update
}));

vi.mock("../src/render/renderVideo.ts", async (orig) => ({
  ...(await orig<typeof import("../src/render/renderVideo.ts")>()),
  renderFilms: vi.fn(async (_dir: string, films: Array<{ plan: any; outPath: string }>) => {
    h.renders++;
    for (const f of films) h.plans[f.outPath] = f.plan;
    const { config } = await import("../src/server/config.ts");
    if (h.liveAfterRender) config.mode = "live";
  }),
  probeVideo: vi.fn((file: string) => {
    const p = h.plans[file];
    if (!p || h.missing === p.kind) throw new Error(`ffprobe: ${file}: No such file or directory`);
    h.probed.push(p.kind);
    return { width: p.width, height: p.height, durationSec: p.durationInFrames / p.fps + 0.03, fps: 30, hasAudio: true, ...h.broken[p.kind] };
  }),
}));

vi.mock("../src/production/mockAssets.ts", async (orig) => {
  const { mkdirSync, writeFileSync } = await import("node:fs");
  const nodePath = await import("node:path");
  return {
    ...(await orig<typeof import("../src/production/mockAssets.ts")>()),
    writePlaceholderStill: (outPath: string) => {
      mkdirSync(nodePath.dirname(outPath), { recursive: true });
      writeFileSync(outPath, "img");
    },
  };
});

vi.mock("../src/render/contactSheet.ts", async (orig) => ({
  ...(await orig<typeof import("../src/render/contactSheet.ts")>()),
  sampledFrames: (videoPath: string, kind: "long" | "short") => {
    h.samplings.push(kind);
    return Array.from({ length: kind === "long" ? 24 : 12 }, (_, i) => ({ cell: i + 1, timeSec: i + 0.5, jpeg: Buffer.from([0xff, 0xd8, 0xff]) }));
  },
}));

// Every persisted state of the job under test, read back after each update: the
// spend and the saved specialist results as the database held them together.
vi.mock("../src/server/store.ts", async (orig) => {
  const real = await orig<typeof import("../src/server/store.ts")>();
  return {
    ...real,
    updateJob: (id: string, patch: any) => {
      real.updateJob(id, patch);
      const qa = (real.getJob(id)?.scratch as any)?.finalFilmQa;
      if (id === h.jobId && qa) h.persisted.push([real.getJob(id)!.spent, ["long", "short"].flatMap((k) => ["factual", "visual"].filter((s) => qa[k]?.[s])).length]);
    },
  };
});

// One answer per specialist, valid against the exact claims and cells it was sent,
// served over a stubbed fetch through the REAL respondJson, so parsing is real.
// Wire failures: "non-json" / "no-output" (a successful response with unusable
// output), "network" (fetch throws) and "http" (a non-success status).
vi.mock("../src/providers/openai.ts", async (orig) => {
  const real = await orig<typeof import("../src/providers/openai.ts")>();
  const wire = async (opts: any, reply: () => Promise<unknown>) => {
    vi.stubGlobal("fetch", vi.fn(reply));
    try {
      return await real.respondJson(opts);
    } finally {
      vi.unstubAllGlobals();
    }
  };
  const ok = (body: unknown) => async () => ({ ok: true, status: 200, json: async () => body });
  return {
  ...real,
  respondJson: vi.fn(async (opts: any) => {
    const { getJob } = await import("../src/server/store.ts");
    const { causalClaims } = await import("../src/production/finalFilmQa.ts");
    const kind = /FILM: LONG/.test(opts.input) ? "long" : "short";
    const specialist = opts.schemaName === "final_film_factual_audit" ? "factual" : "visual";
    const label = `${kind}-${specialist}`;
    const job = getJob(h.jobId)!;
    const qa = (job.scratch as any).finalFilmQa;
    const saved = ["long", "short"].flatMap((k) => ["factual", "visual"].filter((s) => qa?.[k]?.[s]).map((s) => `${k}-${s}`));
    h.calls.push({ label, opts, spent: job.spent, saved });
    const answer = h.answers[label] ?? "PASS";
    if (answer === "crash") {
      h.snapshot = job; // what a crash during this call leaves in the database
      throw new Error("process killed");
    }
    if (answer === "down") throw new Error("OpenAI responses 503: provider down");
    if (answer === "network") return wire(opts, async () => Promise.reject(new TypeError("fetch failed")));
    if (answer === "http") return wire(opts, async () => ({ ok: false, status: 500, text: async () => "server error" }));
    if (answer === "non-json") return wire(opts, ok({ output_text: "I could not complete this review." }));
    if (answer === "no-output") return wire(opts, ok({ output: [] }));
    if (answer === "malformed") return wire(opts, ok({ output_text: JSON.stringify({ decision: "PASS" }) }));
    const review = answer === "HUMAN_REVIEW";
    const text = (body: unknown) => wire(opts, ok({ output_text: JSON.stringify(body) }));
    if (specialist === "factual") {
      const checks = causalClaims((job.scratch as any).scripts[kind]).map((c) => ({ text: c.text, verdict: "SUPPORTED_DIRECTLY", reason: "The sources state it.", evidenceUrls: ["https://example.org/source"] }));
      const issues = review ? [{ reason: `The ${kind} narration overstates why it ended.`, text: `${kind} fragment` }] : [];
      return text({ causalChecks: checks, issues, decision: answer, summary: `private factual summary ${kind}` });
    }
    const cells = opts.images.length;
    const cellObservations = Array.from({ length: cells }, (_, i) => ({ cell: i + 1, description: "a barn beside a frozen lake" }));
    const families = review ? [{ name: "burning barn", description: "the same barn fire", cells: [1, 2, cells] }] : [];
    const issues = review ? [{ reason: `A burning barn keeps returning across the ${kind}.`, cells: [1, cells] }] : [];
    return text({ cellObservations, families, issues, decision: answer, summary: `private visual summary ${kind}` });
  }),
  };
});

const { runJob, newJobId, approveTextForJob, approveVisualsForJob, raiseApprovedMax, acceptFinalForJob } = await import("../src/production/generate.ts");
const store = await import("../src/server/store.ts");
const { createJob, getJob, updateJob, upsertStory, videosForStory, resumableJobIds, addVideos } = store;
const { config } = await import("../src/server/config.ts");
const { PRICING, round } = await import("../src/server/pricing.ts");
const { FINAL_VISUAL_QA_MODEL } = await import("../src/production/finalFilmQa.ts");
const { paulBunyanStory } = await import("../src/production/fixtures/paulBunyan.ts");
const Fastify = (await import("fastify")).default;
const { registerRoutes } = await import("../src/server/routes.ts");

const ORDER: Label[] = ["long-factual", "long-visual", "short-factual", "short-visual"];
const FACT = PRICING.openai.finalFactualReview;
const LOOK = PRICING.openai.finalVisualReview;
const story = { ...paulBunyanStory, createdAt: new Date().toISOString() };
upsertStory(story);

const labels = () => h.calls.map((c) => c.label);
const jobVideos = (id: string) => videosForStory(story.id).filter((v) => v.jobId === id);
const qaOf = (id: string) => (getJob(id)!.scratch as any).finalFilmQa;

beforeEach(() => {
  config.mode = "mock";
  h.liveAfterRender = true;
  h.renders = 0;
  h.probed = [];
  h.broken = {};
  h.missing = null;
  h.samplings = [];
  h.answers = {};
  h.calls = [];
  h.snapshot = null;
  h.persisted = [];
});

// A fresh job taken the normal way to its render: the text gate and the visual
// gate are approved as a person (or the autopilot) would, so a later resume by
// the worker (runJob with no options) behaves exactly like production.
async function produce(approvedMax = 5): Promise<{ id: string; finish: Promise<unknown> }> {
  config.mode = "mock"; // everything before the finish costs nothing
  const job = createJob({ id: newJobId(), storyId: story.id, mock: false, estimatedCost: 5, approvedMax });
  h.jobId = job.id;
  await runJob(job.id); // text gate
  approveTextForJob(job.id);
  await runJob(job.id); // visual gate
  approveVisualsForJob(job.id);
  return { id: job.id, finish: runJob(job.id) }; // motion, render, then the finish (live)
}

// The worker resuming the job after a restart: the row as the crash left it.
async function restartFromSnapshot(): Promise<void> {
  expect(h.snapshot).toBeTruthy();
  updateJob(h.snapshot.id, { ...h.snapshot });
  expect(getJob(h.snapshot.id)!.state).toBe("running");
  expect(resumableJobIds()).toContain(h.snapshot.id);
  h.calls = [];
  await runJob(h.snapshot.id);
}

async function waitFor(id: string, state: string): Promise<void> {
  for (let i = 0; i < 200 && getJob(id)!.state !== state; i++) await new Promise((r) => setTimeout(r, 10));
  expect(getJob(id)!.state).toBe(state);
}

describe("Final-film QC in production: the four specialists", () => {
  test("29. every specialist runs exactly once, even after a HUMAN_REVIEW; issues wait at awaiting_final with nothing registered", async () => {
    h.answers = { "long-factual": "HUMAN_REVIEW", "long-visual": "PASS", "short-factual": "PASS", "short-visual": "HUMAN_REVIEW" };
    const { id, finish } = await produce();
    await finish;

    expect(labels()).toEqual(ORDER);
    const job = getJob(id)!;
    expect([job.state, job.step, job.message]).toEqual(["awaiting_final", "finishing", "Final films need review"]);
    expect(job.error).toBeNull();
    expect(jobVideos(id)).toEqual([]);
    expect(job.spent).toBe(round(2 * (FACT + LOOK)));
    expect(h.renders).toBe(1);

    const { finalQaState } = await import("../src/production/generate.ts");
    expect(finalQaState(job.scratch)).toEqual({
      issues: [
        { film: "long", area: "fact", reason: "The long narration overstates why it ended.", text: "long fragment" },
        { film: "short", area: "visual", reason: "A burning barn keeps returning across the short." },
      ],
    });
  });

  test("the factual specialist keeps the configured model with web search and no image; the visual one is GPT-6 Astra at high reasoning", async () => {
    const { finish } = await produce();
    await finish;
    for (const c of h.calls.filter((c) => c.label.endsWith("factual"))) {
      expect(c.opts.webSearch).toBe(true);
      expect(c.opts.images).toBeUndefined();
      expect(c.opts.model).toBeUndefined(); // respondJson falls back to config.openai.model
      expect(c.opts.reasoning).toBeUndefined();
    }
    for (const c of h.calls.filter((c) => c.label.endsWith("visual"))) {
      expect(c.opts.model).toBe(FINAL_VISUAL_QA_MODEL);
      expect(FINAL_VISUAL_QA_MODEL).toBe("gpt-6-astra");
      expect(c.opts.reasoning).toEqual({ effort: "high" });
      expect(c.opts.webSearch).toBeFalsy();
      expect(c.opts.images).toHaveLength(c.label === "long-visual" ? 24 : 12);
    }
    expect(h.samplings).toEqual(["long", "short"]); // the finished mp4s, once each
  });

  test("30. all four PASS: four calls, the pair registered together, done, Ready unchanged", async () => {
    const { id, finish } = await produce();
    await finish;

    expect(labels()).toEqual(ORDER);
    const job = getJob(id)!;
    expect([job.state, job.step, job.message]).toEqual(["done", "finishing", "Finished"]);
    expect(jobVideos(id).map((v) => v.kind).sort()).toEqual(["long", "short"]);
    expect(job.spent).toBe(round(2 * (FACT + LOOK)));
    const { latestCompletePair } = await import("../src/app/productionStage.ts");
    expect(latestCompletePair(videosForStory(story.id), id)?.jobId).toBe(id);
  });

  test("technical validation runs before any specialist; outputsValidated is saved before the first paid call", async () => {
    const { id, finish } = await produce();
    await finish;
    expect(h.probed).toEqual(["long", "short"]);
    expect(h.calls[0].label).toBe("long-factual");
    expect(h.calls[0].saved).toEqual([]);
    expect(qaOf(id).outputsValidated).toBe(true);
  });

  test("a broken film fails the job before any specialist and nothing is marked validated", async () => {
    h.broken = { short: { hasAudio: false } };
    const { id, finish } = await produce();
    await expect(finish).rejects.toThrow("Final file check failed for Short: audio stream is missing.");
    expect(h.calls).toEqual([]);
    expect(qaOf(id)).toBeUndefined(); // a Retry renders again, as before Stage 14B
    expect(jobVideos(id)).toEqual([]);
  });
});

describe("Final-film QC in production: paid calls and incremental persistence", () => {
  test("each valid result is saved with its charge before the next specialist starts", async () => {
    const { id, finish } = await produce();
    await finish;
    expect(h.calls.map((c) => [c.label, c.spent, c.saved])).toEqual([
      ["long-factual", 0, []],
      ["long-visual", FACT, ["long-factual"]],
      ["short-factual", round(FACT + LOOK), ["long-factual", "long-visual"]],
      ["short-visual", round(2 * FACT + LOOK), ["long-factual", "long-visual", "short-factual"]],
    ]);
    expect((getJob(id)!.scratch as any).spent).toBe(getJob(id)!.spent);
  });

  test("31. a provider failure keeps earlier results; Retry asks only the missing specialists and never renders again", async () => {
    h.answers = { "short-factual": "down" };
    const { id, finish } = await produce();
    await expect(finish).rejects.toThrow("provider down");

    const failed = getJob(id)!;
    expect([failed.state, failed.step]).toEqual(["failed", "finishing"]);
    expect(Object.keys(qaOf(id).long).sort()).toEqual(["factual", "visual"]);
    expect(qaOf(id).short).toEqual({});
    expect(failed.spent).toBe(round(FACT + LOOK)); // the call that never answered is not charged
    expect(jobVideos(id)).toEqual([]);
    expect(h.renders).toBe(1);

    h.answers = {};
    h.calls = [];
    updateJob(id, { state: "queued", error: null, message: "Queued" }); // the Retry route
    await runJob(id);

    expect(labels()).toEqual(["short-factual", "short-visual"]);
    expect(h.renders).toBe(1);
    expect(getJob(id)!.state).toBe("done");
    expect(jobVideos(id)).toHaveLength(2);
    expect(getJob(id)!.spent).toBe(round(2 * (FACT + LOOK)));
  });

  test("a malformed answer is still charged and fails the job; Retry makes a new attempt for that specialist only", async () => {
    h.answers = { "long-visual": "malformed" };
    const { id, finish } = await produce();
    await expect(finish).rejects.toThrow(/Invalid Final-film visual audit/);

    const failed = getJob(id)!;
    expect(failed.state).toBe("failed");
    expect(failed.spent).toBe(round(FACT + LOOK)); // paid, although unusable
    expect(Object.keys(qaOf(id).long)).toEqual(["factual"]);

    h.answers = {};
    h.calls = [];
    updateJob(id, { state: "queued", error: null, message: "Queued" });
    await runJob(id);
    expect(labels()).toEqual(["long-visual", "short-factual", "short-visual"]);
    expect(getJob(id)!.spent).toBe(round(2 * FACT + 3 * LOOK));
    expect(getJob(id)!.state).toBe("done");
    expect(h.renders).toBe(1);
  });

  test("32. the approved maximum stops the next specialist before its call; Approve more spend resumes at it", async () => {
    const approvedMax = round(2 * FACT + LOOK); // room for three specialists, not the Short visual
    const { id, finish } = await produce(approvedMax);
    await expect(finish).rejects.toThrow(/Approved maximum/);

    expect(labels()).toEqual(["long-factual", "long-visual", "short-factual"]); // the refused call never ran
    const failed = getJob(id)!;
    expect(failed.state).toBe("failed");
    expect(failed.spent).toBe(approvedMax);
    expect(Object.keys(qaOf(id).short)).toEqual(["factual"]);
    expect(jobVideos(id)).toEqual([]);

    h.calls = [];
    raiseApprovedMax(id, round(approvedMax + LOOK));
    await runJob(id);
    expect(labels()).toEqual(["short-visual"]);
    expect(h.renders).toBe(1);
    expect(getJob(id)!.state).toBe("done");
    expect(jobVideos(id)).toHaveLength(2);
  });
});

describe("Final-film QC in production: what an answered call costs", () => {
  const retry = async (id: string) => {
    h.answers = {};
    h.calls = [];
    updateJob(id, { state: "queued", error: null, message: "Queued" }); // the Retry route
    await runJob(id);
  };

  test("1. factual: a successful response whose output is not JSON is charged $0.10 once; no result is saved; the job fails", async () => {
    h.answers = { "long-factual": "non-json" };
    const { id, finish } = await produce();
    await expect(finish).rejects.toThrow("OpenAI returned non-JSON output: I could not complete this review.");

    const failed = getJob(id)!;
    expect([failed.state, failed.step]).toEqual(["failed", "finishing"]);
    expect(failed.spent).toBe(FACT);
    expect((failed.scratch as any).spent).toBe(FACT);
    expect(qaOf(id)).toEqual({ outputsValidated: true, long: {}, short: {} });
    expect(labels()).toEqual(["long-factual"]);
    expect(jobVideos(id)).toEqual([]);
  });

  test("a successful response with no output text at all is charged the same way", async () => {
    h.answers = { "short-factual": "no-output" };
    const { id, finish } = await produce();
    await expect(finish).rejects.toThrow(/non-JSON output/);
    expect(getJob(id)!.spent).toBe(round(2 * FACT + LOOK));
    expect(qaOf(id).short).toEqual({});
  });

  test("2 / 3. visual: charged $0.75 once; Retry skips the completed specialists and asks the failed one again, charging nothing twice", async () => {
    h.answers = { "long-visual": "non-json" };
    const { id, finish } = await produce();
    await expect(finish).rejects.toThrow(/non-JSON output/);

    const failed = getJob(id)!;
    expect(failed.state).toBe("failed");
    expect(failed.spent).toBe(round(FACT + LOOK));
    expect(Object.keys(qaOf(id).long)).toEqual(["factual"]);

    await retry(id);
    expect(labels()).toEqual(["long-visual", "short-factual", "short-visual"]); // Long factual is not asked or charged again
    const done = getJob(id)!;
    expect(done.state).toBe("done");
    expect(done.spent).toBe(round(2 * FACT + 3 * LOOK)); // the unusable visual answer once, then the four specialists once each
    expect(h.renders).toBe(1);
    expect(jobVideos(id)).toHaveLength(2);
  });

  test("4. a network failure (fetch throws) is not charged", async () => {
    h.answers = { "short-factual": "network" };
    const { id, finish } = await produce();
    await expect(finish).rejects.toThrow("fetch failed");
    expect(getJob(id)!.state).toBe("failed");
    expect(getJob(id)!.spent).toBe(round(FACT + LOOK)); // the two Long specialists only
    expect(qaOf(id).short).toEqual({});
  });

  test("5. a non-success HTTP response is not charged, as elsewhere in PB4", async () => {
    h.answers = { "short-visual": "http" };
    const { id, finish } = await produce();
    await expect(finish).rejects.toThrow("OpenAI responses 500: server error");
    expect(getJob(id)!.state).toBe("failed");
    expect(getJob(id)!.spent).toBe(round(2 * FACT + LOOK));
    expect(Object.keys(qaOf(id).short)).toEqual(["factual"]);
  });

  test("6. JSON that fails Final-film validation is still charged exactly once", async () => {
    h.answers = { "short-factual": "malformed" };
    const { id, finish } = await produce();
    await expect(finish).rejects.toThrow(/Invalid Final-film factual audit/);
    expect(getJob(id)!.spent).toBe(round(2 * FACT + LOOK));
    expect(qaOf(id).short).toEqual({});
  });

  test("7. a valid answer: its result and its charge only ever reach the database together", async () => {
    const { id, finish } = await produce();
    await finish;
    expect(getJob(id)!.state).toBe("done");
    // Every persisted state as [spent, saved results]: no charge without its
    // result and no result without its charge, at any moment.
    expect([...new Set(h.persisted.map((p) => JSON.stringify(p)))].map((p) => JSON.parse(p))).toEqual([
      [0, 0],
      [FACT, 1],
      [round(FACT + LOOK), 2],
      [round(2 * FACT + LOOK), 3],
      [round(2 * (FACT + LOOK)), 4],
    ]);
  });
});

describe("Final-film QC in production: restart safety", () => {
  test("A. a crash after the file check, during the first call: no render again, it begins at Long factual", async () => {
    h.answers = { "long-factual": "crash" };
    const { finish } = await produce();
    await expect(finish).rejects.toThrow("process killed");
    expect(h.snapshot.scratch.finalFilmQa).toEqual({ outputsValidated: true, long: {}, short: {} });

    h.answers = {};
    await restartFromSnapshot();
    expect(labels()).toEqual(ORDER);
    expect(h.renders).toBe(1);
    expect(getJob(h.snapshot.id)!.state).toBe("done");
  });

  test("B. Long factual saved, then a crash: it begins at Long visual", async () => {
    h.answers = { "long-visual": "crash" };
    const { finish } = await produce();
    await expect(finish).rejects.toThrow("process killed");

    h.answers = {};
    await restartFromSnapshot();
    expect(labels()).toEqual(["long-visual", "short-factual", "short-visual"]);
    expect(h.renders).toBe(1);
    expect(getJob(h.snapshot.id)!.spent).toBe(round(2 * (FACT + LOOK))); // each specialist charged once
  });

  test("C. Long complete and Short factual saved, then a crash: it begins at Short visual", async () => {
    h.answers = { "short-visual": "crash" };
    const { finish } = await produce();
    await expect(finish).rejects.toThrow("process killed");

    h.answers = {};
    await restartFromSnapshot();
    expect(labels()).toEqual(["short-visual"]);
    expect(h.renders).toBe(1);
    expect(getJob(h.snapshot.id)!.state).toBe("done");
  });

  test("D. a job waiting at awaiting_final survives a restart as it is, with no provider call", async () => {
    h.answers = { "short-factual": "HUMAN_REVIEW" };
    const { id, finish } = await produce();
    await finish;
    const before = getJob(id)!;
    expect(before.state).toBe("awaiting_final");

    h.calls = [];
    expect(resumableJobIds()).not.toContain(id); // the worker does not pick it up
    await runJob(id); // and running it anyway changes nothing
    expect(h.calls).toEqual([]);
    const after = getJob(id)!;
    expect([after.state, after.updatedAt, after.spent]).toEqual([before.state, before.updatedAt, before.spent]);
    expect(h.renders).toBe(1);
  });

  test("F. a missing or broken final file on resume fails safely: never rendered again, no call, nothing registered", async () => {
    h.answers = { "long-visual": "crash" };
    const { finish } = await produce();
    await expect(finish).rejects.toThrow("process killed");
    const id = h.snapshot.id;

    h.answers = {};
    h.missing = "long";
    await expect(restartFromSnapshot()).rejects.toThrow("Final file check failed for Long: the finished file is missing or unreadable.");
    expect(getJob(id)!.state).toBe("failed");

    h.missing = null;
    h.broken = { short: { width: 0, height: 0 } };
    h.calls = [];
    updateJob(id, { state: "queued", error: null });
    await expect(runJob(id)).rejects.toThrow("Final file check failed for Short: expected 1080x1920, got 0x0.");

    expect(h.calls).toEqual([]);
    expect(h.renders).toBe(1);
    expect(jobVideos(id)).toEqual([]);
    expect(Object.keys(qaOf(id).long)).toEqual(["factual"]); // earlier results kept
  });
});

describe("Continue anyway and the public boundary", () => {
  async function awaitingFinal(): Promise<string> {
    h.answers = { "long-factual": "HUMAN_REVIEW", "short-visual": "HUMAN_REVIEW" };
    const { id, finish } = await produce();
    await finish;
    expect(getJob(id)!.state).toBe("awaiting_final");
    h.calls = [];
    return id;
  }

  test("E / 33. accept-final requeues the same job; it checks the files again and registers both, with no call and no render", async () => {
    const id = await awaitingFinal();
    const app = Fastify();
    await registerRoutes(app);
    const probedBefore = h.probed.length;

    const res = await app.inject({ method: "POST", url: `/api/jobs/${id}/accept-final` });
    expect(res.statusCode).toBe(200);
    expect(res.json().job.state).toBe("queued");
    await waitFor(id, "done");

    const done = getJob(id)!;
    expect([done.step, done.message, done.error]).toEqual(["finishing", "Finished", null]);
    expect(h.calls).toEqual([]);
    expect(h.samplings).toEqual(["long", "short"]); // only the first pass sampled frames
    expect(h.renders).toBe(1);
    expect(h.probed.slice(probedBefore)).toEqual(["long", "short"]); // probed and validated again
    expect(jobVideos(id).map((v) => v.kind).sort()).toEqual(["long", "short"]);
    // The findings stay private in scratch, with the acceptance.
    const qa = qaOf(id);
    expect(qa.accepted).toBe(true);
    expect(qa.long.factual.decision).toBe("HUMAN_REVIEW");
    expect(qa.short.visual.decision).toBe("HUMAN_REVIEW");
    // Done: the public job no longer carries the gate.
    expect((await app.inject({ method: "GET", url: `/api/jobs/${id}` })).json().job.finalQa).toBeUndefined();
    await app.close();
  });

  test("accept-final on any other state returns the job unchanged; acceptFinalForJob refuses it", async () => {
    const { id, finish } = await produce();
    await finish;
    const app = Fastify();
    await registerRoutes(app);
    const res = await app.inject({ method: "POST", url: `/api/jobs/${id}/accept-final` });
    expect(res.statusCode).toBe(200);
    expect(res.json().job.state).toBe("done");
    expect(qaOf(id).accepted).toBeUndefined();
    expect(() => acceptFinalForJob(id)).toThrow(/Only finished films waiting for review/);
    expect((await app.inject({ method: "POST", url: "/api/jobs/nope/accept-final" })).statusCode).toBe(404);
    await app.close();
  });

  test("36. at awaiting_final the public job carries only film, area, reason and the narration fragment", async () => {
    const id = await awaitingFinal();
    const app = Fastify();
    await registerRoutes(app);
    const res = await app.inject({ method: "GET", url: `/api/jobs/${id}` });
    const job = res.json().job;
    await app.close();

    expect(job.state).toBe("awaiting_final");
    expect(job.finalQa).toEqual({
      issues: [
        { film: "long", area: "fact", reason: "The long narration overstates why it ended.", text: "long fragment" },
        { film: "short", area: "visual", reason: "A burning barn keeps returning across the short." },
      ],
    });
    const raw = JSON.stringify(job);
    for (const hidden of ["scratch", "finalFilmQa", "causalChecks", "evidenceUrls", "example.org", "cellObservations", "families", "burning barn\"", "gpt-6", "astra", "reasoning", "private factual summary", "private visual summary", "outputsValidated", "verdict"]) {
      expect(raw.toLowerCase()).not.toContain(hidden.toLowerCase());
    }
    // The Story page sees the same small shape on its active job.
    const detail = (await (async () => {
      const a = Fastify();
      await registerRoutes(a);
      const r = await a.inject({ method: "GET", url: `/api/stories/${story.slug}` });
      await a.close();
      return r.json();
    })());
    expect(detail.activeJob.id).toBe(id);
    expect(detail.activeJob.finalQa.issues).toHaveLength(2);
  });
});

describe("mock mode and atomic registration", () => {
  test("35. mock: no specialist, no frames, the file check still runs, the pair registers and the job is done", async () => {
    h.liveAfterRender = false;
    const { id, finish } = await produce();
    await finish;

    expect(h.calls).toEqual([]);
    expect(h.samplings).toEqual([]);
    expect(h.probed).toEqual(["long", "short"]);
    const job = getJob(id)!;
    expect(job.state).toBe("done");
    expect(job.spent).toBe(0);
    expect(jobVideos(id)).toHaveLength(2);
    expect(qaOf(id)).toEqual({ outputsValidated: true, long: {}, short: {} }); // no fabricated review
  });

  test("34. addVideos writes the pair in one transaction: a failing second row rolls back the first", async () => {
    const job = createJob({ id: newJobId(), storyId: story.id, mock: true, estimatedCost: 0, approvedMax: 0 });
    const video = (kind: "long" | "short", storyId: string) => ({ id: `${job.id}-${kind}`, storyId, jobId: job.id, kind, path: `stories/x/${kind}.mp4`, width: 1, height: 1, durationSec: 1, fps: 30, hasAudio: true, createdAt: new Date().toISOString() });

    expect(() => addVideos([video("long", story.id), video("short", "no-such-story")])).toThrow(/FOREIGN KEY/);
    expect(jobVideos(job.id)).toEqual([]); // not even the valid Long

    addVideos([video("long", story.id), video("short", story.id)]);
    expect(jobVideos(job.id).map((v) => v.kind).sort()).toEqual(["long", "short"]);
  });

  test("an older complete pair never hides the active awaiting_final job, and it adds no video of its own", async () => {
    const { finish: first } = await produce();
    await first; // an earlier finished pair for the same story
    h.answers = { "long-visual": "HUMAN_REVIEW" };
    h.calls = [];
    const { id, finish } = await produce();
    await finish;

    expect(store.activeJobForStory(story.id)?.id).toBe(id);
    const { productionTarget, latestCompletePair } = await import("../src/app/productionStage.ts");
    const videos = videosForStory(story.id);
    expect(latestCompletePair(videos)).not.toBeNull(); // the older pair still exists
    expect(latestCompletePair(videos, id)).toBeNull(); // no Ready for this job
    expect(productionTarget({ activeJob: { id }, failedJob: null, videos })).toEqual({ jobId: id });
  });
});
