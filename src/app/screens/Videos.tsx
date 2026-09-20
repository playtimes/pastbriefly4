import React, { useEffect, useState } from "react";
import { api, mediaUrl, type StoryDetail } from "../api.ts";
import { navigate } from "../App.tsx";
import type { Video, VideoKind } from "../../types.ts";

function fmtDuration(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

function fmtDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

export function Videos({ slug }: { slug: string }): React.ReactElement {
  const [detail, setDetail] = useState<StoryDetail | null>(null);
  const [tab, setTab] = useState<VideoKind>("long");
  const [published, setPublished] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [sourcesOpen, setSourcesOpen] = useState(false);

  useEffect(() => {
    api.story(slug).then((d) => {
      setDetail(d);
      setPublished(!!d.story.published);
    });
  }, [slug]);

  async function togglePublished(): Promise<void> {
    setPublishing(true);
    try {
      const r = await api.setPublished(detail!.story.id, !published);
      setPublished(!!r.story.published);
    } finally {
      setPublishing(false);
    }
  }

  if (!detail) return <p className="text-muted">Loading…</p>;
  const { story, videos } = detail;

  // Videos are newest-first; the latest job's pair is current, the rest are previous renders.
  const byJob = new Map<string, Video[]>();
  for (const v of videos) {
    if (!byJob.has(v.jobId)) byJob.set(v.jobId, []);
    byJob.get(v.jobId)!.push(v);
  }
  const jobs = [...byJob.values()];
  const current = jobs[0] ?? [];
  const previous = jobs.slice(1);
  const active = current.find((v) => v.kind === tab);

  if (!current.length) {
    return (
      <div className="flex flex-col gap-4">
        <p className="text-muted">No films yet for this story.</p>
        <button onClick={() => navigate(`/story/${slug}`)} className="btn btn-ghost w-fit">← Back to story</button>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-[1040px]">
      {/* Story back-link, a quiet Generated status, and the secondary Publish action. */}
      <div className="flex flex-wrap items-start justify-between gap-5">
        <div>
          <button onClick={() => navigate(`/story/${slug}`)} className="inline-flex items-center gap-2 text-[14px] text-[#cabfb0] transition hover:text-accent">
            <span className="text-[15px] leading-none">←</span> {story.title}
          </button>
          <div className="mt-[9px] flex items-center gap-2 pl-[2px]">
            <span className={`h-[6px] w-[6px] rounded-full ${published ? "bg-accent" : "bg-[#5aa06a]"}`} />
            <span className="text-[11.5px] uppercase tracking-[0.16em] text-dim">{published ? "Published" : "Generated"}</span>
          </div>
        </div>
        <button
          onClick={togglePublished}
          disabled={publishing}
          className="inline-flex h-11 items-center gap-[9px] rounded-full border border-[rgba(245,235,222,0.18)] px-[22px] text-[14px] font-medium text-[#e8dfd2] transition hover:border-[rgba(245,235,222,0.36)] hover:text-white disabled:opacity-50"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M12 16V4" /><path d="M7 9l5-5 5 5" /><path d="M5 20h14" /></svg>
          {publishing ? "…" : published ? "Unpublish" : "Publish"}
        </button>
      </div>

      {/* Centered Long / Short switch. */}
      <div className="mt-[26px] flex justify-center">
        <div className="inline-flex rounded-full border border-line bg-[#15100e] p-[5px]">
          {(["long", "short"] as VideoKind[]).map((k) => (
            <button
              key={k}
              onClick={() => setTab(k)}
              className={`h-10 rounded-full px-[22px] text-[14px] font-semibold transition ${
                tab === k ? "bg-accent text-white" : "text-[#8f8579] hover:text-ink"
              }`}
            >
              {k === "long" ? "Long documentary" : "Short"}
            </button>
          ))}
        </div>
      </div>

      {/* Real player: Long stays 16:9, Short displays as a true centered 9:16. */}
      {active && (
        <>
          <div className="mt-[30px]">
            {active.kind === "short" ? (
              <div className="flex justify-center">
                <video
                  key={active.id}
                  src={mediaUrl(active.path)}
                  controls
                  className="aspect-[9/16] w-[360px] max-w-full rounded-[20px] border border-line bg-black object-contain"
                />
              </div>
            ) : (
              <video
                key={active.id}
                src={mediaUrl(active.path)}
                controls
                className="aspect-video w-full rounded-[16px] border border-line bg-black object-contain"
              />
            )}
          </div>

          {/* Resolution + duration metadata, with the Download action. */}
          <div className="mt-[22px] flex flex-wrap items-center justify-center gap-[18px]">
            <div className="flex items-center gap-4 text-[13px] text-[#8f8579]">
              <span className="tabular-nums">{active.width} × {active.height}</span>
              <span className="h-[3px] w-[3px] rounded-full bg-[#5f554b]" />
              <span className="tabular-nums">{fmtDuration(active.durationSec)}</span>
            </div>
            <a
              href={mediaUrl(active.path)}
              download
              className="inline-flex h-10 items-center gap-2 rounded-full border border-[rgba(245,235,222,0.16)] px-[18px] text-[13.5px] font-medium text-[#cabfb0] transition hover:border-[rgba(245,235,222,0.34)] hover:text-ink"
            >
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M12 4v11" /><path d="M7 10l5 5 5-5" /><path d="M5 20h14" /></svg>
              Download
            </a>
          </div>
        </>
      )}

      {/* Sources stay quiet and collapsed until asked for. */}
      {story.sources.length > 0 && (
        <section className="mt-[42px] mx-auto max-w-[760px]">
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
                  <span className="min-w-[18px] text-[12px] tabular-nums text-[#6f6459]">{i + 1}</span>
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

      {/* Previous versions: real earlier renders, opened via the existing links. */}
      {previous.length > 0 && (
        <section className="mt-10">
          <div className="flex items-baseline justify-between gap-4 border-b border-line pb-4">
            <h2 className="font-serif text-[24px] leading-none text-ink">Previous versions</h2>
            <span className="text-[12.5px] text-dim">Earlier renders of this film</span>
          </div>
          <div className="mt-[10px]">
            {previous.map((group, i) => {
              const long = group.find((v) => v.kind === "long");
              const short = group.find((v) => v.kind === "short");
              const rendered = group[0] ? fmtDate(group[0].createdAt) : "";
              const cuts = [
                long && `Long ${fmtDuration(long.durationSec)}`,
                short && `Short ${fmtDuration(short.durationSec)}`,
              ].filter(Boolean).join(" · ");
              return (
                <div key={i} className="flex items-center gap-[18px] border-b border-line py-4">
                  <div className="min-w-0 flex-1">
                    <div className="text-[15px] font-medium text-[#e8dfd2]">Version {jobs.length - 1 - i}</div>
                    {cuts && <div className="mt-[3px] text-[12.5px] text-[#8f8579]">{cuts}</div>}
                  </div>
                  {rendered && <div className="whitespace-nowrap text-[12.5px] text-dim">Rendered {rendered}</div>}
                  <div className="flex gap-3">
                    {long && (
                      <a href={mediaUrl(long.path)} target="_blank" rel="noreferrer" className="text-[13px] font-semibold text-[#8f8579] transition hover:text-accent">
                        Long ↗
                      </a>
                    )}
                    {short && (
                      <a href={mediaUrl(short.path)} target="_blank" rel="noreferrer" className="text-[13px] font-semibold text-[#8f8579] transition hover:text-accent">
                        Short ↗
                      </a>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      )}
    </div>
  );
}
