import React, { useState } from "react";
import { STEP_ORDER, STEP_LABELS, type Job } from "../types.ts";

// True when a job failed because the next paid call would have passed its
// approved maximum. The budget guard is the only source of this wording.
export function isBudgetFailure(job: Job): boolean {
  return job.state === "failed" && /approved maximum/i.test(job.error || "");
}

const ADD_OPTIONS = [1, 2, 3];
const round2 = (n: number): number => Math.round(n * 100) / 100;

// Approve a little more budget for a job that stopped at the approved maximum and
// resume the SAME job. Only an increase is offered, capped at the ceiling.
export function ApproveMoreResume({
  job,
  maxSpendUsd,
  onApprove,
}: {
  job: Job;
  maxSpendUsd: number;
  onApprove: (newApprovedMax: number) => Promise<void>;
}): React.ReactElement {
  const headroom = round2(Math.max(0, maxSpendUsd - job.approvedMax));
  const presets = ADD_OPTIONS.filter((n) => n <= headroom + 1e-9);
  const options = presets.length ? presets : [headroom];
  const [add, setAdd] = useState(options[0]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  if (headroom <= 0) {
    return <p className="text-[13px] text-muted">Already at the spend ceiling of ${maxSpendUsd.toFixed(2)}; it cannot be increased.</p>;
  }

  const newMax = round2(job.approvedMax + add);

  async function approve(): Promise<void> {
    setBusy(true);
    setErr("");
    try {
      await onApprove(newMax);
    } catch (e: any) {
      setErr(e.message || "Could not approve additional spend.");
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-3 border-t border-line pt-3">
      <p className="text-[13px] leading-[1.5] text-muted">
        Generation stopped because the next paid step would pass the approved maximum. Approve a little more to resume the same job.
      </p>
      <div className="flex items-center gap-2">
        {options.map((n) => (
          <button
            key={n}
            onClick={() => setAdd(n)}
            className={`btn ${add === n ? "btn-primary" : "btn-ghost"} px-3 py-1.5 text-sm`}
          >
            +${n.toFixed(2)}
          </button>
        ))}
      </div>
      <dl className="flex flex-col gap-1 text-[13px]">
        <SpendRow label="Tracked spend (est.)" value={job.spent} />
        <SpendRow label="Current approved maximum" value={job.approvedMax} />
        <SpendRow label="New approved maximum" value={newMax} strong />
      </dl>
      {err && <p className="text-[13px] leading-[1.5] text-red-400">{err}</p>}
      <button onClick={approve} disabled={busy} className="btn btn-primary w-fit">
        {busy ? "Resuming…" : "Approve more & resume"}
      </button>
    </div>
  );
}

// Shared read-out for a failed job: which steps completed, where it failed, the
// error, and tracked spend (a conservative estimate, not a provider invoice) vs.
// the approved max. Uses only values already on the job.
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
        <SpendRow label="Tracked spend (est.)" value={job.spent} strong />
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
