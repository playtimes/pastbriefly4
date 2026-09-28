import { describe, test, expect, vi } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { PreviewFrame, VisualPreview } from "../src/types.ts";

// The DIRECTOR board: a read-only contact sheet of one film with deterministic
// attention flags, plus the PNG export. Static renders, a recording canvas and a
// fake clipboard. No server, no provider, no DOM.
const { buildFilm, initialReview, reviewReducer, stepAction } = await import("../src/app/visualReview/model.ts");
const { ReviewView, ReviewHeader } = await import("../src/app/visualReview/VisualReview.tsx");
const { DirectorBoard, DirectorBoardView, submitSequenceRevision } = await import("../src/app/visualReview/DirectorBoard.tsx");
// The Director QA chain and its result merge run on the server; the board only
// renders the persisted state.
const { runDirectorQa, directorQaResult } = await import("../src/production/directorQaRun.ts");
// The board as it sees a film: its running phase, or the result the server saved
// for a run with this outcome (the server derives it with directorQaResult).
function qaControls({ phase = null, outcome = null, ...over }: any = {}) {
  const run = phase ? { status: "running", phase } : !outcome ? null : outcome.status === "failed" ? { status: "failed", error: outcome.error } : { status: "complete", ...directorQaResult(outcome) };
  return { run, onRun: vi.fn(), onSlot: vi.fn(), ...over };
}
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

const idle = { running: null, failed: null, done: null };
function reviewHtml(state: any) {
  const p = { preview: preview(), storyTitle: "A Neutral Story", version: 0, onBack: vi.fn(), onContinue: vi.fn(), onRebuild: vi.fn(), continuing: false, rebuilding: false, onRegenerate: vi.fn(), regen: idle } as any;
  const films = { long: buildFilm(p.preview, "long"), short: buildFilm(p.preview, "short") };
  return renderToStaticMarkup(React.createElement(ReviewView, { ...p, films, state, dispatch: () => {} }));
}
const director = (film: "long" | "short" = "long") => reviewReducer(reviewReducer(initialReview(preview()), { type: "film", film }), { type: "mode", mode: "director" });
const cardSlots = (html: string) => [...html.matchAll(/data-board-card="(\d+)"/g)].map((m) => m[1]);
const cardHtml = (html: string, slot: string) => {
  const at = html.indexOf(`data-board-card="${slot}"`);
  return html.slice(at, html.indexOf("</button>", at));
};

describe("Director mode", () => {
  test("DIRECTOR sits beside Sequence and Assets, and replaces the stage with the board", () => {
    const html = reviewHtml(director());
    const tabs = [...html.matchAll(/data-mode-tab="(\w+)"/g)].map((m) => m[1]);
    expect(tabs).toEqual(["sequence", "assets", "director"]);
    expect(html).toMatch(/data-mode-tab="director" aria-pressed="true"[^>]*>Director</);
    expect(html).toContain('data-director-board="long"');
    expect(html).not.toContain("data-stage=");
    expect(html).not.toContain("data-asset-grid=");
    // The other modes are unchanged and do not show the board.
    expect(reviewHtml(initialReview(preview()))).not.toContain("data-director-board");
  });

  test("every slot of the selected film appears once, in order; Long and Short never mix", () => {
    const long = reviewHtml(director("long"));
    expect(cardSlots(long)).toEqual(["00", "01", "02", "03", "04", "05", "06", "07", "08"]);
    const short = reviewHtml(director("short"));
    expect(short).toContain('data-director-board="short"');
    expect(cardSlots(short)).toEqual(["00", "01", "02"]);
    expect(short).not.toContain("X01");
  });

  test("cards carry slot, time, the actual still, asset id and type, owner or reuse, and the existing caption", () => {
    const html = reviewHtml(director());
    const c0 = cardHtml(html, "00");
    expect(c0).toContain("Slot 00");
    expect(c0).toContain("00:00 → 00:05 · 5.0s");
    expect(c0).toContain(`src="/media/${path("long", 0)}"`);
    expect(c0).toContain("X01");
    expect(c0).toContain("ARCHIVE");
    expect(c0).toContain(">OWNER<");
    expect(c0).toContain("An archive photograph of the harbour.");

    const c2 = cardHtml(html, "02");
    expect(c2).toContain(`src="/media/${path("long", 1)}"`); // the reuse shows its owner's still
    expect(c2).toContain("scale(1.5)"); // with the slot's own detail crop
    expect(c2).toContain("REUSE OF X02 · SLOT 01");
    expect(c2).toContain("No on-screen caption"); // nothing invented
    expect(cardHtml(html, "03")).toContain("GRAPHIC");
  });

  test("the header summarizes the film and explains the flags without calling them errors", () => {
    const html = reviewHtml(director());
    expect(html).toContain("PastBriefly Director Visual Review");
    expect(html).toContain("A Neutral Story");
    const summary = html.slice(html.indexOf("data-board-summary"), html.indexOf("data-action=\"copy-board\""));
    for (const [label, n] of [["Film", "Long"], ["Slots", "9"], ["Duration", "01:00"], ["Owners", "6"], ["Archive", "1"], ["Graphics", "1"], ["Motion", "1"], ["Attention", "5"]])
      expect(summary).toMatch(new RegExp(`${label}</span><span[^>]*>${n}<`));
    for (const f of ["OPENING", "ENDING", "ADJACENT REUSE", "CLOSE REUSE", "HIGH REUSE", "MOTION"]) expect(html).toContain(`>${f}</dt>`);
    expect(html).toContain("They are not errors or verdicts.");
    expect(html).not.toMatch(/PASS|FAIL|score/i);
  });
});

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

  test("Flagged shows only flagged slots, in order; All shows every slot", () => {
    const b = board.buildDirectorBoard(buildFilm(preview(), "long"));
    const render = (filter: "all" | "flagged") =>
      renderToStaticMarkup(React.createElement(DirectorBoardView, { board: b, storyTitle: "T", version: 0, dispatch: vi.fn(), filter, onFilter: vi.fn(), copy: { kind: "idle" }, onCopy: vi.fn() }));
    expect(cardSlots(render("flagged"))).toEqual(["00", "01", "02", "04", "08"]);
    expect(cardSlots(render("all"))).toHaveLength(9);
    expect(render("flagged")).toMatch(/data-board-filter="flagged" aria-pressed="true"[^>]*>Flagged<span[^>]*>5</);
  });
});

