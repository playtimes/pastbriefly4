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
}

export interface DiscoverResult {
  stories: Story[];
  note: string;
}

export function composeDiscoveryQuery(input: DiscoverInput): string {
  return [input.prompt?.trim(), input.category?.trim()].filter(Boolean).join(" ").trim();
}

function matchStories(stories: Story[], input: DiscoverInput): Story[] {
  const cat = input.category?.trim();
  const terms = (input.prompt ?? "").toLowerCase().split(/\s+/).filter((t) => t.length > 2);
  return stories.filter((s) => {
    if (cat && s.category !== cat) return false;
    if (!terms.length) return true;
    const hay = `${s.title} ${s.hook} ${s.summary} ${s.category}`.toLowerCase();
    return terms.some((t) => hay.includes(t));
  });
}

export async function discover(input: DiscoverInput): Promise<DiscoverResult> {
  let note = "";
  let addedTitles: string[] = [];

  if (config.mode === "live") {
    const r = await findStories(composeDiscoveryQuery(input));
    note = r.note;
    addedTitles = r.added;
  } else {
    note = "Showing matches from your curated library. Add an OpenAI key and switch to Live in Config to discover new stories from the web.";
  }

  const all = listStories();
  const added = all.filter((s) => addedTitles.includes(s.title));
  const matched = matchStories(all, input);

  // Newly discovered stories first, then existing matches, de-duplicated.
  const seen = new Set<string>();
  const stories: Story[] = [];
  for (const s of [...added, ...matched]) {
    if (seen.has(s.id)) continue;
    seen.add(s.id);
    stories.push(s);
  }
  return { stories, note };
}
