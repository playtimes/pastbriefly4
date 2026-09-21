import React, { useEffect, useMemo, useRef, useState } from "react";
import { api, mediaUrl } from "../api.ts";
import { navigate } from "../App.tsx";
import { CATEGORIES, type Story, type NicheGroup, type NichesResponse } from "../../types.ts";

// A restrained PB1 grade applied to card artwork: kept attractive and visible,
// just slightly desaturated and firmed up so it sits in the theme.
const GRADE = "[filter:saturate(0.92)_contrast(1.03)]";

type ResultsMode = null | "search" | "niche";

export function Create(): React.ReactElement {
  const [prompt, setPrompt] = useState("");
  const [category, setCategory] = useState("");
  const [results, setResults] = useState<Story[] | null>(null);
  const [note, setNote] = useState("");
  const [searching, setSearching] = useState(false);
  const [mode, setMode] = useState<ResultsMode>(null);
  const [label, setLabel] = useState("");
  const [niches, setNiches] = useState<NichesResponse | null>(null);
  const resultsRef = useRef<HTMLElement>(null);

  useEffect(() => {
    api.niches().then(setNiches).catch(() => setNiches(null));
  }, []);

  const canSearch = useMemo(() => prompt.trim().length > 0 || category !== "", [prompt, category]);

  // Shared discovery for all three entry points (manual prompt, category, niche
  // click). `resultsMode`/`resultsLabel` drive the shared Search Results header;
  // the niche path passes its own label and never touches the user's search box.
  async function runDiscovery(input: { prompt?: string; category?: string }, resultsMode: "search" | "niche", resultsLabel: string): Promise<void> {
    if (!input.prompt?.trim() && !input.category) return;
    setSearching(true);
    setNote("");
    setMode(resultsMode);
    setLabel(resultsLabel);
    try {
      const r = await api.discover({ prompt: input.prompt?.trim() || undefined, category: input.category || undefined, niche: resultsMode === "niche" });
      setResults(r.stories.filter((s) => !s.hasVideos));
      setNote(r.note);
    } catch (e: any) {
      setNote(e.message || "Discovery failed.");
      setResults([]);
    } finally {
      setSearching(false);
      requestAnimationFrame(() => resultsRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }));
    }
  }

  function onSearch(): void {
    if (!canSearch) return;
    runDiscovery({ prompt, category }, "search", prompt.trim() || category);
  }

  // A niche card is an editorial suggestion: run discovery for it internally and
  // show the results in the shared section. The user's manual query stays as-is.
  function onNiche(name: string): void {
    runDiscovery({ prompt: name }, "niche", name);
  }

  const eyebrow = mode === "niche" ? "Browsing niche" : "Search results";
  const heading = mode === "niche" ? `Stories in ${label}` : `Stories for ${label || "your search"}`;

  return (
    <div className="max-w-[1220px]">
      <header className="max-w-[720px]">
        <h1 className="text-[40px] md:text-[52px] leading-none tracking-[-0.5px] text-ink">Create</h1>
        <p className="mt-[18px] text-[17.5px] leading-[1.5] text-muted [text-wrap:pretty]">
          Hunt down the true stories from history that sound completely made up - the near-misses, the swindles and the
          escapes - and shape them into your next video.
        </p>
      </header>

      {/* Discovery control: one rounded search with a category select. */}
      <section className="mt-[34px] flex gap-3 flex-wrap items-stretch">
        <div className="relative flex-1 min-w-[280px] flex items-center">
          <svg
            width="19"
            height="19"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.7"
            strokeLinecap="round"
            className="absolute left-[22px] pointer-events-none text-dim"
          >
            <circle cx="11" cy="11" r="7" />
            <line x1="20" y1="20" x2="16" y2="16" />
          </svg>
          <input
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && onSearch()}
            placeholder={'Try "Cold War stories", "strange money scandals", "ancient disasters"…'}
            className="w-full h-14 pl-[52px] pr-[22px] rounded-full bg-field border border-line text-ink text-[15.5px] placeholder:text-dim outline-none transition focus:border-accent/55 focus:bg-[#1b1512]"
          />
        </div>

        <div className="relative flex items-center">
          <select
            value={category}
            onChange={(e) => setCategory(e.target.value)}
            className="appearance-none h-14 pl-5 pr-[46px] rounded-full bg-field border border-line text-[#cabfb0] text-[14.5px] min-w-[200px] cursor-pointer outline-none transition focus:border-accent/45"
          >
            <option value="">All categories</option>
            {CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="absolute right-5 pointer-events-none text-dim"
          >
            <path d="M6 9l6 6 6-6" />
          </svg>
        </div>

        <button
          onClick={onSearch}
          disabled={!canSearch || searching}
          className="h-14 px-[34px] rounded-full bg-accent text-white text-[15px] font-semibold shadow-[0_8px_24px_rgba(229,9,20,0.28)] transition hover:bg-accent-hover hover:shadow-[0_10px_30px_rgba(229,9,20,0.4)] disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {searching ? "Searching…" : "Search"}
        </button>
      </section>

      {/* Shared results area - appears after a manual search or a niche click. */}
      {mode !== null && (
        <section ref={resultsRef} className="mt-[52px] scroll-mt-8">
          <div className="flex items-start justify-between gap-5 flex-wrap pb-[18px] border-b border-line">
            <div>
              <span className="text-[11px] tracking-[0.26em] uppercase font-semibold text-accent">{eyebrow}</span>
              <h2 className="mt-2 text-[33px] leading-[1.05] text-ink">{heading}</h2>
              {note && <p className="mt-[9px] text-[13.5px] text-faint">{note}</p>}
            </div>
            {!searching && (
              <button
                onClick={() => { setResults(null); setNote(""); setMode(null); }}
                className="flex-none inline-flex items-center gap-[7px] text-[13.5px] text-dim hover:text-accent"
              >
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                  <path d="M6 6l12 12M18 6L6 18" />
                </svg>
                Clear
              </button>
            )}
          </div>
          <div className="mt-[22px]">
            {searching ? (
              <p className="text-faint text-sm">Finding stories…</p>
            ) : results && results.length ? (
              <StoryGrid stories={results} />
            ) : (
              <p className="text-faint text-sm">No stories found. Try another prompt.</p>
            )}
          </div>
        </section>
      )}

      {/* Real-data niches. Each group is honest about its freshness / availability. */}
      <NicheSection label="Trending niches" context="What's drawing interest now" group={niches?.trending} onPick={onNiche} className="mt-[56px]" />
      <NicheSection label="Popular niches" context="Sustained audience interest" group={niches?.popular} onPick={onNiche} className="mt-12" />
      <NicheSection label="Recommended for PastBriefly" context="Fits the channel's voice" group={niches?.recommended} onPick={onNiche} className="mt-12" />
    </div>
  );
}

