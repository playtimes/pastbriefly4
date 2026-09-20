import { config } from "../server/config.ts";

// Direct calls to the official YouTube Data API v3 (no provider abstraction).
//   search:      GET /youtube/v3/search   (find recent/high-interest videos)
//   videos:      GET /youtube/v3/videos   (statistics for those video ids)
// We collect current public signals around history/documentary subjects; the raw
// titles + view counts are later clustered by OpenAI into human-readable niches.
// PENDING LIVE VERIFICATION before any keyed run.

const API = "https://www.googleapis.com/youtube/v3";

// Neutral history/documentary seed queries. These only decide what slice of
// YouTube we sample; the niche names come from the real returned titles, so the
// output reflects genuine current interest rather than these seeds.
const SEED_QUERIES = [
  "history documentary",
  "strange history",
  "history mystery explained",
  "declassified history",
  "historical disaster documentary",
  "true history story",
];

export interface YtSignal {
  videoId: string;
  title: string;
  channel: string;
  publishedAt: string;
  views: number;
}

// Fetch the highest-viewed history/documentary videos published since a cutoff.
export async function fetchHistorySignals(opts: { publishedAfter: Date; max?: number }): Promise<YtSignal[]> {
  const key = config.youtube.apiKey;
  if (!key) throw new Error("YOUTUBE_API_KEY not set.");

  const meta = new Map<string, { title: string; channel: string; publishedAt: string }>();
  const ids: string[] = [];

  for (const q of SEED_QUERIES) {
    const url = new URL(`${API}/search`);
    url.searchParams.set("key", key);
    url.searchParams.set("part", "snippet");
    url.searchParams.set("type", "video");
    url.searchParams.set("order", "viewCount");
    url.searchParams.set("maxResults", "10");
    url.searchParams.set("relevanceLanguage", "en");
    url.searchParams.set("q", q);
    url.searchParams.set("publishedAfter", opts.publishedAfter.toISOString());

    const res = await fetch(url);
    if (!res.ok) throw new Error(`YouTube search ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const data = (await res.json()) as any;
    for (const it of data.items ?? []) {
      const id = it?.id?.videoId;
      if (!id || meta.has(id)) continue;
      meta.set(id, {
        title: it.snippet?.title ?? "",
        channel: it.snippet?.channelTitle ?? "",
        publishedAt: it.snippet?.publishedAt ?? "",
      });
      ids.push(id);
    }
  }

  // Statistics come from a separate endpoint; batch by the API's 50-id limit.
  const signals: YtSignal[] = [];
  for (let i = 0; i < ids.length; i += 50) {
    const batch = ids.slice(i, i + 50);
    const url = new URL(`${API}/videos`);
    url.searchParams.set("key", key);
    url.searchParams.set("part", "statistics");
    url.searchParams.set("id", batch.join(","));

    const res = await fetch(url);
    if (!res.ok) throw new Error(`YouTube videos ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const data = (await res.json()) as any;
    for (const it of data.items ?? []) {
      const m = meta.get(it.id);
      if (!m) continue;
      signals.push({ videoId: it.id, title: m.title, channel: m.channel, publishedAt: m.publishedAt, views: Number(it.statistics?.viewCount ?? 0) });
    }
  }

  signals.sort((a, b) => b.views - a.views);
  return signals.slice(0, opts.max ?? 40);
}
