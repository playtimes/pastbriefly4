import { describe, test, expect, vi } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { DirectorQaRun, FinalQaIssue, Job, PreviewFrame, Video, VisualPreview } from "../src/types.ts";

// The Production screen's presentation: the six stages, honest progress, the
// issue-first exception faces, the simple issue views, the visual issue mapper,
// the film view behind them and the persistent Ready face. Pure helpers
// and static renders; buttons' own handlers are invoked directly. No server, no
// provider, no DOM.
const stage = await import("../src/app/productionStage.ts");
const { visualIssues, visualIssuesForJob, issueFrame, plain } = await import("../src/app/visualReview/visualIssues.ts");
const { submitSequenceRevision } = await import("../src/app/visualReview/changeVisual.tsx");
const { buildFilm, initialReview } = await import("../src/app/visualReview/model.ts");
const { TextException, TextMore, VisualException, VisualMore, FinalException, FinalFilmReview, finalRenderUrl, ReadyPanel, ProductionProgress, SECTION_TAB } = await import("../src/app/screens/Production.tsx");
const { VisualIssueView, VisualIssuePanel } = await import("../src/app/visualReview/IssueView.tsx");
const { VisualReview, ReviewView } = await import("../src/app/visualReview/VisualReview.tsx");

// ---- helpers

function job(over: Partial<Job> = {}): Job {
  return { id: "j1", storyId: "s", state: "running", step: "research", message: "", error: null, mock: false, estimatedCost: 5, approvedMax: 6, spent: 2.14, preview: null, createdAt: "", updatedAt: "", ...over } as Job;
}

// Expand a hook-free element tree (function components called directly) so a
// button's own onClick can be found by its text and invoked.
function expand(node: any): any {
  if (Array.isArray(node)) return node.map(expand);
  if (!React.isValidElement(node)) return node;
  const el: any = node;
  if (typeof el.type === "function") return expand(el.type(el.props));
  return { ...el, props: { ...el.props, children: expand(el.props.children) } };
}
const text = (n: any): string =>
  n == null || typeof n === "boolean" ? "" : Array.isArray(n) ? n.map(text).join("") : typeof n === "object" ? text(n.props?.children) : String(n);
function buttons(tree: any, label: string | RegExp): any[] {
  const out: any[] = [];
  const walk = (n: any) => {
    if (Array.isArray(n)) return n.forEach(walk);
    if (!n || typeof n !== "object") return;
    if (n.type === "button" && (typeof label === "string" ? text(n) === label : label.test(text(n)))) out.push(n);
    walk(n.props?.children);
  };
  walk(expand(tree));
  return out;
}
// The markup outside every More menu: what the user sees by default.
function visible(html: string): string {
  let out = "";
  let at = 0;
  for (let start = html.indexOf("<details class=\"relative\" data-more"); start >= 0; start = html.indexOf("<details class=\"relative\" data-more", at)) {
    out += html.slice(at, start);
    // Skip to the matching </details>, counting nested disclosures.
    let depth = 0;
    const tag = /<details[\s>]|<\/details>/g;
    tag.lastIndex = start;
    for (let m = tag.exec(html); m; m = tag.exec(html)) {
      depth += m[0] === "</details>" ? -1 : 1;
      if (depth === 0) {
        at = m.index + m[0].length;
        break;
      }
    }
  }
  return out + html.slice(at);
}

const img = (kind: string, n: number) => `stories/demo/images/${kind}-${n}.png`;
function frame(kind: "long" | "short", slot: number, over: Partial<PreviewFrame> = {}): PreviewFrame {
  return { kind, slot, path: img(kind, slot), truth: "reconstruction", motion: false, caption: "", edit: "new", framing: "wide", presentation: "base", startSec: slot * 4, durationSec: 4, ...over };
}
// Long: slots 3..6 (L01 owner, L02 archive, reuse L01, L03 graphic). Short: 0..1.
function preview(): VisualPreview {
  const frames: PreviewFrame[] = [
    frame("long", 3, { asset: "L01" }),
    frame("long", 4, { asset: "L02", truth: "archive", path: "stories/demo/archive/long-4.jpg" }),
    frame("long", 5, { asset: "L01", edit: "reuse", path: img("long", 3) }),
    frame("long", 6, { asset: "L03", truth: "graphic" }),
    frame("short", 0, { asset: "S01" }),
    frame("short", 1, { asset: "S02" }),
  ];
  return { moments: 6, archive: 1, reconstruction: 4, graphic: 1, motionSelected: 0, remainingMotionCost: 0, frames };
}
const films = () => ({ long: buildFilm(preview(), "long"), short: buildFilm(preview(), "short") });
function complete(over: Partial<Extract<DirectorQaRun, { status: "complete" }>> = {}): DirectorQaRun {
  return { status: "complete", verified: true, automaticChanges: 0, cleanupChanges: 0, coordinatedChanges: 0, changed: [], unresolvedRepairs: [], requestedRepairs: [], humanReview: [], summary: "", clean: true, ...over };
}
const assetDone = (issues: any[], over: Record<string, unknown> = {}) => ({ status: "done", reviewed: 6, regenerated: 0, incomplete: 0, message: "Asset QA needs you.", issues, clean: !issues.length, ...over }) as any;

// ---------------------------------------------------------------------------

