import React, { useEffect, useRef, useState } from "react";
import { api } from "../api.ts";
import { navigate } from "../App.tsx";
import { FailedJobDetails, ApproveMoreResume, isBudgetFailure } from "../failedJob.tsx";
import { displayStage, gateFace, latestCompletePair, productionFace, productionTarget, type CompletePair, type DisplayStage } from "../productionStage.ts";
import { VisualReview } from "../visualReview/VisualReview.tsx";
import { buildFilm, regenKey } from "../visualReview/model.ts";
import { visualIssues, type VisualIssue } from "../visualReview/visualIssues.ts";
import { VisualIssuePanel } from "../visualReview/IssueView.tsx";
import type { RegenDraft } from "../visualReview/Inspector.tsx";
import { FinalException, FinalFilmReview, ProductionProgress, ReadyPanel, SECTION_LABEL, SECTION_TAB, TextException, TextMore, VisualException, VisualMore } from "./Production.tsx";
import { directorFeedbackError, productionMediaPrefix, type Job, type PreviewFrame, type SequenceRevisionReport, type StoryReview, type TextQaIssue, type TextQaSection, type VideoKind } from "../../types.ts";

// The Production screen for one story's current job. Its faces follow the job:
// Running, Text needs you, Visuals need you, Films need you, Failed and Ready.
// A gate opens on its issue list, then one issue at a time. PB4 runs its own
// checks; the user only makes the creative calls.
export function Creating({ slug }: { slug: string }): React.ReactElement {
  const [job, setJob] = useState<Job | null>(null);
  const [error, setError] = useState("");
  const [continuing, setContinuing] = useState(false);
  const [acceptingFinal, setAcceptingFinal] = useState(false);
  const [approvingText, setApprovingText] = useState(false);
  const [rebuilding, setRebuilding] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [regenerating, setRegenerating] = useState<string | null>(null);
  const [imageVersion, setImageVersion] = useState(0);
  const [regenFailed, setRegenFailed] = useState<{ key: string; message: string } | null>(null);
  const [regenDone, setRegenDone] = useState<string | null>(null);
  const [regenDraft, setRegenDraft] = useState<RegenDraft | null>(null);
  const [revisingSequence, setRevisingSequence] = useState(false);
  const [storyTitle, setStoryTitle] = useState("");
  const [maxSpend, setMaxSpend] = useState(0);
  // Where the user is inside a gate (null: the issue summary).
  const [textView, setTextView] = useState<TextView | null>(null);
  const [visualView, setVisualView] = useState<VisualView | null>(null);
  const [finalView, setFinalView] = useState<VideoKind | null>(null);
  // The finished Long + Short pair the done job rendered (the Ready face).
  const [ready, setReady] = useState<CompletePair | null>(null);
  const jobId = useRef<string | null>(null);
  const lastStage = useRef<DisplayStage | undefined>(undefined);
  // The job and gate whose face was last handed to the user: it stays theirs
  // until the job moves on, even if a manual edit refreshes updatedAt.
  const handedOver = useRef<string | null>(null);

  useEffect(() => {
    api.config().then((c) => setMaxSpend(c.maxSpendUsd)).catch(() => {});
  }, []);

  // Every job the screen shows goes through here, so a requeued job (step
  // "queued") keeps the stage it was last seen in.
  function show(j: Job): void {
    lastStage.current = displayStage(j, lastStage.current);
    setJob(j);
  }

  useEffect(() => {
    let stop = false;
    let finished = false;
    async function tick(): Promise<void> {
      if (finished) return;
      try {
        if (!jobId.current) {
          const detail = await api.story(slug);
          if (stop) return;
          setStoryTitle(detail.story.title);
          // The active job, the failed latest job, or the job behind the newest
          // complete Long + Short pair (Ready); otherwise navigate as before.
          const target = productionTarget(detail);
          if ("navigate" in target) return navigate(target.navigate === "watch" ? `/story/${slug}/watch` : `/story/${slug}`);
          jobId.current = target.jobId;
        }
        const { job } = await api.job(jobId.current!);
        if (stop) return;
        if (job.state === "done") {
          // Ready stays on this route, with no redirect: this job's own pair only.
          const detail = await api.story(slug);
          if (stop) return;
          const pair = latestCompletePair(detail.videos, job.id, detail.longCompleteJobIds);
          if (!pair) return navigate(`/story/${slug}/watch`);
          finished = true; // nothing left to poll
          setReady(pair);
        }
        show(job);
      } catch (e: any) {
        if (!stop) setError(e.message);
      }
    }
    tick();
    const t = setInterval(tick, 1500);
    return () => {
      stop = true;
      clearInterval(t);
    };
  }, [slug]);

  // A new face starts on its summary, never inside a stale deep review.
  useEffect(() => {
    setTextView(null);
    setVisualView(null);
    setFinalView(null);
  }, [job?.state]);

  async function cont(): Promise<void> {
    if (!jobId.current) return;
    setContinuing(true);
    try {
      await api.continue(jobId.current);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setContinuing(false);
    }
  }

  // Accept the finished films as they are; the job goes back to queued and the
  // poll loop above follows it to Ready.
  async function acceptFinal(): Promise<void> {
    if (!jobId.current) return;
    setAcceptingFinal(true);
    try {
      const { job } = await api.acceptFinal(jobId.current);
      show(job);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setAcceptingFinal(false);
    }
  }

  // Approve the story text and resume; the job goes back to queued and the poll
  // loop above takes over the progress UI through to the visual preview gate.
  async function approveText(): Promise<void> {
    if (!jobId.current) return;
    setApprovingText(true);
    try {
      const { job } = await api.approveText(jobId.current);
      show(job);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setApprovingText(false);
    }
  }

  // Revise the story text from Director feedback. The job stays at the text gate;
  // the returned job carries the revised review. Errors are thrown to the review
  // screen, which keeps the current draft and the pasted feedback.
  async function reviseText(feedback: string): Promise<void> {
    if (!jobId.current) throw new Error("The job is not loaded yet.");
    const { job } = await api.reviseText(jobId.current, feedback);
    show(job);
  }

  // Research more from Director feedback naming the missing evidence: the job
  // stays at the text gate and comes back with the refreshed research and draft.
  // Errors are thrown to the review screen, which keeps the current draft.
  async function researchMore(feedback: string): Promise<void> {
    if (!jobId.current) throw new Error("The job is not loaded yet.");
    const { job } = await api.researchMore(jobId.current, feedback);
    show(job);
  }

  // Revise one film's edit from Director feedback at the visual preview. The job
  // stays at the preview; errors are thrown to the Director board, which keeps
  // the current board and the pasted feedback. targetSlot (from an issue) limits
  // the change to that one slot.
  async function reviseSequence(kind: "long" | "short", feedback: string, targetSlot?: number): Promise<SequenceRevisionReport> {
    if (!jobId.current) throw new Error("The job is not loaded yet.");
    setRevisingSequence(true);
    try {
      const { job, revision } = await api.reviseSequence(jobId.current, kind, feedback, targetSlot);
      show(job);
      return revision;
    } finally {
      setRevisingSequence(false);
    }
  }

  // Reject the previewed visuals and rebuild them under the same job. The job goes
  // back to queued, so the polling loop above takes over the progress UI.
  async function rebuild(): Promise<void> {
    if (!jobId.current) return;
    setRebuilding(true);
    try {
      const { job } = await api.rebuildVisuals(jobId.current);
      show(job);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setRebuilding(false);
    }
  }

  // Regenerate one owner still in place. The job stays at the preview gate; the
  // returned preview replaces the old one and the version bump reloads the images.
  // The review keeps its film, mode and slot: only the job and the images change.
  // Optional Director feedback rides along for this one call; the open feedback
  // box is cleared only on success, so a failure keeps it for a retry.
  async function regenerate(f: PreviewFrame, directorFeedback?: string): Promise<void> {
    if (!jobId.current || typeof f.slot !== "number") return;
    const key = regenKey(f);
    setRegenerating(key);
    setRegenFailed(null);
    setRegenDone(null);
    try {
      const { job } = await api.regenerateStill(jobId.current, f.kind, f.slot, directorFeedback);
      show(job);
      setImageVersion(Date.now());
      setRegenDone(key);
      setRegenDraft(null);
    } catch (e: any) {
      setRegenFailed({ key, message: e.message }); // the preview is unchanged; the old still stays
    } finally {
      setRegenerating(null);
    }
  }

  async function retry(): Promise<void> {
    if (!jobId.current) return;
    setRetrying(true);
    try {
      const { job } = await api.retry(jobId.current);
      show(job);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setRetrying(false);
    }
  }

  // Raise the approved max and resume; the job goes back to queued and the poll
  // loop above takes over the progress UI.
  async function approveMore(newApprovedMax: number): Promise<void> {
    if (!jobId.current) return;
    const { job } = await api.approveSpend(jobId.current, newApprovedMax);
    show(job);
  }

  if (error) return <Fail slug={slug} message={error} />;
  if (!job) return <p className="text-muted">Preparing…</p>;
  let face = productionFace(job);
  const gate = gateFace(job);
  const gateKey = `${job.id}:${job.state}`;
  if (face === "running" && gate && handedOver.current === gateKey) face = gate;
  if (face === "text" || face === "visuals" || face === "final") handedOver.current = gateKey;
  if (face === "failed") return <Fail slug={slug} job={job} onRetry={retry} retrying={retrying} maxSpend={maxSpend} onApproveMore={approveMore} />;

  // Films need you: the concerns grouped by film, then one finished film at a
  // time. Only local state: watching never touches the job. Continue anyway
  // accepts both films.
  if (face === "final") {
    const issues = job.finalQa?.issues ?? [];
    if (finalView) return <FinalFilmReview slug={slug} media={productionMediaPrefix(job.id, job.flow === "long-first")} film={finalView} issues={issues} onFilm={setFinalView} onBack={() => setFinalView(null)} onContinue={acceptFinal} continuing={acceptingFinal} />;
    return <FinalException storyTitle={storyTitle} issues={issues} onReview={setFinalView} onContinue={acceptFinal} continuing={acceptingFinal} />;
  }

  if (face === "done") {
    if (!ready || ready.jobId !== job.id) return <p className="text-muted">Preparing…</p>;
    return <ReadyPanel storyTitle={storyTitle} job={job} pair={ready} onWatch={(film) => navigate(`/story/${slug}/watch/${film}`)} />;
  }

  // Text needs you: the issue list, then one issue at a time. The whole story is
  // there to read, quietly, behind More.
  if (face === "text") {
    const review = job.review!;
    const qa = job.textQa?.status === "stopped" ? job.textQa : undefined;
    const issues = qa?.issues ?? [];
    const more = (from: number | null, tab: ReviewTab) => <TextMore onWholeStory={() => setTextView({ whole: tab, from })} onApprove={approveText} approving={approvingText} />;
    if (textView && "whole" in textView) {
      const { from } = textView;
      return (
        <StoryReviewPanel
          key={textView.whole}
          review={review}
          initialTab={textView.whole}
          backLabel={from === null ? "Back to issues" : "Back to issue"}
          onBack={() => setTextView(from === null ? null : { issue: from })}
          onApprove={approveText}
          approving={approvingText}
          onRevise={reviseText}
          onResearchMore={researchMore}
        />
      );
    }
    const n = textView?.issue ?? -1;
    if (issues[n]) {
      return (
        <TextIssuePanel
          key={n}
          review={review}
          issue={issues[n]}
          index={n}
          total={issues.length}
          onBack={() => setTextView(null)}
          onNext={issues.length > 1 ? () => setTextView({ issue: (n + 1) % issues.length }) : undefined}
          onRevise={reviseText}
          onApprove={approveText}
          approving={approvingText}
          more={more(n, SECTION_TAB[issues[n].section])}
        />
      );
    }
    return (
      <TextException
        storyTitle={storyTitle}
        qa={qa}
        passed={job.textQa?.status === "passed"}
        onReview={(i) => setTextView({ issue: i })}
        onOpenReview={() => setTextView({ whole: "story", from: null })}
        more={more(null, "story")}
      />
    );
  }

  // Visuals need you: the issue list, then one issue at a time with its one
  // creative fix. The films are there to look through, quietly, behind More.
  if (face === "visuals") {
    const preview = job.preview!;
    const films = { long: buildFilm(preview, "long"), short: buildFilm(preview, "short") };
    const issues = visualIssues(job, films);
    // A visual change in flight, or one of PB4's own sequence checks still running.
    const sequenceBusy = revisingSequence || job.directorQa?.long?.status === "running" || job.directorQa?.short?.status === "running";
    const busy = sequenceBusy || regenerating !== null;
    const regen = { running: regenerating, failed: regenFailed, done: regenDone, blocked: sequenceBusy };
    const more = (from: VisualIssue | null, showContinue = true) => (
      <VisualMore onFilms={() => setVisualView({ films: from })} onContinue={cont} onRebuild={rebuild} continuing={continuing} rebuilding={rebuilding} busy={busy} showContinue={showContinue} />
    );
    if (visualView && "films" in visualView) {
      const from = visualView.films;
      return (
        <VisualReview
          key={from?.key ?? ""}
          preview={preview}
          backLabel={from ? "Back to issue" : "Back to issues"}
          target={from?.film ? { film: from.film, index: from.target?.index } : undefined}
          version={imageVersion}
          onBack={() => setVisualView(from ? { issue: from } : null)}
          onRegenerate={regenerate}
          regen={regen}
          draft={regenDraft}
          onDraft={setRegenDraft}
          onReviseSequence={reviseSequence}
          busy={sequenceBusy}
        />
      );
    }
    if (visualView) {
      const opened = visualView.issue;
      const at = issues.findIndex((i) => i.key === opened.key);
      const next = issues.length ? issues[(at + 1) % issues.length] : undefined;
      return (
        <VisualIssuePanel
          key={opened.key}
          issue={at >= 0 ? issues[at] : opened}
          position={at >= 0 ? { index: at, total: issues.length } : null}
          films={films}
          version={imageVersion}
          onBack={() => setVisualView(null)}
          onNext={next && next.key !== opened.key ? () => setVisualView({ issue: next }) : undefined}
          onRegenerate={regenerate}
          regen={regen}
          draft={regenDraft}
          onDraft={setRegenDraft}
          onReviseSequence={reviseSequence}
          busy={busy}
          more={more(at >= 0 ? issues[at] : opened)}
        />
      );
    }
    return <VisualException job={job} storyTitle={storyTitle} issues={issues} version={imageVersion} onReview={(i) => setVisualView({ issue: i })} onContinue={cont} continuing={continuing} busy={busy} more={more(null, issues.length > 0)} />;
  }

  // PB4 at work, including Text QA and the visual checks at the gates.
  return <ProductionProgress job={job} storyTitle={storyTitle} previous={lastStage.current} />;
}

