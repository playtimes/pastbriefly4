import { describe, test, expect, vi } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

// Film Grammar v2E: Coverage Director -> presentation library -> Editor. Timing
// still comes only from the locked v2D cut grid (phrase beats -> fixed EDIT SLOTS).
// The Coverage Director proposes each film's media library (validated, local ids
// L00.. / S00..); PB4 derives every legal presentation (base, plus reconstruction
// detail crops per mustShow region); the Editor picks one presentation per slot;
// PB4 selects motion under a local budget; each used asset is acquired once.
// Everything is validated locally and never repaired. Mock mode only: no provider
// is ever called.
const tmp = mkdtempSync(path.join(os.tmpdir(), "pb4-film-grammar-"));
process.env.PROVIDER_MODE = "mock";
process.env.PB4_DATA_DIR = path.join(tmp, "data");
process.env.PB4_MEDIA_DIR = path.join(tmp, "media");

// Skip the ffmpeg placeholder stills; a stub file is enough for these tests.
vi.mock("../src/production/mockAssets.ts", async (importOriginal) => {
  const { mkdirSync, writeFileSync } = await import("node:fs");
  const nodePath = await import("node:path");
  return {
    ...(await importOriginal<typeof import("../src/production/mockAssets.ts")>()),
    writePlaceholderStill: (outPath: string) => {
      mkdirSync(nodePath.dirname(outPath), { recursive: true });
      writeFileSync(outPath, "img");
    },
  };
});

const {
  buildBeats, buildEditSlots, slotGridProblems, planSlots, planVisuals, resolveReuse, acquireStill, buildRenderPlan, buildPreview, assertFilmGrammarPlan, VisualPlanError,
  fallbackCoverageDirector, fallbackEditor, coveragePayload, editorPayload, editorSchema, slotBlock, validateCoverage, screenCoverage, buildPresentations, validateEdit, selectMotion, assembleEdit, libraryBlock,
  BEAT_HARD_MAX_SEC, SLOT_MAX_SEC, END_TAIL_SEC, COVERAGE_INSTRUCTIONS, COVERAGE_SCHEMA, EDITOR_INSTRUCTIONS, MOTION_BUDGET, MAX_MUST_SHOW, FPS,
} = await import("../src/production/visuals.ts");
import type { Beat, CoverageAsset, CoverageInput, EditorInput, EditorPlans, EditSlot, PlannedShot, Presentation, VisualDirectors } from "../src/production/visuals.ts";
const { paulBunyanStory, paulBunyanResearch, paulBunyanScripts } = await import("../src/production/fixtures/paulBunyan.ts");
const { fillEdit } = await import("./slotPlan.ts");
const { recordNarration } = await import("../src/production/narration.ts");
const { ensureStoryDirs, inStory } = await import("../src/production/paths.ts");
const { words } = await import("../src/production/text.ts");
const { MOTION_CLIP_SECONDS } = await import("../src/server/pricing.ts");
const { stillStyle } = await import("../src/render/Shot.tsx");
const { framingTransform } = await import("../src/render/framing.ts");
import type { Narration } from "../src/production/narration.ts";
import type { Shot } from "../src/render/types.ts";

const story = { ...paulBunyanStory, createdAt: new Date().toISOString() };

async function narration() {
  ensureStoryDirs(story.slug);
  const long = await recordNarration(story.slug, "long", paulBunyanScripts.long);
  const short = await recordNarration(story.slug, "short", paulBunyanScripts.short);
  return { long, short };
}

// Realistic synthetic narration: per-word durations from word length, pauses
// after clause and sentence punctuation, all scaled by `pace` (2 = half speed).
function timed(script: string, pace = 1): Narration {
  let t = 0.25;
  const ws = words(script).map((w) => {
    const dur = (0.12 + 0.045 * w.replace(/[^A-Za-z0-9]/g, "").length) * pace;
    const out = { word: w, start: t, end: t + dur };
    t += dur + (/[.!?]$/.test(w) ? 0.45 : /[,;:]$/.test(w) ? 0.2 : 0.04) * pace;
    return out;
  });
  return { audioRel: "audio/x.mp3", audioMediaRel: "m/x", durationSec: (ws.at(-1)?.end ?? 0) + 0.4, words: ws };
}

function expectContiguous(beats: { wordStart: number; wordEnd: number; startSec: number; endSec: number }[], script: string, n: Narration) {
  expect(beats[0].wordStart).toBe(0);
  expect(beats[0].startSec).toBe(0);
  for (let i = 1; i < beats.length; i++) {
    expect(beats[i].wordStart).toBe(beats[i - 1].wordEnd); // no missing words, no overlaps
    expect(beats[i].startSec).toBe(beats[i - 1].endSec); // no timeline gaps
  }
  expect(beats.at(-1)!.wordEnd).toBe(words(script).length); // reaches the last narrated word
  expect(beats.at(-1)!.endSec).toBeCloseTo(n.durationSec + END_TAIL_SEC, 6);
}

// Synthetic phrase beats with exact durations, for the slot partition.
function beatsOf(parts: [number, string][]): Beat[] {
  let t = 0;
  let w = 0;
  return parts.map(([d, excerpt], id) => {
    const n = words(excerpt).length;
    const b = { id, excerpt, wordStart: w, wordEnd: w + n, startSec: t, endSec: t + d, durationSec: d };
    t += d;
    w += n;
    return b;
  });
}
const spans = (slots: EditSlot[]) => slots.map((s) => [s.startBeatId, s.endBeatId]);
// One slot per duration: every beat ends a sentence, so none merge.
const slotsOf = (kind: "long" | "short", durations: number[]) => buildEditSlots(kind, beatsOf(durations.map((d, i) => [d, `Beat number ${i}.`])));

// A Coverage asset: by default a motion-capable reconstruction with elements in
// the center and on the right. asset(over) overrides fields.
type AssetSpec = Partial<CoverageAsset>;
const asset = (over: AssetSpec = {}): CoverageAsset => ({
  truth: "reconstruction",
  purpose: "Show the felled poplar tree beside the bridge.",
  mustShow: [{ description: "felled poplar tree", region: "center" }, { description: "UN engineers", region: "right" }],
  mustNotShow: ["modern equipment"],
  prompt: "a felled poplar beside the bridge at dawn",
  archiveQuery: "",
  useMaster: false,
  baseFraming: "wide",
  motionCapable: true,
  ...over,
});
const graphicAsset: AssetSpec = { truth: "graphic", purpose: "Show where the tree stood relative to the bridge.", mustShow: [{ description: "the tree", region: "left" }, { description: "the bridge", region: "right" }], motionCapable: false };
const archiveAsset: AssetSpec = { truth: "archive", purpose: "Show the real site in 1976.", mustShow: [{ description: "the real poplar tree", region: "center" }], archiveQuery: "Panmunjom poplar tree 1976", motionCapable: false };

// Test planners. coverage(long, short) returns those asset specs. editor(long, short)
// assigns [presentationId, motionPriority] to the slots given; every other slot gets
// fill(): "L00:base" / "S00:base", or, where that would repeat an adjacent slot, the
// next legal presentation (L00's own details first) that repeats neither neighbour.
function coverage(long: AssetSpec[] = [{}], short: AssetSpec[] = [{}]) {
  return async (_input: CoverageInput) => ({ longAssets: long.map(asset), shortAssets: short.map(asset) });
}
type Picks = Record<number, [string, number?]>;
function fill(slots: EditSlot[], presentations: Presentation[], prefix: string, picks: Picks): string[] {
  const first = `${prefix}00:`;
  const order = [...presentations.filter((p) => p.id.startsWith(first)), ...presentations.filter((p) => !p.id.startsWith(first))].map((p) => p.id);
  return fillEdit(slots.map((s) => s.id), order, (id) => picks[id]?.[0]);
}
function editor(long: Picks = {}, short: Picks = {}) {
  const film = (slots: EditSlot[], presentations: Presentation[], prefix: string, picks: Picks) => {
    const ids = fill(slots, presentations, prefix, picks);
    return slots.map((s) => ({ slotId: s.id, presentationId: ids[s.id], motionPriority: picks[s.id]?.[1] ?? 0 }));
  };
  return async (input: EditorInput): Promise<EditorPlans> => ({
    long: film(input.slots.long, input.presentations.long, "L", long),
    short: film(input.slots.short, input.presentations.short, "S", short),
  });
}
const directors = (cov = coverage(), ed = editor()): VisualDirectors => ({ coverage: cov, editor: ed });
async function plan(d: VisualDirectors = directors()) {
  return planVisuals(story, paulBunyanResearch, paulBunyanScripts, await narration(), d);
}

async function acquireAll(kind: "long" | "short", shots: PlannedShot[]) {
  for (const s of shots) if (s.edit === "new") await acquireStill(story, kind, s, "images/hero.png");
  resolveReuse(story, kind, shots);
}

// Mock narration fixtures used below (Paul Bunyan, deterministic mock timings):
// Long slot 0 = beats 0-1 (5.95s, no motion), slot 1 = beat 2 (4.29s), slot 5 =
// beats 6-7 (6.02s), slot 6 = beat 8 (4.91s); Short slot 0 = beats 0-1 (5.08s, no
// motion), slot 1 = beat 2 (3.71s).