describe("six production stages", () => {
  const j = (state: any, step: any, over: Partial<Job> = {}) => job({ state, step, ...over });
  test("the unchanged job state maps to six human stages", () => {
    const cases: [any, any, string][] = [
      ["queued", "queued", "research"],
      ["running", "research", "research"],
      ["running", "scripts", "writing"],
      ["awaiting_text", "scripts", "writing"], // Text QA review, repair and final verification
      ["running", "narration", "narration"],
      ["running", "archive", "visuals"],
      ["running", "stills", "visuals"],
      ["awaiting_preview", "stills", "checking"], // Asset QA, Visual Autopilot
      ["awaiting_preview", "preview", "checking"], // Long and Short Director QA
      ["running", "build", "rendering"],
      ["running", "rendering", "rendering"],
      ["running", "finishing", "rendering"],
    ];
    for (const [state, step, want] of cases) expect([state, step, stage.displayStage(j(state, step))]).toEqual([state, step, want]);
    expect(stage.DISPLAY_STAGES.map(([, l]) => l)).toEqual(["Researching", "Writing", "Recording narration", "Creating visuals", "Checking films", "Rendering"]);
  });

  test("Text QA and every visual QA phase stay in their parent stage", () => {
    for (const phase of ["review", "repair", "verify"] as const) expect(stage.displayStage(j("awaiting_text", "scripts", { textQa: { status: "running", phase } }))).toBe("writing");
    expect(stage.displayStage(j("awaiting_preview", "preview", { assetQa: { status: "running", phase: "repair", current: 2, total: 3 } }))).toBe("checking");
    expect(stage.displayStage(j("awaiting_preview", "preview", { visualAutopilot: { status: "running" }, directorQa: { long: { status: "running", phase: "coordinating" } } }))).toBe("checking");
    expect(stage.displayStage(j("awaiting_preview", "preview", { directorQa: { long: complete(), short: { status: "running", phase: "verifying" } } }))).toBe("checking");
  });

  test("a requeued job resumes where it is, never back at Researching", () => {
    expect(stage.displayStage(j("queued", "queued", { textQa: { status: "passed" } }))).toBe("narration"); // Text QA approved
    expect(stage.displayStage(j("queued", "queued"), "writing")).toBe("writing"); // approved by hand at the text gate
    expect(stage.displayStage(j("queued", "queued", { preview: preview() }), "checking")).toBe("rendering"); // approved visuals
    expect(stage.displayStage(j("queued", "queued", { message: "Rebuilding visuals" }), "checking")).toBe("visuals");
    expect(stage.displayStage(j("queued", "narration"))).toBe("narration"); // a retry keeps its step
    expect(stage.stageLabel(j("queued", "queued"))).toBe("Starting");
    expect(stage.stageLabel(j("queued", "queued", { textQa: { status: "passed" } }))).toBe("Recording narration");
    expect(stage.stageIndex(j("done", "finishing"))).toBe(6);
  });

  test("after the render, finishing reads Checking final films, still the last stage: the bar never jumps back", () => {
    expect(stage.stageLabel(j("running", "rendering"))).toBe("Rendering");
    for (const state of ["running", "queued"] as const) {
      expect(stage.stageLabel(j(state, "finishing"))).toBe("Checking final films"); // queued: Retry or Continue anyway
      expect(stage.stageIndex(j(state, "finishing"))).toBe(stage.stageIndex(j("running", "rendering")));
    }
    const html = renderToStaticMarkup(React.createElement(ProductionProgress, { job: j("running", "finishing") }));
    expect(html).toContain("Checking final films…</h1>");
    expect(html).toContain("Step 6 of 6<");
    expect(html).not.toContain("Rendering…");
  });

  test("QA gates never show the previous step's finished count", () => {
    expect(stage.stageProgress(j("awaiting_text", "scripts", { progress: { current: 2, total: 2 }, textQa: { status: "running", phase: "review" } }))).toBeNull();
    expect(stage.stageProgress(j("awaiting_preview", "stills", { progress: { current: 12, total: 12 }, assetQa: { status: "running", phase: "review" } }))).toBeNull();
    expect(stage.stageProgress(j("awaiting_preview", "stills", { progress: { current: 7, total: 12 } }))).toBeNull();
    expect(stage.stageProgress(j("queued", "stills", { progress: { current: 3, total: 12 } }))).toBeNull();
    // A running step's own count describes its stage.
    expect(stage.stageProgress(j("running", "stills", { progress: { current: 3, total: 12 } }))).toBe(25);
    expect(stage.stageProgress(j("running", "narration", { progress: { current: 1, total: 2 } }))).toBe(50);
    expect(stage.stageProgress(j("running", "rendering", { progress: { current: 40, total: 100, percent: true } }))).toBe(40);
    // A full count means uncounted work (the audit, the hand-off) is running.
    expect(stage.stageProgress(j("running", "scripts", { progress: { current: 2, total: 2 } }))).toBeNull();
    // Part-stage counts would make the bar jump backwards.
    expect(stage.stageProgress(j("running", "archive", { progress: { current: 4, total: 4 } }))).toBeNull();
    expect(stage.stageProgress(j("running", "build", { progress: { current: 1, total: 3 } }))).toBeNull();
  });

  test("the running face: the stage, step n of 6, a figure only when honest; stages and internals folded away", () => {
    const html = renderToStaticMarkup(React.createElement(ProductionProgress, { job: j("awaiting_preview", "stills", { progress: { current: 12, total: 12 }, assetQa: { status: "running", phase: "repair", current: 2, total: 3 } }), storyTitle: "The War Over a Pig" }));
    expect(html).toContain("In production · The War Over a Pig");
    expect(html).toContain("Checking films…</h1>");
    expect(html).toContain("Step 5 of 6<");
    expect(html.match(/<li /g)).toHaveLength(6); // exactly six stages, under Show stages
    const shown = html.slice(0, html.indexOf("<details"));
    for (const s of ["Repairing", "2 of 3", "12 / 12", "%", "Asset QA", "Director QA", "Text QA", "$"]) expect(shown).not.toContain(s);
    expect(html).toMatch(/<details[^>]*><summary[^>]*>Show stages<\/summary>/);
    const stills = renderToStaticMarkup(React.createElement(ProductionProgress, { job: j("running", "stills", { progress: { current: 3, total: 12 } }) }));
    expect(stills).toContain("Creating visuals…</h1>");
    expect(stills).toContain("Step 4 of 6 · 25%");
    expect(stills).not.toContain("3 / 12");
  });
});

// ---------------------------------------------------------------------------

