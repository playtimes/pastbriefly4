import React from "react";
import { canRegenerate, fmtTime, regenKey, slotLabel, type FilmReview, type ReviewAsset } from "./model.ts";
import { RefreshIcon } from "./Still.tsx";
import { stillFeedbackError, type PreviewFrame } from "../../types.ts";

// What the film view says about the current slot, in plain words, and the two
// creative actions: Regenerate image (a generated image only) and Change visual.

export interface RegenStatus {
  running: string | null; // regenKey of the image being regenerated
  failed: { key: string; message: string } | null;
  done: string | null; // regenKey of the last image replaced successfully
  blocked?: boolean; // another visual change is running
}

// The open "what should change?" note for one image (by regenKey). Ephemeral:
// it lives in the session only and is never stored.
export interface RegenDraft {
  key: string;
  text: string;
}

export interface RegenProps {
  onRegenerate?: (f: PreviewFrame, directorFeedback?: string) => void;
  regen: RegenStatus;
  // With onDraft, Regenerate image first opens the optional note; without it,
  // the button regenerates straight away.
  draft?: RegenDraft | null;
  onDraft?: (d: RegenDraft | null) => void;
}

export const KIND_LABEL: Record<PreviewFrame["truth"], string> = { archive: "Archive photograph", reconstruction: "Generated image", graphic: "Generated graphic" };

const rowLabel = "text-[11px] tracking-[0.14em] uppercase text-dim";

// The current slot: when it plays, what it shows, and what can be done.
export function ShotPanel({ fr, index, children, ...regen }: { fr: FilmReview; index: number; children?: React.ReactNode } & RegenProps): React.ReactElement {
  const f = fr.frames[index];
  const asset = fr.assets[fr.assetOf[index]];
  const ownerFrame = fr.frames[asset.owner];
  const others = asset.uses.filter((j) => j !== index).map((j) => slotLabel(fr.frames[j], j));
  return (
    <div data-shot-panel className="flex flex-col gap-4">
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-[11px] tracking-[0.2em] uppercase text-[#8f8579] font-semibold">Slot {slotLabel(f, index)}</span>
        {typeof f.startSec === "number" && <span className="text-[12.5px] text-dim tabular-nums">{fmtTime(f.startSec)}</span>}
      </div>
      <div className="flex flex-col gap-1">
        <span className="text-[15px] text-ink">{KIND_LABEL[ownerFrame.truth]}</span>
        {others.length > 0 && <span className="text-[13px] text-muted">The same image appears in slot{others.length === 1 ? "" : "s"} {others.join(", ")}.</span>}
      </div>
      {f.caption && (
        <div className="flex flex-col gap-1">
          <span className={rowLabel}>On screen</span>
          <span className="text-[14px] text-[#cabfb0]">{f.caption}</span>
        </div>
      )}
      <AssetActions asset={asset} ownerFrame={ownerFrame} {...regen} />
      {children}
    </div>
  );
}

// Regenerate image for a generated image, or why an archive photograph stays as
// found. A shared image changes everywhere it appears.
export function AssetActions({ asset, ownerFrame, onRegenerate, regen, draft, onDraft, prominent }: { asset: ReviewAsset; ownerFrame: PreviewFrame; prominent?: boolean } & RegenProps): React.ReactElement | null {
  if (ownerFrame.truth === "archive") {
    return <div className="text-[13px] text-dim">An archive photograph is used as found. It is not regenerated.</div>;
  }
  if (!onRegenerate || !canRegenerate(ownerFrame)) return null;
  const key = regenKey(ownerFrame);
  const running = regen.running === key;
  const failed = regen.failed?.key === key ? regen.failed : null;
  const busy = regen.running !== null || !!regen.blocked;
  const n = asset.uses.length;
  const open = onDraft && draft?.key === key ? draft : null;
  const tooLong = open ? stillFeedbackError(open.text) : null;
  // A blank note is no note: the image is regenerated as planned.
  const submit = () => (tooLong ? undefined : open ? onRegenerate(ownerFrame, open.text.trim() || undefined) : onRegenerate(ownerFrame));
  const button = prominent
    ? "btn btn-primary w-fit"
    : `inline-flex items-center gap-2 h-9 px-4 rounded-full border border-[rgba(245,235,222,0.18)] text-[13px] font-medium hover:border-[rgba(245,235,222,0.36)] hover:text-white disabled:cursor-not-allowed ${running ? "text-[#8f8579]" : "text-[#e8dfd2]"}`;
  return (
    <div className="flex flex-col gap-2" data-regenerate={key}>
      {open ? (
        <div className="flex flex-col gap-2" data-regen-feedback={key}>
          <label htmlFor={`regen-feedback-${key}`} className={rowLabel}>
            What should change? (optional)
          </label>
          <textarea
            id={`regen-feedback-${key}`}
            value={open.text}
            onChange={(e) => onDraft!({ key, text: e.target.value })}
            disabled={busy}
            rows={3}
            placeholder="One correction for this image. Leave blank to make it again as planned."
            className="w-full resize-y rounded-lg bg-field border border-[rgba(245,235,222,0.14)] px-3 py-2 text-[13.5px] leading-relaxed text-ink placeholder:text-dim outline-none transition focus:border-accent/55"
          />
          {tooLong && (
            <span role="alert" className="text-[13px] font-medium text-[#f3ebde]">
              {tooLong}
            </span>
          )}
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <button onClick={() => onDraft!(null)} disabled={busy} className="text-[13px] text-[#cabfb0] hover:text-white disabled:cursor-not-allowed">
              Cancel
            </button>
            <button onClick={submit} disabled={busy || !!tooLong} className={button}>
              <RefreshIcon size={14} />
              {running ? "Regenerating…" : "Regenerate image"}
            </button>
          </div>
        </div>
      ) : (
        <div className="flex items-center gap-3 flex-wrap">
          <button onClick={() => (onDraft ? onDraft({ key, text: "" }) : onRegenerate(ownerFrame))} disabled={busy} className={button}>
            <RefreshIcon size={14} />
            {running ? "Regenerating…" : "Regenerate image"}
          </button>
          {regen.done === key && !running && !failed && <span className="text-[12.5px] text-[#a9c3a4]">✓ New image in place</span>}
        </div>
      )}
      {failed && (
        <div className="flex items-center gap-2.5 flex-wrap text-[13px] text-[#e3b8ab]" role="alert">
          <span>Could not regenerate this image. The current one is kept.</span>
          <button onClick={submit} disabled={busy || !!tooLong} className="text-[#f3ebde] font-semibold underline underline-offset-[3px]">
            Retry
          </button>
        </div>
      )}
      <span className="text-xs leading-normal text-dim">{n > 1 ? `Replaces this image in all ${n} slots that use it. The edit stays the same.` : "Replaces this image. The edit stays the same."}</span>
    </div>
  );
}
