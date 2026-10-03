import { describe, test, expect, vi, beforeEach } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";

// Stage 16A Slice 2: the Long-first vertical path. A Long-first job makes the
// Long alone until LONG COMPLETE: research, the Long script and its Long-only
// audit, Long-only Text QA, Long narration, Long-only planning, Long media, Long
// Asset QA and Director QA, Long motion, one Long render, the Long's own Final-
// film QC (and its one bounded repair), then addVideo(long) and LONG COMPLETE.
// Before that THE SHORT DOES NOT EXIST: every persisted write of a Long-first job
// is deep-scanned for any Short key, and the story folder for any Short file.
// Every provider is a local stub that records what it was asked; nothing live
// runs. Legacy pair-first jobs (no flow) keep the pair path, checked at the end.
const tmp = mkdtempSync(path.join(os.tmpdir(), "pb4-long-first-"));
process.env.PROVIDER_MODE = "mock";
process.env.OPENAI_API_KEY = "test-key";
process.env.PB4_DATA_DIR = path.join(tmp, "data");
process.env.PB4_MEDIA_DIR = path.join(tmp, "media");

type Call = { label: string; input: string; instructions: string; images: number };

const h = vi.hoisted(() => ({
  jobId: "",
  liveAfterRender: false,
  calls: [] as Call[], // every answered model call, in order
  provider: [] as string[], // every other provider interaction: "<what>:<file or film>"
  writes: [] as string[], // writeScript kinds
  helpers: [] as string[], // which text-gate helpers production selected (pair or Long-only)
  renders: [] as string[][], // the files each renderFilms call made
  plans: {} as Record<string, any>,
  answers: {} as Record<string, string[]>, // label -> queued decisions ("PASS" default)
  reviewCells: null as number[] | null, // the cells a visual HUMAN_REVIEW names
  archiveFound: true,
  archiveEvery: false,
  crash: null as null | { label: string; nth: number },
  seen: {} as Record<string, number>,
  snapshot: null as any,
  scans: [] as string[][], // Short keys found in each persisted Long-first scratch
  respond: null as null | ((opts: any) => Promise<unknown>),
  narrate: null as null | ((text: string, outPath: string) => Promise<unknown>),
  fetchArchive: null as null | ((query: string, outPath: string) => Promise<unknown>),
}));

// A "process kill" at the nth call of one label: the job row as it was saved
// when the call began is kept as the snapshot a restart would find.
async function crashPoint(label: string): Promise<void> {
  h.seen[label] = (h.seen[label] ?? 0) + 1;
  if (h.crash?.label === label && h.crash.nth === h.seen[label]) {
    const { getJob } = await import("../src/server/store.ts");
    h.snapshot = getJob(h.jobId);
    h.crash = null;
    throw new Error("process killed");
  }
}

