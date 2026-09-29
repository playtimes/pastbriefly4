import { describe, test, expect, vi, beforeAll, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

// Film #4: a planned archive HOLD (one archive base on two adjacent slots) whose
// archive search fell back to a reconstruction is no longer legal. runJob checks
// each film's acquired edit before the preview and repairs such a hold ONCE with
// the existing targeted sequence revision. Live mode with every provider faked:
// the archive search, image generation and the one Editor call are counted.
const tmp = mkdtempSync(path.join(os.tmpdir(), "pb4-archive-hold-"));
process.env.PROVIDER_MODE = "mock";
process.env.PB4_DATA_DIR = path.join(tmp, "data");
process.env.PB4_MEDIA_DIR = path.join(tmp, "media");

// planted: the archive files of the planted assets; failPlanted: their search finds nothing.
const h = vi.hoisted(() => ({ calls: [] as any[], keep: false, failPlanted: false, planted: new Set<string>(), archive: 0, images: 0, hash: 0 }));
vi.mock("../src/providers/openai.ts", () => ({
  respondJson: vi.fn(async (o: any) => {
    if (o.schemaName !== "sequence_revision") throw new Error(`unexpected provider call ${o.schemaName}`);
    h.calls.push(o);
    // The Editor: every offered target takes its first legal choice, or keeps it.
    const keys = o.schema.properties.changes.properties;
    return { changes: Object.fromEntries(Object.entries(keys).map(([id, p]: any) => [id, h.keep ? null : p.enum[0]])), unresolved: [] };
  }),
  imageMimeType: () => "image/png",
  generateImageFile: vi.fn(async (o: any) => {
    h.images++;
    writeFileSync(o.outPath, `generated ${o.outPath}`);
  }),
}));
vi.mock("../src/providers/runway.ts", () => ({ generateMotion: vi.fn(async () => { throw new Error("no motion in these tests"); }) }));
vi.mock("../src/production/wikimedia.ts", () => ({
  fetchArchive: vi.fn(async (_q: string, dest: string) => {
    h.archive++;
    if (h.failPlanted && [...h.planted].some((f) => dest.split(path.sep).join("/").endsWith(f))) return null; // no usable archive
    writeFileSync(dest, `archive ${dest}`);
    return { credit: "Wikimedia Commons", sha256: `hash-${h.hash++}` };
  }),
}));

const { runJob, newJobId, ARCHIVE_HOLD_REPAIR_FAILED, ACQUIRED_EDIT_INVALID } = await import("../src/production/generate.ts");
const v = await import("../src/production/visuals.ts");
const { recordNarration } = await import("../src/production/narration.ts");
const { createJob, getJob, updateJob, upsertStory } = await import("../src/server/store.ts");
const { ensureStoryDirs, inStory } = await import("../src/production/paths.ts");
const { setMode } = await import("../src/server/config.ts");
const { PRICING } = await import("../src/server/pricing.ts");
const { paulBunyanStory, paulBunyanResearch, paulBunyanScripts } = await import("../src/production/fixtures/paulBunyan.ts");
type Shot = import("../src/production/visuals.ts").PlannedShot;
type Kind = "long" | "short";

let planned: { narration: any; plans: { long: Shot[]; short: Shot[] } };
beforeAll(async () => {
  const slug = "archive-hold-plan";
  const story = { ...paulBunyanStory, id: slug, slug, title: "A Neutral Story", createdAt: new Date().toISOString() };
  ensureStoryDirs(slug);
  const narration = { long: await recordNarration(slug, "long", paulBunyanScripts.long), short: await recordNarration(slug, "short", paulBunyanScripts.short) };
  planned = { narration, plans: await v.planVisuals(story, paulBunyanResearch, paulBunyanScripts, narration) };
  setMode("live");
});
beforeEach(() => {
  h.calls = [];
  h.keep = false;
  h.failPlanted = false;
  h.planted = new Set();
  h.archive = 0;
  h.images = 0;
});
afterEach(() => setMode("live"));

const pres = (s: Shot) => `${s.assetId}:${s.presentation}`;

// Two adjacent reuse slots (no motion, 10 s at most together) become one archive
// base asset `X`: slot n owns it, slot n+1 reuses it, as the Editor planned L13.
function plantHold(list: Shot[], kind: Kind, both = true): number {
  const n = list.findIndex((s, i) => i > 2 && i < list.length - 3 && s.edit === "reuse" && list[i + 1].edit === "reuse" && !s.wantsMotion && !list[i + 1].wantsMotion && list[i + 1].endSec - s.startSec <= v.ARCHIVE_HOLD_MAX_SEC);
  const X = kind === "long" ? "L90" : "S90";
  const asset = { assetId: X, presentation: "base" as const, framing: "wide" as const, truth: "archive" as const, archiveQuery: "US Navy bat bomb 1943", prompt: "archive prompt", purpose: "the bat bomb test", mustShow: ["bat canister"], mustNotShow: [], motion: "hold" as const, wantsMotion: false, motionPriority: 0 };
  h.planted.add(`archive/${kind}-${String(n).padStart(2, "0")}.jpg`);
  const owner: Shot = { ...list[n], ...asset, edit: "new" };
  delete owner.assetShot;
  delete owner.focus;
  list[n] = owner;
  if (both) {
    const reuse: Shot = { ...list[n + 1], ...asset, edit: "reuse", assetShot: n };
    delete reuse.focus;
    list[n + 1] = reuse;
  }
  return n;
}

// A job right before acquisition: text, narration and both plans stored, the
// master already made. `mutate` plants the shape a test needs.
function seed(mutate: (plans: { long: Shot[]; short: Shot[] }) => void = () => {}) {
  const slug = `archive-hold-${newJobId().slice(0, 8)}`;
  const story = { ...paulBunyanStory, id: slug, slug, title: "A Neutral Story", createdAt: new Date().toISOString() };
  upsertStory(story);
  ensureStoryDirs(slug);
  writeFileSync(inStory(slug, "images/hero.png"), "master");
  const plans = structuredClone(planned.plans);
  for (const kind of ["long", "short"] as const) for (const s of plans[kind]) delete s.path;
  mutate(plans);
  for (const kind of ["long", "short"] as const) v.assertFilmGrammarPlan(kind, plans[kind]);
  const job = createJob({ id: newJobId(), storyId: story.id, mock: false, estimatedCost: 50, approvedMax: 100 });
  const scratch = { research: paulBunyanResearch, scripts: paulBunyanScripts, textApproved: true, narration: planned.narration, masterRef: "images/hero.png", spent: 1, longShots: plans.long, shortShots: plans.short };
  updateJob(job.id, { scratch: scratch as any, spent: 1, state: "queued", step: "stills" });
  return { job, story, slug };
}
const shots = (id: string, kind: Kind = "long"): Shot[] => getJob(id)!.scratch[kind === "long" ? "longShots" : "shortShots"];
function strictlyValid(id: string, kind: Kind): void {
  const list = shots(id, kind);
  const slots = v.planSlots(kind, paulBunyanScripts[kind], planned.narration[kind]);
  v.validateEdit(kind, slots, v.storedEdit(list), v.storedPresentations(list));
}
// The edit before this step: legal at planning, while X was archive.
function legalAsPlanned(list: Shot[], kind: Kind): void {
  const slots = v.planSlots(kind, paulBunyanScripts[kind], planned.narration[kind]);
  v.validateEdit(kind, slots, v.storedEdit(list), v.storedPresentations(list));
}
const imageSpend = () => h.images * PRICING.openai.image;

describe("post-acquisition edit integrity: a broken archive hold", () => {
  test("A-H. the Film #4 shape: the archive falls back, the hold breaks, ONE repair of the later slot before the preview", async () => {
    let n = -1;
    const { job } = seed((plans) => {
      n = plantHold(plans.long, "long");
      legalAsPlanned(plans.long, "long"); // A. a legal archive hold as planned
      expect(v.archiveHolds(v.planSlots("long", paulBunyanScripts.long, planned.narration.long), v.storedEdit(plans.long).map((e) => e.presentationId), v.storedPresentations(plans.long)).has(n + 1)).toBe(true);
    });
    h.failPlanted = true; // B. no usable archive for X
    expect(await runJob(job.id)).toBe("preview_gate");
    const list = shots(job.id);
    // C, D. X is honestly a reconstruction now, on its generated still, and its reuse follows.
    expect(list[n]).toMatchObject({ assetId: "L90", truth: "reconstruction", path: "images/long-" + String(n).padStart(2, "0") + ".png" });
    expect(list[n].source).toBeUndefined();
    // F, G. exactly one Editor call, offered only the later slot of the pair.
    expect(h.calls).toHaveLength(1);
    expect(Object.keys(h.calls[0].schema.properties.changes.properties)).toEqual([String(n + 1)]);
    expect(h.calls[0].input).toContain("STRUCTURAL EDIT REPAIR");
    expect(pres(list[n + 1])).not.toBe("L90:base");
    list.forEach((s, i) => i !== n + 1 && expect(pres(s)).toBe(pres(list[i])));
    // H. the acquired edit is valid; the job waits at the preview; one planning charge.
    expect(() => strictlyValid(job.id, "long")).not.toThrow();
    const j = getJob(job.id)!;
    expect([j.state, j.previewApproved]).toEqual(["awaiting_preview", false]);
    expect(j.preview!.frames.find((f) => f.kind === "long" && f.slot === n + 1)!.asset).not.toBe("L90");
    expect(j.spent).toBeCloseTo(1 + imageSpend() + PRICING.openai.visualPlan);
  });

  test("E. without the repair the acquired edit really is invalid", async () => {
    const { job } = seed((plans) => void plantHold(plans.long, "long"));
    h.failPlanted = true;
    h.keep = true; // the Editor keeps everything: the repair does not happen
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(runJob(job.id)).rejects.toThrow(ARCHIVE_HOLD_REPAIR_FAILED);
    logged.mockRestore();
    expect(() => strictlyValid(job.id, "long")).toThrow(/repeats slot .*adjacent slots must not show the identical presentation/);
  });

  test("I. archive found: the legal hold stays exactly as planned; no repair call, no repair spend", async () => {
    let n = -1;
    const { job } = seed((plans) => void (n = plantHold(plans.long, "long")));
    expect(await runJob(job.id)).toBe("preview_gate");
    const list = shots(job.id);
    expect([pres(list[n]), pres(list[n + 1])]).toEqual(["L90:base", "L90:base"]);
    expect(list[n]).toMatchObject({ truth: "archive", source: "Wikimedia Commons" });
    expect(h.calls).toEqual([]);
    expect(getJob(job.id)!.spent).toBeCloseTo(1 + imageSpend());
    expect(() => strictlyValid(job.id, "long")).not.toThrow();
  });

  test("J. an archive fallback that is not held across two slots: no repair call", async () => {
    let n = -1;
    const { job } = seed((plans) => void (n = plantHold(plans.long, "long", false)));
    h.failPlanted = true;
    expect(await runJob(job.id)).toBe("preview_gate");
    expect(shots(job.id)[n]).toMatchObject({ assetId: "L90", truth: "reconstruction" });
    expect(h.calls).toEqual([]);
  });

  test("K. a normal edit: no repair call and nothing changed", async () => {
    const { job } = seed();
    const before = [...planned.plans.long.map(pres), ...planned.plans.short.map(pres)];
    expect(await runJob(job.id)).toBe("preview_gate");
    expect([...shots(job.id).map(pres), ...shots(job.id, "short").map(pres)]).toEqual(before);
    expect(h.calls).toEqual([]);
    expect(getJob(job.id)!.spent).toBeCloseTo(1 + imageSpend());
  });

  test("L. a repair that fails stops the job before the preview, in plain words; the fallback stays honestly labelled", async () => {
    let n = -1;
    const { job } = seed((plans) => void (n = plantHold(plans.long, "long")));
    h.failPlanted = true;
    h.keep = true;
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await expect(runJob(job.id)).rejects.toThrow(ARCHIVE_HOLD_REPAIR_FAILED);
      expect(logged).toHaveBeenCalledWith(expect.stringMatching(/^Post-acquisition edit check failed job=.* kind=long: /)); // the detail stays in the log
    } finally {
      logged.mockRestore();
    }
    const j = getJob(job.id)!;
    expect(j.state).toBe("failed");
    expect(j.scratch.spent).toBeCloseTo(j.spent); // the failed attempt's charge is kept for the budget
    expect(j.error).toBe(ARCHIVE_HOLD_REPAIR_FAILED);
    expect(j.error).not.toMatch(/presentation|Film Grammar|hold/i);
    expect(j.preview).toBeNull(); // no preview was exposed
    expect(j.previewApproved).toBe(false);
    expect(shots(job.id)[n]).toMatchObject({ truth: "reconstruction" });
    expect(shots(job.id)[n].source).toBeUndefined();
    expect(shots(job.id)[n].path).toMatch(/^images\//);
    expect(h.calls).toHaveLength(1); // one attempt, no retry
    expect(j.spent).toBeCloseTo(1 + imageSpend() + PRICING.openai.visualPlan); // the call is still charged
  });

  test("M. resume after a successful repair: no second call, no second charge", async () => {
    const { job } = seed((plans) => void plantHold(plans.long, "long"));
    h.failPlanted = true;
    await runJob(job.id);
    const spent = getJob(job.id)!.spent;
    const edit = JSON.stringify(shots(job.id));
    h.calls = [];
    const images = h.images;
    updateJob(job.id, { state: "queued" }); // e.g. a restart picks the job up again
    await runJob(job.id);
    expect(h.calls).toEqual([]);
    expect(h.images).toBe(images);
    expect(getJob(job.id)!.spent).toBe(spent);
    expect(JSON.stringify(shots(job.id))).toBe(edit);
    expect(getJob(job.id)!.state).toBe("awaiting_preview");
  });

  test("N. Long and Short are checked and repaired independently, each with its own one call", async () => {
    const at: Record<Kind, number> = { long: -1, short: -1 };
    const { job } = seed((plans) => {
      at.long = plantHold(plans.long, "long");
      at.short = plantHold(plans.short, "short");
    });
    h.failPlanted = true;
    expect(await runJob(job.id)).toBe("preview_gate");
    expect(h.calls.map((c) => [c.input.match(/FILM: (\w+)/)[1], Object.keys(c.schema.properties.changes.properties)])).toEqual([
      ["LONG", [String(at.long + 1)]],
      ["SHORT", [String(at.short + 1)]],
    ]);
    for (const kind of ["long", "short"] as const) expect(() => strictlyValid(job.id, kind)).not.toThrow();
    // Only the Short broken: the Long is left alone.
    const second = seed((plans) => void (at.short = plantHold(plans.short, "short")));
    h.calls = [];
    await runJob(second.job.id);
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0].input).toContain("FILM: SHORT");
    expect(shots(second.job.id).map(pres)).toEqual(planned.plans.long.map(pres));
  });
});

