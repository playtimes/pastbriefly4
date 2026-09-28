import { describe, test, expect, vi } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Job, StoryReview } from "../src/types.ts";

// The text-review workspace. Static renders per tab, plus the tab and approve
// handlers invoked directly. No server, no provider, no DOM.
const { StoryReviewPanel, StoryReviewView, CreatingProgress, buildStoryReviewClipboardText, copyDirectorReview, submitRevision } = await import("../src/app/screens/Creating.tsx");

const review: StoryReview = {
  title: "Generated title T-91",
  hook: "Generated hook H-37",
  moments: [
    { title: "Moment one M-1", detail: "detail D-1" },
    { title: "Moment two M-2", detail: "detail D-2" },
  ] as any,
  facts: [
    { fact: "Fact F-1 in full.", sourceTitle: "Source S-1", sourceUrl: "https://example.org/s1" },
    { fact: "Fact F-2 without a link.", sourceTitle: "Source S-2", sourceUrl: "" },
  ] as any,
  sources: [],
  longScript: "Long script L-1.\n\nLong paragraph L-2.",
  shortScript: "Short script S-9.",
};

const view = (tab: any, over: Partial<{ review: StoryReview; onTab: any; onApprove: any; approving: boolean; copy: any; onCopy: any; revise: any }> = {}) =>
  React.createElement(StoryReviewView, { review, tab, onTab: vi.fn(), onApprove: vi.fn(), approving: false, ...over });
const html = (tab: any, over = {}) => renderToStaticMarkup(view(tab, over));

// Find a button in a hook-free element tree by its text.
const text = (n: any): string =>
  n == null || typeof n === "boolean" ? "" : Array.isArray(n) ? n.map(text).join("") : typeof n === "object" ? text(n.props?.children) : String(n);
function button(tree: any, label: string): any {
  let found: any;
  const walk = (n: any) => {
    if (Array.isArray(n)) return n.forEach(walk);
    if (!n || typeof n !== "object") return;
    if (n.type === "button" && text(n) === label) found = n;
    walk(n.props?.children);
  };
  walk(StoryReviewView(tree.props));
  return found;
}

describe("story review workspace", () => {
  test("renders the header, all four tabs and Story by default", () => {
    const out = renderToStaticMarkup(React.createElement(StoryReviewPanel, { review, onApprove: vi.fn(), approving: false }));
    expect(out).toContain("Generated title T-91");
    expect(out).toContain("Generated hook H-37");
    for (const t of ["Story", "Facts &amp; Sources", "Long script", "Short script"]) expect(out).toContain(`>${t}</button>`);
    expect(out).toMatch(/aria-selected="true"[^>]*>Story</);
    expect(out).toContain("Moment one M-1");
    expect(out).toContain("detail D-2");
    expect(out).not.toContain("Fact F-1");
    expect(out).not.toContain("Long script L-1");
    expect(out).toContain("Approve &amp; continue");
  });

  test("each tab shows only its own generated content", () => {
    const facts = html("facts");
    expect(facts).toContain("Fact F-1 in full.");
    expect(facts).toContain('href="https://example.org/s1"');
    expect(facts).toContain('target="_blank"');
    expect(facts).toContain(">Source S-1</a>");
    expect(facts).toContain("(Source S-2)");
    expect(facts).not.toContain("Moment one");

    const long = html("long");
    expect(long).toContain("Long script L-1.\n\nLong paragraph L-2.");
    expect(long).not.toContain("Short script S-9");

    const short = html("short");
    expect(short).toContain("Short script S-9.");
    expect(short).not.toContain("Long script L-1");
  });

  test("no mock content from the design reference", () => {
    for (const tab of ["story", "facts", "long", "short"]) expect(html(tab)).not.toMatch(/Dagen H|Sweden/);
  });

  test("the panel scrolls and the approval footer sits outside it", () => {
    const out = html("long");
    const panel = out.indexOf('role="tabpanel"');
    const footer = out.indexOf("<footer");
    const panelTag = out.slice(out.lastIndexOf("<div", panel), out.indexOf(">", panel));
    expect(panelTag).toContain("flex-1");
    expect(panelTag).toContain("min-h-0");
    expect(panelTag).toContain("overflow-y-auto");
    expect(out.slice(panel, footer)).not.toContain("Approve");
    expect(out.slice(footer)).toContain("Approve &amp; continue");
  });

  test("tab buttons select their tab; Approve calls the existing handler", () => {
    const onTab = vi.fn();
    const onApprove = vi.fn();
    const tree = view("story", { onTab, onApprove });
    button(tree, "Facts & Sources").props.onClick();
    button(tree, "Long script").props.onClick();
    button(tree, "Short script").props.onClick();
    button(tree, "Story").props.onClick();
    expect(onTab.mock.calls.map((c) => c[0])).toEqual(["facts", "long", "short", "story"]);
    button(tree, "Approve & continue").props.onClick();
    expect(onApprove).toHaveBeenCalledOnce();
  });

  test("approving keeps the existing disabled / Continuing state", () => {
    const tree = view("story", { approving: true });
    const b = button(tree, "Continuing…");
    expect(b.props.disabled).toBe(true);
  });
});

