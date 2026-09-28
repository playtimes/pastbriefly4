import { describe, test, expect, vi, beforeAll, beforeEach } from "vitest";
import { mkdtempSync, existsSync, readdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";

// Director sequence revision at the visual preview gate: one bounded Editor repair
// of ONE film's stored edit, using only presentations that film already shows. The
// fixture is a real stored plan (mock narration, the fallback planners and mock
// stills). Every provider is a fake that counts calls; nothing live runs.
const tmp = mkdtempSync(path.join(os.tmpdir(), "pb4-seq-rev-"));
process.env.PROVIDER_MODE = "mock";
process.env.PB4_DATA_DIR = path.join(tmp, "data");
process.env.PB4_MEDIA_DIR = path.join(tmp, "media");

const h = vi.hoisted(() => ({ calls: [] as { schemaName: string; input: string; instructions: string; schema: any }[], answer: null as any, qa: null as any, coord: null as any, verify: null as any, images: 0, other: 0 }));
vi.mock("../src/providers/openai.ts", () => ({
  respondJson: vi.fn(async (o: any) => {
    h.calls.push(o);
    if (o.schemaName === "director_qa") return h.qa;
    if (o.schemaName === "coordinated_revision") return h.coord;
    if (o.schemaName === "director_verify") return h.verify;
    if (o.schemaName !== "sequence_revision") throw new Error(`unexpected provider call ${o.schemaName}`);
    return h.answer;
  }),
  imageMimeType: () => "image/png",
  generateImageFile: vi.fn(async () => void h.images++),
}));
vi.mock("../src/providers/runway.ts", () => ({ generateMotion: vi.fn(async () => void h.other++) }));
vi.mock("../src/production/wikimedia.ts", () => ({ fetchArchive: vi.fn(async () => (h.other++, null)) }));

const Fastify = (await import("fastify")).default;
const { registerRoutes } = await import("../src/server/routes.ts");
const { reviseSequenceForJob, newJobId, isRevisingSequence, directorReviewForJob, directorRepairForJob, directorCleanupForJob, directorCoordinateForJob, directorVerifyForJob } = await import("../src/production/generate.ts");
const { buildFilm } = await import("../src/app/visualReview/model.ts");
const { sequenceAttentionFlags } = await import("../src/app/visualReview/board.ts");
const v = await import("../src/production/visuals.ts");
const { recordNarration } = await import("../src/production/narration.ts");
const { createJob, getJob, updateJob, upsertStory } = await import("../src/server/store.ts");
const { ensureStoryDirs, inStory } = await import("../src/production/paths.ts");
const { setMode, config } = await import("../src/server/config.ts");
const { PRICING } = await import("../src/server/pricing.ts");
const { paulBunyanStory, paulBunyanResearch, paulBunyanScripts } = await import("../src/production/fixtures/paulBunyan.ts");
type Shot = import("../src/production/visuals.ts").PlannedShot;

let app: FastifyInstance;
beforeAll(async () => {
  app = Fastify();
  await registerRoutes(app);
  await app.ready();
});
beforeEach(() => {
  h.calls = [];
  h.answer = { changes: {}, unresolved: [] };
  h.qa = { repairs: {}, humanReview: {}, summary: "Nothing notable." };
  h.images = 0;
  h.other = 0;
});

// A job at the visual preview with a real stored plan for both films. The plan
// (mock narration + the fallback planners) is made once; each job gets its own
// story folder with a small file standing in for every owner's still.
let seq = 0;
let planned: { narration: any; plans: { long: Shot[]; short: Shot[] } };
beforeAll(async () => {
  const slug = "seq-rev-plan";
  const story = { ...paulBunyanStory, id: slug, slug, title: "A Neutral Story", createdAt: new Date().toISOString() };
  ensureStoryDirs(slug);
  const narration = { long: await recordNarration(slug, "long", paulBunyanScripts.long), short: await recordNarration(slug, "short", paulBunyanScripts.short) };
  planned = { narration, plans: await v.planVisuals(story, paulBunyanResearch, paulBunyanScripts, narration) };
});
async function seed() {
  const slug = `seq-rev-${seq++}`;
  const story = { ...paulBunyanStory, id: slug, slug, title: "A Neutral Story", createdAt: new Date().toISOString() };
  upsertStory(story);
  ensureStoryDirs(slug);
  const narration = planned.narration;
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
  const job = createJob({ id: newJobId(), storyId: story.id, mock: false, estimatedCost: 5, approvedMax: 10 });
  const scratch = { research: paulBunyanResearch, scripts: paulBunyanScripts, textApproved: true, narration, masterRef: "images/hero.png", spent: 1, longShots: plans.long, shortShots: plans.short };
  updateJob(job.id, { scratch: scratch as any, spent: 1, state: "awaiting_preview", step: "preview", previewApproved: false, preview: v.buildPreview(story, plans.long, plans.short) });
  h.images = 0; // the fixture's mock stills are not the revision's work
  return { job, story, slug };
}
const shots = (id: string, kind: "long" | "short" = "long"): Shot[] => getJob(id)!.scratch[kind === "long" ? "longShots" : "shortShots"];
const pres = (s: Shot) => `${s.assetId}:${s.presentation}`;
// A stored presentation that differs from a slot and both its neighbours.
function replacementFor(list: Shot[], slot: number, avoidAsset?: string): string {
  const ids = v.storedPresentations(list).map((p) => p.id);
  const near = [list[slot - 1], list[slot], list[slot + 1]].filter(Boolean).map(pres);
  return ids.find((id) => !near.includes(id) && (!avoidAsset || !id.startsWith(`${avoidAsset}:`)))!;
}
const reviser = (answer: unknown) => vi.fn(async () => answer);

describe("the stored film as the Editor's menu", () => {
  test("only presentations the film already shows are offered, each once", async () => {
    const { job } = await seed();
    const list = shots(job.id);
    const offered = v.storedPresentations(list);
    expect(offered.map((p) => p.id).sort()).toEqual([...new Set(list.map(pres))].sort());
    for (const id of new Set(list.map((s) => s.assetId))) expect(offered.some((p) => p.id === `${id}:base`)).toBe(true);
    expect(offered.every((p) => p.id.startsWith("L"))).toBe(true); // never the other film
  });

  test("explicit KEEP lines lock slot numbers; asset ids and durations are not slots", () => {
    const feedback = `OPENING
- Replace slots 00 and 02.
- Keep slot 01.
- Keep X04 only at slot 03.
- Keep 15, 17, 18, 20 and 23.
- Keep motion owner X01 at 24.
- Keep one occurrence of each at 11/12.
- Keep the opening under 15 seconds.
- Reduce X19 from four appearances.`;
    expect(v.keptSlots(feedback, 38)).toEqual([1, 3, 11, 12, 15, 17, 18, 20, 23, 24]);
    expect(v.keptSlots("Keep slot 40.", 38)).toEqual([]);
  });

  test("the Editor call carries this film's slots, current edit, locks, menu and the feedback", async () => {
    const { job, story } = await seed();
    const list = shots(job.id);
    const slots = v.planSlots("long", paulBunyanScripts.long, getJob(job.id)!.scratch.narration.long);
    const locked = new Map([[1, "the Director asked to keep this slot"]]);
    const presentations = v.storedPresentations(list);
    const choices = v.sequenceSlotChoices("long", slots, list, presentations, locked, story);
    const respond = vi.fn(async () => ({ changes: {}, unresolved: [] }));
    await v.openAiSequenceRevision({ story, kind: "long", slots, shots: list, presentations, locked, choices, feedback: "Replace slot 00. Keep slot 01." }, respond as any);
    const call = (respond.mock.calls[0] as any)[0];
    expect(call.schemaName).toBe("sequence_revision");
    expect(call.instructions).toBe(v.SEQUENCE_REVISION_INSTRUCTIONS);
    expect(call.instructions).toMatch(/If no available presentation can satisfy a requested change/);
    expect(call.input).toContain("FILM: LONG");
    for (const s of slots) expect(call.input).toContain(`SLOT #${s.id}\n`);
    expect(call.input).toContain(`current: ${pres(list[0])} (owner)`);
    expect(call.input).toContain("LOCKED: the Director asked to keep this slot");
    for (const p of presentations) expect(call.input).toContain(`${p.id} - `);
    expect(call.input).toContain("DIRECTOR FEEDBACK:\nReplace slot 00. Keep slot 01.");
    expect(call.input).not.toMatch(/SHORT CURRENT EDIT|S00:/);
    // Every open slot lists its own legal changes; the locked slot lists none.
    expect(call.input).toContain(`legal changes: ${choices.get(0)!.join(", ")}`);
    // "changes" is keyed by slot: one key per open slot with choices, each with only its own ids or null.
    const changes = call.schema.properties.changes;
    const open = [...choices].filter(([, ids]) => ids.length).map(([id]) => String(id));
    expect(changes.type).toBe("object");
    expect(changes.additionalProperties).toBe(false);
    expect(Object.keys(changes.properties)).toEqual(open);
    expect(changes.required).toEqual(open);
    expect(changes.properties["1"]).toBeUndefined(); // the locked slot is not a key
    for (const key of open) {
      expect(changes.properties[key].enum).toEqual([...choices.get(Number(key))!, null]);
    }
  });
});

// A tiny hand-made stored film: one slot per entry, base presentations only.
function film(spec: { asset: string; truth?: "archive" | "reconstruction" | "graphic" }[], dur = 4) {
  const slots = spec.map((_, i) => ({ id: i, startBeatId: i, endBeatId: i, wordStart: i, wordEnd: i + 1, startSec: i * dur, endSec: (i + 1) * dur, durationSec: dur, motionAllowed: false, excerpt: `words ${i}` }));
  const owners = new Map<string, number>();
  const list = spec.map((s, i): Shot => {
    const own = owners.get(s.asset);
    if (own === undefined) owners.set(s.asset, i);
    return {
      index: i, edit: own === undefined ? "new" : "reuse", ...(own === undefined ? {} : { assetShot: own }), assetId: s.asset, presentation: "base", framing: "wide",
      startSec: i * dur, endSec: (i + 1) * dur, truth: s.truth ?? "reconstruction", motion: "hold", wantsMotion: false, motionPriority: 0,
      prompt: "p", purpose: `purpose ${s.asset}`, mustShow: [], mustNotShow: [], wordStart: i, wordEnd: i + 1, path: `images/x-${owners.get(s.asset)}.png`, mediaType: "image",
    };
  });
  return { slots, list, presentations: v.storedPresentations(list) };
}

describe("legal choices per slot", () => {
  test("regression: a presentation locked on the next slot is never offered to the slot before it", async () => {
    const { job, story } = await seed();
    const beforeShort = JSON.stringify(shots(job.id, "short"));
    const list = shots(job.id);
    // Slot N is editable; slot N+1 is kept by the Director and shows presentation A.
    const n = list.findIndex((s, i) => i > 0 && !s.wantsMotion && list[i + 1] && !list[i + 1].wantsMotion && pres(list[i + 1]) !== pres(s));
    const a = pres(list[n + 1]);
    const feedback = `Replace slot ${n}. Keep slot ${n + 1}.`;
    expect(v.storedPresentations(list).map((p) => p.id)).toContain(a); // A is in the film's menu

    const schemas: any[] = [];
    const answerWith = (answer: unknown) => (input: any) =>
      v.openAiSequenceRevision(input, (async (o: any) => (schemas.push(o), answer)) as any);

    // The model picks A for slot N anyway: not offered, not applied, reported.
    const r1 = await reviseSequenceForJob(job.id, "long", feedback, answerWith({ changes: { [n]: a }, unresolved: [] }));
    const keyN = schemas[0].schema.properties.changes.properties[String(n)];
    expect(keyN.enum).not.toContain(a);
    expect(schemas[0].schema.properties.changes.properties[String(n + 1)]).toBeUndefined();
    expect(schemas[0].input).toMatch(new RegExp(`SLOT #${n + 1}\\n[\\s\\S]*?LOCKED: the Director asked to keep this slot`));
    expect(r1.changed).toEqual([]);
    expect(r1.unresolved).toEqual([{ slotId: n, reason: `Not changed: ${a} is not a legal choice for this slot.` }]);
    expect(shots(job.id).map(pres)).toEqual(list.map(pres));

    // A legal pick for slot N is saved; the locked neighbour keeps A.
    const legal = keyN.enum[0];
    const r2 = await reviseSequenceForJob(job.id, "long", feedback, answerWith({ changes: { [n]: legal }, unresolved: [] }));
    expect(r2.changed).toEqual([n]);
    expect(pres(shots(job.id)[n])).toBe(legal);
    expect(pres(shots(job.id)[n + 1])).toBe(a);
    expect(JSON.stringify(shots(job.id, "short"))).toBe(beforeShort);
    expect(h.images + h.other + h.calls.length).toBe(0); // no Coverage, image, motion or archive call
  });

  test("regression: a slot can be answered at most once, by construction", async () => {
    const { job, story } = await seed();
    const beforeShort = JSON.stringify(shots(job.id, "short"));
    const list = shots(job.id);
    const feedback = "Diversify the middle. Keep slot 01.";
    const slots = v.planSlots("long", paulBunyanScripts.long, getJob(job.id)!.scratch.narration.long);
    const locked = new Map<number, string>([[1, "kept"], ...list.filter((s) => s.wantsMotion).map((s) => [s.index, "motion"] as [number, string])]);
    const choices = v.sequenceSlotChoices("long", slots, list, v.storedPresentations(list), locked, story);
    // Slot S has several legal alternatives; slot T, well away from it, has its own.
    const s = [...choices].find(([id, ids]) => id > 1 && ids.length >= 2)![0];
    const t = [...choices].find(([id, ids]) => id > s + 3 && ids.length >= 1)![0];
    const [a, b] = choices.get(s)!;

    const schema = v.sequenceRevisionSchema({ slots, choices }).properties.changes as any;
    expect(schema.type).toBe("object");
    expect(schema.additionalProperties).toBe(false); // no key outside the listed slots
    expect(schema.properties[String(s)]).toEqual({ type: ["string", "null"], enum: [...choices.get(s)!, null] }); // one property, many legal values
    expect(schema.properties[String(t)].enum).toEqual([...choices.get(t)!, null]); // slot-specific
    for (const id of locked.keys()) expect(schema.properties[String(id)]).toBeUndefined();
    for (const [id, ids] of choices) if (!ids.length) expect(schema.properties[String(id)]).toBeUndefined();

    // The old failing shape (slot S listed twice) is no longer an accepted answer, and nothing is saved.
    await expect(
      reviseSequenceForJob(job.id, "long", feedback, reviser({ changes: [{ slotId: s, presentationId: a }, { slotId: s, presentationId: b }], unresolved: [] })),
    ).rejects.toThrow(/answer is not \{ "changes": \{/);
    expect(shots(job.id).map(pres)).toEqual(list.map(pres));

    // A keyed JSON answer holds one value per slot: a repeated key parses to one value, not two changes.
    const answer = JSON.parse(`{"changes":{"${s}":"${a}","${s}":"${b}","${t}":"${choices.get(t)![0]}"},"unresolved":[]}`);
    expect(Object.keys(answer.changes)).toEqual([String(s), String(t)]);
    const r = await reviseSequenceForJob(job.id, "long", feedback, reviser(answer));
    expect(r.changed).toEqual([s, t]); // each slot once
    expect(pres(shots(job.id)[s])).toBe(b);
    expect(pres(shots(job.id)[t])).toBe(choices.get(t)![0]);
    expect(pres(shots(job.id)[1])).toBe(pres(list[1]));
    expect(JSON.stringify(shots(job.id, "short"))).toBe(beforeShort);
    expect(h.images + h.other + h.calls.length).toBe(0);
  });

  test("motion and KEEP slots get no choices; every offered choice passes the existing checks alone", async () => {
    const { job, story } = await seed();
    const list = shots(job.id);
    const slots = v.planSlots("long", paulBunyanScripts.long, getJob(job.id)!.scratch.narration.long);
    const presentations = v.storedPresentations(list);
    const locked = new Map<number, string>([[2, "kept"], ...list.filter((s) => s.wantsMotion).map((s) => [s.index, "motion"] as [number, string])]);
    const choices = v.sequenceSlotChoices("long", slots, list, presentations, locked, story);
    for (const id of locked.keys()) expect(choices.has(id)).toBe(false);
    const current = v.storedEdit(list);
    for (const [slotId, ids] of choices) {
      expect(ids).not.toContain(current[slotId].presentationId);
      for (const id of ids) {
        const trial = current.map((e) => (e.slotId === slotId ? { slotId, presentationId: id, motionPriority: 0 } : e));
        expect(() => v.assertFilmGrammarPlan("long", v.reassembleStoredEdit(list, v.validateEdit("long", slots, trial, presentations)))).not.toThrow();
      }
      // ...and every presentation left out fails them.
      for (const p of presentations.filter((q) => !ids.includes(q.id) && q.id !== current[slotId].presentationId)) {
        const trial = current.map((e) => (e.slotId === slotId ? { slotId, presentationId: p.id, motionPriority: 0 } : e));
        expect(() => v.validateEdit("long", slots, trial, presentations)).toThrow();
      }
    }
  });

  test("the archive-hold rule decides an archive neighbour: a short pair is a legal hold, a long pair is not", () => {
    const spec = [{ asset: "A1", truth: "archive" as const }, { asset: "R1" }, { asset: "R2" }, { asset: "R1" }];
    const short = film(spec, 4); // 4 s + 4 s: an allowed two-slot hold
    const choicesShort = v.sequenceSlotChoices("long", short.slots, short.list, short.presentations, new Map());
    expect(choicesShort.get(1)).toContain("A1:base");
    expect(choicesShort.get(1)).not.toContain("R2:base"); // identical to slot 2
    expect(choicesShort.get(1)).not.toContain("R1:base"); // its current presentation
    const long = film(spec, 6); // 6 s + 6 s: over the hold limit
    expect(v.sequenceSlotChoices("long", long.slots, long.list, long.presentations, new Map()).get(1)).not.toContain("A1:base");
  });

  test("a slot with no legal alternative is reported unresolved, and the rest of the revision still applies", () => {
    // X Y Z X Y: slot 1's only alternatives are its neighbours' X and Z; slot 4 can still take Z.
    const f = film([{ asset: "X" }, { asset: "Y" }, { asset: "Z" }, { asset: "X" }, { asset: "Y" }]);
    const choices = v.sequenceSlotChoices("long", f.slots, f.list, f.presentations, new Map());
    expect(choices.get(1)).toEqual([]);
    expect(choices.get(3)).toEqual([]);
    expect(choices.get(4)).toEqual(["Z:base"]);
    expect(Object.keys(v.sequenceRevisionSchema({ slots: f.slots, choices }).properties.changes.properties)).toEqual(["0", "4"]);
    const r = v.applySequenceRevision("long", v.storedEdit(f.list), f.presentations, new Map(), choices, {
      changes: { 4: "Z:base", 1: "X:base", 0: null },
      unresolved: [{ slotId: 3, reason: "the model's own words" }],
    });
    expect(r.changed).toEqual([4]);
    expect(r.unresolved).toEqual([
      { slotId: 1, reason: v.NO_LEGAL_ALTERNATIVE },
      { slotId: 3, reason: v.NO_LEGAL_ALTERNATIVE },
    ]);
    expect(v.NO_LEGAL_ALTERNATIVE).toBe("No legal alternative existing presentation is available.");
    expect(() => v.validateEdit("long", f.slots, r.edit, f.presentations)).not.toThrow(); // the final check still passes
  });
});

describe("revising one film's sequence", () => {
  test("a targeted change is saved; kept, motion and unrelated slots and the other film stay as they were", async () => {
    const { job, slug } = await seed();
    const before = shots(job.id);
    const beforeShort = JSON.stringify(shots(job.id, "short"));
    const motion = before.find((s) => s.wantsMotion)!;
    const target = before.findIndex((s, i) => i > 1 && !s.wantsMotion && i !== motion.index && !before[i - 1].wantsMotion);
    const pick = replacementFor(before, target);
    const answer = {
      changes: {
        [target]: pick,
        1: replacementFor(before, 1), // kept by the Director
        [motion.index]: replacementFor(before, motion.index), // a motion slot
      },
      unresolved: [{ slotId: 0, reason: "no other existing visual shows the opening" }],
    };
    const r = await reviseSequenceForJob(job.id, "long", "Replace slot 00. Keep slot 01. Fix the middle.", reviser(answer));

    expect(r.changed).toEqual([target]);
    expect(r.unresolved.map((u) => u.slotId).sort((a, b) => a - b)).toEqual([0, 1, motion.index].sort((a, b) => a - b));
    expect(r.unresolved.find((u) => u.slotId === 0)!.reason).toBe("no other existing visual shows the opening");
    expect(r.unresolved.find((u) => u.slotId === 1)!.reason).toMatch(/Director asked to keep/);
    expect(r.unresolved.find((u) => u.slotId === motion.index)!.reason).toMatch(/motion slot/);

    const after = shots(job.id);
    expect(pres(after[target])).toBe(pick);
    after.forEach((s, i) => {
      // Fixed slots: timing, words and caption never move.
      expect([s.index, s.startSec, s.endSec, s.wordStart, s.wordEnd, s.caption]).toEqual([before[i].index, before[i].startSec, before[i].endSec, before[i].wordStart, before[i].wordEnd, before[i].caption]);
      if (i !== target) expect(pres(s)).toBe(pres(before[i]));
    });
    expect(after[motion.index]).toMatchObject({ wantsMotion: true, motion: "push", edit: "new" });
    expect(after.filter((s) => s.wantsMotion).map((s) => s.index)).toEqual(before.filter((s) => s.wantsMotion).map((s) => s.index));
    expect(after[target]).toMatchObject({ wantsMotion: false, motion: "hold", motionPriority: 0 });
    expect(JSON.stringify(shots(job.id, "short"))).toBe(beforeShort);

    // Owner/reuse stays coherent and every slot points at a still that already existed.
    expect(() => v.assertFilmGrammarPlan("long", after)).not.toThrow();
    const stills = new Set(before.map((s) => s.path));
    for (const s of after) {
      expect(stills.has(s.path)).toBe(true);
      expect(existsSync(inStory(slug, s.path!))).toBe(true);
    }
    const j = getJob(job.id)!;
    expect(j.state).toBe("awaiting_preview");
    expect(j.previewApproved).toBe(false);
    expect(j.preview!.frames.find((f) => f.kind === "long" && f.slot === target)!.asset).toBe(pick.split(":")[0]);
    expect(h.images + h.other).toBe(0);
  });

  test("replacing an asset's owning slot hands ownership to its next use, with the same still", async () => {
    const { job } = await seed();
    const before = shots(job.id);
    const owner = before.find((s) => s.edit === "new" && !s.wantsMotion && before.some((r) => r.edit === "reuse" && r.assetShot === s.index))!;
    const nextUse = before.find((s) => s.assetId === owner.assetId && s.index !== owner.index)!;
    const pick = replacementFor(before, owner.index, owner.assetId);
    await reviseSequenceForJob(job.id, "long", `Replace slot ${owner.index}.`, reviser({ changes: { [owner.index]: pick }, unresolved: [] }));
    const after = shots(job.id);
    const moved = after.find((s) => s.assetId === owner.assetId && s.edit === "new")!;
    expect(moved.index).toBe(nextUse.index);
    expect(moved.path).toBe(owner.path); // no new file, no new asset
    for (const s of after.filter((x) => x.assetId === owner.assetId && x.edit === "reuse")) expect(s.assetShot).toBe(nextUse.index);
    expect(new Set(after.filter((s) => s.edit === "new").map((s) => s.path)).size).toBe(after.filter((s) => s.edit === "new").length);
  });

  test("the final validation still runs: individually legal changes that clash together save nothing", async () => {
    const { job, story } = await seed();
    const before = JSON.stringify(getJob(job.id)!.scratch);
    const list = shots(job.id);
    const slots = v.planSlots("long", paulBunyanScripts.long, getJob(job.id)!.scratch.narration.long);
    const locked = new Map(list.filter((s) => s.wantsMotion).map((s) => [s.index, "motion"] as [number, string]));
    const choices = v.sequenceSlotChoices("long", slots, list, v.storedPresentations(list), locked, story);
    // Two neighbours that may each take the same presentation on their own...
    const target = list.findIndex((_, i) => (choices.get(i) ?? []).some((id) => (choices.get(i + 1) ?? []).includes(id)));
    const shared = choices.get(target)!.find((id) => choices.get(target + 1)!.includes(id))!;
    // ...but not both at once: validateEdit rejects the combined edit.
    await expect(
      reviseSequenceForJob(job.id, "long", "Change both.", reviser({ changes: { [target]: shared, [target + 1]: shared }, unresolved: [] })),
    ).rejects.toThrow(/Invalid edit plan: long .* repeats slot/);
    const target2 = list.findIndex((s, i) => i > 0 && !s.wantsMotion);
    // A presentation the film does not have, or a malformed answer.
    await expect(reviseSequenceForJob(job.id, "long", "Change it.", reviser({ changes: { [target2]: "L99:base" }, unresolved: [] }))).rejects.toThrow(/not an existing long presentation/);
    await expect(reviseSequenceForJob(job.id, "long", "Change it.", reviser("nonsense"))).rejects.toThrow(/Invalid sequence revision/);
    expect(JSON.stringify(getJob(job.id)!.scratch)).toBe(before);
    expect(getJob(job.id)!.state).toBe("awaiting_preview");
  });

  test("only a job at the visual preview can be revised, and the Short is revised on its own", async () => {
    const { job } = await seed();
    updateJob(job.id, { state: "awaiting_text" });
    await expect(reviseSequenceForJob(job.id, "long", "x", reviser({ changes: {}, unresolved: [] }))).rejects.toThrow(/visual preview/);
    updateJob(job.id, { state: "awaiting_preview" });
    const beforeLong = JSON.stringify(shots(job.id));
    const short = shots(job.id, "short");
    const target = short.findIndex((s, i) => i > 0 && !s.wantsMotion);
    const pick = replacementFor(short, target);
    const r = await reviseSequenceForJob(job.id, "short", "Replace one.", reviser({ changes: { [target]: pick }, unresolved: [] }));
    expect(r.changed).toEqual([target]);
    expect(pick.startsWith("S")).toBe(true);
    expect(JSON.stringify(shots(job.id))).toBe(beforeLong);
  });

  test("live: one visual-planning charge per call, even when the answer is rejected; the cap refuses before calling", async () => {
    const { job } = await seed();
    setMode("live");
    try {
      await expect(reviseSequenceForJob(job.id, "long", "x", reviser("nonsense"))).rejects.toThrow();
      expect(getJob(job.id)!.spent).toBeCloseTo(1 + PRICING.openai.visualPlan);
      updateJob(job.id, { approvedMax: 1.06 });
      const blocked = reviser({ changes: {}, unresolved: [] });
      await expect(reviseSequenceForJob(job.id, "long", "x", blocked)).rejects.toThrow(/Approved maximum/);
      expect(blocked).not.toHaveBeenCalled();
    } finally {
      setMode("mock");
    }
    expect(config.mode).toBe("mock");
  });
});

describe("POST /api/jobs/:id/revise-sequence", () => {
  const post = (id: string, payload: unknown) => app.inject({ method: "POST", url: `/api/jobs/${id}/revise-sequence`, payload });

  test("validates the feedback and the state before any call", async () => {
    const { job } = await seed();
    for (const directorFeedback of ["", "  \n "]) {
      const res = await post(job.id, { kind: "long", directorFeedback });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe("Director feedback is required.");
    }
    const long = await post(job.id, { kind: "long", directorFeedback: "x".repeat(4001) });
    expect(long.json().error).toBe("Director feedback must be 4,000 characters or fewer.");
    expect((await post(job.id, { kind: "both", directorFeedback: "x" })).statusCode).toBe(400);
    updateJob(job.id, { state: "done" });
    expect((await post(job.id, { kind: "long", directorFeedback: "x" })).statusCode).toBe(409);
    expect(h.calls).toEqual([]);
  });

  test("live: sends one sequence_revision call for the selected film and returns the report", async () => {
    const { job } = await seed();
    const list = shots(job.id);
    const target = list.findIndex((s, i) => i > 1 && !s.wantsMotion);
    h.answer = { changes: { [target]: replacementFor(list, target) }, unresolved: [{ slotId: 0, reason: "nothing else fits" }] };
    setMode("live");
    try {
      const res = await post(job.id, { kind: "long", directorFeedback: "  Replace the middle. Keep slot 01.  " });
      expect(res.statusCode).toBe(200);
      expect(res.json().revision).toEqual({ changed: [target], unresolved: [{ slotId: 0, reason: "nothing else fits" }] });
      expect(res.json().job.state).toBe("awaiting_preview");
      expect(h.calls.map((c) => c.schemaName)).toEqual(["sequence_revision"]);
      expect(h.calls[0].input).toContain("DIRECTOR FEEDBACK:\nReplace the middle. Keep slot 01.");
      expect(h.images + h.other).toBe(0);
    } finally {
      setMode("mock");
    }
  });

  test("a failed revision returns the error, logs one line without the feedback, and changes nothing", async () => {
    const { job } = await seed();
    const before = JSON.stringify(getJob(job.id)!.scratch.longShots);
    h.answer = { changes: { [0]: "L99:base" }, unresolved: [] };
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    setMode("live");
    try {
      const res = await post(job.id, { kind: "long", directorFeedback: "Secret note SN-9." });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toMatch(/not an existing long presentation/);
      expect(logged).toHaveBeenCalledOnce();
      expect(String(logged.mock.calls[0][0])).toMatch(new RegExp(`^Director sequence revision failed job=${job.id} kind=long feedbackLength=17 error=`));
      expect(String(logged.mock.calls[0][0])).not.toContain("SN-9");
    } finally {
      setMode("mock");
      logged.mockRestore();
    }
    expect(JSON.stringify(getJob(job.id)!.scratch.longShots)).toBe(before);
    expect(getJob(job.id)!.state).toBe("awaiting_preview");
  });

  test("mock mode makes no provider call and changes nothing", async () => {
    const { job } = await seed();
    const before = JSON.stringify(getJob(job.id)!.scratch.longShots);
    const res = await post(job.id, { kind: "long", directorFeedback: "Replace slot 02." });
    expect(res.statusCode).toBe(200);
    expect(res.json().revision).toEqual({ changed: [], unresolved: [] });
    expect(h.calls).toEqual([]);
    expect(JSON.stringify(getJob(job.id)!.scratch.longShots)).toBe(before);
  });

  test("Continue, Rebuild and Regenerate wait while a sequence revision runs", async () => {
    const { job, slug } = await seed();
    let finish!: (v: unknown) => void;
    const pending = reviseSequenceForJob(job.id, "long", "x", () => new Promise((r) => (finish = r)));
    expect(isRevisingSequence(job.id)).toBe(true);
    for (const url of ["continue", "rebuild-visuals"]) expect((await app.inject({ method: "POST", url: `/api/jobs/${job.id}/${url}` })).statusCode).toBe(409);
    expect((await app.inject({ method: "POST", url: `/api/jobs/${job.id}/regenerate-still`, payload: { kind: "long", slot: 0 } })).statusCode).toBe(409);
    finish({ changes: {}, unresolved: [] });
    await pending;
    expect(isRevisingSequence(job.id)).toBe(false);
    expect(getJob(job.id)!.previewApproved).toBe(false);
    expect(readdirSync(inStory(slug, "images")).some((f) => f.endsWith(".prev"))).toBe(false);
  });
});

describe("Director QA", () => {
  const qaPost = (id: string, kind: string) => app.inject({ method: "POST", url: `/api/jobs/${id}/director-qa`, payload: { kind } });
  const repairPost = (id: string, kind: string, repairs: unknown) => app.inject({ method: "POST", url: `/api/jobs/${id}/director-qa/repair`, payload: { kind, repairs } });
  // Capture exactly what the review model would receive.
  async function reviewInput(jobId: string, kind: "long" | "short") {
    let call: any;
    await directorReviewForJob(jobId, kind, (input) => v.openAiDirectorQa(input, (async (o: any) => ((call = o), { repairs: {}, humanReview: {}, summary: "" })) as any));
    return call;
  }

  test("the review sees every slot of the selected film once, with narration, caption, what it shows and the board's flags", async () => {
    const { job, story } = await seed();
    const list = shots(job.id);
    const slots = v.planSlots("long", paulBunyanScripts.long, getJob(job.id)!.scratch.narration.long);
    const call = await reviewInput(job.id, "long");
    expect(call.schemaName).toBe("director_qa");
    expect(call.instructions).toBe(v.DIRECTOR_QA_INSTRUCTIONS);
    expect(call.instructions).toMatch(/You cannot see the images/);
    for (const s of slots) {
      expect(call.input.split(`SLOT #${s.id}\n`).length - 1).toBe(1);
      expect(call.input).toContain(`narration: "${s.excerpt}"`);
    }
    expect(call.input).toContain(`caption: "${list[0].caption!.text}"`);
    const p0 = v.storedPresentations(list).find((p) => p.id === pres(list[0]))!;
    expect(call.input).toContain(`current: ${pres(list[0])} - ${p0.description} (owner)`);
    const fr = buildFilm(v.buildPreview(story, list, shots(job.id, "short")), "long");
    const flags = sequenceAttentionFlags(fr);
    expect(call.input).toContain(`SLOT #0\n`);
    expect(call.input).toMatch(new RegExp(`flags: ${flags[0].join(", ")}\\n`));
    expect(call.input).toContain("OPENING WINDOW: 0.0-15.0s.");
    expect(call.input).not.toMatch(/SHORT EDIT|S0\d:/);
    const short = await reviewInput(job.id, "short");
    expect(short.input).toContain("SHORT EDIT:");
    expect(short.input).not.toMatch(/L0\d:/);
  });

  test("the answer is keyed by slot; motion slots are never repair keys", async () => {
    const { job } = await seed();
    const list = shots(job.id);
    const schema = (await reviewInput(job.id, "long")).schema;
    const motion = list.filter((s) => s.wantsMotion).map((s) => String(s.index));
    expect(motion.length).toBeGreaterThan(0);
    expect(schema.properties.repairs.additionalProperties).toBe(false);
    expect(Object.keys(schema.properties.repairs.properties)).toEqual(list.filter((s) => !s.wantsMotion).map((s) => String(s.index)));
    for (const m of motion) expect(schema.properties.repairs.properties[m]).toBeUndefined();
    expect(Object.keys(schema.properties.humanReview.properties)).toHaveLength(list.length);
  });

  test("reading findings: repairs and human review accepted; a slot in both, or a motion repair, is human review only", async () => {
    const { job } = await seed();
    const list = shots(job.id);
    const motion = list.find((s) => s.wantsMotion)!.index;
    const [a, b, c, d] = list.filter((s) => !s.wantsMotion).map((s) => s.index);
    const qa = v.readDirectorQa("long", list, {
      repairs: { [a]: { reason: "shows the wrong subject", instruction: "use the crowd view" }, [b]: { reason: "stalled", instruction: "another view" }, [motion]: { reason: "weak", instruction: "x" }, [c]: null },
      humanReview: { [b]: "relevance is ambiguous", [d]: "needs a look at the image" },
      summary: " Two fixes. ",
    });
    expect(qa.repairs).toEqual([{ slotId: a, reason: "shows the wrong subject", instruction: "use the crowd view" }]);
    expect(qa.humanReview).toEqual(
      [
        { slotId: b, reason: "relevance is ambiguous" }, // in both lists: human review only
        { slotId: motion, reason: "Motion slot, not changed automatically: weak" },
        { slotId: d, reason: "needs a look at the image" },
      ].sort((x, y) => x.slotId - y.slotId),
    );
    expect(qa.summary).toBe("Two fixes.");
    expect(() => v.readDirectorQa("long", list, { repairs: { [a]: { reason: "x", instruction: "" } }, humanReview: {}, summary: "" })).toThrow(/needs a reason and an instruction/);
    expect(() => v.readDirectorQa("long", list, { repairs: { 999: null }, humanReview: {}, summary: "" })).toThrow(/unknown/);
    expect(() => v.readDirectorQa("long", list, { repairs: [], humanReview: {}, summary: "" })).toThrow(/Invalid Director QA/);
  });

  test("no repair needed: one review call and one charge, nothing changes, human review is returned", async () => {
    const { job } = await seed();
    const before = JSON.stringify(getJob(job.id)!.scratch.longShots);
    h.qa = { repairs: {}, humanReview: { 3: "archive relevance is ambiguous" }, summary: "Mostly clear." };
    setMode("live");
    try {
      const res = await qaPost(job.id, "long");
      expect(res.statusCode).toBe(200);
      expect(res.json().qa).toEqual({ summary: "Mostly clear.", repairs: [], humanReview: [{ slotId: 3, reason: "archive relevance is ambiguous" }] });
    } finally {
      setMode("mock");
    }
    expect(h.calls.map((c) => c.schemaName)).toEqual(["director_qa"]);
    expect(getJob(job.id)!.spent).toBeCloseTo(1 + PRICING.openai.visualPlan);
    expect(JSON.stringify(getJob(job.id)!.scratch.longShots)).toBe(before);
    expect(getJob(job.id)!.state).toBe("awaiting_preview");
  });

  test("auto repair: only the target slots can change; every other slot is locked; the existing revision runs once", async () => {
    const { job } = await seed();
    const beforeShort = JSON.stringify(shots(job.id, "short"));
    const list = shots(job.id);
    const open = list.filter((s) => !s.wantsMotion).map((s) => s.index);
    const [t1, t2] = [open[2], open[open.length - 2]];
    const other = open.find((i) => i !== t1 && i !== t2 && Math.abs(i - t1) > 2 && Math.abs(i - t2) > 2)!;
    let input: any;
    const reviser = vi.fn(async (inp: any) => {
      input = inp;
      // The reviser tries to change an unrelated slot too; it is locked.
      return { changes: { [t1]: inp.choices.get(t1)[0], [other]: replacementFor(list, other) }, unresolved: [] };
    });
    const r = await directorRepairForJob(job.id, "long", [
      { slotId: t1, reason: "shows the wrong subject", instruction: "show the crowd" },
      { slotId: t2, reason: "stalled", instruction: "another angle" },
    ], reviser);
    expect(reviser).toHaveBeenCalledOnce();
    expect([...input.choices.keys()].sort((a: number, b: number) => a - b)).toEqual([t1, t2].sort((a, b) => a - b));
    for (const s of list) if (s.index !== t1 && s.index !== t2) expect(input.locked.has(s.index)).toBe(true);
    expect(input.feedback).toContain("AUTO DIRECTOR SEQUENCE REPAIR");
    expect(input.feedback).toContain(`Slot ${String(t1).padStart(2, "0")}: shows the wrong subject\n  Instruction: show the crowd`);
    expect(input.feedback).toContain("KEEP ALL OTHER SLOTS.");

    expect(r.changed).toEqual([t1]);
    expect(r.unresolved).toEqual([{ slotId: t2, reason: "The repair kept the current presentation." }]); // no second attempt
    const after = shots(job.id);
    after.forEach((s, i) => {
      if (i !== t1) expect(pres(s)).toBe(pres(list[i]));
    });
    expect(JSON.stringify(shots(job.id, "short"))).toBe(beforeShort);
    expect(h.images + h.other + h.calls.length).toBe(0);
    // A motion slot is never an automatic repair target.
    const motion = list.find((s) => s.wantsMotion)!.index;
    await expect(directorRepairForJob(job.id, "long", [{ slotId: motion, reason: "x", instruction: "y" }], reviser)).rejects.toThrow(/motion slot/);
  });

  test("live, review then repair: two text charges at most, no media calls, and the saved edit is the repaired one", async () => {
    const { job } = await seed();
    const list = shots(job.id);
    const t = list.findIndex((s, i) => i > 1 && !s.wantsMotion);
    h.qa = { repairs: { [t]: { reason: "wrong subject", instruction: "show the crowd" } }, humanReview: { 1: "ambiguous" }, summary: "One fix." };
    setMode("live");
    try {
      const review = await qaPost(job.id, "long");
      expect(review.json().qa.repairs).toEqual([{ slotId: t, reason: "wrong subject", instruction: "show the crowd" }]);
      const schema = h.calls[0].schema;
      // The repair schema offers only slot t: take its first legal choice.
      const respond = (await import("../src/providers/openai.ts")).respondJson as any;
      respond.mockImplementationOnce(async (o: any) => {
        h.calls.push(o);
        const key = Object.keys(o.schema.properties.changes.properties);
        expect(key).toEqual([String(t)]);
        return { changes: { [t]: o.schema.properties.changes.properties[String(t)].enum[0] }, unresolved: [] };
      });
      const repair = await repairPost(job.id, "long", review.json().qa.repairs);
      expect(repair.statusCode).toBe(200);
      expect(repair.json().revision.changed).toEqual([t]);
      expect(schema.properties.repairs).toBeDefined();
    } finally {
      setMode("mock");
    }
    expect(h.calls.map((c) => c.schemaName)).toEqual(["director_qa", "sequence_revision"]);
    expect(getJob(job.id)!.spent).toBeCloseTo(1 + 2 * PRICING.openai.visualPlan);
    expect(pres(shots(job.id)[t])).not.toBe(pres(list[t]));
    expect(h.images + h.other).toBe(0);
    expect(getJob(job.id)!.previewApproved).toBe(false);
  });

  test("failures change nothing and are not retried; the spend cap refuses before any call", async () => {
    const { job } = await seed();
    const before = JSON.stringify(getJob(job.id)!.scratch.longShots);
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    setMode("live");
    try {
      h.qa = { repairs: [], humanReview: {}, summary: "" }; // malformed
      const review = await qaPost(job.id, "long");
      expect(review.statusCode).toBe(400);
      expect(review.json().error).toMatch(/Invalid Director QA/);
      const t = shots(job.id).findIndex((s, i) => i > 1 && !s.wantsMotion);
      h.answer = "nonsense";
      const repair = await repairPost(job.id, "long", [{ slotId: t, reason: "x", instruction: "y" }]);
      expect(repair.statusCode).toBe(400);
      expect(h.calls.map((c) => c.schemaName)).toEqual(["director_qa", "sequence_revision"]); // one each, no retry
      expect(logged).toHaveBeenCalledTimes(2);
      updateJob(job.id, { approvedMax: getJob(job.id)!.spent + 0.04 });
      h.calls = [];
      const capped = await qaPost(job.id, "long");
      expect(capped.json().error).toMatch(/Approved maximum/);
      expect(h.calls).toEqual([]);
    } finally {
      setMode("mock");
      logged.mockRestore();
    }
    expect(JSON.stringify(getJob(job.id)!.scratch.longShots)).toBe(before);
    expect(getJob(job.id)!.state).toBe("awaiting_preview");
  });

  test("mock mode: the review makes no provider call and changes nothing", async () => {
    const { job } = await seed();
    const res = await qaPost(job.id, "short");
    expect(res.statusCode).toBe(200);
    expect(res.json().qa.repairs).toEqual([]);
    expect(h.calls).toEqual([]);
  });
});

describe("Director QA deterministic cleanup", () => {
  // Rewrite the stored Long as a valid cycle of distinct assets' base views (no
  // motion). `patch` (slot -> presentation id) then plants exactly the pattern a
  // test needs, using another presentation of the same asset where two of one
  // asset meet, as real plans do (an identical presentation twice is invalid).
  function setLong(jobId: string, story: any, patch: Record<number, string> = {}) {
    const list = shots(jobId);
    const assets = [...new Set(list.map((s) => s.assetId))];
    const edit = list.map((s, i) => ({ slotId: i, presentationId: patch[i] ?? `${assets[i % assets.length]}:base`, motionPriority: 0 }));
    const next = v.reassembleStoredEdit(list, edit);
    v.resolveReuse(story, "long", next);
    const scratch = { ...getJob(jobId)!.scratch, longShots: next };
    updateJob(jobId, { scratch, preview: v.buildPreview(story, next, scratch.shortShots) });
    return { list: next, assets };
  }
  // A fresh job, the asset each slot gets in the pattern-free cycle, and the
  // assets that have a detail crop. The pattern is planted in ONE rewrite of the
  // original plan, whose menu still includes the detail crops.
  async function flat() {
    const { job, story } = await seed();
    const original = shots(job.id);
    const assets = [...new Set(original.map((s) => s.assetId))];
    const cycle = (i: number) => assets[i % assets.length];
    const ids = v.storedPresentations(original).map((p) => p.id);
    const withDetail = assets.filter((a) => ids.some((id) => id.startsWith(`${a}:detail`)));
    const detail = (a: string) => ids.find((id) => id.startsWith(`${a}:detail`))!;
    const n = original.findIndex((s) => s.startSec >= 20); // well past the opening
    return { job, story, cycle, withDetail, detail, n };
  }
  const pad = (n: number) => String(n).padStart(2, "0");

  test("no mandatory pattern: no repair call, nothing remains", async () => {
    const { job, story } = await flat();
    setLong(job.id, story);
    const reviser = vi.fn();
    const r = await directorCleanupForJob(job.id, "long", reviser);
    expect(r.cleanup).toEqual({ ran: false, changed: [], unresolved: [], remaining: [] });
    expect(reviser).not.toHaveBeenCalled();
  });

  test("an adjacent repeat: exactly one targeted repair of the later slot; everything else locked; clean afterwards", async () => {
    const { job, story, withDetail, detail, n } = await flat();
    const a = withDetail[0];
    const { list } = setLong(job.id, story, { [n]: `${a}:base`, [n + 1]: detail(a) });
    let input: any;
    const reviser = vi.fn(async (inp: any) => {
      input = inp;
      const near = [a, list[n + 2].assetId];
      return { changes: { [n + 1]: inp.choices.get(n + 1).find((id: string) => !near.includes(id.split(":")[0])) }, unresolved: [] };
    });
    const r = await directorCleanupForJob(job.id, "long", reviser);
    expect(reviser).toHaveBeenCalledOnce();
    expect([...input.choices.keys()]).toEqual([n + 1]);
    for (const s of list) if (s.index !== n + 1) expect(input.locked.has(s.index)).toBe(true);
    expect(input.feedback).toContain("AUTOMATIC SEQUENCE CLEANUP");
    expect(input.feedback).toContain(`ADJACENT REUSE across slots ${pad(n)}, ${pad(n + 1)}: change slot ${pad(n + 1)}`);
    expect(input.feedback).toContain("KEEP ALL OTHER SLOTS.");
    expect(r.cleanup).toMatchObject({ ran: true, changed: [n + 1], remaining: [] });
    shots(job.id).forEach((s, i) => i !== n + 1 && expect(pres(s)).toBe(pres(list[i])));
    expect(h.images + h.other + h.calls.length).toBe(0);
  });

  test("A-B-A-B, a run of three and an opening repeat each get their target", async () => {
    const { job, story, cycle, withDetail, detail, n } = await flat();
    const [a, b] = [cycle(n), cycle(n + 1)];
    const c = withDetail.find((x) => x !== a && x !== b)!;
    setLong(job.id, story, {
      [n + 2]: `${a}:base`,
      [n + 3]: `${b}:base`, // a b a b
      [n + 8]: `${c}:base`,
      [n + 9]: detail(c),
      [n + 10]: `${c}:base`, // c c c
      2: `${cycle(0)}:base`, // the opening asset again at slot 2
    });
    let input: any;
    await directorCleanupForJob(job.id, "long", async (inp: any) => ((input = inp), { changes: {}, unresolved: [] }));
    expect([...input.choices.keys()].sort((x: number, y: number) => x - y)).toEqual([2, n + 3, n + 9]);
    expect(input.feedback).toContain(`ALTERNATING REUSE across slots ${[n, n + 1, n + 2, n + 3].map(pad).join(", ")}: change slot ${pad(n + 3)}`);
    expect(input.feedback).toContain(`CONSECUTIVE REUSE across slots ${[n + 8, n + 9, n + 10].map(pad).join(", ")}: change slot ${pad(n + 9)}`);
    expect(input.feedback).toContain(`OPENING REPEAT across slots 00, 02: change slot 02`);
  });

  test("a pattern the repair leaves in place becomes a human exception; no second attempt", async () => {
    const { job, story, withDetail, detail, n } = await flat();
    const a = withDetail[0];
    setLong(job.id, story, { [n]: `${a}:base`, [n + 1]: detail(a) });
    const reviser = vi.fn(async () => ({ changes: {}, unresolved: [] }));
    const r = await directorCleanupForJob(job.id, "long", reviser);
    expect(reviser).toHaveBeenCalledOnce();
    expect(r.cleanup.changed).toEqual([]);
    expect(r.cleanup.remaining).toEqual([{ slotId: n + 1, reason: "ADJACENT REUSE remains. No legal existing alternative resolved this sequence issue." }]);
  });

  test("a failed cleanup keeps the earlier edit, reports the targets as exceptions, and is not retried", async () => {
    const { job, story, withDetail, detail, n } = await flat();
    const a = withDetail[0];
    setLong(job.id, story, { [n]: `${a}:base`, [n + 1]: detail(a) });
    const before = JSON.stringify(getJob(job.id)!.scratch.longShots);
    const reviser = vi.fn(async () => "nonsense");
    const r = await directorCleanupForJob(job.id, "long", reviser);
    expect(reviser).toHaveBeenCalledOnce();
    expect(r.cleanup.ran).toBe(true);
    expect(r.cleanup.error).toMatch(/Invalid sequence revision/);
    expect(r.cleanup.remaining).toEqual([{ slotId: n + 1, reason: "ADJACENT REUSE remains. No legal existing alternative resolved this sequence issue. Automatic cleanup failed." }]);
    expect(JSON.stringify(getJob(job.id)!.scratch.longShots)).toBe(before);
    expect(getJob(job.id)!.state).toBe("awaiting_preview");
  });

  test("live, the whole run: never more than three text calls, $0.15 at most, no media calls", async () => {
    const { job } = await seed(); // the mock plan is full of runs of one asset
    const list = shots(job.id);
    const t = list.findIndex((s, i) => i > 1 && !s.wantsMotion);
    h.qa = { repairs: { [t]: { reason: "wrong subject", instruction: "show the crowd" } }, humanReview: {}, summary: "One fix." };
    h.answer = { changes: {}, unresolved: [] };
    setMode("live");
    try {
      expect((await app.inject({ method: "POST", url: `/api/jobs/${job.id}/director-qa`, payload: { kind: "long" } })).statusCode).toBe(200);
      expect((await app.inject({ method: "POST", url: `/api/jobs/${job.id}/director-qa/repair`, payload: { kind: "long", repairs: [{ slotId: t, reason: "wrong subject", instruction: "show the crowd" }] } })).statusCode).toBe(200);
      const res = await app.inject({ method: "POST", url: `/api/jobs/${job.id}/director-qa/cleanup`, payload: { kind: "long" } });
      expect(res.statusCode).toBe(200);
      expect(res.json().cleanup.ran).toBe(true);
      expect(res.json().cleanup.remaining.length).toBeGreaterThan(0); // left as they were: human exceptions
    } finally {
      setMode("mock");
    }
    expect(h.calls.map((c) => c.schemaName)).toEqual(["director_qa", "sequence_revision", "sequence_revision"]);
    expect(getJob(job.id)!.spent).toBeCloseTo(1 + 3 * PRICING.openai.visualPlan);
    expect(h.images + h.other).toBe(0);
    expect(getJob(job.id)!.previewApproved).toBe(false);
  });

  // ------------------------------------------------------------------------
  // Coordinated neighbourhood repair (Director QA step 4)

  // A base-only asset A (like a graphic), plus distinct other assets, for the
  // five-slot shape  B A [B] A C  around the target, away from the fixed neighbours.
  async function coordinatedShape() {
    const f = await flat();
    const assets = [...new Set(shots(f.job.id).map((s) => s.assetId))];
    const baseOnly = assets.filter((a) => !f.withDetail.includes(a));
    const n = f.n;
    const avoid = new Set([f.cycle(n - 1), f.cycle(n + 5)]);
    const [A, B] = baseOnly.filter((a) => !avoid.has(a));
    const [C, D, E, F] = assets.filter((a) => !avoid.has(a) && a !== A && a !== B);
    const { list } = setLong(f.job.id, f.story, { [n]: `${B}:base`, [n + 1]: `${A}:base`, [n + 2]: `${B}:base`, [n + 3]: `${A}:base`, [n + 4]: `${C}:base` });
    return { ...f, list, A, B, C, D, E, F, target: n + 2, window: [n, n + 1, n + 2, n + 3, n + 4] };
  }

  test("regression: the target has no legal one-slot choice, but the five-slot window can move together", async () => {
    const { job, list, A, B, D, E, F, target, window, n } = await coordinatedShape();
    const beforeShort = JSON.stringify(shots(job.id, "short"));
    const slots = v.planSlots("long", paulBunyanScripts.long, getJob(job.id)!.scratch.narration.long);
    const presentations = v.storedPresentations(list);
    // One-slot repair: A cannot go to the target while both neighbours show A.
    const onlyTarget = new Map(slots.filter((s) => s.id !== target).map((s) => [s.id, "fixed"] as [number, string]));
    expect(v.sequenceSlotChoices("long", slots, list, presentations, onlyTarget).get(target)).not.toContain(`${A}:base`);

    let input: any;
    const reviser = vi.fn(async (inp: any) => {
      input = inp;
      return { changes: { [n]: `${D}:base`, [n + 1]: `${E}:base`, [target]: `${A}:base`, [n + 3]: `${F}:base`, [n + 4]: `${B}:base` }, unresolved: [] };
    });
    const r = await directorCoordinateForJob(job.id, "long", target, "Not changed: A is not a legal choice for this slot.", reviser);
    expect(reviser).toHaveBeenCalledOnce();
    expect(input.coordinated).toEqual({ target, reason: "Not changed: A is not a legal choice for this slot.", window });
    expect([...input.choices.keys()]).toEqual(window);
    for (const id of window) expect(input.choices.get(id)).toEqual(presentations.map((p) => p.id)); // the whole current menu
    for (const s of list) if (!window.includes(s.index)) expect(input.locked.has(s.index)).toBe(true);

    expect(r.report.error).toBeUndefined();
    expect(r.report.changed).toEqual(window);
    expect(r.report.humanReview).toEqual([]);
    const after = shots(job.id);
    expect(pres(after[target])).toBe(`${A}:base`);
    after.forEach((s, i) => !window.includes(i) && expect(pres(s)).toBe(pres(list[i]))); // only the window changed
    expect(() => v.assertFilmGrammarPlan("long", after)).not.toThrow();
    expect(JSON.stringify(shots(job.id, "short"))).toBe(beforeShort);
    expect(h.images + h.other + h.calls.length).toBe(0);
    expect(getJob(job.id)!.state).toBe("awaiting_preview");
  });

  test("an invalid combined arrangement, an unknown presentation or a provider failure saves nothing and becomes human review", async () => {
    const { job, A, target } = await coordinatedShape();
    const before = JSON.stringify(getJob(job.id)!.scratch.longShots);
    const pad2 = String(target).padStart(2, "0");
    // A at the target while its neighbours keep A: rejected by the existing validateEdit.
    const invalid = await directorCoordinateForJob(job.id, "long", target, "r", async () => ({ changes: { [target]: `${A}:base` }, unresolved: [] }));
    expect(invalid.report.error).toMatch(/Invalid edit plan: long .* repeats slot/);
    expect(invalid.report.humanReview).toEqual([{ slotId: target, reason: expect.stringContaining(`Coordinated repair could not resolve Slot ${pad2}. The previous valid edit is kept.`) }]);
    const unknown = await directorCoordinateForJob(job.id, "long", target, "r", async () => ({ changes: { [target]: "L99:base" }, unresolved: [] }));
    expect(unknown.report.error).toMatch(/not an existing long presentation/);
    const provider = await directorCoordinateForJob(job.id, "long", target, "r", async () => Promise.reject(new Error("OpenAI responses 500")));
    expect(provider.report.error).toBe("OpenAI responses 500");
    expect(JSON.stringify(getJob(job.id)!.scratch.longShots)).toBe(before);
  });

  test("a motion slot inside the window stays locked; a motion target is refused", async () => {
    const { job } = await seed(); // the mock plan keeps its motion slots
    const list = shots(job.id);
    const m = list.findIndex((s, i) => s.wantsMotion && i > 0 && !list[i - 1].wantsMotion);
    let input: any;
    const r = await directorCoordinateForJob(job.id, "long", m - 1, "r", async (inp: any) => ((input = inp), { changes: { [m]: pres(list[m - 1]) }, unresolved: [] }));
    expect(input.choices.has(m)).toBe(false);
    expect(input.locked.get(m)).toMatch(/motion slot/);
    expect(pres(shots(job.id)[m])).toBe(pres(list[m]));
    expect(r.report.changed).not.toContain(m);
    await expect(directorCoordinateForJob(job.id, "long", m, "r", vi.fn())).rejects.toThrow(/motion slot/);
  });

  test("live, the whole Director QA chain: at most four text calls, $0.20, no media calls", async () => {
    const { job } = await seed(); // the mock plan is full of runs, so cleanup runs
    const list = shots(job.id);
    const t = list.findIndex((s, i) => i > 1 && !s.wantsMotion);
    h.qa = { repairs: { [t]: { reason: "wrong subject", instruction: "show the crowd" } }, humanReview: {}, summary: "One fix." };
    h.answer = { changes: {}, unresolved: [] };
    h.coord = { changes: {}, unresolved: [] };
    const post = (url: string, payload: unknown) => app.inject({ method: "POST", url: `/api/jobs/${job.id}/${url}`, payload });
    setMode("live");
    try {
      expect((await post("director-qa", { kind: "long" })).statusCode).toBe(200);
      expect((await post("director-qa/repair", { kind: "long", repairs: [{ slotId: t, reason: "wrong subject", instruction: "show the crowd" }] })).statusCode).toBe(200);
      expect((await post("director-qa/cleanup", { kind: "long" })).statusCode).toBe(200);
      const res = await post("director-qa/coordinate", { kind: "long", slotId: t, reason: "The repair kept the current presentation." });
      expect(res.statusCode).toBe(200);
      expect(res.json().coordinated.humanReview[0]).toMatchObject({ slotId: t, reason: expect.stringContaining("Coordinated repair left Slot") });
    } finally {
      setMode("mock");
    }
    expect(h.calls.map((c) => c.schemaName)).toEqual(["director_qa", "sequence_revision", "sequence_revision", "coordinated_revision"]);
    expect(h.calls[3].instructions).toBe(v.COORDINATED_REPAIR_INSTRUCTIONS);
    expect(h.calls[3].input).toContain(`UNRESOLVED TARGET: slot #${t}.`);
    expect(h.calls[3].input).not.toMatch(/SHORT|S0\d:/);
    expect(getJob(job.id)!.spent).toBeCloseTo(1 + 4 * PRICING.openai.visualPlan);
    expect(h.images + h.other).toBe(0);
    expect(getJob(job.id)!.previewApproved).toBe(false);
  });

  // ------------------------------------------------------------------------
  // The original Director repair intent, carried into the coordinated repair

  const INTENT = { reason: "Narration describes referendum percentage; current graphic depicts a later parliamentary vote.", instruction: "Use the existing referendum-result graphic." };
  const MECHANICAL = "Not changed: L05:base is not a legal choice for this slot.";

  test("regression: the coordinated repair receives the Director's reason and instruction with the one-slot reason; window, menu and locks are unchanged", async () => {
    const { job, target, window } = await coordinatedShape();
    const inputs: any[] = [];
    const reviser = vi.fn(async (inp: any) => (inputs.push(inp), { changes: {}, unresolved: [] })); // keeps the edit, so both calls see the same film
    const plain = await directorCoordinateForJob(job.id, "long", target, MECHANICAL, reviser);
    const withIntent = await directorCoordinateForJob(job.id, "long", target, MECHANICAL, reviser, INTENT);
    expect(reviser).toHaveBeenCalledTimes(2);
    const [a, b] = inputs;
    expect(a.coordinated).toEqual({ target, reason: MECHANICAL, window }); // no intent: exactly as before
    expect(b.coordinated).toEqual({ target, reason: MECHANICAL, window, intent: INTENT });
    expect([...b.choices]).toEqual([...a.choices]);
    expect([...b.locked]).toEqual([...a.locked]);
    expect(b.presentations).toEqual(a.presentations);
    expect(b.feedback).toBe(a.feedback);
    const section = ["DIRECTOR REPAIR INTENT", "", "Reason:", INTENT.reason, "", "Requested correction:", INTENT.instruction, "", "Why the one-slot repair could not complete:", MECHANICAL, "", ""].join("\n");
    const before = v.coordinatedRevisionPayload(a);
    const after = v.coordinatedRevisionPayload(b);
    expect(after).toContain(section);
    expect(after.replace(section, "")).toBe(before); // the section is the only addition
    expect(before).not.toContain("DIRECTOR REPAIR INTENT");
    expect(after).toContain(`UNRESOLVED TARGET: slot #${target}. ${MECHANICAL}`);
    // The unresolved result keeps the mechanical reason, as today.
    expect(withIntent.report.humanReview).toEqual(plain.report.humanReview);
    expect(h.calls.length + h.images + h.other).toBe(0);
  });

  test("the coordinate route accepts an optional well-formed intent only", async () => {
    const { job, target } = await coordinatedShape();
    const post = (payload: unknown) => app.inject({ method: "POST", url: `/api/jobs/${job.id}/director-qa/coordinate`, payload });
    expect((await post({ kind: "long", slotId: target, reason: MECHANICAL })).statusCode).toBe(200); // no intent: as before
    expect((await post({ kind: "long", slotId: target, reason: MECHANICAL, intent: INTENT })).statusCode).toBe(200);
    expect((await post({ kind: "long", slotId: target, reason: MECHANICAL, intent: { reason: "x", instruction: "" } })).statusCode).toBe(400);
    expect((await post({ kind: "long", slotId: target, reason: MECHANICAL, intent: { reason: "x", instruction: "y", extra: 1 } })).statusCode).toBe(400);
    expect(h.calls).toEqual([]); // mock mode
  });

  // ------------------------------------------------------------------------
  // Final read-only Director verification (the terminal QA step)

  // The block of one slot in a Director payload.
  const slotText = (payload: string, id: number) => payload.slice(payload.indexOf(`SLOT #${id}\n`), payload.indexOf("\n\n", payload.indexOf(`SLOT #${id}\n`)));
  const verifyCapture = (answer: unknown) => {
    const calls: any[] = [];
    return { calls, fn: vi.fn(async (input: any) => (calls.push({ input, payload: v.directorQaPayload(input, "verify") }), answer)) };
  };

  test("regression: a finding about a visual a later repair replaced is not carried forward; the verifier sees what the slot shows now", async () => {
    const { job, n } = await flat().then(async (f) => (setLong(f.job.id, f.story), f));
    const t = n;
    const before = shots(job.id)[t];
    // 1. The initial review flags the slot for what it showed then.
    const review = await directorReviewForJob(job.id, "long", async () => ({ repairs: { [t]: { reason: "group photo is repetitive", instruction: "show the landscape" } }, humanReview: {}, summary: "Initial." }));
    expect(review.qa.repairs[0].reason).toBe("group photo is repetitive");
    // 2. The automatic repair changes it.
    let pick = "";
    await directorRepairForJob(job.id, "long", review.qa.repairs, async (inp: any) => ((pick = inp.choices.get(t)[0]), { changes: { [t]: pick }, unresolved: [] }));
    expect(pres(shots(job.id)[t])).toBe(pick);
    expect(pick).not.toBe(pres(before));
    // 3. The final verification is built fresh from the saved film.
    const cap = verifyCapture({ humanReview: { [t]: "current: the new visual does not name the vote" }, summary: "Final summary." });
    const r = await directorVerifyForJob(job.id, "long", cap.fn);
    const block = slotText(cap.calls[0].payload, t);
    const p = v.storedPresentations(shots(job.id)).find((x) => x.id === pick)!;
    expect(block).toContain(`current: ${pick} - ${p.description}`);
    expect(block).not.toContain(`current: ${pres(before)}`);
    expect(cap.calls[0].payload).toContain("FINAL SAVED EDIT (after automatic repairs; this is authoritative)");
    expect(cap.calls[0].payload).not.toContain("AVAILABLE PRESENTATIONS"); // read-only: no menu to repair from
    expect(r.verify).toEqual({ summary: "Final summary.", humanReview: [{ slotId: t, reason: "current: the new visual does not name the vote" }], patterns: [] });
    expect(JSON.stringify(r.verify)).not.toContain("group photo");
  });

  test("a pattern a later repair broke is absent from the final flags and exceptions", async () => {
    const { job, story, withDetail, detail, n } = await flat();
    const a = withDetail[0];
    setLong(job.id, story, { [n]: `${a}:base`, [n + 1]: detail(a) }); // adjacent repeat at n+1
    await directorCleanupForJob(job.id, "long", async (inp: any) => ({ changes: { [n + 1]: inp.choices.get(n + 1).find((id: string) => !id.startsWith(`${a}:`) && id.split(":")[0] !== shots(job.id)[n + 2].assetId) }, unresolved: [] }));
    const cap = verifyCapture({ humanReview: {}, summary: "" });
    const r = await directorVerifyForJob(job.id, "long", cap.fn);
    expect(cap.calls[0].input.flags[n + 1]).not.toContain("ADJACENT REUSE");
    expect(r.verify.patterns).toEqual([]);
  });

  test("the verifier receives each slot's narration with what it CURRENTLY shows, so a current mismatch is visible to it", async () => {
    const { job, n } = await flat().then(async (f) => (setLong(f.job.id, f.story), f));
    const slots = v.planSlots("long", paulBunyanScripts.long, getJob(job.id)!.scratch.narration.long);
    const cap = verifyCapture({ humanReview: { [n]: "narration gives a percentage; the slot shows a vote count" }, summary: "" });
    const r = await directorVerifyForJob(job.id, "long", cap.fn);
    const block = slotText(cap.calls[0].payload, n);
    expect(block).toContain(`narration: "${slots[n].excerpt}"`);
    expect(block).toContain(`current: ${pres(shots(job.id)[n])} - `);
    expect(cap.calls[0].payload.split("SLOT #").length - 1).toBe(slots.length); // every slot once
    expect(r.verify.humanReview).toEqual([{ slotId: n, reason: "narration gives a percentage; the slot shows a vote count" }]);
    expect(cap.fn).toHaveBeenCalledOnce();
  });

  test("a failed verification keeps the repaired edit, reports current patterns only, and is not retried", async () => {
    const { job, story, withDetail, detail, n } = await flat();
    const a = withDetail[0];
    setLong(job.id, story, { [n]: `${a}:base`, [n + 1]: detail(a) }); // a pattern that stays
    const before = JSON.stringify(getJob(job.id)!.scratch.longShots);
    const failing = vi.fn(async () => Promise.reject(new Error("OpenAI responses 500")));
    const r = await directorVerifyForJob(job.id, "long", failing);
    expect(failing).toHaveBeenCalledOnce();
    expect(r.verify.error).toBe("OpenAI responses 500");
    expect(r.verify.humanReview).toEqual([]); // nothing stale is resurrected
    expect(r.verify.patterns).toEqual([{ slotId: n + 1, reason: "ADJACENT REUSE remains. No legal existing alternative resolved this sequence issue." }]);
    expect(JSON.stringify(getJob(job.id)!.scratch.longShots)).toBe(before);
    // A malformed answer is a failure too.
    expect((await directorVerifyForJob(job.id, "long", async () => ({ humanReview: [], summary: "" }))).verify.error).toMatch(/Invalid Director verification/);
  });

  test("source of truth: the Director board, the PNG export data and the verification use the same saved presentations", async () => {
    const { job, n } = await flat().then(async (f) => (setLong(f.job.id, f.story), f));
    await directorRepairForJob(job.id, "long", [{ slotId: n, reason: "r", instruction: "i" }], async (inp: any) => ({ changes: { [n]: inp.choices.get(n)[0] }, unresolved: [] }));
    const saved = shots(job.id).map(pres);
    const preview = (await app.inject({ method: "GET", url: `/api/jobs/${job.id}` })).json().job.preview;
    const { buildDirectorBoard } = await import("../src/app/visualReview/board.ts");
    const boardIds = buildDirectorBoard(buildFilm(preview, "long")).cards.map((c) => `${c.frame.asset}:${c.frame.presentation}`);
    const cap = verifyCapture({ humanReview: {}, summary: "" });
    await directorVerifyForJob(job.id, "long", cap.fn);
    const verifyIds = [...cap.calls[0].payload.matchAll(/^current: (\S+) - /gm)].map((m) => m[1]);
    expect(boardIds).toEqual(saved); // the board and Copy Director Board (built from the same board)
    expect(verifyIds).toEqual(saved); // the final verification
  });

  test("live, the complete chain: five text calls at most, $0.25, the Director intent reaches only the coordinated repair, nothing after the verification", async () => {
    const { job } = await seed();
    const list = shots(job.id);
    const t = list.findIndex((s, i) => i > 1 && !s.wantsMotion);
    h.qa = { repairs: { [t]: INTENT }, humanReview: {}, summary: "One fix." };
    h.answer = { changes: {}, unresolved: [] };
    h.coord = { changes: {}, unresolved: [] };
    h.verify = { humanReview: { [t]: "current: still unclear" }, summary: "Final." };
    const post = (url: string, payload: unknown) => app.inject({ method: "POST", url: `/api/jobs/${job.id}/${url}`, payload });
    setMode("live");
    try {
      const finding = (await post("director-qa", { kind: "long" })).json().qa.repairs[0];
      expect(finding).toEqual({ slotId: t, ...INTENT });
      const unresolved = (await post("director-qa/repair", { kind: "long", repairs: [finding] })).json().revision.unresolved[0];
      expect(unresolved).toEqual({ slotId: t, reason: "The repair kept the current presentation." });
      await post("director-qa/cleanup", { kind: "long" });
      // As runDirectorQa sends it: the one-slot reason plus the original finding.
      expect((await post("director-qa/coordinate", { kind: "long", slotId: t, reason: unresolved.reason, intent: { reason: finding.reason, instruction: finding.instruction } })).statusCode).toBe(200);
      const res = await post("director-qa/verify", { kind: "long" });
      expect(res.statusCode).toBe(200);
      expect(res.json().verify).toMatchObject({ summary: "Final.", humanReview: [{ slotId: t, reason: "current: still unclear" }] });
    } finally {
      setMode("mock");
    }
    expect(h.calls.map((c) => c.schemaName)).toEqual(["director_qa", "sequence_revision", "sequence_revision", "coordinated_revision", "director_verify"]);
    expect(h.calls[3].input).toContain(`DIRECTOR REPAIR INTENT

Reason:
${INTENT.reason}

Requested correction:
${INTENT.instruction}

Why the one-slot repair could not complete:
The repair kept the current presentation.
`);
    expect(h.calls[4].instructions).toBe(v.DIRECTOR_VERIFY_INSTRUCTIONS);
    for (const history of ["DIRECTOR REPAIR INTENT", INTENT.reason, INTENT.instruction, "The repair kept the current presentation."]) expect(h.calls[4].input).not.toContain(history); // the saved film only
    expect(Object.keys(h.calls[4].schema.properties)).toEqual(["humanReview", "summary"]); // no repairs, no instructions
    expect(getJob(job.id)!.spent).toBeCloseTo(1 + 5 * PRICING.openai.visualPlan);
    expect(h.images + h.other).toBe(0);
    expect(getJob(job.id)!.previewApproved).toBe(false);
  });
});

describe("Director QA: strict narration match for factual graphics", () => {
  const EARLIER = "Earlier referendum, 82 percent opposed.";
  const LATER = "Later parliamentary vote, 310 in favour, 55 opposed.";
  // A hand-made film whose slots carry the given narration and, per asset, what
  // its presentation depicts. G1 and G2 are factual graphics.
  function factFilm(spec: { narration: string; asset: string; truth: "archive" | "reconstruction" | "graphic"; shows: string }[]) {
    const f = film(spec.map((s) => ({ asset: s.asset, truth: s.truth })));
    f.slots.forEach((s, i) => (s.excerpt = spec[i].narration));
    f.list.forEach((s, i) => ((s.purpose = spec[i].shows), (s.mustShow = [spec[i].shows])));
    const input = { story: paulBunyanStory as any, kind: "long" as const, slots: f.slots, shots: f.list, presentations: v.storedPresentations(f.list), flags: f.slots.map(() => []), openingSec: 15, endingSec: 10 };
    return input;
  }
  const swapped = () =>
    factFilm([
      { narration: "The proposal divided the country.", asset: "A1", truth: "archive", shows: "Crowd in a town square." },
      { narration: "In the earlier referendum, 82 percent voted against the proposal.", asset: "G1", truth: "graphic", shows: LATER },
      { narration: "The debate went on for years.", asset: "A2", truth: "archive", shows: "Newspaper office." },
      { narration: "Parliament later approved the proposal.", asset: "G2", truth: "graphic", shows: EARLIER },
      { narration: "The change came overnight.", asset: "A3", truth: "reconstruction", shows: "A street at dawn." },
    ]);
  const capture = async (reviewer: typeof v.openAiDirectorQa, input: any) => {
    let call: any;
    await reviewer(input, (async (o: any) => ((call = o), {})) as any);
    return call;
  };
  const block = (payload: string, id: number) => payload.slice(payload.indexOf(`SLOT #${id}\n`), payload.indexOf("\n\n", payload.indexOf(`SLOT #${id}\n`)));

  test("both Director prompts carry the same strict factual-graphic rule, scoped to graphics", () => {
    for (const text of [v.DIRECTOR_QA_INSTRUCTIONS, v.DIRECTOR_VERIFY_INSTRUCTIONS]) {
      expect(text).toContain(v.FACTUAL_GRAPHIC_RULE);
    }
    const rule = v.FACTUAL_GRAPHIC_RULE;
    for (const claim of ["a year or date", "a percentage", "a vote count or other statistic", "a named event or institution", "a before/after state", "a map standing for a particular story beat"]) expect(rule).toContain(claim);
    for (const failure of ["depicts a different event than the narration", "shows a later event before the narration reaches it", "shows an earlier event after the narration has moved on", "displays numbers or statistics that belong to another story beat", "could make the viewer associate the narration with the wrong fact"]) expect(rule).toContain(failure);
    expect(rule).toContain("proven by the metadata: it is not ambiguous and does not need the image");
    expect(rule).toContain("Low reuse, clean attention flags or an otherwise coherent sequence never excuse it");
    expect(rule).toContain("not a problem merely because it is a graphic");
    expect(rule).toContain("judge archive and reconstruction imagery by general relevance, as before");
    expect(rule).not.toMatch(/\d{4}|percent opposed|\d+ to \d+/); // generic: no story's years or values
    // Initial review: a repair when an existing presentation matches; review only when none does.
    expect(v.DIRECTOR_QA_INSTRUCTIONS).toContain("a proven factual-graphic mismatch is a repair whenever an existing presentation in the menu shows the event or values the narration states");
    expect(v.DIRECTOR_QA_INSTRUCTIONS).toContain("Do not send such a mismatch to humanReview merely because it is a graphic");
    // Final verification: read-only, but the mismatch must be reported.
    expect(v.DIRECTOR_VERIFY_INSTRUCTIONS).toContain("MUST be a humanReview finding that states the narration's fact and the graphic's conflicting fact");
    expect(v.DIRECTOR_VERIFY_INSTRUCTIONS).toContain("You cannot change the edit");
  });

  test("A and B: the review pairs each graphic's facts with its narration; both mismatches become repairs, not human review", async () => {
    const input = swapped();
    const call = await capture(v.openAiDirectorQa, input);
    const one = block(call.input, 1);
    expect(one).toContain('narration: "In the earlier referendum, 82 percent voted against the proposal."');
    expect(one).toContain(`current: G1:base - graphic, wide: ${LATER} (owner)`);
    expect(one).toContain("asset: G1, graphic");
    const three = block(call.input, 3);
    expect(three).toContain('narration: "Parliament later approved the proposal."');
    expect(three).toContain(`current: G2:base - graphic, wide: ${EARLIER} (owner)`);
    expect(call.input).toContain(`G2:base - graphic, wide: ${EARLIER}\n  shows: ${EARLIER}\n  type: graphic`); // the matching fix is on the menu
    expect(Object.keys(call.schema.properties.repairs.properties)).toEqual(["0", "1", "2", "3", "4"]);
    // What a Director following the rule returns, read by the existing reader.
    const qa = v.readDirectorQa("long", input.shots, {
      repairs: {
        1: { reason: "The narration gives the earlier referendum result; the graphic shows the later parliamentary vote.", instruction: "Show G2:base, the earlier referendum result." },
        3: { reason: "The narration is the later parliamentary vote; the graphic shows the earlier referendum result.", instruction: "Show G1:base, the later parliamentary vote." },
      },
      humanReview: {},
      summary: "Two factual graphics are swapped against their narration.",
    });
    expect(qa.repairs.map((r) => r.slotId)).toEqual([1, 3]);
    expect(qa.humanReview).toEqual([]);
  });

  test("C: a graphic that matches its narration is not a finding merely because it is a graphic", async () => {
    const input = factFilm([
      { narration: "The proposal divided the country.", asset: "A1", truth: "archive", shows: "Crowd in a town square." },
      { narration: "In the earlier referendum, 82 percent voted against the proposal.", asset: "G2", truth: "graphic", shows: EARLIER },
      { narration: "Parliament later approved the proposal.", asset: "G1", truth: "graphic", shows: LATER },
    ]);
    const call = await capture(v.openAiDirectorQa, input);
    expect(block(call.input, 1)).toContain(`current: G2:base - graphic, wide: ${EARLIER}`);
    expect(call.instructions).toContain("A graphic whose event and values match the narration is not a problem merely because it is a graphic.");
    const qa = v.readDirectorQa("long", input.shots, { repairs: { 0: null, 1: null, 2: null }, humanReview: { 0: null, 1: null, 2: null }, summary: "" });
    expect(qa.repairs).toEqual([]);
    expect(qa.humanReview).toEqual([]);
    const verify = await capture(v.openAiDirectorVerify, input);
    expect(verify.instructions).toBe(v.DIRECTOR_VERIFY_INSTRUCTIONS);
    expect(v.readDirectorVerify("long", input.shots, { humanReview: { 0: null, 1: null, 2: null }, summary: "" }).humanReview).toEqual([]);
  });

  // A seeded job whose graphic assets depict the given facts: the target slot's
  // graphic one fact, every other graphic the other one.
  function plantFacts(jobId: string, target: number, targetShows: string, otherShows: string) {
    const job = getJob(jobId)!;
    const list: Shot[] = structuredClone(shots(jobId));
    const g = list[target].assetId;
    for (const s of list) if (s.truth === "graphic") (s.purpose = s.assetId === g ? targetShows : otherShows), (s.mustShow = [s.purpose]);
    const story = { ...paulBunyanStory, id: job.storyId, slug: job.storyId, title: "A Neutral Story" };
    updateJob(jobId, { scratch: { ...job.scratch, longShots: list }, preview: v.buildPreview(story as any, list, job.scratch.shortShots) });
  }
  const graphicSlot = (jobId: string) => shots(jobId).findIndex((s) => s.truth === "graphic" && s.edit === "new" && !s.wantsMotion);

  test("D: the final verification receives the CURRENT saved graphic with its narration, and its mismatch finding is shown", async () => {
    const { job } = await seed();
    const t = graphicSlot(job.id);
    plantFacts(job.id, t, LATER, EARLIER);
    let payload = "";
    const finding = "The narration gives the earlier referendum result; the graphic shows the later parliamentary vote.";
    const verifier = vi.fn(async (input: any) => ((payload = v.directorQaPayload(input, "verify")), { humanReview: { [t]: finding }, summary: "One factual graphic contradicts its narration." }));
    const r = await directorVerifyForJob(job.id, "long", verifier);
    const slots = v.planSlots("long", paulBunyanScripts.long, getJob(job.id)!.scratch.narration.long);
    expect(block(payload, t)).toContain(`narration: "${slots[t].excerpt}"`);
    expect(block(payload, t)).toContain(`current: ${pres(shots(job.id)[t])} - graphic, `);
    expect(block(payload, t)).toContain(LATER);
    expect(block(payload, t)).toMatch(/\nasset: \S+, graphic, /);
    expect(r.verify.humanReview).toEqual([{ slotId: t, reason: finding }]);
    expect(verifier).toHaveBeenCalledOnce();
    expect(h.calls.length + h.images + h.other).toBe(0);
  });

  test("E: the existing repair swaps in the matching graphic; the verifier sees only the new current visual and no stale mismatch remains", async () => {
    const { job } = await seed();
    const t = graphicSlot(job.id);
    plantFacts(job.id, t, LATER, EARLIER);
    const reason = "The narration gives the earlier referendum result; the graphic shows the later parliamentary vote.";
    const review = await directorReviewForJob(job.id, "long", async () => ({ repairs: { [t]: { reason, instruction: "Show the earlier referendum graphic." } }, humanReview: {}, summary: "One factual mismatch." }));
    expect(review.qa.repairs).toEqual([{ slotId: t, reason, instruction: "Show the earlier referendum graphic." }]);
    expect(review.qa.humanReview).toEqual([]);
    // The existing one-slot repair: the Editor picks a legal graphic that shows the narration's fact.
    let feedback = "";
    const r = await directorRepairForJob(job.id, "long", review.qa.repairs, async (inp: any) => {
      feedback = inp.feedback;
      const pick = inp.choices.get(t).find((id: string) => inp.presentations.find((p: any) => p.id === id)?.description.includes(EARLIER));
      return { changes: { [t]: pick }, unresolved: [] };
    });
    expect(feedback).toContain(`Slot ${String(t).padStart(2, "0")}: ${reason}`);
    expect(r.changed).toEqual([t]);
    expect(pres(shots(job.id)[t])).not.toBe(pres(review.job.scratch.longShots[t]));
    let payload = "";
    const v2 = await directorVerifyForJob(job.id, "long", async (input: any) => ((payload = v.directorQaPayload(input, "verify")), { humanReview: {}, summary: "No factual mismatch remains." }));
    expect(block(payload, t)).toContain(EARLIER);
    expect(block(payload, t)).not.toContain(LATER);
    expect(v2.verify.humanReview).toEqual([]);
    expect(JSON.stringify(v2.verify)).not.toContain("parliamentary vote");
    expect(h.calls.length + h.images + h.other).toBe(0);
  });
});
