// Create.reference.jsx
// -----------------------------------------------------------------------------
// Reference implementation of the redesigned PB4 Create page.
// This is a STARTING POINT, not drop-in production code. Every place that must
// touch real PB4 data/routes is marked with `// INTEGRATION:`.
//
// - No mock niches, no mock stories, no fake gradient artwork, no fake search state.
// - Reuse PB4's existing discovery layer, categories, routing, and Story page.
// - Tailwind arbitrary values are used here for clarity; prefer mapping the tokens
//   in README.md into tailwind.config and using named classes.
// -----------------------------------------------------------------------------

import { useState } from "react";
// INTEGRATION: import your real hooks/router, e.g.
// import { useDiscovery } from "@/hooks/useDiscovery";
// import { useNiches } from "@/hooks/useNiches";
// import { useNavigate } from "react-router-dom";

// ---- Sidebar icons (18px, 1.6 stroke) --------------------------------------
const IconCreate = (p) => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor"
       strokeWidth="1.6" strokeLinejoin="round" {...p}>
    <path d="M12 3l1.9 5.7L20 10.5l-6.1 1.8L12 18.5l-1.9-6.2L4 10.5l6.1-1.8z" />
  </svg>
);
const IconVideos = (p) => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor"
       strokeWidth="1.6" strokeLinejoin="round" {...p}>
    <rect x="3" y="5" width="18" height="14" rx="3.2" />
    <path d="M10.3 9.2l4.6 2.8-4.6 2.8z" fill="currentColor" stroke="none" />
  </svg>
);
const IconConfig = (p) => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor"
       strokeWidth="1.6" strokeLinecap="round" {...p}>
    <line x1="4" y1="8.5" x2="20" y2="8.5" /><line x1="4" y1="15.5" x2="20" y2="15.5" />
    <circle cx="10" cy="8.5" r="2.6" fill="#0b0807" /><circle cx="15" cy="15.5" r="2.6" fill="#0b0807" />
  </svg>
);

// NOTE: The sidebar almost certainly already exists in PB4 — restyle the real one
// with these classes rather than rendering this copy. Shown here for the visual spec.
function Sidebar() {
  const item = "flex items-center gap-[13px] px-[13px] py-[11px] rounded-[11px] text-[14.5px] font-medium transition-colors";
  return (
    <aside className="sticky top-0 self-start h-screen flex flex-col px-5 py-[30px] bg-[#0b0807] border-r border-[rgba(245,235,222,0.07)]">
      <div className="flex items-center gap-[11px] pt-0.5 px-1.5">
        <div className="w-[30px] h-[30px] rounded-lg bg-[#e50914] grid place-items-center font-serif text-[17px] text-white shadow-[0_4px_16px_rgba(229,9,20,0.35)]">PB</div>
        <div className="flex flex-col leading-none">
          <span className="font-serif text-[22px] text-[#f3ebde]">PastBriefly</span>
          <span className="text-[9.5px] tracking-[0.24em] text-[#7c7266] uppercase mt-1">Story Studio</span>
        </div>
      </div>
      <nav className="flex flex-col gap-1 mt-[38px]">
        {/* INTEGRATION: use your router links; keep exactly these three items. */}
        <a href="#" className={`${item} text-[#f7efe4] bg-[rgba(229,9,20,0.12)] shadow-[inset_2px_0_0_#e50914]`}><IconCreate /> Create</a>
        <a href="#" className={`${item} text-[#8f8579] hover:text-[#f3ebde] hover:bg-[rgba(245,235,222,0.04)]`}><IconVideos /> Videos</a>
        <a href="#" className={`${item} text-[#8f8579] hover:text-[#f3ebde] hover:bg-[rgba(245,235,222,0.04)]`}><IconConfig /> Config</a>
      </nav>
      {/* No footer. The mock's Archivist / Free workspace block is removed. */}
    </aside>
  );
}

