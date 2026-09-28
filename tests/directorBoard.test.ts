import { describe, test, expect, vi } from "vitest";
import type { PreviewFrame, VisualPreview } from "../src/types.ts";

// PB4's own sequence checks, underneath the product: the deterministic attention
// flags and cleanup patterns, and the Run Director QA chain with its result
// merge. Pure functions and injected steps. No server, no provider, no DOM. (The
// Director board these once drove is no longer a user-facing screen.)
const { buildFilm } = await import("../src/app/visualReview/model.ts");
const { runDirectorQa, directorQaResult } = await import("../src/production/directorQaRun.ts");
const board = await import("../src/app/visualReview/board.ts");

const path = (kind: string, n: number) => `stories/demo/images/${kind}-${n}.png`;
function frame(kind: "long" | "short", slot: number, start: number, dur: number, over: Partial<PreviewFrame> = {}): PreviewFrame {
  return { kind, slot, path: path(kind, slot), truth: "reconstruction", motion: false, caption: "", edit: "new", framing: "wide", presentation: "base", startSec: start, durationSec: dur, ...over };
}

// Long, 60 s, neutral assets X01..X06:
//   0 X01 archive 0-5 | 1 X02 5-10 motion | 2 reuse X02 10-15 | 3 X03 graphic 15-20
//   4 reuse X02 20-25 | 5 X04 25-35 | 6 reuse X01 35-40 | 7 X05 40-50 | 8 X06 50-60
// Short, 12 s: 0 Y01 0-4 | 1 Y02 4-8 | 2 reuse Y01 8-12
function preview(): VisualPreview {
  const frames: PreviewFrame[] = [
    frame("long", 0, 0, 5, { asset: "X01", truth: "archive", caption: "An archive photograph of the harbour." }),
    frame("long", 1, 5, 5, { asset: "X02", motion: true }),
    frame("long", 2, 10, 5, { asset: "X02", edit: "reuse", path: path("long", 1), framing: "detail-left", presentation: "detail-left" }),
    frame("long", 3, 15, 5, { asset: "X03", truth: "graphic", caption: "A simple map" }),
    frame("long", 4, 20, 5, { asset: "X02", edit: "reuse", path: path("long", 1) }),
    frame("long", 5, 25, 10, { asset: "X04" }),
    frame("long", 6, 35, 5, { asset: "X01", edit: "reuse", truth: "archive", path: path("long", 0) }),
    frame("long", 7, 40, 10, { asset: "X05" }),
    frame("long", 8, 50, 10, { asset: "X06" }),
    frame("short", 0, 0, 4, { asset: "Y01", caption: "Short caption one" }),
    frame("short", 1, 4, 4, { asset: "Y02" }),
    frame("short", 2, 8, 4, { asset: "Y01", edit: "reuse", path: path("short", 0) }),
  ];
  return { moments: 12, uniqueAssets: 8, reusedPresentations: 4, archive: 1, reconstruction: 6, graphic: 1, motionSelected: 1, remainingMotionCost: 0, frames };
}

describe("attention flags", () => {
  const long = () => board.sequenceAttentionFlags(buildFilm(preview(), "long"));

  test("each rule, exactly", () => {
    expect(long()).toEqual([
      ["OPENING"], // 0-5
      ["OPENING", "HIGH REUSE", "MOTION"], // X02 is in 3 slots
      ["OPENING", "ADJACENT REUSE", "HIGH REUSE"], // same asset as slot 01; no CLOSE REUSE on top
      [], // 15-20: starts at 15, so not OPENING
      ["CLOSE REUSE", "HIGH REUSE"], // X02 last seen ending at 15, 5 s earlier
      [],
      [], // X01 last seen 30 s earlier: not close
      [], // ends at 50 of 60: not ENDING
      ["ENDING"], // 50-60
    ]);
  });

  test("CLOSE REUSE is measured from the previous appearance's end, under 15 s", () => {
    const p = preview();
    const f = p.frames.filter((x) => x.kind === "long");
    f[4].startSec = 30; // X02 ended at 15: exactly 15 s later is not close
    expect(board.sequenceAttentionFlags(buildFilm(p, "long"))[4]).not.toContain("CLOSE REUSE");
    f[4].startSec = 29.9;
    expect(board.sequenceAttentionFlags(buildFilm(p, "long"))[4]).toContain("CLOSE REUSE");
  });

});