describe("Text needs you", () => {
  const qa = {
    status: "stopped" as const,
    stage: "final_verify" as const,
    message: "Text repair completed, but the final verification still needs you.",
    summary: "S",
    issues: [
      { section: "long" as const, reason: "The Long says not a single shot was fired." },
      { section: "facts" as const, reason: "Only one source supports no casualties." },
    ],
  };
  const moreProps = (over: Record<string, unknown> = {}) => ({ onWholeStory: vi.fn(), onApprove: vi.fn(), approving: false, ...over }) as any;
  const props = (over: Record<string, unknown> = {}) => ({ storyTitle: "T", qa, onReview: vi.fn(), onOpenReview: vi.fn(), more: React.createElement(TextMore, moreProps()), ...over }) as any;

  test("issue-first: how many things, one numbered row each with Review issue, and nothing else", () => {
    const html = renderToStaticMarkup(React.createElement(TextException, props()));
    expect(html).toContain("2 things need your attention</h1>");
    const list = html.slice(html.indexOf('aria-label="Text issues"'));
    expect(list).toMatch(/>01<[^]*Long script[^]*>02<[^]*Facts &amp; Sources/);
    expect(html.match(/>Review issue<\/button>/g)).toHaveLength(2);
    const shown = visible(html);
    for (const s of ['role="tablist"', "Approve", "Copy Director Review", "Text QA", "Story review", "summary"]) expect(shown).not.toContain(s);
  });

  test("Review issue opens that issue; More holds only reading the whole story and continuing anyway", () => {
    const p = props();
    const tree = React.createElement(TextException, p);
    buttons(tree, "Review issue").forEach((b) => b.props.onClick());
    expect(p.onReview.mock.calls).toEqual([[0], [1]]);
    const m = moreProps();
    const more = React.createElement(TextMore, m);
    buttons(more, "Read the whole story")[0].props.onClick();
    buttons(more, "Continue anyway")[0].props.onClick();
    expect(m.onWholeStory).toHaveBeenCalledOnce();
    expect(m.onApprove).toHaveBeenCalledOnce();
    expect(renderToStaticMarkup(more)).not.toMatch(/Copy|Director|Production details|QA/);
    expect(SECTION_TAB).toEqual({ story: "story", hook: "story", spine: "story", facts: "facts", long: "long", short: "short" });
  });

  test("a passed Text QA says so: ready for your review, with the story review as the one action", () => {
    const p = props({ qa: undefined, passed: true });
    const html = renderToStaticMarkup(React.createElement(TextException, p));
    expect(html).toContain("Your story is ready for review</h1>");
    expect(html).toContain("Automatic Text QA passed. Ready for your review.");
    expect(html).not.toContain("could not finish checking");
    expect(html).toMatch(/btn btn-primary">Open story review</);
    expect(html).not.toContain("Review issue");
  });

  test("without an issue list (lost or failed QA) the story review is the one action", () => {
    const p = props({ qa: undefined });
    const html = renderToStaticMarkup(React.createElement(TextException, p));
    expect(html).toContain("Your story needs a look</h1>");
    expect(html).toMatch(/btn btn-primary">Open story review</);
    expect(html).not.toContain("Review issue");
    buttons(React.createElement(TextException, p), "Open story review")[0].props.onClick();
    expect(p.onOpenReview).toHaveBeenCalledOnce();
  });

  test("a settled Text QA (stopped, or passed and waiting for the human review) hands the gate over; not yet started or running stays on Writing", () => {
    const review = { title: "", hook: "", facts: [], moments: [], sources: [], longScript: "", shortScript: "" };
    const now = Date.parse("2026-09-28T18:00:00.000Z");
    const justNow = new Date(now - 1500).toISOString(); // reached the gate one poll ago
    const at = (over: Partial<Job>) => job({ state: "awaiting_text", step: "scripts", review, updatedAt: justNow, progress: { current: 2, total: 2 }, ...over });
    // Reached the gate, Text QA not started yet: PB4 is still working.
    expect(stage.productionFace(at({}), now)).toBe("running");
    const waiting = renderToStaticMarkup(React.createElement(ProductionProgress, { job: at({}) }));
    expect(waiting).toContain("Writing…</h1>");
    expect(waiting.slice(0, waiting.indexOf("<details"))).not.toMatch(/%|2 \/ 2|Text needs you/);
    // Running, in any phase.
    for (const phase of ["review", "repair", "verify"] as const) expect(stage.productionFace(at({ textQa: { status: "running", phase } }), now)).toBe("running");
    // Stopped: the exception.
    expect(stage.productionFace(at({ textQa: qa }), now)).toBe("text");
    // Passed: PASS is not an approval, so the draft waits for the human review at once.
    expect(stage.productionFace(at({ textQa: { status: "passed" } }), now)).toBe("text");
    expect(stage.gateFace(at({ textQa: { status: "passed" } }))).toBe("text");
    // No result long after reaching the gate (lost to a restart): the user decides, never a dead end.
    expect(stage.productionFace(at({ updatedAt: new Date(now - stage.GATE_GRACE_MS - 1).toISOString() }), now)).toBe("text");
    expect(stage.storyProductionLabel(at({ updatedAt: new Date(Date.now() - 1000).toISOString() }))).toBe("In production · Writing");
    // The face Creating keeps once handed over (a manual revision refreshes updatedAt); never while QA runs.
    expect(stage.gateFace(at({}))).toBe("text");
    expect(stage.gateFace(at({ textQa: { status: "running", phase: "review" } }))).toBeNull();
  });
});

// ---------------------------------------------------------------------------

describe("visual issues", () => {
  test("an image problem appears once, at its slot, with its image and Regenerate image as the fix", () => {
    const issue = { kind: "long", assetId: "L03", truth: "graphic", stage: "verify", reason: "The labels are unreadable." };
    const out = visualIssues({ assetQa: assetDone([issue, { ...issue, reason: "The map is mirrored." }, issue]) }, films());
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ key: "asset-long-L03", where: "Long · Slot 06 · 00:24", reasons: ["The labels are unreadable.", "The map is mirrored."], fix: "regenerate", target: { index: 3, whole: true } });
    expect(out[0].frame?.slot).toBe(6);
    expect(out[0].asset?.id).toBe("L03");
    // Archive is read only: never regenerated; the fix is Change visual, and it says why.
    const archive = visualIssues({ assetQa: assetDone([{ kind: "long", assetId: "L02", truth: "archive", stage: "review", reason: "A modern logo." }]) }, films());
    expect(archive[0].fix).toBe("change");
    expect(archive[0].asset).toBeUndefined();
    expect(archive[0].note).toBe("This archive image is used as found. It cannot be regenerated.");
  });

  test("the fix follows the image: generated stills regenerate, an archive image changes, a stale one gets nothing", () => {
    const one = (assetId: string, truth: string) => visualIssues({ assetQa: assetDone([{ kind: "long", assetId, truth, stage: "review", reason: "Wrong." }]) }, films())[0];
    // 1, 2. Generated reconstruction and graphic stills keep Regenerate image.
    expect(one("L01", "reconstruction")).toMatchObject({ fix: "regenerate", where: "Long · Slot 03 · 00:12" });
    expect(one("L03", "graphic")).toMatchObject({ fix: "regenerate", where: "Long · Slot 06 · 00:24" });
    // 3, 6. An archive image at a current slot: Change visual, in neutral wording.
    const archive = one("L02", "archive");
    expect(archive).toMatchObject({ fix: "change", where: "Long · Slot 04 · 00:16", target: { index: 1, whole: true } });
    expect(archive.frame?.truth).toBe("archive");
    expect(archive.note).toContain("archive image");
    expect(archive.note).not.toContain("photograph");
    // 7. An asset the current film no longer has: no slot, no image, no invented action.
    const stale = one("L99", "archive");
    expect(stale.fix).toBeUndefined();
    expect(stale.frame).toBeUndefined();
    expect(stale.target).toBeUndefined();
    expect(stale.note).toBe("This part of the film has changed since PB4 checked it, so there is nothing to show.");
  });

  test("an unfinished image check says PB4 could not finish it; nothing reruns PB4's checks", () => {
    const out = visualIssues({ assetQa: assetDone([{ kind: "short", assetId: "S02", truth: "reconstruction", stage: "review", reason: "The review failed.", incomplete: true }], { incomplete: 1 }) }, films());
    expect(out[0].reasons[0]).toBe("PB4 could not finish checking this image. The review failed.");
    expect(out[0].fix).toBe("regenerate"); // the existing legal regeneration, nothing new
    const interrupted = visualIssues({ assetQa: assetDone([], { reviewed: 0, clean: false, message: "Asset QA was interrupted before it finished. Review the visuals manually." }) }, films());
    expect(interrupted).toEqual([expect.objectContaining({ key: "asset-check", where: "Images", reasons: ["PB4's check of the images stopped before it finished."] })]);
    expect(interrupted[0].fix).toBeUndefined();
    expect(JSON.stringify(interrupted)).not.toContain("Asset QA"); // the engine's own message is not product copy
    expect(visualIssues({ assetQa: assetDone([], { clean: false }) }, films())).toEqual([]);
  });

  test("a sequence exception appears, aimed at its slot, fixed by Change visual", () => {
    const out = visualIssues({ directorQa: { long: complete({ clean: false, humanReview: [{ slotId: 4, reason: "The archive photo shows the wrong ship." }] }) } }, films());
    expect(out).toEqual([expect.objectContaining({ key: "slot-long-4", where: "Long · Slot 04 · 00:16", reasons: ["The archive photo shows the wrong ship."], fix: "change", target: { index: 1, whole: false } })]);
    expect(out[0].frame?.slot).toBe(4);
  });

  test("the same slot in several final sources is one row with every distinct reason, in plain words", () => {
    const run = complete({
      clean: false,
      humanReview: [{ slotId: 5, reason: "Repeats the previous image." }, { slotId: 6, reason: "ADJACENT REUSE remains. No legal existing alternative resolved this sequence issue." }],
      unresolvedRepairs: [{ slotId: 5, reason: "No legal alternative existing presentation is available." }, { slotId: 5, reason: "Repeats the previous image." }],
    });
    const out = visualIssues({ directorQa: { short: undefined, long: run } }, films());
    expect(out.map((i) => i.key)).toEqual(["slot-long-5", "slot-long-6"]);
    expect(out[0].reasons).toEqual(["Repeats the previous image.", "PB4 found no other image in this film that could go here."]);
    expect(out[1].reasons).toEqual(["The same image appears twice in a row, and PB4 found no other image to use."]);
    expect(JSON.stringify(out.map((i) => i.reasons))).not.toMatch(/REUSE|presentation|legal/);
  });

  test("the engine's pattern wording is translated; anything else is shown as written", () => {
    expect(plain("CONSECUTIVE REUSE remains. Existing media could not break this run.")).toBe("The same image repeats several times in a row, and PB4 found no other image to break it up.");
    expect(plain("ALTERNATING REUSE remains. Existing media could not safely diversify this section.")).toBe("Two images keep alternating here, and PB4 found no other image to vary it.");
    expect(plain("OPENING REPEAT remains. The same asset still repeats inside the opening.")).toBe("The same image repeats in the opening seconds.");
    expect(plain("Not changed: L05:base is not a legal choice for this slot.")).toBe("PB4 could not make this change by itself.");
    expect(plain("The map is wrong. Not attempted: one coordinated repair per Director QA run.")).toBe("The map is wrong. PB4 did not get to fix this one by itself.");
    expect(plain("The ship has modern funnels.")).toBe("The ship has modern funnels.");
  });

  test("a slot missing from the current film stays visible without a fabricated target", () => {
    const out = visualIssues({ directorQa: { long: complete({ clean: false, humanReview: [{ slotId: 42, reason: "Wrong period uniform." }] }) } }, films());
    expect(out).toHaveLength(1);
    const [i] = out;
    expect(i.where).toBe("Long · Slot 42");
    expect([i.frame, i.target, i.fix]).toEqual([undefined, undefined, undefined]);
    expect(i.note).toBe("This part of the film has changed since PB4 checked it, so there is nothing to show.");
    expect(JSON.stringify(i)).not.toContain("Slot 00");
    expect(issueFrame(i, films())).toBeNull();
    const html = renderToStaticMarkup(React.createElement(VisualException, exceptionProps({ directorQa: { long: complete({ clean: false, humanReview: [{ slotId: 42, reason: "Wrong period uniform." }] }), short: complete() } })));
    expect(html).not.toContain("data-issue-thumb");
  });

  test("an unfinished film check is one plain row with no action: PB4 runs its own checks", () => {
    const out = visualIssues({ directorQa: { long: { status: "failed", error: "OpenAI responses 500" }, short: { status: "interrupted" } } }, films());
    expect(out).toEqual([
      expect.objectContaining({ key: "check-long", where: "Long film", reasons: ["PB4 could not finish checking the Long film."] }),
      expect.objectContaining({ key: "check-short", where: "Short film", reasons: ["PB4's check of the Short film was interrupted."] }),
    ]);
    expect(out.map((i) => i.fix)).toEqual([undefined, undefined]);
    expect(JSON.stringify(out)).not.toMatch(/OpenAI|Director QA|sequence check/);
    const unverified = visualIssues({ directorQa: { long: complete({ clean: false, verified: false, verifyError: "timeout", unresolvedRepairs: [{ slotId: 3, reason: "Not changed." }] }) } }, films());
    expect(unverified.map((i) => i.key)).toEqual(["slot-long-3", "check-long"]);
    expect(unverified[1].reasons).toEqual(["PB4 could not finish its final check of the Long film."]);
  });

  test("coordinated, cleanup and repair failures land on their slot or on one plain film row", () => {
    const coordinated = visualIssues({ directorQa: { long: complete({ clean: false, coordinatedError: { target: 5, error: "Invalid edit plan" }, unresolvedRepairs: [{ slotId: 5, reason: "Still repeats." }] }) } }, films());
    expect(coordinated).toHaveLength(1);
    expect(coordinated[0]).toMatchObject({ key: "slot-long-5", reasons: ["Still repeats.", "PB4 could not fix this part of the film by itself."] });
    const cleanup = visualIssues({ directorQa: { short: complete({ clean: false, cleanupError: "db locked" }) } }, films());
    expect(cleanup).toEqual([expect.objectContaining({ key: "check-short", reasons: ["PB4 could not finish removing repeated images in the Short film."] })]);
    const repair = visualIssues({ directorQa: { long: complete({ clean: false, repairError: "Invalid plan", requestedRepairs: [{ slotId: 6, reason: "Use the referendum graphic." }] }) } }, films());
    expect(repair).toEqual([expect.objectContaining({ key: "slot-long-6", reasons: ["PB4 tried to fix this and could not: Use the referendum graphic."] })]);
    expect(visualIssues({ directorQa: { long: complete({ clean: false, repairError: "Invalid plan" }) } }, films())[0].reasons).toEqual(["PB4's own fixes to the Long film could not be applied."]);
  });

  test("current state only: clean and running films add nothing; an automatic-check failure never claims a pass", () => {
    expect(visualIssues({ directorQa: { long: complete(), short: { status: "running", phase: "reviewing" } } }, films())).toEqual([]);
    const out = visualIssues({ visualAutopilot: { status: "failed", error: "database is locked" } }, films());
    expect(out).toEqual([expect.objectContaining({ key: "autopilot", reasons: ["PB4's automatic check of the visuals stopped before it finished."] })]);
    expect([out[0].target, out[0].fix]).toEqual([undefined, undefined]);
    expect(JSON.stringify(out)).not.toMatch(/passed|database/i);
    expect(visualIssuesForJob({ preview: null, directorQa: { long: { status: "failed", error: "e" } } })).toEqual([]);
  });
});

