import { describe, test, expect, beforeEach } from "vitest";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = mkdtempSync(path.join(os.tmpdir(), "pb4-niches-"));
process.env.PROVIDER_MODE = "mock";
process.env.PB4_DATA_DIR = path.join(tmp, "data");
process.env.PB4_MEDIA_DIR = path.join(tmp, "media");

const { getNiches, cleanNicheText, clampNicheDescription, normalizeNiches, topicKey } = await import("../src/production/niches.ts");
const { clearNicheCache } = await import("../src/server/store.ts");
import type { YtSignal } from "../src/production/youtube.ts";
import type { NicheItem } from "../src/types.ts";

const HOUR = 3600 * 1000;

// A controllable clock + counting fetchers so freshness/caching is testable
// without ever calling YouTube or OpenAI.
function harness() {
  let nowMs = Date.parse("2026-09-19T00:00:00.000Z");
  const fetchCounts = { trending: 0, popular: 0 };
  const deps = {
    now: () => new Date(nowMs),
    available: () => true,
    fetchSignals: async (kind: "trending" | "popular"): Promise<YtSignal[]> => {
      fetchCounts[kind]++;
      return [{ videoId: "v1", title: `${kind} title`, channel: "ch", publishedAt: "", views: 1000 }];
    },
    cluster: async (kind: "trending" | "popular"): Promise<NicheItem[]> => [{ name: `${kind}-niche`, why: "real", evidence: [`${kind} title`] }],
    recommend: async (): Promise<NicheItem[]> => [{ name: "rec-niche", why: "editorial pick", evidence: ["trending-niche"] }],
  };
  return { deps, fetchCounts, advance: (ms: number) => (nowMs += ms) };
}

describe("cached niche data", () => {
  beforeEach(() => clearNicheCache());

  test("computes once, then serves from cache until stale, then refreshes lazily", async () => {
    const { deps, fetchCounts, advance } = harness();

    const first = await getNiches(deps);
    expect(first.trending.available).toBe(true);
    expect(first.trending.niches[0].name).toBe("trending-niche");
    expect(first.recommended.niches[0].name).toBe("rec-niche");
    expect(fetchCounts).toEqual({ trending: 1, popular: 1 });

    // 1 minute later: everything is fresh, nothing is re-fetched.
    advance(60 * 1000);
    const second = await getNiches(deps);
    expect(fetchCounts).toEqual({ trending: 1, popular: 1 });
    expect(second.trending.updatedAt).toBe(first.trending.updatedAt);

    // 7 hours later: trending (6h TTL) is stale and refreshes; popular (24h) is not.
    advance(7 * HOUR);
    await getNiches(deps);
    expect(fetchCounts).toEqual({ trending: 2, popular: 1 });
  });
});