// Inside a gate: one issue, or the whole story / the films (and the issue they
// were opened from).
type TextView = { issue: number } | { whole: ReviewTab; from: number | null };
// A visual issue is kept as opened, so fixing it does not pull the screen away.
type VisualView = { issue: VisualIssue } | { films: VisualIssue | null };

export type ReviewTab = "story" | "facts" | "long" | "short";
const REVIEW_TABS: [ReviewTab, string][] = [
  ["story", "Story"],
  ["facts", "Facts & Sources"],
  ["long", "Long script"],
  ["short", "Short script"],
];

// The whole story: every part of the text in one viewport-sized workspace, with
// Revise story, Research more and Continue production. Header and tabs on top,
// only the active tab scrolls, and the footer never scrolls away. The tab is
// local UI state only - never persisted, routed or sent anywhere.
export function StoryReviewPanel(props: {
  review: StoryReview;
  onApprove: () => void;
  approving: boolean;
  onRevise?: (feedback: string) => Promise<void>;
  onResearchMore?: (feedback: string) => Promise<void>; // the evidence is too thin: research further
  initialTab?: ReviewTab; // opened from a Text QA issue: its tab
  onBack?: () => void;
  backLabel?: string;
}): React.ReactElement {
  const { onRevise, onResearchMore, initialTab, ...rest } = props;
  const [tab, setTab] = useState<ReviewTab>(initialTab ?? "story");
  const revise = useRevise(onRevise, () => setTab("story"));
  // Research more uses the same feedback form and state as a revision.
  const research = useRevise(onResearchMore, () => setTab("story"));
  return <StoryReviewView {...rest} tab={tab} onTab={setTab} revise={revise} research={research} />;
}