describe("Run Director QA", () => {
  const report = (over: Record<string, unknown> = {}) => ({ summary: "Two fixes, one question.", repairs: [], humanReview: [], ...over }) as any;
  const cleanNone = { ran: false, changed: [], unresolved: [], remaining: [] };
  test("no Director repair: one review, no repair call, then the one cleanup step", async () => {
    const phases: string[] = [];
    const review = vi.fn(async () => report({ humanReview: [{ slotId: 3, reason: "ambiguous" }] }));
    const repair = vi.fn();
    const cleanup = vi.fn(async () => cleanNone);
    const out = await runDirectorQa("long", { review, repair, cleanup, onPhase: (p) => phases.push(p) });
    expect(out).toEqual({ status: "complete", qa: report({ humanReview: [{ slotId: 3, reason: "ambiguous" }] }), repair: null, cleanup: cleanNone, coordinated: null, verify: null });
    expect(review.mock.calls).toEqual([["long"]]);
    expect(repair).not.toHaveBeenCalled();
    expect(cleanup.mock.calls).toEqual([["long"]]);
    expect(phases).toEqual(["reviewing", "cleaning"]);
  });

  test("repairs: one repair call with the review's repairs, then one cleanup, for the same film", async () => {
    const phases: string[] = [];
    const repairs = [{ slotId: 2, reason: "r", instruction: "i" }];
    const repair = vi.fn(async () => ({ changed: [2], unresolved: [] }));
    const cleanup = vi.fn(async () => ({ ran: true, changed: [5], unresolved: [], remaining: [] }));
    const out = await runDirectorQa("short", { review: async () => report({ repairs }), repair, cleanup, onPhase: (p) => phases.push(p) });
    expect(out).toEqual({ status: "complete", qa: report({ repairs }), repair: { changed: [2], unresolved: [] }, cleanup: { ran: true, changed: [5], unresolved: [], remaining: [] }, coordinated: null, verify: null });
    expect(repair.mock.calls).toEqual([["short", repairs]]);
    expect(cleanup.mock.calls).toEqual([["short"]]);
    expect(phases).toEqual(["reviewing", "repairing", "cleaning"]);
  });

  test("failures are reported, never retried; a failed review stops before any repair or cleanup", async () => {
    const repair = vi.fn();
    const cleanup = vi.fn(async () => cleanNone);
    expect(await runDirectorQa("long", { review: async () => Promise.reject(new Error("OpenAI responses 500")), repair, cleanup })).toEqual({ status: "failed", error: "OpenAI responses 500" });
    expect(repair).not.toHaveBeenCalled();
    expect(cleanup).not.toHaveBeenCalled();
    const failing = vi.fn(async () => Promise.reject(new Error("Invalid edit plan: long slot 2 repeats slot 1.")));
    const repairs = [{ slotId: 2, reason: "r", instruction: "i" }];
    const out = await runDirectorQa("long", { review: async () => report({ repairs }), repair: failing, cleanup });
    expect(out).toEqual({ status: "repairFailed", qa: report({ repairs }), error: "Invalid edit plan: long slot 2 repeats slot 1.", cleanup: cleanNone, coordinated: null, verify: null });
    expect(failing).toHaveBeenCalledOnce();
    expect(cleanup).toHaveBeenCalledOnce();
    // A cleanup request that fails outright is reported, not retried.
    const broken = vi.fn(async () => Promise.reject(new Error("network down")));
    const out2 = await runDirectorQa("long", { review: async () => report(), repair, cleanup: broken });
    expect(out2).toMatchObject({ status: "complete", cleanup: { ran: false, changed: [], remaining: [], error: "network down" } });
    expect(broken).toHaveBeenCalledOnce();
  });

});