function exceptionProps(over: Partial<Job> = {}, extra: Record<string, unknown> = {}) {
  const j = job({ state: "awaiting_preview", step: "preview", preview: preview(), ...over });
  return { job: j, storyTitle: "T", issues: visualIssuesForJob(j), version: 0, onReview: vi.fn(), onContinue: vi.fn(), continuing: false, busy: false, more: null, ...extra } as any;
}
const visualMore = (over: Record<string, unknown> = {}) => ({ onFilms: vi.fn(), onContinue: vi.fn(), onRebuild: vi.fn(), continuing: false, rebuilding: false, busy: false, ...over }) as any;
// Every control a user must never operate: PB4's own machinery.
const ENGINE = /Director QA|Run Director|Director Board|Director board|Copy Director|Asset QA|Text QA|Revise sequence|Regenerate still|OPENING|ENDING|CLOSE REUSE|ALTERNATING|ADJACENT|HIGH REUSE|Owners|Attention|Flagged|data-board|data-mode-tab|Sequence|Reviewed|Mark all|repair|verification/;

describe("Visuals need you", () => {
  const needs = { assetQa: assetDone([{ kind: "long", assetId: "L01", truth: "reconstruction", stage: "verify", reason: "A modern logo." }]), directorQa: { long: complete({ clean: false, humanReview: [{ slotId: 5, reason: "Map repeats." }] }), short: complete() } };

  test("issue-first and small: a count, one row each with its thumbnail and Review, no engine controls", () => {
    const html = renderToStaticMarkup(React.createElement(VisualException, exceptionProps(needs, { more: React.createElement(VisualMore, visualMore()) })));
    expect(html).toContain("2 things need your attention</h1>");
    expect(html.match(/data-visual-issue=/g)).toHaveLength(2);
    expect(html.match(/data-issue-thumb/g)).toHaveLength(2);
    expect(html.match(/>Review<\/button>/g)).toHaveLength(2);
    expect(html).not.toMatch(ENGINE);
    const shown = visible(html);
    for (const s of ["Continue", "Redo", "motion"]) expect(shown).not.toContain(s);
    const more = html.slice(html.indexOf("data-more"));
    expect(more).toContain(">Look through the films</button>");
    expect(more).toMatch(/data-action="continue"[^>]*>Continue anyway</);
    expect(more).toMatch(/data-action="rebuild"[^>]*>Redo all visuals</);
    expect(more).not.toContain("Production details");
  });

  test("Review opens the chosen issue; More calls the existing handlers", () => {
    const p = exceptionProps(needs);
    buttons(React.createElement(VisualException, p), "Review")[0].props.onClick();
    expect(p.onReview.mock.calls[0][0].key).toBe("asset-long-L01");
    const m = visualMore();
    const more = React.createElement(VisualMore, m);
    buttons(more, "Look through the films")[0].props.onClick();
    buttons(more, "Continue anyway")[0].props.onClick();
    buttons(more, "Redo all visuals")[0].props.onClick();
    expect([m.onFilms, m.onContinue, m.onRebuild].map((f) => f.mock.calls.length)).toEqual([1, 1, 1]);
    expect(renderToStaticMarkup(React.createElement(VisualMore, visualMore({ busy: true })))).toMatch(/disabled=""[^>]*data-action="continue"/);
  });

  test("with nothing left to fix, continuing is the one action", () => {
    const p = exceptionProps({ assetQa: assetDone([]), directorQa: { long: complete(), short: complete() } });
    const html = renderToStaticMarkup(React.createElement(VisualException, p));
    expect(html).toContain("Nothing left to fix</h1>");
    buttons(React.createElement(VisualException, p), "Continue production")[0].props.onClick();
    expect(p.onContinue).toHaveBeenCalledOnce();
    expect(renderToStaticMarkup(React.createElement(VisualMore, visualMore({ showContinue: false })))).not.toContain("Continue anyway");
    expect(renderToStaticMarkup(React.createElement(VisualException, exceptionProps({})))).toContain("PB4 could not check these visuals automatically.");
  });

  test("the visual face waits until the automatic check has settled", () => {
    const now = Date.parse("2026-09-28T18:00:00.000Z");
    const justNow = new Date(now - 1500).toISOString();
    const at = (over: Partial<Job>) => stage.productionFace(job({ state: "awaiting_preview", step: "preview", preview: preview(), updatedAt: justNow, ...over }), now);
    expect(at({})).toBe("running");
    expect(renderToStaticMarkup(React.createElement(ProductionProgress, { job: job({ state: "awaiting_preview", step: "stills", preview: preview(), updatedAt: justNow, progress: { current: 12, total: 12 } }) }))).toContain("Checking films…</h1>");
    expect(at({ assetQa: { status: "running", phase: "review" } })).toBe("running");
    expect(at({ visualAutopilot: { status: "running" } })).toBe("running");
    expect(at({ ...needs, visualAutopilot: { status: "running" } })).toBe("running");
    expect(at(needs)).toBe("visuals");
    expect(at({ assetQa: assetDone([], { reviewed: 0, clean: false, message: "Asset QA was interrupted." }) })).toBe("visuals");
    expect(at({ visualAutopilot: { status: "failed", error: "database is locked" } })).toBe("visuals");
    expect(at({ assetQa: assetDone([]), directorQa: { long: { status: "interrupted" } } })).toBe("visuals");
    expect(at({ updatedAt: new Date(now - stage.GATE_GRACE_MS - 1).toISOString() })).toBe("visuals");
  });
});

// ---------------------------------------------------------------------------

