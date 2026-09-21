import { config } from "../server/config.ts";
import { respondJson } from "../providers/openai.ts";
import { readNiche, writeNiche } from "../server/store.ts";
import { fetchHistorySignals, type YtSignal } from "./youtube.ts";
import type { NicheGroup, NicheItem, NichesResponse } from "../types.ts";

// Discovery niches for the Create dashboard, built from REAL current data:
//   1. YouTube Data API gives current high-interest history/documentary videos.
//   2. OpenAI clusters those real titles into human-readable niche names.
//   3. "Recommended" is an editorial pick over the trending/popular niches.
// Results are cached in SQLite and refreshed lazily when stale. When the real
// sources are not configured we return unavailable groups - never invented data.

const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;
export const TTL: Record<"trending" | "popular", number> = { trending: 6 * HOUR, popular: 24 * HOUR };
const LOOKBACK: Record<"trending" | "popular", number> = { trending: 30 * DAY, popular: 365 * DAY };

// Real data needs: live mode + a YouTube key (signals) + an OpenAI key (clustering).
export function nichesAvailable(): boolean {
  return config.mode === "live" && !!config.youtube.apiKey && !!config.openai.apiKey;
}

// Injectable seams so freshness/caching can be tested without live API calls.
export interface NicheDeps {
  now?: () => Date;
  available?: () => boolean;
  fetchSignals?: (kind: "trending" | "popular", after: Date) => Promise<YtSignal[]>;
  cluster?: (kind: "trending" | "popular", signals: YtSignal[]) => Promise<NicheItem[]>;
  recommend?: (trending: NicheItem[], popular: NicheItem[]) => Promise<NicheItem[]>;
}

const UNAVAILABLE_NOTE =
  "Add a YouTube API key and an OpenAI key in Config, then switch to Live, to surface niches from real YouTube data.";

function ageMs(computedAt: string, now: Date): number {
  return now.getTime() - Date.parse(computedAt);
}

export async function getNiches(deps: NicheDeps = {}): Promise<NichesResponse> {
  const now = deps.now ?? (() => new Date());
  const available = deps.available ?? nichesAvailable;

  if (!available()) {
    const empty = (): NicheGroup => ({ available: false, updatedAt: null, niches: [], note: UNAVAILABLE_NOTE });
    return { trending: empty(), popular: empty(), recommended: empty() };
  }

  const trending = await ensureGroup("trending", now, deps);
  const popular = await ensureGroup("popular", now, deps);
  const recommended = await ensureRecommended(trending, popular, now, deps);

  // A niche should normally appear in only one section. De-duplicate across the
  // three groups at read time (the cached real data is left intact): Trending is
  // most current so it wins over Popular, and Recommended - already a distinct
  // editorial pick - is filtered against both as a safety net.
  const taken = new Set<string>();
  return {
    trending: { ...trending, niches: dedupeAcross(trending.niches, taken) },
    popular: { ...popular, niches: dedupeAcross(popular.niches, taken) },
    recommended: { ...recommended, niches: dedupeAcross(recommended.niches, taken) },
  };
}

async function ensureGroup(kind: "trending" | "popular", now: () => Date, deps: NicheDeps): Promise<NicheGroup> {
  const cached = readNiche(kind);
  if (cached && ageMs(cached.computedAt, now()) < TTL[kind]) {
    return { available: true, updatedAt: cached.computedAt, niches: cached.niches };
  }
  const after = new Date(now().getTime() - LOOKBACK[kind]);
  const fetchSignals = deps.fetchSignals ?? ((_k, a) => fetchHistorySignals({ publishedAfter: a, max: 40 }));
  const cluster = deps.cluster ?? clusterSignals;

  const signals = await fetchSignals(kind, after);
  const niches = normalizeNiches(await cluster(kind, signals));
  const computedAt = now().toISOString();
  writeNiche(kind, { niches, computedAt });
  return { available: true, updatedAt: computedAt, niches };
}

// Recommended is derived from the real trending/popular niches, so it is
// recomputed whenever either of its sources is newer than the cached pick.
async function ensureRecommended(trending: NicheGroup, popular: NicheGroup, now: () => Date, deps: NicheDeps): Promise<NicheGroup> {
  const newest = Math.max(Date.parse(trending.updatedAt ?? "0"), Date.parse(popular.updatedAt ?? "0"));
  const cached = readNiche("recommended");
  if (cached && Date.parse(cached.computedAt) >= newest) {
    return { available: true, updatedAt: cached.computedAt, niches: cached.niches };
  }
  const recommend = deps.recommend ?? recommendNiches;
  const niches = normalizeNiches(await recommend(trending.niches, popular.niches));
  const computedAt = now().toISOString();
  writeNiche("recommended", { niches, computedAt });
  return { available: true, updatedAt: computedAt, niches };
}

// ---- UI-facing text normalization ----
// The niche name/description shown on the Create dashboard must read like short
// editorial copy, not a research report. We defensively strip emojis, markdown
// and stray whitespace, and cap the description length, regardless of what the
// model returned - before caching or displaying. The raw `evidence` (real source
// video titles) is left untouched for grounding/debugging and is never rendered.

