import React, { useEffect, useRef } from "react";
import { isOwnerFrame, matchesFilter, slotLabel, type FilmReview, type ReviewAction, type ReviewState } from "./model.ts";
import { LinkIcon, Still, TRUTH_LABEL, TRUTH_LETTER } from "./Still.tsx";

// The horizontal navigator: one thumbnail per edit slot in Sequence, one per
// asset in the asset inspector. The active thumbnail keeps itself in view.

const ACTIVE_RING = "0 0 0 2px #e50914";
const IDLE_RING = "0 0 0 1px rgba(245,235,222,0.08)";

export function Filmstrip({ fr, state, dispatch, version, children }: { fr: FilmReview; state: ReviewState; dispatch: (a: ReviewAction) => void; version: number; children?: React.ReactNode }): React.ReactElement {
  const box = useRef<HTMLDivElement>(null);
  const seq = state.mode === "sequence";
  const active = seq ? state.index[fr.film] : fr.assets.findIndex((a) => a.key === state.asset[fr.film]);
  const long = fr.film === "long";
  const w = long ? 84 : 46;
  const h = long ? 47 : 82;

  // Center the active thumbnail by scrolling the strip only (never the page).
  useEffect(() => {
    const el = box.current?.querySelector<HTMLElement>(`[data-strip="${active}"]`);
    if (!box.current || !el) return;
    const left = el.offsetLeft - box.current.offsetLeft - box.current.clientWidth / 2 + el.offsetWidth / 2;
    box.current.scrollTo?.({ left, behavior: "smooth" });
  }, [active, fr.film, state.mode, state.filter]);

  return (
    <div className="sticky bottom-0 lg:static z-10 bg-sidebar border-t border-[rgba(245,235,222,0.07)] px-4 lg:px-5 pt-2.5 pb-3 -mx-4 md:mx-0 md:rounded-b-lg">
      {children}
      <div ref={box} className="flex gap-1.5 overflow-x-auto pt-1 px-0.5 pb-1.5" data-filmstrip={seq ? "sequence" : "assets"}>
        {seq
          ? fr.frames.map((f, i) => {
              const current = i === active;
              const match = matchesFilter(fr, i, state.filter);
              const owner = isOwnerFrame(fr, i);
              const asset = fr.assets[fr.assetOf[i]];
              return (
                <button
                  key={i}
                  data-strip={i}
                  aria-current={current ? "true" : undefined}
                  onClick={() => dispatch({ type: "slot", index: i })}
                  title={`Slot ${slotLabel(f, i)} · ${asset.id}${owner ? "" : " (reuse)"} · ${TRUTH_LABEL[f.truth]}${f.motion ? " · motion" : ""}`}
                  className="flex-none flex flex-col gap-[5px] transition-opacity"
                  style={{ width: w, opacity: current ? 1 : !match ? 0.16 : owner ? 1 : 0.6 }}
                >
                  <span className="relative block overflow-hidden rounded bg-sidebar" style={{ width: w, height: h, boxShadow: current ? ACTIVE_RING : IDLE_RING }}>
                    <Still frame={f} version={version} />
                    {f.motion && <span data-motion-dot className="absolute top-1 right-1 w-[7px] h-[7px] rounded-full bg-accent shadow-[0_0_0_2px_rgba(11,8,7,0.7)]" />}
                  </span>
                  <span className={`flex items-center gap-1 text-[10.5px] leading-none tabular-nums font-semibold ${current ? "text-[#f3ebde]" : "text-[#8f8579]"}`}>
                    {slotLabel(f, i)}
                    <span className="font-medium text-[#6f6459]">{TRUTH_LETTER[f.truth]}</span>
                    {!owner && <span data-reuse-icon><LinkIcon size={10} color="#6f6459" /></span>}
                    {state.visited[fr.film].includes(i) && !current && <span className="text-[#7c7266] text-[9px]" title="Reviewed">✓</span>}
                  </span>
                  <span className="h-0.5 rounded-sm" style={{ background: current ? "#e50914" : "transparent" }} />
                </button>
              );
            })
          : fr.assets.map((a, i) => {
              const current = i === active;
              return (
                <button
                  key={a.key}
                  data-strip={i}
                  aria-current={current ? "true" : undefined}
                  onClick={() => dispatch({ type: "asset", key: a.key })}
                  title={`${a.id} · ${TRUTH_LABEL[a.truth]} · used ${a.uses.length}×`}
                  className="flex-none flex flex-col gap-[5px]"
                  style={{ width: w }}
                >
                  <span className="relative block overflow-hidden rounded bg-sidebar" style={{ width: w, height: h, boxShadow: current ? ACTIVE_RING : IDLE_RING }}>
                    <Still frame={fr.frames[a.owner]} version={version} whole />
                    {a.motion && <span data-motion-dot className="absolute top-1 right-1 w-[7px] h-[7px] rounded-full bg-accent" />}
                  </span>
                  <span className={`flex items-center justify-between text-[10.5px] leading-none font-semibold ${current ? "text-[#f3ebde]" : "text-[#8f8579]"}`}>
                    <span className="truncate">{a.id}</span>
                    <span className="font-medium text-[#6f6459]">×{a.uses.length}</span>
                  </span>
                  <span className="h-0.5 rounded-sm" style={{ background: current ? "#e50914" : "transparent" }} />
                </button>
              );
            })}
      </div>
    </div>
  );
}