describe("visual issue view", () => {
  const regen = { running: null, failed: null, done: null };
  const changeControls = (over: Record<string, unknown> = {}) => ({ open: false, feedback: "", running: false, notice: null, onOpen: vi.fn(), onCancel: vi.fn(), onFeedback: vi.fn(), onSubmit: vi.fn(), ...over });
  const issueOf = (j: Partial<Job>) => visualIssuesForJob({ preview: preview(), ...j })[0];
  const view = (issue: any, over: Record<string, unknown> = {}) =>
    ({ issue, position: { index: 0, total: 2 }, films: films(), version: 0, onBack: vi.fn(), onNext: vi.fn(), onRegenerate: vi.fn(), regen, busy: false, more: React.createElement(VisualMore, visualMore()), ...over }) as any;
  const html = (p: any) => renderToStaticMarkup(React.createElement(VisualIssueView, p));
  const actions = (out: string) => (visible(out).match(/>(Regenerate image|Change visual)</g) ?? []).length;

  test("a generated image: the problem, the large current image and Regenerate image, and nothing else", () => {
    const issue = issueOf({ assetQa: assetDone([{ kind: "long", assetId: "L03", truth: "graphic", stage: "verify", reason: "The labels are unreadable." }]) });
    const p = view(issue);
    const out = html(p);
    expect(out).toContain("Visual issue · Issue 1 of 2");
    expect(out).toContain("Long · Slot 06 · 00:24</h1>");
    expect(out).toContain("The labels are unreadable.");
    expect(out).toMatch(/data-issue-visual="long"[^>]*aspect-video[^]*long-6\.png/);
    expect(out).not.toMatch(ENGINE);
    expect(actions(out)).toBe(1);
    expect(visible(out)).toContain(">Regenerate image<");
    const tree = React.createElement(VisualIssueView, p);
    buttons(tree, /Regenerate image/)[0].props.onClick();
    expect(p.onRegenerate).toHaveBeenCalledWith(films().long.frames[3]); // the existing regeneration, unchanged
    buttons(tree, "Next issue →")[0].props.onClick();
    buttons(tree, "← Back to issues")[0].props.onClick();
    expect(p.onNext).toHaveBeenCalledOnce();
    expect(p.onBack).toHaveBeenCalledOnce();
  });

  test("a read-only archive image: Change visual, which runs the existing sequence revision, never Regenerate image", () => {
    const issue = issueOf({ assetQa: assetDone([{ kind: "long", assetId: "L02", truth: "archive", stage: "review", reason: "A modern logo." }]) });
    // 4, 5. Wired as Creating wires it: the one action is Change visual.
    const onReviseSequence = vi.fn();
    const out = renderToStaticMarkup(React.createElement(VisualIssuePanel, view(issue, { onReviseSequence })));
    expect(out).toContain("This archive image is used as found. It cannot be regenerated.");
    expect(out).not.toContain("archive photograph");
    expect(out).toContain('data-action="change-visual"');
    expect(visible(out)).toContain(">Change visual<");
    expect(out).not.toContain("Regenerate image");
    expect(actions(out)).toBe(1);
    expect(onReviseSequence).not.toHaveBeenCalled(); // nothing runs until the person asks
    // Without a sequence revision to run, no action is invented.
    expect(actions(renderToStaticMarkup(React.createElement(VisualIssuePanel, view(issue))))).toBe(0);
    // The button opens the existing revision for the Long film, about this slot.
    const revise = changeControls();
    buttons(React.createElement(VisualIssueView, view(issue, { revise })), "Change visual")[0].props.onClick();
    expect(revise.onOpen).toHaveBeenCalledWith("Slot 04: A modern logo.");
  });

  test("a placement problem: the slot as the film shows it and Change visual, which runs the existing sequence revision", async () => {
    const issue = issueOf({ directorQa: { short: complete({ clean: false, humanReview: [{ slotId: 1, reason: "The same map again." }] }) } });
    const revise = changeControls();
    const p = view(issue, { revise });
    const out = html(p);
    expect(out).toMatch(/data-issue-visual="short"[^>]*aspect-\[9\/16\]/);
    expect(out).not.toMatch(ENGINE);
    expect(actions(out)).toBe(1);
    buttons(React.createElement(VisualIssueView, p), "Change visual")[0].props.onClick();
    expect(revise.onOpen).toHaveBeenCalledWith("Slot 01: The same map again.");
    const open = html(view(issue, { revise: changeControls({ open: true, feedback: "Slot 01: use S01." }) }));
    expect(open).toContain("What should change? · Short film");
    expect(open).toMatch(/<textarea[^>]*>Slot 01: use S01\.<\/textarea>/);
    expect(open).not.toMatch(ENGINE);
    const applied = html(view(issue, { revise: changeControls({ notice: { kind: "applied", report: { changed: [1], unresolved: [{ slotId: 2, reason: "no other image" }] } } }) }));
    expect(applied).toContain("Changed slot 01");
    expect(applied).toContain("Slot 02 could not change: no other image");
    // Underneath, it is the existing revision for this one film, trimmed and validated.
    const revision = vi.fn(async () => ({ changed: [1], unresolved: [] }));
    expect(await submitSequenceRevision("short", "  Slot 01: use S01.\n", false, revision)).toEqual({ status: "ok", report: { changed: [1], unresolved: [] } });
    expect(revision.mock.calls).toEqual([["short", "Slot 01: use S01."]]);
    expect(await submitSequenceRevision("short", "  ", false, revision)).toEqual({ status: "invalid", error: "Director feedback is required." });
    expect(await submitSequenceRevision("short", "x", true, revision)).toEqual({ status: "skipped" });
  });

  test("an unfinished check, a slot no longer in the film and an automatic-check failure: no image, no action, only why", () => {
    for (const j of [
      { directorQa: { long: { status: "failed", error: "OpenAI responses 500" } } },
      { directorQa: { long: complete({ clean: false, humanReview: [{ slotId: 42, reason: "Wrong uniform." }] }) } },
      { visualAutopilot: { status: "failed", error: "db" } },
    ] as Partial<Job>[]) {
      const out = html(view(issueOf(j)));
      expect(out).not.toContain("data-issue-visual");
      expect(actions(out)).toBe(0);
      expect(out).not.toMatch(/OpenAI|Director QA|Check the|Run /);
      expect(out).toMatch(/nothing to show|Nothing here needs fixing by itself/);
    }
  });

  test("a fixed issue stays on screen as resolved, without its fix", () => {
    const issue = issueOf({ assetQa: assetDone([{ kind: "long", assetId: "L03", truth: "graphic", stage: "verify", reason: "Unreadable." }]) });
    const out = html(view(issue, { position: null, onNext: undefined }));
    expect(out).toContain("Visual issue · Resolved");
    expect(out).toContain("PB4 no longer flags this.");
    expect(out).toContain("data-issue-visual");
    expect(actions(out)).toBe(0);
  });
});

// ---------------------------------------------------------------------------

describe("film view (Look through the films)", () => {
  const base = (over: Record<string, unknown> = {}) =>
    ({ preview: preview(), version: 0, onBack: vi.fn(), onRegenerate: vi.fn(), regen: { running: null, failed: null, done: null }, onReviseSequence: vi.fn(), ...over }) as any;

  test("opens on the issue's slot and goes back to the issue", () => {
    const issue = visualIssuesForJob({ preview: preview(), directorQa: { short: complete({ clean: false, humanReview: [{ slotId: 1, reason: "Wrong flag." }] }) } })[0];
    const p = base({ target: { film: issue.film, index: issue.target!.index }, backLabel: "Back to issue" });
    const out = renderToStaticMarkup(React.createElement(VisualReview, p));
    expect(out).toContain('data-review-film="short"');
    expect(out).toContain("2 / 2");
    const view = React.createElement(ReviewView, { ...p, films: films(), state: initialReview(preview()), dispatch: vi.fn() });
    // Only the header is expanded: the Change visual control keeps its own state.
    const header = (ReviewView as any)({ ...view.props }).props.children[0];
    buttons(header, "← Back to issue")[0].props.onClick();
    expect(p.onBack).toHaveBeenCalledOnce();
  });

  test("the Director board, its QA controls and diagnostics are not reachable in the product", () => {
    const out = renderToStaticMarkup(React.createElement(VisualReview, base()));
    expect(out).not.toMatch(ENGINE);
    for (const s of ["data-director-board", "data-board-filter", "data-board-legend", "data-qa-result", "run-director-qa", "copy-board", "data-filter", "data-mode-tab"]) expect(out).not.toContain(s);
    // The only creative actions: Regenerate image (where legal) and Change visual.
    expect(out).toContain("Regenerate image");
    expect(out).toContain('data-action="change-visual"');
    expect(Object.keys(initialReview(preview())).sort()).toEqual(["film", "index"]);
  });
});

// ---------------------------------------------------------------------------

