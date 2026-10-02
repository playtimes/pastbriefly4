import { describe, test, expect, vi } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Job, StoryReview } from "../src/types.ts";

// The text-review workspace. Static renders per tab, plus the tab and approve
// handlers invoked directly. No server, no provider, no DOM.
const { StoryReviewPanel, StoryReviewView, TextIssueView, IssueText, buildStoryReviewClipboardText, submitRevision } = await import("../src/app/screens/Creating.tsx");
const { ProductionProgress } = await import("../src/app/screens/Production.tsx");

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

const view = (tab: any, over: Partial<{ review: StoryReview; onTab: any; onApprove: any; approving: boolean; revise: any }> = {}) =>
  React.createElement(StoryReviewView, { review, tab, onTab: vi.fn(), onApprove: vi.fn(), approving: false, ...over });
const html = (tab: any, over = {}) => renderToStaticMarkup(view(tab, over));

// Find a button in a hook-free element tree by its text (function components,
// like the revise form and More, are expanded by calling them).
const text = (n: any): string =>
  n == null || typeof n === "boolean" ? "" : Array.isArray(n) ? n.map(text).join("") : typeof n === "object" ? text(n.props?.children) : String(n);
function buttons(tree: any, label: string): any[] {
  const out: any[] = [];
  const walk = (n: any) => {
    if (Array.isArray(n)) return n.forEach(walk);
    if (!n || typeof n !== "object") return;
    if (typeof n.type === "function") return walk(n.type(n.props));
    if (n.type === "button" && text(n) === label) out.push(n);
    walk(n.props?.children);
  };
  walk(tree);
  return out;
}
const button = (tree: any, label: string): any => buttons(tree, label).at(-1);

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
    expect(out).toContain("Continue production");
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
    expect(out.slice(panel, footer)).not.toContain("Continue production");
    expect(out.slice(footer)).toContain("Continue production");
  });

  test("tab buttons select their tab; Continue production calls the existing approval", () => {
    const onTab = vi.fn();
    const onApprove = vi.fn();
    const tree = view("story", { onTab, onApprove });
    button(tree, "Facts & Sources").props.onClick();
    button(tree, "Long script").props.onClick();
    button(tree, "Short script").props.onClick();
    button(tree, "Story").props.onClick();
    expect(onTab.mock.calls.map((c) => c[0])).toEqual(["facts", "long", "short", "story"]);
    button(tree, "Continue production").props.onClick();
    expect(onApprove).toHaveBeenCalledOnce();
  });

  test("approving keeps the existing disabled / Continuing state", () => {
    const tree = view("story", { approving: true });
    const b = button(tree, "Continuing…");
    expect(b.props.disabled).toBe(true);
  });
});

