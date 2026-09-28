import React, { useEffect, useRef, useState } from "react";
import { mediaUrl } from "../api.ts";
import { sequenceFeedbackError, type DirectorQaPhase, type DirectorQaRun, type PreviewFrame, type SequenceRevisionReport } from "../../types.ts";
import { fmtTime, pad2, type Film, type FilmReview, type ReviewAction } from "./model.ts";
import { Still } from "./Still.tsx";
import { boardFileName, buildDirectorBoard, cardTime, cardUse, FLAG_LEGEND, NO_CAPTION, startBoardCopy, TRUTH_UPPER, type BoardCopy, type DirectorBoard as Board } from "./board.ts";

// DIRECTOR mode: a read-only contact sheet of every slot in the current film, in
// edit order, with the attention flags. A card opens its slot in Sequence.

export type BoardFilter = "all" | "flagged";

type ReviseSequence = (kind: Film, feedback: string) => Promise<SequenceRevisionReport>;

// The outcome of the last sequence revision in this board session. Local only.
export type SequenceNotice = { kind: "invalid"; message: string } | { kind: "failed"; message: string } | { kind: "applied"; report: SequenceRevisionReport };

// The inline Revise sequence form, as the view sees it.
export interface SequenceReviseControls {
  open: boolean;
  feedback: string;
  running: boolean;
  notice: SequenceNotice | null;
  onOpen: () => void;
  onCancel: () => void;
  onFeedback: (v: string) => void;
  onSubmit: () => void;
}

export type SequenceOutcome = { status: "skipped" } | { status: "invalid"; error: string } | { status: "ok"; report: SequenceRevisionReport } | { status: "failed"; error: string };

// Submit trimmed feedback for ONE film, once. Invalid feedback never reaches the
// server and is never truncated; a revision already running is skipped; a
// rejection becomes an error to show, and the caller keeps the pasted feedback.
export async function submitSequenceRevision(kind: Film, feedback: string, running: boolean, revise: ReviseSequence): Promise<SequenceOutcome> {
  if (running) return { status: "skipped" };
  const invalid = sequenceFeedbackError(feedback);
  if (invalid) return { status: "invalid", error: invalid };
  try {
    return { status: "ok", report: await revise(kind, feedback.trim()) };
  } catch (e: any) {
    return { status: "failed", error: e?.message || "The sequence revision failed." };
  }
}

// The Run Director QA action, as the view sees it. The chain itself runs on the
// server; `run` is this film's persisted state (its phase, then its result).
// `startError` is a refused start, which changed nothing.
export interface QaControls {
  run: DirectorQaRun | null;
  startError?: string | null;
  onRun: () => void;
  onSlot: (slotId: number) => void; // open that slot in Sequence
}

// Starts Run Director QA for one film on the server (throws if it is refused).
export type RunDirectorQa = (kind: Film) => Promise<void>;

const qaPhaseOf = (run: DirectorQaRun | null | undefined): DirectorQaPhase | null => (run?.status === "running" ? run.phase : null);

