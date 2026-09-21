import React from "react";
import { STEP_ORDER, STEP_LABELS, type Job } from "../types.ts";

// Shared read-out for a failed job: which steps completed, where it failed, the
// error, and actual spend vs. approved max. Uses only values already on the job.
export function FailedJobDetails({ job }: { job: Job }): React.ReactElement {
  const failedIndex = STEP_ORDER.indexOf(job.step); // -1 for queued/preview/etc.
  return (
    <div className="flex flex-col gap-4">
      {failedIndex >= 0 ? (
        <ol className="flex flex-col gap-2">
          {STEP_ORDER.map((step, i) => {
            const status = i < failedIndex ? "done" : i === failedIndex ? "failed" : "pending";
            return (
              <li key={step} className="flex flex-col gap-1">
                <div className="flex items-center gap-2.5">
                  <span
                    className={`w-5 h-5 rounded-full flex items-center justify-center text-[0.6rem] ${
                      status === "done"
                        ? "bg-accent text-[#f7f4ee]"
                        : status === "failed"
                          ? "border-2 border-red-400 text-red-400"
                          : "border border-line"
                    }`}
                  >
                    {status === "done" ? "✓" : status === "failed" ? "✕" : ""}
                  </span>
                  <span className={status === "failed" ? "text-red-400" : status === "done" ? "text-muted" : "text-muted/60"}>
                    {STEP_LABELS[step]}
                    {status === "failed" ? " - failed here" : ""}
                  </span>
                </div>
                {status === "failed" && <p className="pl-[30px] text-[13px] leading-[1.5] text-red-400 [text-wrap:pretty]">{job.error || "Generation failed."}</p>}
              </li>
            );
          })}
        </ol>
      ) : (
        <p className="text-[13px] leading-[1.5] text-red-400 [text-wrap:pretty]">{job.error || "Generation failed."}</p>
      )}

      <dl className="flex flex-col gap-1 border-t border-line pt-3 text-[13px]">
        <SpendRow label="Spent so far" value={job.spent} strong />
        <SpendRow label="Approved maximum" value={job.approvedMax} />
        <SpendRow label="Estimated total" value={job.estimatedCost} />
      </dl>
    </div>
  );
}

function SpendRow({ label, value, strong }: { label: string; value: number; strong?: boolean }): React.ReactElement {
  return (
    <div className="flex justify-between">
      <dt className="text-muted">{label}</dt>
      <dd className={strong ? "font-semibold text-ink" : "text-muted"}>${value.toFixed(2)}</dd>
    </div>
  );
}
