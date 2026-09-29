import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import type { PreviewFrame, VisualPreview } from "../src/types.ts";

// Change visual from an issue is structurally about the issue's slot: the slot
// travels as targetSlot from the screen to the request, and the feedback text is
// never read for it. Without a DOM, a tiny useState stand-in keeps the hook's
// state between "renders" so open / type / submit run through the real code.
const hooks = vi.hoisted(() => ({ states: [] as unknown[], i: 0 }));
vi.mock("react", async (importOriginal) => {
  const React: any = await importOriginal();
  const useState = (init: unknown) => {
    const k = hooks.i++;
    if (!(k in hooks.states)) hooks.states[k] = typeof init === "function" ? (init as () => unknown)() : init;
    return [hooks.states[k], (v: unknown) => (hooks.states[k] = typeof v === "function" ? (v as (p: unknown) => unknown)(hooks.states[k]) : v)];
  };
  return { ...React, default: { ...React.default, useState }, useState };
});

const React = (await import("react")).default;
const { renderToStaticMarkup } = await import("react-dom/server");
const { VisualIssuePanel } = await import("../src/app/visualReview/IssueView.tsx");
const { useSequenceRevise, ChangeVisualForm, SEQUENCE_FAILED } = await import("../src/app/visualReview/changeVisual.tsx");
const { visualIssuesForJob } = await import("../src/app/visualReview/visualIssues.ts");
const { buildFilm } = await import("../src/app/visualReview/model.ts");
const { api } = await import("../src/app/api.ts");

const img = (kind: string, n: number) => `stories/demo/images/${kind}-${n}.png`;
function frame(kind: "long" | "short", slot: number, over: Partial<PreviewFrame> = {}): PreviewFrame {
  return { kind, slot, path: img(kind, slot), truth: "reconstruction", motion: false, caption: "", edit: "new", framing: "wide", presentation: "base", startSec: slot * 4, durationSec: 4, ...over };
}
// Long slots 29..32; slot 31 is an archive image.
function preview(): VisualPreview {
  const frames = [
    frame("long", 29, { asset: "L01" }),
    frame("long", 30, { asset: "L02" }),
    frame("long", 31, { asset: "L03", truth: "archive", path: "stories/demo/archive/long-31.jpg" }),
    frame("long", 32, { asset: "L04", truth: "graphic" }),
    frame("short", 0, { asset: "S01" }),
  ];
  return { moments: 5, archive: 1, reconstruction: 3, graphic: 1, motionSelected: 0, remainingMotionCost: 0, frames };
}
const films = () => ({ long: buildFilm(preview(), "long"), short: buildFilm(preview(), "short") });
const assetQa = (issues: unknown[]) => ({ status: "done", reviewed: 5, regenerated: 0, incomplete: 0, message: "", issues, clean: false }) as any;

beforeEach(() => {
  hooks.states = [];
  hooks.i = 0;
});

// Render the issue screen's controls: the Panel returns the view with its `revise`.
function panel(issue: any, onReviseSequence: any) {
  hooks.i = 0;
  const el: any = (VisualIssuePanel as any)({ issue, position: { index: 0, total: 1 }, films: films(), version: 0, onBack: vi.fn(), onRegenerate: vi.fn(), regen: { running: null, failed: null, done: null }, busy: false, more: null, onReviseSequence });
  return el.props.revise;
}

