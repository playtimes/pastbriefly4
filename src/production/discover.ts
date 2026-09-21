import { config } from "../server/config.ts";
import { listStories } from "../server/store.ts";
import { findStories } from "./research.ts";
import type { Story } from "../types.ts";

// The Create dashboard's unified discovery: a prompt and/or a category. In live
// mode this runs web research to find new true stories; in mock mode it searches
// the curated library. Either way it returns real Story records to display.

export interface DiscoverInput {
  prompt?: string;
  category?: string | null;
  // A niche-card click discovers NEW stories for that niche only. A plain search
  // (manual prompt or category) also folds in relevant existing library matches.
  niche?: boolean;
}

export interface DiscoverResult {
  stories: Story[];
  note: string;
}

export function composeDiscoveryQuery(input: DiscoverInput): string {
  return [input.prompt?.trim(), input.category?.trim()].filter(Boolean).join(" ").trim();
}

// Relevant existing library stories. `strict` (niche mode) requires a real term
// match so an unrelated niche can't fall back to the whole library.
function matchStories(stories: Story[], input: DiscoverInput, strict: boolean): Story[] {
  const cat = input.category?.trim();
  const terms = (input.prompt ?? "").toLowerCase().split(/\s+/).filter((t) => t.length > 2);
  return stories.filter((s) => {
    if (cat && s.category !== cat) return false;
    if (!terms.length) return !strict;
    const hay = `${s.title} ${s.hook} ${s.summary} ${s.category}`.toLowerCase();
    return terms.some((t) => hay.includes(t));
  });
}

function dedupeById(stories: Story[]): Story[] {
  const seen = new Set<string>();
  const out: Story[] = [];
  for (const s of stories) {
    if (seen.has(s.id)) continue;
    seen.add(s.id);
    out.push(s);
  }
  return out;
}

export async function discover(input: DiscoverInput): Promise<DiscoverResult> {
  if (config.mode === "live") {
    const r = await findStories(composeDiscoveryQuery(input));
    const all = listStories();
    const added = all.filter((s) => r.added.includes(s.title));

    // A niche click asks for NEW stories in that niche: return only what was just
    // discovered, never loose matches from the existing library.
    if (input.niche) return { stories: added, note: r.note };

    // Manual search / category: newly discovered first, then relevant existing
    // matches, de-duplicated.
    return { stories: dedupeById([...added, ...matchStories(all, input, false)]), note: r.note };
  }

  // Mock mode: no real web discovery. Return niche-relevant curated matches so the
  // UI has something to show - deterministic and never the whole library for a
  // niche, so unrelated niches don't collapse to the same fallback set.
  const note = input.niche
    ? "Mock mode: showing niche-relevant stories from your curated library. Switch to Live in Config to discover new stories from the web."
    : "Showing matches from your curated library. Add an OpenAI key and switch to Live in Config to discover new stories from the web.";
  return { stories: matchStories(listStories(), input, !!input.niche), note };
}
