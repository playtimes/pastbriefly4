import React, { useEffect, useRef, useState } from "react";
import { api, mediaUrl } from "../api.ts";
import { navigate } from "../App.tsx";
import { FailedJobDetails } from "../failedJob.tsx";
import { STEP_ORDER, STEP_LABELS, type Job } from "../../types.ts";

export function Creating({ slug }: { slug: string }): React.ReactElement {
  const [job, setJob] = useState<Job | null>(null);
  const [error, setError] = useState("");
  const [continuing, setContinuing] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const jobId = useRef<string | null>(null);

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

  if (error) return <Fail slug={slug} message={error} />;
  if (job?.state === "failed")
    return <Fail slug={slug} job={job} onRetry={retry} retrying={retrying} />;
  if (!job) return <p className="text-muted">Preparing…</p>;

  if (job.state === "awaiting_preview" && job.preview) {
    const p = job.preview;
    return (
      <div className="flex flex-col gap-6">
        <div>
          <p className="kicker mb-1">One quick look</p>
          <h1 className="text-3xl">Visual direction</h1>
          <p className="text-muted mt-2">
            {p.moments} visual moments · {p.archive} archive · {p.reconstruction} reconstruction · {p.motionSelected} selected for motion
            {p.remainingMotionCost > 0 ? ` · est. remaining motion $${p.remainingMotionCost.toFixed(2)}` : ""}
          </p>
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3">
          {p.frames.map((f, i) => (
            <div key={i} className="surface overflow-hidden">
              <div className="relative aspect-video">
                <img src={mediaUrl(f.path)} alt="" className="w-full h-full object-cover" />
                {f.motion && <span className="absolute top-2 right-2 w-2 h-2 rounded-full bg-accent" title="motion" />}
              </div>
              <div className="px-2 py-1.5">
                <p className="text-[0.6rem] tracking-widest uppercase text-muted">{f.truth}</p>
                {f.caption && <p className="text-xs truncate">{f.caption}</p>}
              </div>
            </div>
          ))}
        </div>
        <div>
          <button onClick={cont} disabled={continuing} className="btn btn-primary text-lg">
            {continuing ? "Continuing…" : "Continue"}
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
          return (
            <li key={step} className="flex items-center gap-3">
              <span className={`w-5 h-5 rounded-full flex items-center justify-center text-[0.6rem] ${done ? "bg-accent text-[#f7f4ee]" : active ? "border-2 border-accent" : "border border-line"}`}>
                {done ? "✓" : ""}
              </span>
              <span className={active ? "text-ink" : done ? "text-muted" : "text-muted/60"}>{STEP_LABELS[step]}</span>
              {active && <Spinner />}
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

function Fail({ slug, message, job, onRetry, retrying }: { slug: string; message?: string; job?: Job; onRetry?: () => void; retrying?: boolean }): React.ReactElement {
  return (
    <div className="flex flex-col gap-4 max-w-lg">
      <h1 className="text-2xl">Something went wrong</h1>
      {job ? <FailedJobDetails job={job} /> : <p className="text-muted">{message}</p>}
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