// ---- Story result card ------------------------------------------------------
// story shape from YOUR discovery layer. Expected fields used: id, title, hook, thumbnailUrl.
function StoryCard({ story, onOpen }) {
  return (
    <article
      onClick={() => onOpen(story)}
      className="rounded-2xl overflow-hidden bg-[#14100e] border border-[rgba(245,235,222,0.08)] cursor-pointer transition-[transform,border-color] duration-[250ms] hover:-translate-y-1 hover:border-[rgba(245,235,222,0.2)]"
    >
      <div className="relative aspect-video bg-[#14100e]">
        {/* INTEGRATION: real story thumbnail. Solid fallback when absent — no fake gradients. */}
        {story.thumbnailUrl && (
          <img src={story.thumbnailUrl} alt="" className="absolute inset-0 w-full h-full object-cover" />
        )}
        <div className="absolute inset-0 shadow-[inset_0_-60px_60px_-30px_rgba(0,0,0,0.5)]" />
      </div>
      <div className="pt-[17px] px-[19px] pb-5">
        <h3 className="font-serif text-[21px] leading-[1.15] text-[#f4ecdf] line-clamp-2">{story.title}</h3>
        <p className="mt-[9px] text-[13.5px] leading-[1.45] text-[#968b7e] line-clamp-2">{story.hook}</p>
      </div>
    </article>
  );
}

// ---- Niche card (Trending / Popular / Recommended) --------------------------
// niche shape from YOUR data. Expected fields used: id, title, description.
function NicheCard({ niche, onPick }) {
  return (
    <button
      onClick={() => onPick(niche)}
      className="text-left flex flex-col min-h-[176px] pt-6 px-6 pb-5 rounded-[15px] bg-[#14100e] border border-[rgba(245,235,222,0.08)] transition-[transform,border-color,background] duration-[250ms] hover:-translate-y-[3px] hover:border-[rgba(229,9,20,0.4)] hover:bg-[#181310]"
    >
      <h3 className="font-serif text-[24px] leading-[1.12] text-[#f4ecdf] line-clamp-2">{niche.title}</h3>
      <p className="mt-[11px] text-[14px] leading-[1.5] text-[#968b7e] line-clamp-2">{niche.description}</p>
      <span className="mt-auto pt-4 flex items-center gap-[7px] text-[12px] tracking-[0.14em] uppercase font-semibold text-[#e50914]">
        Find stories <span className="text-[15px] leading-none">→</span>
      </span>
    </button>
  );
}

function NicheSection({ title, context, niches, onPick }) {
  return (
    <section className="mt-12">
      <div className="flex items-baseline justify-between gap-4 pb-[18px] border-b border-[rgba(245,235,222,0.08)]">
        <h2 className="font-serif text-[28px] leading-none text-[#f4ecdf]">{title}</h2>
        {context && <span className="text-[12.5px] text-[#7c7266]">{context}</span>}
      </div>
      <div className="mt-[22px] grid gap-[18px] [grid-template-columns:repeat(auto-fill,minmax(310px,1fr))]">
        {niches.map((n) => <NicheCard key={n.id} niche={n} onPick={onPick} />)}
      </div>
    </section>
  );
}

