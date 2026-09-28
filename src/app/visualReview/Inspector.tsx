import React from "react";
import { canRegenerate, fmtTime, isOwnerFrame, regenKey, slotLabel, type FilmReview, type ReviewAction, type ReviewAsset } from "./model.ts";
import { framingLabel, LinkIcon, RefreshIcon, TRUTH_LABEL } from "./Still.tsx";
import { stillFeedbackError, type PreviewFrame } from "../../types.ts";

// The compact inspector beside (desktop) or below (mobile) the current visual.
// It shows only public preview data: slot timing, the asset, its truth, owner or
// reuse, framing, focus, motion and the on-screen caption.

export interface RegenStatus {
  running: string | null; // regenKey of the still being regenerated
  failed: { key: string; message: string } | null;
  done: string | null; // regenKey of the last still replaced successfully
  blocked?: boolean; // another edit operation (sequence revision, Director QA) is running
}

// The open Director-feedback box for one owner still (by regenKey). Ephemeral:
// it lives in the review session only and is never stored.
export interface RegenDraft {
  key: string;
  text: string;
}

export interface RegenProps {
  onRegenerate?: (f: PreviewFrame, directorFeedback?: string) => void;
  regen: RegenStatus;
  // With onDraft, Regenerate still first opens the optional feedback box;
  // without it, the button regenerates straight away as before.
  draft?: RegenDraft | null;
  onDraft?: (d: RegenDraft | null) => void;
}

const badge = "inline-flex items-center gap-1.5 h-[22px] px-[9px] rounded text-[10px] font-bold tracking-[0.14em]";
const rowLabel = "text-[11px] tracking-[0.14em] uppercase text-dim pt-0.5";
const chip = "h-[26px] px-2.5 rounded-full border border-[rgba(245,235,222,0.14)] text-[#cabfb0] text-xs tabular-nums hover:border-accent hover:text-white";

