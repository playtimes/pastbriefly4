import { describe, test, expect, vi, beforeEach } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

// Film #5: the finished-film visual audit flagged repeated pictures, several of
// which were generated reconstructions standing in for archive that acquisition
// could not find. ONE bounded repair: another archive search for exactly those
// assets, the existing Pixel Asset QA on what it finds, then only the changed
// film re-rendered and re-audited. Jobs go the normal way to the render in mock
// mode; the render stub switches PB4 to live for the finish. Nothing reaches a
// provider: rendering, probing, frame sampling, Commons and every model are stubbed.
const tmp = mkdtempSync(path.join(os.tmpdir(), "pb4-final-repair-"));
process.env.PROVIDER_MODE = "mock";
process.env.PB4_DATA_DIR = path.join(tmp, "data");
process.env.PB4_MEDIA_DIR = path.join(tmp, "media");
process.env.OPENAI_API_KEY = "test-key";

type Kind = "long" | "short";
type Answer = "PASS" | "HUMAN_REVIEW" | "crash";

const h = vi.hoisted(() => ({
  jobId: "",
  liveAfterRender: true,
  failRepairRender: false,
  rendered: [] as string[][], // the films each renderFilms call rendered
  plans: {} as Record<string, any>,
  answers: {} as Record<string, Answer[]>, // per specialist label, one answer per call in order
  targets: { long: [] as string[], short: [] as string[] }, // assets a visual HUMAN_REVIEW points at
  pixel: {} as Record<string, "PASS" | "HUMAN_REVIEW">,
  cells: { long: null as number[] | null, short: null as number[] | null }, // explicit issue cells
  sequence: "first" as "first" | "keep" | "invalid" | "crash" | "graphic", // the one sequence revision's answer
  graphicPick: "", // "graphic": the (never offered) presentation the answer puts on its first slot
  verifyFlag: [] as number[], // slots the Director verification flags
  revisions: [] as any[],
  found: new Set<string>(), // "long:L05": Commons finds an archive for this asset
  commons: [] as { query: string; asset: string }[],
  calls: [] as { label: string; spent: number }[],
  snapshot: null as any,
}));

const outKind = (p: string): Kind => (p.endsWith("long.mp4") ? "long" : "short");

vi.mock("../src/render/renderVideo.ts", async (orig) => ({
  ...(await orig<typeof import("../src/render/renderVideo.ts")>()),
  renderFilms: vi.fn(async (_dir: string, films: Array<{ plan: any; outPath: string }>) => {
    if (h.failRepairRender && h.rendered.length) throw new Error("render crashed");
    h.rendered.push(films.map((f) => outKind(f.outPath)));
    for (const f of films) h.plans[f.outPath] = f.plan;
    const { config } = await import("../src/server/config.ts");
    if (h.liveAfterRender) config.mode = "live";
  }),
  probeVideo: vi.fn((file: string) => {
    const p = h.plans[file];
    if (!p) throw new Error(`ffprobe: ${file}: No such file or directory`);
    return { width: p.width, height: p.height, durationSec: p.durationInFrames / p.fps + 0.03, fps: 30, hasAudio: true };
  }),
}));

vi.mock("../src/production/mockAssets.ts", async (orig) => {
  const fs = await import("node:fs");
  const nodePath = await import("node:path");
  return {
    ...(await orig<typeof import("../src/production/mockAssets.ts")>()),
    writePlaceholderStill: (outPath: string) => {
      fs.mkdirSync(nodePath.dirname(outPath), { recursive: true });
      fs.writeFileSync(outPath, "img");
    },
  };
});

vi.mock("../src/render/contactSheet.ts", async (orig) => ({
  ...(await orig<typeof import("../src/render/contactSheet.ts")>()),
  sampledFrames: (_videoPath: string, kind: Kind) => Array.from({ length: kind === "long" ? 24 : 12 }, (_, i) => ({ cell: i + 1, timeSec: i + 0.5, jpeg: Buffer.from([0xff, 0xd8, 0xff]) })),
}));

// Commons: finds an archive only for the assets in h.found; the file it writes is the proof.
vi.mock("../src/production/wikimedia.ts", async (orig) => ({
  ...(await orig<typeof import("../src/production/wikimedia.ts")>()),
  fetchArchive: vi.fn(async (query: string, dest: string) => {
    const { getJob } = await import("../src/server/store.ts");
    const m = dest.split(path.sep).join("/").match(/archive\/(long|short)-(\d+)\.jpg$/)!;
    const kind = m[1] as Kind;
    const s = getJob(h.jobId)!.scratch as any;
    const asset = (kind === "long" ? s.longShots : s.shortShots)[Number(m[2])].assetId;
    h.commons.push({ query, asset: `${kind}:${asset}` });
    if (!h.found.has(`${kind}:${asset}`)) return null;
    writeFileSync(dest, `archive bytes ${kind}:${asset}`);
    return { sourcePage: "https://commons.wikimedia.org/wiki/File:X.jpg", assetUrl: "https://upload.wikimedia.org/x.jpg", credit: `US Navy · Public domain (${asset})`, license: "Public domain", localPath: dest, sha256: `sha-${kind}-${asset}` };
  }),
}));

