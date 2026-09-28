import { describe, test, expect, vi, beforeAll, beforeEach } from "vitest";
import { mkdtempSync, mkdirSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

// The retained presentation pool: once a saved film edit has shown a presentation
// with its acquired still, a later sequence revision can select it again after
// its last slot moved away. Mock mode with a real stored plan (mock narration,
// the fallback planners, mock stills); every provider is a fake that counts calls.
const tmp = mkdtempSync(path.join(os.tmpdir(), "pb4-retained-"));
process.env.PROVIDER_MODE = "mock";
process.env.PB4_DATA_DIR = path.join(tmp, "data");
process.env.PB4_MEDIA_DIR = path.join(tmp, "media");

const h = vi.hoisted(() => ({ calls: [] as any[], images: 0, other: 0 }));
vi.mock("../src/providers/openai.ts", () => ({
  respondJson: vi.fn(async (o: any) => {
    h.calls.push(o);
    throw new Error(`unexpected provider call ${o.schemaName}`);
  }),
  imageMimeType: () => "image/png",
  generateImageFile: vi.fn(async () => void h.images++),
}));
vi.mock("../src/providers/runway.ts", () => ({ generateMotion: vi.fn(async () => void h.other++) }));
vi.mock("../src/production/wikimedia.ts", () => ({ fetchArchive: vi.fn(async () => (h.other++, null)) }));

const { runJob, reviseSequenceForJob, directorReviewForJob, directorRepairForJob, directorCoordinateForJob, regenerateStill, clearVisualsForRebuild, newJobId } = await import("../src/production/generate.ts");
const v = await import("../src/production/visuals.ts");
const { recordNarration } = await import("../src/production/narration.ts");
const { createJob, getJob, updateJob, upsertStory } = await import("../src/server/store.ts");
const { ensureStoryDirs, inStory } = await import("../src/production/paths.ts");
const { paulBunyanStory, paulBunyanResearch, paulBunyanScripts } = await import("../src/production/fixtures/paulBunyan.ts");
type Shot = import("../src/production/visuals.ts").PlannedShot;

beforeEach(() => {
  h.calls = [];
  h.images = 0;
  h.other = 0;
});

let planned: { narration: any; plans: { long: Shot[]; short: Shot[] } };
beforeAll(async () => {
  const slug = "retained-plan";
  const story = { ...paulBunyanStory, id: slug, slug, title: "A Neutral Story", createdAt: new Date().toISOString() };
  ensureStoryDirs(slug);
  const narration = { long: await recordNarration(slug, "long", paulBunyanScripts.long), short: await recordNarration(slug, "short", paulBunyanScripts.short) };
  planned = { narration, plans: await v.planVisuals(story, paulBunyanResearch, paulBunyanScripts, narration) };
});

let seq = 0;
function newStory() {
  const slug = `retained-${seq++}`;
  const story = { ...paulBunyanStory, id: slug, slug, title: "A Neutral Story", createdAt: new Date().toISOString() };
  upsertStory(story);
  ensureStoryDirs(slug);
  // A tiny reference frame makes each mock still a quick copy; the master is on disk.
  mkdirSync(inStory(slug, "refs"), { recursive: true });
  writeFileSync(inStory(slug, "refs/ref.png"), "ref");
  writeFileSync(inStory(slug, "images/hero.png"), "master");
  return story;
}

// A job taken through the normal pipeline from its saved plan: acquisition (mock
// stills), resolveReuse and the preview gate. This is where the pool is first saved.
async function seed() {
  const story = newStory();
  const job = createJob({ id: newJobId(), storyId: story.id, mock: true, estimatedCost: 5, approvedMax: 10 });
  const plans = structuredClone(planned.plans);
  const scratch = { research: paulBunyanResearch, scripts: paulBunyanScripts, textApproved: true, narration: planned.narration, masterRef: "images/hero.png", spent: 1, longShots: plans.long, shortShots: plans.short };
  updateJob(job.id, { scratch: scratch as any, spent: 1 });
  await runJob(job.id);
  expect(getJob(job.id)!.state).toBe("awaiting_preview");
  return { job, story };
}

// An older job saved before the pool existed: the same stored edit, no pool.
function seedLegacy() {
  const story = newStory();
  const plans = structuredClone(planned.plans);
  for (const kind of ["long", "short"] as const) {
    for (const s of plans[kind]) {
      if (s.edit !== "new") continue;
      s.path = `images/${kind}-${String(s.index).padStart(2, "0")}.png`;
      s.mediaType = "image";
      writeFileSync(inStory(story.slug, s.path), `still ${kind} ${s.index}`);
    }
    v.resolveReuse(story, kind, plans[kind]);
  }
  const job = createJob({ id: newJobId(), storyId: story.id, mock: false, estimatedCost: 5, approvedMax: 10 });
  const scratch = { research: paulBunyanResearch, scripts: paulBunyanScripts, textApproved: true, narration: planned.narration, masterRef: "images/hero.png", spent: 1, longShots: plans.long, shortShots: plans.short };
  updateJob(job.id, { scratch: scratch as any, spent: 1, state: "awaiting_preview", step: "preview", previewApproved: false, preview: v.buildPreview(story, plans.long, plans.short) });
  return { job, story };
}

const shots = (id: string, kind: "long" | "short" = "long"): Shot[] => getJob(id)!.scratch[kind === "long" ? "longShots" : "shortShots"];
const pool = (id: string, kind: "long" | "short" = "long"): v.RetainedPresentation[] => getJob(id)!.scratch.retainedPresentations?.[kind];
const pres = (s: { assetId: string; presentation: string }) => `${s.assetId}:${s.presentation}`;
const ids = (list: { assetId: string; presentation: string }[]) => list.map(pres);
const uses = (id: string, p: string, kind: "long" | "short" = "long") => shots(id, kind).filter((s) => pres(s) === p).map((s) => s.index);
const noProviderWork = () => expect(h.calls.length + h.images + h.other).toBe(0);

// One bounded revision of one slot: the reviser picks `pick(choices)` for it and
// hands back the Editor input it was given.
async function reviseSlot(jobId: string, slot: number, pick: (choices: string[]) => string | undefined, kind: "long" | "short" = "long") {
  let seen: any;
  const r = await reviseSequenceForJob(jobId, kind, `Replace slot ${String(slot).padStart(2, "0")}.`, async (inp: any) => {
    seen = inp;
    const id = pick(inp.choices.get(slot) ?? []);
    return { changes: id ? { [slot]: id } : {}, unresolved: [] };
  });
  return { ...r, input: seen };
}

// Drop every current use of `asset`, one slot per revision (each one a legal
// one-slot change of the edit as it is saved then).
async function dropAsset(jobId: string, asset: string, kind: "long" | "short" = "long") {
  for (;;) {
    const slot = shots(jobId, kind).find((s) => s.assetId === asset);
    if (!slot) return;
    const r = await reviseSlot(jobId, slot.index, (c) => c.find((id) => !id.startsWith(`${asset}:`)), kind);
    expect(r.changed).toEqual([slot.index]);
  }
}

// A non-motion base-only asset whose slots never carry motion: the fixture's first graphic.
const graphicAsset = (list: Shot[]) => list.find((s) => s.truth === "graphic" && s.edit === "new" && !list.some((x) => x.assetId === s.assetId && x.wantsMotion))!;

describe("retained presentations: initial population", () => {
  test("the first saved edit fills each film's pool with exactly the presentations it shows, with their stills", async () => {
    const { job, story } = await seed();
    for (const kind of ["long", "short"] as const) {
      const list = shots(job.id, kind);
      const kept = pool(job.id, kind);
      expect(ids(kept)).toEqual([...new Set(ids(list))]); // each once, nothing unused
      for (const r of kept) {
        const owner = list.find((s) => s.assetId === r.assetId && s.edit === "new")!;
        expect(r.path).toBe(owner.path);
        expect(existsSync(inStory(story.slug, r.path))).toBe(true);
        expect(r).not.toHaveProperty("index");
        expect(r).not.toHaveProperty("caption");
        expect(r).not.toHaveProperty("wantsMotion");
      }
    }
    expect(ids(pool(job.id, "long")).every((id) => id.startsWith("L"))).toBe(true);
    expect(ids(pool(job.id, "short")).every((id) => id.startsWith("S"))).toBe(true);
    noProviderWork();
  });
});

describe("retained presentations: a dropped owner stays selectable", () => {
  test("core regression: A loses its last use, stays retained with the same file, and is selected again with no media call", async () => {
    const { job, story } = await seed();
    const original = shots(job.id);
    const owner = graphicAsset(original);
    const A = pres(owner);
    const file = owner.path!;
    const bytes = readFileSync(inStory(story.slug, file));
    expect(ids(pool(job.id))).toContain(A);

    await dropAsset(job.id, owner.assetId);
    expect(uses(job.id, A)).toEqual([]); // current usage is zero
    expect(ids(pool(job.id))).toContain(A); // still retained
    expect(pool(job.id).find((r) => pres(r) === A)!.path).toBe(file);
    expect(readFileSync(inStory(story.slug, file))).toEqual(bytes); // the same existing file

    // The next revision's menu offers it, reported as unused, and its original slot may take it again.
    const r = await reviseSlot(job.id, owner.index, (c) => c.find((id) => id === A));
    expect(r.input.presentations.map((p: any) => p.id)).toContain(A);
    expect(v.sequenceRevisionPayload(r.input)).toMatch(new RegExp(`${A} - [^\\n]*\\n[\\s\\S]*?used now at slots: none`));
    expect(r.changed).toEqual([owner.index]);

    // A owns its existing still again; nothing was generated.
    const now = shots(job.id);
    expect(now[owner.index].edit).toBe("new");
    expect(now[owner.index].path).toBe(file);
    expect(now[owner.index].mediaType).toBe("image");
    expect(now[owner.index].truth).toBe(owner.truth);
    expect(now[owner.index].prompt).toBe(owner.prompt);
    expect(now[owner.index].motion).toBe("hold");
    expect(now[owner.index].startSec).toBe(owner.startSec); // timing unchanged
    expect(now[owner.index].endSec).toBe(owner.endSec);
    expect(() => v.assertFilmGrammarPlan("long", now)).not.toThrow();
    expect(() => v.resolveReuse(story, "long", now)).not.toThrow();
    expect(getJob(job.id)!.preview!.frames.find((f) => f.kind === "long" && f.slot === owner.index)!.asset).toBe(owner.assetId);
    noProviderWork();

    // A second use of A becomes a reuse of that owner.
    const other = original.find((s) => s.assetId === owner.assetId && s.index !== owner.index)!;
    await reviseSlot(job.id, other.index, (c) => c.find((id) => id === A));
    const after = shots(job.id);
    expect(after[other.index]).toMatchObject({ edit: "reuse", assetShot: owner.index, path: file });
    expect(() => v.assertFilmGrammarPlan("long", after)).not.toThrow();
    noProviderWork();
  });

  test("the pool never duplicates an entry and never shrinks across revisions", async () => {
    const { job } = await seed();
    const first = ids(pool(job.id));
    const owner = graphicAsset(shots(job.id));
    await dropAsset(job.id, owner.assetId);
    await reviseSlot(job.id, owner.index, (c) => c.find((id) => id === pres(owner)));
    await reviseSlot(job.id, owner.index, (c) => c.find((id) => id !== pres(owner)));
    const kept = ids(pool(job.id));
    expect(new Set(kept).size).toBe(kept.length);
    expect(kept).toEqual(first); // the same presentations, nothing new, nothing lost
    noProviderWork();
  });

  test("Long and Short keep separate pools", async () => {
    const { job } = await seed();
    const shortPool = JSON.stringify(pool(job.id, "short"));
    const owner = graphicAsset(shots(job.id));
    await dropAsset(job.id, owner.assetId);
    expect(JSON.stringify(pool(job.id, "short"))).toBe(shortPool); // a Long revision never touches the Short pool

    const slot = shots(job.id, "short").find((s) => !s.wantsMotion && s.index > 0)!;
    const r = await reviseSlot(job.id, slot.index, () => undefined, "short");
    expect(r.input.presentations.every((p: any) => p.id.startsWith("S"))).toBe(true); // no Long media in the Short menu
    expect([...r.input.choices.values()].flat().some((id: string) => id.startsWith("L"))).toBe(false);
    expect(ids(pool(job.id, "long"))).toContain(pres(owner));
    noProviderWork();
  });
});

describe("retained presentations: every existing rule still applies", () => {
  test("a zero-use presentation is never offered to a locked slot, and a pick there is not applied", async () => {
    const { job } = await seed();
    const owner = graphicAsset(shots(job.id));
    const A = pres(owner);
    await dropAsset(job.id, owner.assetId);
    const before = ids(shots(job.id));
    let seen: any;
    const r = await reviseSequenceForJob(job.id, "long", `Keep slot ${String(owner.index).padStart(2, "0")}.`, async (inp: any) => {
      seen = inp;
      return { changes: { [owner.index]: A }, unresolved: [] };
    });
    expect(seen.presentations.map((p: any) => p.id)).toContain(A); // in the film's menu...
    expect(seen.choices.has(owner.index)).toBe(false); // ...but the kept slot has no choices at all
    for (const s of shots(job.id).filter((x) => x.wantsMotion)) expect(seen.choices.has(s.index)).toBe(false); // nor any motion slot
    expect(r.changed).toEqual([]);
    expect(r.unresolved).toEqual([{ slotId: owner.index, reason: "Not changed: the Director asked to keep this slot" }]);
    expect(ids(shots(job.id))).toEqual(before);
    noProviderWork();
  });

  test("a zero-use presentation on two adjacent slots fails validateEdit and nothing is saved", async () => {
    const { job } = await seed();
    const owner = graphicAsset(shots(job.id));
    const A = pres(owner);
    await dropAsset(job.id, owner.assetId);
    const before = ids(shots(job.id));
    const target = owner.index;
    const r = await directorCoordinateForJob(job.id, "long", target, "needs the chart", async (inp: any) => {
      expect(inp.presentations.map((p: any) => p.id)).toContain(A);
      return { changes: { [target]: A, [target + 1]: A }, unresolved: [] };
    });
    expect(r.report.error).toMatch(/adjacent slots must not show the identical presentation/);
    expect(ids(shots(job.id))).toEqual(before);
    expect(uses(job.id, A)).toEqual([]);
    noProviderWork();
  });

  test("a retained presentation whose file is missing is unavailable and never regenerated", async () => {
    const { job, story } = await seed();
    const owner = graphicAsset(shots(job.id));
    const A = pres(owner);
    await dropAsset(job.id, owner.assetId);
    rmSync(inStory(story.slug, owner.path!));

    let seen: any;
    await expect(
      reviseSequenceForJob(job.id, "long", "Replace the slot.", async (inp: any) => {
        seen = inp;
        return { changes: { [owner.index]: A }, unresolved: [] };
      }),
    ).rejects.toThrow(new RegExp(`presentationId "${A}" is not an existing long presentation`));
    expect(seen.presentations.map((p: any) => p.id)).not.toContain(A);
    expect([...seen.choices.values()].flat()).not.toContain(A);
    expect(uses(job.id, A)).toEqual([]);
    expect(existsSync(inStory(story.slug, owner.path!))).toBe(false); // not recreated
    expect(ids(pool(job.id))).toContain(A); // kept, just unavailable
    noProviderWork();
  });
});

describe("retained presentations: regeneration", () => {
  test("regenerating an active owner keeps every entry of its asset, pointing at its current still", async () => {
    const { job, story } = await seed();
    // L00-style asset: a reconstruction with base and detail presentations.
    const list = shots(job.id);
    const owner = list.find((s) => s.edit === "new" && s.truth === "reconstruction" && !s.wantsMotion && list.filter((x) => x.assetId === s.assetId).length >= 3)!;
    const asset = owner.assetId;
    const entries = ids(pool(job.id)).filter((id) => id.startsWith(`${asset}:`));
    expect(entries.length).toBeGreaterThan(1);
    // Move ownership: the owner slot takes another asset, so the asset's next use owns its still.
    await reviseSlot(job.id, owner.index, (c) => c.find((id) => !id.startsWith(`${asset}:`)));
    const moved = shots(job.id).find((s) => s.assetId === asset && s.edit === "new")!;
    expect(moved.index).not.toBe(owner.index);
    expect(moved.path).toBe(owner.path);

    await regenerateStill(job.id, "long", moved.index);
    const now = shots(job.id).find((s) => s.assetId === asset && s.edit === "new")!;
    expect(now.index).toBe(moved.index);
    const kept = pool(job.id).filter((r) => r.assetId === asset);
    expect(ids(kept)).toEqual(entries); // the same logical entries, none added or lost
    for (const r of kept) expect(r.path).toBe(now.path); // including any presentation not in use now
    expect(existsSync(inStory(story.slug, now.path!))).toBe(true);
    expect(new Set(ids(pool(job.id))).size).toBe(pool(job.id).length);
  });
});

describe("retained presentations: regenerating a reselected zero-use asset", () => {
  test("C: the regenerated still replaces A's retained file, every use follows it, and no other asset is touched", async () => {
    const { job, story } = await seed();
    const original = shots(job.id);
    const owner = graphicAsset(original);
    const A = pres(owner);
    const file = owner.path!;
    const second = original.find((s) => s.assetId === owner.assetId && s.index !== owner.index)!;
    await dropAsset(job.id, owner.assetId);
    // Reselected first at a DIFFERENT slot, which becomes its owner, then at its old slot as a reuse.
    await reviseSlot(job.id, second.index, (c) => c.find((id) => id === A));
    await reviseSlot(job.id, owner.index, (c) => c.find((id) => id === A));
    const moved = shots(job.id)[second.index];
    expect(moved).toMatchObject({ edit: "new", path: file });
    expect(shots(job.id)[owner.index]).toMatchObject({ edit: "reuse", assetShot: second.index });

    const others = pool(job.id).filter((r) => r.assetId !== owner.assetId);
    const slotPath = `images/long-${String(second.index).padStart(2, "0")}.png`;
    const bytes = new Map(others.map((r) => [r.path, readFileSync(inStory(story.slug, r.path), "utf8")]));
    writeFileSync(inStory(story.slug, "refs/ref.png"), "regenerated A"); // the mock still's source
    await regenerateStill(job.id, "long", second.index);

    expect(readFileSync(inStory(story.slug, file), "utf8")).toBe("regenerated A"); // A's own retained file, replaced
    expect(existsSync(inStory(story.slug, slotPath))).toBe(false); // never a file named after the new owner slot
    for (const s of shots(job.id).filter((x) => x.assetId === owner.assetId)) expect(s.path).toBe(file);
    expect(pool(job.id).find((r) => pres(r) === A)!.path).toBe(file);
    expect(pool(job.id).filter((r) => r.assetId !== owner.assetId)).toEqual(others); // no effect on any other asset
    for (const [rel, body] of bytes) expect(readFileSync(inStory(story.slug, rel), "utf8")).toBe(body);
    expect(ids(pool(job.id)).filter((id) => id.startsWith(`${owner.assetId}:`))).toEqual([A]); // same logical asset
    noProviderWork();
  });
});

describe("retained presentations: older jobs", () => {
  test("a job without a pool seeds it from its CURRENT shots only; earlier losses are not restored", async () => {
    const { job, story } = seedLegacy();
    expect(getJob(job.id)!.scratch.retainedPresentations).toBeUndefined();
    // A still of an asset dropped before the pool existed: its file remains, its metadata is gone.
    writeFileSync(inStory(story.slug, "images/long-99.png"), "lost");
    const current = [...new Set(ids(shots(job.id)))];
    const owner = graphicAsset(shots(job.id));
    const A = pres(owner);

    // The first revision on the older job drops A's owner slot...
    const slot = owner.index;
    const r = await reviseSlot(job.id, slot, (c) => c.find((id) => !id.startsWith(`${owner.assetId}:`)));
    expect(r.input.presentations.map((p: any) => p.id).sort()).toEqual([...current].sort()); // the menu is the current edit only
    // ...and the pool now holds exactly the presentations the edit showed before and after it.
    expect(ids(pool(job.id)).sort()).toEqual([...current].sort());
    expect(pool(job.id).some((p) => p.path === "images/long-99.png")).toBe(false); // nothing is inferred from disk
    expect(getJob(job.id)!.scratch.retainedPresentations.short).toBeUndefined(); // the Short pool seeds when the Short is saved

    // Losses stop from here on: A can drop to zero uses and still be offered.
    await dropAsset(job.id, owner.assetId);
    const again = await reviseSlot(job.id, slot, (c) => c.find((id) => id === A));
    expect(again.changed).toEqual([slot]);
    expect(shots(job.id)[slot].path).toBe(owner.path);
    noProviderWork();
  });
});

describe("retained presentations: Director QA", () => {
  test("the Director review and its repair see a zero-use retained presentation through the normal menu", async () => {
    const { job } = await seed();
    const owner = graphicAsset(shots(job.id));
    const A = pres(owner);
    await dropAsset(job.id, owner.assetId);

    let payload = "";
    const review = await directorReviewForJob(job.id, "long", (input) =>
      v.openAiDirectorQa(input, (async (o: any) => ((payload = o.input), { repairs: { [owner.index]: { reason: "the chart belongs here", instruction: `Show ${A}.` } }, humanReview: {}, summary: "One repair." })) as any),
    );
    expect(payload).toMatch(new RegExp(`${A} - [^\\n]*\\n[\\s\\S]*?used now at slots: none`));
    expect(review.qa.repairs.map((f) => f.slotId)).toEqual([owner.index]);

    let offered: string[] = [];
    const r = await directorRepairForJob(job.id, "long", review.qa.repairs, async (inp: any) => ((offered = inp.choices.get(owner.index)), { changes: { [owner.index]: A }, unresolved: [] }));
    expect(offered).toContain(A);
    expect(r.changed).toEqual([owner.index]);
    expect(shots(job.id)[owner.index]).toMatchObject({ edit: "new", path: owner.path });
    noProviderWork(); // no Coverage, image, motion or archive call; the reviewers are local fakes
  });
});

describe("retained presentations: rebuild", () => {
  test("rebuilding the visuals clears the pools and their stills, so a new plan cannot pick up old media", async () => {
    const { job, story } = await seed();
    const owner = graphicAsset(shots(job.id));
    await dropAsset(job.id, owner.assetId);
    expect(existsSync(inStory(story.slug, owner.path!))).toBe(true);
    clearVisualsForRebuild(job.id);
    expect(getJob(job.id)!.scratch.retainedPresentations).toBeUndefined();
    expect(existsSync(inStory(story.slug, owner.path!))).toBe(false);
    expect(existsSync(inStory(story.slug, "images/hero.png"))).toBe(true); // the master stays
  });
});

describe("retainPresentations", () => {
  const shot = (index: number, assetId: string, presentation: Shot["presentation"], over: Partial<Shot> = {}): Shot => ({
    index, edit: "new", assetId, presentation, framing: "wide", startSec: index, endSec: index + 1, truth: "reconstruction", motion: "hold", wantsMotion: false,
    prompt: `prompt ${assetId}`, purpose: `purpose ${assetId}`, mustShow: ["a"], mustNotShow: [], wordStart: index, wordEnd: index + 1, path: `images/long-0${index}.png`, mediaType: "image", ...over,
  });

  test("adds, refreshes in place and never removes; shots without a still are ignored", () => {
    const a = shot(0, "L00", "base");
    const b = shot(1, "L01", "base", { focus: "x" });
    const pool1 = v.retainPresentations(undefined, [a, b, shot(2, "L02", "base", { path: undefined })]);
    expect(ids(pool1)).toEqual(["L00:base", "L01:base"]);
    const pool2 = v.retainPresentations(pool1, [shot(0, "L00", "detail-left", { edit: "new", path: "images/long-05.png", truth: "reconstruction" })]);
    expect(ids(pool2)).toEqual(["L00:base", "L01:base", "L00:detail-left"]);
    expect(pool2.filter((r) => r.assetId === "L00").every((r) => r.path === "images/long-05.png")).toBe(true); // follows the owner's still
    expect(pool2.find((r) => r.assetId === "L01")!.path).toBe("images/long-01.png"); // unused: left as it was
    expect(v.retainPresentations(pool2, [])).toEqual(pool2);
  });

  test("storedPresentations appends retained unused ones, never motion eligible, and never duplicates", () => {
    const a = shot(0, "L00", "base", { motionPriority: 2 });
    const kept = v.retainPresentations(undefined, [a, shot(1, "L01", "base")]);
    const menu = v.storedPresentations([a], kept);
    expect(menu.map((p) => p.id)).toEqual(["L00:base", "L01:base"]);
    expect(menu[0].motionEligible).toBe(true);
    expect(menu[1]).toMatchObject({ motionEligible: false, description: "reconstruction, wide: purpose L01", elements: ["a"] });
    expect(v.storedPresentations([a]).map((p) => p.id)).toEqual(["L00:base"]); // without a pool: as before
  });
});