// The outcome of the last revision attempt in this Story Review session. Local
// only: it does not survive a reload and is never sent anywhere.
export type ReviseNotice = { kind: "invalid"; message: string } | { kind: "failed"; message: string } | { kind: "applied" };

// The inline Director revision: local UI state only. The review itself is never
// touched here - it changes only when the job comes back with a revised review.
export interface ReviseControls {
  open: boolean;
  feedback: string;
  running: boolean;
  notice?: ReviseNotice | null;
  onOpen: (prefill?: string) => void; // prefill: a starting instruction, kept if feedback was already typed
  onCancel: () => void;
  onFeedback: (v: string) => void;
  onSubmit: () => void;
}

// The revision form's state: local, never stored. `onApplied` runs after a
// successful revision. Undefined when revision is not wired.
export function useRevise(onRevise: ((feedback: string) => Promise<void>) | undefined, onApplied?: () => void): ReviseControls | undefined {
  const [open, setOpen] = useState(false);
  const [feedback, setFeedback] = useState("");
  const [running, setRunning] = useState(false);
  const [notice, setNotice] = useState<ReviseNotice | null>(null);
  const onSubmit = async () => {
    if (!onRevise || running) return;
    setNotice(null);
    setRunning(true);
    const out = await submitRevision(feedback, false, onRevise);
    setRunning(false);
    if (out.status === "invalid") setNotice({ kind: "invalid", message: out.error });
    if (out.status === "failed") setNotice({ kind: "failed", message: out.error });
    if (out.status === "ok") {
      setOpen(false);
      setFeedback("");
      setNotice({ kind: "applied" });
      onApplied?.();
    }
  };
  return (
    onRevise && {
      open,
      feedback,
      running,
      notice,
      onOpen: (prefill) => (setOpen(true), setNotice(null), setFeedback((f) => f || prefill || "")),
      onCancel: () => (setOpen(false), setNotice(null)),
      onFeedback: setFeedback,
      onSubmit,
    }
  );
}

