import { describe, test, expect, vi } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { PreviewFrame, VisualPreview } from "../src/types.ts";

// The visual-review workspace. Pure view-model and reducer tests, plus static
// renders; interactions are exercised by calling the rendered buttons' handlers.
// No server, no provider, no DOM.
const { buildFilm, initialReview, reviewReducer, stepAction, matchingSlots, canRegenerate, regenKey } = await import("../src/app/visualReview/model.ts");
const { VisualReview, ReviewView, ReviewHeader } = await import("../src/app/visualReview/VisualReview.tsx");
const { SlotInspector, AssetInspector } = await import("../src/app/visualReview/Inspector.tsx");

const img = (kind: string, n: number) => `stories/demo/images/${kind}-${n}.png`;
function frame(kind: "long" | "short", slot: number, over: Partial<PreviewFrame> = {}): PreviewFrame {
  return { kind, slot, path: img(kind, slot), truth: "reconstruction", motion: false, caption: "", edit: "new", framing: "wide", presentation: "base", startSec: slot * 4, durationSec: 4, ...over };
}

// Long: real slot ids 3..9 (earlier slots have no still yet), with
//   3 L01 owner (reconstruction, motion)  4 L02 archive owner  5 reuse of L01 detail
//   6 L03 graphic owner  7 reuse of L01  8 reuse of L02  9 L04 owner (motion)
// Short: 0 S01 owner, 1 reuse of S01, 2 S02 graphic owner.
function preview(): VisualPreview {
  const L01 = img("long", 3);
  const L02 = "stories/demo/archive/long-4.jpg";
  const frames: PreviewFrame[] = [
    frame("long", 3, { asset: "L01", motion: true }),
    frame("long", 4, { asset: "L02", truth: "archive", path: L02 }),
    frame("long", 5, { asset: "L01", edit: "reuse", path: L01, framing: "detail-left", presentation: "detail-left", focus: "the bow" }),
    frame("long", 6, { asset: "L03", truth: "graphic" }),
    frame("long", 7, { asset: "L01", edit: "reuse", path: L01 }),
    frame("long", 8, { asset: "L02", edit: "reuse", truth: "archive", path: L02 }),
    frame("long", 9, { asset: "L04", motion: true }),
    frame("short", 0, { asset: "S01" }),
    frame("short", 1, { asset: "S01", edit: "reuse", path: img("short", 0) }),
    frame("short", 2, { asset: "S02", truth: "graphic" }),
  ];
  return { moments: 10, uniqueAssets: 6, reusedPresentations: 4, archive: 1, reconstruction: 3, graphic: 2, motionSelected: 2, remainingMotionCost: 1.2, frames };
}

const idle = { running: null, failed: null, done: null };
function props(over: Record<string, unknown> = {}) {
  return { preview: preview(), version: 0, onBack: vi.fn(), onContinue: vi.fn(), onRebuild: vi.fn(), continuing: false, rebuilding: false, onRegenerate: vi.fn(), regen: idle, ...over } as any;
}
function view(state: any, over: Record<string, unknown> = {}) {
  const p = props(over);
  const films = { long: buildFilm(p.preview, "long"), short: buildFilm(p.preview, "short") };
  return { p, films, html: renderToStaticMarkup(React.createElement(ReviewView, { ...p, films, state, dispatch: () => {} })) };
}
const run = (...actions: any[]) => actions.reduce((s, a) => reviewReducer(s, a), initialReview(preview()));

// Expand a hook-free element tree (function components called directly) so a
// button's own onClick can be found by its text and invoked.
function expand(node: any): any {
  if (Array.isArray(node)) return node.map(expand);
  if (!React.isValidElement(node)) return node;
  const el: any = node;
  if (typeof el.type === "function") return expand(el.type(el.props));
  return { ...el, props: { ...el.props, children: expand(el.props.children) } };
}
const text = (node: any): string =>
  node == null || typeof node === "boolean" ? "" : Array.isArray(node) ? node.map(text).join("") : typeof node === "object" ? text(node.props?.children) : String(node);
function buttons(tree: any, label: string): any[] {
  const out: any[] = [];
  const walk = (n: any) => {
    if (Array.isArray(n)) return n.forEach(walk);
    if (!n || typeof n !== "object") return;
    if (n.type === "button" && text(n).includes(label)) out.push(n);
    walk(n.props?.children);
  };
  walk(expand(tree));
  return out;
}