describe("board navigation", () => {
  test("a card opens its slot in the existing Sequence mode; arrows do nothing on the board", () => {
    const b = board.buildDirectorBoard(buildFilm(preview(), "long"));
    const dispatch = vi.fn();
    const tree: any = DirectorBoardView({ board: b, storyTitle: "T", version: 0, dispatch, filter: "all", onFilter: vi.fn(), copy: { kind: "idle" }, onCopy: vi.fn() });
    const cards: any[] = [];
    const walk = (n: any) => {
      if (Array.isArray(n)) return n.forEach(walk);
      if (!n || typeof n !== "object") return;
      if (n.props?.["data-board-card"]) cards.push(n);
      walk(n.props?.children);
    };
    walk(tree);
    cards.find((c) => c.props["data-board-card"] === "04").props.onClick();
    expect(dispatch).toHaveBeenCalledWith({ type: "slot", index: 4 });
    const after = reviewReducer(director(), dispatch.mock.calls[0][0]);
    expect(after.mode).toBe("sequence");
    expect(after.index.long).toBe(4);
    expect(stepAction(director(), buildFilm(preview(), "long"), 1)).toBeNull();
  });
});

// A canvas stand-in that records what is drawn.
function recorder() {
  const text: string[] = [];
  const images: unknown[] = [];
  const ctx: any = {
    fillStyle: "", strokeStyle: "", font: "", lineWidth: 1, textBaseline: "top",
    fillRect: () => {}, strokeRect: () => {},
    fillText: (t: string) => text.push(t),
    measureText: (t: string) => ({ width: t.length * 7 }),
    drawImage: (src: unknown) => images.push(src),
  };
  let size = { width: 0, height: 0 };
  const deps = {
    loaded: [] as string[],
    loadImage: async (url: string) => (deps.loaded.push(url), url.includes("missing") ? null : { width: 1536, height: 1024, source: url as any }),
    canvas: (width: number, height: number) => ((size = { width, height }), { ctx, toBlob: async () => new Blob(["png"], { type: "image/png" }) }),
  };
  return { text, images, deps, size: () => size };
}
const url = (f: PreviewFrame) => `/media/${f.path}`;

describe("Director board PNG", () => {
  test("uses the same sequence as Director mode: every slot once, in order, with its metadata and flags", async () => {
    const b = board.buildDirectorBoard(buildFilm(preview(), "long"));
    const r = recorder();
    const blob = await board.renderDirectorBoardPng(b, "A Neutral Story", url, r.deps);
    expect(blob.type).toBe("image/png");
    expect(r.deps.loaded).toEqual(b.cards.map((c) => `/media/${c.frame.path}`));
    expect(r.images).toHaveLength(9);
    const slots = r.text.filter((t) => t.startsWith("Slot "));
    expect(slots.map((t) => t.slice(5, 7))).toEqual(["00", "01", "02", "03", "04", "05", "06", "07", "08"]);
    expect(slots[0]).toBe("Slot 00  00:00 → 00:05 · 5.0s");
    expect(r.text).toContain("PASTBRIEFLY DIRECTOR VISUAL REVIEW");
    expect(r.text).toContain("Story: A Neutral Story");
    expect(r.text).toContain("Film: Long   Slots: 9   Duration: 01:00   Owners: 6   Archive: 1   Graphics: 1   Motion: 1   Attention: 5");
    expect(r.text).toContain("X02 · RECONSTRUCTION");
    expect(r.text).toContain("REUSE OF X02 · SLOT 01");
    expect(r.text).toContain("OPENING · ADJACENT REUSE · HIGH REUSE");
    expect(r.text.join("\n")).toContain("An archive photograph of the harbour.");
  });

  test("a fixed width and grid per film, never the browser window", async () => {
    const long = board.boardLayout(board.buildDirectorBoard(buildFilm(preview(), "long")));
    expect(long).toMatchObject({ width: 1600, columns: 4 });
    expect(long.thumbH).toBeLessThan(long.cardW); // landscape
    const short = board.boardLayout(board.buildDirectorBoard(buildFilm(preview(), "short")));
    expect(short).toMatchObject({ width: 1600, columns: 6 });
    expect(short.thumbH).toBeGreaterThan(short.cardW); // portrait
    const r = recorder();
    await board.renderDirectorBoardPng(board.buildDirectorBoard(buildFilm(preview(), "long")), "T", url, r.deps);
    expect(r.size()).toEqual({ width: long.width, height: long.height });
  });

  test("switching to Short exports the Short only", async () => {
    const r = recorder();
    await board.renderDirectorBoardPng(board.buildDirectorBoard(buildFilm(preview(), "short")), "T", url, r.deps);
    expect(r.deps.loaded).toEqual([`/media/${path("short", 0)}`, `/media/${path("short", 1)}`, `/media/${path("short", 0)}`]);
    expect(r.text.filter((t) => t.startsWith("Slot "))).toHaveLength(3);
    expect(r.text.some((t) => t.startsWith("Film: Short"))).toBe(true);
    expect(r.text.join(" ")).not.toContain("X0");
  });

  test("one missing still is drawn as unavailable instead of failing the board", async () => {
    const p = preview();
    p.frames[0].path = "stories/demo/images/missing.png";
    const r = recorder();
    await board.renderDirectorBoardPng(board.buildDirectorBoard(buildFilm(p, "long")), "T", url, r.deps);
    expect(r.text).toContain("Image unavailable");
    expect(r.images).toHaveLength(8);
  });

  test("long captions wrap to two lines with an ellipsis", () => {
    const ctx = { measureText: (t: string) => ({ width: t.length * 7 }) };
    const lines = board.wrapLines(ctx, "one two three four five six seven eight nine ten eleven twelve", 70, 2);
    expect(lines).toHaveLength(2);
    expect(lines[1].endsWith("…")).toBe(true);
  });
});