export type RevisionOutcome = { status: "skipped" } | { status: "invalid"; error: string } | { status: "ok" } | { status: "failed"; error: string };

// Submit trimmed Director feedback once. Invalid feedback (empty or too long)
// never reaches onRevise and is never truncated; a revision already running is
// skipped; a rejection becomes an error to show, and the caller keeps the
// current review and the pasted feedback.
export async function submitRevision(feedback: string, running: boolean, onRevise: (feedback: string) => Promise<void>): Promise<RevisionOutcome> {
  if (running) return { status: "skipped" };
  const invalid = directorFeedbackError(feedback);
  if (invalid) return { status: "invalid", error: invalid };
  const f = feedback.trim();
  try {
    await onRevise(f);
    return { status: "ok" };
  } catch (e: any) {
    return { status: "failed", error: e?.message || "The revision failed." };
  }
}

// A self-contained Markdown packet of the review text: durable PastBriefly rules
// plus the generated review verbatim - no project state, no analytics, nothing
// rewritten. No longer offered in the product UI; kept as the one rendering of
// the review text that the Text QA server tests check against.
export function buildStoryReviewClipboardText(r: StoryReview): string {
  const spine = r.moments.map((m, i) => `${i + 1}. ${m.title}\n   ${m.detail}`).join("\n\n");
  const facts = r.facts.length
    ? r.facts
        .map((f) => ["- " + f.fact, f.sourceTitle && `  Source: ${f.sourceTitle}`, f.sourceUrl && `  ${f.sourceUrl}`].filter(Boolean).join("\n"))
        .join("\n\n")
    : "No fact sheet was produced for this story.";
  // A Long-first draft has no Short: no Short section and no Short check.
  const hasShort = r.shortScript !== undefined;
  const shortSection = hasShort ? `## SHORT SCRIPT\n\n${r.shortScript}\n\n` : "";
  const checks = [
    "Is the strange premise immediately understandable?",
    "Does the Long tell a causal story rather than merely list facts?",
    "Is the opening strong enough to make the viewer want the next sentence?",
    "Is anything confusing, repetitive, padded, generic, or unnecessary?",
    "Do any factual claims appear weak, ambiguous, overstated, or insufficiently supported by the listed sources?",
    ...(hasShort ? ["Does the Short preserve the strongest version of the premise?"] : []),
    "Does the story have enough depth for the Long without artificial padding?",
    "Give a final decision:",
  ]
    .map((c, i) => `${i + 1}. ${c}`)
    .join("\n");
  return `# PASTBRIEFLY DIRECTOR REVIEW

Stage: TEXT GATE

Review this story only.
Do not generate assets, call providers, or advance production.
Stop at the text gate.

## DIRECTOR RULES

- The story is the product.
- PastBriefly makes true historical stories that sound made up.
- Long-form is the main product.
- Do not pad a weak story merely to hit a runtime.
- Prefer a clear strange premise, causal escalation, and satisfying payoff.
- Distinguish sourced fact from unsupported or unclear claims.
- Recommend APPROVE or REVISE and explain exact changes.
- Do not advance production.

## TITLE

${r.title}

## PREMISE / HOOK

${r.hook || "(none)"}

## STORY SPINE

${spine}

## FACTS & SOURCES

${facts}

## LONG SCRIPT

${r.longScript}

${shortSection}## REVIEW REQUEST

Review this PB4 text gate as editorial / production director.

Check:

${checks}
   - APPROVE
   - REVISE

If REVISE, give exact changes.

Stop at the text gate.
`;
}

