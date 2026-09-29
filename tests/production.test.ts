import { describe, test, expect, vi } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { DirectorQaRun, Job, PreviewFrame, Video, VisualPreview } from "../src/types.ts";

// The Production screen's presentation: the six stages, honest progress, the
// issue-first exception faces, the simple issue views, the visual issue mapper,
// the film view behind them and the persistent Ready face. Pure helpers
// and static renders; buttons' own handlers are invoked directly. No server, no
// provider, no DOM.
const stage = await import("../src/app/productionStage.ts");
const { visualIssues, visualIssuesForJob, issueFrame, plain } = await import("../src/app/visualReview/visualIssues.ts");
const { submitSequenceRevision } = await import("../src/app/visualReview/changeVisual.tsx");
const { buildFilm, initialReview } = await import("../src/app/visualReview/model.ts");
const { TextException, TextMore, VisualException, VisualMore, ReadyPanel, ProductionProgress, SECTION_TAB } = await import("../src/app/screens/Production.tsx");
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

  test("without an issue list (lost or failed QA) the story review is the one action", () => {
    const p = props({ qa: undefined });
    const html = renderToStaticMarkup(React.createElement(TextException, p));
    expect(html).toContain("Your story needs a look</h1>");
    expect(html).toMatch(/btn btn-primary">Open story review</);
    expect(html).not.toContain("Review issue");
    buttons(React.createElement(TextException, p), "Open story review")[0].props.onClick();
    expect(p.onOpenReview).toHaveBeenCalledOnce();
  });

  test("only a stopped Text QA is a human exception; not yet started or running stays on Writing", () => {
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
});