describe("Copy Director Board", () => {
  class FakeItem {
    constructor(public items: Record<string, Promise<Blob>>) {}
  }
  const b = () => board.buildDirectorBoard(buildFilm(preview(), "long"));

  test("reports copied only after the clipboard write succeeds, with the PNG", async () => {
    let finish!: () => void;
    const write = vi.fn(() => new Promise<void>((r) => (finish = r)));
    const objectUrl = vi.fn();
    const r = recorder();
    const out = board.startBoardCopy(b(), "T", url, { deps: r.deps, clipboard: { write }, Item: FakeItem as any, objectUrl });
    let settled = false;
    out.then(() => (settled = true));
    await new Promise((res) => setTimeout(res, 0));
    expect(write).toHaveBeenCalledOnce(); // started at once, inside the click
    expect(settled).toBe(false);
    finish();
    expect(await out).toEqual({ kind: "copied" });
    const item = (write.mock.calls[0] as any)[0][0] as FakeItem;
    expect((await item.items["image/png"]).type).toBe("image/png");
    expect(objectUrl).not.toHaveBeenCalled();
  });

  test("a refused or missing image clipboard offers the same PNG as a download", async () => {
    const objectUrl = vi.fn(() => "blob:board");
    const refused = await board.startBoardCopy(b(), "T", url, { deps: recorder().deps, clipboard: { write: vi.fn(async () => { throw new Error("NotAllowedError"); }) }, Item: FakeItem as any, objectUrl });
    expect(refused).toEqual({ kind: "fallback", url: "blob:board" });
    expect((objectUrl.mock.calls[0] as any)[0].type).toBe("image/png");
    expect(await board.startBoardCopy(b(), "T", url, { deps: recorder().deps, clipboard: undefined, Item: FakeItem as any, objectUrl })).toEqual({ kind: "fallback", url: "blob:board" });
    expect(await board.startBoardCopy(b(), "T", url, { deps: recorder().deps, clipboard: { write: vi.fn() }, Item: undefined, objectUrl })).toEqual({ kind: "fallback", url: "blob:board" });
  });

  test("the button states: preparing, copied, and the download fallback", () => {
    const render = (copy: any) =>
      renderToStaticMarkup(React.createElement(DirectorBoardView, { board: b(), storyTitle: "T", version: 0, dispatch: vi.fn(), filter: "all", onFilter: vi.fn(), copy, onCopy: vi.fn() }));
    expect(render({ kind: "idle" })).toMatch(/data-action="copy-board"[^>]*>Copy Director Board</);
    expect(render({ kind: "working" })).toMatch(/disabled=""[^>]*data-action="copy-board"[^>]*>Preparing board…</);
    expect(render({ kind: "copied" })).toContain("Director board copied");
    const fallback = render({ kind: "fallback", url: "blob:board" });
    expect(fallback).not.toContain("Director board copied");
    expect(fallback).toMatch(/<a href="blob:board" download="director-board-long.png"[^>]*>Download Director Board<\/a>/);
    expect(render({ kind: "idle" })).not.toContain("Download Director Board");
  });
});

