import { describe, test, expect, vi } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { PreviewFrame, VisualPreview } from "../src/types.ts";

// The film view: look through a film slot by slot and make the two creative
// changes (Regenerate image, Change visual). Pure view-model and reducer tests,
// plus static renders; interactions call the rendered buttons' own handlers.
// No server, no provider, no DOM.
const { buildFilm, initialReview, reviewReducer, stepAction, canRegenerate, regenKey } = await import("../src/app/visualReview/model.ts");
const { VisualReview, ReviewView } = await import("../src/app/visualReview/VisualReview.tsx");
const { ShotPanel } = await import("../src/app/visualReview/Inspector.tsx");

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
  test("owners and reuses are derived per film", () => {
    const long = buildFilm(preview(), "long");
    expect(long.frames.map((f) => f.slot)).toEqual([3, 4, 5, 6, 7, 8, 9]);
    expect(long.assets.map((a) => [a.id, a.owner, a.uses, a.truth, a.motion])).toEqual([
      ["L01", 0, [0, 2, 4], "reconstruction", true],
      ["L02", 1, [1, 5], "archive", false],
      ["L03", 3, [3], "graphic", false],
      ["L04", 6, [6], "reconstruction", true],
    ]);
    expect(buildFilm(preview(), "short").assets.map((a) => a.id)).toEqual(["S01", "S02"]);
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

describe("the film view", () => {
  test("opens on Long and never mixes the films", () => {
    const html = renderToStaticMarkup(React.createElement(VisualReview, props()));
    expect(html).toContain('data-review-film="long"');
    expect(html).toMatch(/data-stage="long"[^>]*aspect-video/);
    expect(html.match(/data-strip="/g)).toHaveLength(7);
    expect(html).not.toContain("short-0.png");
    expect(html).toContain(">Long documentary</button>");
    expect(html).toContain("1 / 7");
  });

  test("opens on the slot it was sent to", () => {
    const html = renderToStaticMarkup(React.createElement(VisualReview, props({ target: { film: "short", index: 2 } })));
    expect(html).toContain('data-review-film="short"');
    expect(html).toMatch(/data-stage="short"[^>]*aspect-\[9\/16\]/);
    expect(html).toContain("3 / 3");
    expect(html.match(/data-strip="/g)).toHaveLength(3);
  });

  test("switching film keeps each film's own position; Previous/Next step one slot", () => {
    const s = run({ type: "slot", index: 6 }, { type: "film", film: "short" });
    expect([s.film, s.index.long, s.index.short]).toEqual(["short", 6, 0]);
    expect(reviewReducer(s, { type: "film", film: "long" }).index.long).toBe(6);
    const fr = buildFilm(preview(), "long");
    expect(stepAction(run(), fr, 1)).toEqual({ type: "slot", index: 1 });
    expect(stepAction(run(), fr, -1)).toBeNull();
    expect(stepAction(run({ type: "slot", index: 6 }), fr, 1)).toBeNull();
    const { html } = view(run({ type: "slot", index: 2 }));
    expect(html).toMatch(/data-strip="2" aria-current="true"[\s\S]*?box-shadow:0 0 0 2px #e50914/);
    expect(html).toContain("3 / 7");
    expect(html).toContain("Slot 05 · 00:20");
  });

  test("no engine vocabulary: no modes, filters, board, metrics, owner or reuse labels, truth letters or motion markers", () => {
    const { html } = view(run({ type: "slot", index: 2 }), { onReviseSequence: vi.fn() });
    for (const s of ["Sequence", "Assets", "Director", "data-mode-tab", "data-filter", "Owners", "Archive <", "Graphics", "Motion", "MOTION", "Attention", "Flagged", "ORIGINAL ASSET", "REUSE OF", "base view", "data-reuse-icon", ">A</span>", ">G</span>", "Rebuild", "Continue", "Run Director QA", "Copy Director Board", "Reviewed", "Mark all"]) {
      expect(html).not.toContain(s);
    }
  });

  test("the slot panel speaks plainly: when, what kind of image, where else it appears, what is on screen", () => {
    const fr = buildFilm(preview(), "long");
    const owner = renderToStaticMarkup(React.createElement(ShotPanel, { fr, index: 0, regen: idle, onRegenerate: vi.fn() }));
    expect(owner).toContain("Slot 03");
    expect(owner).toContain("Generated image");
    expect(owner).toContain("The same image appears in slots 05, 07.");
    const archive = renderToStaticMarkup(React.createElement(ShotPanel, { fr, index: 5, regen: idle, onRegenerate: vi.fn() }));
    expect(archive).toContain("Archive photograph");
    expect(archive).toContain("An archive photograph is used as found. It is not regenerated.");
    expect(archive).not.toContain("Regenerate image");
    const p = preview();
    p.frames[3] = { ...p.frames[3], caption: "The harbour, 1859" };
    expect(renderToStaticMarkup(React.createElement(ShotPanel, { fr: buildFilm(p, "long"), index: 3, regen: idle }))).toContain("The harbour, 1859");
  });

  test("Change visual appears only when wired, started from the current slot", () => {
    expect(view(run({ type: "slot", index: 2 }), { onReviseSequence: vi.fn() }).html).toContain('data-action="change-visual"');
    expect(view(run()).html).not.toContain("Change visual");
  });

  test("navigation only changes local state", () => {
    const p = preview();
    const before = JSON.stringify(p);
    const s = run({ type: "slot", index: 5 }, { type: "film", film: "short" }, { type: "slot", index: 1 });
    renderToStaticMarkup(React.createElement(ReviewView, { ...props({ preview: p }), films: { long: buildFilm(p, "long"), short: buildFilm(p, "short") }, state: s, dispatch: () => {} }));
    expect(JSON.stringify(p)).toBe(before);
  });
});

describe("Regenerate image", () => {
  const fr = buildFilm(preview(), "long");
  const panel = (index: number, over: Record<string, unknown> = {}) => ({ fr, index, regen: idle, onRegenerate: vi.fn(), ...over }) as any;

  test("offered wherever the slot shows a generated image; a shared image is regenerated once, for every slot", () => {
    const offered = fr.frames.map((_, i) => renderToStaticMarkup(React.createElement(ShotPanel, panel(i))).includes("Regenerate image"));
    expect(offered).toEqual([true, false, true, true, true, false, true]); // the archive L02 slots never
    const p = panel(2); // a reuse of L01
    buttons(React.createElement(ShotPanel, p), "Regenerate image")[0].props.onClick();
    expect(p.onRegenerate).toHaveBeenCalledWith(fr.frames[0]); // the owner still, through the existing handler
    expect(renderToStaticMarkup(React.createElement(ShotPanel, p))).toContain("Replaces this image in all 3 slots that use it.");
    expect(renderToStaticMarkup(React.createElement(ShotPanel, panel(0, { onRegenerate: undefined })))).not.toContain("Regenerate image");
  });

  test("regeneration keeps the slot on screen and refreshes the image in place", () => {
    const s = run({ type: "slot", index: 2 });
    const running = view(s, { regen: { ...idle, running: "long-3" } }).html;
    expect(running).toContain("Regenerating… the current image stays until the new one is ready");
    expect(running).toMatch(/<button[^>]*disabled=""[^>]*>.*Regenerating…/);
    const after = view(s, { version: 1234, regen: { ...idle, done: "long-3" } }).html;
    expect(after).toContain("3 / 7");
    expect(after).toContain(`src="/media/${img("long", 3)}?v=1234"`);
    expect(after).toContain("New image in place");
  });

  test("a failed regeneration keeps the current image and offers Retry", () => {
    const onRegenerate = vi.fn();
    const p = panel(0, { regen: { ...idle, failed: { key: "long-3", message: "OpenAI image generation failed (500)" } }, onRegenerate });
    const html = renderToStaticMarkup(React.createElement(ShotPanel, p));
    expect(html).toContain("Could not regenerate this image. The current one is kept.");
    expect(html).not.toContain("OpenAI image generation failed"); // the raw provider error is not product copy
    buttons(React.createElement(ShotPanel, p), "Retry")[0].props.onClick();
    expect(onRegenerate).toHaveBeenCalledWith(fr.frames[0]);
  });

  describe("what should change (optional note)", () => {
    // Long index 0 is L01 (slot 3, key long-3), a reconstruction owner used in 3 slots.
    const note = (over: Record<string, unknown> = {}) => {
      const p = panel(0, { onDraft: vi.fn(), draft: null, ...over });
      return { p, el: React.createElement(ShotPanel, p), html: renderToStaticMarkup(React.createElement(ShotPanel, p)) };
    };
    const lastButton = (el: any, label: string) => buttons(el, label).at(-1);

    test("Regenerate image opens the note and calls nothing", () => {
      const { p, el, html } = note();
      expect(html).not.toContain("<textarea");
      buttons(el, "Regenerate image")[0].props.onClick();
      expect(p.onDraft).toHaveBeenCalledWith({ key: "long-3", text: "" });
      expect(p.onRegenerate).not.toHaveBeenCalled();
    });

    test("the open note keeps the replace-everywhere line, and Cancel only closes", () => {
      const { p, el, html } = note({ draft: { key: "long-3", text: "Fix the sign." } });
      expect(html).toContain("What should change? (optional)");
      expect(html).toMatch(/<textarea[^>]*>Fix the sign\.<\/textarea>/);
      expect(html).toContain("Replaces this image in all 3 slots that use it.");
      buttons(el, "Cancel")[0].props.onClick();
      expect(p.onDraft).toHaveBeenCalledWith(null);
      expect(p.onRegenerate).not.toHaveBeenCalled();
    });

    test("a blank note regenerates as planned; text is trimmed and sent", () => {
      const blank = note({ draft: { key: "long-3", text: "  \n " } });
      lastButton(blank.el, "Regenerate image").props.onClick();
      expect(blank.p.onRegenerate.mock.calls).toEqual([[fr.frames[0], undefined]]);
      const withNote = note({ draft: { key: "long-3", text: "  Remove the emblem.\n" } });
      lastButton(withNote.el, "Regenerate image").props.onClick();
      expect(withNote.p.onRegenerate.mock.calls).toEqual([[fr.frames[0], "Remove the emblem."]]);
    });

    test("while regenerating, the note and its buttons are disabled", () => {
      const { html } = note({ draft: { key: "long-3", text: "Remove the emblem." }, regen: { ...idle, running: "long-3" } });
      expect(html).toMatch(/<textarea[^>]*disabled=""/);
      expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Cancel/);
      expect(html).toMatch(/<button[^>]*disabled=""[^>]*>.*Regenerating…/);
    });

    test("over 2,000 characters says so and cannot be sent", () => {
      const { p, el, html } = note({ draft: { key: "long-3", text: "x".repeat(2001) } });
      expect(html).toContain("Director feedback must be 2,000 characters or fewer.");
      const submit = lastButton(el, "Regenerate image");
      expect(submit.props.disabled).toBe(true);
      submit.props.onClick();
      expect(p.onRegenerate).not.toHaveBeenCalled();
    });

    test("a failure keeps the image and the note, and Retry resends it", () => {
      const { p, el, html } = note({ draft: { key: "long-3", text: "Remove the emblem." }, regen: { ...idle, failed: { key: "long-3", message: "OpenAI image 500" } } });
      expect(html).toContain("Could not regenerate this image. The current one is kept.");
      expect(html).toMatch(/<textarea[^>]*>Remove the emblem\.<\/textarea>/);
      buttons(el, "Retry")[0].props.onClick();
      expect(p.onRegenerate.mock.calls).toEqual([[fr.frames[0], "Remove the emblem."]]);
    });

    test("another image's note does not open on this one", () => {
      expect(note({ draft: { key: "long-6", text: "x" } }).html).not.toContain("<textarea");
    });
  });
});
