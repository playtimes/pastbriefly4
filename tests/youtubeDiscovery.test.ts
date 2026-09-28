import { test, expect, vi, afterEach } from "vitest";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";

// Regression: public discovery still uses only the Data API key (no OAuth, no
// bearer header) against search + videos. fetch is stubbed; no Google calls.
const tmp = mkdtempSync(path.join(os.tmpdir(), "pb4-ytdisc-"));
process.env.PB4_DATA_DIR = path.join(tmp, "data");
process.env.PB4_MEDIA_DIR = path.join(tmp, "media");
process.env.YOUTUBE_API_KEY = "yt-public-key";

const { fetchHistorySignals } = await import("../src/production/youtube.ts");

afterEach(() => vi.restoreAllMocks());

test("discovery uses the API key only, search then videos, sorted by views", async () => {
  const calls: { url: URL; init?: any }[] = [];
  global.fetch = vi.fn(async (url: any, init?: any) => {
    const u = new URL(String(url));
    calls.push({ url: u, init });
    const body =
      u.pathname === "/youtube/v3/search"
        ? { items: [{ id: { videoId: `a-${u.searchParams.get("q")}` }, snippet: { title: "t", channelTitle: "c", publishedAt: "2026-09-01T00:00:00Z" } }, { id: { videoId: "shared" }, snippet: { title: "s" } }] }
        : { items: String(u.searchParams.get("id")).split(",").map((id, i) => ({ id, statistics: { viewCount: String(i * 10) } })) };
    return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) } as any;
  }) as any;

  const out = await fetchHistorySignals({ publishedAfter: new Date("2026-09-01T00:00:00Z"), max: 5 });

  expect(calls.map((c) => c.url.pathname)).toEqual([...Array(6).fill("/youtube/v3/search"), "/youtube/v3/videos"]);
  for (const c of calls) {
    expect(c.url.origin).toBe("https://www.googleapis.com");
    expect(c.url.searchParams.get("key")).toBe("yt-public-key");
    expect(c.init).toBeUndefined(); // plain GET, no Authorization header
  }
  expect(calls[0].url.searchParams.get("order")).toBe("viewCount");
  expect(calls[6].url.searchParams.get("id")!.split(",")).toHaveLength(7); // 6 unique + 1 shared
  expect(out).toHaveLength(5);
  expect(out[0].views).toBeGreaterThanOrEqual(out[1].views);
});