// Height = viewport minus the shell's vertical padding (py-12 on desktop; py-8
// plus the sticky top nav on mobile). A small floor lets the page scroll instead
// of crushing the panel on very short windows.
export function StoryReviewView({
  review: r,
  tab,
  onTab,
  onApprove,
  approving,
  revise,
  research,
  onBack,
  backLabel,
}: {
  review: StoryReview;
  tab: ReviewTab;
  onTab: (t: ReviewTab) => void;
  onApprove: () => void;
  approving: boolean;
  revise?: ReviseControls;
  research?: ReviseControls; // Research more: the same feedback form, asking for more evidence
  onBack?: () => void;
  backLabel?: string;
}): React.ReactElement {
  // One text-gate action at a time: a running or open form holds the others.
  const busy = !!revise?.running || !!research?.running;
  return (
    <div className="max-w-3xl h-[calc(100dvh-8rem)] md:h-[calc(100dvh-6rem)] min-h-[22rem] flex flex-col gap-5">
      <header className="flex-none">
        {onBack && (
          <button onClick={onBack} className="inline-flex items-center gap-2 mb-3 text-[13px] text-[#cabfb0] hover:text-accent">
            <span aria-hidden="true">←</span> {backLabel || "Back"}
          </button>
        )}
        <p className="kicker mb-1">The whole story</p>
        <h1 className="text-3xl">{r.title}</h1>
        {r.hook && <p className="text-muted mt-2 text-lg [text-wrap:pretty]">{r.hook}</p>}
      </header>

      <div role="tablist" className="flex-none flex gap-1 overflow-x-auto overflow-y-hidden [scrollbar-width:none] border-b border-line">
        {REVIEW_TABS.filter(([id]) => id !== "short" || r.shortScript !== undefined).map(([id, label]) => (
          <button
            key={id}
            role="tab"
            aria-selected={tab === id}
            onClick={() => onTab(id)}
            className={`flex-none -mb-px px-3.5 pt-2.5 pb-3 text-[14.5px] font-medium whitespace-nowrap transition ${tab === id ? "text-ink shadow-[inset_0_-2px_0_#e50914]" : "text-muted hover:text-ink"}`}
          >
            {label}
          </button>
        ))}
      </div>

      <div role="tabpanel" className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden pr-2">
        <TabContent review={r} tab={tab} />
      </div>

      {revise && <ReviseBox revise={revise} />}
      {research && <ReviseBox revise={research} labels={RESEARCH_LABELS} />}

      {revise?.notice?.kind === "applied" && !revise.open && (
        <div role="status" className="flex-none flex flex-col gap-0.5 rounded-lg border border-[#a9c3a4]/60 bg-[#a9c3a4]/10 px-4 py-3 text-[14px] text-ink">
          <strong className="font-semibold">Revision applied</strong>
          <span>Read the updated story, then continue production.</span>
        </div>
      )}
      {research?.notice?.kind === "applied" && !research.open && (
        <div role="status" className="flex-none flex flex-col gap-0.5 rounded-lg border border-[#a9c3a4]/60 bg-[#a9c3a4]/10 px-4 py-3 text-[14px] text-ink">
          <strong className="font-semibold">Research refreshed</strong>
          <span>Read the new research and story, then continue production.</span>
        </div>
      )}

      <footer className="flex-none flex flex-wrap items-center justify-end gap-x-6 gap-y-3 pt-4 border-t border-line">
        <div className="flex-none flex flex-wrap items-center gap-3">
          {revise && (
            <button onClick={() => revise.onOpen()} disabled={revise.open || !!research?.open || busy || approving} aria-expanded={revise.open} className="btn btn-ghost">
              Revise story
            </button>
          )}
          {research && (
            <button onClick={() => research.onOpen()} disabled={research.open || !!revise?.open || busy || approving} aria-expanded={research.open} className="btn btn-ghost">
              Research more
            </button>
          )}
          <button onClick={onApprove} disabled={approving || busy} className="btn btn-primary">
            {approving ? "Continuing…" : "Continue production"}
          </button>
        </div>
      </footer>
    </div>
  );
}