describe("copy director review", () => {
  test("the footer has Copy Director Review next to Approve, outside the scroll panel", () => {
    const out = html("long");
    const footer = out.slice(out.indexOf("<footer"));
    expect(footer).toContain(">Copy Director Review</button>");
    expect(footer).toContain("Approve &amp; continue");
    expect(out.slice(0, out.indexOf("<footer"))).not.toContain("Copy Director Review");
  });

  test("the packet carries the whole generated review verbatim plus the durable brief", () => {
    const md = buildStoryReviewClipboardText(review);
    expect(md.startsWith("# PASTBRIEFLY DIRECTOR REVIEW\n\nStage: TEXT GATE")).toBe(true);
    expect(md).toContain("## TITLE\n\nGenerated title T-91\n");
    expect(md).toContain("## PREMISE / HOOK\n\nGenerated hook H-37\n");
    expect(md).toContain("## STORY SPINE\n\n1. Moment one M-1\n   detail D-1\n\n2. Moment two M-2\n   detail D-2\n");
    expect(md).toContain("- Fact F-1 in full.\n  Source: Source S-1\n  https://example.org/s1");
    expect(md).toContain("- Fact F-2 without a link.\n  Source: Source S-2");
    expect(md).toContain("## LONG SCRIPT\n\nLong script L-1.\n\nLong paragraph L-2.\n");
    expect(md).toContain("## SHORT SCRIPT\n\nShort script S-9.\n");
    expect(md).toContain("## REVIEW REQUEST");
    expect(md).toContain("   - APPROVE\n   - REVISE");
    expect(md).toContain("If REVISE, give exact changes.");
    expect(md.trimEnd().endsWith("Stop at the text gate.")).toBe(true);
    expect(md).not.toMatch(/Dagen H|Sweden|Film #3|CTR|AWR/);
  });

  test("it follows whatever review is supplied", () => {
    const other = { ...review, title: "Another title X-2", moments: [{ title: "Only moment", detail: "only detail" }], facts: [] };
    const md = buildStoryReviewClipboardText(other as any);
    expect(md).toContain("Another title X-2");
    expect(md).not.toContain("Generated title T-91");
    expect(md).toContain("No fact sheet was produced for this story.");
  });

  test("copy writes the packet for this review; failures are reported, not hidden", async () => {
    const clip = { writeText: vi.fn(async () => {}) };
    expect(await copyDirectorReview(review, clip)).toBe(true);
    expect(clip.writeText).toHaveBeenCalledWith(buildStoryReviewClipboardText(review));

    expect(await copyDirectorReview(review, { writeText: vi.fn(async () => { throw new Error("denied"); }) })).toBe(false);
    expect(await copyDirectorReview(review, undefined)).toBe(false);
  });

  test("copy does not approve or change tab; approve does not copy", () => {
    const onApprove = vi.fn();
    const onCopy = vi.fn();
    const onTab = vi.fn();
    const tree = view("facts", { onApprove, onCopy, onTab });
    button(tree, "Copy Director Review").props.onClick();
    expect(onCopy).toHaveBeenCalledOnce();
    expect(onApprove).not.toHaveBeenCalled();
    expect(onTab).not.toHaveBeenCalled();
    button(tree, "Approve & continue").props.onClick();
    expect(onApprove).toHaveBeenCalledOnce();
    expect(onCopy).toHaveBeenCalledOnce();
  });

  test("button label reflects copied / failed", () => {
    expect(html("story", { copy: "copied" })).toContain(">Copied</button>");
    expect(html("story", { copy: "failed" })).toContain(">Copy failed</button>");
  });
});

describe("director revision", () => {
  const controls = (over: Record<string, unknown> = {}) => ({
    open: false,
    feedback: "",
    running: false,
    notice: null,
    onOpen: vi.fn(),
    onCancel: vi.fn(),
    onFeedback: vi.fn(),
    onSubmit: vi.fn(),
    ...over,
  });
  // A different story again, so nothing depends on one fixture.
  const revised: StoryReview = {
    title: "Revised title R-4",
    hook: "Revised hook RH-8",
    moments: [{ title: "Revised moment RM-1", detail: "revised detail RD-1" }],
    facts: [{ fact: "Revised fact RF-1.", sourceTitle: "Source S-1", sourceUrl: "https://example.org/s1" }],
    sources: [],
    longScript: "Revised long RL-1.",
    shortScript: "Revised short RS-1.",
  };

  test("the footer orders Copy Director Review, Revise story, Approve & continue", () => {
    const footer = html("long", { revise: controls() }).split("<footer")[1];
    const at = (s: string) => footer.indexOf(s);
    expect(at(">Copy Director Review</button>")).toBeGreaterThan(-1);
    expect(at(">Revise story</button>")).toBeGreaterThan(at(">Copy Director Review</button>"));
    expect(at("Approve &amp; continue")).toBeGreaterThan(at(">Revise story</button>"));
    expect(footer).toMatch(/class="btn btn-ghost"[^>]*>Revise story</);
  });

  test("closed by default: no feedback box; opening calls onOpen and nothing else", () => {
    const revise = controls();
    const onApprove = vi.fn();
    const onTab = vi.fn();
    expect(html("story", { revise })).not.toContain("<textarea");
    button(view("story", { revise, onApprove, onTab }), "Revise story").props.onClick();
    expect(revise.onOpen).toHaveBeenCalledOnce();
    expect(onApprove).not.toHaveBeenCalled();
    expect(onTab).not.toHaveBeenCalled();
  });

  test("open: the Director feedback box sits between the tab panel and the footer", () => {
    const out = html("long", { revise: controls({ open: true }) });
    const box = out.indexOf("<textarea");
    expect(box).toBeGreaterThan(out.indexOf('role="tabpanel"'));
    expect(box).toBeLessThan(out.indexOf("<footer"));
    expect(out).toContain(">Director feedback</label>");
    expect(out).toContain('placeholder="Paste the REVISE feedback from the Director..."');
    expect(out).toContain(">Cancel</button>");
    // The footer opener is disabled while the box is open.
    expect(out.split("<footer")[1]).toMatch(/disabled=""[^>]*>Revise story</);
  });

  test("Cancel only closes: the review on screen is unchanged and nothing is submitted", () => {
    const revise = controls({ open: true, feedback: "Cut the second act." });
    const tree = view("story", { revise });
    button(tree, "Cancel").props.onClick();
    expect(revise.onCancel).toHaveBeenCalledOnce();
    expect(revise.onSubmit).not.toHaveBeenCalled();
    expect(html("story", { revise: controls() })).toContain("Generated title T-91");
  });

  test("blank feedback says it is required and does not submit", async () => {
    const onRevise = vi.fn(async () => {});
    expect(await submitRevision("   \n ", false, onRevise)).toEqual({ status: "invalid", error: "Director feedback is required." });
    expect(onRevise).not.toHaveBeenCalled();
    const out = html("story", { revise: controls({ open: true, feedback: "   \n ", notice: { kind: "invalid", message: "Director feedback is required." } }) });
    expect(out).toMatch(/role="alert"[^>]*>Director feedback is required\.</);
    expect(out).not.toContain("Revision failed");
  });

  test("feedback over 20,000 characters says it is too long, is not truncated and does not submit", async () => {
    const onRevise = vi.fn(async () => {});
    const long = "x".repeat(20001);
    expect(await submitRevision(long, false, onRevise)).toEqual({ status: "invalid", error: "Director feedback must be 20,000 characters or fewer." });
    expect(onRevise).not.toHaveBeenCalled();
    // Exactly the limit (surrounding whitespace aside) is still accepted, whole.
    const max = "y".repeat(20000);
    expect(await submitRevision(`  ${max}\n`, false, onRevise)).toEqual({ status: "ok" });
    expect(onRevise.mock.calls).toEqual([[max]]);
    // The textarea has no maxlength, so nothing is cut off while pasting.
    expect(html("story", { revise: controls({ open: true }) })).not.toMatch(/<textarea[^>]*maxlength/i);
  });

  test("while revising: Revising…, inputs and Approve disabled, no second submit", async () => {
    const out = html("story", { revise: controls({ open: true, feedback: "Tighten the opening.", running: true }) });
    expect(out).toContain("Revising…</button>");
    expect(out).toMatch(/<textarea[^>]*disabled=""/);
    expect(out).toMatch(/disabled=""[^>]*>Approve &amp; continue</);
    const onRevise = vi.fn(async () => {});
    expect(await submitRevision("Tighten the opening.", true, onRevise)).toEqual({ status: "skipped" });
    expect(onRevise).not.toHaveBeenCalled();
  });

  test("submit sends the trimmed feedback once and never approves", async () => {
    const onRevise = vi.fn(async () => {});
    expect(await submitRevision("  Cut the second act.\n", false, onRevise)).toEqual({ status: "ok" });
    expect(onRevise.mock.calls).toEqual([["Cut the second act."]]);
    const revise = controls({ open: true, feedback: "Cut the second act." });
    const onApprove = vi.fn();
    // The first "Revise story" is the submit in the feedback box; the last is the footer opener.
    const tree = view("story", { revise, onApprove });
    const all: any[] = [];
    const walk = (n: any): void => {
      if (Array.isArray(n)) return n.forEach(walk);
      if (!n || typeof n !== "object") return;
      if (n.type === "button" && text(n) === "Revise story") all.push(n);
      walk(n.props?.children);
    };
    walk(StoryReviewView(tree.props));
    expect(all).toHaveLength(2);
    all[0].props.onClick();
    expect(revise.onSubmit).toHaveBeenCalledOnce();
    expect(revise.onOpen).not.toHaveBeenCalled();
    expect(onApprove).not.toHaveBeenCalled();
  });

  test("a failure is reported and shown; the current draft stays on screen", async () => {
    const out1 = await submitRevision("Fix fact 2.", false, async () => {
      throw new Error("OpenAI responses 500");
    });
    expect(out1).toEqual({ status: "failed", error: "OpenAI responses 500" });
    const out = html("story", { revise: controls({ open: true, feedback: "Fix fact 2.", notice: { kind: "failed", message: "OpenAI responses 500" } }) });
    const alert = out.slice(out.indexOf('role="alert"'), out.indexOf("<footer"));
    expect(alert).toContain("Revision failed");
    expect(alert).toContain("The current draft was not changed.");
    expect(alert).toContain("OpenAI responses 500");
    expect(out).toMatch(/role="alert" class="[^"]*border-accent/); // not muted helper text
    expect(out).toContain("Fix fact 2."); // the pasted feedback is kept for a retry
    expect(out).toMatch(/<button class="btn btn-ghost">Revise story</); // retry is available
    expect(out).toContain("Generated title T-91");
    expect(out).not.toContain("Revision applied");
  });

  test("a successful revision says it was applied and still waits for Approve", () => {
    const onApprove = vi.fn();
    const out = html("story", { review: revised, onApprove, revise: controls({ notice: { kind: "applied" } }) });
    const status = out.slice(out.indexOf('role="status"'), out.indexOf("<footer"));
    expect(status).toContain("Revision applied");
    expect(status).toContain("Review the updated draft before approving.");
    expect(out).not.toContain("Revision failed");
    expect(out).toMatch(/<button class="btn btn-primary">Approve &amp; continue</);
    expect(onApprove).not.toHaveBeenCalled();
    // Opening the box again for another pass hides the old confirmation.
    expect(html("story", { revise: controls({ open: true, notice: { kind: "applied" } }) })).not.toContain("Revision applied");
  });

  test("a revised review renders normally, and Copy Director Review copies the revision", async () => {
    const story = html("story", { review: revised, revise: controls() });
    expect(story).toContain("Revised title R-4");
    expect(story).toContain("Revised moment RM-1");
    expect(story).not.toContain("Generated title T-91");
    expect(html("long", { review: revised })).toContain("Revised long RL-1.");
    expect(html("short", { review: revised })).toContain("Revised short RS-1.");
    expect(html("facts", { review: revised })).toContain("Revised fact RF-1.");
    // Still at the text gate: Approve is there, enabled, and waits for a click.
    expect(story).toMatch(/<button class="btn btn-primary">Approve &amp; continue</);

    const clip = { writeText: vi.fn(async () => {}) };
    expect(await copyDirectorReview(revised, clip)).toBe(true);
    const md = clip.writeText.mock.calls[0][0] as string;
    expect(md).toContain("## TITLE\n\nRevised title R-4\n");
    expect(md).toContain("## LONG SCRIPT\n\nRevised long RL-1.\n");
    expect(md).not.toContain("Generated title T-91");
    expect(md).not.toContain("Long script L-1");
  });

  test("the panel shows the Revise story action only when revision is wired", () => {
    const withIt = renderToStaticMarkup(React.createElement(StoryReviewPanel, { review, onApprove: vi.fn(), approving: false, onRevise: vi.fn(async () => {}) }));
    expect(withIt).toContain(">Revise story</button>");
    expect(withIt).not.toContain("<textarea");
    const without = renderToStaticMarkup(React.createElement(StoryReviewPanel, { review, onApprove: vi.fn(), approving: false }));
    expect(without).not.toContain("Revise story");
  });
});

