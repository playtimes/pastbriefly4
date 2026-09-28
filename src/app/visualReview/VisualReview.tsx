import React, { useEffect, useReducer, useRef } from "react";
import {
  buildFilm,
  FILTERS,
  fmtTime,
  initialReview,
  matchingSlots,
  regenKey,
  reviewReducer,
  slotLabel,
  stepAction,
  type Film,
  type FilmReview,
  type ReviewAction,
  type ReviewState,
} from "./model.ts";
import { AssetInspector, SlotInspector, type RegenProps } from "./Inspector.tsx";
import { AssetGrid } from "./AssetGrid.tsx";
import { DirectorBoard, type RunDirectorQa } from "./DirectorBoard.tsx";
import { Filmstrip } from "./Filmstrip.tsx";
import { RefreshIcon, Still } from "./Still.tsx";
import { AssetQaNotice, VisualQaSummary } from "./AssetQaNotice.tsx";
import type { AssetQaState, DirectorQaRuns, SequenceRevisionReport, VisualAutopilotState, VisualPreview } from "../../types.ts";

// The visual-review gate: one film at a time, reviewed as a Sequence of edit slots
// or as its unique Assets, with a large current visual, a compact inspector and a
// filmstrip - or as a read-only Director board of every slot. All navigation is local UI state; the only actions that touch the
// job are the existing Continue, Rebuild visuals and Regenerate still handlers.

export interface VisualReviewProps extends RegenProps {
  preview: VisualPreview;
  storyTitle?: string;
  version: number; // image cache-bust after a regeneration
  onBack: () => void;
  onContinue: () => void;
  onRebuild: () => void;
  continuing: boolean;
  rebuilding: boolean;
  onReviseSequence?: (kind: Film, feedback: string) => Promise<SequenceRevisionReport>;
  onDirectorQa?: RunDirectorQa;
  revisingSequence?: boolean; // a sequence revision or Director QA is running
  directorQa?: DirectorQaRuns; // the latest Run Director QA per film (server state)
  visualAutopilot?: VisualAutopilotState; // the Visual Autopilot, when its approval failed
  assetQa?: Extract<AssetQaState, { status: "done" }>; // the latest Pixel Asset QA result
}