// One Story Review tab's content.
function TabContent({ review: r, tab }: { review: StoryReview; tab: ReviewTab }): React.ReactElement {
  if (tab === "facts") {
    return (
      <ul className="flex flex-col">
        {r.facts.map((f, i) => (
          <li key={i} className="text-[15px] leading-relaxed py-3 border-b border-line">
            {f.fact}{" "}
            {f.sourceUrl ? (
              <a href={f.sourceUrl} target="_blank" rel="noreferrer" className="text-accent underline">
                {f.sourceTitle || "source"}
              </a>
            ) : (
              <span className="text-muted">({f.sourceTitle})</span>
            )}
          </li>
        ))}
        {r.facts.length === 0 && <li className="text-sm text-muted">No fact sheet was produced for this story.</li>}
      </ul>
    );
  }
  if (tab === "long" || tab === "short") return <p className="whitespace-pre-wrap text-[15px] leading-[1.75] max-w-[68ch]">{tab === "long" ? r.longScript : r.shortScript}</p>;
  return (
    <ol className="list-decimal pl-5 flex flex-col gap-3.5">
      {r.moments.map((m, i) => (
        <li key={i} className="text-[15px] leading-relaxed pl-1">
          <span className="font-semibold">{m.title}</span>
          <span className="text-muted"> - {m.detail}</span>
        </li>
      ))}
    </ol>
  );
}