function StoryGrid({ stories }: { stories: Story[] }): React.ReactElement {
  return (
    <div className="grid gap-[14px] [grid-template-columns:repeat(auto-fill,minmax(430px,1fr))]">
      {stories.map((s) => (
        <button
          key={s.id}
          onClick={() => navigate(`/story/${s.slug}`)}
          className="flex gap-[18px] text-left p-3 rounded-[14px] border border-transparent cursor-pointer transition duration-200 hover:bg-panel hover:border-line"
        >
          <div className="relative flex-none w-[190px] aspect-[3/2] rounded-[11px] overflow-hidden bg-panel">
            {s.heroImage ? (
              <img
                src={mediaUrl(s.heroImage)}
                alt=""
                className={`absolute inset-0 w-full h-full object-cover ${GRADE}`}
              />
            ) : null}
            <div className="absolute inset-0 bg-[linear-gradient(105deg,rgba(8,5,4,0.55),rgba(8,5,4,0.08)_70%)]" />
          </div>
          <div className="flex-1 min-w-0 flex flex-col justify-center pr-1.5">
            <div className="text-[10.5px] tracking-[0.19em] uppercase font-semibold text-dim">
              {s.category} · {s.year}
            </div>
            <h3 className="mt-[9px] font-serif text-[23px] leading-[1.14] text-ink line-clamp-3">{s.title}</h3>
            <p className="mt-2 text-[13.5px] leading-[1.45] text-faint line-clamp-2">{s.hook}</p>
          </div>
        </button>
      ))}
    </div>
  );
}

function NicheSection({
  label,
  context,
  group,
  onPick,
  className = "",
}: {
  label: string;
  context: string;
  group: NicheGroup | undefined;
  onPick: (name: string) => void;
  className?: string;
}): React.ReactElement {
  return (
    <section className={className}>
      <div className="flex items-baseline justify-between gap-4 pb-[18px] border-b border-line">
        <h2 className="text-[28px] leading-none text-ink">{label}</h2>
        <span className="text-[12.5px] text-dim">
          {group?.available && group.updatedAt ? `Updated ${timeAgo(group.updatedAt)}` : context}
        </span>
      </div>
      {!group ? (
        <p className="mt-[22px] text-faint text-sm">Loading…</p>
      ) : !group.available ? (
        <p className="mt-[22px] text-faint text-sm max-w-2xl">{group.note}</p>
      ) : group.niches.length === 0 ? (
        <p className="mt-[22px] text-faint text-sm">Nothing to show right now.</p>
      ) : (
        <div className="mt-[22px] grid gap-[18px] [grid-template-columns:repeat(auto-fill,minmax(310px,1fr))]">
          {group.niches.map((n) => (
            <button
              key={n.name}
              onClick={() => onPick(n.name)}
              className="text-left flex flex-col min-h-[176px] pt-6 px-6 pb-5 rounded-[15px] bg-panel border border-line transition duration-[250ms] hover:-translate-y-[3px] hover:border-accent/40 hover:bg-[#181310]"
            >
              <h3 className="text-[24px] leading-[1.12] text-ink line-clamp-2">{n.name}</h3>
              {n.why && <p className="mt-[11px] text-[14px] leading-[1.5] text-faint line-clamp-2">{n.why}</p>}
              <span className="mt-auto pt-4 flex items-center gap-[7px] text-[12px] tracking-[0.14em] uppercase font-semibold text-accent">
                Find stories <span className="text-[15px] leading-none">→</span>
              </span>
            </button>
          ))}
        </div>
      )}
    </section>
  );
}

function timeAgo(iso: string): string {
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms) || ms < 0) return "just now";
  const min = Math.floor(ms / 60000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const d = Math.floor(hr / 24);
  return `${d}d ago`;
}