describe("ALTERNATING REUSE and the mandatory cleanup patterns", () => {
  // Frames of one film with the given asset per slot (4 s each). Asset letters only.
  function seqFilm(assets: string[], dur = 4) {
    const frames: PreviewFrame[] = assets.map((a, i) => frame("long", i, i * dur, dur, { asset: a, path: path("long", assets.indexOf(a)), edit: assets.indexOf(a) === i ? "new" : "reuse" }));
    return buildFilm({ ...preview(), frames }, "long");
  }
  const all = () => true;
  const summary = (issues: any[]) => issues.map((i) => `${i.pattern}:${i.frames.join("")}>${i.targets.join("")}`);

  test("A B A B is flagged on all four slots; A B A C is not; A A A A is not alternating", () => {
    const abab = board.sequenceAttentionFlags(seqFilm(["P", "A", "B", "A", "B", "Q", "R", "S", "T", "U"], 5));
    expect([1, 2, 3, 4].every((i) => abab[i].includes("ALTERNATING REUSE"))).toBe(true);
    expect(abab[0]).not.toContain("ALTERNATING REUSE");
    expect(abab[5]).not.toContain("ALTERNATING REUSE");
    expect(board.sequenceAttentionFlags(seqFilm(["A", "B", "A", "C", "D"])).some((f) => f.includes("ALTERNATING REUSE"))).toBe(false);
    expect(board.sequenceAttentionFlags(seqFilm(["A", "A", "A", "A", "D"])).some((f) => f.includes("ALTERNATING REUSE"))).toBe(false);
  });

  test("each mandatory pattern gets the smallest later target; CLOSE REUSE alone does not", () => {
    // Adjacent pair (outside the opening): the later one.
    expect(summary(board.sequenceCleanup(seqFilm(["P", "Q", "R", "S", "T", "A", "A", "U"]), all))).toEqual(["ADJACENT REUSE:56>6"]);
    // A run of three: the middle one breaks both adjacencies.
    expect(summary(board.sequenceCleanup(seqFilm(["P", "Q", "R", "S", "T", "A", "A", "A", "U"]), all))).toEqual(["CONSECUTIVE REUSE:567>6"]);
    // A B A B: the latest member.
    expect(summary(board.sequenceCleanup(seqFilm(["P", "Q", "R", "S", "A", "B", "A", "B", "U"]), all))).toEqual(["ALTERNATING REUSE:4567>7"]);
    // Opening repeat (not adjacent): keep the first, change the later one.
    expect(summary(board.sequenceCleanup(seqFilm(["A", "Q", "A", "S", "T", "U"]), all))).toEqual(["OPENING REPEAT:02>2"]);
    // CLOSE REUSE alone (after the opening, not adjacent, not alternating): no cleanup.
    const close = seqFilm(["P", "Q", "R", "S", "A", "T", "A", "U", "V"]);
    expect(board.sequenceAttentionFlags(close)[6]).toContain("CLOSE REUSE");
    expect(board.sequenceCleanup(close, all)).toEqual([]);
  });

  test("a locked member moves the target to an editable neighbour; with none, the pattern has no target", () => {
    const f = seqFilm(["P", "Q", "R", "S", "T", "A", "A", "U"]);
    expect(summary(board.sequenceCleanup(f, (i) => i !== 6))).toEqual(["ADJACENT REUSE:56>5"]); // the later one is locked: the earlier one
    expect(summary(board.sequenceCleanup(f, (i) => i !== 6 && i !== 5))).toEqual(["ADJACENT REUSE:56>"]);
    // A B A B with the last member locked: the next latest.
    expect(summary(board.sequenceCleanup(seqFilm(["P", "Q", "R", "S", "A", "B", "A", "B", "U"]), (i) => i !== 7))).toEqual(["ALTERNATING REUSE:4567>6"]);
  });
});