describe("view model from the real preview frames", () => {
  test("owners, reuses and metrics are derived per film", () => {
    const long = buildFilm(preview(), "long");
    expect(long.frames.map((f) => f.slot)).toEqual([3, 4, 5, 6, 7, 8, 9]);
    expect(long.assets.map((a) => [a.id, a.owner, a.uses, a.truth, a.motion])).toEqual([
      ["L01", 0, [0, 2, 4], "reconstruction", true],
      ["L02", 1, [1, 5], "archive", false],
      ["L03", 3, [3], "graphic", false],
      ["L04", 6, [6], "reconstruction", true],
    ]);
    expect(long.metrics).toEqual({ assets: 4, reuses: 3, archive: 1, motion: 2 });
    expect(buildFilm(preview(), "short").metrics).toEqual({ assets: 2, reuses: 1, archive: 0, motion: 0 });
  });

  test("the slot that acquired an asset owns it even when a reuse is listed first", () => {
    const p = preview();
    p.frames = [frame("long", 0, { asset: "L09", edit: "reuse" }), frame("long", 1, { asset: "L09" })];
    const [a] = buildFilm(p, "long").assets;
    expect([a.owner, a.uses]).toEqual([1, [1, 0]]);
  });

  test("regenerate eligibility is the existing generated-owner rule", () => {
    const long = buildFilm(preview(), "long");
    expect(long.frames.map(canRegenerate)).toEqual([true, false, false, true, false, false, true]);
    expect(regenKey(long.frames[3])).toBe("long-6"); // the real edit slot id, not the list index
  });
});