describe("Revise sequence", () => {
  const controls = (over: Record<string, unknown> = {}) => ({
    open: false, feedback: "", running: false, notice: null,
    onOpen: vi.fn(), onCancel: vi.fn(), onFeedback: vi.fn(), onSubmit: vi.fn(), ...over,
  });
  const b = (p = preview(), film: "long" | "short" = "long") => board.buildDirectorBoard(buildFilm(p, film));
  const viewProps = (revise: any) => ({ board: b(), storyTitle: "T", version: 0, dispatch: vi.fn(), filter: "all" as const, onFilter: vi.fn(), copy: { kind: "idle" as const }, onCopy: vi.fn(), revise });
  const render = (revise: any) => renderToStaticMarkup(React.createElement(DirectorBoardView, viewProps(revise)));
  const tree = (revise: any) => DirectorBoardView(viewProps(revise));
  function find(n: any, match: (el: any) => boolean): any {
    if (Array.isArray(n)) return n.map((x) => find(x, match)).find(Boolean);
    if (!n || typeof n !== "object") return undefined;
    if (match(n)) return n;
    return find(n.props?.children, match);
  }
  const byAction = (t: any, action: string) => find(t, (el) => el.props?.["data-action"] === action);

  test("sits beside Copy Director Board, only when wired, and only on the Director board", () => {
    expect(render(controls())).toMatch(/data-action="revise-sequence"[^>]*>Revise sequence<\/button>.*data-action="copy-board"/s);
    expect(render(undefined)).not.toContain("Revise sequence");
    const wired = renderToStaticMarkup(React.createElement(DirectorBoard, { fr: buildFilm(preview(), "long"), storyTitle: "T", version: 0, dispatch: vi.fn(), onReviseSequence: vi.fn() }));
    expect(wired).toContain(">Revise sequence</button>");
    expect(wired).not.toContain("<textarea");
    expect(reviewHtml(initialReview(preview()))).not.toContain("Revise sequence"); // Sequence mode
  });

  test("opening calls onOpen only; the open form names the film; Cancel only closes", () => {
    const closed = controls();
    byAction(tree(closed), "revise-sequence").props.onClick();
    expect(closed.onOpen).toHaveBeenCalledOnce();
    expect(closed.onSubmit).not.toHaveBeenCalled();
    const open = controls({ open: true, feedback: "Keep slot 01." });
    const html = render(open);
    expect(html).toContain("Director sequence feedback · Long only");
    expect(html).toMatch(/<textarea[^>]*>Keep slot 01\.<\/textarea>/);
    expect(html).toMatch(/disabled=""[^>]*data-action="revise-sequence"/); // the opener is disabled while open
    find(tree(open), (el) => el.type === "button" && el.props.children === "Cancel").props.onClick();
    expect(open.onCancel).toHaveBeenCalledOnce();
    expect(open.onSubmit).not.toHaveBeenCalled();
  });

  test("empty and too-long feedback are refused before any call; the film and trimmed text are sent", async () => {
    const revise = vi.fn(async () => ({ changed: [], unresolved: [] }));
    expect(await submitSequenceRevision("long", "  \n ", false, revise)).toEqual({ status: "invalid", error: "Director feedback is required." });
    expect(await submitSequenceRevision("long", "x".repeat(4001), false, revise)).toEqual({ status: "invalid", error: "Director feedback must be 4,000 characters or fewer." });
    expect(await submitSequenceRevision("short", "Keep slot 01.", true, revise)).toEqual({ status: "skipped" });
    expect(revise).not.toHaveBeenCalled();
    expect(await submitSequenceRevision("short", "  Keep slot 01.\n", false, revise)).toEqual({ status: "ok", report: { changed: [], unresolved: [] } });
    expect(revise.mock.calls).toEqual([["short", "Keep slot 01."]]);
    const failed = await submitSequenceRevision("long", "x", false, async () => {
      throw new Error("Invalid edit plan: long slot 4 repeats slot 3");
    });
    expect(failed).toEqual({ status: "failed", error: "Invalid edit plan: long slot 4 repeats slot 3" });
  });

  test("while revising, the form is locked and says Revising…", () => {
    const html = render(controls({ open: true, feedback: "x", running: true }));
    expect(html).toMatch(/<textarea[^>]*disabled=""/);
    expect(html).toMatch(/disabled=""[^>]*data-action="submit-sequence"[^>]*>Revising…</);
  });

  test("a failure says the edit was not changed and keeps the feedback for retry", () => {
    const html = render(controls({ open: true, feedback: "Replace slot 02.", notice: { kind: "failed", message: "Invalid edit plan: long slot 2 repeats slot 1." } }));
    expect(html).toContain("Sequence revision failed");
    expect(html).toContain("The current edit was not changed.");
    expect(html).toContain("Invalid edit plan: long slot 2 repeats slot 1.");
    expect(html).toMatch(/<textarea[^>]*>Replace slot 02\.<\/textarea>/);
    expect(html).not.toContain("Sequence revision applied");
  });

  test("success reports what changed and what is unresolved", () => {
    const report = { changed: [2, 4], unresolved: [{ slotId: 0, reason: "no other existing visual shows the opening" }] };
    const html = render(controls({ notice: { kind: "applied", report } }));
    expect(html).toContain("Sequence revision applied");
    expect(html).toContain("Review the updated Director board before continuing.");
    expect(html).toContain("Changed: 2 slots (02, 04) · Unresolved: 1");
    expect(html).toContain("Slot 00: no other existing visual shows the opening");
    expect(render(controls({ open: true, notice: { kind: "applied", report } }))).not.toContain("Sequence revision applied");
  });

  test("the board and its export follow the revised sequence", async () => {
    const revised = preview();
    revised.frames[2] = { ...revised.frames[2], asset: "X04", edit: "reuse", path: path("long", 5), framing: "wide", presentation: "base" };
    const html = renderToStaticMarkup(React.createElement(DirectorBoardView, { ...viewProps(undefined), board: b(revised) }));
    expect(cardHtml(html, "02")).toContain("REUSE OF X04 · SLOT 05");
    const r = recorder();
    await board.renderDirectorBoardPng(b(revised), "T", url, r.deps);
    expect(r.deps.loaded[2]).toBe(`/media/${path("long", 5)}`);
    expect(b().cards[2].assetId).toBe("X02"); // the original preview is untouched
  });

  test("changed slots become unreviewed; every other slot keeps its reviewed state", () => {
    const s = reviewReducer(director(), { type: "markAll", count: 9 });
    const after = reviewReducer(s, { type: "unvisit", film: "long", indexes: [2, 4] });
    expect(after.visited.long).toEqual([0, 1, 3, 5, 6, 7, 8]);
    expect(after.visited.short).toEqual(s.visited.short);
    expect(after.mode).toBe("director");
  });

  test("Continue and Rebuild are disabled while a sequence revision runs", () => {
    const p = { preview: preview(), storyTitle: "T", version: 0, onBack: vi.fn(), onContinue: vi.fn(), onRebuild: vi.fn(), continuing: false, rebuilding: false, regen: idle, revisingSequence: true } as any;
    const films = { long: buildFilm(p.preview, "long"), short: buildFilm(p.preview, "short") };
    const html = renderToStaticMarkup(React.createElement(ReviewHeader, { ...p, films, state: director(), dispatch: vi.fn(), fr: films.long }));
    expect(html).toMatch(/disabled=""[^>]*data-action="continue"/);
    expect(html).toMatch(/disabled=""[^>]*data-action="rebuild"/);
  });
});