describe("Automatic Text QA on the Creating screen", () => {
  const job =(over: Partial<Job>): Job =>
    ({ id: "j", storyId: "s", state: "awaiting_text", step: "scripts", message: "", error: null, mock: false, estimatedCost: 5, approvedMax: 15, spent: 1, preview: null, createdAt: "", updatedAt: "", ...over }) as Job;
  const progress = (j: Job) => renderToStaticMarkup(React.createElement(CreatingProgress, { job: j }));

  test("a stop opens the Story Review with the reason above it, and every manual tool stays", () => {
    const qa = {
      status: "stopped" as const,
      stage: "final_verify" as const,
      message: "Text repair completed, but the final verification still needs you.",
      summary: "The Short still overstates SO-1.",
      issues: [{ section: "short" as const, reason: "Ends on a weak statistic WS-4." }],
      feedback: "Remove the disputed fact FX-2.",
      error: undefined,
    };
    const out = renderToStaticMarkup(React.createElement(StoryReviewPanel, { review, onApprove: vi.fn(), approving: false, onRevise: vi.fn(async () => {}), qa }));
    const panel = out.slice(out.indexOf('aria-label="Text QA"'), out.indexOf('role="tablist"'));
    for (const s of ["Text QA needs you", qa.message, "The Short still overstates SO-1.", "Issues:", "Short script:</span> Ends on a weak statistic WS-4.", "Remove the disputed fact FX-2."]) expect(panel).toContain(s);
    for (const t of ["Story", "Facts &amp; Sources", "Long script", "Short script"]) expect(out).toContain(`>${t}</button>`);
    for (const b of ["Copy Director Review", "Revise story", "Approve &amp; continue"]) expect(out).toContain(`>${b}</button>`);
    expect(out).toContain("Generated title T-91"); // the current draft stays visible

    const failed = renderToStaticMarkup(
      React.createElement(StoryReviewPanel, { review, onApprove: vi.fn(), approving: false, qa: { status: "stopped", stage: "director_review", message: "Text QA could not complete. Review the current draft manually.", summary: "", issues: [], error: "OpenAI responses 500" } }),
    );
    expect(failed).toContain("Text QA could not complete. Review the current draft manually.");
    expect(failed).toContain("OpenAI responses 500");
    expect(failed).not.toContain("Issues:");
    // No Text QA state: the Story Review is exactly as before.
    expect(renderToStaticMarkup(React.createElement(StoryReviewPanel, { review, onApprove: vi.fn(), approving: false }))).not.toContain("Text QA");
  });

  test("while Text QA runs the progress screen shows its phases, never the approval", () => {
    const reviewing = progress(job({ textQa: { status: "running", phase: "review" } }));
    expect(reviewing).toContain("Director reviewing…</h1>");
    expect(reviewing).not.toContain("Applying text repair");
    expect(reviewing).not.toContain("Approve");

    const verifying = progress(job({ textQa: { status: "running", phase: "verify" } }));
    expect(verifying).toContain("Final text verification…</h1>");
    const qaList = verifying.slice(verifying.indexOf('aria-label="Text QA"'));
    for (const s of ["Director reviewing", "Applying text repair", "Final text verification"]) expect(qaList).toContain(s);

    const passed = progress(job({ state: "queued", step: "queued", textQa: { status: "passed" } }));
    expect(passed).toContain("Text QA passed. Continuing to visuals…");
    expect(progress(job({ state: "running", step: "scripts", progress: { current: 2, total: 2 } }))).toContain("Auditing scripts…</h1>");
    expect(progress(job({ state: "running", step: "research" }))).toContain("Researching the story…</h1>");
  });
});