export function DirectorBoard({ fr, storyTitle, version, dispatch, onReviseSequence, onDirectorQa, directorQa }: { fr: FilmReview; storyTitle: string; version: number; dispatch: (a: ReviewAction) => void; onReviseSequence?: ReviseSequence; onDirectorQa?: RunDirectorQa; directorQa?: DirectorQaRun }): React.ReactElement {
  const [filter, setFilter] = useState<BoardFilter>("all");
  const [copy, setCopy] = useState<BoardCopy>({ kind: "idle" });
  const [open, setOpen] = useState(false);
  const [feedback, setFeedback] = useState("");
  const [running, setRunning] = useState(false);
  const [notice, setNotice] = useState<SequenceNotice | null>(null);
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  const board = buildDirectorBoard(fr);
  const qaPhase = qaPhaseOf(directorQa);
  const qaBusy = starting || qaPhase !== null;
  const indexesOf = (slots: number[]) => slots.map((id) => fr.frames.findIndex((f) => f.slot === id)).filter((i) => i >= 0);
  // When a run this board watched finishes, the slots it changed need looking at again.
  const seen = useRef(directorQa?.status);
  useEffect(() => {
    const before = seen.current;
    seen.current = directorQa?.status;
    if (before !== "running" || directorQa?.status !== "complete" || !directorQa.changed.length) return;
    setFilter("all");
    setCopy({ kind: "idle" });
    dispatch({ type: "unvisit", film: fr.film, indexes: indexesOf(directorQa.changed) });
  }, [directorQa]);
  const onRunQa = async () => {
    if (!onDirectorQa || qaBusy || running) return;
    setNotice(null);
    setStartError(null);
    setStarting(true);
    try {
      await onDirectorQa(fr.film);
    } catch (e: any) {
      setStartError(e?.message || "Could not start Director QA.");
    } finally {
      setStarting(false);
    }
  };
  const qa: QaControls | undefined = onDirectorQa && {
    run: directorQa ?? null,
    startError,
    onRun: onRunQa,
    onSlot: (slotId) => {
      const [index] = indexesOf([slotId]);
      if (index !== undefined) dispatch({ type: "slot", index });
    },
  };
  const onSubmit = async () => {
    if (!onReviseSequence || running || qaBusy) return;
    setNotice(null);
    setRunning(true);
    const out = await submitSequenceRevision(fr.film, feedback, false, onReviseSequence);
    setRunning(false);
    if (out.status === "invalid" || out.status === "failed") setNotice({ kind: out.status, message: out.error });
    if (out.status === "ok") {
      setOpen(false);
      setFeedback("");
      setFilter("all");
      setCopy({ kind: "idle" });
      setNotice({ kind: "applied", report: out.report });
      // Changed slots need looking at again; every other slot keeps its reviewed state.
      dispatch({ type: "unvisit", film: fr.film, indexes: indexesOf(out.report.changed) });
    }
  };
  const revise: SequenceReviseControls | undefined = onReviseSequence && {
    open,
    feedback,
    running: running || qaBusy,
    notice,
    onOpen: () => (setOpen(true), setNotice(null)),
    onCancel: () => (setOpen(false), setNotice(null)),
    onFeedback: setFeedback,
    onSubmit,
  };
  useEffect(() => {
    if (copy.kind === "copied") {
      const t = setTimeout(() => setCopy({ kind: "idle" }), 2500);
      return () => clearTimeout(t);
    }
    if (copy.kind === "fallback") return () => URL.revokeObjectURL(copy.url);
  }, [copy]);
  const imageUrl = (f: PreviewFrame) => (version ? `${mediaUrl(f.path)}?v=${version}` : mediaUrl(f.path));
  const onCopy = () => {
    if (copy.kind === "working") return;
    setCopy({ kind: "working" });
    startBoardCopy(board, storyTitle, imageUrl).then(setCopy);
  };
  return <DirectorBoardView board={board} storyTitle={storyTitle} version={version} dispatch={dispatch} filter={filter} onFilter={setFilter} copy={copy} onCopy={onCopy} revise={revise} qa={qa} />;
}