export function VisualReview(props: VisualReviewProps): React.ReactElement {
  const [state, dispatch] = useReducer(reviewReducer, props.preview, initialReview);
  const films = { long: buildFilm(props.preview, "long"), short: buildFilm(props.preview, "short") };
  const fr = films[state.film];

  // Left/Right step through the matching slots (or assets). Typing in a field,
  // or a modified key, is never hijacked.
  const latest = useRef({ state, fr });
  latest.current = { state, fr };
  useEffect(() => {
    function onKey(e: KeyboardEvent): void {
      if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
      if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
      const t = e.target as HTMLElement | null;
      if (t && (/^(input|textarea|select)$/i.test(t.tagName) || t.isContentEditable)) return;
      const a = stepAction(latest.current.state, latest.current.fr, e.key === "ArrowRight" ? 1 : -1);
      e.preventDefault();
      if (a) dispatch(a);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return <ReviewView {...props} films={films} state={state} dispatch={dispatch} />;
}

export function ReviewView(props: VisualReviewProps & { films: Record<Film, FilmReview>; state: ReviewState; dispatch: (a: ReviewAction) => void }): React.ReactElement {
  const { films, state, dispatch, version } = props;
  const fr = films[state.film];
  const seq = state.mode === "sequence";
  const openAsset = seq ? undefined : fr.assets.find((a) => a.key === state.asset[state.film]);
  const index = Math.min(state.index[state.film], Math.max(0, fr.frames.length - 1));
  const regen: RegenProps = { onRegenerate: props.onRegenerate, regen: props.regen, draft: props.draft, onDraft: props.onDraft };

  return (
    <div className="flex flex-col" data-review-film={state.film} data-review-mode={state.mode}>
      <ReviewHeader {...props} fr={fr} />
      {props.assetQa && <AssetQaNotice qa={props.assetQa} films={films} version={version} dispatch={dispatch} />}
      <VisualQaSummary runs={props.directorQa} pilot={props.visualAutopilot} dispatch={dispatch} />
      {fr.frames.length === 0 ? (
        <p className="py-16 text-center text-dim">This film has no preview frames.</p>
      ) : (
        <>
          <Toolbar fr={fr} state={state} dispatch={dispatch} />
          {state.mode === "director" ? (
            <DirectorBoard key={fr.film} fr={fr} storyTitle={props.storyTitle ?? ""} version={version} dispatch={dispatch} onReviseSequence={props.onReviseSequence} onDirectorQa={props.onDirectorQa} directorQa={props.directorQa?.[fr.film]} />
          ) : !seq && !openAsset ? (
            <AssetGrid fr={fr} dispatch={dispatch} version={version} />
          ) : (
            <>
              <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_340px] gap-[22px] lg:gap-10 py-3.5">
                <div className="min-w-0 flex flex-col gap-3">
                  {openAsset && (
                    <button onClick={() => dispatch({ type: "asset", key: null })} className="self-start h-7 text-[13px] text-[#8f8579] hover:text-[#f3ebde]">
                      ← All {fr.assets.length} assets
                    </button>
                  )}
                  <Stage fr={fr} state={state} index={index} dispatch={dispatch} version={version} regenRunning={props.regen.running} />
                </div>
                <aside className="min-w-0 lg:max-h-[calc(100vh-240px)] lg:overflow-y-auto lg:pr-1.5">
                  {openAsset ? <AssetInspector fr={fr} asset={openAsset} dispatch={dispatch} {...regen} /> : <SlotInspector fr={fr} index={index} dispatch={dispatch} {...regen} />}
                </aside>
              </div>
              <Filmstrip fr={fr} state={state} dispatch={dispatch} version={version}>
                <StripBar fr={fr} state={state} dispatch={dispatch} />
              </Filmstrip>
            </>
          )}
          {/* Mobile keeps Rebuild reachable without crowding the compact header. */}
          <div className="lg:hidden flex justify-center pt-6 pb-2">
            <RebuildButton {...props} />
          </div>
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------

export function ReviewHeader(props: VisualReviewProps & { films: Record<Film, FilmReview>; state: ReviewState; dispatch: (a: ReviewAction) => void; fr: FilmReview }): React.ReactElement {
  const { films, state, dispatch, fr, preview } = props;
  const m = fr.metrics;
  const metrics = (
    <>
      <Metric n={m.assets} label={m.assets === 1 ? "asset" : "assets"} />
      <Metric n={m.reuses} label={m.reuses === 1 ? "reuse" : "reuses"} />
      <Metric n={m.archive} label="archive" />
      <Metric n={m.motion} label="motion" dot />
      {preview.remainingMotionCost > 0 && <span className="whitespace-nowrap">est. ${preview.remainingMotionCost.toFixed(2)} remaining motion (both films)</span>}
    </>
  );
  const tabs = (mobile: boolean) =>
    (["long", "short"] as const).map((k) => (
      <button
        key={k}
        data-film-tab={k}
        aria-pressed={state.film === k}
        onClick={() => dispatch({ type: "film", film: k })}
        className={`rounded-full font-semibold whitespace-nowrap ${mobile ? "flex-1 h-9 text-[13px]" : "h-[34px] px-[18px] text-[13.5px]"} ${state.film === k ? "bg-accent text-white" : "text-[#8f8579] hover:text-[#f3ebde]"}`}
      >
        {mobile ? (k === "long" ? "Long" : "Short") : k === "long" ? "Long documentary" : "Short"}
        <span className="font-normal opacity-75"> · {films[k].frames.length}</span>
      </button>
    ));
  const back = (
    <button onClick={props.onBack} className="inline-flex items-center gap-2 text-[13px] text-[#cabfb0] hover:text-accent max-w-full truncate">
      <span aria-hidden="true">←</span> {props.storyTitle || "Back to story"}
    </button>
  );

  return (
    <>
      {/* Desktop */}
      <header className="hidden lg:grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-6 pb-4 border-b border-[rgba(245,235,222,0.07)]">
        <div className="min-w-0">
          {back}
          <div className="flex items-baseline gap-3.5 mt-2">
            <span className="text-[10.5px] tracking-[0.2em] uppercase text-dim whitespace-nowrap">Visual review</span>
            <h1 className="m-0 text-[32px] leading-none text-ink whitespace-nowrap">Visual direction</h1>
          </div>
        </div>
        <div className="flex flex-col items-center gap-[9px]">
          <div className="inline-flex p-1 rounded-full bg-[#15100e] border border-[rgba(245,235,222,0.09)]">{tabs(false)}</div>
          <div className="flex flex-wrap items-center justify-center gap-x-3.5 gap-y-1 max-w-[420px] text-[12.5px] text-[#8f8579] whitespace-nowrap">{metrics}</div>
        </div>
        <div className="flex items-center justify-end gap-2.5">
          <RebuildButton {...props} />
          <ContinueButton {...props} />
        </div>
      </header>

      {/* Mobile: compact and sticky, film choice and Continue always at hand. */}
      <header className="lg:hidden sticky top-[55px] md:top-0 z-10 -mx-4 md:mx-0 px-4 py-3 bg-[rgba(14,10,9,0.96)] border-b border-[rgba(245,235,222,0.07)] flex flex-col gap-3">
        <div className="flex items-center gap-3">
          <button onClick={props.onBack} title="Back to story" className="w-9 h-9 flex-none rounded-full grid place-items-center text-[#cabfb0] border border-[rgba(245,235,222,0.12)]">
            ←
          </button>
          <div className="flex-1 min-w-0">
            <div className="text-[10px] tracking-[0.2em] uppercase text-dim">Visual review</div>
            <h1 className="m-0 text-[23px] leading-[1.05] text-ink">Visual direction</h1>
          </div>
          <ContinueButton {...props} compact />
        </div>
        <div className="flex p-1 rounded-full bg-[#15100e] border border-[rgba(245,235,222,0.09)]">{tabs(true)}</div>
        <div className="flex items-center gap-3 text-xs text-[#8f8579] overflow-x-auto whitespace-nowrap">{metrics}</div>
      </header>
    </>
  );
}

function Metric({ n, label, dot }: { n: number; label: string; dot?: boolean }): React.ReactElement {
  return (
    <span className="inline-flex items-center gap-[5px]">
      {dot && <span className="w-[5px] h-[5px] rounded-full bg-accent" />}
      <span className="text-[#e8dfd2] tabular-nums font-medium">{n}</span>
      {label}
    </span>
  );
}

function ContinueButton({ onContinue, continuing, rebuilding, regen, revisingSequence, compact }: VisualReviewProps & { compact?: boolean }): React.ReactElement {
  return (
    <button
      onClick={onContinue}
      disabled={continuing || rebuilding || regen.running !== null || !!revisingSequence}
      data-action="continue"
      className={`inline-flex items-center gap-2 rounded-full bg-accent text-white font-semibold whitespace-nowrap hover:bg-accent-hover disabled:opacity-50 disabled:cursor-not-allowed ${compact ? "h-10 px-[18px] text-sm" : "h-[42px] px-[22px] text-sm shadow-[0_8px_24px_rgba(229,9,20,0.28)]"}`}
    >
      {continuing ? "Continuing…" : "Continue"}
      {!compact && !continuing && <span aria-hidden="true">→</span>}
    </button>
  );
}

function RebuildButton({ onRebuild, continuing, rebuilding, regen, revisingSequence }: VisualReviewProps): React.ReactElement {
  return (
    <button
      onClick={onRebuild}
      disabled={continuing || rebuilding || regen.running !== null || !!revisingSequence}
      data-action="rebuild"
      className="inline-flex items-center gap-2 h-10 px-3.5 rounded-full text-[13.5px] font-medium text-[#8f8579] whitespace-nowrap hover:text-[#f3ebde] hover:bg-[rgba(245,235,222,0.04)] disabled:opacity-50 disabled:cursor-not-allowed"
    >
      <RefreshIcon />
      {rebuilding ? "Rebuilding…" : "Rebuild visuals"}
    </button>
  );
}

// ---------------------------------------------------------------------------

function Toolbar({ fr, state, dispatch }: { fr: FilmReview; state: ReviewState; dispatch: (a: ReviewAction) => void }): React.ReactElement {
  const seen = state.visited[fr.film].length;
  const total = fr.frames.length;
  return (
    <div className="flex items-center justify-between gap-4 flex-wrap pt-2">
      <div className="flex items-center gap-[26px] flex-wrap min-w-0">
        <div className="flex gap-5">
          {(["sequence", "assets", "director"] as const).map((k) => (
            <button
              key={k}
              data-mode-tab={k}
              aria-pressed={state.mode === k}
              onClick={() => dispatch({ type: "mode", mode: k })}
              className={`relative h-[34px] text-[11.5px] font-semibold tracking-[0.16em] uppercase hover:text-[#f3ebde] ${state.mode === k ? "text-[#f3ebde]" : "text-dim"}`}
            >
              {k === "sequence" ? "Sequence" : k === "assets" ? "Assets" : "Director"}
              <span className="absolute left-0 right-0 bottom-0.5 h-0.5 rounded-sm" style={{ background: state.mode === k ? "#e50914" : "transparent" }} />
            </button>
          ))}
        </div>
        {state.mode === "sequence" && (
          <div className="flex items-center gap-1 sm:pl-[22px] sm:border-l border-[rgba(245,235,222,0.1)] overflow-x-auto max-w-full">
            {FILTERS.map((f) => (
              <button
                key={f.key}
                data-filter={f.key}
                aria-pressed={state.filter === f.key}
                onClick={() => dispatch({ type: "filter", filter: f.key })}
                className={`h-[30px] px-[11px] rounded-full text-[13px] font-medium whitespace-nowrap flex items-center gap-1.5 hover:text-[#f3ebde] ${state.filter === f.key ? "bg-[rgba(245,235,222,0.08)] text-[#f3ebde]" : "text-[#8f8579]"}`}
              >
                {f.label}
                <span className="text-[11.5px] text-dim tabular-nums">{matchingSlots(fr, f.key).length}</span>
              </button>
            ))}
          </div>
        )}
      </div>
      <div className="flex items-center gap-3.5 text-[12.5px] text-[#8f8579]">
        <span className="inline-flex items-center gap-[9px] whitespace-nowrap">
          Reviewed{" "}
          <span className="text-[#e8dfd2] tabular-nums font-medium" data-reviewed>
            {seen} / {total}
          </span>
          <span className="w-16 h-[3px] rounded-sm bg-[rgba(245,235,222,0.1)] overflow-hidden inline-block">
            <span className="block h-full bg-[#cabfb0]" style={{ width: `${total ? Math.round((seen / total) * 100) : 0}%` }} />
          </span>
        </span>
        <button
          onClick={() => dispatch({ type: "markAll", count: total })}
          className="text-dim underline underline-offset-[3px] decoration-[rgba(245,235,222,0.2)] whitespace-nowrap hover:text-[#f3ebde]"
        >
          Mark all reviewed
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------

function Stage({ fr, state, index, dispatch, version, regenRunning }: { fr: FilmReview; state: ReviewState; index: number; dispatch: (a: ReviewAction) => void; version: number; regenRunning: string | null }): React.ReactElement {
  const seq = state.mode === "sequence";
  const asset = seq ? fr.assets[fr.assetOf[index]] : fr.assets.find((a) => a.key === state.asset[fr.film])!;
  const frame = seq ? fr.frames[index] : fr.frames[asset.owner];
  const running = regenRunning !== null && regenRunning === regenKey(fr.frames[asset.owner]);
  const prev = stepAction(state, fr, -1);
  const next = stepAction(state, fr, 1);
  const long = fr.film === "long";
  const assetPos = fr.assets.indexOf(asset);

  return (
    <>
      <div className="relative flex items-center justify-center">
        <div
          data-stage={fr.film}
          className={`relative overflow-hidden rounded-[10px] bg-sidebar border border-[rgba(245,235,222,0.08)] shadow-[0_30px_80px_rgba(0,0,0,0.45)] ${long ? "w-full aspect-video" : "aspect-[9/16] h-[min(70vh,560px)] lg:h-[min(54vh,600px)]"}`}
          style={long ? { maxWidth: "calc(56vh * 16 / 9)" } : undefined}
        >
          <Still frame={frame} version={version} whole={!seq} className={`transition-[filter] duration-300 ${running ? "brightness-[0.62] saturate-[0.7]" : ""}`} />
          {seq && frame.motion && (
            <span className="absolute top-3.5 left-3.5 inline-flex items-center h-[22px] px-[9px] rounded bg-accent text-white text-[10px] font-bold tracking-[0.14em]">MOTION</span>
          )}
          {running && (
            <div className="absolute inset-x-0 bottom-0 px-[18px] py-4 bg-gradient-to-t from-[rgba(11,8,7,0.8)] to-transparent flex flex-col gap-2.5">
              <span className="text-[12.5px] text-[#f3ebde]">Regenerating {asset.id}… the current still stays until the new one is ready</span>
              <span className="relative h-0.5 rounded-sm bg-[rgba(245,235,222,0.15)] overflow-hidden">
                <span className="absolute inset-y-0 left-0 w-2/5 bg-accent animate-pulse" />
              </span>
            </div>
          )}
        </div>
      </div>
      <div className="flex items-center justify-center gap-4">
        <NavArrow dir={-1} action={prev} dispatch={dispatch} />
        <div className="min-w-[120px] text-center flex flex-col gap-0.5" data-counter>
          <span className="text-sm text-[#e8dfd2] tabular-nums font-medium">{seq ? `${index + 1} / ${fr.frames.length}` : `${assetPos + 1} / ${fr.assets.length}`}</span>
          <span className="text-[11px] text-dim">
            {seq ? `Slot ${slotLabel(frame, index)}${typeof frame.startSec === "number" ? ` · ${fmtTime(frame.startSec)}` : ""}` : `Asset ${asset.id}`}
          </span>
        </div>
        <NavArrow dir={1} action={next} dispatch={dispatch} />
      </div>
    </>
  );
}

function NavArrow({ dir, action, dispatch }: { dir: 1 | -1; action: ReviewAction | null; dispatch: (a: ReviewAction) => void }): React.ReactElement {
  return (
    <button
      onClick={() => action && dispatch(action)}
      disabled={!action}
      title={dir < 0 ? "Previous (←)" : "Next (→)"}
      aria-label={dir < 0 ? "Previous" : "Next"}
      className="w-[38px] h-[38px] rounded-full border border-[rgba(245,235,222,0.14)] text-[#cabfb0] grid place-items-center hover:border-[rgba(245,235,222,0.34)] hover:text-white disabled:opacity-30 disabled:cursor-not-allowed"
    >
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d={dir < 0 ? "M15 6l-6 6 6 6" : "M9 6l6 6-6 6"} />
      </svg>
    </button>
  );
}

// Above the strip: jump to the ends, and what the active filter is doing.
function StripBar({ fr, state, dispatch }: { fr: FilmReview; state: ReviewState; dispatch: (a: ReviewAction) => void }): React.ReactElement {
  const seq = state.mode === "sequence";
  const label = FILTERS.find((f) => f.key === state.filter)!.label;
  const matching = matchingSlots(fr, state.filter);
  const pos = matching.indexOf(state.index[fr.film]);
  const jump = "h-[26px] px-[9px] rounded-md text-xs text-[#8f8579] whitespace-nowrap hover:text-[#f3ebde] hover:bg-[rgba(245,235,222,0.05)]";
  return (
    <div className="flex items-center justify-between gap-3 mb-1.5">
      <div className="flex items-center gap-0.5">
        {seq ? (
          <>
            <button className={jump} onClick={() => dispatch({ type: "slot", index: matching[0] ?? 0 })}>
              Beginning
            </button>
            <button className={jump} onClick={() => dispatch({ type: "slot", index: matching[matching.length - 1] ?? fr.frames.length - 1 })}>
              End
            </button>
          </>
        ) : (
          <>
            <button className={jump} onClick={() => dispatch({ type: "asset", key: fr.assets[0].key })}>
              First asset
            </button>
            <button className={jump} onClick={() => dispatch({ type: "asset", key: fr.assets[fr.assets.length - 1].key })}>
              Last asset
            </button>
          </>
        )}
      </div>
      {seq && state.filter !== "all" && matching.length === 0 ? (
        <span className="text-[11.5px] text-[#cabfb0] whitespace-nowrap" data-no-match>
          No {label.toLowerCase()} slots in this film.{" "}
          <button onClick={() => dispatch({ type: "filter", filter: "all" })} className="underline underline-offset-[3px] text-[#f3ebde]">
            Show all
          </button>
        </span>
      ) : (
        <span className="text-[11.5px] text-[#6f6459] whitespace-nowrap overflow-hidden text-ellipsis">
          {!seq
            ? "← → to step through assets"
            : state.filter === "all"
              ? "← → to step through shots"
              : `${label}: ${pos >= 0 ? pos + 1 : "-"} of ${matching.length} · ← → steps through ${label.toLowerCase()} only`}
        </span>
      )}
    </div>
  );
}