vi.mock("../src/providers/openai.ts", async (orig) => {
  const real = await orig<typeof import("../src/providers/openai.ts")>();
  const { mkdirSync, writeFileSync } = await import("node:fs");
  const nodePath = await import("node:path");
  return {
    ...real,
    respondJson: vi.fn(async (opts: any) => h.respond!(opts)),
    generateImageFile: vi.fn(async (opts: { outPath: string }) => {
      await crashPoint("image");
      h.provider.push(`image:${nodePath.basename(opts.outPath)}`);
      mkdirSync(nodePath.dirname(opts.outPath), { recursive: true });
      writeFileSync(opts.outPath, `still ${nodePath.basename(opts.outPath)}`);
    }),
  };
});
vi.mock("../src/providers/elevenlabs.ts", () => ({ narrate: vi.fn(async (text: string, outPath: string) => h.narrate!(text, outPath)) }));
vi.mock("../src/providers/runway.ts", () => ({
  generateMotion: vi.fn(async (opts: { kind: string; outPath: string }) => {
    await crashPoint("motion");
    h.provider.push(`motion:${opts.kind}`);
    const { mkdirSync, writeFileSync } = await import("node:fs");
    mkdirSync((await import("node:path")).dirname(opts.outPath), { recursive: true });
    writeFileSync(opts.outPath, "clip");
  }),
}));
vi.mock("../src/production/wikimedia.ts", async (orig) => ({
  ...(await orig<typeof import("../src/production/wikimedia.ts")>()),
  fetchArchive: vi.fn(async (query: string, outPath: string) => h.fetchArchive!(query, outPath)),
}));
vi.mock("../src/render/renderVideo.ts", async (orig) => ({
  ...(await orig<typeof import("../src/render/renderVideo.ts")>()),
  renderFilms: vi.fn(async (_dir: string, films: Array<{ plan: any; outPath: string }>) => {
    await crashPoint("render");
    const nodePath = await import("node:path");
    h.renders.push(films.map((f) => nodePath.basename(f.outPath)));
    for (const f of films) h.plans[f.outPath] = f.plan;
    if (h.liveAfterRender) (await import("../src/server/config.ts")).config.mode = "live";
  }),
  probeVideo: vi.fn((file: string) => {
    const p = h.plans[file];
    if (!p) throw new Error(`ffprobe: ${file}: No such file or directory`);
    h.provider.push(`probe:${p.kind}`);
    return { width: p.width, height: p.height, durationSec: p.durationInFrames / p.fps + 0.03, fps: 30, hasAudio: true };
  }),
}));
vi.mock("../src/render/contactSheet.ts", async (orig) => ({
  ...(await orig<typeof import("../src/render/contactSheet.ts")>()),
  sampledFrames: (_videoPath: string, kind: "long" | "short") => {
    h.provider.push(`frames:${kind}`);
    return Array.from({ length: kind === "long" ? 24 : 12 }, (_, i) => ({ cell: i + 1, timeSec: i + 0.5, jpeg: Buffer.from([0xff, 0xd8, 0xff]) }));
  },
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
// Which formats production asks the script writer for, and which text-gate
// helper (pair or Long-only) it selects. Each spy calls the real helper.
vi.mock("../src/production/scripts.ts", async (orig) => {
  const real = await orig<typeof import("../src/production/scripts.ts")>();
  const spy = (name: string) => vi.fn(async (...args: any[]) => (h.helpers.push(name), (real as any)[name](...args)));
  const helpers = ["auditScripts", "auditLongScript", "reviseStoryText", "reviseLongText", "reviewStoryDraft", "reviewLongDraft", "verifyStoryDraft", "verifyLongDraft"];
  return {
    ...real,
    ...Object.fromEntries(helpers.map((name) => [name, spy(name)])),
    writeScript: vi.fn(async (s: any, r: any, kind: "long" | "short") => (h.writes.push(kind), real.writeScript(s, r, kind))),
  };
});
// Every persisted write of a Long-first job is deep-scanned for Short state.
vi.mock("../src/server/store.ts", async (orig) => {
  const real = await orig<typeof import("../src/server/store.ts")>();
  return {
    ...real,
    updateJob: (id: string, patch: any) => {
      real.updateJob(id, patch);
      const s = real.getJob(id)?.scratch;
      if (s?.flow === "long-first") h.scans.push(shortState(s));
    },
  };
});

// Every key that names a Short, and every film/kind field that says "short".
function shortState(o: unknown, at = "scratch"): string[] {
  if (Array.isArray(o)) return o.flatMap((x, i) => shortState(x, `${at}[${i}]`));
  if (!o || typeof o !== "object") return [];
  return Object.entries(o).flatMap(([k, v]) => [
    ...(/short/i.test(k) ? [`${at}.${k}`] : []),
    ...((k === "film" || k === "kind") && v === "short" ? [`${at}.${k}=short`] : []),
    ...shortState(v, `${at}.${k}`),
  ]);
}

const g = await import("../src/production/generate.ts");
const { runJob, newJobId, approveTextForJob, approveVisualsForJob, acceptFinalForJob, autoTextQaForJob, autoVisualQaForJob, jobProgress, filmKinds } = g;
const v = await import("../src/production/visuals.ts");
const s = await import("../src/production/scripts.ts");
const aq = await import("../src/production/assetQa.ts");
const store = await import("../src/server/store.ts");
const { createJob, getJob, updateJob, upsertStory, videosForStory, resumableJobIds, longCompleteJobIds } = store;
const { db } = await import("../src/server/db.ts");
const { config, DATA_DIR } = await import("../src/server/config.ts");
const { PRICING, assetReviewUsd, ttsUsd, round } = await import("../src/server/pricing.ts");
const { storyDir, inStory, retainedArchiveDir, isProductionMedia, clearWorkingVisuals, ensureProductionDirs } = await import("../src/production/paths.ts");
const { productionMediaPrefix, productionRel } = await import("../src/types.ts");
const { recordNarration } = await import("../src/production/narration.ts");
const { causalClaims, issueAssets } = await import("../src/production/finalFilmQa.ts");
const { cellTimes } = await import("../src/render/contactSheet.ts");
const { paulBunyanStory, paulBunyanResearch, paulBunyanScripts } = await import("../src/production/fixtures/paulBunyan.ts");
const Fastify = (await import("fastify")).default;
const { registerRoutes } = await import("../src/server/routes.ts");
type Story = import("../src/types.ts").Story;

const LONG = paulBunyanScripts.long;
const ARCHIVE_BYTES = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from("real archive photograph")]);
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
const scratchOf = (id: string) => getJob(id)!.scratch as any;
const labels = () => h.calls.map((c) => c.label);
const count = (label: string) => labels().filter((l) => l === label).length;

// ---- the stub providers

function timings(text: string) {
  let t = 0.3;
  return text.split(/\s+/).filter(Boolean).map((word) => {
    const start = t;
    t += 0.32 + (/[.!?]$/.test(word) ? 0.34 : 0.03);
    return { word, start, end: start + 0.3 };
  });
}

h.narrate = async (text, outPath) => {
  await crashPoint("tts");
  h.provider.push(`tts:${path.basename(outPath)}`);
  mkdirSync(path.dirname(outPath), { recursive: true });
  writeFileSync(outPath, "voice");
  return timings(text);
};

h.fetchArchive = async (query, outPath) => {
  h.provider.push(`archive:${path.basename(outPath)}`);
  if (!h.archiveFound) return null;
  writeFileSync(outPath, ARCHIVE_BYTES);
  return { sourcePage: "https://commons.wikimedia.org/wiki/File:Glomar.jpg", assetUrl: "https://upload.wikimedia.org/glomar.jpg", credit: "U.S. Navy · Public domain", license: "Public domain", localPath: outPath, sha256: sha(ARCHIVE_BYTES), title: "File:Glomar.jpg", mime: "image/jpeg", query };
};

// The Long's fixed slots as planning built them (from the saved script and narration).
const slotsNow = () => v.planSlots("long", scratchOf(h.jobId).scripts.long, scratchOf(h.jobId).narration.long);
let coverage: any;

// One asset per slot: an all-distinct edit has no repetition pattern, so Director
// QA can be clean. One archive asset, and one motion-capable reconstruction on a
// slot where motion is allowed.
function coverageAnswer() {
  const slots = slotsNow();
  const motionAt = slots.findIndex((s) => s.motionAllowed);
  const archiveAt = motionAt === 1 ? 2 : 1;
  coverage = {
    longAssets: slots.map((_, i) => ({
      truth: i === archiveAt ? "archive" : "reconstruction",
      purpose: `Show what slot ${i} narrates.`,
      mustShow: [{ description: `subject ${i}`, region: "center" }],
      mustNotShow: [],
      prompt: `A scene for slot ${i}.`,
      archiveQuery: i === archiveAt ? "Hughes Glomar Explorer 1974" : "",
      useMaster: i === 0,
      baseFraming: "wide",
      motionCapable: i === motionAt,
    })),
    archiveAt,
    motionAt,
  };
  return { longAssets: coverage.longAssets };
}

// With `h.archiveEvery`, the archive asset's base also returns every eighth slot
// (never adjacent), so a sampled final-film cell always lands on it.
function editAnswer() {
  const archiveSlot = (i: number) => h.archiveEvery && i % 8 === coverage.archiveAt % 8 && i !== coverage.motionAt;
  return {
    long: slotsNow().map((s, i) => ({ slotId: s.id, presentationId: `${v.assetId("long", archiveSlot(i) ? coverage.archiveAt : i)}:base`, motionPriority: i === coverage.motionAt ? 2 : 0 })),
  };
}

const next = (label: string) => h.answers[label]?.shift() ?? "PASS";

h.respond = async (opts: any) => {
  const film = /FILM: (LONG|SHORT)/.exec(String(opts.input))?.[1]?.toLowerCase();
  const label = opts.schemaName === "final_film_factual_audit" ? `${film}-factual` : opts.schemaName === "final_film_visual_audit" ? `${film}-visual` : opts.schemaName;
  await crashPoint(label);
  h.calls.push({ label, input: String(opts.input ?? ""), instructions: String(opts.instructions ?? ""), images: opts.images?.length ?? 0 });
  switch (opts.schemaName) {
    case "research":
    case "research_audit":
    case "research_verify":
      return structuredClone(paulBunyanResearch);
    case "script":
      return { script: LONG };
    case "long_script_audit":
      return { long: LONG };
    case "long_text_qa":
      return { decision: "PASS", summary: "Clear and supported.", repairFeedback: null, humanReview: [] };
    case "long_text_verify":
      return { decision: "PASS", summary: "Clear and supported.", humanReview: [] };
    case "long_coverage_plan":
      return coverageAnswer();
    case "long_edit_plan":
      return editAnswer();
    case "asset_qa":
    case "asset_verify":
      return { assets: Object.fromEntries(Object.keys(opts.schema.properties.assets.properties).map((id) => [id, { decision: "PASS", reason: "", repairFeedback: null }])), summary: "" };
    case "director_qa":
      return { repairs: {}, humanReview: {}, summary: "Nothing notable." };
    case "director_verify":
      return { humanReview: {}, summary: "Final." };
    case "final_film_factual_audit": {
      const decision = next(label);
      const checks = causalClaims(scratchOf(h.jobId).scripts[film!]).map((c) => ({ text: c.text, verdict: "SUPPORTED_DIRECTLY", reason: "The sources state it.", evidenceUrls: ["https://example.org/source"] }));
      const issues = decision === "HUMAN_REVIEW" ? [{ reason: `The ${film} narration overstates why it ended.`, text: `${film} fragment` }] : [];
      return { causalChecks: checks, issues, decision, summary: "private factual summary" };
    }
    case "final_film_visual_audit": {
      const decision = next(label);
      const cells = opts.images.length;
      const named = h.reviewCells ?? [1, cells];
      const cellObservations = Array.from({ length: cells }, (_, i) => ({ cell: i + 1, description: "a ship at sea" }));
      const review = decision === "HUMAN_REVIEW";
      return {
        cellObservations,
        families: review ? [{ name: "reconstructed ship", description: "a reconstruction where archive was planned", cells: [...new Set([...named, (named[0] % cells) + 1])] }] : [],
        issues: review ? [{ reason: `A reconstruction stands in for real archive in the ${film}.`, cells: named }] : [],
        decision,
        summary: "private visual summary",
      };
    }
    default:
      throw new Error(`unexpected provider call ${opts.schemaName}`);
  }
};

// ---- the flow

let n = 0;
function newStory(): Story {
  const slug = `long-first-${n++}`;
  const story = { ...paulBunyanStory, id: slug, slug, title: `A Long-first Story ${n}`, createdAt: new Date().toISOString() };
  upsertStory(story);
  return story;
}

function longFirstJob(story: Story, approvedMax = 50) {
  const job = createJob({ id: newJobId(), storyId: story.id, mock: config.mode === "mock", estimatedCost: 9.39, approvedMax, scratch: { flow: "long-first" } });
  h.jobId = job.id;
  return job;
}

// The worker and the two autopilots, as production runs them: a new draft goes
// to Text QA (which never approves), then the human Approve & continue; fresh
// visuals go to the Visual Autopilot, and a visual gate
// it leaves is approved as a person would. Stops at done, failed or
// awaiting_final.
async function drive(id: string): Promise<void> {
  for (let i = 0; i < 12; i++) {
    const job = getJob(id)!;
    if (job.state === "done" || job.state === "failed" || job.state === "awaiting_final") return;
    if (job.state === "awaiting_text") {
      await autoTextQaForJob(id);
      if (getJob(id)!.state === "awaiting_text") approveTextForJob(id);
      continue;
    }
    if (job.state === "awaiting_preview" && !job.previewApproved) {
      await autoVisualQaForJob(id, () => {});
      if (!getJob(id)!.previewApproved) approveVisualsForJob(id);
      continue;
    }
    await runJob(id).catch(() => {}); // a failure is the job's state; the test checks it
  }
}

// Every file under the story folder, relative.
function files(slug: string): string[] {
  const root = storyDir(slug);
  const out: string[] = [];
  const walk = (d: string) => {
    if (!existsSync(d)) return;
    for (const name of readdirSync(d)) {
      const p = path.join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else out.push(path.relative(root, p).split(path.sep).join("/"));
    }
  };
  walk(root);
  return out;
}

// THE SHORT DOES NOT EXIST: no persisted Short key at any write, no Short file,
// no Short video row, no Short provider work.
function expectNoShort(id: string, slug: string): void {
  expect(h.scans.length).toBeGreaterThan(0);
  expect(h.scans.flat()).toEqual([]);
  expect(shortState(scratchOf(id))).toEqual([]);
  expect(files(slug).filter((f) => /short/i.test(f))).toEqual([]);
  expect(videosForStory(getJob(id)!.storyId).filter((x) => x.kind === "short")).toEqual([]);
  expect(h.writes).not.toContain("short");
  expect(h.provider.filter((p) => /short/i.test(p))).toEqual([]);
  expect(labels().filter((l) => /short/i.test(l))).toEqual([]);
}

// The spend a run's answered calls and media work cost, from PRICING.
function expectedSpend(): number {
  const price = (c: Call): number => {
    if (/^research/.test(c.label)) return c.label === "research_verify" ? PRICING.openai.research : 0; // one charge for the three passes
    if (["script", "long_script_audit", "long_text_qa", "long_text_verify", "long_story_revision"].includes(c.label)) return PRICING.openai.script;
    if (["long_coverage_plan", "long_edit_plan", "coverage_repair", "edit_repair", "director_qa", "director_verify", "sequence_revision"].includes(c.label)) return PRICING.openai.visualPlan;
    if (c.label === "asset_qa" || c.label === "asset_verify") return assetReviewUsd(c.images);
    if (c.label === "long-factual") return PRICING.openai.finalFactualReview;
    if (c.label === "long-visual") return PRICING.openai.finalVisualReview;
    throw new Error(`no price for ${c.label}`);
  };
  const media = h.provider.reduce((s, p) => s + (p.startsWith("image:") ? PRICING.openai.image : p.startsWith("motion:") ? PRICING.runway.video5s : p.startsWith("tts:") ? ttsUsd(LONG.length) : 0), 0);
  return round(h.calls.reduce((s, c) => s + price(c), 0) + media);
}

beforeEach(() => {
  config.mode = "mock";
  h.liveAfterRender = false;
  h.calls = [];
  h.provider = [];
  h.writes = [];
  h.helpers = [];
  h.renders = [];
  h.answers = {};
  h.reviewCells = null;
  h.archiveFound = true;
  h.archiveEvery = false;
  h.crash = null;
  h.seen = {};
  h.snapshot = null;
  h.scans = [];
});

// ---------------------------------------------------------------------------

describe("the flow marker", () => {
  test("createJob writes the initial scratch in the SAME insert; without it a job starts empty, as always", () => {
    const story = newStory();
    const job = longFirstJob(story);
    const row = db.prepare("SELECT scratch FROM jobs WHERE id=?").get(job.id) as { scratch: string };
    expect(JSON.parse(row.scratch)).toEqual({ flow: "long-first" });
    expect(job.scratch).toEqual({ flow: "long-first" });
    const legacy = createJob({ id: newJobId(), storyId: story.id, mock: true, estimatedCost: 1, approvedMax: 2 });
    expect((db.prepare("SELECT scratch FROM jobs WHERE id=?").get(legacy.id) as { scratch: string }).scratch).toBe("{}");
    expect(filmKinds(job.scratch)).toEqual(["long"]);
    expect(filmKinds(legacy.scratch)).toEqual(["long", "short"]);
  });

  test("the public job carries the flow only for a Long-first job; nothing else of scratch", async () => {
    const story = newStory();
    const lf = longFirstJob(story);
    const legacy = createJob({ id: newJobId(), storyId: story.id, mock: true, estimatedCost: 1, approvedMax: 2 });
    const app = Fastify();
    await registerRoutes(app);
    const a = (await app.inject({ method: "GET", url: `/api/jobs/${lf.id}` })).json().job;
    const b = (await app.inject({ method: "GET", url: `/api/jobs/${legacy.id}` })).json().job;
    expect(a.flow).toBe("long-first");
    expect("flow" in b).toBe(false);
    expect("scratch" in a || "scratch" in b).toBe(false);
    await app.close();
  });
});

describe("1, 3. the whole Long-first path in mock mode", () => {
  test("runs to done with the Long alone: one Long video, LONG COMPLETE, and no Short anywhere at any persisted step", async () => {
    const story = newStory();
    const job = longFirstJob(story);
    const steps: string[] = [];
    // Progress counts one film: never half done because a Short is absent.
    const first = await runJob(job.id);
    expect(first).toBe("text_gate");
    expect(scratchOf(job.id).scripts).toEqual({ long: expect.any(String) });
    expect(scratchOf(job.id).scriptParts).toEqual({ long: expect.any(String) });
    expect(jobProgress({ step: "scripts", scratch: scratchOf(job.id) })).toEqual({ current: 1, total: 1 });
    approveTextForJob(job.id);
    expect(await runJob(job.id)).toBe("preview_gate");
    steps.push(getJob(job.id)!.state);
    const s = scratchOf(job.id);
    expect(Object.keys(s.narration)).toEqual(["long"]);
    expect(jobProgress({ step: "narration", scratch: s })).toEqual({ current: 1, total: 1 });
    expect(s.longShots.length).toBeGreaterThan(0);
    expect("shortShots" in s).toBe(false);
    expect(Object.keys(s.retainedPresentations)).toEqual(["long"]);
    expect(getJob(job.id)!.preview!.moments).toBe(s.longShots.length); // the Long's preview alone
    approveVisualsForJob(job.id);
    await runJob(job.id);

    const done = getJob(job.id)!;
    expect(done.state).toBe("done");
    expect(h.writes).toEqual(["long"]); // the mock never builds a Short either
    expect(h.renders).toEqual([["long.mp4"]]);
    const videos = videosForStory(story.id);
    expect(videos.map((x) => [x.id, x.kind])).toEqual([[`${job.id}-long`, "long"]]);
    expect(scratchOf(job.id).longComplete).toEqual({ videoId: `${job.id}-long`, at: expect.any(String) });
    expect(scratchOf(job.id).finalFilmQa).toEqual({ outputsValidated: true, long: {} });
    expect(longCompleteJobIds(story.id)).toEqual([job.id]);
    expect(files(story.slug)).toContain(`jobs/${job.id}/audio/long.wav`); // the job's own media workspace
    expectNoShort(job.id, story.slug);
    expect(h.calls).toEqual([]); // mock: no model call at all
  });
});

describe("2, 3. Long-first in live mode, every provider stubbed", () => {
  test("every provider interaction is the Long's, no prompt carries a Short, and the spend is the Long's work alone", async () => {
    config.mode = "live";
    const story = newStory();
    const job = longFirstJob(story);
    await drive(job.id);
    const done = getJob(job.id)!;
    expect(done.state).toBe("done");

    // Model calls: Long-only schemas, in production order, each once.
    const assetBatches = Math.ceil(aq.assetQaTargets("long", scratchOf(job.id).longShots).length / aq.ASSET_QA_BATCH);
    expect(labels()).toEqual([
      "research",
      "research_audit",
      "research_verify",
      "script",
      "long_script_audit",
      "long_text_qa",
      "long_coverage_plan",
      "long_edit_plan",
      ...Array(assetBatches).fill("asset_qa"),
      "director_qa",
      "director_verify",
      "long-factual",
      "long-visual",
    ]);
    for (const c of h.calls) {
      expect(c.input).not.toMatch(/SHORT SCRIPT|SHORT SLOTS|SHORT MEDIA|shortAssets|FILM: SHORT/);
      expect(c.instructions).not.toMatch(/SHORT SCRIPT|shortAssets|E\. SHORT|the Short/);
    }
    expect(h.calls.find((c) => c.label === "script")!.instructions).toMatch(/long-form script director/);
    expect(h.calls.filter((c) => c.label.startsWith("long_") || c.label.startsWith("asset_") || c.label.startsWith("director_")).every((c) => !/\bShort\b/.test(c.input))).toBe(true);

    // Media and render: the Long's files only.
    const images = h.provider.filter((p) => p.startsWith("image:"));
    expect(images[0]).toBe("image:hero.png");
    expect(images.slice(1).every((p) => /^image:long-\d\d\.png$/.test(p))).toBe(true);
    expect(new Set(images).size).toBe(images.length);
    expect(h.provider.filter((p) => p.startsWith("tts:"))).toEqual(["tts:long.mp3"]);
    expect(h.provider.filter((p) => p.startsWith("archive:")).every((p) => /^archive:long-\d\d\.jpg$/.test(p))).toBe(true);
    expect(h.provider.filter((p) => p.startsWith("motion:"))).toEqual(coverage.motionAt >= 0 ? ["motion:long"] : []);
    expect(h.renders).toEqual([["long.mp4"]]);
    expect(h.provider.filter((p) => p.startsWith("frames:"))).toEqual(["frames:long"]);

    // Spend: exactly the Long's answered calls and media, nothing else.
    expect(done.spent).toBe(expectedSpend());
    expect(videosForStory(story.id).map((x) => x.kind)).toEqual(["long"]);
    expect(scratchOf(job.id).longComplete.videoId).toBe(`${job.id}-long`);
    expect(h.helpers).toEqual(["auditLongScript", "reviewLongDraft"]);
    expect(store.getScripts(story.id)).toEqual({ long: LONG }); // the story's stored scripts: the Long alone
    expectNoShort(job.id, story.slug);
  });

  test("the Visual Autopilot runs Asset QA, the Long's Director QA, then approves: no Short run is waited for", async () => {
    config.mode = "live";
    const story = newStory();
    const job = longFirstJob(story);
    expect(await runJob(job.id)).toBe("text_gate");
    await autoTextQaForJob(job.id);
    approveTextForJob(job.id); // the human gate: Text QA never approves
    expect(await runJob(job.id)).toBe("preview_gate");
    const before = h.calls.length;
    const advanced: string[] = [];
    expect(await autoVisualQaForJob(job.id, (id) => advanced.push(id))).toBe("approved");
    expect(labels().slice(before).filter((l) => l.startsWith("director"))).toEqual(["director_qa", "director_verify"]);
    expect(advanced).toEqual([job.id]);
    expect(getJob(job.id)!.previewApproved).toBe(true);
    expect(Object.keys(scratchOf(job.id).directorQa)).toEqual(["long"]);
    expect(g.visualGateClean(job.id)).toBe(true); // Asset QA and the Long's run: the whole gate
    expectNoShort(job.id, story.slug);
  });
});

describe("4. resume at the saved boundaries never repeats completed paid work", () => {
  // Each "crash" kills the process at one call; the worker then resumes the saved row.
  const points: [string, { label: string; nth: number }, string[]][] = [
    ["the Long audit (the script write is kept)", { label: "long_script_audit", nth: 1 }, ["script"]],
    ["narration (the text is kept)", { label: "tts", nth: 1 }, ["script", "long_script_audit", "long_text_qa"]],
    ["the master still (the plan is kept)", { label: "image", nth: 1 }, ["long_coverage_plan", "long_edit_plan"]],
    ["the fourth still (earlier stills are kept)", { label: "image", nth: 4 }, ["long_coverage_plan", "long_edit_plan"]],
    ["motion (the stills and gate results are kept)", { label: "motion", nth: 1 }, ["director_qa", "director_verify"]],
    ["the render (motion is kept)", { label: "render", nth: 1 }, ["director_qa", "director_verify"]],
    ["the Long's visual QC (its factual result is kept)", { label: "long-visual", nth: 1 }, ["long-factual"]],
  ];
  test.each(points)("a crash at %s", async (_name, crash, once) => {
    config.mode = "live";
    const story = newStory();
    const job = longFirstJob(story);
    h.crash = crash;
    await drive(job.id);
    expect(getJob(job.id)!.state).toBe("failed");
    expect(h.snapshot).toBeTruthy();
    // The worker resumes the row as the crash left it.
    updateJob(job.id, { ...h.snapshot });
    expect(resumableJobIds()).toContain(job.id);
    await drive(job.id);

    expect(getJob(job.id)!.state).toBe("done");
    for (const label of once) expect(count(label)).toBe(1);
    const images = h.provider.filter((p) => p.startsWith("image:"));
    expect(new Set(images).size).toBe(images.length); // no still made twice
    expect(h.provider.filter((p) => p.startsWith("motion:")).length).toBeLessThanOrEqual(1);
    expect(h.renders.filter((r) => r.length).length).toBe(1); // one finished render
    expect(getJob(job.id)!.spent).toBe(expectedSpend()); // nothing charged twice
    expect(videosForStory(story.id).map((x) => x.id)).toEqual([`${job.id}-long`]);
    expectNoShort(job.id, story.slug);
  });

  test("a restart at the text gate and at the visual gate calls nothing again", async () => {
    config.mode = "live";
    const story = newStory();
    const job = longFirstJob(story);
    await runJob(job.id);
    const atText = h.calls.length;
    expect(await runJob(job.id)).toBeUndefined(); // still at the text gate
    expect(h.calls.length).toBe(atText);
    // Text QA passes and the job still waits: a restart there calls nothing again.
    expect(await autoTextQaForJob(job.id)).toEqual({ status: "passed" });
    const passed = [h.calls.length, h.provider.length];
    expect(await runJob(job.id)).toBeUndefined();
    expect([h.calls.length, h.provider.length]).toEqual(passed);
    expect(getJob(job.id)!.state).toBe("awaiting_text");
    approveTextForJob(job.id); // the human gate
    await runJob(job.id);
    const atPreview = [h.calls.length, h.provider.length];
    updateJob(job.id, { state: "queued" }); // the worker resumes a gate job after a restart
    await runJob(job.id);
    expect([h.calls.length, h.provider.length]).toEqual(atPreview);
    expect(getJob(job.id)!.state).toBe("awaiting_preview");
    expectNoShort(job.id, story.slug);
  });
});

describe("5. the addVideo -> LONG COMPLETE crash window", () => {
  test("the Long registered but LONG COMPLETE not saved: the resume reuses everything and upserts the same row", async () => {
    config.mode = "live";
    const story = newStory();
    const job = longFirstJob(story);
    await drive(job.id);
    expect(getJob(job.id)!.state).toBe("done");
    const row = videosForStory(story.id)[0];
    const spent = getJob(job.id)!.spent;
    // What a process stop between addVideo(long) and the final job update leaves:
    // the row exists, the job is still running in the finish, LONG COMPLETE absent.
    const { longComplete: _lc, ...rest } = scratchOf(job.id);
    updateJob(job.id, { state: "running", step: "finishing", message: "Checking the final film", scratch: rest });
    expect(longCompleteJobIds(story.id)).toEqual([]);
    expect(resumableJobIds()).toContain(job.id);
    const [calls, renders, provider] = [h.calls.length, h.renders.length, h.provider.filter((p) => !p.startsWith("probe:")).length];

    await runJob(job.id);
    expect(getJob(job.id)!.state).toBe("done");
    expect(scratchOf(job.id).longComplete).toEqual({ videoId: `${job.id}-long`, at: expect.any(String) });
    expect(h.calls.length).toBe(calls); // no reviewer asked again
    expect(h.renders.length).toBe(renders); // nothing rendered again
    expect(h.provider.filter((p) => !p.startsWith("probe:")).length).toBe(provider); // only the local file check ran
    expect(getJob(job.id)!.spent).toBe(spent); // nothing charged again
    const videos = videosForStory(story.id);
    expect(videos).toHaveLength(1);
    expect(videos[0]).toEqual(row); // the same row, its creation time kept
    expect(longCompleteJobIds(story.id)).toEqual([job.id]);
  });
});

describe("6. the Long's finished-film review", () => {
  test("HUMAN_REVIEW waits at awaiting_final with no video; Continue anyway registers the Long alone, with no new work", async () => {
    config.mode = "live";
    const story = newStory();
    const job = longFirstJob(story);
    h.answers = { "long-factual": ["HUMAN_REVIEW"] }; // a factual concern: no automatic repair applies
    await drive(job.id);
    const waiting = getJob(job.id)!;
    expect(waiting.state).toBe("awaiting_final");
    expect(waiting.message).toBe("The final film needs review");
    expect(videosForStory(story.id)).toEqual([]);
    expect(scratchOf(job.id).longComplete).toBeUndefined();
    expect(scratchOf(job.id).finalFilmQa.visualRepair).toBeUndefined();
    expect(labels().filter((l) => /factual|visual/.test(l))).toEqual(["long-factual", "long-visual"]);
    // The public concerns: the Long's only.
    const app = Fastify();
    await registerRoutes(app);
    const pub = (await app.inject({ method: "GET", url: `/api/jobs/${job.id}` })).json().job;
    expect(pub.finalQa.issues.map((i: any) => i.film)).toEqual(["long"]);
    await app.close();

    const [calls, provider] = [h.calls.length, h.provider.filter((p) => !p.startsWith("probe:")).length];
    acceptFinalForJob(job.id);
    await drive(job.id);
    expect(getJob(job.id)!.state).toBe("done");
    expect(h.calls.length).toBe(calls);
    expect(h.provider.filter((p) => !p.startsWith("probe:")).length).toBe(provider);
    expect(videosForStory(story.id).map((x) => x.id)).toEqual([`${job.id}-long`]);
    expect(scratchOf(job.id).longComplete.videoId).toBe(`${job.id}-long`);
    expectNoShort(job.id, story.slug);
  });

  test("7. the one bounded final visual repair needs only the Long's factual PASS: archive recovered, the Long alone re-rendered and re-audited", async () => {
    config.mode = "live";
    const story = newStory();
    const job = longFirstJob(story);
    h.archiveFound = false; // the planned archive falls back to a reconstruction
    h.archiveEvery = true;
    // The visual audit flags the cell over that fallback slot; the re-audit passes.
    h.answers = { "long-visual": ["HUMAN_REVIEW", "PASS"] };
    const original = h.respond!;
    h.respond = async (opts) => {
      if (opts.schemaName === "final_film_visual_audit" && !h.reviewCells) {
        const shots = scratchOf(job.id).longShots;
        const owner = shots.find((s: any) => s.archiveQuery && s.edit === "new")!;
        const plan = h.plans[inStory(story.slug, `jobs/${job.id}/renders/long.mp4`)];
        const duration = plan.durationInFrames / plan.fps + 0.03;
        const times = cellTimes(duration, "long");
        // The cells the product's own mapping puts on that asset (an issue names two or more).
        h.reviewCells = Array.from({ length: times.length }, (_, i) => i + 1).filter((c) => issueAssets(shots, times, [c]).includes(owner.assetId));
        h.archiveFound = true; // the repair's one more search finds it
      }
      return original(opts);
    };
    try {
      await drive(job.id);
    } finally {
      h.respond = original;
    }
    const s = scratchOf(job.id);
    expect(getJob(job.id)!.state).toBe("done");
    expect(s.finalFilmQa.visualRepair).toMatchObject({ attempted: true, recovered: [{ film: "long" }] });
    expect(s.finalFilmQa.visualRepair.rerender).toBeUndefined();
    expect(h.renders).toEqual([["long.mp4"], ["long.mp4"]]); // the Long, then the Long again
    expect(labels().filter((l) => /factual|visual/.test(l))).toEqual(["long-factual", "long-visual", "long-visual"]);
    const owner = s.longShots.find((x: any) => x.archiveQuery && x.edit === "new");
    expect(owner).toMatchObject({ truth: "archive", path: expect.stringMatching(new RegExp(`^jobs/${job.id}/archive/long-\\d\\d\\.jpg$`)) });
    // The recovered archive was found, reviewed and rendered from the job's own
    // workspace: the scoped path is still an archive file to the ledger and repair.
    expect(isProductionMedia(owner.path, "archive")).toBe(true);
    expect(getJob(job.id)!.state).toBe("done");
    expect(videosForStory(story.id).map((x) => x.kind)).toEqual(["long"]);
    expect(getJob(job.id)!.spent).toBe(expectedSpend());
    expectNoShort(job.id, story.slug);
  });
});

describe("8. this story's retained archive reaches the Long Coverage call as screened candidates", () => {
  test("listed with its rejection reason, a malformed sidecar skipped; planned archive still goes through the normal search; no DATA_DIR path reaches a render", async () => {
    config.mode = "live";
    const story = newStory();
    const dir = retainedArchiveDir(story.slug);
    mkdirSync(dir, { recursive: true });
    const hash = sha(Buffer.from("retained bytes"));
    writeFileSync(
      path.join(dir, `${hash}.json`),
      JSON.stringify({
        status: "screened archive candidate",
        sha256: hash,
        file: `${hash}.jpg`,
        story: story.slug,
        title: "File:Hughes Glomar Explorer at sea.jpg",
        sourcePage: "https://commons.wikimedia.org/wiki/File:Hughes_Glomar_Explorer_at_sea.jpg",
        assetUrl: "https://upload.wikimedia.org/glomar-sea.jpg",
        license: "Public domain",
        credit: "U.S. Navy · Public domain",
        acquisitions: [{ at: "2026-09-01T00:00:00.000Z", query: "Hughes Glomar Explorer 1974", film: "long", owner: "long:L05" }],
        reviews: [{ at: "2026-09-01T00:01:00.000Z", film: "long", assetId: "L05", decision: "rejected", reason: "The photo shows the ship at sea, not under construction.", by: "final visual repair" }],
      }),
    );
    writeFileSync(path.join(dir, `${sha(Buffer.from("bad"))}.json`), "{ not json");
    const job = longFirstJob(story);
    await drive(job.id);
    expect(getJob(job.id)!.state).toBe("done");

    const cov = h.calls.find((c) => c.label === "long_coverage_plan")!;
    expect(cov.input).toContain("SCREENED ARCHIVE CANDIDATES (already acquired for this story; screened, NOT approved");
    expect(cov.input).toContain('- "File:Hughes Glomar Explorer at sea.jpg" (licence: Public domain; credit: U.S. Navy · Public domain)');
    expect(cov.input).toContain("found by: Hughes Glomar Explorer 1974");
    expect(cov.input).toContain("rejected for one slot before: The photo shows the ship at sea, not under construction.");
    expect(cov.input).not.toContain(hash); // no hash, path or DATA_DIR reaches the prompt
    expect(cov.input).not.toContain(DATA_DIR);
    expect(cov.input).not.toContain("archive-retained");
    expect(cov.instructions).toContain("SCREENED ARCHIVE CANDIDATES");

    // The planned archive is acquired by the normal search into the job's own working folder.
    expect(h.provider.some((p) => /^archive:long-\d\d\.jpg$/.test(p))).toBe(true);
    const owner = scratchOf(job.id).longShots.find((x: any) => x.archiveQuery && x.edit === "new");
    expect(owner.path).toMatch(new RegExp(`^jobs/${job.id}/archive/long-\\d\\d\\.jpg$`));
    const plans = JSON.stringify(Object.values(h.plans));
    expect(plans).not.toContain(DATA_DIR);
    expect(plans).not.toContain("archive-retained");
  });
});

describe("11. legacy pair-first jobs keep the pair path (the Project Azorian shape)", () => {
  // A job with no flow, produced the normal way (mock until the render, then the
  // live finish), exactly as the pair Final-film QC suite does.
  async function legacyAtFinal(answers: Record<string, string[]>) {
    const story = { ...paulBunyanStory, createdAt: new Date().toISOString() };
    upsertStory(story);
    const job = createJob({ id: newJobId(), storyId: story.id, mock: false, estimatedCost: 5, approvedMax: 10 });
    h.jobId = job.id;
    h.liveAfterRender = true;
    h.answers = answers;
    await runJob(job.id);
    approveTextForJob(job.id);
    await runJob(job.id);
    approveVisualsForJob(job.id);
    await runJob(job.id);
    return { job, story };
  }

  test("pair QC, pair repair eligibility, awaiting_final with nothing registered, pair Continue anyway through addVideos", async () => {
    // Long visual HUMAN_REVIEW with a Short factual concern: the pair repair rule
    // needs BOTH factual audits PASS, so no automatic repair is attempted.
    const { job, story } = await legacyAtFinal({ "long-visual": ["HUMAN_REVIEW"], "short-factual": ["HUMAN_REVIEW"] });
    expect(getJob(job.id)!.state).toBe("awaiting_final");
    expect(getJob(job.id)!.message).toBe("Final films need review");
    expect(labels()).toEqual(["long-factual", "long-visual", "short-factual", "short-visual"]);
    const qa = scratchOf(job.id).finalFilmQa;
    expect(Object.keys(qa).sort()).toEqual(["long", "outputsValidated", "short"]);
    expect(qa.visualRepair).toBeUndefined();
    expect(h.renders).toEqual([["long.mp4", "short.mp4"]]);
    expect(scratchOf(job.id).flow).toBeUndefined();
    expect(videosForStory(story.id).filter((x) => x.jobId === job.id)).toEqual([]);

    acceptFinalForJob(job.id);
    await runJob(job.id);
    expect(getJob(job.id)!.state).toBe("done");
    expect(videosForStory(story.id).filter((x) => x.jobId === job.id).map((x) => x.kind).sort()).toEqual(["long", "short"]);
    expect(scratchOf(job.id).longComplete).toBeUndefined();
    expect(longCompleteJobIds(story.id)).not.toContain(job.id);
    expect(h.scans).toEqual([]); // never treated as a Long-first job
  });
});

describe("flow authority: the job's flow, never its draft's shape, selects the Long-only text helpers", () => {
  // A job at the text gate whose saved draft is the Long alone. Without the flow
  // it is an old, partial or malformed pair-first job; with it, a Long-first job.
  function atTextGate(flow: boolean) {
    const story = newStory();
    const job = createJob({ id: newJobId(), storyId: story.id, mock: false, estimatedCost: 5, approvedMax: 50, ...(flow ? { scratch: { flow: "long-first" } } : {}) });
    h.jobId = job.id;
    updateJob(job.id, { state: "awaiting_text", step: "scripts", scratch: { ...job.scratch, research: structuredClone(paulBunyanResearch), scriptParts: { long: LONG }, scripts: { long: LONG } } as any });
    return { job, story };
  }

  // The model answers in the shape the selected prompt asks for: a REPAIR, a
  // revision and an audit (the pair's carry a Short), then a PASS.
  async function withAnswers<T>(run: () => Promise<T>): Promise<T> {
    const repair = { decision: "REPAIR", summary: "One fix.", repairFeedback: "Tighten the hook to the first event.", humanReview: [] };
    const answers: Record<string, unknown> = {
      text_qa: repair,
      long_text_qa: repair,
      story_revision: { title: "T", hook: "H", moments: [], facts: [], long: LONG, short: "The pair model's Short." },
      long_story_revision: { title: "T", hook: "H", moments: [], facts: [], long: LONG },
      script_audit: { long: LONG, short: "The pair model's Short." },
      text_verify: { decision: "PASS", summary: "Fixed.", humanReview: [] },
    };
    const original = h.respond!;
    h.respond = async (opts) => {
      if (!(opts.schemaName in answers)) return original(opts);
      h.calls.push({ label: opts.schemaName, input: String(opts.input), instructions: String(opts.instructions), images: 0 });
      return answers[opts.schemaName];
    };
    try {
      return await run();
    } finally {
      h.respond = original;
    }
  }

  test("A + B. a NO-FLOW job whose draft lacks a Short stays pair-first: Text QA review, revision, audit and verification are the pair helpers", async () => {
    config.mode = "live";
    const { job } = atTextGate(false);
    const state = await withAnswers(() => autoTextQaForJob(job.id));
    expect(state?.status).toBe("passed");
    // Passed (after the one repair) is not approved: the job waits for the human.
    expect(getJob(job.id)!.state).toBe("awaiting_text");
    expect(scratchOf(job.id).textApproved).toBeUndefined();
    expect(h.provider).toEqual([]);
    expect(h.helpers).toEqual(["reviewStoryDraft", "reviseStoryText", "auditScripts", "verifyStoryDraft"]);
    for (const name of ["reviewLongDraft", "verifyLongDraft", "reviseLongText", "auditLongScript"]) expect(h.helpers).not.toContain(name);
    expect(labels()).toEqual(["text_qa", "story_revision", "script_audit", "text_verify"]);
    expect(h.calls[0].instructions).toBe(s.TEXT_QA_INSTRUCTIONS); // the pair prompt, not the Long-only one
    expect(scratchOf(job.id).flow).toBeUndefined();
    expect(h.scans).toEqual([]); // never handled as a Long-first job
  });

  test("B. revision at the text gate of that NO-FLOW job: the pair revision, then the pair audit", async () => {
    config.mode = "live";
    const { job } = atTextGate(false);
    await withAnswers(() => g.reviseTextForJob(job.id, "Tighten the hook to the first event."));
    expect(h.helpers).toEqual(["reviseStoryText", "auditScripts"]);
    expect(labels()).toEqual(["story_revision", "script_audit"]);
    expect(scratchOf(job.id).flow).toBeUndefined();
    expect(h.scans).toEqual([]);
  });

  test("a real Long-first job with the same draft takes the Long-only helpers, and the story's stored scripts stay the Long alone", async () => {
    config.mode = "live";
    const { job, story } = atTextGate(true);
    const state = await withAnswers(() => autoTextQaForJob(job.id));
    expect(state?.status).toBe("passed");
    expect(getJob(job.id)!.state).toBe("awaiting_text"); // not approved: waiting for the human
    expect(scratchOf(job.id).textApproved).toBeUndefined();
    expect(h.provider).toEqual([]); // no narration or media
    expect(h.helpers).toEqual(["reviewLongDraft", "reviseLongText", "auditLongScript", "verifyLongDraft"]);
    expect(labels()).toEqual(["long_text_qa", "long_story_revision", "long_script_audit", "long_text_verify"]);
    expect(scratchOf(job.id).scripts).toEqual({ long: LONG });
    expect(store.getScripts(story.id)).toEqual({ long: LONG });
    expectNoShort(job.id, story.slug);
  });
});

describe("the human text gate: Automatic Text QA PASS never approves a Long-first draft", () => {
  test("PASS waits at awaiting_text, shown as passed and still up for review; only Approve & continue starts the Long's narration", async () => {
    config.mode = "live";
    const story = newStory();
    const job = longFirstJob(story);
    expect(await runJob(job.id)).toBe("text_gate");
    expect(await autoTextQaForJob(job.id)).toEqual({ status: "passed" });
    expect(labels().slice(-1)).toEqual(["long_text_qa"]); // one review, no repair
    const waiting = getJob(job.id)!;
    expect(waiting.state).toBe("awaiting_text");
    expect((waiting.scratch as any).textApproved).toBeUndefined();
    expect(h.provider).toEqual([]); // no narration, image, archive or motion

    const app = Fastify();
    await registerRoutes(app);
    const pub = (await app.inject({ method: "GET", url: `/api/jobs/${job.id}` })).json().job;
    expect(pub).toMatchObject({ state: "awaiting_text", flow: "long-first", textQa: { status: "passed" }, review: { longScript: LONG } });
    expect("shortScript" in pub.review).toBe(false);
    await app.close();

    expect(await runJob(job.id)).toBeUndefined(); // a resume at the gate starts nothing
    expect(h.provider).toEqual([]);
    approveTextForJob(job.id); // what the approve-text route does: the human Approve & continue
    expect(await runJob(job.id)).toBe("preview_gate");
    expect(h.provider.filter((p) => p.startsWith("tts:"))).toEqual(["tts:long.mp3"]);
    expectNoShort(job.id, story.slug);
  });
});

describe("a manual revision invalidates the last Text QA result (Long-first)", () => {
  test("PASS, then a successful manual revision: the old PASS is cleared, the Long-only Text QA checks the NEW Long, stories.scripts stays { long }", async () => {
    config.mode = "live";
    const story = newStory();
    const job = longFirstJob(story);
    expect(await runJob(job.id)).toBe("text_gate");
    expect(await autoTextQaForJob(job.id)).toEqual({ status: "passed" });

    const REVISED = `${LONG}\n\nOne revised closing line.`;
    const original = h.respond!;
    h.respond = async (opts) => {
      if (opts.schemaName !== "long_story_revision" && opts.schemaName !== "long_script_audit") return original(opts);
      h.calls.push({ label: opts.schemaName, input: String(opts.input), instructions: String(opts.instructions), images: 0 });
      return opts.schemaName === "long_script_audit" ? { long: REVISED } : { title: story.title, hook: story.hook, moments: [], facts: [], long: REVISED };
    };
    const app = Fastify();
    await registerRoutes(app);
    try {
      const res = await app.inject({ method: "POST", url: `/api/jobs/${job.id}/revise-text`, payload: { feedback: "Close on the strangest fact." } });
      expect(res.statusCode).toBe(200);
      expect(res.json().job.textQa).toEqual({ status: "running", phase: "review" });
      for (let i = 0; i < 200 && g.textQaState(job.id)?.status === "running"; i++) await new Promise((r) => setTimeout(r, 5));
    } finally {
      h.respond = original;
    }

    expect(labels().slice(-3)).toEqual(["long_story_revision", "long_script_audit", "long_text_qa"]);
    expect(h.helpers.slice(-3)).toEqual(["reviseLongText", "auditLongScript", "reviewLongDraft"]);
    expect(h.calls.at(-1)!.input).toContain(`LONG SCRIPT:\n${REVISED}`);
    expect(h.calls.at(-1)!.input).not.toMatch(/SHORT/);
    const pub = (await app.inject({ method: "GET", url: `/api/jobs/${job.id}` })).json().job;
    expect(pub).toMatchObject({ state: "awaiting_text", flow: "long-first", textQa: { status: "passed" }, review: { longScript: REVISED } });
    expect("shortScript" in pub.review).toBe(false);
    await app.close();
    expect(scratchOf(job.id).textApproved).toBeUndefined();
    expect(scratchOf(job.id).scripts).toEqual({ long: REVISED });
    expect(store.getScripts(story.id)).toEqual({ long: REVISED });
    expect(h.provider).toEqual([]); // no narration or media
    expectNoShort(job.id, story.slug);
  });
});

describe("12. a Long-first job's media live in its own jobs/<jobId>/ workspace; a legacy job keeps the story root", () => {
  // An earlier production of the same story, at the story root as a legacy job
  // left it (the old Crijnssen shape): every stage of a new Long-first job must
  // leave these bytes exactly as they were.
  const OLD_FILES = [
    "audio/long.mp3",
    "audio/short.mp3",
    "images/hero.png",
    ...Array.from({ length: 40 }, (_, i) => `images/long-${String(i).padStart(2, "0")}.png`),
    "images/short-00.png",
    "archive/long-01.jpg",
    "archive/short-02.jpg",
    "motion/long-02.mp4",
    "motion/long-02.mp4.req.json",
    "renders/long.mp4",
    "renders/short.mp4",
  ];
  function seedOldProduction(slug: string): Map<string, string> {
    const before = new Map<string, string>();
    for (const rel of OLD_FILES) {
      const abs = inStory(slug, rel);
      mkdirSync(path.dirname(abs), { recursive: true });
      writeFileSync(abs, `OLD PRODUCTION ${rel}`);
      before.set(rel, sha(readFileSync(abs)));
    }
    return before;
  }
  function expectOldUntouched(slug: string, before: Map<string, string>): void {
    for (const [rel, hash] of before) {
      expect(existsSync(inStory(slug, rel)), rel).toBe(true);
      expect(sha(readFileSync(inStory(slug, rel))), rel).toBe(hash);
    }
  }
  const stillShot = (index: number, extra: Record<string, unknown> = {}) =>
    ({ index, edit: "new", truth: "reconstruction", prompt: `A scene ${index}.`, assetId: `L${index}`, presentation: "base", motion: "hold", ...extra }) as any;

  test("the prefix: jobs/<jobId> for a Long-first job, empty for a legacy job; a job id that could escape the folder is refused", () => {
    expect(productionMediaPrefix("abc", true)).toBe("jobs/abc");
    expect(productionMediaPrefix("abc", false)).toBe("");
    expect(productionRel("jobs/abc", "images/hero.png")).toBe("jobs/abc/images/hero.png");
    expect(productionRel("", "images/hero.png")).toBe("images/hero.png");
    for (const bad of ["../x", "a/b", "", "a b"]) expect(() => productionMediaPrefix(bad, true)).toThrow(/cannot name a media folder/);
  });

  test("1, 2. every writer puts a Long-first job's file under jobs/<jobId>/ and a legacy job's at the story root, exactly as before", async () => {
    config.mode = "live";
    for (const [prefix, at] of [["jobs/abc", "jobs/abc/"], ["", ""]] as const) {
      const story = newStory();
      ensureProductionDirs(story.slug, prefix);
      const nar = await recordNarration(story.slug, "long", "One short line.", prefix);
      expect(nar.audioRel).toBe(`${at}audio/long.mp3`);
      expect(nar.audioMediaRel).toBe(`stories/${story.slug}/${at}audio/long.mp3`);
      expect(await v.ensureMaster(story, paulBunyanResearch.world, prefix)).toBe(`${at}images/hero.png`);
      const still = stillShot(0);
      expect(await v.acquireStill(story, "long", still, null, new Map(), undefined, undefined, "job", prefix)).toBe("generated");
      expect(still.path).toBe(`${at}images/long-00.png`);
      const archive = stillShot(1, { truth: "archive", archiveQuery: "Hughes Glomar Explorer 1974" });
      expect(await v.acquireStill(story, "long", archive, null, new Map(), undefined, undefined, "job", prefix)).toBe("archive");
      expect(archive.path).toBe(`${at}archive/long-01.jpg`);
      await v.acquireMotion(story, "long", still, prefix);
      expect(still.motionPath).toBe(`${at}motion/long-00.mp4`);
      for (const rel of [nar.audioRel, `${at}images/hero.png`, still.path, archive.path, still.motionPath]) expect(existsSync(inStory(story.slug, rel)), rel).toBe(true);
    }
  });

  test("3. clearing a Long-first job's working visuals touches its own workspace only; the legacy clear keeps its old story-root semantics", () => {
    const story = newStory();
    const before = seedOldProduction(story.slug);
    const mine = "jobs/new-job";
    ensureProductionDirs(story.slug, mine);
    for (const rel of ["images/hero.png", "images/long-00.png", "images/short-03.webp", "archive/long-01.jpg", "motion/long-00.mp4", "audio/long.mp3", "renders/long.mp4"]) writeFileSync(inStory(story.slug, `${mine}/${rel}`), "new");
    clearWorkingVisuals(story.slug, mine);
    expectOldUntouched(story.slug, before);
    const left = files(story.slug).filter((f) => f.startsWith(`${mine}/`)).sort();
    expect(left).toEqual([`${mine}/audio/long.mp3`, `${mine}/images/hero.png`, `${mine}/renders/long.mp4`]);
    for (const sub of ["archive", "images", "motion", "audio", "renders"]) expect(existsSync(inStory(story.slug, `${mine}/${sub}`))).toBe(true);

    // The legacy clear is what it always was: story-root shot stills, archive and
    // motion go; hero, audio and renders stay; a job workspace is not its business.
    clearWorkingVisuals(story.slug);
    const root = files(story.slug).filter((f) => !f.startsWith("jobs/")).sort();
    expect(root).toEqual(["audio/long.mp3", "audio/short.mp3", "images/hero.png", "renders/long.mp4", "renders/short.mp4"]);
    expect(files(story.slug).filter((f) => f.startsWith(`${mine}/`)).sort()).toEqual(left);
  });

  test("4. an old story-root still is never taken as a Long-first job's own (a legacy job still reuses it, as before)", async () => {
    const story = newStory();
    const before = seedOldProduction(story.slug);
    config.mode = "mock";
    const scoped = stillShot(0);
    expect(await v.acquireStill(story, "long", scoped, null, new Map(), undefined, undefined, "abc", "jobs/abc")).toBe("mock");
    expect(scoped.path).toBe("jobs/abc/images/long-00.png");
    config.mode = "live";
    const live = stillShot(1);
    expect(await v.acquireStill(story, "long", live, null, new Map(), undefined, undefined, "abc", "jobs/abc")).toBe("generated");
    expect(live.path).toBe("jobs/abc/images/long-01.png");
    expectOldUntouched(story.slug, before);
    const legacy = stillShot(2);
    expect(await v.acquireStill(story, "long", legacy, null, new Map(), undefined, undefined, "legacy")).toBe("existing");
    expect(legacy.path).toBe("images/long-02.png");
  });

  test("1, 5, 6, 10. a whole live Long-first run next to an earlier production: every file in jobs/<jobId>/, the preview and the registered Video there too, the old bytes untouched, no Short", async () => {
    config.mode = "live";
    const story = newStory();
    const before = seedOldProduction(story.slug);
    const job = longFirstJob(story);
    const at = `jobs/${job.id}/`;
    expect(await runJob(job.id)).toBe("text_gate");
    await autoTextQaForJob(job.id);
    approveTextForJob(job.id);
    expect(await runJob(job.id)).toBe("preview_gate");
    // The preview the person reviews serves the job's own stills.
    const preview = JSON.stringify(getJob(job.id)!.preview);
    expect(preview).toContain(`stories/${story.slug}/${at}images/`);
    expect(preview).not.toMatch(new RegExp(`stories/${story.slug}/(images|archive|motion)/`));
    await drive(job.id);
    expect(getJob(job.id)!.state).toBe("done");

    const s = scratchOf(job.id);
    expect(s.narration.long.audioRel).toBe(`${at}audio/long.mp3`);
    expect(s.narration.long.audioMediaRel).toBe(`stories/${story.slug}/${at}audio/long.mp3`);
    expect(s.masterRef).toBe(`${at}images/hero.png`);
    for (const shot of s.longShots) {
      expect(shot.path.startsWith(at), shot.path).toBe(true);
      if (shot.motionPath) expect(shot.motionPath).toMatch(new RegExp(`^${at}motion/long-\\d\\d\\.mp4$`));
    }
    expect(s.longShots.some((x: any) => isProductionMedia(x.path, "archive"))).toBe(true);
    // The render: the job's file, from a plan whose every asset is the job's.
    const out = inStory(story.slug, `${at}renders/long.mp4`);
    expect(Object.keys(h.plans)).toContain(out);
    expect(Object.keys(h.plans).filter((k) => k.startsWith(storyDir(story.slug)))).toEqual([out]);
    const plan = h.plans[out];
    expect(plan.audio).toBe(`${at}audio/long.mp3`);
    expect(JSON.stringify(plan)).not.toMatch(/"(images|archive|motion|audio)\//);
    expect(videosForStory(story.id).map((x) => x.path)).toEqual([`stories/${story.slug}/${at}renders/long.mp4`]);

    // Everything this job wrote is in its workspace; the earlier production is untouched.
    const written = files(story.slug).filter((f) => !before.has(f));
    expect(written.length).toBeGreaterThan(0);
    expect(written.filter((f) => !f.startsWith(at))).toEqual([]);
    for (const rel of ["audio/long.mp3", "images/hero.png"]) expect(written).toContain(`${at}${rel}`);
    expect(written.some((f) => new RegExp(`^${at}images/long-\\d\\d\\.png$`).test(f))).toBe(true);
    expect(written.some((f) => new RegExp(`^${at}archive/long-\\d\\d\\.jpg$`).test(f))).toBe(true);
    expect(written.some((f) => new RegExp(`^${at}motion/long-\\d\\d\\.mp4$`).test(f))).toBe(true);
    expect(written.filter((f) => /short/i.test(f))).toEqual([]);
    expectOldUntouched(story.slug, before);
    expect(getJob(job.id)!.spent).toBe(expectedSpend());
    expect(h.scans.flat()).toEqual([]);
  });

  test("7. a crash mid-stills resumes from the job's saved paths; no story-root file is ever adopted as the job's work", async () => {
    config.mode = "live";
    const story = newStory();
    const before = seedOldProduction(story.slug);
    const job = longFirstJob(story);
    h.crash = { label: "image", nth: 4 };
    await drive(job.id);
    expect(getJob(job.id)!.state).toBe("failed");
    const saved = (h.snapshot.scratch.longShots as any[]).filter((x) => x.path).map((x) => x.path);
    expect(saved.length).toBeGreaterThan(0);
    expect(saved.every((p: string) => p.startsWith(`jobs/${job.id}/`))).toBe(true);
    updateJob(job.id, { ...h.snapshot });
    await drive(job.id);
    expect(getJob(job.id)!.state).toBe("done");
    const shots = scratchOf(job.id).longShots as any[];
    expect(shots.every((x) => x.path.startsWith(`jobs/${job.id}/`))).toBe(true);
    for (const p of saved) expect(shots.some((x) => x.path === p)).toBe(true); // the saved stills, kept
    const images = h.provider.filter((p) => p.startsWith("image:"));
    expect(new Set(images).size).toBe(images.length); // none made twice
    expectOldUntouched(story.slug, before);
  });

  test("8, 9. a scoped generated still is regenerable, regenerates in place, and a scoped archive seeds the ledger", async () => {
    config.mode = "live";
    const story = newStory();
    const before = seedOldProduction(story.slug);
    const job = longFirstJob(story);
    await runJob(job.id);
    approveTextForJob(job.id);
    expect(await runJob(job.id)).toBe("preview_gate");
    const shots = scratchOf(job.id).longShots as any[];
    const targets = aq.assetQaTargets("long", shots);
    const gen = targets.find((t) => t.truth === "reconstruction")!;
    expect(gen.path.startsWith(`jobs/${job.id}/images/`)).toBe(true);
    expect(gen.regenerable).toBe(true);
    const arc = targets.find((t) => t.truth === "archive")!;
    expect(arc.path.startsWith(`jobs/${job.id}/archive/`)).toBe(true);
    expect(arc.regenerable).toBe(false);

    writeFileSync(inStory(story.slug, gen.path), "before regeneration");
    await g.regenerateStill(job.id, "long", gen.owner, "Calmer sea.");
    const after = (scratchOf(job.id).longShots as any[]).find((x) => x.index === gen.owner);
    expect(after.path).toBe(gen.path); // replaced in place, inside the workspace
    expect(readFileSync(inStory(story.slug, gen.path), "utf8")).toBe(`still ${path.basename(gen.path)}`);

    const ledger = v.seedArchiveLedger(story, [["long", shots]]);
    expect([...ledger.values()]).toEqual([v.archiveOwner("long", shots.find((x) => x.path === arc.path))]);
    expect(isProductionMedia(`jobs/${job.id}/images/long-00.png`, "images")).toBe(true);
    expect(isProductionMedia("images/long-00.png", "images")).toBe(true);
    expect(isProductionMedia(`jobs/${job.id}/archive/long-01.jpg`, "archive")).toBe(true);
    for (const no of ["xjobs/a/images/x.png", "jobs/a/b/images/x.png", "jobs/../images/x.png", "jobs/a/images/sub/x.png", "notimages/x.png", "archive/long-01.jpg"]) expect(isProductionMedia(no, "images"), no).toBe(false);
    expectOldUntouched(story.slug, before);
  });

  test("2. a legacy pair-first job keeps every story-root path: narration, master, stills, renders and its Video rows", async () => {
    const story = newStory();
    const job = createJob({ id: newJobId(), storyId: story.id, mock: false, estimatedCost: 5, approvedMax: 50 });
    h.jobId = job.id;
    h.liveAfterRender = true; // mock until the render, then the live finish, as the pair suites run it
    await runJob(job.id);
    approveTextForJob(job.id);
    await runJob(job.id);
    approveVisualsForJob(job.id);
    await runJob(job.id);
    expect(getJob(job.id)!.state).toBe("done");
    const s = scratchOf(job.id);
    expect(s.flow).toBeUndefined();
    expect([s.narration.long.audioRel, s.narration.short.audioRel]).toEqual(["audio/long.wav", "audio/short.wav"]);
    expect(s.masterRef).toBe("images/hero.png");
    for (const shot of [...s.longShots, ...s.shortShots]) expect(shot.path).toMatch(/^images\/(long|short)-\d\d\.png$/);
    expect(Object.keys(h.plans).filter((k) => k.startsWith(storyDir(story.slug))).sort()).toEqual([inStory(story.slug, "renders/long.mp4"), inStory(story.slug, "renders/short.mp4")].sort());
    expect(videosForStory(story.id).map((x) => x.path).sort()).toEqual([`stories/${story.slug}/renders/long.mp4`, `stories/${story.slug}/renders/short.mp4`]);
    expect(files(story.slug).filter((f) => f.startsWith("jobs/"))).toEqual([]);
  });
});
