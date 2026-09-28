import React from "react";
import { AssetActions, type RegenProps } from "./Inspector.tsx";
import { ChangeVisualForm, useSequenceRevise, type ReviseSequence, type SequenceReviseControls } from "./changeVisual.tsx";
import { Still } from "./Still.tsx";
import { issueFrame, type VisualIssue } from "./visualIssues.ts";
import { pad2, type Film, type FilmReview } from "./model.ts";

// One visual issue on its own: what is wrong, the visual it is about, and at
// most one creative action: Regenerate image for a generated image, Change
// visual for a slot that needs a different image. PB4's own checks run by
// themselves; nothing here operates them.

export interface VisualIssueProps extends RegenProps {
  issue: VisualIssue;
  position: { index: number; total: number } | null; // null: resolved since it was opened
  films: Record<Film, FilmReview>;
  version: number;
  onBack: () => void;
  onNext?: () => void;
  onReviseSequence?: ReviseSequence;
  busy: boolean; // another visual change is running
  more: React.ReactNode;
}

export function VisualIssuePanel(props: VisualIssueProps): React.ReactElement {
  const revise = useSequenceRevise(props.issue.film ?? "long", props.issue.fix === "change" ? props.onReviseSequence : undefined, props.busy);
  return <VisualIssueView {...props} revise={revise} />;
}

export function VisualIssueView(props: VisualIssueProps & { revise?: SequenceReviseControls }): React.ReactElement {
  const { issue, position, revise } = props;
  const shown = issueFrame(issue, props.films);
  const short = issue.film === "short";
  const slot = shown?.frame.slot;
  return (
    <div className="flex flex-col gap-6 max-w-[900px]" data-visual-issue-view={issue.key}>
      <button onClick={props.onBack} className="self-start inline-flex items-center gap-2 text-[13px] text-[#cabfb0] hover:text-accent">
        <span aria-hidden="true">←</span> Back to issues
      </button>
      <div className="flex flex-col gap-2">
        <p className="text-[11px] font-semibold tracking-[0.18em] uppercase text-accent">Visual issue · {position ? `Issue ${position.index + 1} of ${position.total}` : "Resolved"}</p>
        <h1 className="font-serif text-[30px] md:text-[36px] leading-[1.1] text-ink">{issue.where}</h1>
        {issue.reasons.map((r, i) => (
          <p key={i} className="text-[16px] leading-[1.55] text-[#c8bcad] [text-wrap:pretty] break-words">
            {r}
          </p>
        ))}
        {!position && <p className="text-[14.5px] text-[#a9c3a4]">PB4 no longer flags this. The current visual is below.</p>}
      </div>

      {shown && (
        <div className="flex justify-center lg:justify-start">
          <div
            data-issue-visual={issue.film}
            className={`relative overflow-hidden rounded-[10px] bg-sidebar border border-[rgba(245,235,222,0.08)] ${short ? "aspect-[9/16] h-[min(62vh,560px)]" : "w-full aspect-video"}`}
            style={short ? undefined : { maxWidth: "calc(58vh * 16 / 9)" }}
          >
            <Still frame={shown.frame} version={props.version} whole={shown.whole} />
          </div>
        </div>
      )}

      {issue.note && <p className="text-[14px] text-muted [text-wrap:pretty]">{issue.note}</p>}

      {position && issue.fix === "regenerate" && shown && <AssetActions asset={shown.asset} ownerFrame={shown.frame} onRegenerate={props.onRegenerate} regen={props.regen} draft={props.draft} onDraft={props.onDraft} prominent />}

      {revise && <ChangeVisualForm revise={revise} film={issue.film ?? "long"} />}

      <div className="flex flex-wrap items-center gap-x-5 gap-y-3 pt-4 border-t border-line">
        {position && revise && !revise.open && (
          <button onClick={() => revise.onOpen(slot !== undefined ? `Slot ${pad2(slot)}: ${issue.reasons.join(" ")}` : issue.reasons.join(" "))} disabled={revise.running} data-action="change-visual" className="btn btn-primary">
            Change visual
          </button>
        )}
        {props.onNext && (
          <button onClick={props.onNext} className="text-[14px] text-ink underline underline-offset-[3px] decoration-[rgba(245,235,222,0.3)] hover:text-accent">
            Next issue →
          </button>
        )}
        {props.more}
      </div>
    </div>
  );
}