describe("the review text packet", () => {

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

  test("the footer offers Revise story, then Continue production, and nothing else", () => {
    const footer = html("long", { revise: controls() }).split("<footer")[1];
    expect(footer.indexOf(">Continue production</button>")).toBeGreaterThan(footer.indexOf(">Revise story</button>"));
    expect(footer).toMatch(/class="btn btn-ghost"[^>]*>Revise story</);
    expect(footer).not.toMatch(/Copy|More|Director Review/);
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
    expect(out).toMatch(/disabled=""[^>]*>Continue production</);
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
    const all = buttons(tree, "Revise story");
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

  test("a successful revision says it was applied and still waits for Continue production", () => {
    const onApprove = vi.fn();
    const out = html("story", { review: revised, onApprove, revise: controls({ notice: { kind: "applied" } }) });
    const status = out.slice(out.indexOf('role="status"'), out.indexOf("<footer"));
    expect(status).toContain("Revision applied");
    expect(status).toContain("Read the updated story, then continue production.");
    expect(out).not.toContain("Revision failed");
    expect(out).toMatch(/<button class="btn btn-primary">Continue production</);
    expect(onApprove).not.toHaveBeenCalled();
    // Opening the box again for another pass hides the old confirmation.
    expect(html("story", { revise: controls({ open: true, notice: { kind: "applied" } }) })).not.toContain("Revision applied");
  });

  test("a revised review renders normally and still waits for Continue production", () => {
    const story = html("story", { review: revised, revise: controls() });
    expect(story).toContain("Revised title R-4");
    expect(story).toContain("Revised moment RM-1");
    expect(story).not.toContain("Generated title T-91");
    expect(html("long", { review: revised })).toContain("Revised long RL-1.");
    expect(html("short", { review: revised })).toContain("Revised short RS-1.");
    expect(html("facts", { review: revised })).toContain("Revised fact RF-1.");
    expect(story).toMatch(/<button class="btn btn-primary">Continue production</);
    expect(buildStoryReviewClipboardText(revised)).toContain("## LONG SCRIPT\n\nRevised long RL-1.\n");
  });

  test("the panel shows the Revise story action only when revision is wired", () => {
    const withIt = renderToStaticMarkup(React.createElement(StoryReviewPanel, { review, onApprove: vi.fn(), approving: false, onRevise: vi.fn(async () => {}) }));
    expect(withIt).toContain(">Revise story</button>");
    expect(withIt).not.toContain("<textarea");
    const without = renderToStaticMarkup(React.createElement(StoryReviewPanel, { review, onApprove: vi.fn(), approving: false }));
    expect(without).not.toContain("Revise story");
  });
});

describe("Text needs you: the simple issue view and the advanced review", () => {
  const job = (over: Partial<Job>): Job =>
    ({ id: "j", storyId: "s", state: "awaiting_text", step: "scripts", message: "", error: null, mock: false, estimatedCost: 5, approvedMax: 15, spent: 1, preview: null, createdAt: "", updatedAt: "", ...over }) as Job;
  const progress = (j: Job) => renderToStaticMarkup(React.createElement(ProductionProgress, { job: j }));
  const controls = (over: Record<string, unknown> = {}) => ({ open: false, feedback: "", running: false, notice: null, onOpen: vi.fn(), onCancel: vi.fn(), onFeedback: vi.fn(), onSubmit: vi.fn(), ...over });
  const issueProps = (over: Record<string, unknown> = {}) =>
    ({ review, issue: { section: "long", reason: "The Long says not a single shot was fired LR-7." }, index: 0, total: 2, onBack: vi.fn(), onNext: vi.fn(), onApprove: vi.fn(), approving: false, more: null, revise: controls(), ...over }) as any;
  const issueHtml = (over: Record<string, unknown> = {}) => renderToStaticMarkup(React.createElement(TextIssueView, issueProps(over)));

  test("one issue: its section, its reason and only the text it is about", () => {
    const out = issueHtml();
    expect(out).toContain("Issue 1 of 2");
    expect(out).toContain(">Long script</h1>");
    expect(out).toContain("The Long says not a single shot was fired LR-7.");
    const content = out.slice(out.indexOf("data-issue-content"));
    expect(content).toContain("Long script L-1.\n\nLong paragraph L-2.");
    for (const s of ["Short script S-9", "Fact F-1", "Moment one M-1"]) expect(content).not.toContain(s);
    // Not the workspace: no tabs, no approval, no packet.
    for (const s of ['role="tablist"', "Approve", "Copy Director Review", "Text QA"]) expect(out).not.toContain(s);
    // The other sections show their own content.
    const at = (section: string) => renderToStaticMarkup(React.createElement(IssueText, { review, section } as any));
    expect(at("facts")).toContain("Fact F-1 in full.");
    expect(at("short")).toContain("Short script S-9.");
    expect(at("spine")).toContain("Moment one M-1");
    expect(at("hook")).toContain("Generated hook H-37");
    expect(at("hook")).not.toContain("Moment one");
  });

  test("Revise story opens the existing revision, started from the issue; Next issue and Back work", () => {
    const p = issueProps();
    const tree = React.createElement(TextIssueView, p);
    button(tree, "Revise story").props.onClick();
    expect(p.revise.onOpen.mock.calls).toEqual([["Revise the long script: The Long says not a single shot was fired LR-7."]]);
    button(tree, "Next issue →").props.onClick();
    button(tree, "← Back to issues").props.onClick();
    expect(p.onNext).toHaveBeenCalledOnce();
    expect(p.onBack).toHaveBeenCalledOnce();
    expect(issueHtml({ onNext: undefined })).not.toContain("Next issue");
    // Open: the same feedback form as the advanced review; submit goes through it.
    const open = issueProps({ revise: controls({ open: true, feedback: "Cut the claim." }) });
    expect(renderToStaticMarkup(React.createElement(TextIssueView, open))).toMatch(/<textarea[^>]*>Cut the claim\.<\/textarea>/);
    buttons(React.createElement(TextIssueView, open), "Revise story")[0].props.onClick();
    expect(open.revise.onSubmit).toHaveBeenCalledOnce();
  });

  test("after a revision, continuing is the decision", () => {
    const p = issueProps({ revise: controls({ notice: { kind: "applied" } }) });
    const out = renderToStaticMarkup(React.createElement(TextIssueView, p));
    expect(out).toContain("Revision applied.");
    button(React.createElement(TextIssueView, p), "Continue production").props.onClick();
    expect(p.onApprove).toHaveBeenCalledOnce();
    expect(issueHtml()).not.toContain("Continue production"); // not before a revision
  });

  test("the whole story opens on the issue's tab, returns to the issue, and keeps only Revise story and Continue production", () => {
    const onBack = vi.fn();
    const out = renderToStaticMarkup(React.createElement(StoryReviewPanel, { review, onApprove: vi.fn(), approving: false, onRevise: vi.fn(async () => {}), initialTab: "short", onBack, backLabel: "Back to issue" }));
    expect(out).toContain("The whole story");
    expect(out).toMatch(/aria-selected="true"[^>]*>Short script</);
    for (const t of ["Story", "Facts &amp; Sources", "Long script", "Short script"]) expect(out).toContain(`>${t}</button>`);
    for (const b of ["Revise story", "Continue production"]) expect(out).toContain(`>${b}</button>`);
    expect(out).not.toMatch(/Copy Director Review|Text QA|Issue 1|Production details|Review whether the story is clear and interesting/);
    button(view("short", { onBack, backLabel: "Back to issue" } as any), "← Back to issue").props.onClick();
    expect(onBack).toHaveBeenCalledOnce();
    expect(html("facts")).not.toContain("Back to"); // not opened from anywhere: no back link
  });

  test("while Text QA runs the progress screen reads Writing: no QA phase, no stale script count, never the approval", () => {
    // The finished Scripts count is still on the job at the text gate.
    const reviewing = progress(job({ textQa: { status: "running", phase: "review" }, progress: { current: 2, total: 2 } }));
    expect(reviewing).toContain("Writing…</h1>");
    expect(reviewing).toContain("Step 2 of 6");
    expect(reviewing).toContain('aria-current="step" data-stage-current="writing"');
    const primary = reviewing.slice(0, reviewing.indexOf("<details"));
    for (const s of ["Director reviewing", "Applying text repair", "Final text verification", "%", "2 / 2", "Text QA"]) expect(primary).not.toContain(s);
    expect(reviewing).not.toContain("Approve");

    const verifying = progress(job({ textQa: { status: "running", phase: "verify" } }));
    expect(verifying).toContain("Writing…</h1>");
    expect(verifying).not.toMatch(/verify|Text QA|review ·/); // no check phase anywhere, details included

    // Approved: Writing is ticked and production resumes at narration.
    const passed = progress(job({ state: "queued", step: "queued", textQa: { status: "passed" } }));
    expect(passed).toContain("Recording narration…</h1>");
    expect(passed).toMatch(/✓<\/span>Writing<\/li>/);
    expect(progress(job({ state: "running", step: "scripts", progress: { current: 1, total: 2 } }))).toContain("Step 2 of 6 · 50%");
    const auditing = progress(job({ state: "running", step: "scripts", progress: { current: 2, total: 2 } }));
    expect(auditing).toContain("Writing…</h1>");
    expect(auditing.slice(0, auditing.indexOf("<details"))).not.toContain("%");
    expect(progress(job({ state: "running", step: "research" }))).toContain("Researching…</h1>");
  });
});

describe("a Long-first draft (Stage 16A): no Short anywhere in the review", () => {
  const { shortScript: _s, ...longOnly } = review;
  test("no Short tab and no empty Short pane; the pair review keeps all four tabs", () => {
    const out = renderToStaticMarkup(React.createElement(StoryReviewPanel, { review: longOnly as StoryReview, onApprove: vi.fn(), approving: false }));
    for (const t of ["Story", "Facts &amp; Sources", "Long script"]) expect(out).toContain(`>${t}</button>`);
    expect(out).not.toContain("Short script");
    const pair = renderToStaticMarkup(React.createElement(StoryReviewPanel, { review, onApprove: vi.fn(), approving: false }));
    expect(pair).toContain(">Short script</button>");
  });

  test("the review packet has no Short section and no Short check; the pair packet is unchanged", () => {
    const md = buildStoryReviewClipboardText(longOnly as StoryReview);
    expect(md).toContain("## LONG SCRIPT\n\nLong script L-1.\n\nLong paragraph L-2.\n\n## REVIEW REQUEST");
    expect(md).not.toMatch(/SHORT|Short|undefined/);
    expect(md).toContain("6. Does the story have enough depth for the Long without artificial padding?\n7. Give a final decision:");
    const pair = buildStoryReviewClipboardText(review);
    expect(pair).toContain("## SHORT SCRIPT\n\nShort script S-9.\n\n## REVIEW REQUEST");
    expect(pair).toContain("6. Does the Short preserve the strongest version of the premise?\n7. Does the story have enough depth for the Long without artificial padding?\n8. Give a final decision:");
  });
});
