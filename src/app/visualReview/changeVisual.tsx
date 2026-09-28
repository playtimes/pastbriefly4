import React, { useState } from "react";
import { sequenceFeedbackError, type SequenceRevisionReport } from "../../types.ts";
import { pad2, type Film } from "./model.ts";

// Change visual: the existing sequence revision for ONE film, asked for in plain
// words. It can only move images the film already has between its slots; the
// narration, timing and media stay as they are.

export type ReviseSequence = (kind: Film, feedback: string) => Promise<SequenceRevisionReport>;

// The outcome of the last change in this session. Local only.
export type SequenceNotice = { kind: "invalid"; message: string } | { kind: "failed"; message: string } | { kind: "applied"; report: SequenceRevisionReport };

// The Change visual form, as the view sees it.
export interface SequenceReviseControls {
  open: boolean;
  feedback: string;
  running: boolean;
  notice: SequenceNotice | null;
  onOpen: (prefill?: string) => void; // prefill: a starting instruction, kept if something was already typed
  onCancel: () => void;
  onFeedback: (v: string) => void;
  onSubmit: () => void;
}

export type SequenceOutcome = { status: "skipped" } | { status: "invalid"; error: string } | { status: "ok"; report: SequenceRevisionReport } | { status: "failed"; error: string };

// Submit trimmed feedback for ONE film, once. Invalid feedback never reaches the
// server and is never truncated; a revision already running is skipped; a
// rejection becomes an error to show, and the caller keeps the typed text.
export async function submitSequenceRevision(kind: Film, feedback: string, running: boolean, revise: ReviseSequence): Promise<SequenceOutcome> {
  if (running) return { status: "skipped" };
  const invalid = sequenceFeedbackError(feedback);
  if (invalid) return { status: "invalid", error: invalid };
  try {
    return { status: "ok", report: await revise(kind, feedback.trim()) };
  } catch (e: any) {
    return { status: "failed", error: e?.message || "The visual could not be changed." };
  }
}

// The form's state: local, never stored. `busy` (another visual operation is
// running) disables it. Undefined when changing visuals is not wired.
export function useSequenceRevise(film: Film, onReviseSequence: ReviseSequence | undefined, busy: boolean): SequenceReviseControls | undefined {
  const [open, setOpen] = useState(false);
  const [feedback, setFeedback] = useState("");
  const [running, setRunning] = useState(false);
  const [notice, setNotice] = useState<SequenceNotice | null>(null);
  const onSubmit = async () => {
    if (!onReviseSequence || running || busy) return;
    setNotice(null);
    setRunning(true);
    const out = await submitSequenceRevision(film, feedback, false, onReviseSequence);
    setRunning(false);
    if (out.status === "invalid" || out.status === "failed") setNotice({ kind: out.status, message: out.error });
    if (out.status === "ok") {
      setOpen(false);
      setFeedback("");
      setNotice({ kind: "applied", report: out.report });
    }
  };
  return (
    onReviseSequence && {
      open,
      feedback,
      running: running || busy,
      notice,
      onOpen: (prefill) => (setOpen(true), setNotice(null), setFeedback((f) => f || prefill || "")),
      onCancel: () => (setOpen(false), setNotice(null)),
      onFeedback: setFeedback,
      onSubmit,
    }
  );
}

// The open form, and what the last change did.
export function ChangeVisualForm({ revise, film }: { revise: SequenceReviseControls; film: Film }): React.ReactElement {
  const report = revise.notice?.kind === "applied" && !revise.open ? revise.notice.report : null;
  return (
    <>
      {revise.open && (
        <section aria-label="Change visual" data-change-visual={film} className="flex flex-col gap-2.5 rounded-lg border border-[rgba(245,235,222,0.12)] px-4 py-4">
          <label htmlFor="change-visual" className="text-[11px] tracking-[0.18em] uppercase text-[#8f8579] font-semibold">
            What should change? · {film === "long" ? "Long" : "Short"} film
          </label>
          <textarea
            id="change-visual"
            value={revise.feedback}
            onChange={(e) => revise.onFeedback(e.target.value)}
            disabled={revise.running}
            rows={4}
            placeholder="For example: Slot 05, use a different image of the harbour."
            className="w-full resize-y rounded-lg bg-field border border-[rgba(245,235,222,0.14)] px-3.5 py-3 text-[14px] leading-relaxed text-ink placeholder:text-dim outline-none transition focus:border-accent/55"
          />
          <span className="text-[12.5px] text-dim">PB4 picks from images this film already has. Narration and timing stay the same.</span>
          {revise.notice?.kind === "invalid" && (
            <p role="alert" className="text-[14px] font-medium text-ink">
              {revise.notice.message}
            </p>
          )}
          {revise.notice?.kind === "failed" && (
            <div role="alert" className="flex flex-col gap-1 rounded-lg border border-accent bg-accent/15 px-4 py-3 text-[14px] text-ink">
              <strong className="font-semibold">The visual was not changed</strong>
              <span className="text-[13px] break-words">{revise.notice.message}</span>
            </div>
          )}
          <div className="flex items-center justify-end gap-3">
            <button onClick={revise.onCancel} disabled={revise.running} className="btn btn-ghost">
              Cancel
            </button>
            <button onClick={revise.onSubmit} disabled={revise.running} className="btn btn-primary" data-action="submit-change">
              {revise.running ? "Changing…" : "Change visual"}
            </button>
          </div>
        </section>
      )}
      {report && (
        <div role="status" data-change-applied className="flex flex-col gap-1 rounded-lg border border-[#a9c3a4]/60 bg-[#a9c3a4]/10 px-4 py-3 text-[14px] text-ink">
          <strong className="font-semibold">{report.changed.length ? `Changed slot${report.changed.length === 1 ? "" : "s"} ${report.changed.map(pad2).join(", ")}` : "Nothing was changed"}</strong>
          {report.unresolved.map((u) => (
            <span key={u.slotId} className="text-[13px]">
              Slot {pad2(u.slotId)} could not change: {u.reason}
            </span>
          ))}
        </div>
      )}
    </>
  );
}