describe("Long / Short", () => {
  test("defaults to Long and never mixes the films", () => {
    const html = renderToStaticMarkup(React.createElement(VisualReview, props()));
    expect(html).toContain('data-review-film="long"');
    expect(html).toMatch(/data-stage="long"[^>]*aspect-video/);
    expect(html.match(/data-strip="/g)).toHaveLength(7);
    expect(html).not.toContain("short-0.png");
    expect(html).toContain("Long documentary<span");
    expect(html).toContain(" · 7</span>");
    expect(html).toContain(" · 3</span>");
  });

  test("switching film swaps frames, metrics, strip, aspect and resets the filter", () => {
    const s = run({ type: "filter", filter: "motion" }, { type: "slot", index: 6 }, { type: "film", film: "short" });
    expect([s.film, s.filter, s.index.long, s.index.short]).toEqual(["short", "all", 6, 0]);
    const { html } = view(s);
    expect(html).toMatch(/data-stage="short"[^>]*aspect-\[9\/16\]/);
    expect(html).not.toContain('data-stage="long"');
    expect(html.match(/data-strip="/g)).toHaveLength(3);
    expect(html).toContain("width:46px");
    expect(html).not.toContain("long-3.png");
    expect(html).toMatch(/>2<\/span>assets/);
    // Back to Long: the Long position is kept.
    expect(reviewReducer(s, { type: "film", film: "long" }).index.long).toBe(6);
  });
});

describe("Sequence / Assets", () => {
  test("Sequence is the default; Assets shows each owner once", () => {
    expect(initialReview(preview()).mode).toBe("sequence");
    const { html } = view(run({ type: "mode", mode: "assets" }));
    expect(html).toContain('data-asset-grid="long"');
    expect(html.match(/data-asset-card="/g)).toHaveLength(4);
    expect(html).toContain("4 unique Long assets");
    expect(html).toContain("Used in 3 slots");
    expect(html).toContain("Used in 1 slot<");
    expect(html).not.toContain('data-stage="long"'); // grid, no stage until an asset is opened
    expect(html).not.toContain("data-filter="); // filters belong to Sequence
  });

  test("opening an asset shows it in the inspector with its owner and uses", () => {
    const s = run({ type: "asset", key: "L01" });
    const { html } = view(s);
    expect(html).toContain('data-inspector="asset"');
    expect(html).toContain("All 4 assets");
    expect(html).toContain("MOTION SELECTED");
    expect(html).toContain("1 / 4");
    expect(stepAction(s, buildFilm(preview(), "long"), 1)).toEqual({ type: "asset", key: "L02" });
    const fr = buildFilm(preview(), "long");
    const tree = React.createElement(AssetInspector, { fr, asset: fr.assets[0], dispatch: vi.fn(), regen: idle, onRegenerate: vi.fn() });
    const dispatch = vi.fn();
    const inspector = React.createElement(AssetInspector, { fr, asset: fr.assets[0], dispatch, regen: idle });
    buttons(inspector, "Slot 03")[0].props.onClick(); // the owner
    buttons(inspector, "07")[0].props.onClick(); // a use
    expect(dispatch.mock.calls).toEqual([[{ type: "slot", index: 0 }], [{ type: "slot", index: 4 }]]);
    expect(renderToStaticMarkup(tree)).toContain("Regenerate still");
    const archive = React.createElement(AssetInspector, { fr, asset: fr.assets[1], dispatch, regen: idle, onRegenerate: vi.fn() });
    expect(renderToStaticMarkup(archive)).not.toContain("Regenerate still");
    expect(renderToStaticMarkup(archive)).toContain("not regenerated");
  });
});

describe("owner and reuse", () => {
  const fr = buildFilm(preview(), "long");
  const inspect = (index: number, over: Record<string, unknown> = {}) => ({ fr, index, dispatch: vi.fn(), regen: idle, onRegenerate: vi.fn(), ...over }) as any;

  test("an owner reads ORIGINAL ASSET and lists where it is reused", () => {
    const html = renderToStaticMarkup(React.createElement(SlotInspector, inspect(0)));
    expect(html).toContain("ORIGINAL ASSET");
    expect(html).toContain("Reused in");
    expect(html).toContain("Slot 03");
    expect(html).toContain("Regenerate still");
    expect(html).toContain("Replaces L01 in all 3 slots that use it.");
  });

  test("a reuse names its asset and View original asset jumps to the real owning slot", () => {
    const p = inspect(2);
    const html = renderToStaticMarkup(React.createElement(SlotInspector, p));
    expect(html).toContain("REUSE OF L01");
    expect(html).toContain("View original asset · slot 03");
    expect(html).toContain("Detail left");
    expect(html).toContain("the bow");
    expect(html).not.toContain("Regenerate still");
    buttons(React.createElement(SlotInspector, p), "View original asset")[0].props.onClick();
    expect(p.dispatch).toHaveBeenCalledWith({ type: "slot", index: 0 });
    expect(reviewReducer(run({ type: "slot", index: 2 }), { type: "slot", index: 0 }).index.long).toBe(0);
  });

  test("archive owners and reuses never offer regeneration", () => {
    expect(renderToStaticMarkup(React.createElement(SlotInspector, inspect(1)))).not.toContain("Regenerate still");
    expect(renderToStaticMarkup(React.createElement(SlotInspector, inspect(5)))).not.toContain("Regenerate still");
    expect(renderToStaticMarkup(React.createElement(SlotInspector, inspect(4)))).not.toContain("Regenerate still");
  });
});

describe("filters and navigation", () => {
  const fr = buildFilm(preview(), "long");

  test("counts and Previous/Next step through the matching set only", () => {
    expect(["all", "owners", "motion", "archive", "graphics"].map((f: any) => matchingSlots(fr, f).length)).toEqual([7, 4, 2, 2, 1]);
    const s = run({ type: "filter", filter: "motion" });
    expect(stepAction(s, fr, 1)).toEqual({ type: "slot", index: 6 });
    expect(stepAction(reviewReducer(s, { type: "slot", index: 6 }), fr, 1)).toBeNull();
    const owners = run({ type: "filter", filter: "owners" }, { type: "slot", index: 1 });
    expect(stepAction(owners, fr, 1)).toEqual({ type: "slot", index: 3 });
    expect(stepAction(owners, fr, -1)).toEqual({ type: "slot", index: 0 });
    const html = view(reviewReducer(s, { type: "slot", index: 6 })).html;
    expect(html).toContain("Motion: 2 of 2");
  });

  test("a filter with no matches says so and offers Show all", () => {
    const p = preview();
    p.frames = p.frames.filter((f) => f.truth !== "graphic");
    const s = run({ type: "filter", filter: "graphics" });
    const films = { long: buildFilm(p, "long"), short: buildFilm(p, "short") };
    const html = renderToStaticMarkup(React.createElement(ReviewView, { ...props({ preview: p }), films, state: s, dispatch: () => {} }));
    expect(html).toContain("No graphics slots in this film.");
    expect(html).toContain("Show all");
    expect(stepAction(s, films.long, 1)).toBeNull();
    expect(reviewReducer(s, { type: "filter", filter: "all" }).filter).toBe("all");
  });

  test("navigation and filtering only change local state", () => {
    const p = preview();
    const before = JSON.stringify(p);
    const s = run({ type: "filter", filter: "archive" }, { type: "slot", index: 5 }, { type: "film", film: "short" }, { type: "mode", mode: "assets" }, { type: "asset", key: "S02" });
    renderToStaticMarkup(React.createElement(ReviewView, { ...props({ preview: p }), films: { long: buildFilm(p, "long"), short: buildFilm(p, "short") }, state: s, dispatch: () => {} }));
    expect(JSON.stringify(p)).toBe(before);
  });

  test("the current thumbnail carries the red active ring and every slot shows its truth letter", () => {
    const { html } = view(run({ type: "slot", index: 2 }));
    expect(html).toMatch(/data-strip="2" aria-current="true"[\s\S]*?box-shadow:0 0 0 2px #e50914/);
    expect(html.match(/data-reuse-icon/g)).toHaveLength(3);
    expect(html).toContain(">A</span>");
    expect(html).toContain(">G</span>");
    expect(html).toContain("3 / 7");
    expect(html).toContain("Slot 05 · 00:20");
  });

  test("visited slots count as reviewed, locally", () => {
    const s = run({ type: "slot", index: 2 }, { type: "slot", index: 4 }, { type: "slot", index: 2 });
    expect(s.visited.long).toEqual([0, 2, 4]);
    expect(view(s).html).toContain("3 / 7</span>");
    expect(reviewReducer(s, { type: "markAll", count: 7 }).visited.long).toHaveLength(7);
    expect(reviewReducer(s, { type: "film", film: "short" }).visited.short).toEqual([0]);
    // Switching film inside Assets, then back to Sequence, still counts the slot on screen.
    const back = run({ type: "mode", mode: "assets" }, { type: "film", film: "short" }, { type: "mode", mode: "sequence" });
    expect(back.visited.short).toEqual([0]);
  });
});

describe("regenerate and the existing actions", () => {
  test("the Regenerate button calls the existing handler with the owner frame", () => {
    const fr = buildFilm(preview(), "long");
    const onRegenerate = vi.fn();
    buttons(React.createElement(SlotInspector, { fr, index: 3, dispatch: vi.fn(), regen: idle, onRegenerate }), "Regenerate still")[0].props.onClick();
    expect(onRegenerate).toHaveBeenCalledWith(fr.frames[3]);
    expect(onRegenerate.mock.calls[0][0]).toMatchObject({ kind: "long", slot: 6, asset: "L03" });
  });

  test("regeneration keeps the review context and refreshes the image in place", () => {
    const s = run({ type: "slot", index: 2 });
    const running = view(s, { regen: { ...idle, running: "long-3" } }).html;
    expect(running).toContain("Regenerating L01…");
    expect(running).toMatch(/data-action="continue"[^>]*disabled/);
    expect(running).toMatch(/data-action="rebuild"[^>]*disabled/);
    // The job comes back with a new preview object; the same local state renders
    // the same slot, now with the cache-busted still.
    const after = view(s, { version: 1234, regen: { ...idle, done: "long-3" } }).html;
    expect(after).toContain("3 / 7");
    expect(after).toContain("REUSE OF L01");
    expect(after).toContain(`src="/media/${img("long", 3)}?v=1234"`);
  });

  test("a failed regeneration keeps the current still and offers Retry", () => {
    const fr = buildFilm(preview(), "long");
    const onRegenerate = vi.fn();
    const p = { fr, index: 0, dispatch: vi.fn(), regen: { ...idle, failed: { key: "long-3", message: "OpenAI image generation failed (500)" } }, onRegenerate };
    const html = renderToStaticMarkup(React.createElement(SlotInspector, p));
    expect(html).toContain("Could not regenerate this still. The current one is kept.");
    expect(html).toContain("OpenAI image generation failed (500)");
    buttons(React.createElement(SlotInspector, p), "Retry")[0].props.onClick();
    expect(onRegenerate).toHaveBeenCalledWith(fr.frames[0]);
    expect(view(run(), { regen: p.regen }).html).toContain(`src="/media/${img("long", 3)}"`);
  });

  test("Continue and Rebuild call the existing handlers, and back returns to the story", () => {
    const p = props();
    const films = { long: buildFilm(p.preview, "long"), short: buildFilm(p.preview, "short") };
    const header = React.createElement(ReviewHeader, { ...p, films, state: run(), dispatch: vi.fn(), fr: films.long });
    const cont = buttons(header, "Continue");
    expect(cont).toHaveLength(2); // desktop and the compact mobile header
    cont[0].props.onClick();
    buttons(header, "Rebuild visuals")[0].props.onClick();
    buttons(header, "Back to story")[0].props.onClick();
    expect(p.onContinue).toHaveBeenCalledTimes(1);
    expect(p.onRebuild).toHaveBeenCalledTimes(1);
    expect(p.onBack).toHaveBeenCalledTimes(1);
    const html = renderToStaticMarkup(header);
    expect(html).toContain("est. $1.20 remaining motion (both films)");
    const busy = renderToStaticMarkup(React.createElement(ReviewHeader, { ...p, continuing: true, films, state: run(), dispatch: vi.fn(), fr: films.long }));
    expect(busy).toContain("Continuing…");
    expect(busy).toMatch(/data-action="rebuild"[^>]*disabled/);
  });
});