describe("Ready", () => {
  const video = (id: string, jobId: string, kind: "long" | "short", durationSec: number): Video => ({ id, storyId: "s", jobId, kind, path: `stories/demo/${id}.mp4`, width: 1920, height: 1080, durationSec, fps: 30, hasAudio: true, createdAt: "" });

  test("the newest complete Long + Short pair comes from one job; a newer lone video never hijacks it", () => {
    // Newest first, as videosForStory returns them: a later job failed after one video.
    const videos = [video("v5", "j3", "long", 700), video("v4", "j2", "short", 57), video("v3", "j2", "long", 708), video("v2", "j1", "short", 50), video("v1", "j1", "long", 600)];
    const pair = stage.latestCompletePair(videos)!;
    expect(pair.jobId).toBe("j2");
    expect([pair.long.id, pair.short.id]).toEqual(["v3", "v4"]);
    expect(stage.latestCompletePair(videos, "j1")!.long.id).toBe("v1");
    expect(stage.latestCompletePair(videos, "j3")).toBeNull();
    expect(stage.latestCompletePair([video("a", "j1", "long", 1), video("b", "j2", "short", 1)])).toBeNull();
  });

  test("opening the route follows the active job, then a failed latest job, then the finished pair", () => {
    const videos = [video("v5", "j3", "long", 700), video("v4", "j2", "short", 57), video("v3", "j2", "long", 708)];
    expect(stage.productionTarget({ activeJob: { id: "a" }, failedJob: null, videos })).toEqual({ jobId: "a" });
    expect(stage.productionTarget({ activeJob: null, failedJob: { id: "f" }, videos })).toEqual({ jobId: "f" });
    // A reload of a finished production: its own job again, so Ready shows again.
    expect(stage.productionTarget({ activeJob: null, failedJob: null, videos })).toEqual({ jobId: "j2" });
    expect(stage.productionTarget({ activeJob: null, failedJob: null, videos: [] })).toEqual({ navigate: "story" });
    expect(stage.productionTarget({ activeJob: null, failedJob: null, videos: [video("a", "j1", "long", 1), video("b", "j2", "long", 1)] })).toEqual({ navigate: "watch" });
    expect(stage.productionFace(job({ state: "done", step: "finishing" }))).toBe("done");
  });

  test("Ready shows the pair's runtimes and that job's spend, with Watch buttons and no player", () => {
    const pair = { jobId: "j2", long: video("v3", "j2", "long", 708), short: video("v4", "j2", "short", 57) };
    const onWatch = vi.fn();
    const p = { storyTitle: "The War Over a Pig", job: job({ id: "j2", state: "done", step: "finishing", spent: 4.62 }), pair, onWatch };
    const html = renderToStaticMarkup(React.createElement(ReadyPanel, p));
    expect(html).toContain("Ready");
    expect(html).toContain("The War Over a Pig</h1>");
    expect(html).toMatch(/data-ready="long"[^]*11:48[^]*Watch Long/);
    expect(html).toMatch(/data-ready="short"[^]*0:57[^]*Watch Short/);
    expect(html).toContain("$4.62");
    expect(html).not.toContain("<video");
    // Finished: the machinery is gone.
    for (const s of ["data-more", "Production details", "QA", "Step", "stages", "repair", "provider"]) expect(html).not.toContain(s);
    buttons(React.createElement(ReadyPanel, p), "Watch Long")[0].props.onClick();
    buttons(React.createElement(ReadyPanel, p), "Watch Short")[0].props.onClick();
    expect(onWatch.mock.calls).toEqual([["long"], ["short"]]); // each opens Watch on its own film
  });

  test("the Watch route carries the film to open on; the plain route is unchanged", async () => {
    const { resolveRoute, activeNav } = await import("../src/app/route.ts");
    expect(resolveRoute("/story/pig-war/watch/short")).toEqual({ name: "watch", slug: "pig-war", film: "short" });
    expect(resolveRoute("/story/pig-war/watch/long")).toEqual({ name: "watch", slug: "pig-war", film: "long" });
    expect(resolveRoute("/story/pig-war/watch")).toEqual({ name: "watch", slug: "pig-war" });
    expect(resolveRoute("/story/pig-war/watch/other")).toEqual({ name: "watch", slug: "pig-war" });
    expect(activeNav("/story/pig-war/watch/short")).toBe("videos");
  });
});

// ---------------------------------------------------------------------------