// ---------------------------------------------------------------------------
describe("timed phrase beats", () => {
  test("Long beats come from the real word times, not from the word count", () => {
    const script = paulBunyanScripts.long;
    const normal = buildBeats("long", script, timed(script, 1));
    const slow = buildBeats("long", script, timed(script, 1.6));
    // The same words spoken slower need more beats: timing, not text, sets the cut list.
    expect(slow.length).toBeGreaterThan(normal.length);
    const n = timed(script, 1);
    for (const b of normal.slice(1)) expect(b.startSec).toBe(n.words[b.wordStart].start); // cuts land on spoken word onsets
  });

  test("normal Long beats land around 3-5s and none exceeds the hard maximum", () => {
    const n = timed(paulBunyanScripts.long);
    const beats = buildBeats("long", paulBunyanScripts.long, n);
    const inRange = beats.filter((b) => b.durationSec >= 2.5 && b.durationSec <= 5).length;
    expect(inRange / beats.length).toBeGreaterThanOrEqual(0.85);
    for (const b of beats) expect(b.durationSec).toBeLessThanOrEqual(BEAT_HARD_MAX_SEC);
    expect(BEAT_HARD_MAX_SEC).toBeLessThanOrEqual(MOTION_CLIP_SECONDS);
    // Not tiny fragments: the median beat is a real phrase.
    const sorted = beats.map((b) => b.durationSec).sort((a, b) => a - b);
    expect(sorted[Math.floor(sorted.length / 2)]).toBeGreaterThan(3);
  });

  test("Short beats are phrase-timed around 2.5-4s", () => {
    const n = timed(paulBunyanScripts.short);
    const beats = buildBeats("short", paulBunyanScripts.short, n);
    const inRange = beats.filter((b) => b.durationSec >= 2 && b.durationSec <= 4.5).length;
    expect(inRange / beats.length).toBeGreaterThanOrEqual(0.8);
    for (const b of beats) expect(b.durationSec).toBeLessThanOrEqual(BEAT_HARD_MAX_SEC);
    const mean = beats.reduce((a, b) => a + b.durationSec, 0) / beats.length;
    expect(mean).toBeLessThan(buildBeats("long", paulBunyanScripts.short, n).reduce((a, b) => a + b.durationSec, 0) / buildBeats("long", paulBunyanScripts.short, n).length + 1e-9);
  });

  test("every narration word is covered exactly once, for both films, with the mock narration too", async () => {
    const narr = await narration();
    for (const kind of ["long", "short"] as const) {
      const script = paulBunyanScripts[kind];
      expectContiguous(buildBeats(kind, script, narr[kind]), script, narr[kind]);
      expectContiguous(buildBeats(kind, script, timed(script)), script, timed(script));
    }
  });

  test("beats prefer sentence and clause boundaries", () => {
    const n = timed(paulBunyanScripts.long);
    const beats = buildBeats("long", paulBunyanScripts.long, n);
    const punctuated = beats.filter((b) => /[.!?,;:]["')\]]?$/.test(b.excerpt) || /-$/.test(b.excerpt)).length;
    expect(punctuated / beats.length).toBeGreaterThanOrEqual(0.8);
  });

  test("only a single word that alone outlasts the maximum may exceed it", () => {
    const script = "The fuse was lit. Then silence. Everyone waited on the ridge for the blast to come.";
    const n = timed(script);
    // Stretch "silence." with a long pause after it: that one word holds the screen ~7s.
    const i = n.words.findIndex((w) => w.word === "silence.");
    for (let k = i + 1; k < n.words.length; k++) {
      n.words[k].start += 7;
      n.words[k].end += 7;
    }
    n.durationSec += 7;
    const beats = buildBeats("long", script, n);
    expectContiguous(beats, script, n);
    for (const b of beats.filter((b) => b.durationSec > BEAT_HARD_MAX_SEC)) expect(b.wordEnd - b.wordStart).toBe(1);
  });
});

// ---------------------------------------------------------------------------
describe("local edit slots: PB4 owns the cut grid", () => {
  test("slots cover every phrase beat exactly once, with no gaps or overlaps, in both films", async () => {
    const narr = await narration();
    for (const kind of ["long", "short"] as const) {
      for (const n of [narr[kind], timed(paulBunyanScripts[kind]), timed(paulBunyanScripts[kind], 1.3)]) {
        const beats = buildBeats(kind, paulBunyanScripts[kind], n);
        const slots = buildEditSlots(kind, beats);
        expect(slotGridProblems(kind, beats, slots)).toEqual([]);
        expect(slots[0].startBeatId).toBe(0);
        expect(slots.at(-1)!.endBeatId).toBe(beats.length - 1);
        slots.forEach((s, i) => {
          expect(s.id).toBe(i);
          if (i > 0) expect(s.startBeatId).toBe(slots[i - 1].endBeatId + 1); // every beat once, in order
          expect(s).toMatchObject({ wordStart: beats[s.startBeatId].wordStart, wordEnd: beats[s.endBeatId].wordEnd, startSec: beats[s.startBeatId].startSec, endSec: beats[s.endBeatId].endSec });
          expect(s.durationSec).toBeCloseTo(s.endSec - s.startSec, 9);
          expect(s.excerpt).toBe(beats.slice(s.startBeatId, s.endBeatId + 1).map((b) => b.excerpt).join(" "));
        });
        expectContiguous(slots, paulBunyanScripts[kind], n); // words and screen time, end to end
      }
    }
  });

  test("Long slots stay within 7s and Short slots within 6s", async () => {
    expect(SLOT_MAX_SEC).toEqual({ long: 7, short: 6 });
    const narr = await narration();
    for (const kind of ["long", "short"] as const) {
      for (const n of [narr[kind], timed(paulBunyanScripts[kind], 0.8), timed(paulBunyanScripts[kind]), timed(paulBunyanScripts[kind], 1.3)]) {
        for (const s of buildEditSlots(kind, buildBeats(kind, paulBunyanScripts[kind], n))) expect(s.durationSec).toBeLessThanOrEqual(SLOT_MAX_SEC[kind] + 1e-6);
      }
    }
    // Some slots in the real mock grid do group several phrases.
    expect(buildEditSlots("long", buildBeats("long", paulBunyanScripts.long, narr.long)).some((s) => s.endBeatId > s.startBeatId)).toBe(true);
  });

  test("two short related phrases that fit are merged into one sensible slot", () => {
    expect(spans(buildEditSlots("long", beatsOf([[2.2, "When the order finally came"], [2.4, "the crew moved onto the deck."]])))).toEqual([[0, 1]]);
    expect(spans(buildEditSlots("short", beatsOf([[1.8, "When the order came"], [2.0, "the crew moved."]])))).toEqual([[0, 1]]);
    // A clause break inside one sentence still merges when both halves are short.
    expect(spans(buildEditSlots("long", beatsOf([[2.2, "When the order finally came,"], [2.4, "the crew moved onto the deck."]])))).toEqual([[0, 1]]);
  });

  test("phrases that do not fit together stay separate slots, and it never merges only to reduce the count", () => {
    expect(spans(buildEditSlots("long", beatsOf([[4.0, "a long first phrase that runs on"], [3.5, "and a second phrase after it."]])))).toEqual([[0, 0], [1, 1]]); // 7.5s > 7s
    expect(spans(buildEditSlots("short", beatsOf([[3.5, "a long first phrase"], [3.0, "and a second one."]])))).toEqual([[0, 0], [1, 1]]); // 6.5s > 6s
    // Two comfortable clauses (3.5s + 3.4s = 6.9s, legal) keep their own slots: merging would only cut the count.
    expect(spans(buildEditSlots("long", beatsOf([[3.5, "The first clause ran on,"], [3.4, "and the second clause ended."]])))).toEqual([[0, 0], [1, 1]]);
  });

  test("a sentence boundary is strongly preferred as a cut", () => {
    // Same durations (2.5s + 2.5s = 5.0s, right in the Long pace band): only the punctuation differs.
    expect(spans(buildEditSlots("long", beatsOf([[2.5, "The submarine ran aground,"], [2.5, "and the crew waited on deck."]])))).toEqual([[0, 1]]);
    expect(spans(buildEditSlots("long", beatsOf([[2.5, "The submarine ran aground."], [2.5, "The crew waited on deck."]])))).toEqual([[0, 0], [1, 1]]);
    expect(spans(buildEditSlots("short", beatsOf([[1.8, "The order came."], [2.0, "The crew moved."]])))).toEqual([[0, 0], [1, 1]]);
  });

  test("the same beats always give the same slots", async () => {
    const narr = await narration();
    for (const kind of ["long", "short"] as const) {
      const beats = buildBeats(kind, paulBunyanScripts[kind], narr[kind]);
      expect(buildEditSlots(kind, beats)).toEqual(buildEditSlots(kind, structuredClone(beats)));
      expect(planSlots(kind, paulBunyanScripts[kind], narr[kind])).toEqual(buildEditSlots(kind, beats));
    }
  });

  test("phrase beats are never split, and a single beat that alone outlasts the maximum stands as its own slot", () => {
    const slots = buildEditSlots("long", beatsOf([[3, "Then silence."], [8, "Everyone waited."], [3, "Then the blast."]]));
    expect(spans(slots)).toEqual([[0, 0], [1, 1], [2, 2]]);
    expect(slots[1]).toMatchObject({ durationSec: 8, motionAllowed: false });
    expect(slotGridProblems("long", beatsOf([[3, "a."], [8, "b."], [3, "c."]]), slots)).toEqual([]);
  });

  test("a broken grid is reported, so it could never reach a planner", () => {
    const beats = beatsOf([[2, "a,"], [2, "b,"], [2, "c,"], [2, "d."]]);
    const slots = buildEditSlots("short", beats);
    expect(slotGridProblems("short", beats, slots)).toEqual([]);
    const s = (id: number, a: number, b: number, d = 2): EditSlot => ({ ...slots[0], id, startBeatId: a, endBeatId: b, durationSec: d });
    expect(slotGridProblems("short", beats, [s(0, 0, 1), s(1, 3, 3)])).toEqual(["short slot 1 starts at beat 3, expected 2"]);
    expect(slotGridProblems("short", beats, [s(0, 0, 1), s(1, 1, 3)])).toEqual(["short slot 1 starts at beat 1, expected 2"]);
    expect(slotGridProblems("short", beats, [s(0, 0, 1)])).toEqual(["short slots end at beat 1, not the final beat 3"]);
    expect(slotGridProblems("short", beats, [s(0, 0, 3, 6.5)])).toEqual(["short slot 0 runs 6.50s, over the 6s maximum"]);
  });

  test("both planners see the same fixed slots with time, duration, motion allowance and narration, and no beat ranges", async () => {
    const narr = await narration();
    let cov: CoverageInput | undefined;
    let ed: EditorInput | undefined;
    await planVisuals(story, paulBunyanResearch, paulBunyanScripts, narr, {
      coverage: async (i) => ((cov = i), fallbackCoverageDirector(i)),
      editor: async (i) => ((ed = i), fallbackEditor(i)),
    });
    expect(cov!.slots.long).toEqual(planSlots("long", paulBunyanScripts.long, narr.long));
    expect(cov!.slots.short).toEqual(planSlots("short", paulBunyanScripts.short, narr.short));
    expect(ed!.slots).toEqual(cov!.slots);
    expect(Object.keys(cov!).sort()).toEqual(["research", "scripts", "slots", "story"]); // no phrase beats at the planner boundary
    const s0 = cov!.slots.long[0];
    expect(slotBlock(s0)).toBe(`SLOT #0\ntime: 0.00-5.95\nduration: 5.95s\nmotion allowed: no\nnarration: "${s0.excerpt}"`);
    expect(slotBlock(cov!.slots.long[1])).toMatch(/^SLOT #1\ntime: 5\.95-10\.24\nduration: 4\.29s\nmotion allowed: yes\nnarration: "/);
    for (const payload of [coveragePayload(cov!), editorPayload(ed!)]) {
      for (const s of [...cov!.slots.long, ...cov!.slots.short]) expect(payload).toContain(slotBlock(s));
      expect(payload).toContain(`LONG SLOTS (#0-#${cov!.slots.long.length - 1}):`);
      expect(payload).not.toMatch(/may end through|BEATS \(|startBeatId|endBeatId|sourceSlotId|sourceElementIndex/);
    }
    expect(coveragePayload(cov!)).toMatch(/Do NOT assign anything to slots: propose each film's media library/);
  });
});

// ---------------------------------------------------------------------------
describe("motion allowance per fixed slot", () => {
  test("a slot of 5s or less allows motion; a longer slot does not", async () => {
    const narr = await narration();
    const long = planSlots("long", paulBunyanScripts.long, narr.long);
    for (const s of long) expect(s.motionAllowed).toBe(s.durationSec <= MOTION_CLIP_SECONDS + 1e-6);
    expect(long[0]).toMatchObject({ durationSec: expect.closeTo(5.95, 2), motionAllowed: false });
    expect(long[1]).toMatchObject({ durationSec: expect.closeTo(4.29, 2), motionAllowed: true });
    expect(buildEditSlots("long", beatsOf([[5, "Exactly five seconds."]]))[0].motionAllowed).toBe(true);
    expect(buildEditSlots("long", beatsOf([[5.01, "Just over five seconds."]]))[0].motionAllowed).toBe(false);
  });

  test("no v2D per-slot director, reframe bookkeeping, freeze-tail or event-range logic remains", () => {
    const src = readFileSync(path.join(__dirname, "..", "src", "production", "visuals.ts"), "utf8");
    expect(src).not.toMatch(/maxNormalEndBeat|maxMotionEndBeat|legalEventEnds|MOTION_EVENT_MAX_SEC|\bEVENT_MAX_SEC|beatLine|may end through/);
    expect(src).not.toMatch(/sourceBeatId|sourceBeat\b|reframeOfBeat|DirectorEvent|assembleEvents|fallbackEvents/);
    expect(src).not.toMatch(/sourceSlotId|sourceElementIndex|DirectorDecision|DIRECTOR_SCHEMA|DIRECTOR_INSTRUCTIONS|assembleSlots|resolveReframes|"reframe"/);
    expect(src).not.toMatch(/is a graphic; only a reconstruction or archive still can be reframed|already showed slot/);
    expect(src).not.toMatch(/validateHold|hold would extend|assetBeatId|MAX_HOLD|freeze(Tail|Frame)/);
  });
});

// ---------------------------------------------------------------------------
describe("coverage director: a validated media library", () => {
  test("assets get deterministic local ids: L00.. for the Long, S00.. for the Short", () => {
    const raw = [asset(), asset(graphicAsset), asset(archiveAsset)];
    expect(validateCoverage("long", raw).map((a) => a.id)).toEqual(["L00", "L01", "L02"]);
    expect(validateCoverage("short", raw).map((a) => a.id)).toEqual(["S00", "S01", "S02"]);
    expect(validateCoverage("long", structuredClone(raw))).toEqual(validateCoverage("long", raw));
    const many = Array.from({ length: 12 }, () => asset());
    expect(validateCoverage("long", many).at(-1)!.id).toBe("L11");
  });

  test("a valid asset keeps its fields; continuity and motion only mean something for a reconstruction", () => {
    const [rec, gfx, arc] = validateCoverage("long", [asset({ useMaster: true }), asset({ ...graphicAsset, useMaster: true, motionCapable: true }), asset({ ...archiveAsset, motionCapable: true })]);
    expect(rec).toMatchObject({ id: "L00", truth: "reconstruction", useMaster: true, motionCapable: true, baseFraming: "wide", archiveQuery: "" });
    expect(rec.mustShow).toEqual([{ description: "felled poplar tree", region: "center" }, { description: "UN engineers", region: "right" }]);
    expect(gfx).toMatchObject({ truth: "graphic", useMaster: false, motionCapable: false });
    expect(arc).toMatchObject({ truth: "archive", archiveQuery: "Panmunjom poplar tree 1976", motionCapable: false });
    expect(validateCoverage("long", [asset({ archiveQuery: "ignored" })])[0].archiveQuery).toBe("");
  });

  const invalid: [string, AssetSpec, RegExp][] = [
    ["an unknown truth", { truth: "photo" as never }, /^has truth "photo", not archive, reconstruction or graphic$/],
    ["no purpose", { purpose: " " }, /^has no purpose$/],
    ["no prompt", { prompt: "" }, /^has no prompt/],
    ["no mustShow", { mustShow: [] }, /^has no mustShow elements/],
    ["plain-string mustShow", { mustShow: ["felled poplar tree"] as never }, /mustShow\[0\] is not a \{description, region\} element with a description/],
    ["an unknown region", { mustShow: [{ description: "felled poplar tree", region: "top" as never }] }, /mustShow\[0\] "felled poplar tree" has region "top", not left, center, right or whole/],
    ["a missing region", { mustShow: [{ description: "felled poplar tree" } as never] }, /has region null/],
    ["an \"or\" element", { mustShow: [{ description: "signage or buoys", region: "left" }] }, /mustShow\[0\] "signage or buoys" is an either\/or element/],
    ["a slash element", { mustShow: [{ description: "sonar/radar equipment", region: "left" }] }, /"sonar\/radar equipment" is an either\/or element/],
    ["an \"either\" element", { mustShow: [{ description: "either patrol boat", region: "left" }] }, /"either patrol boat" is an either\/or element/],
    ["an \"and/or\" element", { mustShow: [{ description: "tug and/or barge", region: "left" }] }, /"tug and\/or barge" is an either\/or element/],
    ["a non-object candidate", "an asset" as never, /^has truth null/],
    ["too many elements", { mustShow: Array.from({ length: MAX_MUST_SHOW + 1 }, (_, i) => ({ description: `thing ${i}`, region: "center" as const })) }, /has 5 mustShow elements, more than 4/],
    ["a repeated element", { mustShow: [{ description: "the bridge", region: "left" }, { description: "The bridge", region: "right" }] }, /repeats the mustShow element "The bridge"/],
    ["archive without a query", { truth: "archive", archiveQuery: "  " }, /^is archive but has no archiveQuery$/],
    ["a detail base framing", { baseFraming: "detail-left" as never }, /has baseFraming "detail-left", not wide or medium/],
    ["no motionCapable flag", { motionCapable: undefined as never }, /has no motionCapable flag/],
  ];
  test.each(invalid)("%s discards that candidate only, never repaired", (_name, spec, reason) => {
    const third = asset({ purpose: "Show the bridge after the tree was felled." });
    const bad = typeof spec === "string" ? spec : asset(spec);
    const { assets, rejected } = screenCoverage("long", [asset(), bad, third]);
    expect(assets.map((a) => a.id)).toEqual(["L00", "L01"]); // ids assigned after filtering
    expect(assets[1].purpose).toBe(third.purpose);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]).toMatchObject({ film: "long", index: 1 });
    expect(rejected[0].reason).toMatch(reason);
  });

  test("valid candidates survive unchanged; several invalid ones are filtered independently", () => {
    const ok = [asset(), asset(graphicAsset), asset(archiveAsset)];
    const orEl = asset({ mustShow: [{ description: "table or desk", region: "left" }] });
    const slash = asset({ mustShow: [{ description: "gangway/hatch", region: "center" }] });
    const noQuery = asset({ truth: "archive", archiveQuery: "" });
    const { assets, rejected } = screenCoverage("short", [orEl, ok[0], slash, ok[1], noQuery, ok[2]]);
    expect(assets).toEqual(validateCoverage("short", ok)); // the same assets, the same ids, nothing altered
    expect(assets.map((a) => a.id)).toEqual(["S00", "S01", "S02"]);
    expect(rejected).toEqual([
      { film: "short", index: 0, reason: 'mustShow[0] "table or desk" is an either/or element; each element must be one concrete visible thing' },
      { film: "short", index: 2, reason: 'mustShow[0] "gangway/hatch" is an either/or element; each element must be one concrete visible thing' },
      { film: "short", index: 4, reason: "is archive but has no archiveQuery" },
    ]);
  });

  test("a film with zero valid candidates fails, naming every rejection", () => {
    const run = () => screenCoverage("long", [asset({ purpose: "" }), asset({ mustShow: [{ description: "tug or support vessel", region: "right" }] })]);
    expect(run).toThrow(VisualPlanError);
    expect(run).toThrow(/^Invalid coverage plan: long has no valid candidates \(2 proposed, all rejected: #0 has no purpose; #1 mustShow\[0\] "tug or support vessel" is an either\/or element; each element must be one concrete visible thing\)\.$/);
    expect(() => screenCoverage("short", [asset({ baseFraming: "tight" as never })])).toThrow(/^Invalid coverage plan: short has no valid candidates \(1 proposed/);
  });

  test("a missing or empty library is refused, including an old per-slot answer", () => {
    expect(() => validateCoverage("long", undefined)).toThrow(/^Invalid coverage plan: longAssets is missing or empty; each film needs a media library\.$/);
    expect(() => validateCoverage("short", [])).toThrow(/shortAssets is missing or empty/);
  });

  test("the Coverage schema returns asset libraries only: no slots, timing or crops", () => {
    expect(COVERAGE_SCHEMA.required).toEqual(["longAssets", "shortAssets"]);
    const item = COVERAGE_SCHEMA.properties.longAssets.items as any;
    expect([...item.required].sort()).toEqual(["archiveQuery", "baseFraming", "motionCapable", "mustNotShow", "mustShow", "prompt", "purpose", "truth", "useMaster"]);
    expect(Object.keys(item.properties).sort()).toEqual([...item.required].sort());
    expect(item.properties.mustShow.items.properties.region.enum).toEqual(["left", "center", "right", "whole"]);
    expect(item.properties.baseFraming.enum).toEqual(["wide", "medium"]);
    for (const gone of ["slotId", "edit", "framing", "wantsMotion", "motion", "sourceSlotId", "startSec"]) expect(item.properties[gone]).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
describe("presentation library: legal presentations are derived locally", () => {
  const lib = (...specs: AssetSpec[]) => buildPresentations(validateCoverage("long", specs.map(asset)));

  test("every asset gets a base presentation at its base framing", () => {
    const p = lib({}, graphicAsset, archiveAsset, { baseFraming: "medium" });
    expect(p.filter((x) => x.kind === "base").map((x) => [x.id, x.framing])).toEqual([["L00:base", "wide"], ["L01:base", "wide"], ["L02:base", "wide"], ["L03:base", "medium"]]);
  });

  test("a reconstruction gets one detail crop per distinct region, left -> center -> right", () => {
    const p = lib({
      mustShow: [
        { description: "grounded submarine", region: "center" },
        { description: "patrol vessel", region: "right" },
        { description: "rocks beneath the hull", region: "center" },
        { description: "fisherman in a boat", region: "left" },
      ],
    });
    expect(p.map((x) => x.id)).toEqual(["L00:base", "L00:detail-left", "L00:detail-center", "L00:detail-right"]);
    expect(p[2]).toMatchObject({ kind: "detail-center", framing: "detail-center", elements: ["grounded submarine", "rocks beneath the hull"] });
    expect(p[2].description).toBe("crop on grounded submarine; rocks beneath the hull");
    expect(p[0].elements).toEqual(["grounded submarine", "patrol vessel", "rocks beneath the hull", "fisherman in a boat"]);
  });

  test("a whole-frame element makes no detail crop", () => {
    expect(lib({ mustShow: [{ description: "open sea", region: "whole" }] }).map((x) => x.id)).toEqual(["L00:base"]);
    expect(lib({ mustShow: [{ description: "open sea", region: "whole" }, { description: "patrol vessel", region: "left" }] }).map((x) => x.id)).toEqual(["L00:base", "L00:detail-left"]);
  });

  test("archive and graphics are base only: graphics are never reframed", () => {
    expect(lib(archiveAsset).map((x) => x.id)).toEqual(["L00:base"]);
    expect(lib(graphicAsset).map((x) => x.id)).toEqual(["L00:base"]); // left and right regions, still no crop
  });

  test("the same library always gives the same presentations", () => {
    expect(lib({}, graphicAsset)).toEqual(lib({}, graphicAsset));
  });

  // Capabilities are derived locally from the asset; nothing new is stored.
  describe("capabilities the Editor sees beside every presentation", () => {
    const assets = validateCoverage("long", [asset(), asset(archiveAsset), asset(graphicAsset), asset({ motionCapable: false })]);
    const pres = buildPresentations(assets);
    const block = (i: number) => libraryBlock(assets[i], pres);

    test("motion eligibility: only the base of a motion-capable reconstruction", () => {
      expect(pres.map((p) => [p.id, p.truth, p.motionEligible])).toEqual([
        ["L00:base", "reconstruction", true],
        ["L00:detail-center", "reconstruction", false],
        ["L00:detail-right", "reconstruction", false],
        ["L01:base", "archive", false],
        ["L02:base", "graphic", false],
        ["L03:base", "reconstruction", false],
        ["L03:detail-center", "reconstruction", false],
        ["L03:detail-right", "reconstruction", false],
      ]);
    });

    test("an archive base is marked base only, no details, no motion", () => {
      expect(block(1)).toContain("  L01:base - archive, wide: Show the real site in 1976.\n    type: archive\n    detail views: none (base only: cut away and return later, never hold it on adjacent slots)\n    adjacent repeat: FORBIDDEN\n    motion eligible: no (motionPriority must be 0)");
    });

    test("a graphic base is marked base only, no details, no motion", () => {
      expect(block(2)).toContain("  L02:base - graphic, wide: Show where the tree stood relative to the bridge.\n    type: graphic\n    detail views: none (base only: cut away and return later, never hold it on adjacent slots)\n    adjacent repeat: FORBIDDEN\n    motion eligible: no (motionPriority must be 0)");
    });

    test("a reconstruction base lists its legal details; motion follows motionCapable", () => {
      expect(block(0)).toContain("  L00:base - reconstruction, wide: Show the felled poplar tree beside the bridge.\n    type: reconstruction\n    detail views:\n    - L00:detail-center\n    - L00:detail-right\n    adjacent repeat: FORBIDDEN\n    motion eligible: yes (only on a slot with motion allowed: yes)");
      expect(block(3)).toMatch(/L03:base - [^\n]*\n    type: reconstruction\n    detail views:\n    - L03:detail-center\n    - L03:detail-right\n    adjacent repeat: FORBIDDEN\n    motion eligible: no \(motionPriority must be 0\)/);
    });

    test("a detail names its source asset and is never motion eligible", () => {
      expect(block(0)).toContain("  L00:detail-right - crop on UN engineers\n    type: reconstruction detail\n    source asset: L00\n    adjacent repeat: FORBIDDEN\n    motion eligible: no (motionPriority must be 0)");
    });

    test("every presentation says adjacent repeat forbidden and exposes motion eligibility", () => {
      const text = assets.map((_, i) => block(i)).join("\n");
      expect(text.match(/^ {2}L\d\d:[a-z-]+ - /gm)!.length).toBe(pres.length);
      expect(text.match(/^ {4}adjacent repeat: FORBIDDEN$/gm)!.length).toBe(pres.length);
      expect(text.match(/^ {4}motion eligible: (yes|no) /gm)!.length).toBe(pres.length);
    });
  });
});

// ---------------------------------------------------------------------------
describe("editor: exactly one legal presentation per fixed slot", () => {
  const slots = slotsOf("long", [4, 4, 4, 4]);
  const pres = buildPresentations(validateCoverage("long", [asset(), asset(graphicAsset)]));
  const a = (slotId: number, presentationId = "L00:base", motionPriority = 0) => ({ slotId, presentationId, motionPriority });
  const good = () => [a(0), a(1, "L00:detail-center"), a(2, "L01:base"), a(3, "L00:base", 2)];

  test("one assignment for every slot passes and comes back in slot order", () => {
    expect(validateEdit("long", slots, good(), pres)).toEqual(good());
    expect(validateEdit("long", slots, good().reverse(), pres)).toEqual(good());
  });

  const cases: [string, () => unknown, RegExp][] = [
    ["a missing slot", () => good().filter((x) => x.slotId !== 2), /^Invalid edit plan: long is missing an assignment for slot 2; every slot gets exactly one assignment\.$/],
    ["several missing slots", () => good().slice(0, 2), /is missing an assignment for slots 2, 3;/],
    ["a duplicate slot", () => [...good(), a(1)], /^Invalid edit plan: long item 4: slotId 1 is duplicated; every slot gets exactly one assignment\.$/],
    ["an unknown slot", () => [...good(), a(4)], /^Invalid edit plan: long item 4: slotId 4 is unknown \(slots are 0-3\)\.$/],
    ["a negative slot", () => [...good(), a(-1)], /slotId -1 is unknown/],
    ["a non-integer slot", () => good().map((x) => (x.slotId === 1 ? { ...x, slotId: 1.5 } : x)), /item 1: slotId 1\.5 is not an integer/],
    ["no assignments", () => [], /^Invalid edit plan: long has no slot assignments; the Editor must return exactly one assignment for each of slots 0-3\.$/],
    ["an unknown asset", () => good().map((x) => (x.slotId === 2 ? a(2, "L07:base") : x)), /^Invalid edit plan: long slot 2 \(beats 2-2, 4\.00s\): presentationId "L07:base" is not a legal long presentation\.$/],
    ["a crop that was never derived", () => good().map((x) => (x.slotId === 1 ? a(1, "L00:detail-left") : x)), /presentationId "L00:detail-left" is not a legal long presentation/],
    ["a graphic crop", () => good().map((x) => (x.slotId === 2 ? a(2, "L01:detail-left") : x)), /presentationId "L01:detail-left" is not a legal long presentation/],
    ["a Short presentation in the Long", () => good().map((x) => (x.slotId === 0 ? a(0, "S00:base") : x)), /presentationId "S00:base" is not a legal long presentation/],
    ["a bare asset id", () => good().map((x) => (x.slotId === 0 ? a(0, "L00") : x)), /presentationId "L00" is not a legal long presentation/],
    ["an out-of-range motion priority", () => good().map((x) => (x.slotId === 3 ? a(3, "L00:base", 4) : x)), /slot 3 \(beats 3-3, 4\.00s\): motionPriority 4 is not 0, 1, 2 or 3/],
    ["a fractional motion priority", () => good().map((x) => (x.slotId === 3 ? a(3, "L00:base", 1.5) : x)), /motionPriority 1\.5 is not 0, 1, 2 or 3/],
    ["an adjacent identical base (a hidden hold)", () => good().map((x) => (x.slotId === 1 ? a(1) : x)), /^Invalid edit plan: long slot 1 \(beats 1-1, 4\.00s\): presentationId "L00:base" repeats slot 0; adjacent slots must not show the identical presentation\.$/],
    ["an adjacent identical graphic", () => good().map((x) => (x.slotId === 3 ? a(3, "L01:base") : x)), /^Invalid edit plan: long slot 3 \(beats 3-3, 4\.00s\): presentationId "L01:base" repeats slot 2;/],
    ["an adjacent identical detail", () => good().map((x) => (x.slotId === 2 ? a(2, "L00:detail-center") : x)), /slot 2 \(beats 2-2, 4\.00s\): presentationId "L00:detail-center" repeats slot 1;/],
    ["an adjacent duplicate given out of order", () => [a(3, "L01:base"), a(2, "L01:base"), a(1, "L00:detail-center"), a(0)], /slot 3 \(beats 3-3, 4\.00s\): presentationId "L01:base" repeats slot 2;/],
    ["a motion priority on a graphic", () => good().map((x) => (x.slotId === 2 ? a(2, "L01:base", 1) : x)), /^Invalid edit plan: long slot 2 \(beats 2-2, 4\.00s\): motionPriority 1 on "L01:base", which is not motion eligible; its priority must be 0\.$/],
    ["a motion priority on a detail", () => good().map((x) => (x.slotId === 1 ? a(1, "L00:detail-center", 3) : x)), /slot 1 \(beats 1-1, 4\.00s\): motionPriority 3 on "L00:detail-center", which is not motion eligible/],
  ];
  test.each(cases)("%s fails validation, never repaired", (_name, make, reason) => {
    const run = () => validateEdit("long", slots, make(), pres);
    expect(run).toThrow(VisualPlanError);
    expect(run).toThrow(reason);
  });

  test("a motion priority on an eligible presentation passes, and on an archive base fails", () => {
    const withArchive = buildPresentations(validateCoverage("long", [asset(), asset(archiveAsset)]));
    const eligible = [a(0, "L00:base", 3), a(1, "L01:base"), a(2, "L00:base", 1), a(3, "L00:detail-center")];
    expect(validateEdit("long", slots, eligible, withArchive)).toEqual(eligible);
    expect(() => validateEdit("long", slots, eligible.map((x) => (x.slotId === 1 ? a(1, "L01:base", 2) : x)), withArchive)).toThrow(
      /^Invalid edit plan: long slot 1 \(beats 1-1, 4\.00s\): motionPriority 2 on "L01:base", which is not motion eligible; its priority must be 0\.$/,
    );
    // A non-motion-capable reconstruction's base is not eligible either.
    const still = buildPresentations(validateCoverage("long", [asset({ motionCapable: false })]));
    expect(() => validateEdit("long", slots, [a(0, "L00:base", 1), a(1, "L00:detail-center"), a(2), a(3, "L00:detail-right")], still)).toThrow(/motionPriority 1 on "L00:base", which is not motion eligible/);
  });

  test("the same presentation later (a callback) and base -> detail of one asset on adjacent slots are allowed", () => {
    const callback = [a(0, "L01:base"), a(1), a(2, "L01:base"), a(3)]; // L01:base and L00:base each return after one other slot
    expect(validateEdit("long", slots, callback, pres)).toEqual(callback);
    const coverage = [a(0), a(1, "L00:detail-center"), a(2, "L00:detail-right"), a(3)]; // one asset, four adjacent cuts
    expect(validateEdit("long", slots, coverage, pres)).toEqual(coverage);
  });

  test("an Editor plan with an adjacent identical presentation fails the whole plan before assembly, never repaired", async () => {
    await expect(plan(directors(coverage([{}, graphicAsset]), editor({ 4: ["L01:base"], 5: ["L01:base"] })))).rejects.toThrow(
      /^Invalid edit plan: long slot 5 \(beats 6-7, [\d.]+s\): presentationId "L01:base" repeats slot 4; adjacent slots must not show the identical presentation\.$/,
    );
    await expect(plan(directors(coverage(), editor({}, { 1: ["S00:detail-right"], 2: ["S00:detail-right"] })))).rejects.toThrow(/^Invalid edit plan: short slot 2 .*repeats slot 1;/);
    // The same pick with another slot between them is a legal callback.
    const plans = await plan(directors(coverage([{}, graphicAsset]), editor({ 4: ["L01:base"], 6: ["L01:base"] })));
    expect([plans.long[4].assetId, plans.long[5].assetId, plans.long[6].assetId]).toEqual(["L01", "L00", "L01"]);
  });

  test("the Editor schema only allows listed presentation ids, per film", () => {
    const schema = editorSchema({ long: pres, short: buildPresentations(validateCoverage("short", [asset(archiveAsset)])) }) as any;
    const long = schema.properties.long.items;
    expect([...long.required].sort()).toEqual(["motionPriority", "presentationId", "slotId"]);
    expect(Object.keys(long.properties).sort()).toEqual([...long.required].sort());
    expect(long.properties.presentationId.enum).toEqual(["L00:base", "L00:detail-center", "L00:detail-right", "L01:base"]);
    expect(schema.properties.short.items.properties.presentationId.enum).toEqual(["S00:base"]);
    expect(long.properties.motionPriority.enum).toEqual([0, 1, 2, 3]);
    for (const gone of ["edit", "framing", "truth", "startSec", "durationSec", "sourceSlotId", "wantsMotion"]) expect(long.properties[gone]).toBeUndefined();
  });

  test("the Editor sees the validated library with every legal presentation", async () => {
    const narr = await narration();
    let input: EditorInput | undefined;
    await planVisuals(story, paulBunyanResearch, paulBunyanScripts, narr, directors(coverage([{}, graphicAsset], [archiveAsset, {}]), async (i) => ((input = i), editor()(i))));
    expect(input!.library.long.map((x) => x.id)).toEqual(["L00", "L01"]);
    expect(input!.presentations.long.map((p) => p.id)).toEqual(["L00:base", "L00:detail-center", "L00:detail-right", "L01:base"]);
    const payload = editorPayload(input!);
    expect(payload).toContain("ASSET L00 - reconstruction, motion-capable: Show the felled poplar tree beside the bridge.");
    expect(payload).toContain("  shows: felled poplar tree (center); UN engineers (right)");
    expect(payload).toContain("  L00:detail-right - crop on UN engineers");
    expect(payload).toContain("  L01:base - graphic, wide: Show where the tree stood relative to the bridge.");
    expect(payload).toContain("ASSET S00 - archive: Show the real site in 1976.");
    expect(payload).toContain("LONG MEDIA LIBRARY (2 assets, 4 legal presentations):");
  });
});

// ---------------------------------------------------------------------------
describe("local motion budget", () => {
  const lib = (specs: AssetSpec[], kind: "long" | "short" = "long") => {
    const assets = validateCoverage(kind, specs.map(asset));
    return { assets, pres: buildPresentations(assets) };
  };
  const a = (slotId: number, presentationId: string, motionPriority: number) => ({ slotId, presentationId, motionPriority });

  test("only a base presentation of a motion-capable reconstruction on a slot of 5s or less is eligible", () => {
    const slots = slotsOf("long", [4, 4, 4, 4, 4, 6, 4, 4]);
    const { assets, pres } = lib([{}, archiveAsset, graphicAsset, { motionCapable: false }, {}, {}, {}]);
    const edit = [
      a(0, "L00:base", 2), // eligible
      a(1, "L00:detail-center", 3), // detail: never moves
      a(2, "L01:base", 3), // archive: never moves
      a(3, "L02:base", 3), // graphic: never moves
      a(4, "L03:base", 3), // not motion-capable
      a(5, "L04:base", 3), // 6s slot: longer than the clip
      a(6, "L05:base", 0), // priority 0: no motion wanted
      a(7, "L06:base", 1), // eligible
    ];
    expect(slots[5].motionAllowed).toBe(false);
    expect(selectMotion("long", slots, edit, pres, assets)).toEqual({ candidates: [0, 7], selected: [0, 7] });
  });

  test("at most 5 clips in the Long and 3 in the Short, 8 in total", () => {
    expect(MOTION_BUDGET).toEqual({ long: 5, short: 3 });
    const long = lib(Array.from({ length: 8 }, () => ({})));
    const slots = slotsOf("long", Array(8).fill(4));
    const edit = slots.map((s) => a(s.id, `L0${s.id}:base`, 1));
    const m = selectMotion("long", slots, edit, long.pres, long.assets);
    expect(m.candidates).toHaveLength(8);
    expect(m.selected).toEqual([0, 1, 2, 3, 4]);
    const short = lib(Array.from({ length: 6 }, () => ({})), "short");
    const sslots = slotsOf("short", Array(6).fill(3));
    expect(selectMotion("short", sslots, sslots.map((s) => a(s.id, `S0${s.id}:base`, 2)), short.pres, short.assets).selected).toEqual([0, 1, 2]);
  });

  test("highest priority first, then the earlier slot, deterministically", () => {
    const { assets, pres } = lib(Array.from({ length: 8 }, () => ({})));
    const slots = slotsOf("long", Array(8).fill(4));
    const prio = [1, 3, 2, 3, 1, 2, 3, 2];
    const edit = slots.map((s) => a(s.id, `L0${s.id}:base`, prio[s.id]));
    // 3s: slots 1, 3, 6; then 2s: slots 2, 5 (7 loses the tie on slot order).
    expect(selectMotion("long", slots, edit, pres, assets).selected).toEqual([1, 2, 3, 5, 6]);
    expect(selectMotion("long", slots, [...edit].reverse(), pres, assets).selected).toEqual([1, 2, 3, 5, 6]);
  });

  test("only one Runway clip per underlying asset", () => {
    const { assets, pres } = lib([{}, {}]);
    const slots = slotsOf("long", [4, 4, 4, 4]);
    const edit = [a(0, "L00:base", 1), a(1, "L00:base", 3), a(2, "L00:base", 3), a(3, "L01:base", 1)];
    expect(selectMotion("long", slots, edit, pres, assets)).toEqual({ candidates: [0, 1, 2, 3], selected: [1, 3] });
  });

  test("the selected slot owns the asset and carries its clip; every other use shows the still", () => {
    const { assets, pres } = lib([{}]);
    const slots = slotsOf("long", [4, 4, 4]);
    const edit = [a(0, "L00:detail-center", 0), a(1, "L00:base", 2), a(2, "L00:detail-right", 0)];
    const shots = assembleEdit("long", slots, edit, pres, assets, selectMotion("long", slots, edit, pres, assets), story, paulBunyanResearch);
    expect(shots.map((s) => [s.edit, s.assetShot, s.wantsMotion, s.framing])).toEqual([
      ["reuse", 1, false, "detail-center"],
      ["new", undefined, true, "wide"],
      ["reuse", 1, false, "detail-right"],
    ]);
    expect(shots[1]).toMatchObject({ motion: "push", motionPriority: 2, motionCandidate: true });
    expect(shots[0]).toMatchObject({ motion: "hold", focus: "felled poplar tree" });
    expect(() => assertFilmGrammarPlan("long", shots)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
describe("reuse: each used asset is acquired once", () => {
  test("the same asset used repeatedly is owned by one slot; every other use reuses its still", async () => {
    const narr = await narration();
    const plans = await planVisuals(story, paulBunyanResearch, paulBunyanScripts, narr, directors(coverage([{}, graphicAsset]), editor({ 1: ["L00:detail-center"], 2: ["L01:base"], 3: ["L00:detail-right"] })));
    const long = plans.long;
    const owners = long.filter((s) => s.edit === "new");
    expect(owners.map((s) => [s.index, s.assetId])).toEqual([[0, "L00"], [2, "L01"]]);
    for (const s of long.filter((x) => x.edit === "reuse")) expect(long[s.assetShot!]).toMatchObject({ edit: "new", assetId: s.assetId });
    expect(long[1]).toMatchObject({ edit: "reuse", assetId: "L00", presentation: "detail-center", framing: "detail-center", focus: "felled poplar tree", assetShot: 0 });
    await acquireAll("long", long);
    expect(long[1].path).toBe(long[0].path); // a detail costs nothing: the owner's still
    expect(long[3].path).toBe(long[0].path);
    expect(long.at(-1)!.path).toBe(long[0].path); // repeated base presentation: the same still again
    expect(new Set(long.map((s) => s.path)).size).toBe(2);
  });

  test("an unused coverage asset is never planned for acquisition", async () => {
    const plans = await plan(directors(coverage([{}, { purpose: "An unused asset." }, graphicAsset]), editor({ 2: ["L02:base"] })));
    expect(plans.long.some((s) => s.assetId === "L01")).toBe(false);
    expect(plans.long.filter((s) => s.edit === "new").map((s) => s.assetId)).toEqual(["L00", "L02"]);
  });

  test("acquisition refuses a reuse slot, and a reuse whose owner has no still fails clearly instead of generating", async () => {
    const plans = await plan(directors(coverage(), editor({ 1: ["L00:detail-center"] })));
    await expect(acquireStill(story, "long", plans.long[1], null)).rejects.toThrow(/long slot 1 reuses asset L00 and never acquires its own still/);
    const owner = { ...plans.long[0], motionPath: "motion/long-00.mp4", path: undefined };
    expect(() => resolveReuse(story, "long", [owner, plans.long[1]])).toThrow(/owner has no still image/);
    expect(() => resolveReuse(story, "long", [{ ...owner, path: "motion/long-00.mp4" }, plans.long[1]])).toThrow(/no still image/);
    expect(() => resolveReuse(story, "long", [{ ...owner, path: "images/missing.png" }, plans.long[1]])).toThrow(/missing/);
  });

  test("a reuse never plays the owner's motion clip, only its still", async () => {
    const narr = await narration();
    const plans = await planVisuals(story, paulBunyanResearch, paulBunyanScripts, narr, directors(coverage(), editor({ 1: ["L00:base", 3], 3: ["L00:detail-center"] })));
    const long = plans.long;
    expect(long[1]).toMatchObject({ edit: "new", wantsMotion: true });
    expect(long[0]).toMatchObject({ edit: "reuse", assetShot: 1 }); // the motion slot owns the asset
    await acquireAll("long", long);
    long[1].motionPath = "motion/long-01.mp4";
    long[1].mediaType = "video";
    writeFileSync(inStory(story.slug, "motion/long-01.mp4"), "clip");
    resolveReuse(story, "long", long);
    const render = buildRenderPlan("long", story, long, narr.long, "#d9a066");
    expect(render.shots[1]).toMatchObject({ mediaType: "video", path: "motion/long-01.mp4" });
    expect(render.shots[3]).toMatchObject({ mediaType: "image", path: "images/long-01.png", framing: "detail-center" });
    expect(render.shots[0]).toMatchObject({ mediaType: "image", path: "images/long-01.png" });
  });

  test("the preview names each slot's asset and presentation, marks motion and counts reuse", async () => {
    const narr = await narration();
    const plans = await planVisuals(story, paulBunyanResearch, paulBunyanScripts, narr, directors(coverage([{}, graphicAsset]), editor({ 1: ["L00:base", 2], 2: ["L01:base"], 3: ["L00:detail-right"] })));
    await acquireAll("long", plans.long);
    await acquireAll("short", plans.short);
    const p = buildPreview(story, plans.long, plans.short);
    const frames = p.frames.filter((f) => f.kind === "long");
    expect(frames.length).toBe(plans.long.length); // one frame per slot
    expect(frames[3]).toMatchObject({ asset: "L00", presentation: "detail-right", focus: "UN engineers", edit: "reuse", path: frames[1].path });
    expect(frames[1]).toMatchObject({ asset: "L00", presentation: "base", motion: true, edit: "new", startBeat: 2, endBeat: 2 });
    expect(p).toMatchObject({ moments: plans.long.length + plans.short.length, uniqueAssets: 3, reusedPresentations: plans.long.length + plans.short.length - 3 });
    expect(p).toMatchObject({ reconstruction: 2, graphic: 1, archive: 0, motionSelected: 1, remainingMotionCost: 0 });
    expect(p.motionCandidates).toBeGreaterThanOrEqual(1);
    const ui = readFileSync(path.join(__dirname, "..", "src", "app", "previewFrames.tsx"), "utf8");
    expect(ui).toMatch(/asset: \{f\.asset\}/);
    expect(ui).toMatch(/presentation: \{f\.presentation\}/);
    expect(ui).toMatch(/motion selected/);
    expect(ui).not.toMatch(/reframe of slot|reframeOf/);
  });
});

// ---------------------------------------------------------------------------
describe("pipeline: two planning calls, timing only from the slots", () => {
  test("PlannedShot timing, words and index come from its EditSlot, and the render has one shot per slot", async () => {
    const narr = await narration();
    const plans = await planVisuals(story, paulBunyanResearch, paulBunyanScripts, narr, directors(coverage([{}, graphicAsset]), editor({ 3: ["L00:detail-center"], 4: ["L01:base"], 6: ["L00:base", 2] })));
    for (const kind of ["long", "short"] as const) {
      const slots = planSlots(kind, paulBunyanScripts[kind], narr[kind]);
      expect(plans[kind]).toHaveLength(slots.length);
      plans[kind].forEach((s, i) => {
        const slot = slots[i];
        expect(s).toMatchObject({ index: slot.id, startBeat: slot.startBeatId, endBeat: slot.endBeatId, startSec: slot.startSec, endSec: slot.endSec, wordStart: slot.wordStart, wordEnd: slot.wordEnd });
      });
      await acquireAll(kind, plans[kind]);
      const render = buildRenderPlan(kind, story, plans[kind], narr[kind], "#d9a066");
      expect(render.shots).toHaveLength(slots.length); // the renderer invents no cuts
      render.shots.forEach((r, i) => i > 0 && expect(r.startFrame).toBe(Math.round(slots[i].startSec * FPS)));
    }
  });

  test("the Editor cannot affect timing: timing-like fields in an assignment are ignored", async () => {
    const plain = await plan();
    const meddling = await plan(
      directors(coverage(), async (input) => {
        const e = await editor()(input);
        return {
          long: e.long.map((x) => ({ ...x, startSec: 99, endSec: 100, durationSec: 1, wordStart: 7, wordEnd: 8, index: 40, edit: "new", framing: "detail-left" })),
          short: e.short.map((x) => ({ ...x, durationSec: 30 })),
        };
      }),
    );
    expect(meddling).toEqual(plain);
  });

  test("a Coverage failure stops before the Editor is ever called", async () => {
    let editorCalls = 0;
    const spy = async (i: EditorInput) => (editorCalls++, editor()(i));
    const run = plan(directors(coverage([{ truth: "archive", archiveQuery: "" }]), spy));
    await expect(run).rejects.toBeInstanceOf(VisualPlanError);
    await expect(run).rejects.toThrow(/^Invalid coverage plan: long has no valid candidates \(1 proposed, all rejected: #0 is archive but has no archiveQuery\)\.$/);
    await expect(plan(directors(async () => ({ longAssets: [asset()] }) as never, spy))).rejects.toThrow(/shortAssets is missing or empty/);
    expect(editorCalls).toBe(0);
  });

  test("one invalid candidate does not kill Coverage: it is discarded and recorded, the Editor sees only the valid library", async () => {
    let input: EditorInput | undefined;
    const bad = { purpose: "A rejected candidate.", mustShow: [{ description: "Swedish naval or coast guard vessel", region: "right" as const }] };
    const plans = await plan(directors(coverage([{}, bad, graphicAsset], [bad, {}]), async (i) => ((input = i), editor({ 1: ["L01:base"] })(i))));
    expect(plans.coverageRejected).toEqual([
      { film: "long", index: 1, reason: 'mustShow[0] "Swedish naval or coast guard vessel" is an either/or element; each element must be one concrete visible thing' },
      { film: "short", index: 0, reason: 'mustShow[0] "Swedish naval or coast guard vessel" is an either/or element; each element must be one concrete visible thing' },
    ]);
    expect(input!.library.long.map((a) => [a.id, a.truth])).toEqual([["L00", "reconstruction"], ["L01", "graphic"]]);
    expect(input!.library.short.map((a) => a.id)).toEqual(["S00"]);
    // Rejected candidates create no presentations and never reach the Editor.
    expect(input!.presentations.long).toEqual(buildPresentations(input!.library.long));
    expect(input!.presentations.short.map((p) => p.id)).toEqual(["S00:base", "S00:detail-center", "S00:detail-right"]);
    expect(editorPayload(input!)).not.toContain("A rejected candidate.");
    expect(editorPayload(input!)).not.toContain("coast guard");
    // Nothing planned (so nothing acquired or charged) comes from a rejected candidate.
    for (const s of [...plans.long, ...plans.short]) expect(s.purpose).not.toBe("A rejected candidate.");
    expect(plans.long[1]).toMatchObject({ assetId: "L01", truth: "graphic" });
    expect((await plan(directors(coverage([{}, graphicAsset]), editor({ 1: ["L01:base"] })))).coverageRejected).toEqual([]);
  });

  test("a rejected candidate cannot receive motion, and the Editor stays strict about its would-be id", async () => {
    const movingBad = { mustShow: [{ description: "tug or support vessel", region: "center" as const }], motionCapable: true };
    // The rejected motion-capable reconstruction was raw item 0; L00-L02 are now graphics, which never move.
    const plans = await plan(directors(coverage([movingBad, graphicAsset, graphicAsset, graphicAsset]), editor({ 1: ["L00:base"], 6: ["L00:base"] })));
    expect(plans.long.every((s) => !s.wantsMotion && !s.motionCandidate)).toBe(true);
    expect(plans.long.every((s) => s.truth === "graphic")).toBe(true);
    // A priority on the graphic that took its place is itself an Editor failure.
    const moving = plan(directors(coverage([movingBad, graphicAsset, graphicAsset, graphicAsset]), editor({ 1: ["L00:base", 3] })));
    await expect(moving).rejects.toThrow(/^Invalid edit plan: long slot 1 \(beats 2-2, [\d.]+s\): motionPriority 3 on "L00:base", which is not motion eligible; its priority must be 0\.$/);
    // Naming a presentation that only a rejected candidate would have had is an Editor failure, never repaired.
    const run = plan(directors(coverage([movingBad, graphicAsset, graphicAsset, graphicAsset]), editor({ 1: ["L03:base", 3] })));
    await expect(run).rejects.toThrow(/^Invalid edit plan: long slot 1 \(beats 2-2, [\d.]+s\): presentationId "L03:base" is not a legal long presentation\.$/);
  });

  test("zero valid Long or Short candidates, or a malformed Coverage answer, fails before the Editor", async () => {
    let editorCalls = 0;
    const spy = async (i: EditorInput) => (editorCalls++, editor()(i));
    const orEl = { mustShow: [{ description: "gamma/uranium highlight", region: "center" as const }] };
    await expect(plan(directors(coverage([orEl, { purpose: "" }]), spy))).rejects.toThrow(/^Invalid coverage plan: long has no valid candidates \(2 proposed/);
    await expect(plan(directors(coverage([{}], [orEl]), spy))).rejects.toThrow(/^Invalid coverage plan: short has no valid candidates \(1 proposed, all rejected: #0 mustShow\[0\] "gamma\/uranium highlight"/);
    for (const answer of [null, [], "longAssets", 7]) {
      await expect(plan(directors(async () => answer as never, spy))).rejects.toThrow(/^Invalid coverage plan: the answer is not a \{ "longAssets", "shortAssets" \} object\.$/);
    }
    await expect(plan(directors(async () => ({ longAssets: { a: 1 }, shortAssets: [asset()] }) as never, spy))).rejects.toThrow(/^Invalid coverage plan: longAssets is missing or empty/);
    await expect(plan(directors(async () => ({ longAssets: [asset()] }) as never, spy))).rejects.toThrow(/^Invalid coverage plan: shortAssets is missing or empty/);
    expect(editorCalls).toBe(0);
  });

  test("an Editor failure is a VisualPlanError, raised before anything is assembled", async () => {
    const run = plan(directors(coverage(), editor({ 2: ["L00:detail-left"] })));
    await expect(run).rejects.toBeInstanceOf(VisualPlanError);
    await expect(run).rejects.toThrow(/^Invalid edit plan: long slot 2 \(beats 3-3, [\d.]+s\): presentationId "L00:detail-left" is not a legal long presentation\.$/);
    const short = plan(directors(coverage(), async (input) => ({ ...(await editor()(input)), short: [] })));
    await expect(short).rejects.toThrow(/^Invalid edit plan: short has no slot assignments/);
  });

  test("the paid-call hooks run once per planning call, even when an answer then fails validation", async () => {
    const narr = await narration();
    const log: string[] = [];
    const hooks = { before: () => log.push("before"), after: () => log.push("after") };
    await planVisuals(story, paulBunyanResearch, paulBunyanScripts, narr, directors(), hooks);
    expect(log).toEqual(["before", "after", "before", "after"]);
    log.length = 0;
    await expect(planVisuals(story, paulBunyanResearch, paulBunyanScripts, narr, directors(coverage([{ mustShow: [] }])), hooks)).rejects.toThrow(/coverage/);
    expect(log).toEqual(["before", "after"]); // the Editor never ran
  });

  test("the mock fallback planners always produce a valid edit with reuse, details, a graphic and budgeted motion", async () => {
    const narr = await narration();
    const plans = await planVisuals(story, paulBunyanResearch, paulBunyanScripts, narr);
    for (const kind of ["long", "short"] as const) {
      const slots = planSlots(kind, paulBunyanScripts[kind], narr[kind]);
      expect(plans[kind]).toHaveLength(slots.length);
      expect(() => assertFilmGrammarPlan(kind, plans[kind])).not.toThrow();
      const moving = plans[kind].filter((s) => s.wantsMotion);
      expect(moving.length).toBeLessThanOrEqual(MOTION_BUDGET[kind]);
      for (const s of moving) expect(slots[s.index].motionAllowed && s.presentation === "base" && s.truth === "reconstruction").toBe(true);
      expect(new Set(moving.map((s) => s.assetId)).size).toBe(moving.length);
    }
    expect(plans.long.some((s) => s.edit === "reuse")).toBe(true);
    expect(plans.long.some((s) => s.presentation.startsWith("detail-"))).toBe(true);
    expect(plans.long.some((s) => s.truth === "graphic")).toBe(true);
    expect(plans.long.some((s) => s.wantsMotion)).toBe(true);
    expect(plans.long.at(-1)!.assetId).toBe("L00"); // the closing callback
  });

  test("every video slot fits inside its clip, so no timeline relies on a frozen last frame", async () => {
    const narr = await narration();
    const plans = await planVisuals(story, paulBunyanResearch, paulBunyanScripts, narr);
    for (const kind of ["long", "short"] as const) {
      const shots = plans[kind];
      await acquireAll(kind, shots);
      for (const s of shots) if (s.wantsMotion) s.motionPath = `motion/${kind}-${String(s.index).padStart(2, "0")}.mp4`;
      const render = buildRenderPlan(kind, story, shots, narr[kind], "#d9a066");
      expect(render.shots).toHaveLength(shots.length);
      for (const s of render.shots.filter((x) => x.mediaType === "video")) expect(s.endFrame - s.startFrame).toBeLessThanOrEqual(MOTION_CLIP_SECONDS * FPS);
    }
  });

  test("each reconstruction prompt pins its mustShow elements to their regions, so the crops land on them", async () => {
    const plans = await plan(directors(coverage([{ mustShow: [{ description: "patrol vessel", region: "left" }, { description: "open sea", region: "whole" }] }])));
    expect(plans.long[0].prompt).toMatch(/Must show: patrol vessel \(in the left third of the frame\); open sea \(across the frame\)\./);
    expect(plans.long[0].mustShow).toEqual(["patrol vessel", "open sea"]);
  });
});

// ---------------------------------------------------------------------------
describe("render: the slot grid owns cuts, stills are full-bleed", () => {
  const still = (over: Partial<PlannedShot>): PlannedShot => ({
    index: 0, edit: "new", assetId: "L00", presentation: "base", framing: "wide", startSec: 0, endSec: 1, truth: "reconstruction", motion: "hold", wantsMotion: false,
    prompt: "p", purpose: "x", mustShow: [], mustNotShow: [], wordStart: 0, wordEnd: 1, path: "images/long-00.png", mediaType: "image", ...over,
  });
  const narr20 = { audioRel: "audio/long.mp3", audioMediaRel: "", durationSec: 20, words: [{ word: "w", start: 0, end: 19.6 }] } as Narration;

  test("MAX_HOLD artificial recutting is gone: a 20s still is one render shot", () => {
    const plan = buildRenderPlan("long", story, [still({ endSec: 20.5 })], narr20, "#d9a066");
    expect(plan.shots).toHaveLength(1);
    expect(plan.shots[0]).toMatchObject({ id: "long-00", startFrame: 0, endFrame: plan.durationInFrames, motion: "hold" });
  });

  test("render shots follow the slots' own screen times and presentation framing", () => {
    const shots = [still({ endSec: 3.2 }), still({ index: 1, edit: "reuse", assetShot: 0, presentation: "detail-center", startSec: 3.2, endSec: 20.5, framing: "detail-center" })];
    const plan = buildRenderPlan("long", story, shots, narr20, "#d9a066");
    expect(plan.shots.map((s) => [s.startFrame, s.endFrame])).toEqual([[0, Math.round(3.2 * FPS)], [Math.round(3.2 * FPS), plan.durationInFrames]]);
    expect(plan.shots[1].framing).toBe("detail-center");
  });

  test("a v1 shot list or a v2D per-slot plan is refused with a clear rebuild message", () => {
    const v1 = [{ index: 0, truth: "reconstruction", motion: "hold", wantsMotion: false, prompt: "p", purpose: "x", mustShow: [], mustNotShow: [], wordStart: 0, wordEnd: 1, path: "images/long-00.png" }] as any;
    expect(() => assertFilmGrammarPlan("long", v1)).toThrow(/Rebuild the visuals/);
    expect(() => buildRenderPlan("long", story, v1, narr20, "#d9a066")).toThrow(/Film Grammar v2E/);
    const v2d = [{ ...still({}), assetId: undefined, presentation: undefined }, { ...still({ index: 1 }), edit: "reframe", assetShot: 0, assetId: undefined, presentation: undefined }] as any;
    expect(() => assertFilmGrammarPlan("long", v2d)).toThrow(/slot 0 has no media asset/);
    expect(() => assertFilmGrammarPlan("long", [still({}), still({ index: 1 })])).toThrow(/asset L00 has two owning slots/);
    expect(() => assertFilmGrammarPlan("long", [still({}), still({ index: 1, edit: "reuse", assetId: "L01", assetShot: 0 })])).toThrow(/slot 1 reuses L01 without its owning slot/);
  });

  const shot = (over: Partial<Shot> = {}): Shot => ({ id: "long-00", startFrame: 0, endFrame: 90, mediaType: "image", path: "img.png", truth: "reconstruction", motion: "hold", ...over });

  test("Long stills render full-bleed: cover, no blurred duplicate, no floating shadow", () => {
    const style = stillStyle(shot(), 10, 90, "long");
    expect(style).toMatchObject({ width: "100%", height: "100%", objectFit: "cover" });
    expect(String(style.filter)).not.toMatch(/blur/);
    expect(style.boxShadow).toBeUndefined();
    const src = readFileSync(path.join(__dirname, "..", "src", "render", "Shot.tsx"), "utf8");
    expect(src).not.toMatch(/blur\(/);
    expect(src).not.toMatch(/boxShadow/);
    expect(src).not.toMatch(/objectFit: "contain"/);
  });

  test("framing changes crop and scale deterministically and never exposes an edge", () => {
    const at = (framing: Shot["framing"]) => stillStyle(shot({ framing }), 0, 90, "long");
    expect(at("wide")).toEqual(at("wide")); // deterministic
    const transforms = (["wide", "medium", "detail-left", "detail-center", "detail-right"] as const).map((f) => `${at(f).transform} @ ${at(f).transformOrigin}`);
    expect(new Set(transforms).size).toBe(5); // every framing is a distinct crop
    expect(framingTransform("wide").scale).toBe(1);
    expect(framingTransform("medium").scale).toBeGreaterThan(1);
    expect(framingTransform("detail-left").scale).toBeGreaterThan(framingTransform("medium").scale);
    expect(framingTransform("detail-left").originX).toBeLessThan(50);
    expect(framingTransform("detail-right").originX).toBeGreaterThan(50);
    for (const f of ["wide", "medium", "detail-left", "detail-center", "detail-right"] as const) {
      const t = framingTransform(f);
      expect(t.scale).toBeGreaterThanOrEqual(1); // scaling up about an inner origin keeps the frame covered
      expect(t.scale).toBeLessThanOrEqual(1.6); // restrained
    }
  });

  test("Short stays native portrait and full-frame", async () => {
    const style = stillStyle(shot({ framing: "medium", motion: "push" }), 10, 90, "short");
    expect(style).toMatchObject({ width: "100%", height: "100%", objectFit: "cover" });
    const narr = await narration();
    const plans = await planVisuals(story, paulBunyanResearch, paulBunyanScripts, narr);
    await acquireAll("short", plans.short);
    const plan = buildRenderPlan("short", story, plans.short, narr.short, "#d9a066");
    expect([plan.width, plan.height]).toEqual([1080, 1920]);
  });
});

// ---------------------------------------------------------------------------
describe("instructions: coverage director and editor", () => {
  test("the Coverage Director only proposes media; it assigns nothing to slots", () => {
    expect(COVERAGE_INSTRUCTIONS).toMatch(/Your only question is: "What useful documentary media should exist for this film\?"/);
    expect(COVERAGE_INSTRUCTIONS).toMatch(/You assign nothing to slots: no slot ids, no timing, no order of use, no crops/);
    expect(COVERAGE_INSTRUCTIONS).toMatch(/A LIBRARY, NOT A QUOTA/);
    expect(COVERAGE_INSTRUCTIONS).toMatch(/Do not create one asset per slot/);
    expect(COVERAGE_INSTRUCTIONS).toMatch(/"longAssets" and "shortAssets"/);
  });

  test("mustShow describes actual visible content, with regions, and no either/or elements", () => {
    expect(COVERAGE_INSTRUCTIONS).toMatch(/MUSTSHOW MUST DESCRIBE ACTUAL VISIBLE CONTENT - every mustShow element is ONE concrete, physically visible, atomic thing that is present in this exact frame/);
    expect(COVERAGE_INSTRUCTIONS).toMatch(/GOOD: "grounded Soviet submarine", "exposed rocks beneath hull", "Swedish patrol vessel"/);
    expect(COVERAGE_INSTRUCTIONS).toMatch(/BAD: "proximity to naval base", "Cold War tension", "Swedish response", "autumn environment", "skeptical expressions", "signage or buoys"/);
    expect(COVERAGE_INSTRUCTIONS).toMatch(/EXACTLY ONE THING PER ELEMENT - never offer alternatives: no "or", no "\/", no "either", no "and\/or"/);
    expect(COVERAGE_INSTRUCTIONS).toMatch(/never invent a more specific detail just to avoid an alternative/);
    expect(COVERAGE_INSTRUCTIONS).toMatch(/An element that offers alternatives discards the WHOLE asset/);
    expect(COVERAGE_INSTRUCTIONS).toMatch(/Usually 1-3 elements, never more than 4/);
    expect(COVERAGE_INSTRUCTIONS).toMatch(/PastBriefly derives legal detail crops from these elements/);
    expect(COVERAGE_INSTRUCTIONS).toMatch(/"whole" \(an element that spans the frame\) gives no crop/);
    expect(COVERAGE_INSTRUCTIONS).toMatch(/graphics are never cropped/);
  });

  test("factual, one-frame and readable-text rules are kept and strengthened", () => {
    expect(COVERAGE_INSTRUCTIONS).toMatch(/FACTUAL GROUNDING \(HARD FACTUAL VISUAL RULE\)/);
    expect(COVERAGE_INSTRUCTIONS).toMatch(/PLAUSIBLE IS NOT SUPPORTED/);
    expect(COVERAGE_INSTRUCTIONS).toMatch(
      /do NOT invent event-specific meetings, rooms or interiors, phone calls, handshakes, flags, insignia, signs, hazard markers, military equipment, cranes, sonar equipment, crowds, press conferences, documents, readable labels/,
    );
    expect(COVERAGE_INSTRUCTIONS).toMatch(/ONE ASSET = ONE FRAME/);
    expect(COVERAGE_INSTRUCTIONS).toMatch(/a collage, a montage, an inset, a split screen, a split-focus showing two different actions at once, separate moments, a before\/after, "in the next moment"/);
    expect(COVERAGE_INSTRUCTIONS).toMatch(/NO INVENTED READABLE TEXT - a generated reconstruction must never depend on readable historical text/);
    expect(COVERAGE_INSTRUCTIONS).toMatch(/ARCHIVE FALLBACK MUST NOT FAKE HISTORY/);
    expect(COVERAGE_INSTRUCTIONS).toMatch(/archiveQuery: for archive, a specific event query that targets the REAL historical media/);
    expect(COVERAGE_INSTRUCTIONS).toMatch(/That prompt describes a historical editorial RECONSTRUCTION of the physical scene, never the archive item itself: it must NOT ask for a photograph, a news photo, an archival image or a historical photograph/);
    expect(COVERAGE_INSTRUCTIONS).toMatch(/Do not dramatize negations or limitations/);
  });

  test("archive: specific real subjects, no quota, and zero archive is not automatic", () => {
    expect(COVERAGE_INSTRUCTIONS).toMatch(/when a specific real historical person, vessel, event, photograph, document, newspaper or film plausibly exists and directly supports the story/);
    expect(COVERAGE_INSTRUCTIONS).toMatch(/There is no archive quota and never choose archive merely for variety - but when direct historical subjects clearly exist, zero archive is not the automatic answer/);
    expect(COVERAGE_INSTRUCTIONS).toMatch(/never generic like "Sweden 1981"/);
  });

  test("the Editor only picks listed presentations and returns no timing, crops or assets", () => {
    expect(EDITOR_INSTRUCTIONS).toMatch(/"What legal piece of available media should appear in this fixed slot\?"/);
    expect(EDITOR_INSTRUCTIONS).toMatch(/You do NOT create assets, create crops, alter timing, choose cuts or estimate cost/);
    expect(EDITOR_INSTRUCTIONS).toMatch(/no missing slot, no duplicate slot, no unknown slot, and no presentation that is not listed/);
    expect(EDITOR_INSTRUCTIONS).toMatch(/reusing an asset, in any presentation, costs nothing/);
    expect(EDITOR_INSTRUCTIONS).toMatch(/A detail shows only the elements it lists/);
  });

  test("the Editor keeps the editorial guidance: sequences, repetition, overuse, callbacks, ending", () => {
    expect(EDITOR_INSTRUCTIONS).toMatch(/SEQUENCES - you see the whole timeline: edit it as small sequences, not as isolated slot islands\. Think in mini-sequences of roughly 20-40 seconds/);
    expect(EDITOR_INSTRUCTIONS).toMatch(/establish -> detail -> person\/evidence -> escalation -> payoff/);
    expect(EDITOR_INSTRUCTIONS).toMatch(/Avoid three consecutive slots dominated by the same primary subject at a similar scale/);
    expect(EDITOR_INSTRUCTIONS).toMatch(/reuse is a tool for detail and callbacks, not a way to avoid variety/);
    expect(EDITOR_INSTRUCTIONS).toMatch(/Give each film a deliberate ending/);
    expect(EDITOR_INSTRUCTIONS).toMatch(/ABSTRACT NARRATION/);
  });

  test("motion priority is only a request: PB4 applies the budget and eligibility", () => {
    expect(EDITOR_INSTRUCTIONS).toMatch(/MOTION PRIORITY - 0 none, 1 useful, 2 strong, 3 standout\. PastBriefly chooses the actual motion itself/);
    expect(EDITOR_INSTRUCTIONS).toMatch(/at most 5 clips in the Long and 3 in the Short; at most one clip per asset; highest priority first, earlier slots winning ties/);
    expect(EDITOR_INSTRUCTIONS).toMatch(/Most slots are 0/);
  });

  // v2F creative hardening: guidance only, never a semantic validator.
  test("Coverage: no unsupported event-specific detail; one frame = one action", () => {
    expect(COVERAGE_INSTRUCTIONS).toMatch(/NO UNSUPPORTED EVENT-SPECIFIC DETAIL: a reconstruction may depict only event-specific details supported by the verified facts, the research moments or the audited narration/);
    expect(COVERAGE_INSTRUCTIONS).toMatch(
      /Never invent a specific operations room, conference room, interrogation room, phone-call scene, meeting, handshake, salvage equipment, tug, crane, sonar equipment, patrol zone, military installation, flag, insignia, boundary marker or warning sign unless it is supported/,
    );
    expect(COVERAGE_INSTRUCTIONS).toMatch(/prefer another supported physical detail, real archive, geography or an already-supported recurring subject: do not stage a fictional event/);
    expect(COVERAGE_INSTRUCTIONS).toMatch(/Never action A plus action B in one frame \(BAD: "an officer examines equipment while another questions the captain"\), never the current event plus the next event/);
    expect(COVERAGE_INSTRUCTIONS).toMatch(/You are providing SEVERAL pieces of coverage[^.]*never cram the narration into one image/);
  });

  test("Coverage: mustShow is concrete factual content, never mood; crop-safe", () => {
    expect(COVERAGE_INSTRUCTIONS).toMatch(/MUSTSHOW IS FACTUAL CONTENT, NOT MOOD: never an expression, emotion, lighting, time of day, season, weather or atmosphere/);
    expect(COVERAGE_INSTRUCTIONS).toMatch(/"skeptical expression", "anxious expression", "tension", "concern", "suspicion", "autumn atmosphere", "early morning light", "dramatic weather"/);
    expect(COVERAGE_INSTRUCTIONS).toMatch(/Lighting or mood may appear in the prompt where appropriate, never as a mustShow element/);
    expect(COVERAGE_INSTRUCTIONS).toMatch(/Every element must be crop-safe: one concrete visible object, person or place feature/);
  });

  test("Coverage: no generated readable text; graphics carry only supported information", () => {
    expect(COVERAGE_INSTRUCTIONS).toMatch(/Never ask image generation for hull numbers, signs, map labels, document text, instrument readings, headlines, insignia text or captions unless the exact visible wording is explicitly verified AND necessary/);
    expect(COVERAGE_INSTRUCTIONS).toMatch(/A GRAPHIC communicates only supported information: never invent labelled sonar stations, patrol zones, detection nodes, military positions or routes/);
    expect(COVERAGE_INSTRUCTIONS).toMatch(/If generated text would be needed to make a graphic understandable, choose another visual instead/);
  });

  test("Coverage: master restraint and a compact Short coverage kit (guidance, not quotas)", () => {
    expect(COVERAGE_INSTRUCTIONS).toMatch(/- useMaster: see MASTER REFERENCE\./);
    expect(COVERAGE_INSTRUCTIONS).toMatch(/Set useMaster true only when THAT recurring subject is visibly present in this reconstruction\. Never merely because the asset belongs to the same event/);
    expect(COVERAGE_INSTRUCTIONS).toMatch(/never for an interior without the recurring subject, a people-only scene, an evidence or object-only shot, a graphic, archive or an unrelated environment/);
    expect(COVERAGE_INSTRUCTIONS).toMatch(/THE SHORT IS A COVERAGE KIT, NOT ONE IMAGE PER SLOT - [^.]*do not propose almost one unique asset per slot/);
    expect(COVERAGE_INSTRUCTIONS).toMatch(/roughly 7-10 useful unique assets for a ~50 second Short is usually enough when base and detail reuse can tell the story \(guidance, not a quota\)/);
    expect(COVERAGE_INSTRUCTIONS).toMatch(/never manufacture elements merely to create crops/);
  });

  test("Editor: sequences, reuse, same-subject variety, archive alignment, callbacks, no hidden holds", () => {
    expect(EDITOR_INSTRUCTIONS).toMatch(/establishing base -> supported detail -> different subject or evidence -> archive -> callback, rather than new asset -> new asset -> new asset -> new asset/);
    expect(EDITOR_INSTRUCTIONS).toMatch(/Reuse is desirable when it creates coverage, continuity, a callback or a scale change, but do not overuse one asset just because it has many presentations/);
    expect(EDITOR_INSTRUCTIONS).toMatch(/EVERY SLOT IS AN ACTUAL CUT - the exact same presentationId may NEVER appear in two adjacent slots[^.]*the whole plan is rejected\./);
    expect(EDITOR_INSTRUCTIONS).toMatch(/This applies equally to reconstruction, archive, graphic and detail presentations\./);
    expect(EDITOR_INSTRUCTIONS).toMatch(/cut away to another supported presentation and return to it later; do NOT fake a hold by repeating it/);
    expect(EDITOR_INSTRUCTIONS).toMatch(/BAD: slot 20 -> L07:base, slot 21 -> L07:base, slot 22 -> L07:base\. GOOD: slot 20 -> L07:base, slot 21 -> L04:detail-center, slot 22 -> L07:base/);
    expect(EDITOR_INSTRUCTIONS).toMatch(/Before returning JSON, explicitly check every adjacent pair: assignment\[n\]\.presentationId must not equal assignment\[n - 1\]\.presentationId/);
    expect(EDITOR_INSTRUCTIONS).toMatch(/The same presentation later, after other slots, is allowed/);
    expect(EDITOR_INSTRUCTIONS).not.toMatch(/unless the hold is deliberate/);
    expect(EDITOR_INSTRUCTIONS).toMatch(/Different presentation ids do not make a run varied/);
    expect(EDITOR_INSTRUCTIONS).toMatch(/supported reset where the narration allows: a person, an object or evidence, geography, archive, the environment or another action/);
    expect(EDITOR_INSTRUCTIONS).toMatch(/ARCHIVE MUST MATCH THE WORDS - an archive presentation must directly support the CURRENT slot's narration/);
    expect(EDITOR_INSTRUCTIONS).toMatch(/Do not place a related famous person or event merely because it belongs to the story/);
    expect(EDITOR_INSTRUCTIONS).toMatch(/when returning to an asset shortly after it appeared, prefer another of its legal presentations where that is meaningful; an exact earlier crop should return only when the repeated composition itself serves the story/);
  });

  test("Editor: motion priority only where motion is eligible; the local budget is unchanged", () => {
    expect(EDITOR_INSTRUCTIONS).toMatch(/A priority above 0 is useful ONLY when all three hold: the slot is 5s or shorter \("motion allowed: yes"\), the chosen presentation is the base of a motion-capable reconstruction, and visible physical movement would improve the shot/);
    expect(EDITOR_INSTRUCTIONS).toMatch(/Never give a priority, least of all 3, to a slot that cannot move/);
    expect(EDITOR_INSTRUCTIONS).toMatch(/if it says no, motionPriority MUST be 0, or the whole plan is rejected/);
    expect(MOTION_BUDGET).toEqual({ long: 5, short: 3 });
    expect(SLOT_MAX_SEC).toEqual({ long: 7, short: 6 });
    expect(MOTION_CLIP_SECONDS).toBe(5);
  });

  test("no reframe bookkeeping, event ranges or timing arithmetic in either prompt; plain hyphens only", () => {
    for (const text of [COVERAGE_INSTRUCTIONS, EDITOR_INSTRUCTIONS]) {
      expect(text).not.toMatch(/sourceSlotId|sourceElementIndex|startBeatId|endBeatId|LEGAL END RANGES|40-50|wantsMotion|"reframe"|"new"/);
      expect(text).not.toMatch(/U 137|U137/); // generic guidance, no story special case
      expect(text).not.toMatch(/[‒-―]/);
    }
  });
});
