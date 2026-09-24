import React from "react";
import { mediaUrl } from "./api.ts";
import type { PreviewFrame } from "../types.ts";

// The visual preview frame grids: Long as landscape 16:9 cards, then Short as
// portrait 9:16 cards, so both films can be inspected before motion is approved.
// Each card names its media asset and presentation, so reuse is readable.
export function PreviewFrames({ frames }: { frames: PreviewFrame[] }): React.ReactElement {
  const sections = [
    { kind: "long" as const, title: "Long", aspect: "aspect-video", grid: "grid-cols-2 sm:grid-cols-3 md:grid-cols-4" },
    { kind: "short" as const, title: "Short", aspect: "aspect-[9/16]", grid: "grid-cols-3 sm:grid-cols-4 md:grid-cols-6" },
  ];
  return (
    <div className="flex flex-col gap-6">
      {sections.map((sec) => {
        const list = frames.filter((f) => (f.kind ?? "long") === sec.kind);
        if (list.length === 0) return null;
        return (
          <section key={sec.kind} data-film={sec.kind} className="flex flex-col gap-3">
            <h2 className="text-xl">{sec.title}</h2>
            <div className={`grid ${sec.grid} gap-3`}>
              {list.map((f, i) => (
                <div key={i} className="surface overflow-hidden">
                  <div className={`relative ${sec.aspect}`}>
                    <img src={mediaUrl(f.path)} alt="" className="w-full h-full object-cover" />
                    {f.motion && <span className="absolute top-2 right-2 w-2 h-2 rounded-full bg-accent" title="motion" />}
                  </div>
                  <div className="px-2 py-1.5">
                    <p className="text-[0.6rem] tracking-widest uppercase text-muted">{f.truth}</p>
                    {f.asset && (
                      <p className="text-xs">
                        asset: {f.asset}
                        {f.edit === "reuse" ? " (reused)" : ""}
                      </p>
                    )}
                    {f.presentation && <p className="text-xs text-muted">presentation: {f.presentation}</p>}
                    {f.focus && <p className="text-xs truncate" title={f.focus}>focus: {f.focus}</p>}
                    {f.motion && <p className="text-xs">motion selected</p>}
                    {f.caption && <p className="text-xs truncate">{f.caption}</p>}
                  </div>
                </div>
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}
