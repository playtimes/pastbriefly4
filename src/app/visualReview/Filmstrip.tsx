import React, { useEffect, useRef } from "react";
import { slotLabel, type FilmReview, type ReviewAction } from "./model.ts";
import { Still } from "./Still.tsx";

// The neighbouring visuals: one thumbnail per slot, in film order. The current
// one keeps itself in view.

const ACTIVE_RING = "0 0 0 2px #e50914";
const IDLE_RING = "0 0 0 1px rgba(245,235,222,0.08)";

export function Filmstrip({ fr, index, dispatch, version }: { fr: FilmReview; index: number; dispatch: (a: ReviewAction) => void; version: number }): React.ReactElement {
  const box = useRef<HTMLDivElement>(null);
  const long = fr.film === "long";
  const w = long ? 84 : 46;
  const h = long ? 47 : 82;

  // Center the current thumbnail by scrolling the strip only (never the page).
  useEffect(() => {
    const el = box.current?.querySelector<HTMLElement>(`[data-strip="${index}"]`);
    if (!box.current || !el) return;
    const left = el.offsetLeft - box.current.offsetLeft - box.current.clientWidth / 2 + el.offsetWidth / 2;
    box.current.scrollTo?.({ left, behavior: "smooth" });
  }, [index, fr.film]);

  return (
    <div className="sticky bottom-0 lg:static z-10 bg-sidebar border-t border-[rgba(245,235,222,0.07)] px-4 lg:px-5 pt-3 pb-3 -mx-4 md:mx-0 md:rounded-b-lg">
      <div ref={box} className="flex gap-1.5 overflow-x-auto pt-1 px-0.5 pb-1.5" data-filmstrip={fr.film}>
        {fr.frames.map((f, i) => {
          const current = i === index;
          return (
            <button
              key={i}
              data-strip={i}
              aria-current={current ? "true" : undefined}
              onClick={() => dispatch({ type: "slot", index: i })}
              title={`Slot ${slotLabel(f, i)}`}
              className="flex-none flex flex-col gap-[5px]"
              style={{ width: w, opacity: current ? 1 : 0.75 }}
            >
              <span className="relative block overflow-hidden rounded bg-sidebar" style={{ width: w, height: h, boxShadow: current ? ACTIVE_RING : IDLE_RING }}>
                <Still frame={f} version={version} />
              </span>
              <span className={`text-[10.5px] leading-none tabular-nums font-semibold ${current ? "text-[#f3ebde]" : "text-[#8f8579]"}`}>{slotLabel(f, i)}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
