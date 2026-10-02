import React, { useEffect, useReducer, useRef } from "react";
import { buildFilm, fmtTime, initialReview, regenKey, reviewReducer, slotLabel, stepAction, type Film, type FilmReview, type ReviewAction, type ReviewState } from "./model.ts";
import { ShotPanel, type RegenProps } from "./Inspector.tsx";
import { Filmstrip } from "./Filmstrip.tsx";
import { Still } from "./Still.tsx";
import { ChangeVisualForm, useSequenceRevise, type ReviseSequence } from "./changeVisual.tsx";
import type { VisualPreview } from "../../types.ts";

// The film view: look through the Long or the Short slot by slot, with the
// neighbouring visuals in a strip, and make the same two creative changes the
// issue view offers (Regenerate image, Change visual). Opened from an issue it
// starts on that issue's slot. Navigation is local UI state only.

export interface VisualReviewProps extends RegenProps {
  preview: VisualPreview;
  version: number; // image cache-bust after a regeneration
  onBack: () => void;
  backLabel?: string;
  target?: { film: Film; index?: number }; // where to open
  onReviseSequence?: ReviseSequence;
  busy?: boolean; // a visual change is already running
}

export function VisualReview(props: VisualReviewProps): React.ReactElement {
  const [state, dispatch] = useReducer(reviewReducer, props.preview, (p) => {
    let s = initialReview(p);
    if (props.target) s = reviewReducer(s, { type: "film", film: props.target.film });
    if (props.target?.index !== undefined) s = reviewReducer(s, { type: "slot", index: props.target.index });
    return s;
  });
  const films = { long: buildFilm(props.preview, "long"), short: buildFilm(props.preview, "short") };
  const fr = films[state.film];

  // Left/Right step through the slots. Typing in a field, or a modified key, is
  // never hijacked.
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
  const index = Math.min(state.index[state.film], Math.max(0, fr.frames.length - 1));
  const frame = fr.frames[index];
  const regen: RegenProps = { onRegenerate: props.onRegenerate, regen: { ...props.regen, blocked: props.regen.blocked || props.busy }, draft: props.draft, onDraft: props.onDraft };
  const back = props.backLabel || "Back";

  return (
    <div className="flex flex-col gap-4" data-review-film={state.film}>
      <header className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3 pb-4 border-b border-[rgba(245,235,222,0.07)]">
        <button onClick={props.onBack} className="inline-flex items-center gap-2 text-[13px] text-[#cabfb0] hover:text-accent">
          <span aria-hidden="true">←</span> {back}
        </button>
        <div className="inline-flex p-1 rounded-full bg-[#15100e] border border-[rgba(245,235,222,0.09)]">
          {/* A Long-first job's preview has no Short: no empty Short tab. */}
          {(["long", "short"] as const).filter((k) => k === "long" || films.short.frames.length > 0).map((k) => (
            <button
              key={k}
              data-film-tab={k}
              aria-pressed={state.film === k}
              onClick={() => dispatch({ type: "film", film: k })}
              className={`rounded-full font-semibold whitespace-nowrap h-[34px] px-[18px] text-[13.5px] ${state.film === k ? "bg-accent text-white" : "text-[#8f8579] hover:text-[#f3ebde]"}`}
            >
              {k === "long" ? "Long documentary" : "Short"}
            </button>
          ))}
        </div>
      </header>
      {!frame ? (
        <p className="py-16 text-center text-dim">This film has no visuals yet.</p>
      ) : (
        <>
          <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_320px] gap-[22px] lg:gap-10">
            <div className="min-w-0 flex flex-col gap-3">
              <Stage fr={fr} index={index} state={state} dispatch={dispatch} version={version} regenRunning={props.regen.running} />
            </div>
            <aside className="min-w-0">
              <ShotPanel fr={fr} index={index} {...regen}>
                <ChangeVisualControl key={fr.film} film={fr.film} prefill={`Slot ${slotLabel(frame, index)}: `} onReviseSequence={props.onReviseSequence} busy={!!props.busy || props.regen.running !== null} />
              </ShotPanel>
            </aside>
          </div>
          <Filmstrip fr={fr} index={index} dispatch={dispatch} version={version} />
        </>
      )}
    </div>
  );
}

// Change visual for the film on screen, started from the current slot.
function ChangeVisualControl({ film, prefill, onReviseSequence, busy }: { film: Film; prefill: string; onReviseSequence?: ReviseSequence; busy: boolean }): React.ReactElement | null {
  const revise = useSequenceRevise(film, onReviseSequence, busy);
  if (!revise) return null;
  return (
    <div className="flex flex-col gap-3 pt-4 border-t border-line">
      {!revise.open && (
        <button onClick={() => revise.onOpen(prefill)} disabled={revise.running} data-action="change-visual" className="w-fit inline-flex items-center gap-2 h-9 px-4 rounded-full border border-[rgba(245,235,222,0.18)] text-[13px] font-medium text-[#e8dfd2] hover:border-[rgba(245,235,222,0.36)] hover:text-white disabled:opacity-50 disabled:cursor-not-allowed">
          Change visual
        </button>
      )}
      <ChangeVisualForm revise={revise} film={film} />
    </div>
  );
}

function Stage({ fr, index, state, dispatch, version, regenRunning }: { fr: FilmReview; index: number; state: ReviewState; dispatch: (a: ReviewAction) => void; version: number; regenRunning: string | null }): React.ReactElement {
  const frame = fr.frames[index];
  const asset = fr.assets[fr.assetOf[index]];
  const running = regenRunning !== null && regenRunning === regenKey(fr.frames[asset.owner]);
  const long = fr.film === "long";
  return (
    <>
      <div className="relative flex items-center justify-center">
        <div
          data-stage={fr.film}
          className={`relative overflow-hidden rounded-[10px] bg-sidebar border border-[rgba(245,235,222,0.08)] shadow-[0_30px_80px_rgba(0,0,0,0.45)] ${long ? "w-full aspect-video" : "aspect-[9/16] h-[min(70vh,560px)] lg:h-[min(54vh,600px)]"}`}
          style={long ? { maxWidth: "calc(56vh * 16 / 9)" } : undefined}
        >
          <Still frame={frame} version={version} className={`transition-[filter] duration-300 ${running ? "brightness-[0.62] saturate-[0.7]" : ""}`} />
          {running && (
            <div className="absolute inset-x-0 bottom-0 px-[18px] py-4 bg-gradient-to-t from-[rgba(11,8,7,0.8)] to-transparent flex flex-col gap-2.5">
              <span className="text-[12.5px] text-[#f3ebde]">Regenerating… the current image stays until the new one is ready</span>
              <span className="relative h-0.5 rounded-sm bg-[rgba(245,235,222,0.15)] overflow-hidden">
                <span className="absolute inset-y-0 left-0 w-2/5 bg-accent animate-pulse" />
              </span>
            </div>
          )}
        </div>
      </div>
      <div className="flex items-center justify-center gap-4">
        <NavArrow dir={-1} action={stepAction(state, fr, -1)} dispatch={dispatch} />
        <div className="min-w-[120px] text-center flex flex-col gap-0.5" data-counter>
          <span className="text-sm text-[#e8dfd2] tabular-nums font-medium">
            {index + 1} / {fr.frames.length}
          </span>
          <span className="text-[11px] text-dim">
            Slot {slotLabel(frame, index)}
            {typeof frame.startSec === "number" ? ` · ${fmtTime(frame.startSec)}` : ""}
          </span>
        </div>
        <NavArrow dir={1} action={stepAction(state, fr, 1)} dispatch={dispatch} />
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