describe("Run Director QA", () => {
  const report = (over: Record<string, unknown> = {}) => ({ summary: "Two fixes, one question.", repairs: [], humanReview: [], ...over }) as any;
  const cleanNone = { ran: false, changed: [], unresolved: [], remaining: [] };
  const qaView = (qa: any, revise?: any) =>
    React.createElement(DirectorBoardView, { board: board.buildDirectorBoard(buildFilm(preview(), "long")), storyTitle: "T", version: 0, dispatch: vi.fn(), filter: "all", onFilter: vi.fn(), copy: { kind: "idle" }, onCopy: vi.fn(), revise, qa });
  const controls = (over: Record<string, unknown> = {}) => qaControls(over);

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

  test("the button sits in Director mode and shows each phase; Revise sequence waits", () => {
    const idle = renderToStaticMarkup(qaView(controls()));
    expect(idle).toMatch(/data-action="run-director-qa"[^>]*>Run Director QA<\/button>/);
    expect(renderToStaticMarkup(qaView(undefined))).not.toContain("Run Director QA");
    expect(renderToStaticMarkup(qaView(controls({ phase: "reviewing" })))).toMatch(/disabled=""[^>]*data-action="run-director-qa"[^>]*>Director reviewing…</);
    expect(renderToStaticMarkup(qaView(controls({ phase: "repairing" })))).toContain(">Repairing sequence…</button>");
    expect(renderToStaticMarkup(qaView(controls({ phase: "cleaning" })))).toContain(">Cleaning up repetition…</button>");
    const reviseRunning = { open: false, feedback: "", running: true, notice: null, onOpen: vi.fn(), onCancel: vi.fn(), onFeedback: vi.fn(), onSubmit: vi.fn() };
    expect(renderToStaticMarkup(qaView(controls(), reviseRunning))).toMatch(/disabled=""[^>]*data-action="run-director-qa"/);
  });

  test("results: Director and cleanup changes counted apart; remaining patterns become human review", () => {
    // Clean means the final film was verified with nothing left for a person (the server always verifies).
    const clean = renderToStaticMarkup(qaView(controls({ outcome: { status: "complete", qa: report(), repair: null, cleanup: cleanNone, coordinated: null, verify: { summary: "", humanReview: [], patterns: [] } } })));
    expect(clean).toContain("Director QA complete");
    expect(clean).toContain("Automatic Director changes: 0 · Automatic cleanup changes: 0 · Coordinated repair changes: 0 · Unresolved repairs: 0 · Needs human review: 0");
    expect(clean).toContain("No automatic sequence repair was needed.");

    const html = renderToStaticMarkup(
      qaView(
        controls({
          outcome: {
            status: "complete",
            qa: report({ repairs: [{ slotId: 0, reason: "r", instruction: "i" }], humanReview: [{ slotId: 6, reason: "needs the image" }] }),
            repair: { changed: [0, 4], unresolved: [{ slotId: 2, reason: "No legal alternative existing presentation is available." }] },
            cleanup: { ran: true, changed: [5], unresolved: [], remaining: [{ slotId: 7, reason: "ADJACENT REUSE remains. No legal existing alternative resolved this sequence issue." }] },
          },
        }),
      ),
    );
    expect(html).toContain("Automatic Director changes: 2 · Automatic cleanup changes: 1 · Coordinated repair changes: 0 · Unresolved repairs: 1 · Needs human review: 2");
    expect(html).toContain("ADJACENT REUSE remains.");
    expect(html).toContain("needs the image");
    expect(html).not.toContain("No automatic sequence repair was needed."); // never clean while a pattern remains
    expect(html).not.toMatch(/approved|perfect/i);

    // A remaining pattern alone keeps the result from reading as clean.
    const remaining = renderToStaticMarkup(qaView(controls({ outcome: { status: "complete", qa: report(), repair: null, cleanup: { ...cleanNone, remaining: [{ slotId: 3, reason: "OPENING REPEAT remains." }] } } })));
    expect(remaining).not.toContain("No automatic sequence repair was needed.");
    expect(remaining).toContain("Needs human review: 1");

    const failed = renderToStaticMarkup(qaView(controls({ outcome: { status: "failed", error: "OpenAI responses 500" } })));
    expect(failed).toContain("Director QA failed");
    expect(failed).toContain("No edit was changed.");

    const repairFailed = renderToStaticMarkup(qaView(controls({ outcome: { status: "repairFailed", qa: report({ repairs: [{ slotId: 2, reason: "wrong subject", instruction: "i" }] }), error: "Invalid edit plan", cleanup: cleanNone } })));
    expect(repairFailed).toContain("Director QA review completed, but automatic repair failed.");
    expect(repairFailed).toContain("Repairs the Director asked for");

    const cleanupFailed = renderToStaticMarkup(
      qaView(controls({ outcome: { status: "complete", qa: report(), repair: { changed: [1], unresolved: [] }, cleanup: { ran: true, changed: [], unresolved: [], remaining: [{ slotId: 4, reason: "ADJACENT REUSE remains. No legal existing alternative resolved this sequence issue. Automatic cleanup failed." }], error: "Invalid edit plan" } } })),
    );
    expect(cleanupFailed).toContain("Director QA completed, but automatic cleanup failed.");
    expect(cleanupFailed).toContain("The edit before the cleanup stays saved.");
    expect(cleanupFailed).toContain("Automatic Director changes: 1 · Automatic cleanup changes: 0");
    expect(cleanupFailed).toContain("Automatic cleanup failed.");
  });

  test("a listed exception opens its slot in Sequence", () => {
    const onSlot = vi.fn();
    const tree: any = DirectorBoardView({
      board: board.buildDirectorBoard(buildFilm(preview(), "long")), storyTitle: "T", version: 0, dispatch: vi.fn(), filter: "all", onFilter: vi.fn(), copy: { kind: "idle" }, onCopy: vi.fn(),
      qa: controls({ onSlot, outcome: { status: "complete", qa: report(), repair: null, cleanup: { ...cleanNone, remaining: [{ slotId: 6, reason: "ALTERNATING REUSE remains." }] } } }),
    });
    const find = (n: any, match: (el: any) => boolean): any => {
      if (Array.isArray(n)) return n.map((x) => find(x, match)).find(Boolean);
      if (!n || typeof n !== "object") return undefined;
      if (typeof n.type === "function") return find(n.type(n.props), match);
      if (match(n)) return n;
      return find(n.props?.children, match);
    };
    find(tree, (el) => el.props?.["data-qa-slot"] === 6).props.onClick();
    expect(onSlot).toHaveBeenCalledWith(6);
    const html = renderToStaticMarkup(React.createElement(DirectorBoard, { fr: buildFilm(preview(), "long"), storyTitle: "T", version: 0, dispatch: vi.fn(), onDirectorQa: vi.fn() }));
    expect(html).toContain(">Run Director QA</button>");
  });

  test("Regenerate still is blocked while a sequence operation runs", async () => {
    const { SlotInspector } = await import("../src/app/visualReview/Inspector.tsx");
    const fr = buildFilm(preview(), "long");
    const html = renderToStaticMarkup(React.createElement(SlotInspector, { fr, index: 1, dispatch: vi.fn(), onRegenerate: vi.fn(), regen: { running: null, failed: null, done: null, blocked: true } }));
    expect(html).toMatch(/<button[^>]*disabled[^>]*>.*Regenerate still/);
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
    expect(board.FLAG_LEGEND.map(([f]) => f)).toContain("ALTERNATING REUSE");
  });

  test("the board and its PNG legend show the new flag", async () => {
    const html = renderToStaticMarkup(React.createElement(DirectorBoardView, { board: board.buildDirectorBoard(seqFilm(["P", "A", "B", "A", "B", "Q", "R", "S", "T", "U"], 5)), storyTitle: "T", version: 0, dispatch: vi.fn(), filter: "all", onFilter: vi.fn(), copy: { kind: "idle" }, onCopy: vi.fn() }));
    expect(html).toContain(">ALTERNATING REUSE</dt>");
    expect(html).toContain('data-flag="ALTERNATING REUSE"');
    const r = recorder();
    await board.renderDirectorBoardPng(board.buildDirectorBoard(seqFilm(["P", "A", "B", "A", "B", "Q"], 5)), "T", url, r.deps);
    expect(r.text.join("\n")).toContain("ALTERNATING REUSE:");
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
  const qaView = (outcome: any) =>
    React.createElement(DirectorBoardView, {
      board: board.buildDirectorBoard(buildFilm(preview(), "long")), storyTitle: "T", version: 0, dispatch: vi.fn(), filter: "all", onFilter: vi.fn(), copy: { kind: "idle" }, onCopy: vi.fn(),
      qa: qaControls({ outcome }),
    });

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

  test("the result panel counts coordinated changes apart and never lists a fixed slot as unresolved", () => {
    const fixed = renderToStaticMarkup(
      qaView({ status: "complete", qa: report(), repair: { changed: [12], unresolved: [{ slotId: 6, reason: "No legal alternative existing presentation is available." }] }, cleanup: cleanNone, coordinated: { target: 6, changed: [4, 5, 6, 7, 8], humanReview: [], remaining: [] } }),
    );
    expect(fixed).toContain("Automatic Director changes: 1 · Automatic cleanup changes: 0 · Coordinated repair changes: 5 · Unresolved repairs: 0 · Needs human review: 0");
    expect(fixed).not.toContain("Auto repair unresolved");

    const failed = renderToStaticMarkup(
      qaView({
        status: "complete", qa: report(), repair: { changed: [], unresolved: [{ slotId: 6, reason: "r" }] }, cleanup: cleanNone,
        coordinated: { target: 6, changed: [], humanReview: [{ slotId: 6, reason: "Coordinated repair could not resolve Slot 06. The previous valid edit is kept. Invalid edit plan" }], remaining: [], error: "Invalid edit plan" },
      }),
    );
    expect(failed).toContain("Coordinated repair could not resolve Slot 06. The previous valid edit is kept.");
    expect(failed).toContain("Coordinated repair changes: 0 · Unresolved repairs: 0 · Needs human review: 1");
    expect(failed).toContain('role="alert"');
  });

  test("the phase label shows while coordinating", () => {
    const html = renderToStaticMarkup(
      React.createElement(DirectorBoardView, {
        board: board.buildDirectorBoard(buildFilm(preview(), "long")), storyTitle: "T", version: 0, dispatch: vi.fn(), filter: "all", onFilter: vi.fn(), copy: { kind: "idle" }, onCopy: vi.fn(),
        qa: qaControls({ phase: "coordinating" }),
      }),
    );
    expect(html).toMatch(/disabled=""[^>]*data-action="run-director-qa"[^>]*>Coordinating a repair…</);
  });
});

describe("final Director verification in Run Director QA", () => {
  const cleanNone = { ran: false, changed: [], unresolved: [], remaining: [] };
  const review = (over: Record<string, unknown> = {}) => ({ summary: "Initial summary about the old edit.", repairs: [], humanReview: [{ slotId: 8, reason: "group photo is repetitive" }], ...over }) as any;
  const verified = { summary: "Final summary of the current edit.", humanReview: [{ slotId: 8, reason: "the aerial landscape does not show the vote" }], patterns: [] };
  const render = (outcome: any) =>
    renderToStaticMarkup(
      React.createElement(DirectorBoardView, {
        board: board.buildDirectorBoard(buildFilm(preview(), "long")), storyTitle: "T", version: 0, dispatch: vi.fn(), filter: "all", onFilter: vi.fn(), copy: { kind: "idle" }, onCopy: vi.fn(),
        qa: qaControls({ outcome }),
      }),
    );

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

  test("stale regression: the panel shows only the verification's current findings and summary", () => {
    const html = render({ status: "complete", qa: review(), repair: { changed: [8], unresolved: [] }, cleanup: { ...cleanNone, remaining: [{ slotId: 7, reason: "ALTERNATING REUSE remains." }] }, coordinated: null, verify: verified });
    expect(html).toContain("Final Director verification complete");
    expect(html).toContain("the aerial landscape does not show the vote");
    expect(html).toContain("Final summary of the current edit.");
    expect(html).not.toContain("group photo"); // the initial review's finding about the old visual
    expect(html).not.toContain("Initial summary about the old edit.");
    expect(html).not.toContain("ALTERNATING REUSE remains."); // an earlier pattern the final film no longer has
    expect(html).toContain("Needs human review: 1");
  });

  test("a failed verification: the repaired edit is kept, current patterns stay, stale findings are not restored", () => {
    const html = render({
      status: "complete", qa: review(), repair: { changed: [8], unresolved: [] }, cleanup: cleanNone, coordinated: null,
      verify: { summary: "", humanReview: [], patterns: [{ slotId: 3, reason: "ADJACENT REUSE remains." }], error: "OpenAI responses 500" },
    });
    expect(html).toContain("Final Director verification failed.");
    expect(html).toContain("The repaired edit is kept.");
    expect(html).toContain("OpenAI responses 500");
    expect(html).toContain("ADJACENT REUSE remains.");
    expect(html).not.toContain("group photo");
    expect(html).not.toContain("Initial summary about the old edit.");
    expect(html).not.toContain("No automatic sequence repair was needed.");
    expect(html).toContain('role="alert"');
  });

  test("operational exceptions survive the verification; a verified slot's reasons are merged, not duplicated", () => {
    const html = render({
      status: "complete", qa: review(), repair: { changed: [], unresolved: [{ slotId: 6, reason: "r" }] }, cleanup: cleanNone,
      coordinated: { target: 6, changed: [], humanReview: [{ slotId: 6, reason: "Coordinated repair could not resolve Slot 06. The previous valid edit is kept. x" }], remaining: [], error: "x" },
      verify: { summary: "", humanReview: [{ slotId: 6, reason: "the slot still shows the vote count" }], patterns: [] },
    });
    expect(html).toContain("the slot still shows the vote count Coordinated repair could not resolve Slot 06.");
    expect(html.match(/data-qa-slot="6"/g)).toHaveLength(1);
  });

  test("the phase label shows while verifying", () => {
    const html = renderToStaticMarkup(
      React.createElement(DirectorBoardView, {
        board: board.buildDirectorBoard(buildFilm(preview(), "long")), storyTitle: "T", version: 0, dispatch: vi.fn(), filter: "all", onFilter: vi.fn(), copy: { kind: "idle" }, onCopy: vi.fn(),
        qa: qaControls({ phase: "verifying" }),
      }),
    );
    expect(html).toContain(">Final Director verification…</button>");
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

  test("the verification's graphic mismatch is shown even when no deterministic pattern remains", () => {
    const html = renderToStaticMarkup(
      React.createElement(DirectorBoardView, {
        board: board.buildDirectorBoard(buildFilm(preview(), "long")), storyTitle: "T", version: 0, dispatch: vi.fn(), filter: "all", onFilter: vi.fn(), copy: { kind: "idle" }, onCopy: vi.fn(),
        qa: qaControls({
          outcome: { status: "complete", qa: { summary: "Initial.", repairs: [], humanReview: [] }, repair: null, cleanup: cleanNone, coordinated: null, verify: { summary: "One factual graphic contradicts its narration.", humanReview: [{ slotId: 4, reason }], patterns: [] } },
        }),
      }),
    );
    expect(html).toContain(reason);
    expect(html).toContain('data-qa-slot="4"');
    expect(html).toContain("Needs human review: 1");
  });
});

describe("the Director board follows the server's Run Director QA state", () => {
  const view = (qa: any) =>
    renderToStaticMarkup(
      React.createElement(DirectorBoardView, { board: board.buildDirectorBoard(buildFilm(preview(), "long")), storyTitle: "T", version: 0, dispatch: vi.fn(), filter: "all", onFilter: vi.fn(), copy: { kind: "idle" }, onCopy: vi.fn(), qa }),
    );

  test("the board shows the persisted phase of a run, so a reload mid-run still shows it", () => {
    const html = renderToStaticMarkup(React.createElement(DirectorBoard, { fr: buildFilm(preview(), "long"), storyTitle: "T", version: 0, dispatch: vi.fn(), onDirectorQa: vi.fn(), directorQa: { status: "running", phase: "cleaning" } }));
    expect(html).toMatch(/disabled=""[^>]*data-action="run-director-qa"[^>]*>Cleaning up repetition…</);
    expect(html).not.toContain("data-qa-result");
  });

  test("an interrupted run says the saved edit is kept and invites a new run", () => {
    const html = view({ run: { status: "interrupted" }, onRun: vi.fn(), onSlot: vi.fn() });
    expect(html).toContain('data-qa-result="interrupted"');
    expect(html).toContain("Director QA was interrupted.");
    expect(html).toContain("The current saved edit is kept at the last completed valid step.");
    expect(html).toContain("Run Director QA again if you want to retry.");
    expect(html).toMatch(/data-action="run-director-qa"[^>]*>Run Director QA</);
    expect(html).not.toMatch(/disabled=""[^>]*data-action="run-director-qa"/);
  });

  test("a refused start is shown and changes nothing", () => {
    const html = view({ run: null, startError: "Director QA is running. Wait for it to finish.", onRun: vi.fn(), onSlot: vi.fn() });
    expect(html).toContain("Director QA did not start");
    expect(html).toContain("Director QA is running. Wait for it to finish.");
  });

  test("Run Director QA only starts the server run for this film; the Short board never shows the Long run", async () => {
    const onDirectorQa = vi.fn(async () => {});
    const find = (n: any, match: (el: any) => boolean): any => {
      if (Array.isArray(n)) return n.map((x) => find(x, match)).find(Boolean);
      if (!n || typeof n !== "object") return undefined;
      if (typeof n.type === "function") return find(n.type(n.props), match);
      if (match(n)) return n;
      return find(n.props?.children, match);
    };
    const qa = { run: null, onRun: () => onDirectorQa("short"), onSlot: vi.fn() };
    find(DirectorBoardView({ board: board.buildDirectorBoard(buildFilm(preview(), "short")), storyTitle: "T", version: 0, dispatch: vi.fn(), filter: "all", onFilter: vi.fn(), copy: { kind: "idle" }, onCopy: vi.fn(), qa } as any), (el) => el.props?.["data-action"] === "run-director-qa").props.onClick();
    expect(onDirectorQa.mock.calls).toEqual([["short"]]);
    const p = { preview: preview(), storyTitle: "T", version: 0, onBack: vi.fn(), onContinue: vi.fn(), onRebuild: vi.fn(), continuing: false, rebuilding: false, onRegenerate: vi.fn(), regen: idle, onDirectorQa, directorQa: { long: { status: "running", phase: "verifying" } } } as any;
    const films = { long: buildFilm(p.preview, "long"), short: buildFilm(p.preview, "short") };
    const html = (film: "long" | "short") => renderToStaticMarkup(React.createElement(ReviewView, { ...p, films, state: director(film), dispatch: () => {} }));
    expect(html("long")).toContain(">Final Director verification…</button>");
    expect(html("short")).toContain(">Run Director QA</button>");
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