export function DirectorBoardView({ board, storyTitle, version, dispatch, filter, onFilter, copy, onCopy, revise, qa }: { board: Board; storyTitle: string; version: number; dispatch: (a: ReviewAction) => void; filter: BoardFilter; onFilter: (f: BoardFilter) => void; copy: BoardCopy; onCopy: () => void; revise?: SequenceReviseControls; qa?: QaControls }): React.ReactElement {
  const long = board.film === "long";
  const s = board.summary;
  const phase = qaPhaseOf(qa?.run);
  const cards = filter === "flagged" ? board.cards.filter((c) => c.flags.length > 0) : board.cards;
  const stat = (label: string, n: React.ReactNode) => (
    <span className="inline-flex items-baseline gap-1.5 whitespace-nowrap">
      <span className="text-dim">{label}</span>
      <span className="text-[#e8dfd2] tabular-nums font-medium">{n}</span>
    </span>
  );
  return (
    <div className="py-4 flex flex-col gap-5" data-director-board={board.film}>
      <div className="flex items-start justify-between gap-6 flex-wrap">
        <div className="min-w-0 flex flex-col gap-2">
          <span className="text-[10.5px] tracking-[0.2em] uppercase text-accent font-semibold">PastBriefly Director Visual Review</span>
          <h2 className="m-0 text-[26px] leading-tight text-ink">{storyTitle || "Untitled"}</h2>
          <div className="flex flex-wrap gap-x-4 gap-y-1 text-[12.5px]" data-board-summary>
            {stat("Film", long ? "Long" : "Short")}
            {stat("Slots", s.slots)}
            {stat("Duration", fmtTime(s.durationSec))}
            {stat("Owners", s.owners)}
            {stat("Archive", s.archive)}
            {stat("Graphics", s.graphics)}
            {stat("Motion", s.motion)}
            {stat("Attention", s.attention)}
          </div>
        </div>
        <div className="flex flex-col items-end gap-1.5">
          <div className="flex items-center gap-2.5 flex-wrap justify-end">
            {qa && (
              <button
                onClick={qa.onRun}
                disabled={phase !== null || !!revise?.running}
                data-action="run-director-qa"
                className="inline-flex items-center gap-2 h-10 px-[18px] rounded-full border border-accent/60 text-[13.5px] font-semibold text-[#f3ebde] hover:border-accent hover:text-white disabled:opacity-60 disabled:cursor-not-allowed"
              >
                {phase === "reviewing" ? "Director reviewing…" : phase === "repairing" ? "Repairing sequence…" : phase === "cleaning" ? "Cleaning up repetition…" : phase === "coordinating" ? "Coordinating a repair…" : phase === "verifying" ? "Final Director verification…" : "Run Director QA"}
              </button>
            )}
            {revise && (
              <button
                onClick={revise.onOpen}
                disabled={revise.open || revise.running}
                aria-expanded={revise.open}
                data-action="revise-sequence"
                className="inline-flex items-center gap-2 h-10 px-[18px] rounded-full border border-[rgba(245,235,222,0.18)] text-[13.5px] font-medium text-[#e8dfd2] hover:border-[rgba(245,235,222,0.36)] hover:text-white disabled:opacity-60 disabled:cursor-not-allowed"
              >
                Revise sequence
              </button>
            )}
            <button
              onClick={onCopy}
              disabled={copy.kind === "working"}
              data-action="copy-board"
              className="inline-flex items-center gap-2 h-10 px-[18px] rounded-full border border-[rgba(245,235,222,0.18)] text-[13.5px] font-medium text-[#e8dfd2] hover:border-[rgba(245,235,222,0.36)] hover:text-white disabled:opacity-60 disabled:cursor-not-allowed"
            >
              {copy.kind === "working" ? "Preparing board…" : "Copy Director Board"}
            </button>
          </div>
          <span aria-live="polite" className="text-[12.5px] text-right">
            {copy.kind === "copied" && <span className="text-[#a9c3a4]">Director board copied</span>}
            {copy.kind === "fallback" && (
              <span className="text-[#e3b8ab]">
                Could not copy the image.{" "}
                <a href={copy.url} download={boardFileName(board.film)} className="text-[#f3ebde] font-semibold underline underline-offset-[3px]">
                  Download Director Board
                </a>
              </span>
            )}
            {copy.kind === "error" && <span className="text-[#e3b8ab]">Could not build the board: {copy.message}</span>}
          </span>
        </div>
      </div>

      {qa?.startError && (
        <div role="alert" data-qa-result="refused" className="flex flex-col gap-1 rounded-lg border border-accent bg-accent/15 px-4 py-3 text-[14px] text-ink">
          <strong className="font-semibold">Director QA did not start</strong>
          <span className="text-[13px] break-words">{qa.startError}</span>
        </div>
      )}
      {qa?.run && qa.run.status !== "running" && <QaResult run={qa.run} onSlot={qa.onSlot} />}

      {revise?.open && (
        <section aria-label="Director sequence revision" data-sequence-revision={board.film} className="flex flex-col gap-2.5 rounded-lg border border-[rgba(245,235,222,0.12)] px-4 py-4">
          <label htmlFor="sequence-feedback" className="text-[11px] tracking-[0.18em] uppercase text-[#8f8579] font-semibold">
            Director sequence feedback · {long ? "Long" : "Short"} only
          </label>
          <textarea
            id="sequence-feedback"
            value={revise.feedback}
            onChange={(e) => revise.onFeedback(e.target.value)}
            disabled={revise.running}
            rows={7}
            placeholder="Paste the Director's sequence feedback for this film. Name the slots to replace and the slots to keep."
            className="w-full resize-y rounded-lg bg-field border border-[rgba(245,235,222,0.14)] px-3.5 py-3 text-[13.5px] leading-relaxed text-ink placeholder:text-dim outline-none transition focus:border-accent/55"
          />
          <span className="text-[12px] text-dim">Only visuals this film already has can move between slots. Timing, narration and media stay as they are.</span>
          {revise.notice?.kind === "invalid" && (
            <p role="alert" className="text-[14px] font-medium text-ink">
              {revise.notice.message}
            </p>
          )}
          {revise.notice?.kind === "failed" && (
            <div role="alert" className="flex flex-col gap-1 rounded-lg border border-accent bg-accent/15 px-4 py-3 text-[14px] text-ink">
              <strong className="font-semibold">Sequence revision failed</strong>
              <span>The current edit was not changed.</span>
              <span className="text-[13px] break-words">{revise.notice.message}</span>
            </div>
          )}
          <div className="flex items-center justify-end gap-3">
            <button onClick={revise.onCancel} disabled={revise.running} className="btn btn-ghost">
              Cancel
            </button>
            <button onClick={revise.onSubmit} disabled={revise.running} className="btn btn-ghost" data-action="submit-sequence">
              {revise.running ? "Revising…" : "Revise sequence"}
            </button>
          </div>
        </section>
      )}

      {revise?.notice?.kind === "applied" && !revise.open && (
        <div role="status" data-sequence-applied className="flex flex-col gap-1 rounded-lg border border-[#a9c3a4]/60 bg-[#a9c3a4]/10 px-4 py-3 text-[14px] text-ink">
          <strong className="font-semibold">Sequence revision applied</strong>
          <span>Review the updated Director board before continuing.</span>
          <span className="text-[13px] tabular-nums">
            Changed: {revise.notice.report.changed.length} slot{revise.notice.report.changed.length === 1 ? "" : "s"}
            {revise.notice.report.changed.length > 0 && ` (${revise.notice.report.changed.map(pad2).join(", ")})`} · Unresolved: {revise.notice.report.unresolved.length}
          </span>
          {revise.notice.report.unresolved.length > 0 && (
            <ul className="m-0 pl-4 list-disc text-[13px]" data-unresolved>
              {revise.notice.report.unresolved.map((u) => (
                <li key={u.slotId}>
                  Slot {pad2(u.slotId)}: {u.reason}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      <dl className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-x-6 gap-y-1 text-[12px] text-[#8f8579]" data-board-legend>
        {FLAG_LEGEND.map(([flag, what]) => (
          <div key={flag} className="flex gap-2">
            <dt className="font-semibold tracking-[0.08em] text-[#e3b8ab] whitespace-nowrap">{flag}</dt>
            <dd className="m-0">{what}</dd>
          </div>
        ))}
        <div className="sm:col-span-2 lg:col-span-3 text-dim">Attention flags mark where to look. They are not errors or verdicts.</div>
      </dl>

      <div className="flex items-center gap-1">
        {(["all", "flagged"] as const).map((k) => (
          <button
            key={k}
            data-board-filter={k}
            aria-pressed={filter === k}
            onClick={() => onFilter(k)}
            className={`h-[30px] px-[11px] rounded-full text-[13px] font-medium flex items-center gap-1.5 hover:text-[#f3ebde] ${filter === k ? "bg-[rgba(245,235,222,0.08)] text-[#f3ebde]" : "text-[#8f8579]"}`}
          >
            {k === "all" ? "All" : "Flagged"}
            <span className="text-[11.5px] text-dim tabular-nums">{k === "all" ? s.slots : s.attention}</span>
          </button>
        ))}
      </div>

      <div className={`grid gap-x-5 gap-y-7 ${long ? "grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4" : "grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6"}`}>
        {cards.map((c) => (
          <button key={c.index} data-board-card={c.slot} onClick={() => dispatch({ type: "slot", index: c.index })} title="Open this slot in Sequence" className="flex flex-col gap-2 text-left group">
            <span className={`relative block w-full overflow-hidden rounded-lg bg-sidebar border ${c.flags.length ? "border-accent/70" : "border-[rgba(245,235,222,0.08)]"} ${long ? "aspect-video" : "aspect-[9/16]"}`}>
              <Still frame={c.frame} version={version} className="transition-transform duration-300 group-hover:scale-[1.02]" />
            </span>
            <span className="flex items-baseline justify-between gap-2">
              <span className="text-[13px] font-semibold text-ink whitespace-nowrap">Slot {c.slot}</span>
              <span className="text-[12px] text-[#8f8579] tabular-nums whitespace-nowrap">{cardTime(c)}</span>
            </span>
            <span className="flex items-baseline gap-2 flex-wrap -mt-1">
              <span className="font-serif text-[19px] leading-none text-ink">{c.assetId}</span>
              <span className="text-[10.5px] tracking-[0.14em] text-[#8f8579]">{TRUTH_UPPER[c.frame.truth]}</span>
            </span>
            <span className="text-[10.5px] tracking-[0.12em] text-[#cabfb0]">{cardUse(c)}</span>
            <span className={`text-[12.5px] leading-snug line-clamp-3 ${c.caption ? "text-[#e8dfd2]" : "text-dim"}`}>{c.caption || NO_CAPTION}</span>
            {c.flags.length > 0 && (
              <span className="flex flex-wrap gap-1">
                {c.flags.map((f) => (
                  <span key={f} data-flag={f} className="inline-flex items-center h-[20px] px-[7px] rounded text-[9.5px] font-bold tracking-[0.1em] bg-[rgba(229,9,20,0.14)] text-[#f3c9bf]">
                    {f}
                  </span>
                ))}
              </span>
            )}
          </button>
        ))}
      </div>
      {cards.length === 0 && <p className="text-[13px] text-dim">No flagged slots in this film.</p>}
    </div>
  );
}
// The Director QA result the server saved: what changed automatically (the
// Director's repairs, the deterministic cleanup and the coordinated repair,
// counted apart) and the exceptions that still need a person, merged on the
// server from the CURRENT final film. Each listed slot opens in Sequence. Never
// an approval.
function QaResult({ run, onSlot }: { run: Exclude<DirectorQaRun, { status: "running" }>; onSlot: (slotId: number) => void }): React.ReactElement {
  if (run.status === "failed") {
    return (
      <div role="alert" data-qa-result="failed" className="flex flex-col gap-1 rounded-lg border border-accent bg-accent/15 px-4 py-3 text-[14px] text-ink">
        <strong className="font-semibold">Director QA failed</strong>
        <span>No edit was changed.</span>
        <span className="text-[13px] break-words">{run.error}</span>
      </div>
    );
  }
  if (run.status === "interrupted") {
    return (
      <div role="alert" data-qa-result="interrupted" className="flex flex-col gap-1 rounded-lg border border-accent bg-accent/15 px-4 py-3 text-[14px] text-ink">
        <strong className="font-semibold">Director QA was interrupted.</strong>
        <span>The current saved edit is kept at the last completed valid step.</span>
        <span>Run Director QA again if you want to retry.</span>
      </div>
    );
  }
  const { summary, clean } = run;
  const unresolved = run.unresolvedRepairs;
  const human = run.humanReview;
  const coordinatedError = run.coordinatedError;
  const failed = !!run.repairError || !!run.cleanupError || !!coordinatedError || !!run.verifyError;
  const slotLink = (slotId: number) => (
    <button onClick={() => onSlot(slotId)} data-qa-slot={slotId} className="font-semibold text-[#f3ebde] underline underline-offset-[3px] tabular-nums">
      Slot {pad2(slotId)}
    </button>
  );
  const list = (title: string, items: { slotId: number; reason: string }[], attr: string, tone: string) =>
    items.length > 0 && (
      <div className="flex flex-col gap-1" {...{ [attr]: true }}>
        <span className={`text-[11px] tracking-[0.16em] uppercase font-semibold ${tone}`}>{title}</span>
        <ul className="m-0 pl-4 list-disc text-[13px]">
          {items.map((u) => (
            <li key={u.slotId}>
              {slotLink(u.slotId)}: {u.reason}
            </li>
          ))}
        </ul>
      </div>
    );
  return (
    <div
      role={failed ? "alert" : "status"}
      data-qa-result={run.repairError ? "repairFailed" : "complete"}
      className={`flex flex-col gap-2 rounded-lg border px-4 py-3 text-[14px] text-ink ${failed ? "border-accent bg-accent/15" : "border-[rgba(245,235,222,0.18)] bg-[rgba(245,235,222,0.04)]"}`}
    >
      {run.repairError ? (
        <>
          <strong className="font-semibold">Director QA review completed, but automatic repair failed.</strong>
          <span>The Director's repairs were not applied.</span>
          <span className="text-[13px] break-words">{run.repairError}</span>
        </>
      ) : run.cleanupError ? (
        <strong className="font-semibold">Director QA completed, but automatic cleanup failed.</strong>
      ) : (
        <strong className="font-semibold">Director QA complete</strong>
      )}
      {run.cleanupError && (
        <span className="text-[13px] break-words" data-qa-cleanup-error>
          Cleanup: {run.cleanupError} The edit before the cleanup stays saved.
        </span>
      )}
      {coordinatedError && (
        <span className="text-[13px] break-words" data-qa-coordinated-error>
          Coordinated repair could not resolve Slot {pad2(coordinatedError.target)}. The previous valid edit is kept.
        </span>
      )}
      {run.verified && (
        <span className="text-[13px]" data-qa-verified>
          Final Director verification complete
        </span>
      )}
      {run.verifyError && (
        <span className="flex flex-col gap-0.5 text-[13px] break-words" data-qa-verify-error>
          <strong className="font-semibold">Final Director verification failed.</strong>
          <span>The repaired edit is kept. The final semantic check could not complete: review the current board before continuing.</span>
          <span>{run.verifyError}</span>
        </span>
      )}
      <span className="tabular-nums" data-qa-counts>
        Automatic Director changes: {run.automaticChanges} · Automatic cleanup changes: {run.cleanupChanges} · Coordinated repair changes: {run.coordinatedChanges} · Unresolved repairs: {unresolved.length} · Needs
        human review: {human.length}
      </span>
      {clean && !run.automaticChanges && !run.cleanupChanges && !run.coordinatedChanges && <span>No automatic sequence repair was needed.</span>}
      {summary && <p className="m-0 text-[13px] text-[#cabfb0]">{summary}</p>}
      {list("Auto repair unresolved", unresolved, "data-qa-unresolved", "text-[#e3b8ab]")}
      {run.repairError && list("Repairs the Director asked for", run.requestedRepairs, "data-qa-requested", "text-[#8f8579]")}
      {list("Needs human review", human, "data-qa-human", "text-[#f3c9bf]")}
      <span className="text-[12px] text-dim">Continue stays your decision.</span>
    </div>
  );
}