vi.mock("../src/providers/openai.ts", async (orig) => {
  const real = await orig<typeof import("../src/providers/openai.ts")>();
  return {
    ...real,
    respondJson: vi.fn(async (opts: any) => {
      const { getJob } = await import("../src/server/store.ts");
      const { causalClaims } = await import("../src/production/finalFilmQa.ts");
      const job = getJob(h.jobId)!;
      const s = job.scratch as any;
      if (opts.schemaName === "asset_qa") {
        h.calls.push({ label: "asset-qa", spent: job.spent });
        const ids: string[] = opts.schema.properties.assets.required;
        return { assets: Object.fromEntries(ids.map((id) => [id, { decision: h.pixel[id] ?? "PASS", reason: h.pixel[id] === "HUMAN_REVIEW" ? "The photo shows a different ship." : "", repairFeedback: null }])), summary: "" };
      }
      if (opts.schemaName === "sequence_revision") {
        h.calls.push({ label: "sequence", spent: job.spent });
        h.revisions.push(opts);
        if (h.sequence === "crash") {
          h.snapshot = job;
          throw new Error("process killed");
        }
        if (h.sequence === "invalid") return { changes: "not a map", unresolved: [] };
        const keys = Object.entries(opts.schema.properties.changes.properties);
        if (h.sequence === "graphic") return { changes: Object.fromEntries(keys.map(([id], i) => [id, i === 0 ? h.graphicPick : null])), unresolved: [] };
        return { changes: Object.fromEntries(keys.map(([id, p]: any) => [id, h.sequence === "keep" ? null : p.enum[0]])), unresolved: [] };
      }
      if (opts.schemaName === "director_verify") {
        h.calls.push({ label: "verify", spent: job.spent });
        return { humanReview: Object.fromEntries(h.verifyFlag.map((s) => [String(s), "It no longer shows what the narration says."])), summary: "" };
      }
      const kind: Kind = /FILM: LONG/.test(opts.input) ? "long" : "short";
      const specialist = opts.schemaName === "final_film_factual_audit" ? "factual" : "visual";
      const label = `${kind}-${specialist}`;
      h.calls.push({ label, spent: job.spent });
      const answer = h.answers[label]?.shift() ?? "PASS";
      if (answer === "crash") {
        h.snapshot = job;
        throw new Error("process killed");
      }
      const review = answer === "HUMAN_REVIEW";
      if (specialist === "factual") {
        const checks = causalClaims(s.scripts[kind]).map((c: any) => ({ text: c.text, verdict: "SUPPORTED_DIRECTLY", reason: "The sources state it.", evidenceUrls: ["https://example.org/source"] }));
        return { causalChecks: checks, issues: review ? [{ reason: "It overstates the cause.", text: `${kind} fragment` }] : [], decision: answer, summary: "" };
      }
      const n = opts.images.length;
      const cells = review ? issueCells(kind, n) : [];
      return {
        cellObservations: Array.from({ length: n }, (_, i) => ({ cell: i + 1, description: "a ship at sea" })),
        families: review ? [{ name: "ship at sea", description: "the same ship", cells }] : [],
        issues: review ? [{ reason: `The same ship keeps returning across the ${kind}.`, cells }] : [],
        decision: answer,
        summary: "",
      };
    }),
  };
});

const { runJob, newJobId, approveTextForJob, approveVisualsForJob, acceptFinalForJob, resumeFinalVisualRepairForJob } = await import("../src/production/generate.ts");
const { createJob, getJob, updateJob, upsertStory, videosForStory, resumableJobIds } = await import("../src/server/store.ts");
const { config } = await import("../src/server/config.ts");
const { PRICING, assetReviewUsd, round } = await import("../src/server/pricing.ts");
const { cellTimes } = await import("../src/render/contactSheet.ts");
const { issueAssets, cellSlots } = await import("../src/production/finalFilmQa.ts");
const v = await import("../src/production/visuals.ts");
const { inStory } = await import("../src/production/paths.ts");
const { paulBunyanStory } = await import("../src/production/fixtures/paulBunyan.ts");
const Fastify = (await import("fastify")).default;
const { registerRoutes } = await import("../src/server/routes.ts");

const FACT = PRICING.openai.finalFactualReview;
const LOOK = PRICING.openai.finalVisualReview;
const FOUR = round(2 * (FACT + LOOK));
const story = { ...paulBunyanStory, createdAt: new Date().toISOString() };
upsertStory(story);

type Shot = import("../src/production/visuals.ts").PlannedShot;
const scratchOf = (id: string) => getJob(id)!.scratch as any;
const shotsOf = (id: string, kind: Kind): Shot[] => scratchOf(id)[kind === "long" ? "longShots" : "shortShots"];
const labels = () => h.calls.map((c) => c.label);
// Without the sequence stage (the archive-only tests answer it with no change).
const archiveLabels = () => labels().filter((l) => l !== "sequence");
const SEQ = PRICING.openai.visualPlan;
const seqSpend = () => round(labels().filter((l) => l === "sequence" || l === "verify").length * SEQ);
const repairOf = (id: string) => scratchOf(id).finalFilmQa.visualRepair;
const renderPath = (kind: Kind) => inStory(story.slug, `renders/${kind}.mp4`);

// The film's cell times exactly as the finish computes them (the probed duration).
function times(kind: Kind, shots?: Shot[]): number[] {
  const plan = h.plans[renderPath(kind)] ?? v.buildRenderPlan(kind, story, shots!, scratchOf(h.jobId).narration[kind], v.accentFor(story.category));
  return cellTimes(plan.durationInFrames / plan.fps + 0.03, kind);
}
// The cells showing h.targets[kind] (at least two, as the audit requires).
function issueCells(kind: Kind, n: number): number[] {
  if (h.cells[kind]) return h.cells[kind]!;
  const shots = shotsOf(h.jobId, kind);
  const t = times(kind);
  const mine = t.map((_, i) => i + 1).filter((c) => h.targets[kind].includes(issueAssets(shots, t, [c])[0]));
  const cells = [...mine];
  for (const c of [1, n, 2]) if (cells.length < 2 && !cells.includes(c)) cells.push(c);
  return cells.sort((a, b) => a - b);
}

// Make `count` owner assets of one film archive fallbacks: planned as archive
// (archiveQuery kept), now reconstructions on their generated stills, only ever
// shown as a base, each sampled by at least one cell. Returns their ids, most
// sampled first. `motion`: the first one also owns a reconstruction motion clip.
function plantFallbacks(id: string, kind: Kind, count: number, opts: { motion?: boolean } = {}): string[] {
  const shots = shotsOf(id, kind);
  const t = times(kind, shots);
  const sampled = new Map<string, number>();
  t.forEach((_, i) => {
    const a = issueAssets(shots, t, [i + 1])[0];
    sampled.set(a, (sampled.get(a) ?? 0) + 1);
  });
  const eligible = shots
    .filter((s) => s.edit === "new" && !s.wantsMotion && s.path?.startsWith("images/") && shots.filter((u) => u.assetId === s.assetId).every((u) => u.presentation === "base") && sampled.has(s.assetId))
    .sort((a, b) => sampled.get(b.assetId)! - sampled.get(a.assetId)!)
    .slice(0, count)
    .map((s) => s.assetId);
  expect(eligible).toHaveLength(count);
  for (const s of shots) {
    if (!eligible.includes(s.assetId)) continue;
    s.truth = "reconstruction";
    s.archiveQuery = `archive query ${s.assetId}`;
    delete s.source;
    if (opts.motion && s.assetId === eligible[0] && s.edit === "new") {
      s.wantsMotion = true;
      s.motionPath = `motion/${kind}-${String(s.index).padStart(2, "0")}.mp4`;
      mkdirSync(path.dirname(inStory(story.slug, s.motionPath)), { recursive: true });
      writeFileSync(inStory(story.slug, s.motionPath), "reconstruction motion");
    }
  }
  const s = scratchOf(id);
  s[kind === "long" ? "longShots" : "shortShots"] = shots;
  updateJob(id, { scratch: s });
  return eligible;
}

