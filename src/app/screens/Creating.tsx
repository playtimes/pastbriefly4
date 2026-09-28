import React, { useEffect, useRef, useState } from "react";
import { api } from "../api.ts";
import { navigate } from "../App.tsx";
import { FailedJobDetails, ApproveMoreResume, isBudgetFailure } from "../failedJob.tsx";
import { VisualReview } from "../visualReview/VisualReview.tsx";
import { regenKey } from "../visualReview/model.ts";
import type { RegenDraft } from "../visualReview/Inspector.tsx";
import { STEP_ORDER, STEP_LABELS, directorFeedbackError, type AssetQaPhase, type AssetQaState, type Job, type JobStep, type PreviewFrame, type SequenceRevisionReport, type StoryReview, type TextQaPhase, type TextQaSection, type TextQaState } from "../../types.ts";

export function Creating({ slug }: { slug: string }): React.ReactElement {
  const [job, setJob] = useState<Job | null>(null);
  const [error, setError] = useState("");
  const [continuing, setContinuing] = useState(false);
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
  const jobId = useRef<string | null>(null);

  useEffect(() => {
    api.config().then((c) => setMaxSpend(c.maxSpendUsd)).catch(() => {});
  }, []);

  useEffect(() => {
    let stop = false;
    async function tick(): Promise<void> {
      try {
        if (!jobId.current) {
          const detail = await api.story(slug);
          setStoryTitle(detail.story.title);
          if (detail.activeJob) jobId.current = detail.activeJob.id;
          else if (detail.videos.length >= 2) return navigate(`/story/${slug}/watch`);
          else return navigate(`/story/${slug}`);
        }
        const { job } = await api.job(jobId.current!);
        if (stop) return;
        setJob(job);
        if (job.state === "done") return navigate(`/story/${slug}/watch`);
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

  // Approve the story text and resume; the job goes back to queued and the poll
  // loop above takes over the progress UI through to the visual preview gate.
  async function approveText(): Promise<void> {
    if (!jobId.current) return;
    setApprovingText(true);
    try {
      const { job } = await api.approveText(jobId.current);
      setJob(job);
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
    setJob(job);
  }

  // Revise one film's edit from Director feedback at the visual preview. The job
  // stays at the preview; errors are thrown to the Director board, which keeps
  // the current board and the pasted feedback.
  async function reviseSequence(kind: "long" | "short", feedback: string): Promise<SequenceRevisionReport> {
    if (!jobId.current) throw new Error("The job is not loaded yet.");
    setRevisingSequence(true);
    try {
      const { job, revision } = await api.reviseSequence(jobId.current, kind, feedback);
      setJob(job);
      return revision;
    } finally {
      setRevisingSequence(false);
    }
  }

  // Start Run Director QA for one film. The whole chain runs on the server; the
  // poll above then shows its phase and result from the job, so leaving the page
  // changes nothing. Continue, Rebuild and Regenerate wait while it runs.
  async function directorQa(kind: "long" | "short"): Promise<void> {
    if (!jobId.current) throw new Error("The job is not loaded yet.");
    const { job } = await api.runDirectorQa(jobId.current, kind);
    setJob(job);
  }

  // Reject the previewed visuals and rebuild them under the same job. The job goes
  // back to queued, so the polling loop above takes over the progress UI.
  async function rebuild(): Promise<void> {
    if (!jobId.current) return;
    setRebuilding(true);
    try {
      const { job } = await api.rebuildVisuals(jobId.current);
      setJob(job);
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
      setJob(job);
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
      setJob(job);
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
    setJob(job);
  }

  if (error) return <Fail slug={slug} message={error} />;
  if (job?.state === "failed")
    return <Fail slug={slug} job={job} onRetry={retry} retrying={retrying} maxSpend={maxSpend} onApproveMore={approveMore} />;
  if (!job) return <p className="text-muted">Preparing…</p>;

  // While Automatic Text QA runs the draft is not up for review yet: keep the
  // progress screen. When it stops, the Story Review opens with its reason.
  if (job.state === "awaiting_text" && job.textQa?.status === "running") return <CreatingProgress job={job} />;
  if (job.state === "awaiting_text" && job.review) {
    const qa = job.textQa?.status === "stopped" ? job.textQa : undefined;
    return <StoryReviewPanel review={job.review} onApprove={approveText} approving={approvingText} onRevise={reviseText} qa={qa} />;
  }

  // While Pixel Asset QA inspects (and may repair) the stills, the visuals are not
  // up for review yet: keep the progress screen, as for Text QA.
  if (job.state === "awaiting_preview" && job.assetQa?.status === "running") return <CreatingProgress job={job} />;
  // The same while the Visual Autopilot reviews the Long and Short sequences.
  if (job.state === "awaiting_preview" && job.visualAutopilot?.status === "running") return <CreatingProgress job={job} />;
  if (job.state === "awaiting_preview" && job.preview) {
    // A manual revision in flight, or a server-side Director QA run for either film.
    const sequenceBusy = revisingSequence || job.directorQa?.long?.status === "running" || job.directorQa?.short?.status === "running";
    return (
      <VisualReview
        preview={job.preview}
        storyTitle={storyTitle}
        version={imageVersion}
        onBack={() => navigate(`/story/${slug}`)}
        onContinue={cont}
        onRebuild={rebuild}
        continuing={continuing}
        rebuilding={rebuilding}
        onRegenerate={regenerate}
        regen={{ running: regenerating, failed: regenFailed, done: regenDone, blocked: sequenceBusy }}
        draft={regenDraft}
        onDraft={setRegenDraft}
        onReviseSequence={reviseSequence}
        onDirectorQa={directorQa}
        revisingSequence={sequenceBusy}
        directorQa={job.directorQa}
        visualAutopilot={job.visualAutopilot}
        assetQa={job.assetQa?.status === "done" ? job.assetQa : undefined}
      />
    );
  }

  return <CreatingProgress job={job} />;
}

// The Automatic Text QA phases, in the order they can run.
const TEXT_QA_PHASES: [TextQaPhase, string][] = [
  ["review", "Director reviewing"],
  ["repair", "Applying text repair"],
  ["verify", "Final text verification"],
];

// The Visual Autopilot after a clean Asset QA, in order.
const VISUAL_AUTOPILOT_PHASES: [string, string][] = [
  ["assets", "Inspecting visual assets"],
  ["long", "Reviewing Long sequence"],
  ["short", "Reviewing Short sequence"],
];

// The Pixel Asset QA phases, in the order they can run.
function assetQaPhases(qa: Extract<AssetQaState, { status: "running" }>): [AssetQaPhase, string][] {
  return [
    ["review", "Inspecting visual assets"],
    ["repair", qa.phase === "repair" && qa.current ? `Repairing visual asset ${qa.current} of ${qa.total}` : "Repairing visual assets"],
    ["verify", "Verifying repaired visuals"],
  ];
}

// The progress screen. While Text QA runs (the job waits at the text gate) the
// written films are done and its phases so far show under them; once it passes,
// one line says so while the job continues to the visuals. Pixel Asset QA shows
// its phases the same way under the finished stills, at the visual preview.
export function CreatingProgress({ job }: { job: Job }): React.ReactElement {
  const qa = job.textQa;
  const atGate = job.state === "awaiting_preview";
  const assetQa = atGate && job.assetQa?.status === "running" ? job.assetQa : null;
  // The Visual Autopilot after Asset QA: Director QA for Long, then for Short.
  const pilot = atGate && job.visualAutopilot?.status === "running" && !assetQa;
  const film = job.directorQa?.short?.status === "running" || (job.directorQa?.long && job.directorQa.long.status !== "running") ? "short" : "long";
  const phases: [string, string][] = assetQa ? assetQaPhases(assetQa) : pilot ? VISUAL_AUTOPILOT_PHASES : TEXT_QA_PHASES;
  const running = assetQa ? assetQa.phase : pilot ? film : job.state === "awaiting_text" && qa?.status === "running" ? qa.phase : null;
  const under: JobStep = assetQa || pilot ? "stills" : "scripts";
  const reached = running ? phases.slice(0, phases.findIndex(([p]) => p === running) + 1) : [];
  const currentIndex = running ? STEP_ORDER.indexOf(under) + 1 : STEP_ORDER.indexOf(job.step as any);
  const auditing = job.step === "scripts" && !!job.progress && job.progress.current === job.progress.total;
  const heading = running ? phases.find(([p]) => p === running)![1] : auditing ? "Auditing scripts" : STEP_LABELS[job.step];
  return (
    <div className="flex flex-col gap-8 max-w-xl">
      <div>
        <p className="kicker mb-1">Creating your films</p>
        <h1 className="text-3xl">{heading}…</h1>
        {qa?.status === "passed" && job.state !== "awaiting_text" && <p className="mt-2 text-ink">Text QA passed. Continuing to visuals…</p>}
        {job.visualAutopilot?.status === "passed" && !atGate && <p className="mt-2 text-ink">Visual QA passed. Continuing production…</p>}
        <p className="text-muted mt-2">You can leave this page and come back - it keeps working.</p>
      </div>
      <ol className="flex flex-col gap-3">
        {STEP_ORDER.map((step, i) => {
          const done = currentIndex > i || job.state === "done";
          const active = currentIndex === i && !running;
          const prog = active ? job.progress : undefined;
          const pct = prog ? Math.round((prog.current / prog.total) * 100) : 0;
          return (
            <li key={step} className="flex flex-col gap-1.5">
              <div className="flex items-center gap-3">
                <span className={`w-5 h-5 rounded-full flex items-center justify-center text-[0.6rem] ${done ? "bg-accent text-[#f7f4ee]" : active ? "border-2 border-accent" : "border border-line"}`}>
                  {done ? "✓" : ""}
                </span>
                <span className={active ? "text-ink" : done ? "text-muted" : "text-muted/60"}>{STEP_LABELS[step]}</span>
                {active && !prog && <Spinner />}
                {prog && (
                  <span className="ml-auto text-[13px] tabular-nums text-muted">
                    {prog.percent ? `${pct}%` : `${prog.current} / ${prog.total} · ${pct}%`}
                  </span>
                )}
              </div>
              {prog && (
                <div className="ml-8 h-1.5 overflow-hidden rounded-full bg-line">
                  <div className="h-full rounded-full bg-accent transition-[width] duration-500" style={{ width: `${pct}%` }} />
                </div>
              )}
              {step === under && reached.length > 0 && (
                <ol aria-label={assetQa ? "Asset QA" : pilot ? "Visual QA" : "Text QA"} className="ml-8 flex flex-col gap-2">
                  {reached.map(([p, label]) => {
                    const now = p === running;
                    return (
                      <li key={p} className="flex items-center gap-3 text-[14px]">
                        <span className={`w-3.5 h-3.5 rounded-full flex items-center justify-center text-[0.5rem] ${now ? "border-2 border-accent" : "bg-accent text-[#f7f4ee]"}`}>{now ? "" : "✓"}</span>
                        <span className={now ? "text-ink" : "text-muted"}>{label}</span>
                        {now && <Spinner />}
                      </li>
                    );
                  })}
                </ol>
              )}
            </li>
          );
        })}
      </ol>
    </div>
  );
}

type TextQaStop = Extract<TextQaState, { status: "stopped" }>;
const SECTION_LABELS: Record<TextQaSection, string> = { story: "Story", hook: "Hook", spine: "Story spine", facts: "Facts & Sources", long: "Long script", short: "Short script" };

// Why Automatic Text QA stopped at this Story Review. The manual tools below stay
// exactly as they are: this only says what needs a human.
export function TextQaNotice({ qa }: { qa: TextQaStop }): React.ReactElement {
  return (
    <section role="alert" aria-label="Text QA" className="flex-none max-h-[30vh] overflow-y-auto flex flex-col gap-1.5 rounded-lg border border-accent bg-accent/15 px-4 py-3 text-[14px] text-ink">
      <strong className="kicker text-ink">Text QA needs you</strong>
      <span className="font-medium">{qa.message}</span>
      {qa.summary && <span className="[text-wrap:pretty]">{qa.summary}</span>}
      {qa.issues.length > 0 && (
        <>
          <span className="font-medium mt-1">Issues:</span>
          <ul className="list-disc pl-5 flex flex-col gap-1">
            {qa.issues.map((i, n) => (
              <li key={n}>
                <span className="text-muted">{SECTION_LABELS[i.section]}:</span> {i.reason}
              </li>
            ))}
          </ul>
        </>
      )}
      {qa.feedback && (
        <details className="mt-1">
          <summary className="cursor-pointer text-muted">Requested text repair</summary>
          <p className="whitespace-pre-wrap mt-1">{qa.feedback}</p>
        </details>
      )}
      {qa.error && <span className="text-[13px] break-words text-muted">{qa.error}</span>}
    </section>
  );
}

export type ReviewTab = "story" | "facts" | "long" | "short";
const REVIEW_TABS: [ReviewTab, string][] = [
  ["story", "Story"],
  ["facts", "Facts & Sources"],
  ["long", "Long script"],
  ["short", "Short script"],
];

// The text-review gate as one viewport-sized workspace: header and tabs on top,
// only the active tab scrolls, and the approval footer never scrolls away.
// The tab is local UI state only - never persisted, routed or sent anywhere.
export function StoryReviewPanel(props: { review: StoryReview; onApprove: () => void; approving: boolean; onRevise?: (feedback: string) => Promise<void>; qa?: TextQaStop }): React.ReactElement {
  const { onRevise, ...rest } = props;
  const [tab, setTab] = useState<ReviewTab>("story");
  const [copy, setCopy] = useState<CopyState>("idle");
  const [reviseOpen, setReviseOpen] = useState(false);
  const [feedback, setFeedback] = useState("");
  const [revising, setRevising] = useState(false);
  const [notice, setNotice] = useState<ReviseNotice | null>(null);
  useEffect(() => {
    if (copy === "idle") return;
    const t = setTimeout(() => setCopy("idle"), 2000);
    return () => clearTimeout(t);
  }, [copy]);
  const onCopy = () => copyDirectorReview(props.review).then((ok) => setCopy(ok ? "copied" : "failed"));
  const onSubmit = async () => {
    if (!onRevise || revising) return;
    setNotice(null);
    setRevising(true);
    const out = await submitRevision(feedback, false, onRevise);
    setRevising(false);
    if (out.status === "invalid") setNotice({ kind: "invalid", message: out.error });
    if (out.status === "failed") setNotice({ kind: "failed", message: out.error });
    if (out.status === "ok") (setReviseOpen(false), setFeedback(""), setTab("story"), setNotice({ kind: "applied" }));
  };
  const revise: ReviseControls | undefined = onRevise && {
    open: reviseOpen,
    feedback,
    running: revising,
    notice,
    onOpen: () => (setReviseOpen(true), setNotice(null)),
    onCancel: () => (setReviseOpen(false), setNotice(null)),
    onFeedback: setFeedback,
    onSubmit,
  };
  return <StoryReviewView {...rest} tab={tab} onTab={setTab} copy={copy} onCopy={onCopy} revise={revise} />;
}

export type CopyState = "idle" | "copied" | "failed";

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
  onOpen: () => void;
  onCancel: () => void;
  onFeedback: (v: string) => void;
  onSubmit: () => void;
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

// Copy the director packet for the review on screen. Resolves false (never
// throws) when the clipboard is unavailable or refuses, so the UI can say so.
export async function copyDirectorReview(r: StoryReview, clipboard: Pick<Clipboard, "writeText"> | undefined = globalThis.navigator?.clipboard): Promise<boolean> {
  try {
    if (!clipboard) return false;
    await clipboard.writeText(buildStoryReviewClipboardText(r));
    return true;
  } catch {
    return false;
  }
}

// A self-contained Markdown packet for an outside editorial review of the text
// gate. Durable PastBriefly rules plus the generated review verbatim - no
// project state, no analytics, nothing rewritten.
export function buildStoryReviewClipboardText(r: StoryReview): string {
  const spine = r.moments.map((m, i) => `${i + 1}. ${m.title}\n   ${m.detail}`).join("\n\n");
  const facts = r.facts.length
    ? r.facts
        .map((f) => ["- " + f.fact, f.sourceTitle && `  Source: ${f.sourceTitle}`, f.sourceUrl && `  ${f.sourceUrl}`].filter(Boolean).join("\n"))
        .join("\n\n")
    : "No fact sheet was produced for this story.";
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

## SHORT SCRIPT

${r.shortScript}

## REVIEW REQUEST

Review this PB4 text gate as editorial / production director.

Check:

1. Is the strange premise immediately understandable?
2. Does the Long tell a causal story rather than merely list facts?
3. Is the opening strong enough to make the viewer want the next sentence?
4. Is anything confusing, repetitive, padded, generic, or unnecessary?
5. Do any factual claims appear weak, ambiguous, overstated, or insufficiently supported by the listed sources?
6. Does the Short preserve the strongest version of the premise?
7. Does the story have enough depth for the Long without artificial padding?
8. Give a final decision:
   - APPROVE
   - REVISE

If REVISE, give exact changes.

Stop at the text gate.
`;
}

// Height = viewport minus the shell's vertical padding (py-12 on desktop; py-8
// plus the sticky top nav on mobile). A small floor lets the page scroll instead
// of crushing the panel on very short windows.
export function StoryReviewView({ review: r, tab, onTab, onApprove, approving, copy = "idle", onCopy, revise, qa }: { review: StoryReview; tab: ReviewTab; onTab: (t: ReviewTab) => void; onApprove: () => void; approving: boolean; copy?: CopyState; onCopy?: () => void; revise?: ReviseControls; qa?: TextQaStop }): React.ReactElement {
  return (
    <div className="max-w-3xl h-[calc(100dvh-8rem)] md:h-[calc(100dvh-6rem)] min-h-[22rem] flex flex-col gap-5">
      <header className="flex-none">
        <p className="kicker mb-1">Story review</p>
        <h1 className="text-3xl">{r.title}</h1>
        {r.hook && <p className="text-muted mt-2 text-lg [text-wrap:pretty]">{r.hook}</p>}
      </header>

      {qa && <TextQaNotice qa={qa} />}

      <div role="tablist" className="flex-none flex gap-1 overflow-x-auto overflow-y-hidden [scrollbar-width:none] border-b border-line">
        {REVIEW_TABS.map(([id, label]) => (
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
        {tab === "story" && (
          <ol className="list-decimal pl-5 flex flex-col gap-3.5">
            {r.moments.map((m, i) => (
              <li key={i} className="text-[15px] leading-relaxed pl-1">
                <span className="font-semibold">{m.title}</span>
                <span className="text-muted"> - {m.detail}</span>
              </li>
            ))}
          </ol>
        )}
        {tab === "facts" && (
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
        )}
        {tab === "long" && <p className="whitespace-pre-wrap text-[15px] leading-[1.75] max-w-[68ch]">{r.longScript}</p>}
        {tab === "short" && <p className="whitespace-pre-wrap text-[15px] leading-[1.75] max-w-[68ch]">{r.shortScript}</p>}
      </div>

      {revise?.open && (
        <section aria-label="Director revision" className="flex-none flex flex-col gap-2.5 pt-4 border-t border-line">
          <label htmlFor="director-feedback" className="kicker">Director feedback</label>
          <textarea
            id="director-feedback"
            value={revise.feedback}
            onChange={(e) => revise.onFeedback(e.target.value)}
            disabled={revise.running}
            rows={5}
            placeholder="Paste the REVISE feedback from the Director..."
            className="w-full max-h-[30vh] resize-y rounded-xl bg-field border border-line px-4 py-3 text-ink text-[14.5px] leading-relaxed placeholder:text-dim outline-none transition focus:border-accent/55"
          />
          {revise.notice?.kind === "invalid" && (
            <p role="alert" className="text-[14px] font-medium text-ink">
              {revise.notice.message}
            </p>
          )}
          {revise.notice?.kind === "failed" && (
            <div role="alert" className="flex flex-col gap-1 rounded-lg border border-accent bg-accent/15 px-4 py-3 text-[14px] text-ink">
              <strong className="font-semibold">Revision failed</strong>
              <span>The current draft was not changed.</span>
              <span className="text-[13px] break-words">{revise.notice.message}</span>
            </div>
          )}
          <div className="flex flex-wrap items-center justify-end gap-3">
            <button onClick={revise.onCancel} disabled={revise.running} className="btn btn-ghost">
              Cancel
            </button>
            <button onClick={revise.onSubmit} disabled={revise.running} className="btn btn-ghost">
              {revise.running ? "Revising…" : "Revise story"}
            </button>
          </div>
        </section>
      )}

      {revise?.notice?.kind === "applied" && !revise.open && (
        <div role="status" className="flex-none flex flex-col gap-0.5 rounded-lg border border-[#a9c3a4]/60 bg-[#a9c3a4]/10 px-4 py-3 text-[14px] text-ink">
          <strong className="font-semibold">Revision applied</strong>
          <span>Review the updated draft before approving.</span>
        </div>
      )}

      <footer className="flex-none flex flex-wrap items-center justify-between gap-x-6 gap-y-3 pt-4 border-t border-line">
        <p className="flex-[1_1_320px] text-muted text-sm [text-wrap:pretty]">
          PB4 has completed its research and factual checks. Review whether the story is clear and interesting before media is generated.
        </p>
        <div className="flex-none flex flex-wrap items-center gap-3">
          <button onClick={onCopy} className="btn btn-ghost" aria-live="polite">
            {copy === "copied" ? "Copied" : copy === "failed" ? "Copy failed" : "Copy Director Review"}
          </button>
          {revise && (
            <button onClick={revise.onOpen} disabled={revise.open || approving} aria-expanded={revise.open} className="btn btn-ghost">
              Revise story
            </button>
          )}
          <button onClick={onApprove} disabled={approving || revise?.running} className="btn btn-primary">
            {approving ? "Continuing…" : "Approve & continue"}
          </button>
        </div>
      </footer>
    </div>
  );
}

function Spinner(): React.ReactElement {
  return <span className="w-3.5 h-3.5 border-2 border-accent border-t-transparent rounded-full animate-spin" />;
}

function Fail({ slug, message, job, onRetry, retrying, maxSpend, onApproveMore }: { slug: string; message?: string; job?: Job; onRetry?: () => void; retrying?: boolean; maxSpend?: number; onApproveMore?: (newApprovedMax: number) => Promise<void> }): React.ReactElement {
  return (
    <div className="flex flex-col gap-4 max-w-lg">
      <h1 className="text-2xl">Something went wrong</h1>
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
