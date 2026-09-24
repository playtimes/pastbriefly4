import React, { useEffect, useRef, useState } from "react";
import { api } from "../api.ts";
import { navigate } from "../App.tsx";
import { FailedJobDetails, ApproveMoreResume, isBudgetFailure } from "../failedJob.tsx";
import { PreviewFrames } from "../previewFrames.tsx";
import { STEP_ORDER, STEP_LABELS, type Job } from "../../types.ts";

export function Creating({ slug }: { slug: string }): React.ReactElement {
  const [job, setJob] = useState<Job | null>(null);
  const [error, setError] = useState("");
  const [continuing, setContinuing] = useState(false);
  const [approvingText, setApprovingText] = useState(false);
  const [rebuilding, setRebuilding] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [maxSpend, setMaxSpend] = useState(0);
  const jobId = useRef<string | null>(null);

  useEffect(() => {
    api.config().then((c) => setMaxSpend(c.maxSpendUsd)).catch(() => {});
  }, []);

  useEffect(() => {
    let stop = false;
    async function tick(): Promise<void> {
      try {
        if (!jobId.current) {
          const detail = await api.story(slug);
          if (detail.activeJob) jobId.current = detail.activeJob.id;
          else if (detail.videos.length >= 2) return navigate(`/story/${slug}/watch`);
          else return navigate(`/story/${slug}`);
        }
        const { job } = await api.job(jobId.current!);
        if (stop) return;
        setJob(job);
        if (job.state === "done") return navigate(`/story/${slug}/watch`);
      } catch (e: any) {
        if (!stop) setError(e.message);
      }
    }
    tick();
    const t = setInterval(tick, 1500);
    return () => {
      stop = true;
      clearInterval(t);
    };
  }, [slug]);

  async function cont(): Promise<void> {
    if (!jobId.current) return;
    setContinuing(true);
    try {
      await api.continue(jobId.current);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setContinuing(false);
    }
  }

  // Approve the story text and resume; the job goes back to queued and the poll
  // loop above takes over the progress UI through to the visual preview gate.
  async function approveText(): Promise<void> {
    if (!jobId.current) return;
    setApprovingText(true);
    try {
      const { job } = await api.approveText(jobId.current);
      setJob(job);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setApprovingText(false);
    }
  }

  // Reject the previewed visuals and rebuild them under the same job. The job goes
  // back to queued, so the polling loop above takes over the progress UI.
  async function rebuild(): Promise<void> {
    if (!jobId.current) return;
    setRebuilding(true);
    try {
      const { job } = await api.rebuildVisuals(jobId.current);
      setJob(job);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setRebuilding(false);
    }
  }

  async function retry(): Promise<void> {
    if (!jobId.current) return;
    setRetrying(true);
    try {
      const { job } = await api.retry(jobId.current);
      setJob(job);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setRetrying(false);
    }
  }

  // Raise the approved max and resume; the job goes back to queued and the poll
  // loop above takes over the progress UI.
  async function approveMore(newApprovedMax: number): Promise<void> {
    if (!jobId.current) return;
    const { job } = await api.approveSpend(jobId.current, newApprovedMax);
    setJob(job);
  }

  if (error) return <Fail slug={slug} message={error} />;
  if (job?.state === "failed")
    return <Fail slug={slug} job={job} onRetry={retry} retrying={retrying} maxSpend={maxSpend} onApproveMore={approveMore} />;
  if (!job) return <p className="text-muted">Preparing…</p>;

  if (job.state === "awaiting_text" && job.review) {
    const r = job.review;
    return (
      <div className="flex flex-col gap-6 max-w-3xl">
        <div>
          <p className="kicker mb-1">Story review</p>
          <h1 className="text-3xl">{r.title}</h1>
          {r.hook && <p className="text-muted mt-2 text-lg">{r.hook}</p>}
          <p className="text-muted mt-3 text-sm">
            PB4 has completed its research and factual checks. Review whether the story is clear and interesting before media is generated.
          </p>
        </div>

        <section className="flex flex-col gap-2">
          <h2 className="text-xl">Story spine</h2>
          <ol className="flex flex-col gap-1.5">
            {r.moments.map((m, i) => (
              <li key={i} className="text-sm">
                <span className="font-semibold">{m.title}</span>
                <span className="text-muted"> - {m.detail}</span>
              </li>
            ))}
          </ol>
        </section>

        <details className="surface p-4">
          <summary className="cursor-pointer text-xl">Facts &amp; sources</summary>
          <ul className="mt-3 flex flex-col gap-2">
            {r.facts.map((f, i) => (
              <li key={i} className="text-sm">
                {f.fact}{" "}
                {f.sourceUrl ? (
                  <a href={f.sourceUrl} target="_blank" rel="noreferrer" className="text-accent underline">
                    {f.sourceTitle || "source"}
                  </a>
                ) : (
                  <span className="text-muted">({f.sourceTitle})</span>
                )}
              </li>
            ))}
            {r.facts.length === 0 && <li className="text-sm text-muted">No fact sheet was produced for this story.</li>}
          </ul>
        </details>

        <section className="flex flex-col gap-2">
          <h2 className="text-xl">Long script</h2>
          <p className="whitespace-pre-wrap text-sm leading-relaxed">{r.longScript}</p>
        </section>

        <section className="flex flex-col gap-2">
          <h2 className="text-xl">Short script</h2>
          <p className="whitespace-pre-wrap text-sm leading-relaxed">{r.shortScript}</p>
        </section>

        <div className="flex items-center gap-3">
          <button onClick={approveText} disabled={approvingText} className="btn btn-primary text-lg">
            {approvingText ? "Continuing…" : "Approve & continue"}
          </button>
        </div>
      </div>
    );
  }

  if (job.state === "awaiting_preview" && job.preview) {
    const p = job.preview;
    return (
      <div className="flex flex-col gap-6">
        <div>
          <p className="kicker mb-1">One quick look</p>
          <h1 className="text-3xl">Visual direction</h1>
          <p className="text-muted mt-2">
            {p.moments} slots
            {p.uniqueAssets !== undefined ? ` · ${p.uniqueAssets} unique assets · ${p.reusedPresentations ?? 0} reused presentations` : ""} · {p.archive} archive ·{" "}
            {p.reconstruction} reconstruction · {p.graphic} graphic · {p.motionSelected} selected for motion
            {p.remainingMotionCost > 0 ? ` · est. remaining motion $${p.remainingMotionCost.toFixed(2)}` : ""}
          </p>
        </div>
        <PreviewFrames frames={p.frames} />
        <div className="flex items-center gap-3">
          <button onClick={cont} disabled={continuing || rebuilding} className="btn btn-primary text-lg">
            {continuing ? "Continuing…" : "Continue"}
          </button>
          <button onClick={rebuild} disabled={continuing || rebuilding} className="btn btn-ghost text-lg">
            {rebuilding ? "Rebuilding…" : "Rebuild visuals"}
          </button>
        </div>
      </div>
    );
  }

  const currentIndex = STEP_ORDER.indexOf(job.step as any);
  return (
    <div className="flex flex-col gap-8 max-w-xl">
      <div>
        <p className="kicker mb-1">Creating your films</p>
        <h1 className="text-3xl">{STEP_LABELS[job.step]}…</h1>
        <p className="text-muted mt-2">You can leave this page and come back - it keeps working.</p>
      </div>
      <ol className="flex flex-col gap-3">
        {STEP_ORDER.map((step, i) => {
          const done = currentIndex > i || job.state === "done";
          const active = currentIndex === i;
          const prog = active ? job.progress : undefined;
          const pct = prog ? Math.round((prog.current / prog.total) * 100) : 0;
          return (
            <li key={step} className="flex flex-col gap-1.5">
              <div className="flex items-center gap-3">
                <span className={`w-5 h-5 rounded-full flex items-center justify-center text-[0.6rem] ${done ? "bg-accent text-[#f7f4ee]" : active ? "border-2 border-accent" : "border border-line"}`}>
                  {done ? "✓" : ""}
                </span>
                <span className={active ? "text-ink" : done ? "text-muted" : "text-muted/60"}>{STEP_LABELS[step]}</span>
                {active && !prog && <Spinner />}
                {prog && (
                  <span className="ml-auto text-[13px] tabular-nums text-muted">
                    {prog.current} / {prog.total} · {pct}%
                  </span>
                )}
              </div>
              {prog && (
                <div className="ml-8 h-1.5 overflow-hidden rounded-full bg-line">
                  <div className="h-full rounded-full bg-accent transition-[width] duration-500" style={{ width: `${pct}%` }} />
                </div>
              )}
            </li>
          );
        })}
      </ol>
    </div>
  );
}