describe("post-acquisition edit integrity: anything else invalid stops the job before the preview", () => {
  // Run a job expected to stop at the check; returns the logged diagnostics.
  async function stopped(jobId: string): Promise<string[]> {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await expect(runJob(jobId)).rejects.toThrow(ACQUIRED_EDIT_INVALID);
      return log.mock.calls.map((c) => String(c[0]));
    } finally {
      log.mockRestore();
    }
  }
  function expectStoppedBeforePreview(jobId: string): void {
    const j = getJob(jobId)!;
    expect(j.state).toBe("failed");
    expect(j.error).toBe(ACQUIRED_EDIT_INVALID);
    expect(j.error).not.toMatch(/presentation|Film Grammar|slot|hold/i);
    expect(j.preview).toBeNull();
    expect(h.calls).toEqual([]); // no repair call
  }

  test("A, B. the saved shots are checked against the authoritative planSlots grid: shots off that grid stop the job", async () => {
    const { job } = seed((plans) => {
      // Same presentations, but two slot boundaries moved half a second off the planned grid.
      plans.long[5].endSec += 0.5;
      plans.long[6].startSec += 0.5;
    });
    const logged = await stopped(job.id);
    expectStoppedBeforePreview(job.id);
    expect(logged).toEqual([expect.stringMatching(/^Post-acquisition edit check failed job=.* kind=long: The stored long edit no longer matches its fixed slots/)]);
    // One shot fewer than the grid has slots: also stopped.
    const short = seed((plans) => void plans.short.pop());
    h.calls = [];
    expect((await stopped(short.job.id))[0]).toMatch(/kind=short: The stored short edit no longer matches its fixed slots/);
    expectStoppedBeforePreview(short.job.id);
  });

  test("C. an adjacent reconstruction repeat that is no broken archive hold: no repair call, the job stops", async () => {
    let n = -1;
    const { job } = seed((plans) => {
      const list = plans.long;
      const owner = list.find((s) => s.edit === "new" && s.truth === "reconstruction" && s.presentation === "base" && !s.wantsMotion)!;
      n = list.findIndex((s, i) => i > owner.index + 2 && s.edit === "reuse" && list[i + 1]?.edit === "reuse" && !s.wantsMotion && !list[i + 1].wantsMotion && pres(list[i - 1]) !== pres(owner) && pres(list[i + 2]) !== pres(owner));
      for (const i of [n, n + 1]) {
        const reuse: Shot = { ...list[i], assetId: owner.assetId, presentation: "base", framing: owner.framing, truth: owner.truth, assetShot: owner.index, prompt: owner.prompt, purpose: owner.purpose, mustShow: owner.mustShow, mustNotShow: owner.mustNotShow };
        delete reuse.focus;
        delete reuse.archiveQuery;
        list[i] = reuse;
      }
    });
    const logged = await stopped(job.id);
    expectStoppedBeforePreview(job.id);
    expect(logged[0]).toMatch(new RegExp(`kind=long: Invalid edit plan: long slot ${n + 1} .* repeats slot ${n}`));
  });
});
