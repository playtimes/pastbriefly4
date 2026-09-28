import React from "react";
import { canRegenerate, type Film, type FilmReview, type ReviewAction } from "./model.ts";
import { Still, TRUTH_LABEL } from "./Still.tsx";
import type { AssetQaState, DirectorQaRun, DirectorQaRuns, VisualAutopilotState } from "../../types.ts";

type AssetQaResult = Extract<AssetQaState, { status: "done" }>;

// Beside the Asset QA result: where each film's Director QA stands, with a jump
// to that film's existing Director board, and why the Visual Autopilot could not
// approve when its approval failed. The detail stays on the Director boards.
export function VisualQaSummary({ runs, pilot, dispatch }: { runs?: DirectorQaRuns; pilot?: VisualAutopilotState; dispatch: (a: ReviewAction) => void }): React.ReactElement | null {
  const rows = (["long", "short"] as const)
    .map((film) => ({ film, run: runs?.[film] }))
    .filter((r): r is { film: Film; run: Exclude<DirectorQaRun, { status: "running" }> } => !!r.run && r.run.status !== "running");
  const failed = pilot?.status === "failed" ? pilot.error : null;
  if (!rows.length && !failed) return null;
  const state = (run: Exclude<DirectorQaRun, { status: "running" }>) =>
    run.status === "complete" ? (run.humanReview.length ? `Needs human review: ${run.humanReview.length}` : run.clean ? "Clean" : "Complete, not clean") : run.status === "failed" ? "Failed" : "Interrupted";
  const open = (film: Film) => {
    dispatch({ type: "film", film });
    dispatch({ type: "mode", mode: "director" });
  };
  return (
    <div aria-label="Visual QA" className="pt-3 flex flex-col gap-1.5 text-[13px]">
      {failed && (
        <p role="alert" className="m-0 rounded-lg border border-accent bg-accent/15 px-4 py-2 text-ink">
          Visual QA passed, but the automatic approval could not continue: {failed} Continue remains available.
        </p>
      )}
      {rows.length > 0 && (
        <p className="m-0 flex flex-wrap gap-x-5 gap-y-1 text-[#8f8579]">
          {rows.map(({ film, run }) => (
            <span key={film} data-visual-qa={film}>
              <span className="uppercase tracking-[0.14em] text-[11px] font-semibold text-[#cabfb0]">{film === "long" ? "Long" : "Short"} Director QA</span> {state(run)}{" "}
              <button onClick={() => open(film)} className="underline underline-offset-[3px] text-[#f3ebde]">
                Open board
              </button>
            </span>
          ))}
        </p>
      )}
    </div>
  );
}

// The result of Pixel Asset QA at the top of Visual Review: one quiet line when
// every current still passed, else the assets that still need a person, each
// with its thumbnail and a jump to the existing asset view (where Regenerate
// still lives, when it is legal). Nothing else about the review changes.
export function AssetQaNotice({ qa, films, version, dispatch }: { qa: AssetQaResult; films: Record<Film, FilmReview>; version: number; dispatch: (a: ReviewAction) => void }): React.ReactElement {
  const open = (film: Film, key: string) => {
    dispatch({ type: "film", film });
    dispatch({ type: "asset", key });
  };
  if (!qa.issues.length && !qa.incomplete) {
    return (
      <p aria-label="Asset QA" className="pt-3 text-[13px] text-[#8f8579]">
        {qa.message}
        {qa.regenerated > 0 && ` ${qa.regenerated} still${qa.regenerated === 1 ? " was" : "s were"} regenerated and verified.`}
      </p>
    );
  }
  return (
    <section role="alert" aria-label="Asset QA" className="mt-3 max-h-[34vh] overflow-y-auto flex flex-col gap-2 rounded-lg border border-accent bg-accent/15 px-4 py-3 text-[14px] text-ink">
      <strong className="kicker text-ink">Asset QA needs you</strong>
      <span className="font-medium">{qa.message}</span>
      <ul className="flex flex-col gap-2">
        {qa.issues.map((i) => {
          const fr = films[i.kind];
          const asset = fr.assets.find((a) => a.id === i.assetId);
          const frame = asset ? fr.frames[asset.owner] : undefined;
          return (
            <li key={`${i.kind}-${i.assetId}`} data-asset-qa={`${i.kind}-${i.assetId}`} className="flex items-start gap-3">
              {frame && (
                <span className={`relative flex-none overflow-hidden rounded bg-sidebar ${i.kind === "long" ? "w-20 aspect-video" : "w-10 aspect-[9/16]"}`}>
                  <Still frame={frame} version={version} whole />
                </span>
              )}
              <span className="flex-1 min-w-0 flex flex-col gap-0.5">
                <span>
                  <span className="font-medium">{i.assetId}</span>
                  <span className="text-muted"> · {i.kind === "long" ? "Long" : "Short"} · {TRUTH_LABEL[i.truth]}{i.incomplete ? " · review incomplete" : ""}</span>
                </span>
                <span className="[text-wrap:pretty]">{i.reason}</span>
                {asset && (
                  <span className="flex items-center gap-3 text-[13px]">
                    <button onClick={() => open(i.kind, asset.key)} className="underline underline-offset-[3px] text-[#f3ebde]">
                      View asset
                    </button>
                    {frame && canRegenerate(frame) && <span className="text-muted">Regenerate still is available in the asset view.</span>}
                  </span>
                )}
              </span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