export function SlotInspector({ fr, index, dispatch, ...regen }: { fr: FilmReview; index: number; dispatch: (a: ReviewAction) => void } & RegenProps): React.ReactElement {
  const f = fr.frames[index];
  const asset = fr.assets[fr.assetOf[index]];
  const owner = isOwnerFrame(fr, index);
  const ownerFrame = fr.frames[asset.owner];
  const others = asset.uses.filter((j) => j !== index);
  const hasTime = typeof f.startSec === "number" && typeof f.durationSec === "number";
  return (
    <div data-inspector="slot">
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-[11px] tracking-[0.2em] uppercase text-[#8f8579] font-semibold">Slot {slotLabel(f, index)}</span>
        {hasTime && (
          <span className="text-[12.5px] text-dim tabular-nums whitespace-nowrap">
            {fmtTime(f.startSec!)} → {fmtTime(f.startSec! + f.durationSec!)} · {f.durationSec!.toFixed(1)}s
          </span>
        )}
      </div>

      <div className="flex flex-wrap gap-1.5 mt-3.5">
        {owner ? (
          <span className={`${badge} bg-[rgba(243,235,222,0.1)] text-[#f3ebde]`}>ORIGINAL ASSET</span>
        ) : (
          <span className={`${badge} border border-[rgba(245,235,222,0.2)] text-[#cabfb0]`}>
            <LinkIcon />
            REUSE OF {asset.id}
          </span>
        )}
        {f.motion && <span className={`${badge} bg-accent text-white`}>MOTION</span>}
      </div>

      <div className="mt-4 font-serif text-[40px] leading-none text-ink break-words">{asset.id}</div>
      <div className="mt-2 text-[11px] tracking-[0.16em] uppercase text-[#8f8579]">{TRUTH_LABEL[f.truth]}</div>

      {!owner && (
        <button
          onClick={() => dispatch({ type: "slot", index: asset.owner })}
          className="mt-4 inline-flex items-center gap-2 pb-[3px] border-b border-[rgba(229,9,20,0.6)] text-[#f3ebde] text-sm font-medium hover:text-accent"
        >
          View original asset · slot {slotLabel(ownerFrame, asset.owner)} →
        </button>
      )}
      {owner && <AssetActions asset={asset} ownerFrame={ownerFrame} {...regen} />}

      <div className="mt-6 pt-[18px] border-t border-[rgba(245,235,222,0.08)] grid grid-cols-[84px_minmax(0,1fr)] gap-y-[11px] gap-x-3.5 text-sm">
        <span className={rowLabel}>Framing</span>
        <span className="text-[#e8dfd2]">{framingLabel(f)}</span>
        {f.focus && (
          <>
            <span className={rowLabel}>Focus</span>
            <span className="text-[#e8dfd2]">“{f.focus}”</span>
          </>
        )}
        <span className={rowLabel}>Motion</span>
        <span className={f.motion ? "text-[#f3ebde]" : "text-[#8f8579]"}>{f.motion ? "Selected · animated after approval" : "None"}</span>
        {f.caption && (
          <>
            <span className={rowLabel}>Caption</span>
            <span className="text-[#cabfb0]">{f.caption}</span>
          </>
        )}
      </div>

      {others.length > 0 && (
        <div className="mt-5">
          <div className="text-[11px] tracking-[0.14em] uppercase text-dim">{owner ? "Reused in" : "Same asset in"}</div>
          <div className="flex flex-wrap gap-1.5 mt-2">
            {others.map((j) => (
              <button key={j} onClick={() => dispatch({ type: "slot", index: j })} className={chip}>
                {slotLabel(fr.frames[j], j)}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

export function AssetInspector({ fr, asset, dispatch, ...regen }: { fr: FilmReview; asset: ReviewAsset; dispatch: (a: ReviewAction) => void } & RegenProps): React.ReactElement {
  const ownerFrame = fr.frames[asset.owner];
  const n = asset.uses.length;
  return (
    <div data-inspector="asset">
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-[11px] tracking-[0.2em] uppercase text-[#8f8579] font-semibold">Asset</span>
        <span className="text-[12.5px] text-dim">
          Used in {n} slot{n === 1 ? "" : "s"}
        </span>
      </div>
      {asset.motion && (
        <div className="flex flex-wrap gap-1.5 mt-3.5">
          <span className={`${badge} bg-accent text-white`}>MOTION SELECTED</span>
        </div>
      )}
      <div className="mt-4 font-serif text-[40px] leading-none text-ink break-words">{asset.id}</div>
      <div className="mt-2 text-[11px] tracking-[0.16em] uppercase text-[#8f8579]">{TRUTH_LABEL[asset.truth]}</div>

      <AssetActions asset={asset} ownerFrame={ownerFrame} {...regen} />

      <div className="mt-6 pt-[18px] border-t border-[rgba(245,235,222,0.08)] grid grid-cols-[84px_minmax(0,1fr)] gap-y-[11px] gap-x-3.5 text-sm items-start">
        <span className={rowLabel}>Owner</span>
        <button
          onClick={() => dispatch({ type: "slot", index: asset.owner })}
          className="justify-self-start text-[#e8dfd2] underline underline-offset-[3px] decoration-[rgba(229,9,20,0.6)] hover:text-accent"
        >
          Slot {slotLabel(ownerFrame, asset.owner)}
        </button>
        <span className={`${rowLabel} pt-[5px]`}>Used</span>
        <div className="flex flex-wrap gap-1.5">
          {asset.uses.map((j) => (
            <button key={j} onClick={() => dispatch({ type: "slot", index: j })} className={chip}>
              {slotLabel(fr.frames[j], j)}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

// Regenerate still for an eligible generated owner, or the archive note. Reuse
// slots never get here: they offer "View original asset" instead.
function AssetActions({ asset, ownerFrame, onRegenerate, regen, draft, onDraft }: { asset: ReviewAsset; ownerFrame: PreviewFrame } & RegenProps): React.ReactElement | null {
  if (ownerFrame.truth === "archive") {
    return <div className="mt-4 text-[12.5px] text-dim">Documentary material - used as found, not regenerated.</div>;
  }
  if (!onRegenerate || !canRegenerate(ownerFrame)) return null;
  const key = regenKey(ownerFrame);
  const running = regen.running === key;
  const failed = regen.failed?.key === key ? regen.failed : null;
  const busy = regen.running !== null || !!regen.blocked;
  const n = asset.uses.length;
  const open = onDraft && draft?.key === key ? draft : null;
  const tooLong = open ? stillFeedbackError(open.text) : null;
  // Blank feedback is no feedback: exactly today's regeneration.
  const submit = () => (tooLong ? undefined : open ? onRegenerate(ownerFrame, open.text.trim() || undefined) : onRegenerate(ownerFrame));
  const button = `inline-flex items-center gap-2 h-9 px-4 rounded-full border border-[rgba(245,235,222,0.18)] text-[13px] font-medium hover:border-[rgba(245,235,222,0.36)] hover:text-white disabled:cursor-not-allowed ${running ? "text-[#8f8579]" : "text-[#e8dfd2]"}`;
  return (
    <div className="mt-[18px] flex flex-col gap-2" data-regenerate={key}>
      {open ? (
        <div className="flex flex-col gap-2" data-regen-feedback={key}>
          <span className="text-[11px] tracking-[0.2em] uppercase text-[#8f8579] font-semibold">Regenerate {asset.id}</span>
          <label htmlFor={`regen-feedback-${key}`} className={rowLabel}>
            Director feedback (optional)
          </label>
          <textarea
            id={`regen-feedback-${key}`}
            value={open.text}
            onChange={(e) => onDraft!({ key, text: e.target.value })}
            disabled={busy}
            rows={3}
            placeholder="One visual correction for this still. Leave blank to regenerate as planned."
            className="w-full resize-y rounded-lg bg-field border border-[rgba(245,235,222,0.14)] px-3 py-2 text-[13px] leading-relaxed text-ink placeholder:text-dim outline-none transition focus:border-accent/55"
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
              {running ? "Regenerating…" : "Regenerate still"}
            </button>
          </div>
        </div>
      ) : (
        <div className="flex items-center gap-3 flex-wrap">
          <button onClick={() => (onDraft ? onDraft({ key, text: "" }) : onRegenerate(ownerFrame))} disabled={busy} className={button}>
            <RefreshIcon size={14} />
            {running ? "Regenerating…" : "Regenerate still"}
          </button>
          {regen.done === key && !running && !failed && <span className="text-[12.5px] text-[#a9c3a4]">✓ New still in place - review it now</span>}
        </div>
      )}
      {failed && (
        <div className="flex items-center gap-2.5 flex-wrap text-[13px] text-[#e3b8ab]" role="alert">
          <span>Could not regenerate this still. The current one is kept.</span>
          <button onClick={submit} disabled={busy || !!tooLong} className="text-[#f3ebde] font-semibold underline underline-offset-[3px]">
            Retry
          </button>
          {failed.message && <span className="basis-full text-xs text-[#a88f86]">{failed.message}</span>}
        </div>
      )}
      <span className="text-xs leading-normal text-dim">
        {n > 1
          ? `Replaces ${asset.id} in all ${n} slots that use it. Timing, framing and the edit stay the same.`
          : `Replaces ${asset.id} in slot ${slotLabel(ownerFrame, asset.owner)}. The edit stays the same.`}
      </span>
    </div>
  );
}