const EMOJI = /[\p{Extended_Pictographic}\u{FE0F}\u{20E3}\u{200B}-\u{200D}\u{1F1E6}-\u{1F1FF}]/gu;
// Kept short so the description always fits a clean 2-line niche card.
const DESC_MAX = 120;

export function cleanNicheText(s: string): string {
  return (s ?? "")
    .replace(EMOJI, "")
    .replace(/[*_`#>~]+/g, "") // markdown emphasis / headings / quotes / strike
    .replace(/\s+/g, " ")
    .trim();
}

// One tidy editorial sentence, capped at ~140 chars on a word boundary.
export function clampNicheDescription(s: string): string {
  const c = cleanNicheText(s);
  if (c.length <= DESC_MAX) return c;
  const cut = c.slice(0, DESC_MAX);
  const lastSpace = cut.lastIndexOf(" ");
  return (lastSpace > 60 ? cut.slice(0, lastSpace) : cut).replace(/[\s.,;:!?-]+$/, "") + "…";
}

export function normalizeNiches(niches: NicheItem[]): NicheItem[] {
  return niches.map((n) => ({
    name: cleanNicheText(n.name),
    why: clampNicheDescription(n.why),
    evidence: n.evidence ?? [], // preserved for grounding/debugging; never rendered on the dashboard
  }));
}

// ---- Cross-section de-duplication ----
// Two niche titles describe the same topic when their significant words match,
// ignoring order, casing, punctuation, simple plurals and filler words. This is
// a mechanical safety net; the clustering prompts do the real separation.
const TOPIC_STOP = new Set(["the", "a", "an", "of", "and", "in", "on", "for", "to", "history", "historical", "story", "stories", "era", "age"]);

export function topicKey(name: string): string {
  return cleanNicheText(name)
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w && !TOPIC_STOP.has(w))
    .map((w) => (w.length > 3 && w.endsWith("s") ? w.slice(0, -1) : w)) // naive singular
    .sort()
    .join(" ");
}

// Keep only niches whose topic has not already been claimed by an earlier group.
function dedupeAcross(niches: NicheItem[], taken: Set<string>): NicheItem[] {
  const out: NicheItem[] = [];
  for (const n of niches) {
    const key = topicKey(n.name);
    if (!key || taken.has(key)) continue;
    taken.add(key);
    out.push(n);
  }
  return out;
}

// ---- OpenAI clustering (live) ----

const NICHE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["niches"],
  properties: {
    niches: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["name", "why", "evidence"],
        properties: {
          name: { type: "string" },
          why: { type: "string" },
          evidence: { type: "array", items: { type: "string" } },
        },
      },
    },
  },
};

async function clusterSignals(kind: "trending" | "popular", signals: YtSignal[]): Promise<NicheItem[]> {
  if (!signals.length) return [];
  const window = kind === "trending" ? "the last ~30 days" : "the last ~6-12 months";
  const rows = signals.map((s) => ({ title: s.title, views: s.views, channel: s.channel, publishedAt: s.publishedAt }));
  const out = await respondJson<{ niches: NicheItem[] }>({
    instructions: `You cluster REAL YouTube history/documentary videos into 4-6 subject niches reflecting what is drawing interest over ${window}. Group by subject, not by channel. For each niche return:
- name: a concise, human-readable niche title, 2-5 words. No emojis, no markdown.
- why: ONE short editorial sentence, at most 120 characters, describing the niche's appeal like a magazine blurb - not a research report. No emojis, no markdown, and never quote, list, or paste the source video titles.
- evidence: 2-3 of the ACTUAL video titles provided, verbatim, for internal grounding only (this is never shown to users).
Do not invent titles or niches that the data does not support.`,
    input: `Real YouTube results (title, view count):\n${JSON.stringify(rows)}`,
    schemaName: "niches",
    schema: NICHE_SCHEMA,
    webSearch: true,
  });
  return out.niches.slice(0, 6);
}

async function recommendNiches(trending: NicheItem[], popular: NicheItem[]): Promise<NicheItem[]> {
  if (!trending.length && !popular.length) return [];
  const out = await respondJson<{ niches: NicheItem[] }>({
    instructions:
      'You are an editorial curator for PastBriefly, whose promise is "True historical stories that sound made up." Using the REAL trending and popular niches and their evidence as your source material, define 3-5 niches that most sharply embody that promise: stranger-than-fiction true events - improbable near-misses, audacious swindles, unlikely escapes, bizarre coincidences. Do NOT simply repeat or lightly rename the trending/popular niches; sharpen or recombine them into distinct angles with the highest surprising-story density, and give each a title that differs from the input niche names. Stay grounded in the provided evidence - do not invent subjects the data does not support. Return for each: name - a concise 2-5 word title, no emojis, no markdown; why - ONE short editorial sentence, at most 120 characters, on why it sounds made up but is real, no emojis, no markdown, and never quoting or listing source video titles; evidence - the source niches/signals you drew on, for internal grounding only (never shown to users).',
    input: `Trending niches:\n${JSON.stringify(trending)}\n\nPopular niches:\n${JSON.stringify(popular)}`,
    schemaName: "niches",
    schema: NICHE_SCHEMA,
    webSearch: true,
  });
  return out.niches.slice(0, 5);
}