// The words of one feedback form: a revision of the draft, or Research more.
interface FeedbackLabels {
  id: string;
  section: string;
  placeholder: string;
  failed: string;
  unchanged: string;
  running: string;
  submit: string;
}
const REVISE_LABELS: FeedbackLabels = {
  id: "director-feedback",
  section: "Director revision",
  placeholder: "Paste the REVISE feedback from the Director...",
  failed: "Revision failed",
  unchanged: "The current draft was not changed.",
  running: "Revising…",
  submit: "Revise story",
};
const RESEARCH_LABELS: FeedbackLabels = {
  id: "director-research-feedback",
  section: "Research more",
  placeholder: "Say what evidence is missing: the events, people, dates or sources to research further...",
  failed: "Research failed",
  unchanged: "The current research and draft were not changed.",
  running: "Researching…",
  submit: "Research more",
};

// The open Director feedback form: feedback, what went wrong, Cancel and submit.
function ReviseBox({ revise, labels = REVISE_LABELS }: { revise: ReviseControls; labels?: FeedbackLabels }): React.ReactElement | null {
  if (!revise.open) return null;
  return (
    <section aria-label={labels.section} className="flex-none flex flex-col gap-2.5 pt-4 border-t border-line">
      <label htmlFor={labels.id} className="kicker">Director feedback</label>
      <textarea
        id={labels.id}
        value={revise.feedback}
        onChange={(e) => revise.onFeedback(e.target.value)}
        disabled={revise.running}
        rows={5}
        placeholder={labels.placeholder}
        className="w-full max-h-[30vh] resize-y rounded-xl bg-field border border-line px-4 py-3 text-ink text-[14.5px] leading-relaxed placeholder:text-dim outline-none transition focus:border-accent/55"
      />
      {revise.notice?.kind === "invalid" && (
        <p role="alert" className="text-[14px] font-medium text-ink">
          {revise.notice.message}
        </p>
      )}
      {revise.notice?.kind === "failed" && (
        <div role="alert" className="flex flex-col gap-1 rounded-lg border border-accent bg-accent/15 px-4 py-3 text-[14px] text-ink">
          <strong className="font-semibold">{labels.failed}</strong>
          <span>{labels.unchanged}</span>
          <span className="text-[13px] break-words">{revise.notice.message}</span>
        </div>
      )}
      <div className="flex flex-wrap items-center justify-end gap-3">
        <button onClick={revise.onCancel} disabled={revise.running} className="btn btn-ghost">
          Cancel
        </button>
        <button onClick={revise.onSubmit} disabled={revise.running} className="btn btn-ghost">
          {revise.running ? labels.running : labels.submit}
        </button>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------- Text issue

// The part of the story a Text QA section is about: the hook, the story spine,
// the facts, or one script.
export function IssueText({ review: r, section }: { review: StoryReview; section: TextQaSection }): React.ReactElement {
  if (section === "hook" || section === "story") {
    return (
      <div className="flex flex-col gap-4">
        <div>
          <p className="font-serif text-[22px] leading-tight text-ink">{r.title}</p>
          {r.hook && <p className="mt-1.5 text-[15.5px] text-muted [text-wrap:pretty]">{r.hook}</p>}
        </div>
        {section === "story" && <TabContent review={r} tab="story" />}
      </div>
    );
  }
  return <TabContent review={r} tab={SECTION_TAB[section]} />;
}

type TextIssueProps = {
  review: StoryReview;
  issue: TextQaIssue;
  index: number;
  total: number;
  onBack: () => void;
  onNext?: () => void;
  onApprove: () => void;
  approving: boolean;
  more: React.ReactNode;
};

export function TextIssuePanel({ onRevise, ...props }: TextIssueProps & { onRevise: (feedback: string) => Promise<void> }): React.ReactElement {
  const revise = useRevise(onRevise);
  return <TextIssueView {...props} revise={revise} />;
}

// One text issue on its own: what is wrong, the text it is about, and the one
// fix (Revise story). After a revision, continuing is the decision.
export function TextIssueView({ review, issue, index, total, onBack, onNext, onApprove, approving, more, revise }: TextIssueProps & { revise?: ReviseControls }): React.ReactElement {
  const label = SECTION_LABEL[issue.section];
  const applied = revise?.notice?.kind === "applied" && !revise.open;
  return (
    <div className="flex flex-col gap-6 max-w-3xl" data-text-issue-view={issue.section}>
      <button onClick={onBack} className="self-start inline-flex items-center gap-2 text-[13px] text-[#cabfb0] hover:text-accent">
        <span aria-hidden="true">←</span> Back to issues
      </button>
      <div className="flex flex-col gap-2">
        <p className="text-[11px] font-semibold tracking-[0.18em] uppercase text-accent">
          Text issue · Issue {index + 1} of {total}
        </p>
        <h1 className="font-serif text-[30px] md:text-[36px] leading-[1.1] text-ink">{label}</h1>
        <p className="text-[16px] leading-[1.55] text-[#c8bcad] [text-wrap:pretty] break-words">{issue.reason}</p>
      </div>
      <section aria-label={label} data-issue-content className="max-h-[48vh] overflow-y-auto rounded-xl border border-line bg-panel px-5 py-4">
        <IssueText review={review} section={issue.section} />
      </section>
      {revise && <ReviseBox revise={revise} />}
      {applied && (
        <div role="status" className="flex flex-wrap items-center gap-x-5 gap-y-2 rounded-lg border border-[#a9c3a4]/60 bg-[#a9c3a4]/10 px-4 py-3 text-[14px] text-ink">
          <span className="flex-1 min-w-[220px]">
            <strong className="font-semibold">Revision applied.</strong> Read it above. When it is right, continue production.
          </span>
          <button onClick={onApprove} disabled={approving} className="btn btn-primary">
            {approving ? "Continuing…" : "Continue production"}
          </button>
        </div>
      )}
      <div className="flex flex-wrap items-center gap-x-5 gap-y-3 pt-4 border-t border-line">
        {revise && !revise.open && (
          <button onClick={() => revise.onOpen(`Revise the ${label.toLowerCase()}: ${issue.reason}`)} disabled={approving} className={applied ? "btn btn-ghost" : "btn btn-primary"}>
            Revise story
          </button>
        )}
        {onNext && (
          <button onClick={onNext} className="text-[14px] text-ink underline underline-offset-[3px] decoration-[rgba(245,235,222,0.3)] hover:text-accent">
            Next issue →
          </button>
        )}
        {more}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- Failed

function Fail({ slug, message, job, onRetry, retrying, maxSpend, onApproveMore }: { slug: string; message?: string; job?: Job; onRetry?: () => void; retrying?: boolean; maxSpend?: number; onApproveMore?: (newApprovedMax: number) => Promise<void> }): React.ReactElement {
  return (
    <div className="flex flex-col gap-4 max-w-lg">
      <h1 className="text-2xl">Production stopped</h1>
      {job ? <FailedJobDetails job={job} /> : <p className="text-muted">{message}</p>}
      {job && onApproveMore && maxSpend !== undefined && maxSpend > 0 && isBudgetFailure(job) && (
        <ApproveMoreResume job={job} maxSpendUsd={maxSpend} onApprove={onApproveMore} />
      )}
      <div className="flex items-center gap-3">
        {onRetry && (
          <button onClick={onRetry} disabled={retrying} className="btn btn-primary w-fit">
            {retrying ? "Retrying…" : "Retry"}
          </button>
        )}
        <button onClick={() => navigate(`/story/${slug}`)} className="btn btn-ghost w-fit">← Back to story</button>
      </div>
    </div>
  );
}
