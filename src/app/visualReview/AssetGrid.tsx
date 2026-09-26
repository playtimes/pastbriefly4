import React from "react";
import type { FilmReview, ReviewAction } from "./model.ts";
import { Still, TRUTH_LABEL } from "./Still.tsx";

// Every unique owner asset of the film, once, image first. A card opens the asset
// in the inspector.
export function AssetGrid({ fr, dispatch, version }: { fr: FilmReview; dispatch: (a: ReviewAction) => void; version: number }): React.ReactElement {
  const long = fr.film === "long";
  return (
    <div className="py-4" data-asset-grid={fr.film}>
      <div className="flex items-baseline justify-between gap-4 flex-wrap mb-5">
        <h2 className="m-0 text-[28px] leading-none text-ink">
          {fr.assets.length} unique {long ? "Long" : "Short"} asset{fr.assets.length === 1 ? "" : "s"}
        </h2>
        <span className="text-[13px] text-dim">Each still shown once. Open one to inspect it.</span>
      </div>
      <div className={`grid gap-x-5 gap-y-[26px] ${long ? "grid-cols-2 lg:grid-cols-[repeat(auto-fill,minmax(240px,1fr))]" : "grid-cols-2 sm:grid-cols-3 lg:grid-cols-[repeat(auto-fill,minmax(160px,1fr))]"}`}>
        {fr.assets.map((a) => (
          <button key={a.key} data-asset-card={a.id} onClick={() => dispatch({ type: "asset", key: a.key })} className="flex flex-col gap-[11px] text-left transition-transform hover:-translate-y-0.5">
            <span className={`relative block w-full overflow-hidden rounded-lg border border-[rgba(245,235,222,0.08)] bg-sidebar ${long ? "aspect-video" : "aspect-[9/16]"}`}>
              <Still frame={fr.frames[a.owner]} version={version} whole />
            </span>
            <span className="flex items-baseline justify-between gap-2.5">
              <span className="font-serif text-[22px] leading-none text-ink truncate">{a.id}</span>
              <span className="text-xs text-[#8f8579] whitespace-nowrap">
                Used in {a.uses.length} slot{a.uses.length === 1 ? "" : "s"}
              </span>
            </span>
            <span className="flex items-center gap-2.5 flex-wrap -mt-1 text-[10.5px] tracking-[0.14em] uppercase text-dim">
              <span>{TRUTH_LABEL[a.truth]}</span>
              {a.motion && (
                <span className="inline-flex items-center gap-[5px] text-[#e8dfd2]">
                  <span className="w-[5px] h-[5px] rounded-full bg-accent" />
                  Motion
                </span>
              )}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}