describe("UI-facing niche text is clean editorial copy", () => {
  beforeEach(() => clearNicheCache());

  test("strips emojis, markdown and stray whitespace", () => {
    expect(cleanNicheText("  Cold  War   Espionage 🕵️‍♂️  ")).toBe("Cold War Espionage");
    expect(cleanNicheText("**Ancient** _Disasters_ `#history`")).toBe("Ancient Disasters history");
    expect(cleanNicheText("Money 💰 & Deception 🤑")).toBe("Money & Deception");
  });

  test("caps the description near 140 characters on a word boundary", () => {
    const long = "The Cold War produced espionage tales so improbable that they read like fiction, ".repeat(4);
    const out = clampNicheDescription(long);
    expect(out.length).toBeLessThanOrEqual(141); // 140 + ellipsis
    expect(out.endsWith("…")).toBe(true);
    expect(out).not.toMatch(/\s…$/); // no dangling space before the ellipsis
  });

  test("normalizes name/description but never alters the real source evidence", () => {
    const raw = [
      {
        name: "Cold War Spies 🕵️",
        why: "**A verbose research report** that quotes the raw title: \"TOP 10 CRAZY Cold War Facts!!!\" ".repeat(3),
        evidence: ["TOP 10 CRAZY Cold War Facts!!! 🔥", "Declassified: The Berlin Tunnel"],
      },
    ];
    const [n] = normalizeNiches(raw);
    expect(n.name).toBe("Cold War Spies");
    expect(n.why).not.toMatch(/[*_`]/);
    expect(n.why.length).toBeLessThanOrEqual(141);
    // The real YouTube evidence is preserved verbatim for grounding/debugging.
    expect(n.evidence).toEqual(["TOP 10 CRAZY Cold War Facts!!! 🔥", "Declassified: The Berlin Tunnel"]);
  });

  test("getNiches cleans clustered text before it reaches the UI", async () => {
    const verbose = {
      now: () => new Date("2026-09-19T00:00:00.000Z"),
      available: () => true,
      fetchSignals: async () => [{ videoId: "v1", title: "Raw Title", channel: "ch", publishedAt: "", views: 10 }],
      cluster: async () => [{ name: "Naval Mysteries 🚢", why: "  A   messy **blurb**  ", evidence: ["Raw Title 🚢"] }],
      recommend: async () => [{ name: "Editorial Pick ✨", why: "*fit*", evidence: ["Naval Mysteries"] }],
    };
    const g = await getNiches(verbose);
    expect(g.trending.niches[0].name).toBe("Naval Mysteries");
    expect(g.trending.niches[0].why).toBe("A messy blurb");
    expect(g.recommended.niches[0].name).toBe("Editorial Pick");
    // Evidence (real source titles) is retained in stored data, untouched.
    expect(g.trending.niches[0].evidence).toEqual(["Raw Title 🚢"]);
  });
});

describe("a niche appears in only one section", () => {
  beforeEach(() => clearNicheCache());

  test("topicKey ignores order, casing, punctuation and simple plurals", () => {
    expect(topicKey("Cold War Espionage")).toBe(topicKey("espionage, cold-war"));
    expect(topicKey("Ancient Disasters")).toBe(topicKey("The Ancient Disaster"));
    expect(topicKey("Naval Mysteries")).not.toBe(topicKey("Aviation Mysteries"));
  });

  test("getNiches de-duplicates across trending, popular and recommended", async () => {
    // Trending and Popular both surface the same topic; Recommended echoes it too.
    const dup = {
      now: () => new Date("2026-09-19T00:00:00.000Z"),
      available: () => true,
      fetchSignals: async () => [{ videoId: "v1", title: "t", channel: "c", publishedAt: "", views: 1 }],
      cluster: async (kind: "trending" | "popular"): Promise<NicheItem[]> =>
        kind === "trending"
          ? [{ name: "Cold War Espionage", why: "spies", evidence: [] }]
          : [{ name: "cold-war espionage", why: "spies", evidence: [] }, { name: "Gilded Age Swindles", why: "cons", evidence: [] }],
      recommend: async (): Promise<NicheItem[]> => [
        { name: "Cold War Espionage", why: "echo", evidence: [] },
        { name: "Impossible Escapes", why: "distinct", evidence: [] },
      ],
    };
    const g = await getNiches(dup);
    const names = (grp: { niches: NicheItem[] }) => grp.niches.map((n) => n.name);

    // Trending keeps the topic; Popular drops the duplicate but keeps its unique one.
    expect(names(g.trending)).toEqual(["Cold War Espionage"]);
    expect(names(g.popular)).toEqual(["Gilded Age Swindles"]);
    // Recommended's echo is filtered; its distinct pick survives.
    expect(names(g.recommended)).toEqual(["Impossible Escapes"]);

    // Every visible topic key is unique across all three sections.
    const keys = [...g.trending.niches, ...g.popular.niches, ...g.recommended.niches].map((n) => topicKey(n.name));
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe("no fake fallback niche data", () => {
  beforeEach(() => clearNicheCache());

  test("when real sources are unavailable, groups are empty and marked unavailable", async () => {
    const groups = await getNiches({ available: () => false });
    for (const g of [groups.trending, groups.popular, groups.recommended]) {
      expect(g.available).toBe(false);
      expect(g.updatedAt).toBeNull();
      expect(g.niches).toEqual([]);
      expect(g.note).toBeTruthy();
    }
  });
});