// ---- Page -------------------------------------------------------------------
export default function CreatePage() {
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("all"); // INTEGRATION: default to your real "all" value
  const [resultsMode, setResultsMode] = useState(null); // null | 'search' | 'niche'
  const [resultsLabel, setResultsLabel] = useState("");

  // INTEGRATION: replace with your real hooks.
  // const categories = useCategories();
  // const { trending, popular, recommended } = useNiches();
  // const { run: runDiscovery, stories, loading } = useDiscovery();
  // const navigate = useNavigate();
  const categories = [];        // INTEGRATION
  const trending = [];          // INTEGRATION
  const popular = [];           // INTEGRATION
  const recommended = [];       // INTEGRATION
  const stories = [];           // INTEGRATION: results from discovery
  const loading = false;        // INTEGRATION

  const runSearch = () => {
    const label = query.trim();
    setResultsMode("search");
    setResultsLabel(label);
    // INTEGRATION: real discovery from the manual prompt + category
    // runDiscovery({ query: label, category });
  };

  const pickNiche = (niche) => {
    // Do NOT modify `query` — leave the user's text untouched.
    setResultsMode("niche");
    setResultsLabel(niche.title);
    // INTEGRATION: real discovery for this niche directly
    // runDiscovery({ nicheId: niche.id });
  };

  const openStory = (story) => {
    // INTEGRATION: navigate to the existing Story page/route
    // navigate(`/story/${story.id}`);
  };

  const showResults = resultsMode !== null;
  const eyebrow = resultsMode === "niche" ? "Browsing niche" : "Search results";
  const heading =
    resultsMode === "niche"
      ? `Stories in ${resultsLabel}`
      : `Stories for ${resultsLabel || "your search"}`;

  return (
    <div className="min-h-screen grid grid-cols-[250px_minmax(0,1fr)] bg-[#0e0a09] text-[#f3ebde] font-sans">
      <Sidebar />

      <main className="px-[52px] pt-[46px] pb-20 overflow-x-hidden">
        <div className="max-w-[1220px] mx-auto">
          {/* Header */}
          <header className="max-w-[720px]">
            <h1 className="font-serif font-normal text-[52px] leading-none tracking-[-0.5px] text-[#f6efe4]">Create</h1>
            <p className="mt-[18px] text-[17.5px] leading-[1.5] text-[#a89e92] [text-wrap:pretty]">
              Hunt down the true stories from history that sound completely made up — the near-misses,
              the swindles and the escapes — and shape them into your next video.
            </p>
          </header>

          {/* Search row */}
          <section className="mt-[34px]">
            <div className="flex gap-3 flex-wrap items-stretch">
              <div className="relative flex-1 min-w-[280px] flex items-center">
                <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="#7c7266" strokeWidth="1.7"
                     strokeLinecap="round" className="absolute left-[22px] pointer-events-none">
                  <circle cx="11" cy="11" r="7" /><line x1="20" y1="20" x2="16" y2="16" />
                </svg>
                <input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") runSearch(); }}
                  placeholder={'Try "Cold War stories", "strange money scandals", "ancient disasters"…'}
                  className="w-full h-14 pl-[52px] pr-[22px] rounded-full bg-[#17110f] border border-[rgba(245,235,222,0.11)] text-[#f3ebde] text-[15.5px] placeholder:text-[#7c7266] outline-none focus:border-[rgba(229,9,20,0.55)] focus:bg-[#1b1512]"
                />
              </div>

              <div className="relative flex items-center">
                <select
                  value={category}
                  onChange={(e) => setCategory(e.target.value)}
                  className="appearance-none h-14 pl-5 pr-[46px] rounded-full bg-[#17110f] border border-[rgba(245,235,222,0.11)] text-[#cabfb0] text-[14.5px] min-w-[200px] cursor-pointer outline-none focus:border-[rgba(229,9,20,0.45)]"
                >
                  {/* INTEGRATION: render your REAL categories here */}
                  {categories.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
                </select>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#8f8579" strokeWidth="1.8"
                     strokeLinecap="round" strokeLinejoin="round" className="absolute right-5 pointer-events-none">
                  <path d="M6 9l6 6 6-6" />
                </svg>
              </div>

              <button
                onClick={runSearch}
                className="h-14 px-[34px] rounded-full bg-[#e50914] text-white text-[15px] font-semibold shadow-[0_8px_24px_rgba(229,9,20,0.28)] hover:bg-[#f5121d] hover:shadow-[0_10px_30px_rgba(229,9,20,0.4)] transition"
              >
                Search
              </button>
            </div>
          </section>

          {/* Shared results area */}
          {showResults && (
            <section className="mt-[52px] animate-[fadeUp_.5s_ease_both]">
              <div className="flex items-baseline gap-[14px] flex-wrap pb-5 border-b border-[rgba(245,235,222,0.08)]">
                <span className="text-[11px] tracking-[0.26em] uppercase font-semibold text-[#e50914]">{eyebrow}</span>
                <h2 className="font-serif text-[33px] leading-none text-[#f4ecdf]">{heading}</h2>
              </div>
              <div className="mt-[26px] grid gap-[22px] [grid-template-columns:repeat(auto-fill,minmax(290px,1fr))]">
                {/* INTEGRATION: real stories + loading/empty states */}
                {loading && <p className="text-[#968b7e]">Finding stories…</p>}
                {!loading && stories.length === 0 && <p className="text-[#968b7e]">No stories found. Try another prompt.</p>}
                {stories.map((s) => <StoryCard key={s.id} story={s} onOpen={openStory} />)}
              </div>
            </section>
          )}

          {/* Niche sections — INTEGRATION: real niche data */}
          <NicheSection title="Trending niches" context="This week across the archive" niches={trending} onPick={pickNiche} />
          <NicheSection title="Popular niches" context="Most made into videos" niches={popular} onPick={pickNiche} />
          <NicheSection title="Recommended for PastBriefly" context="Fits the channel’s voice" niches={recommended} onPick={pickNiche} />
        </div>
      </main>
    </div>
  );
}

// tailwind.config keyframes:
//   keyframes: { fadeUp: { from: { opacity: 0, transform: 'translateY(12px)' }, to: { opacity: 1, transform: 'none' } } }