function Spinner(): React.ReactElement {
  return <span className="w-3.5 h-3.5 border-2 border-accent border-t-transparent rounded-full animate-spin" />;
}

function Fail({ slug, message, job, onRetry, retrying, maxSpend, onApproveMore }: { slug: string; message?: string; job?: Job; onRetry?: () => void; retrying?: boolean; maxSpend?: number; onApproveMore?: (newApprovedMax: number) => Promise<void> }): React.ReactElement {
  return (
    <div className="flex flex-col gap-4 max-w-lg">
      <h1 className="text-2xl">Something went wrong</h1>
      {job ? <FailedJobDetails job={job} /> : <p className="text-muted">{message}</p>}
      {job && onApproveMore && maxSpend !== undefined && maxSpend > 0 && isBudgetFailure(job) && (
        <ApproveMoreResume job={job} maxSpendUsd={maxSpend} onApprove={onApproveMore} />
      )}
      <div className="flex items-center gap-3">
        {onRetry && (
          <button onClick={onRetry} disabled={retrying} className="btn btn-primary w-fit">
            {retrying ? "Retrying…" : "Retry"}
          </button>
        )}
        <button onClick={() => navigate(`/story/${slug}`)} className="btn btn-ghost w-fit">← Back to story</button>
      </div>
    </div>
  );
}