describe("coordinated neighbourhood repair in Run Director QA", () => {
  const report = (over: Record<string, unknown> = {}) => ({ summary: "", repairs: [{ slotId: 6, reason: "r", instruction: "i" }, { slotId: 12, reason: "r", instruction: "i" }], humanReview: [], ...over }) as any;
  const cleanNone = { ran: false, changed: [], unresolved: [], remaining: [] };
  test("one coordinated repair for the earliest unresolved slot; any other becomes human review", async () => {
    const phases: string[] = [];
    const coordinate = vi.fn(async (_k: string, slotId: number) => ({ target: slotId, changed: [4, 6, 8], humanReview: [], remaining: [] }));
    const out: any = await runDirectorQa("long", {
      review: async () => report(),
      repair: async () => ({ changed: [], unresolved: [{ slotId: 12, reason: "Not changed: X is not a legal choice for this slot." }, { slotId: 6, reason: "No legal alternative existing presentation is available." }] }),
      cleanup: async () => cleanNone,
      coordinate,
      onPhase: (p) => phases.push(p),
    });
    expect(coordinate.mock.calls).toEqual([["long", 6, "No legal alternative existing presentation is available.", { reason: "r", instruction: "i" }]]);
    expect(phases).toEqual(["reviewing", "repairing", "cleaning", "coordinating"]);
    expect(out.coordinated.changed).toEqual([4, 6, 8]);
    expect(out.coordinated.humanReview).toEqual([{ slotId: 12, reason: "Not changed: X is not a legal choice for this slot. Not attempted: one coordinated repair per Director QA run." }]);
  });

  test("nothing unresolved: no coordinated call; a failed Director repair (not unresolved) never triggers it", async () => {
    const coordinate = vi.fn();
    const clean: any = await runDirectorQa("long", { review: async () => report(), repair: async () => ({ changed: [6, 12], unresolved: [] }), cleanup: async () => cleanNone, coordinate });
    expect(clean.coordinated).toBeNull();
    const failed: any = await runDirectorQa("long", { review: async () => report(), repair: async () => Promise.reject(new Error("OpenAI responses 500")), cleanup: async () => cleanNone, coordinate });
    expect(failed.status).toBe("repairFailed");
    expect(failed.coordinated).toBeNull();
    expect(coordinate).not.toHaveBeenCalled();
  });

  test("a coordinated request that fails outright is reported for human review, not retried", async () => {
    const coordinate = vi.fn(async () => Promise.reject(new Error("network down")));
    const out: any = await runDirectorQa("long", { review: async () => report(), repair: async () => ({ changed: [], unresolved: [{ slotId: 6, reason: "r" }] }), cleanup: async () => cleanNone, coordinate });
    expect(coordinate).toHaveBeenCalledOnce();
    expect(out.coordinated).toMatchObject({ target: 6, changed: [], error: "network down" });
    expect(out.coordinated.humanReview[0].reason).toContain("Coordinated repair could not resolve Slot 06. The previous valid edit is kept.");
  });

});