describe("Films need you", () => {
  const issues: FinalQaIssue[] = [
    { film: "long", area: "fact", reason: "Says the program ended for one reason; the sources give two.", text: "cancelled in favor of the atomic bomb" },
    { film: "short", area: "visual", reason: "The same burning hangar keeps returning." },
  ];
  const finalJob = (over: Partial<Job> = {}) => job({ state: "awaiting_final", step: "finishing", preview: preview(), finalQa: { issues }, ...over });

  test("awaiting_final is its own face at once, never Failed or a running stage", () => {
    expect(stage.productionFace(finalJob())).toBe("final");
    expect(stage.productionFace(finalJob({ updatedAt: new Date().toISOString() }))).toBe("final"); // no grace wait: its checks are complete
    expect(stage.gateFace(finalJob())).toBe("final");
    expect(stage.productionFace(job({ state: "running", step: "finishing" }))).toBe("running");
  });

  // A raw engine reason in its lab wording: shown as it is, never the headline.
  const labReason = "The Flames and smoke family appears in sampled cells 1-3, 5 and 7-18 behind distinct activities.";
  const three: FinalQaIssue[] = [
    { film: "long", area: "fact", reason: "Says the program ended for one reason; the sources give two.", text: "cancelled in favor of the atomic bomb" },
    { film: "long", area: "visual", reason: labReason },
    { film: "short", area: "visual", reason: "The same burning hangar keeps returning." },
  ];
  const summary = (over: Record<string, unknown> = {}) => ({ storyTitle: "The War Over a Pig", issues: three, onReview: vi.fn(), onContinue: vi.fn(), continuing: false, ...over });
  const review = (over: Record<string, unknown> = {}) => ({ slug: "bat-bomb", film: "long" as const, issues: three, onFilm: vi.fn(), onBack: vi.fn(), onContinue: vi.fn(), continuing: false, ...over });
  const FACT = "This claim may be stronger than the evidence.";
  const VISUAL = "This film may feel visually repetitive.";

  test("the summary groups concerns by film, with ONE Review action per affected film", () => {
    const p = summary();
    const html = renderToStaticMarkup(React.createElement(FinalException, p));
    expect(html).toContain("Films need you · The War Over a Pig");
    expect(html).toContain("3 things need your attention</h1>");
    expect(html.match(/data-final-film=/g)).toHaveLength(2);
    expect(html).toMatch(/data-final-film="long"[^]*Long documentary[^]*2 concerns[^]*Review Long[^]*data-final-issue="long-fact"[^]*data-final-issue="long-visual"[^]*data-final-film="short"[^]*>Short<[^]*1 concern[^]*Review Short[^]*data-final-issue="short-visual"/);
    expect(buttons(React.createElement(FinalException, p), "Review Long")).toHaveLength(1);
    expect(buttons(React.createElement(FinalException, p), "Review Short")).toHaveLength(1);
    buttons(React.createElement(FinalException, p), "Review Long")[0].props.onClick();
    buttons(React.createElement(FinalException, p), "Review Short")[0].props.onClick();
    expect(p.onReview.mock.calls).toEqual([["long"], ["short"]]);
    // Only the film with concerns offers its review.
    const shortOnly = summary({ issues: three.slice(2) });
    expect(buttons(React.createElement(FinalException, shortOnly), "Review Long")).toHaveLength(0);
    expect(buttons(React.createElement(FinalException, shortOnly), "Review Short")).toHaveLength(1);
    expect(renderToStaticMarkup(React.createElement(FinalException, shortOnly))).not.toContain("Long documentary");
  });

  test("a fact concern reads Long · Fact, the human headline, the narration words, then the stored reason", () => {
    const html = renderToStaticMarkup(React.createElement(FinalException, summary()));
    expect(html).toMatch(new RegExp(`data-final-issue="long-fact"[^]*Long · Fact[^]*${FACT.replace(/\./g, "\\.")}[^]*<q[^>]*>cancelled in favor of the atomic bomb</q>[^]*data-final-reason[^>]*>Says the program ended for one reason; the sources give two\\.<`));
  });

  test("a visual concern reads Visual, the repetition headline, then the stored reason exactly as PB4 wrote it", () => {
    const html = renderToStaticMarkup(React.createElement(FinalException, summary()));
    expect(html).toMatch(new RegExp(`data-final-issue="long-visual"[^]*Long · Visual[^]*${VISUAL.replace(/\./g, "\\.")}[^]*data-final-reason[^>]*>${labReason.replace(/\./g, "\\.")}<`));
    expect(html).toMatch(new RegExp(`data-final-issue="short-visual"[^]*Short · Visual[^]*${VISUAL.replace(/\./g, "\\.")}[^]*>The same burning hangar keeps returning\\.<`));
    // The reason is never rewritten, and the headlines are presentation copy only.
    expect(three[1].reason).toBe(labReason);
    expect(html.match(new RegExp(FACT.replace(/\./g, "\\."), "g"))).toHaveLength(1);
    expect(html.match(new RegExp(VISUAL.replace(/\./g, "\\."), "g"))).toHaveLength(2);
    // Outside the stored reasons and the two headlines: no laboratory, no fixes, no Failed.
    const surface = [...three.map((i) => i.reason), FACT].reduce((h, s) => h.split(s).join(""), html);
    for (const s of ["evidence", "http", "contact", "famil", "cells", "score", "severity", "confidence", "model", "Astra", "QC", "HUMAN_REVIEW", "Audit", "Specialist", "Debug", "Advanced", "Regenerate", "Change visual", "Fix", "Retry", "Production stopped", "Failed"]) expect(surface).not.toContain(s);
  });

  // Every concern, on the summary and in each film review: label, headline, the
  // quote (facts), then the stored reason folded behind Why PB4 stopped.
  const concernsOf = (html: string) => html.split(/<li data-final-issue=/).slice(1).map((c) => c.slice(0, c.indexOf("</li>")));
  const views = () => [
    renderToStaticMarkup(React.createElement(FinalException, summary())),
    renderToStaticMarkup(React.createElement(FinalFilmReview, review())),
    renderToStaticMarkup(React.createElement(FinalFilmReview, review({ film: "short" }))),
  ];

  test("the stored reason is hidden by default behind a closed Why PB4 stopped disclosure", () => {
    for (const html of views()) {
      const list = concernsOf(html);
      expect(list.length).toBeGreaterThan(0);
      for (const c of list) {
        const at = c.indexOf("<details");
        expect(at).toBeGreaterThan(0);
        expect(c.slice(at)).toMatch(/^<details data-final-detail="true" class="[^"]*"><summary [^>]*>Why PB4 stopped<\/summary><p data-final-reason/);
        expect(c.slice(at, c.indexOf(">", at))).not.toContain(" open");
        // Nothing of the reason sits outside the closed disclosure.
        expect(c.slice(0, at)).not.toContain("data-final-reason");
      }
    }
  });

  test("the disclosure holds the exact stored reason, byte for byte", () => {
    const tree = expand(React.createElement(FinalException, summary()));
    const reasons: string[] = [];
    const walk = (n: any) => {
      if (Array.isArray(n)) return n.forEach(walk);
      if (!n || typeof n !== "object") return;
      if (n.props?.["data-final-reason"]) reasons.push(n.props.children);
      walk(n.props?.children);
    };
    walk(tree);
    expect(reasons).toEqual(three.map((i) => i.reason));
    expect(reasons[1]).toBe(labReason);
  });

  test("a fact reads label, headline, then the quote, then the folded reason; a visual reads label, headline, folded reason", () => {
    for (const html of views()) {
      for (const c of concernsOf(html)) {
        const head = c.indexOf(c.includes('fact"') ? FACT : VISUAL);
        expect(head).toBeGreaterThan(c.indexOf("uppercase"));
        const quote = c.indexOf("<q");
        if (c.startsWith('"long-fact"')) expect(quote).toBeGreaterThan(head);
        else expect(quote).toBe(-1);
        expect(c.indexOf("<details")).toBeGreaterThan(Math.max(head, quote));
      }
    }
  });

  test("opening or closing the disclosure is the browser's own: no handler, no request, no job change", () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    try {
      const j = finalJob();
      const before = JSON.stringify(j);
      const disclosures: any[] = [];
      const walk = (n: any) => {
        if (Array.isArray(n)) return n.forEach(walk);
        if (!n || typeof n !== "object") return;
        if (n.type === "details" && n.props?.["data-final-detail"]) disclosures.push(n);
        walk(n.props?.children);
      };
      walk(expand(React.createElement(FinalException, summary({ issues: j.finalQa!.issues }))));
      walk(expand(React.createElement(FinalFilmReview, review({ issues: j.finalQa!.issues }))));
      expect(disclosures).toHaveLength(3);
      for (const d of disclosures) {
        expect(Object.keys(d.props).filter((k) => k.startsWith("on"))).toEqual([]);
        expect("open" in d.props).toBe(false);
        const summaryEl = [d.props.children].flat().find((c: any) => c?.type === "summary");
        expect(Object.keys(summaryEl.props).filter((k) => k.startsWith("on"))).toEqual([]);
      }
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(JSON.stringify(j)).toBe(before);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  test("Continue anyway is secondary on the summary, calls once, and shows it is running", () => {
    const p = summary();
    const [button] = buttons(React.createElement(FinalException, p), "Continue anyway");
    expect(button.props.className).toContain("btn-ghost");
    expect(button.props.className).not.toContain("btn-primary");
    expect(buttons(React.createElement(FinalException, p), "Review Long")[0].props.className).toContain("btn-primary");
    expect(button.props.disabled).toBe(false);
    button.props.onClick();
    expect(p.onContinue).toHaveBeenCalledTimes(1);
    const busy = summary({ storyTitle: "", continuing: true });
    const [running] = buttons(React.createElement(FinalException, busy), "Continuing…");
    expect(running.props.disabled).toBe(true);
    expect(renderToStaticMarkup(React.createElement(FinalException, busy))).toContain(">Films need you<");
    expect(renderToStaticMarkup(React.createElement(FinalException, summary({ issues: three.slice(2) })))).toContain("1 thing needs your attention</h1>");
  });

  test("Review Long plays the actual Long render at 16:9 with only the Long's concerns", () => {
    const html = renderToStaticMarkup(React.createElement(FinalFilmReview, review()));
    expect(html).toMatch(/<video src="\/media\/stories\/bat-bomb\/renders\/long\.mp4" controls="" class="aspect-video w-full /);
    expect(html.match(/<video/g)).toHaveLength(1);
    expect(html).toContain("Back to issues");
    expect(html).toContain("Long documentary</h1>");
    expect(html).toMatch(new RegExp(`PB4 noticed[^]*data-final-issue="long-fact"[^]*>Fact<[^]*${FACT.replace(/\./g, "\\.")}[^]*<q[^>]*>cancelled in favor of the atomic bomb</q>[^]*data-final-issue="long-visual"[^]*>Visual<[^]*${VISUAL.replace(/\./g, "\\.")}`));
    expect(html).not.toContain("short-visual");
    expect(html).not.toContain("The same burning hangar");
    // A decision view, not the library: no download, publishing, sources or versions.
    for (const s of ["download", "Download", "Publish", "Sources", "Previous versions", "01", "02"]) expect(html).not.toContain(s);
  });

  test("Review Short plays the actual Short render as a centered 9:16 with only the Short's concerns", () => {
    const html = renderToStaticMarkup(React.createElement(FinalFilmReview, review({ film: "short" })));
    expect(html).toMatch(/<div class="flex justify-center"><video src="\/media\/stories\/bat-bomb\/renders\/short\.mp4" controls="" class="aspect-\[9\/16\] /);
    expect(html).toContain("Short</h1>");
    expect(html).toContain('data-final-issue="short-visual"');
    expect(html).not.toContain("long-fact");
    expect(html).not.toContain("long-visual");
    expect(finalRenderUrl("bat-bomb", "short")).toBe("/media/stories/bat-bomb/renders/short.mp4");
  });

  test("with concerns on both films the review switches between them; with one film it does not offer a switch", () => {
    const p = review();
    const pills = (props: any, label: string) => buttons(React.createElement(FinalFilmReview, props), label);
    expect(pills(p, "Short")).toHaveLength(1);
    expect(pills(p, "Long documentary")[0].props["aria-pressed"]).toBe(true);
    pills(p, "Short")[0].props.onClick();
    pills(p, "Long documentary")[0].props.onClick();
    expect(p.onFilm.mock.calls).toEqual([["short"], ["long"]]);
    const shortOnly = review({ film: "short", issues: three.slice(2) });
    expect(pills(shortOnly, "Long documentary")).toHaveLength(0);
  });

  test("watching, switching and Back to issues are local: no request, and the job is untouched", () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    try {
      const j = finalJob();
      const before = JSON.stringify(j);
      const p = review({ issues: j.finalQa!.issues });
      renderToStaticMarkup(React.createElement(FinalFilmReview, p));
      buttons(React.createElement(FinalFilmReview, p), /Back to issues/)[0].props.onClick();
      buttons(React.createElement(FinalFilmReview, p), "Short")[0].props.onClick();
      expect(p.onBack).toHaveBeenCalledTimes(1);
      expect(p.onFilm).toHaveBeenCalledWith("short");
      expect(p.onContinue).not.toHaveBeenCalled();
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(JSON.stringify(j)).toBe(before);
      expect(stage.productionFace(j)).toBe("final");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  test("Continue anyway inside the film review is the same pair-level decision: one call, secondary, no per-film accept", () => {
    const p = review();
    const [button] = buttons(React.createElement(FinalFilmReview, p), "Continue anyway");
    expect(button.props.className).toContain("btn-ghost");
    expect(button.props["data-action"]).toBe("accept-final");
    button.props.onClick();
    expect(p.onContinue).toHaveBeenCalledTimes(1);
    expect(p.onContinue).toHaveBeenCalledWith(); // no film argument: both films are accepted together
    expect(buttons(React.createElement(FinalFilmReview, p), /Accept|Long only|Short only/)).toHaveLength(0);
    expect(buttons(React.createElement(FinalFilmReview, review({ continuing: true })), "Continuing…")[0].props.disabled).toBe(true);
  });

  test("Ready only after a pass or Continue anyway: the waiting job follows its own gate and has no pair", () => {
    const video = (id: string, jobId: string, kind: "long" | "short"): Video => ({ id, storyId: "s", jobId, kind, path: `stories/demo/${id}.mp4`, width: 1920, height: 1080, durationSec: 60, fps: 30, hasAudio: true, createdAt: "" });
    const older = [video("v2", "old", "short"), video("v1", "old", "long")];
    // An older finished pair never hides the active awaiting_final job.
    expect(stage.productionTarget({ activeJob: { id: "j1" }, failedJob: null, videos: older })).toEqual({ jobId: "j1" });
    expect(stage.latestCompletePair(older, "j1")).toBeNull();
    expect(stage.productionFace(finalJob({ state: "done" }))).toBe("done");
    // Previewing the unregistered render adds no Video: the waiting job still has no pair.
    renderToStaticMarkup(React.createElement(FinalFilmReview, { slug: "demo", film: "long", issues, onFilm: vi.fn(), onBack: vi.fn(), onContinue: vi.fn(), continuing: false }));
    expect(stage.latestCompletePair(older, "j1")).toBeNull();
    expect(older).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------

describe("Story page status", () => {
  test("running production reads as its stage; a stop reads as Needs you with its issue count", () => {
    expect(stage.storyProductionLabel(job({ state: "running", step: "scripts" }))).toBe("In production · Writing");
    expect(stage.storyProductionLabel(job({ state: "awaiting_preview", step: "preview", preview: preview(), assetQa: { status: "running", phase: "review" } }))).toBe("In production · Checking films");
    expect(stage.storyProductionLabel(job({ state: "queued", step: "queued" }))).toBe("In production · Starting");
    const review = { title: "", hook: "", facts: [], moments: [], sources: [], longScript: "", shortScript: "" };
    const textStop = { status: "stopped" as const, stage: "director_review" as const, message: "m", summary: "", issues: [{ section: "facts" as const, reason: "r" }, { section: "long" as const, reason: "q" }] };
    expect(stage.storyProductionLabel(job({ state: "awaiting_text", review, textQa: textStop }))).toBe("Needs you · 2 issues");
    expect(stage.storyProductionLabel(job({ state: "awaiting_text", review }))).toBe("Needs you");
    expect(stage.storyProductionLabel(job({ state: "awaiting_preview", preview: preview(), directorQa: { long: complete({ clean: false, humanReview: [{ slotId: 3, reason: "x" }] }), short: complete() } }))).toBe("Needs you · 1 issue");
  });

  test("the finished-film gate reads Needs you with its issue count; checking the finished films reads as production", () => {
    const issue = { film: "long" as const, area: "fact" as const, reason: "r" };
    expect(stage.storyProductionLabel(job({ state: "awaiting_final", step: "finishing", finalQa: { issues: [issue, { ...issue, area: "visual" }] } }))).toBe("Needs you · 2 issues");
    expect(stage.storyProductionLabel(job({ state: "awaiting_final", step: "finishing", finalQa: { issues: [issue] } }))).toBe("Needs you · 1 issue");
    expect(stage.storyProductionLabel(job({ state: "awaiting_final", step: "finishing" }))).toBe("Needs you");
    expect(stage.storyProductionLabel(job({ state: "running", step: "finishing" }))).toBe("In production · Checking final films");
  });
});

// ---------------------------------------------------------------------------

describe("Long-first (Stage 16A): a finished Long alone is a complete production", () => {
  const video = (id: string, jobId: string, kind: "long" | "short", durationSec: number): Video => ({ id, storyId: "s", jobId, kind, path: `stories/demo/${id}.mp4`, width: 1920, height: 1080, durationSec, fps: 30, hasAudio: true, createdAt: "" });

  test("a LONG COMPLETE job's lone Long is Ready; any other lone video still is not, and never hides the last pair", () => {
    const videos = [video("v5", "j3", "long", 700), video("v4", "j2", "short", 57), video("v3", "j2", "long", 708)];
    // j3 reached LONG COMPLETE: its Long alone is the newest complete production.
    expect(stage.latestCompletePair(videos, undefined, ["j3"])).toEqual({ jobId: "j3", long: videos[0] });
    expect(stage.latestCompletePair(videos, "j3", ["j3"])!.short).toBeUndefined();
    // Without LONG COMPLETE the same lone video is a legacy partial: the pair wins, as always.
    expect(stage.latestCompletePair(videos)!.jobId).toBe("j2");
    expect(stage.latestCompletePair(videos, undefined, ["other"])!.jobId).toBe("j2");
    expect(stage.latestCompletePair(videos, "j3")).toBeNull();
    // Opening the route after a reload finds the finished Long.
    expect(stage.productionTarget({ activeJob: null, failedJob: null, videos: [videos[0]], longCompleteJobIds: ["j3"] })).toEqual({ jobId: "j3" });
    expect(stage.productionTarget({ activeJob: null, failedJob: null, videos: [videos[0]] })).toEqual({ navigate: "story" });
  });

  test("Ready shows one Long card with Watch Long; no Short card, no empty slot", () => {
    const pair = { jobId: "j3", long: video("v5", "j3", "long", 708) };
    const onWatch = vi.fn();
    const p = { storyTitle: "Project Azorian", job: job({ id: "j3", state: "done", step: "finishing", spent: 8.2, flow: "long-first" }), pair, onWatch };
    const html = renderToStaticMarkup(React.createElement(ReadyPanel, p));
    expect(html).toContain("Ready");
    expect(html).toMatch(/data-ready="long"[^]*11:48[^]*Watch Long/);
    expect(html).not.toContain('data-ready="short"');
    expect(html).not.toContain("Watch Short");
    expect(html).toContain("$8.20");
    buttons(React.createElement(ReadyPanel, p), "Watch Long")[0].props.onClick();
    expect(onWatch.mock.calls).toEqual([["long"]]);
  });

  test("the film view offers no empty Short tab for a Long-only preview; a pair keeps both tabs", () => {
    const base = (pv: VisualPreview) => ({ preview: pv, version: 0, onBack: vi.fn(), onRegenerate: vi.fn(), regen: { running: null, failed: null, done: null }, onReviseSequence: vi.fn() }) as any;
    const longOnly = { ...preview(), frames: preview().frames.filter((f) => f.kind === "long") };
    const out = renderToStaticMarkup(React.createElement(VisualReview, base(longOnly)));
    expect(out).toContain('data-film-tab="long"');
    expect(out).not.toContain('data-film-tab="short"');
    const pair = renderToStaticMarkup(React.createElement(VisualReview, base(preview())));
    expect(pair).toContain('data-film-tab="long"');
    expect(pair).toContain('data-film-tab="short"');
  });
});