beforeEach(() => {
  config.mode = "mock";
  h.liveAfterRender = true;
  h.failRepairRender = false;
  h.rendered = [];
  h.answers = {};
  h.targets = { long: [], short: [] };
  h.pixel = {};
  h.cells = { long: null, short: null };
  h.sequence = "keep"; // archive-only tests: the sequence stage changes nothing
  h.graphicPick = "";
  h.verifyFlag = [];
  h.revisions = [];
  h.found = new Set();
  h.commons = [];
  h.calls = [];
  h.snapshot = null;
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

// A fresh job the normal way to its visual gate, approved; `plant` then shapes
// the saved plan; the final run does motion, render and the (live) finish.
async function produce(plant: (id: string) => void = () => {}, approvedMax = 5): Promise<string> {
  config.mode = "mock";
  const job = createJob({ id: newJobId(), storyId: story.id, mock: false, estimatedCost: 5, approvedMax });
  h.jobId = job.id;
  await runJob(job.id);
  approveTextForJob(job.id);
  await runJob(job.id);
  approveVisualsForJob(job.id);
  plant(job.id);
  await runJob(job.id);
  return job.id;
}
// Flag only Long cells that show motion slots: nothing a repair may move.
function flagMotionOnly(jid: string): void {
  const shots = shotsOf(jid, "long");
  const t = times("long", shots);
  h.cells.long = t.map((_, i) => i + 1).filter((c) => shots.find((s) => s.index === cellSlots(shots, t, [c])[0].slot)!.wantsMotion);
}
// Flag the non-motion cells, spread across the film, that show the film's most sampled asset.
function flagRepeats(jid: string, kind: Kind): void {
  const shots = shotsOf(jid, kind);
  const t = times(kind, shots);
  const rows = cellSlots(shots, t, t.map((_, i) => i + 1));
  const count = new Map<string, number>();
  for (const r of rows) count.set(r.assetId, (count.get(r.assetId) ?? 0) + 1);
  const top = [...count].sort((a, b) => b[1] - a[1])[0][0];
  h.cells[kind] = rows.filter((r) => r.assetId === top).map((r) => r.cell);
  if (h.cells[kind]!.length < 2) h.cells[kind] = [rows[0].cell, rows[rows.length - 1].cell];
}
// Also flag every cell that shows the film's planted archive fallback (h.targets).
function flagFallbacks(jid: string, kind: Kind): void {
  const shots = shotsOf(jid, kind);
  const t = times(kind, shots);
  const cells = t.map((_, i) => i + 1).filter((c) => h.targets[kind].includes(cellSlots(shots, t, [c])[0].assetId));
  h.cells[kind] = [...new Set([...(h.cells[kind] ?? []), ...cells])].sort((a, b) => a - b);
}
const planned = (kind: Kind, n: number, extra: { motion?: boolean } = {}) => (id: string) => {
  h.targets[kind] = plantFallbacks(id, kind, n, extra);
};

describe("final visual archive repair: when it does not run", () => {
  test("A. a visual PASS: no repair, done", async () => {
    const id = await produce(planned("long", 1));
    expect(getJob(id)!.state).toBe("done");
    expect(h.commons).toEqual([]);
    expect(repairOf(id)).toBeUndefined();
    expect(h.rendered).toEqual([["long", "short"]]);
  });

  test("B. a factual HUMAN_REVIEW: the visual repair never runs, the person decides", async () => {
    h.answers = { "short-factual": ["HUMAN_REVIEW"], "long-visual": ["HUMAN_REVIEW"] };
    const id = await produce(planned("long", 1));
    expect(getJob(id)!.state).toBe("awaiting_final");
    expect(h.commons).toEqual([]);
    expect(repairOf(id)).toBeUndefined();
    expect(getJob(id)!.spent).toBe(FOUR);
  });

  test("C, 3, 4. flagged cells that show only motion slots and no archive fallback: nothing can move, no repair, no call", async () => {
    h.answers = { "long-visual": ["HUMAN_REVIEW"] };
    const id = await produce((jid) => {
      const shots = shotsOf(jid, "long");
      const t = times("long", shots);
      const moving = t.map((_, i) => i + 1).filter((c) => shots.find((s) => s.index === cellSlots(shots, t, [c])[0].slot)!.wantsMotion);
      expect(moving.length).toBeGreaterThanOrEqual(2);
      h.cells.long = moving;
    });
    expect(getJob(id)!.state).toBe("awaiting_final");
    expect(h.commons).toEqual([]);
    expect(repairOf(id)).toBeUndefined();
    expect(labels()).toEqual(["long-factual", "long-visual", "short-factual", "short-visual"]);
  });

  test("an approved maximum that cannot cover the repair's worst case: skipped before anything changes", async () => {
    h.answers = { "long-visual": ["HUMAN_REVIEW"] };
    const id = await produce(planned("long", 1), FOUR + 0.5); // the four audits fit, one more visual audit does not
    expect(getJob(id)!.state).toBe("awaiting_final");
    expect(h.commons).toEqual([]);
    expect(repairOf(id)).toBeUndefined();
  });
});

describe("final visual archive repair: the one attempt", () => {
  test("D, E. the issue's cells implicate one fallback asset: it is searched once, however many cells show it", async () => {
    h.answers = { "long-visual": ["HUMAN_REVIEW"] };
    const id = await produce(planned("long", 1));
    const [asset] = h.targets.long;
    const t = times("long");
    expect(t.filter((_, i) => issueAssets(shotsOf(id, "long"), t, [i + 1])[0] === asset).length).toBeGreaterThanOrEqual(1);
    expect(repairOf(id).tried).toEqual([{ film: "long", assetId: asset }]);
    // One search: the asset's query list once through, nothing twice.
    const queries = h.commons.filter((c) => c.asset === `long:${asset}`).map((c) => c.query);
    expect(new Set(queries).size).toBe(queries.length);
    expect(queries).toContain(`archive query ${asset}`);
  });

  test("F. several implicated fallback assets: each tried at most once in the one pass", async () => {
    h.answers = { "long-visual": ["HUMAN_REVIEW"], "short-visual": ["HUMAN_REVIEW"] };
    const id = await produce((jid) => {
      planned("long", 1)(jid);
      planned("short", 1)(jid);
    });
    const tried = repairOf(id).tried.map((t: any) => `${t.film}:${t.assetId}`);
    expect(tried).toEqual([`long:${h.targets.long[0]}`, `short:${h.targets.short[0]}`]);
    const searched = new Set(h.commons.map((c) => c.asset));
    expect([...searched].sort()).toEqual([...tried].sort());
  });

  test("G. nothing recovered: no Pixel QA, no re-render, no new visual audit, awaiting_final", async () => {
    h.answers = { "long-visual": ["HUMAN_REVIEW"] };
    const id = await produce(planned("long", 1));
    expect(getJob(id)!.state).toBe("awaiting_final");
    expect(repairOf(id)).toMatchObject({ attempted: true, recovered: [], rejected: [] });
    expect(h.rendered).toEqual([["long", "short"]]);
    expect(archiveLabels()).toEqual(["long-factual", "long-visual", "short-factual", "short-visual"]);
    expect(getJob(id)!.spent).toBe(round(FOUR + seqSpend())); // an archive search is not paid provider work
    expect(shotsOf(id, "long").find((s) => s.assetId === h.targets.long[0] && s.edit === "new")).toMatchObject({ truth: "reconstruction" });
  });

  test("I. a recovered archive the existing Pixel Asset QA does not pass is never used", async () => {
    h.answers = { "long-visual": ["HUMAN_REVIEW"] };
    const id = await produce((jid) => {
      planned("long", 1)(jid);
      h.found.add(`long:${h.targets.long[0]}`);
      h.pixel[h.targets.long[0]] = "HUMAN_REVIEW";
    });
    const [asset] = h.targets.long;
    const owner = shotsOf(id, "long").find((s) => s.assetId === asset && s.edit === "new")!;
    expect(owner).toMatchObject({ truth: "reconstruction", path: expect.stringMatching(/^images\//) });
    expect(existsSync(inStory(story.slug, `archive/long-${String(owner.index).padStart(2, "0")}.jpg`))).toBe(false); // the rejected file is gone
    expect(repairOf(id).rejected).toEqual([{ film: "long", assetId: asset, reason: "The photo shows a different ship." }]);
    expect(h.rendered).toEqual([["long", "short"]]); // nothing re-rendered
    expect(archiveLabels()).toEqual(["long-factual", "long-visual", "short-factual", "short-visual", "asset-qa"]);
    expect(getJob(id)!.state).toBe("awaiting_final");
    expect(getJob(id)!.spent).toBe(round(FOUR + assetReviewUsd(1) + seqSpend()));
  });

  test("H, J, K. recovered and passed: bound as archive everywhere, only that film re-rendered and re-audited once, then Ready", async () => {
    h.answers = { "long-visual": ["HUMAN_REVIEW", "PASS"] };
    const id = await produce((jid) => {
      planned("long", 1)(jid);
      h.found.add(`long:${h.targets.long[0]}`);
    });
    const [asset] = h.targets.long;
    const uses = shotsOf(id, "long").filter((s) => s.assetId === asset);
    const owner = uses.find((s) => s.edit === "new")!;
    const archive = `archive/long-${String(owner.index).padStart(2, "0")}.jpg`;
    // H. the asset is archive in every slot that shows it, with its credit.
    for (const s of uses) expect(s).toMatchObject({ truth: "archive", path: archive, source: `US Navy · Public domain (${asset})`, wantsMotion: false });
    expect(readFileSync(inStory(story.slug, archive), "utf8")).toBe(`archive bytes long:${asset}`);
    expect(repairOf(id)).toMatchObject({ attempted: true, tried: [{ film: "long", assetId: asset }], recovered: [{ film: "long", assetId: asset, source: `US Navy · Public domain (${asset})` }], rejected: [] });
    // J. only the Long was rendered again, from the archive still; one new Long visual audit.
    expect(h.rendered).toEqual([["long", "short"], ["long"]]);
    const rendered = h.plans[renderPath("long")];
    expect(JSON.stringify(rendered)).toContain(archive);
    expect(archiveLabels()).toEqual(["long-factual", "long-visual", "short-factual", "short-visual", "asset-qa", "long-visual"]);
    const qa = scratchOf(id).finalFilmQa;
    expect(qa.long.factual.decision).toBe("PASS"); // kept, never asked again
    expect([qa.short.factual.decision, qa.short.visual.decision, qa.long.visual.decision]).toEqual(["PASS", "PASS", "PASS"]);
    // K. both films pass now: the pair is registered together.
    const j = getJob(id)!;
    expect(j.state).toBe("done");
    expect(videosForStory(story.id).filter((x) => x.jobId === id).map((x) => x.kind).sort()).toEqual(["long", "short"]);
    expect(j.spent).toBe(round(FOUR + assetReviewUsd(1) + LOOK + seqSpend()));
  });

  test("L, N. the repaired film still HUMAN_REVIEW: awaiting_final, never a second repair; Continue anyway then registers the pair", async () => {
    h.answers = { "long-visual": ["HUMAN_REVIEW", "HUMAN_REVIEW"] };
    const id = await produce((jid) => {
      planned("long", 1)(jid);
      h.found.add(`long:${h.targets.long[0]}`);
    });
    expect(getJob(id)!.state).toBe("awaiting_final");
    expect(repairOf(id).recovered).toHaveLength(1);
    expect(h.commons.length).toBeGreaterThan(0);
    const searched = h.commons.length;
    expect(labels().filter((l) => l === "long-visual")).toHaveLength(2);

    // Nothing starts another repair: not a resume, not the explicit route.
    expect(() => resumeFinalVisualRepairForJob(id)).toThrow(/no automatic archive repair/);
    h.calls = [];
    acceptFinalForJob(id);
    await runJob(id);
    expect(h.calls).toEqual([]);
    expect(h.commons).toHaveLength(searched);
    expect(getJob(id)!.state).toBe("done");
    expect(videosForStory(story.id).filter((x) => x.jobId === id).map((x) => x.kind).sort()).toEqual(["long", "short"]);
  });

  test("M. a restart during the new visual audit repeats neither the search nor the Pixel QA", async () => {
    h.answers = { "long-visual": ["HUMAN_REVIEW", "crash"] };
    const id = await produce((jid) => {
      planned("long", 1)(jid);
      h.found.add(`long:${h.targets.long[0]}`);
    }).catch(() => h.jobId);
    expect(h.snapshot).toBeTruthy();
    updateJob(id, { ...h.snapshot }); // the row as the crash left it
    expect(resumableJobIds()).toContain(id);
    const searched = h.commons.length;
    h.calls = [];
    h.answers = { "long-visual": ["PASS"] };
    await runJob(id);
    expect(labels()).toEqual(["long-visual"]);
    expect(h.commons).toHaveLength(searched);
    expect(getJob(id)!.state).toBe("done");
  });

  test("M. a restart between binding and re-render renders first, then goes on without a second attempt", async () => {
    h.answers = { "long-visual": ["HUMAN_REVIEW"] };
    h.failRepairRender = true;
    const id = await produce((jid) => {
      planned("long", 1)(jid);
      h.found.add(`long:${h.targets.long[0]}`);
    }).catch(() => h.jobId);
    expect(getJob(id)!.state).toBe("failed");
    expect(repairOf(id).rerender).toEqual(["long"]);
    expect(scratchOf(id).finalFilmQa.long.visual).toBeUndefined();
    const searched = h.commons.length;
    h.failRepairRender = false;
    h.calls = [];
    updateJob(id, { state: "queued", error: null }); // Retry
    await runJob(id);
    expect(h.rendered.at(-1)).toEqual(["long"]);
    expect(repairOf(id).rerender).toBeUndefined();
    expect(labels()).toEqual(["long-visual"]);
    expect(h.commons).toHaveLength(searched);
    expect(getJob(id)!.state).toBe("done");
  });

  test("a recovered archive replaces a reconstruction's motion clip: the motion is unbound, the archive renders as a still", async () => {
    h.answers = { "long-visual": ["HUMAN_REVIEW"] };
    const id = await produce(flagMotionOnly); // reaches the gate with nothing repairable, like Film #5 under the old code
    expect(getJob(id)!.state).toBe("awaiting_final");
    // The Film #5 shape: an existing job whose flagged pictures are archive fallbacks, one with motion.
    h.targets.long = plantFallbacks(id, "long", 1, { motion: true });
    const s = scratchOf(id);
    const t = times("long");
    s.finalFilmQa.long.visual.issues = [{ reason: "repeats", cells: t.map((_, i) => i + 1).filter((c) => issueAssets(shotsOf(id, "long"), t, [c])[0] === h.targets.long[0]).concat([24]).slice(0, 3) }];
    updateJob(id, { scratch: s });
    h.found.add(`long:${h.targets.long[0]}`);
    config.mode = "live";
    resumeFinalVisualRepairForJob(id);
    await runJob(id);
    const owner = shotsOf(id, "long").find((x) => x.assetId === h.targets.long[0] && x.edit === "new")!;
    expect(owner.motionPath).toBeUndefined();
    expect(owner.wantsMotion).toBe(false);
    const planShot = h.plans[renderPath("long")].shots.find((x: any) => x.path.includes(`archive/long-`));
    expect(planShot).toBeTruthy();
    expect(JSON.stringify(h.plans[renderPath("long")])).not.toContain(".mp4\"");
  });
});

describe("final visual repair: the one existing-media sequence revision", () => {
  const edit = (id: string, kind: Kind) => shotsOf(id, kind).map((s) => `${s.assetId}:${s.presentation}`);
  // The slots the repair may move, as the finish computes them: the flagged cells'
  // non-motion slots, never two adjacent.
  function expectedTargets(id: string, kind: Kind): number[] {
    const shots = shotsOf(id, kind);
    const slots = [...new Set(cellSlots(shots, times(kind), h.cells[kind]!).map((c) => c.slot))].sort((a, b) => a - b).filter((s) => !shots.find((x) => x.index === s)!.wantsMotion);
    return slots.filter((s, i) => !(i > 0 && slots[i - 1] === s - 1));
  }

  test("1, 2, 9. non-archive repeated slots move to existing media: only the issue's slots, one revision, one verification, one re-render and audit; factual kept", async () => {
    h.sequence = "first";
    h.answers = { "long-visual": ["HUMAN_REVIEW", "PASS"] };
    let before: string[] = [];
    const id = await produce((jid) => {
      flagRepeats(jid, "long");
      before = edit(jid, "long");
    });
    const targets = expectedTargets(id, "long");
    expect(targets.length).toBeGreaterThan(0);
    expect(h.commons).toEqual([]); // nothing to recover from archive
    // One revision offered exactly the issue's movable slots, with the structured evidence.
    expect(h.revisions).toHaveLength(1);
    expect(Object.keys(h.revisions[0].schema.properties.changes.properties).map(Number)).toEqual(targets);
    expect(h.revisions[0].input).toContain("FINAL WHOLE-FILM REPETITION REPAIR");
    expect(h.revisions[0].input).toContain("KEEP ALL OTHER SLOTS.");
    // Only target slots changed; the saved edit passes the ordinary strict checks.
    const after = edit(id, "long");
    const changed = after.flatMap((p, i) => (p !== before[i] ? [i] : []));
    expect(changed.length).toBeGreaterThan(0);
    for (const s of changed) expect(targets).toContain(s);
    const shots = shotsOf(id, "long");
    expect(() => v.validateEdit("long", v.planSlots("long", scratchOf(id).scripts.long, scratchOf(id).narration.long), v.storedEdit(shots), v.storedPresentations(shots))).not.toThrow();
    expect(repairOf(id).sequence).toEqual([{ film: "long", targets, changed, outcome: "Changed and verified." }]);
    // One verification, one re-render of the Long only, one new Long visual audit; factual never again.
    expect(labels()).toEqual(["long-factual", "long-visual", "short-factual", "short-visual", "sequence", "verify", "long-visual"]);
    expect(h.rendered).toEqual([["long", "short"], ["long"]]);
    const qa = scratchOf(id).finalFilmQa;
    expect([qa.long.factual.decision, qa.short.factual.decision, qa.short.visual.decision, qa.long.visual.decision]).toEqual(["PASS", "PASS", "PASS", "PASS"]);
    expect(getJob(id)!.state).toBe("done");
    expect(getJob(id)!.spent).toBe(round(FOUR + 2 * SEQ + LOOK));
  });

  test("3. a flagged motion slot stays locked and is never offered", async () => {
    h.sequence = "first";
    h.answers = { "long-visual": ["HUMAN_REVIEW", "PASS"] };
    let motion = -1;
    const id = await produce((jid) => {
      flagRepeats(jid, "long");
      const shots = shotsOf(jid, "long");
      const t = times("long", shots);
      const moving = t.map((_, i) => i + 1).find((c) => shots.find((s) => s.index === cellSlots(shots, t, [c])[0].slot)!.wantsMotion)!;
      motion = cellSlots(shots, t, [moving])[0].slot;
      h.cells.long = [...new Set([...h.cells.long!, moving])].sort((a, b) => a - b);
    });
    const offered = Object.keys(h.revisions[0].schema.properties.changes.properties).map(Number);
    expect(offered).not.toContain(motion);
    expect(repairOf(id).sequence[0].targets).not.toContain(motion);
    expect(shotsOf(id, "long").find((s) => s.index === motion)!.wantsMotion).toBe(true);
  });

  test("6, 7. a malformed revision is charged once and saves nothing; a change the Director verification flags is put back", async () => {
    h.sequence = "invalid";
    h.answers = { "long-visual": ["HUMAN_REVIEW"] };
    let before: string[] = [];
    const id = await produce((jid) => {
      flagRepeats(jid, "long");
      before = edit(jid, "long");
    });
    expect(edit(id, "long")).toEqual(before);
    expect(repairOf(id).sequence[0].outcome).toMatch(/^Revision not applied: Invalid sequence revision/);
    expect(labels()).toEqual(["long-factual", "long-visual", "short-factual", "short-visual", "sequence"]);
    expect(h.rendered).toEqual([["long", "short"]]); // nothing changed: no re-render
    const qa = scratchOf(id).finalFilmQa;
    expect(qa.long.visual.decision).toBe("HUMAN_REVIEW"); // the finding still stands for the person
    expect(repairOf(id).rerender).toBeUndefined();
    expect(getJob(id)!.state).toBe("awaiting_final");
    expect(getJob(id)!.spent).toBe(round(FOUR + SEQ));

    // Verified against the narration: a flagged changed slot means the old edit is kept.
    h.calls = [];
    h.revisions = [];
    h.rendered = [];
    h.sequence = "first";
    h.answers = { "long-visual": ["HUMAN_REVIEW"] };
    let second: string[] = [];
    const id2 = await produce((jid) => {
      flagRepeats(jid, "long");
      second = edit(jid, "long");
      h.verifyFlag = expectedTargets(jid, "long");
    });
    expect(edit(id2, "long")).toEqual(second);
    expect(repairOf(id2).sequence[0].outcome).toMatch(/^Director verification flagged slot/);
    expect(labels().slice(4)).toEqual(["sequence", "verify"]);
    expect(h.rendered).toEqual([["long", "short"]]);
    expect(getJob(id2)!.state).toBe("awaiting_final");
  });

  test("5, 10. both films flagged: one revision per film at most, and a second HUMAN_REVIEW never starts another", async () => {
    h.sequence = "first";
    h.answers = { "long-visual": ["HUMAN_REVIEW", "HUMAN_REVIEW"], "short-visual": ["HUMAN_REVIEW", "HUMAN_REVIEW"] };
    const id = await produce((jid) => {
      flagRepeats(jid, "long");
      flagRepeats(jid, "short");
    });
    expect(h.revisions.map((r) => /FILM: (\w+)/.exec(r.input)?.[1] ?? "?")).toHaveLength(2);
    expect(labels().filter((l) => l === "sequence")).toHaveLength(2);
    expect(h.rendered).toEqual([["long", "short"], ["long", "short"]]);
    expect(labels().filter((l) => l.endsWith("-visual"))).toEqual(["long-visual", "short-visual", "long-visual", "short-visual"]);
    expect(getJob(id)!.state).toBe("awaiting_final");
    expect(() => resumeFinalVisualRepairForJob(id)).toThrow(/no automatic archive repair/);
    h.calls = [];
    updateJob(id, { state: "queued" }); // a later resume of the finish
    await runJob(id);
    expect(h.calls).toEqual([]);
    expect(getJob(id)!.state).toBe("awaiting_final");
  });

  test("8. archive recovery and a sequence move in the same one attempt: one re-render, one new audit", async () => {
    h.sequence = "first";
    h.answers = { "long-visual": ["HUMAN_REVIEW", "PASS"] };
    const id = await produce((jid) => {
      h.targets.long = plantFallbacks(jid, "long", 1);
      h.found.add(`long:${h.targets.long[0]}`);
      flagRepeats(jid, "long");
      const shots = shotsOf(jid, "long");
      const t = times("long", shots);
      const fallbackCells = t.map((_, i) => i + 1).filter((c) => cellSlots(shots, t, [c])[0].assetId === h.targets.long[0]);
      h.cells.long = [...new Set([...h.cells.long!, ...fallbackCells])].sort((a, b) => a - b);
    });
    const r = repairOf(id);
    expect(r.recovered.map((x: any) => x.assetId)).toEqual(h.targets.long);
    expect(r.sequence[0].changed.length).toBeGreaterThan(0);
    // The recovered asset's slots are not sequence targets.
    const recoveredSlots = shotsOf(id, "long").filter((s) => s.assetId === h.targets.long[0]).map((s) => s.index);
    for (const s of r.sequence[0].targets) expect(recoveredSlots).not.toContain(s);
    expect(archiveLabels()).toEqual(["long-factual", "long-visual", "short-factual", "short-visual", "asset-qa", "verify", "long-visual"]);
    expect(labels().filter((l) => l === "sequence")).toHaveLength(1);
    expect(h.rendered).toEqual([["long", "short"], ["long"]]);
    expect(getJob(id)!.state).toBe("done");
    expect(getJob(id)!.spent).toBe(round(FOUR + assetReviewUsd(1) + 2 * SEQ + LOOK));
  });

  // Flag the repeats plus one extra cell that shows an information graphic (the
  // mock film plans some; an all-base, non-motion asset is made one if none is
  // sampled), clear of the other targets. Returns every graphic asset of the film
  // and the flagged graphic slot, plus the choices the ORDINARY slot screening
  // would offer the real targets.
  function plantGraphics(jid: string): { graphics: string[]; graphicSlot: number; plain: Map<number, string[]>; targets: number[] } {
    flagRepeats(jid, "long");
    const shots = shotsOf(jid, "long");
    const t = times("long", shots);
    const rows = cellSlots(shots, t, t.map((_, i) => i + 1));
    const flaggedSlots = cellSlots(shots, t, h.cells.long!).map((c) => c.slot);
    const flaggedAssets = new Set(cellSlots(shots, t, h.cells.long!).map((c) => c.assetId));
    const clear = (r: (typeof rows)[number]) => !flaggedAssets.has(r.assetId) && flaggedSlots.every((s) => Math.abs(s - r.slot) > 1);
    const truth = (a: string) => shots.find((s) => s.assetId === a)!.truth;
    const usable = (a: string) => shots.filter((s) => s.assetId === a).every((s) => !s.wantsMotion && s.presentation === "base");
    const g = rows.find((r) => clear(r) && truth(r.assetId) === "graphic") ?? rows.find((r) => clear(r) && usable(r.assetId))!;
    expect(g).toBeTruthy();
    for (const s of shots) if (s.assetId === g.assetId) s.truth = "graphic";
    const graphics = [...new Set(shots.filter((s) => s.truth === "graphic").map((s) => s.assetId))];
    h.cells.long = [...new Set([...h.cells.long!, g.cell])].sort((a, b) => a - b);
    const s = scratchOf(jid);
    s.longShots = shots;
    updateJob(jid, { scratch: s });
    // The ordinary screening (no final-repair rule) of the targets the repair will use.
    const targets = expectedTargets(jid, "long").filter((x) => x !== g.slot);
    const slots = v.planSlots("long", s.scripts.long, s.narration.long);
    const locked = new Map<number, string>(slots.filter((x) => !targets.includes(x.id)).map((x) => [x.id, "not a target"] as [number, string]));
    const pool = (s.retainedPresentations?.long ?? v.retainPresentations(undefined, shots)).filter((r: any) => existsSync(inStory(story.slug, r.path)));
    const plain = v.sequenceSlotChoices("long", slots, shots, v.storedPresentations(shots, pool), locked, story, pool);
    return { graphics, graphicSlot: g.slot, plain, targets };
  }
  const isGraphic = (graphics: string[]) => (p: string) => graphics.some((a) => p.startsWith(`${a}:`));

  test("G1, G3. a flagged graphic slot is never a target; the other targets keep their ordinary existing-media choices minus graphics", async () => {
    h.sequence = "first";
    h.answers = { "long-visual": ["HUMAN_REVIEW", "PASS"] };
    let g!: ReturnType<typeof plantGraphics>;
    let before: string[] = [];
    const id = await produce((jid) => {
      g = plantGraphics(jid);
      before = edit(jid, "long");
    });
    const offered = h.revisions[0].schema.properties.changes.properties as Record<string, { enum: (string | null)[] }>;
    // The graphic slot is locked and never a target; the non-graphic targets are offered.
    expect(Object.keys(offered).map(Number)).toEqual(g.targets);
    expect(repairOf(id).sequence[0].targets).toEqual(g.targets);
    expect(repairOf(id).sequence[0].targets).not.toContain(g.graphicSlot);
    expect(h.revisions[0].input).toMatch(/information graphic is intentional/);
    // Each target keeps every ordinary legal non-graphic choice and is offered no
    // graphic, although the ordinary screening WOULD have offered one.
    expect([...g.plain.values()].flat().some(isGraphic(g.graphics))).toBe(true);
    for (const t of g.targets) {
      const ids = offered[String(t)].enum.filter((x): x is string => x !== null);
      expect(ids.filter(isGraphic(g.graphics))).toEqual([]);
      for (const p of g.plain.get(t)!.filter((x) => !isGraphic(g.graphics)(x))) expect(ids).toContain(p);
      expect(ids.length).toBeGreaterThan(0);
    }
    // Graphics stay exactly where they were; the targets moved to non-graphic media.
    const after = edit(id, "long");
    const shots = shotsOf(id, "long");
    for (const [i, p] of before.entries()) if (isGraphic(g.graphics)(p)) expect(after[i]).toBe(p);
    for (const s of repairOf(id).sequence[0].changed) expect(shots.find((x) => x.index === s)!.truth).not.toBe("graphic");
    expect(getJob(id)!.state).toBe("done");
  });

  test("G2. an answer that puts a graphic on a target is not applied: charged once, nothing saved, no verification", async () => {
    h.sequence = "graphic";
    h.answers = { "long-visual": ["HUMAN_REVIEW"] };
    let before: string[] = [];
    const id = await produce((jid) => {
      const g = plantGraphics(jid);
      h.graphicPick = g.plain.get(g.targets[0])!.find(isGraphic(g.graphics))!; // legal for the ordinary screening
      expect(h.graphicPick).toBeTruthy();
      before = edit(jid, "long");
    });
    expect(edit(id, "long")).toEqual(before);
    expect(repairOf(id).sequence[0].changed).toEqual([]);
    expect(repairOf(id).sequence[0].outcome).toContain(`Not changed: ${h.graphicPick}`);
    expect(labels().slice(4)).toEqual(["sequence"]); // no verification of an unapplied answer
    expect(h.rendered).toEqual([["long", "short"]]);
    expect(getJob(id)!.state).toBe("awaiting_final");
    expect(getJob(id)!.spent).toBe(round(FOUR + SEQ));
  });

  test("a restart during the revision call re-renders and re-audits that film, never revising again", async () => {
    h.sequence = "crash";
    h.answers = { "long-visual": ["HUMAN_REVIEW"] };
    const id = await produce((jid) => flagRepeats(jid, "long"));
    expect(h.snapshot).toBeTruthy(); // the row as saved when the revision call started
    expect(h.snapshot.scratch.finalFilmQa.visualRepair.rerender).toEqual(["long"]);
    expect(h.snapshot.scratch.finalFilmQa.long.visual).toBeUndefined();
    updateJob(id, { ...h.snapshot });
    h.calls = [];
    h.rendered = [];
    h.answers = { "long-visual": ["PASS"] };
    await runJob(id);
    expect(h.rendered).toEqual([["long"]]);
    expect(labels()).toEqual(["long-visual"]);
    expect(getJob(id)!.state).toBe("done");
  });
});

describe("the existing awaiting_final job: the explicit resume", () => {
  async function waiting(): Promise<string> {
    h.answers = { "long-visual": ["HUMAN_REVIEW"] };
    const id = await produce(flagMotionOnly);
    expect(getJob(id)!.state).toBe("awaiting_final");
    h.targets.long = plantFallbacks(id, "long", 1);
    const s = scratchOf(id);
    const t = times("long");
    const cells = t.map((_, i) => i + 1).filter((c) => issueAssets(shotsOf(id, "long"), t, [c])[0] === h.targets.long[0]);
    s.finalFilmQa.long.visual.issues = [{ reason: "repeats", cells: [...cells, cells[0] === 1 ? 24 : 1] }];
    updateJob(id, { scratch: s });
    config.mode = "live";
    return id;
  }

  test("the route requeues a repairable job once, optionally raising the approved maximum; the worker does the rest", async () => {
    const id = await waiting();
    h.found.add(`long:${h.targets.long[0]}`);
    h.answers = { "long-visual": ["PASS"] };
    const app = Fastify();
    await registerRoutes(app);
    const tight = await app.inject({ method: "POST", url: `/api/jobs/${id}/final-visual-repair`, payload: { approvedMax: FOUR + 0.1 } });
    expect(tight.statusCode).toBe(400); // below the current maximum
    const res = await app.inject({ method: "POST", url: `/api/jobs/${id}/final-visual-repair`, payload: { approvedMax: 6 } });
    expect(res.statusCode).toBe(200);
    expect(res.json().job.state).toBe("queued");
    expect(getJob(id)!.approvedMax).toBe(6);
    for (let i = 0; i < 300 && getJob(id)!.state !== "done"; i++) await new Promise((r) => setTimeout(r, 10));
    expect(getJob(id)!.state).toBe("done");
    expect(repairOf(id).recovered).toHaveLength(1);
    const again = await app.inject({ method: "POST", url: `/api/jobs/${id}/final-visual-repair` });
    expect(again.statusCode).toBe(400);
    await app.close();
  });

  test("kind: long repairs the Long only; the Short's edit, file and results are never touched and no Short call is made", async () => {
    // Both films flagged and repairable, but the approved maximum at production
    // cannot cover the repair, so the job waits with both findings.
    h.answers = { "long-visual": ["HUMAN_REVIEW"], "short-visual": ["HUMAN_REVIEW"] };
    const id = await produce((jid) => {
      h.targets.long = plantFallbacks(jid, "long", 1);
      h.targets.short = plantFallbacks(jid, "short", 1);
      h.found.add(`long:${h.targets.long[0]}`);
      h.found.add(`short:${h.targets.short[0]}`);
      for (const kind of ["long", "short"] as const) {
        flagRepeats(jid, kind);
        flagFallbacks(jid, kind);
      }
    }, FOUR + 0.5);
    expect(getJob(id)!.state).toBe("awaiting_final");
    expect(repairOf(id)).toBeUndefined();
    config.mode = "live";
    // $3 covers the Long's worst case, not both films'.
    expect(() => resumeFinalVisualRepairForJob(id, 3)).toThrow(/needs an approved maximum/);
    const shortBefore = JSON.stringify({ shots: shotsOf(id, "short"), qa: scratchOf(id).finalFilmQa.short, plan: h.plans[renderPath("short")] });
    const shortPlan = h.plans[renderPath("short")];
    h.calls = [];
    h.commons = [];
    h.rendered = [];
    h.sequence = "first";
    h.answers = { "long-visual": ["PASS"] };
    const app = Fastify();
    await registerRoutes(app);
    const bad = await app.inject({ method: "POST", url: `/api/jobs/${id}/final-visual-repair`, payload: { kind: "both" } });
    expect(bad.statusCode).toBe(400);
    const res = await app.inject({ method: "POST", url: `/api/jobs/${id}/final-visual-repair`, payload: { kind: "long", approvedMax: 3 } });
    expect(res.statusCode).toBe(200);
    for (let i = 0; i < 300 && !(getJob(id)!.state === "awaiting_final" && labels().includes("long-visual")); i++) await new Promise((r) => setTimeout(r, 10));
    await app.close();
    expect(getJob(id)!.state).toBe("awaiting_final"); // the Short still carries its HUMAN_REVIEW
    // Only Long work: its archive search and Pixel QA, one revision, one verification, one audit.
    expect(h.commons.every((c) => c.asset.startsWith("long:"))).toBe(true);
    expect(h.commons.length).toBeGreaterThan(0);
    expect(labels()).toEqual(["asset-qa", "sequence", "verify", "long-visual"]);
    expect(h.revisions.map((r) => /FILM: (\w+)/.exec(r.input)?.[1])).toEqual(["LONG"]);
    expect(h.rendered).toEqual([["long"]]);
    // The Short: saved edit, render plan (same file, never re-rendered) and results byte for byte.
    expect(h.plans[renderPath("short")]).toBe(shortPlan);
    expect(JSON.stringify({ shots: shotsOf(id, "short"), qa: scratchOf(id).finalFilmQa.short, plan: h.plans[renderPath("short")] })).toBe(shortBefore);
    const qa = scratchOf(id).finalFilmQa;
    expect(qa.outputsValidated).toBe(true);
    expect(qa.repairOnly).toBe("long");
    expect(qa.long.factual.decision).toBe("PASS");
    expect(qa.long.visual.decision).toBe("PASS");
    expect(repairOf(id).tried).toEqual([{ film: "long", assetId: h.targets.long[0] }]);
    expect(repairOf(id).sequence.map((s: any) => s.film)).toEqual(["long"]);
    // One attempt: nothing more for the Short afterwards.
    expect(() => resumeFinalVisualRepairForJob(id, 3, "short")).toThrow(/no automatic visual repair/);
  });

  test("a job whose findings are not the repairable class is refused and left as it is", async () => {
    h.answers = { "long-factual": ["HUMAN_REVIEW"] };
    const id = await produce();
    config.mode = "live";
    const before = JSON.stringify(getJob(id));
    expect(() => resumeFinalVisualRepairForJob(id)).toThrow(/no automatic archive repair/);
    expect(JSON.stringify(getJob(id))).toBe(before);
  });

  test("a repair the approved maximum cannot cover is refused before anything changes", async () => {
    const id = await waiting();
    updateJob(id, { approvedMax: getJob(id)!.spent + 0.2 });
    const before = JSON.stringify(getJob(id));
    expect(() => resumeFinalVisualRepairForJob(id)).toThrow(/needs an approved maximum of at least/);
    expect(JSON.stringify(getJob(id))).toBe(before);
  });
});
