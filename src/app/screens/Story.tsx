import React, { useEffect, useState } from "react";
import { api, type StoryDetail } from "../api.ts";
import { navigate } from "../App.tsx";
import { FailedJobDetails, ApproveMoreResume, isBudgetFailure } from "../failedJob.tsx";

export function Story({ slug }: { slug: string }): React.ReactElement {
  const [detail, setDetail] = useState<StoryDetail | null>(null);
  const [error, setError] = useState("");
  const [showCost, setShowCost] = useState(false);
  const [mode, setMode] = useState("mock");
  const [maxSpend, setMaxSpend] = useState(0);
  const [sourcesOpen, setSourcesOpen] = useState(false);
  const [rechecking, setRechecking] = useState(false);
  const [recheckMsg, setRecheckMsg] = useState("");
  const [saved, setSaved] = useState(false);
  const [savingBusy, setSavingBusy] = useState(false);
  const [retrying, setRetrying] = useState(false);

  useEffect(() => {
    api.story(slug).then((d) => {
      setDetail(d);
      setSaved(!!d.story.saved);
    }).catch((e) => setError(e.message));
    api.config().then((c) => {
      setMode(c.mode);
      setMaxSpend(c.maxSpendUsd);
    });
  }, [slug]);

  async function toggleSaved(storyId: string): Promise<void> {
    const next = !saved;
    setSavingBusy(true);
    setSaved(next); // optimistic
    try {
      await api.setSaved(storyId, next);
    } catch {
      setSaved(!next); // revert on failure
    } finally {
      setSavingBusy(false);
    }
  }

  async function recheck(storyId: string): Promise<void> {
    setRechecking(true);
    setRecheckMsg("");
    try {
      const r = await api.recheck(storyId);
      if (r.verdict === "rewrite") {
        setDetail(await api.story(slug));
        setRecheckMsg("Corrected with more defensible facts.");
      } else if (r.verdict === "supported") {
        setRecheckMsg("Checked - the story holds up.");
      } else {
        setRecheckMsg(r.reason || "This story could not be verified.");
      }
    } catch (e: any) {
      setRecheckMsg(e.message || "Recheck failed.");
    } finally {
      setRechecking(false);
    }
  }

  async function retry(jobId: string): Promise<void> {
    setRetrying(true);
    try {
      await api.retry(jobId);
      navigate(`/story/${slug}/creating`);
    } catch (e: any) {
      setError(e.message);
      setRetrying(false);
    }
  }

  async function approveMore(jobId: string, newApprovedMax: number): Promise<void> {
    await api.approveSpend(jobId, newApprovedMax);
    navigate(`/story/${slug}/creating`);
  }

  if (error) return <Back message={error} />;
  if (!detail) return <p className="text-muted">Loading…</p>;

  const { story, videos, activeJob, failedJob } = detail;
  const busy = activeJob && activeJob.state !== "done" && activeJob.state !== "failed";
  const hasFilms = videos.length >= 2;
  const paragraphs = story.summary.split(/\n\n+/).map((p) => p.trim()).filter(Boolean);

  return (
    <div className="max-w-[1180px]">
      {/* Quiet return to the discovery page. */}
      <button onClick={() => navigate("/")} className="inline-flex items-center gap-2 text-[13.5px] text-[#8f8579] transition hover:text-accent">
        <span className="text-[15px] leading-none">←</span> Back to Create
      </button>

      {/* A clean dark cinematic hero. The story title and hook carry it; a subtle
          bottom gradient adds depth. */}
      <section className="relative mt-4 flex items-end overflow-hidden rounded-[20px] border border-line bg-[#140c09] min-h-[360px] md:min-h-[452px]">
        <div className="absolute inset-0 bg-[linear-gradient(to_top,rgba(8,5,4,0.55),transparent_70%)]" />
        <div className="relative max-w-[840px] px-6 py-9 md:px-[46px] md:py-[44px]">
          <div className="flex flex-wrap items-center gap-[10px] text-[11.5px] font-semibold uppercase tracking-[0.22em]">
            <span className="text-accent">{story.category}</span>
            {story.year && (
              <>
                <span className="text-[#6f6459]">·</span>
                <span className="tracking-[0.16em] text-[#cbb8a2]">{story.year}</span>
              </>
            )}
            {story.place && (
              <>
                <span className="text-[#6f6459]">·</span>
                <span className="tracking-[0.16em] text-[#cbb8a2]">{story.place}</span>
              </>
            )}
          </div>
          <h1 className="mt-4 font-serif text-[34px] md:text-[50px] leading-[1.04] tracking-[-0.4px] text-[#f7f0e5] [text-wrap:balance]">{story.title}</h1>
          {story.hook && <p className="mt-[18px] max-w-[600px] font-serif italic text-[19px] md:text-[21px] leading-[1.4] text-[#e7ddcf]">“{story.hook}”</p>}
        </div>
      </section>

      <div className="mt-11 grid items-start gap-10 lg:gap-[46px] [grid-template-columns:1fr] lg:[grid-template-columns:minmax(0,1fr)_328px]">
        {/* Story column: readable width, comfortable spacing. */}
        <div>
          <div className="text-[11px] font-semibold uppercase tracking-[0.24em] text-accent">The story</div>
          <div className="mt-4 max-w-[660px]">
            {paragraphs.map((p, i) => (
              <p key={i} className="mb-[18px] text-[16.5px] leading-[1.72] text-[#c8bcad] [text-wrap:pretty]">{p}</p>
            ))}
          </div>

          <div className="mt-11">
            <div className="flex items-baseline justify-between gap-4 border-b border-line pb-[18px]">
              <h2 className="font-serif text-[26px] md:text-[28px] leading-none text-ink">Story moments</h2>
              <span className="text-[12.5px] text-dim">The beats that carry the film</span>
            </div>
            <div className="mt-2">
              {story.moments.map((m, i) => (
                <div key={i} className="grid gap-5 md:gap-[22px] py-[26px] border-b border-line [grid-template-columns:44px_minmax(0,1fr)] md:[grid-template-columns:64px_minmax(0,1fr)]">
                  <div className="font-serif text-[28px] md:text-[34px] leading-none text-accent">{String(i + 1).padStart(2, "0")}</div>
                  <div>
                    <h3 className="font-serif text-[21px] md:text-[23px] leading-[1.2] text-[#f2e9db]">{m.title}</h3>
                    <p className="mt-[10px] max-w-[600px] text-[15px] leading-[1.65] text-[#9c9184] [text-wrap:pretty]">{m.detail}</p>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* Make-the-film panel + visual direction, sticky beside the story. */}
        <aside className="flex flex-col gap-[22px] lg:sticky lg:top-6">
          <div className="rounded-[18px] border border-line bg-[#16110f] p-6">
            <div className="text-[11px] font-semibold uppercase tracking-[0.2em] text-dim">Make the film</div>
            {busy ? (
              <button
                onClick={() => navigate(`/story/${slug}/creating`)}
                className="mt-4 flex h-[54px] w-full items-center justify-center rounded-full border border-line text-[14px] font-medium text-[#cabfb0] transition hover:border-[rgba(245,235,222,0.32)] hover:text-ink"
              >
                Generation in progress →
              </button>
            ) : failedJob ? (
              <div className="mt-4 flex flex-col gap-4">
                <p className="text-[14px] font-semibold text-red-400">Last generation failed</p>
                <FailedJobDetails job={failedJob} />
                {maxSpend > 0 && isBudgetFailure(failedJob) && (
                  <ApproveMoreResume job={failedJob} maxSpendUsd={maxSpend} onApprove={(m) => approveMore(failedJob.id, m)} />
                )}
                <button
                  onClick={() => retry(failedJob.id)}
                  disabled={retrying}
                  className="h-[54px] w-full rounded-full bg-accent text-[15px] font-semibold text-white shadow-[0_8px_24px_rgba(229,9,20,0.3)] transition hover:bg-accent-hover hover:shadow-[0_10px_30px_rgba(229,9,20,0.42)] disabled:opacity-60"
                >
                  {retrying ? "Retrying…" : "Retry"}
                </button>
              </div>
            ) : hasFilms ? (
              <>
                <button
                  onClick={() => navigate(`/story/${slug}/watch`)}
                  className="mt-4 flex h-[54px] w-full items-center justify-center gap-[9px] rounded-full bg-accent text-[15px] font-semibold text-white shadow-[0_8px_24px_rgba(229,9,20,0.3)] transition hover:bg-accent-hover hover:shadow-[0_10px_30px_rgba(229,9,20,0.42)]"
                >
                  <svg width="17" height="17" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5.5v13l11-6.5z" /></svg>
                  Watch films
                </button>
                <button
                  onClick={() => setShowCost(true)}
                  className="mt-[10px] h-[46px] w-full rounded-full border border-line text-[14px] font-medium text-[#cabfb0] transition hover:border-[rgba(245,235,222,0.32)] hover:text-ink"
                >
                  Generate again
                </button>
              </>
            ) : (
              <>
                <button
                  onClick={() => setShowCost(true)}
                  className="mt-4 h-[54px] w-full rounded-full bg-accent text-[15px] font-semibold text-white shadow-[0_8px_24px_rgba(229,9,20,0.3)] transition hover:bg-accent-hover hover:shadow-[0_10px_30px_rgba(229,9,20,0.42)]"
                >
                  Generate Short + Long
                </button>
                <p className="mt-[14px] text-[12.5px] leading-[1.5] text-dim">Creates a short cut and a long-form documentary edit from this story.</p>
              </>
            )}
          </div>

          {story.productionNote && (
            <div className="border-t border-line pt-5">
              <div className="text-[11px] font-semibold uppercase tracking-[0.2em] text-accent">Visual direction</div>
              <p className="mt-3 text-[14px] leading-[1.6] text-muted [text-wrap:pretty]">{story.productionNote}</p>
            </div>
          )}

          {/* Save the story to the Stories page so it survives a refresh. */}
          <div className="border-t border-line pt-5">
            <button
              onClick={() => toggleSaved(story.id)}
              disabled={savingBusy}
              className="inline-flex items-center gap-2 text-[13px] text-dim transition hover:text-accent disabled:opacity-50"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill={saved ? "currentColor" : "none"} stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
                <path d="M6 4h12v16l-6-4-6 4z" />
              </svg>
              {saved ? "Saved" : "Save story"}
            </button>
          </div>

          {/* Quietly re-verify the saved facts before committing to a film. */}
          <div className="border-t border-line pt-5">
            <button
              onClick={() => recheck(story.id)}
              disabled={rechecking}
              className="inline-flex items-center gap-2 text-[13px] text-dim transition hover:text-accent disabled:opacity-50"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 12a9 9 0 1 1-2.64-6.36" /><path d="M21 4v5h-5" />
              </svg>
              {rechecking ? "Rechecking…" : "Recheck story"}
            </button>
            {recheckMsg && <p className="mt-[10px] text-[12.5px] leading-[1.5] text-muted [text-wrap:pretty]">{recheckMsg}</p>}
          </div>
        </aside>
      </div>

      {/* Sources stay quiet and collapsed until asked for. */}
      {story.sources.length > 0 && (
        <section className="mt-[52px] max-w-[760px]">
          <button
            onClick={() => setSourcesOpen((v) => !v)}
            className="flex w-full items-center justify-between gap-3 border-t border-line py-5 text-[#cabfb0] transition hover:text-ink"
          >
            <span className="flex items-baseline gap-[9px] text-[15px]">
              Sources <span className="text-[13px] text-dim">({story.sources.length})</span>
            </span>
            <span className="inline-flex text-[#8f8579] transition-transform duration-[250ms]" style={{ transform: sourcesOpen ? "rotate(180deg)" : "none" }}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M6 9l6 6 6-6" /></svg>
            </span>
          </button>
          {sourcesOpen && (
            <div className="pb-2">
              {story.sources.map((s, i) => (
                <a
                  key={i}
                  href={s.url}
                  target="_blank"
                  rel="noreferrer"
                  className="group flex items-baseline gap-[14px] border-b border-line py-[13px]"
                >
                  <span className="min-w-[20px] text-[12px] tabular-nums text-[#6f6459]">{i + 1}</span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-[14.5px] leading-[1.4] text-[#cabfb0] group-hover:text-ink">{s.title}</span>
                    {s.note && <span className="mt-[3px] block text-[12.5px] text-dim">{s.note}</span>}
                  </span>
                  <span className="text-[#5f554b] group-hover:text-muted">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M7 17L17 7" /><path d="M8 7h9v9" /></svg>
                  </span>
                </a>
              ))}
            </div>
          )}
        </section>
      )}

      {showCost && <CostDialog detail={detail} slug={slug} mode={mode} onClose={() => setShowCost(false)} />}
    </div>
  );
}

function CostDialog({ detail, slug, mode, onClose }: { detail: StoryDetail; slug: string; mode: string; onClose: () => void }): React.ReactElement {
  const { story, estimate } = detail;
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  async function approve(): Promise<void> {
    setSubmitting(true);
    setError("");
    try {
      const max = Math.max(estimate.total, 0.01);
      await api.generate(story.id, Math.ceil(max * 100) / 100);
      navigate(`/story/${slug}/creating`);
    } catch (e: any) {
      setError(e.message);
      setSubmitting(false);
    }
  }

  return (
    <div className="fixed inset-0 z-30 bg-black/70 flex items-center justify-center p-4" onClick={onClose}>
      <div className="surface p-6 max-w-md w-full" onClick={(e) => e.stopPropagation()}>
        <p className="kicker mb-1">Before we start</p>
        <h3 className="text-2xl mb-4">Estimated cost</h3>
        <div className="flex flex-col gap-2">
          {estimate.lines.map((l, i) => (
            <div key={i} className="flex justify-between text-sm">
              <span className="text-muted">{l.label}{l.detail ? ` · ${l.detail}` : ""}</span>
              <span>${l.usd.toFixed(2)}</span>
            </div>
          ))}
          <div className="border-t border-line mt-2 pt-2 flex justify-between font-semibold">
            <span>Estimated total</span>
            <span>${estimate.total.toFixed(2)}</span>
          </div>
        </div>
        <p className="text-muted text-xs mt-3">
          {mode === "mock"
            ? "Local mode: this runs offline and free. The figures show the live-equivalent cost."
            : "You approve this as the maximum spend. No paid work runs before you approve."}
        </p>
        {error && <p className="text-red-400 text-sm mt-3">{error}</p>}
        <div className="flex gap-3 mt-5">
          <button onClick={onClose} className="btn btn-ghost flex-1">Cancel</button>
          <button onClick={approve} disabled={submitting} className="btn btn-primary flex-1">
            {submitting ? "Starting…" : "Approve & Generate"}
          </button>
        </div>
      </div>
    </div>
  );
}

function Back({ message }: { message: string }): React.ReactElement {
  return (
    <div className="flex flex-col gap-4">
      <p className="text-muted">{message}</p>
      <button onClick={() => navigate("/")} className="btn btn-ghost w-fit">← All stories</button>
    </div>
  );
}