describe("final Director verification in Run Director QA", () => {
  const cleanNone = { ran: false, changed: [], unresolved: [], remaining: [] };
  const review = (over: Record<string, unknown> = {}) => ({ summary: "Initial summary about the old edit.", repairs: [], humanReview: [{ slotId: 8, reason: "group photo is repetitive" }], ...over }) as any;
  const verified = { summary: "Final summary of the current edit.", humanReview: [{ slotId: 8, reason: "the aerial landscape does not show the vote" }], patterns: [] };

  test("the verification always runs once, last, after a successful review, even when nothing was repaired", async () => {
    const order: string[] = [];
    const out: any = await runDirectorQa("long", {
      review: async () => (order.push("review"), review()),
      repair: async () => (order.push("repair"), { changed: [], unresolved: [] }),
      cleanup: async () => (order.push("cleanup"), cleanNone),
      coordinate: async () => (order.push("coordinate"), { target: 0, changed: [], humanReview: [], remaining: [] }),
      verify: async () => (order.push("verify"), verified),
      onPhase: (p) => order.push(`phase:${p}`),
    });
    expect(order).toEqual(["phase:reviewing", "review", "phase:cleaning", "cleanup", "phase:verifying", "verify"]);
    expect(out.verify).toEqual(verified);
  });

  test("the full chain ends with the verification; nothing runs after it; a failed review runs none of it", async () => {
    const order: string[] = [];
    await runDirectorQa("long", {
      review: async () => review({ repairs: [{ slotId: 6, reason: "r", instruction: "i" }] }),
      repair: async () => (order.push("repair"), { changed: [], unresolved: [{ slotId: 6, reason: "r" }] }),
      cleanup: async () => (order.push("cleanup"), cleanNone),
      coordinate: async () => (order.push("coordinate"), { target: 6, changed: [4, 6], humanReview: [], remaining: [] }),
      verify: async () => (order.push("verify"), verified),
    });
    expect(order).toEqual(["repair", "cleanup", "coordinate", "verify"]);
    const verify = vi.fn();
    expect((await runDirectorQa("long", { review: async () => Promise.reject(new Error("x")), repair: vi.fn(), cleanup: vi.fn(), verify })).status).toBe("failed");
    expect(verify).not.toHaveBeenCalled();
  });

  test("a failed verification request falls back to the latest current patterns, not the stale findings", async () => {
    const verify = vi.fn(async () => Promise.reject(new Error("network down")));
    const remaining = [{ slotId: 3, reason: "ADJACENT REUSE remains." }];
    const out: any = await runDirectorQa("long", { review: async () => review(), repair: vi.fn(), cleanup: async () => ({ ...cleanNone, remaining }), verify });
    expect(verify).toHaveBeenCalledOnce();
    expect(out.verify).toEqual({ summary: "", humanReview: [], patterns: remaining, error: "network down" });
  });

  test("stale regression: the result carries only the verification's current findings and summary", () => {
    const r = directorQaResult({ status: "complete", qa: review(), repair: { changed: [8], unresolved: [] }, cleanup: { ...cleanNone, remaining: [{ slotId: 7, reason: "ALTERNATING REUSE remains." }] }, coordinated: null, verify: verified } as any);
    expect(r.verified).toBe(true);
    expect(r.summary).toBe("Final summary of the current edit.");
    expect(r.humanReview).toEqual([{ slotId: 8, reason: "the aerial landscape does not show the vote" }]);
    expect(JSON.stringify(r)).not.toMatch(/group photo|Initial summary about the old edit|ALTERNATING REUSE remains/); // stale findings and patterns
  });

  test("a failed verification: the repaired edit is kept, current patterns stay, stale findings are not restored", () => {
    const r = directorQaResult({
      status: "complete", qa: review(), repair: { changed: [8], unresolved: [] }, cleanup: cleanNone, coordinated: null,
      verify: { summary: "", humanReview: [], patterns: [{ slotId: 3, reason: "ADJACENT REUSE remains." }], error: "OpenAI responses 500" },
    } as any);
    expect(r).toMatchObject({ verified: false, verifyError: "OpenAI responses 500", clean: false, changed: [8] });
    expect(r.humanReview).toEqual([{ slotId: 3, reason: "ADJACENT REUSE remains." }]);
    expect(JSON.stringify(r)).not.toMatch(/group photo|Initial summary about the old edit/);
  });

  test("operational exceptions survive the verification; a verified slot's reasons are merged, not duplicated", () => {
    const r = directorQaResult({
      status: "complete", qa: review(), repair: { changed: [], unresolved: [{ slotId: 6, reason: "r" }] }, cleanup: cleanNone,
      coordinated: { target: 6, changed: [], humanReview: [{ slotId: 6, reason: "Coordinated repair could not resolve Slot 06. The previous valid edit is kept. x" }], remaining: [], error: "x" },
      verify: { summary: "", humanReview: [{ slotId: 6, reason: "the slot still shows the vote count" }], patterns: [] },
    } as any);
    expect(r.humanReview).toEqual([{ slotId: 6, reason: "the slot still shows the vote count Coordinated repair could not resolve Slot 06. The previous valid edit is kept. x" }]);
  });

});