describe("Change visual from an issue", () => {
  const archive = () => visualIssuesForJob({ preview: preview(), assetQa: assetQa([{ kind: "long", assetId: "L03", truth: "archive", stage: "review", reason: "Shows a patch, not the airfield." }]) })[0];

  test("1, 2. the issue's own slot is sent as targetSlot, whatever the feedback text says", async () => {
    const issue = archive();
    expect(issue).toMatchObject({ fix: "change", where: "Long · Slot 31 · 02:04" });
    const revise = vi.fn(async () => ({ changed: [31], unresolved: [] }));
    panel(issue, revise).onOpen("Slot 31: Shows a patch, not the airfield.");
    // The person rewrites the text, naming other slots; the target stays 31.
    panel(issue, revise).onFeedback("Slot 40: use a hangar. Also fix slot 39.");
    await panel(issue, revise).onSubmit();
    expect(revise.mock.calls).toEqual([["long", "Slot 40: use a hangar. Also fix slot 39.", 31]]);
  });

  test("a Director QA slot issue sends its slot as the target too", async () => {
    const issue = visualIssuesForJob({ preview: preview(), directorQa: { long: { status: "complete", verified: true, automaticChanges: 0, cleanupChanges: 0, coordinatedChanges: 0, changed: [], unresolvedRepairs: [], requestedRepairs: [], humanReview: [{ slotId: 30, reason: "Wrong place." }], summary: "", clean: false } } as any })[0];
    const revise = vi.fn(async () => ({ changed: [], unresolved: [] }));
    panel(issue, revise).onOpen("Something else.");
    await panel(issue, revise).onSubmit();
    expect(revise.mock.calls).toEqual([["long", "Something else.", 30]]);
  });

  test("3. looking through a film, Change visual still sends no target", async () => {
    const revise = vi.fn(async () => ({ changed: [], unresolved: [] }));
    const controls = () => ((hooks.i = 0), useSequenceRevise("short", revise, false)!); // as VisualReview calls it
    controls().onOpen("Slot 00: ");
    controls().onFeedback("Slot 00: another angle.");
    await controls().onSubmit();
    expect(revise.mock.calls).toEqual([["short", "Slot 00: another angle."]]);
  });

  test("10. a failed change shows plain words, never the engine's, and keeps the typed text", async () => {
    const issue = archive();
    const raw = 'Invalid edit plan: long slot 40 (x) presentationId "L13:base" repeats slot 39; adjacent slots must not show the identical presentation.';
    const revise = vi.fn(async () => Promise.reject(new Error(raw)));
    panel(issue, revise).onOpen("Slot 31: use the hangars.");
    await panel(issue, revise).onSubmit();
    const controls = panel(issue, revise);
    expect(controls).toMatchObject({ open: true, feedback: "Slot 31: use the hangars.", notice: { kind: "failed", message: SEQUENCE_FAILED } });
    const html = renderToStaticMarkup(React.createElement(ChangeVisualForm, { revise: controls, film: "long" }));
    expect(html).toContain("The visual could not be changed. The current film was kept.");
    expect(html).toMatch(/<textarea[^>]*>Slot 31: use the hangars\.<\/textarea>/); // ready to retry
    for (const leak of ["Invalid edit plan", "presentationId", "adjacent slots", "L13:base"]) expect(html).not.toContain(leak);
  });

  test("a successful change still shows the revision's own unresolved result", async () => {
    const issue = archive();
    const revise = vi.fn(async () => ({ changed: [], unresolved: [{ slotId: 31, reason: "No legal alternative existing presentation is available." }] }));
    panel(issue, revise).onOpen("Slot 31: use the hangars.");
    await panel(issue, revise).onSubmit();
    const html = renderToStaticMarkup(React.createElement(ChangeVisualForm, { revise: panel(issue, revise), film: "long" }));
    expect(html).toContain("Nothing was changed");
    expect(html).toContain("Slot 31 could not change: No legal alternative existing presentation is available.");
  });
});

describe("4. api.reviseSequence", () => {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify({ job: {}, revision: { changed: [], unresolved: [] } }), { status: 200 }));
  beforeEach(() => {
    fetchMock.mockClear();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());
  const body = () => JSON.parse((fetchMock.mock.calls[0] as any)[1].body);

  test("sends targetSlot only when one is supplied", async () => {
    await api.reviseSequence("j1", "long", "Change it.");
    expect(body()).toEqual({ kind: "long", directorFeedback: "Change it." });
    fetchMock.mockClear();
    await api.reviseSequence("j1", "long", "Change it.", undefined);
    expect(body()).toEqual({ kind: "long", directorFeedback: "Change it." });
    fetchMock.mockClear();
    await api.reviseSequence("j1", "long", "Change it.", 31);
    expect(body()).toEqual({ kind: "long", directorFeedback: "Change it.", targetSlot: 31 });
    expect((fetchMock.mock.calls[0] as any)[0]).toBe("/api/jobs/j1/revise-sequence");
  });
});