describe("factual-graphic mismatches in Run Director QA", () => {
  const reason = "The narration gives the earlier referendum result; the graphic shows the later parliamentary vote.";
  const cleanNone = { ran: false, changed: [], unresolved: [], remaining: [] };

  test("a graphic mismatch the one-slot repair cannot fix goes to the existing coordinated repair, then the verification", async () => {
    const order: string[] = [];
    const coordinate = vi.fn(async (_k: string, slotId: number) => (order.push("coordinate"), { target: slotId, changed: [4, 6], humanReview: [], remaining: [] }));
    await runDirectorQa("long", {
      review: async () => ({ summary: "", repairs: [{ slotId: 6, reason, instruction: "Show the earlier referendum graphic." }], humanReview: [] }),
      repair: async () => (order.push("repair"), { changed: [], unresolved: [{ slotId: 6, reason: "The repair kept the current presentation." }] }),
      cleanup: async () => (order.push("cleanup"), cleanNone),
      coordinate,
      verify: async () => (order.push("verify"), { summary: "", humanReview: [], patterns: [] }),
    });
    expect(order).toEqual(["repair", "cleanup", "coordinate", "verify"]);
    expect(coordinate).toHaveBeenCalledWith("long", 6, "The repair kept the current presentation.", { reason, instruction: "Show the earlier referendum graphic." });
  });

});

describe("the original Director repair intent in Run Director QA", () => {
  const cleanNone = { ran: false, changed: [], unresolved: [], remaining: [] };
  const intent = { reason: "Narration describes referendum percentage; current graphic depicts a later parliamentary vote.", instruction: "Use the existing referendum-result graphic." };
  const mechanical = "Not changed: L05:base is not a legal choice for this slot.";

  test("an unresolved Director repair escalates with its original reason and instruction, not only the mechanical reason", async () => {
    const coordinate = vi.fn(async (_k: string, slotId: number) => ({ target: slotId, changed: [], humanReview: [], remaining: [] }));
    await runDirectorQa("long", {
      review: async () => ({ summary: "", repairs: [{ slotId: 6, ...intent }], humanReview: [] }),
      repair: async () => ({ changed: [], unresolved: [{ slotId: 6, reason: mechanical }] }),
      cleanup: async () => cleanNone,
      coordinate,
    });
    expect(coordinate.mock.calls).toEqual([["long", 6, mechanical, intent]]);
  });

  test("a coordinated target that was never a Director repair (a cleanup pattern) escalates as before, with no intent", async () => {
    const coordinate = vi.fn(async (_k: string, slotId: number) => ({ target: slotId, changed: [], humanReview: [], remaining: [] }));
    await runDirectorQa("long", {
      review: async () => ({ summary: "", repairs: [{ slotId: 9, ...intent }], humanReview: [] }),
      repair: async () => ({ changed: [9], unresolved: [] }),
      cleanup: async () => ({ ...cleanNone, ran: true, unresolved: [{ slotId: 3, reason: "ADJACENT REUSE" }] }),
      coordinate,
    });
    expect(coordinate.mock.calls).toEqual([["long", 3, "ADJACENT REUSE"]]);
  });
});
