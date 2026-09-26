import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import type { Story } from "../src/types.ts";

// Archive acquisition hardening: a result found by a broad story-level fallback
// search must still match the owning shot's own archiveQuery anchors, and two
// distinct assets may never accept the same archive bytes (also across a resume).
// Wikimedia is a stubbed global fetch and OpenAI a stub: zero provider calls.
const tmp = mkdtempSync(path.join(os.tmpdir(), "pb4-archive-acq-"));
process.env.PROVIDER_MODE = "live";
process.env.OPENAI_API_KEY = "test-key";
process.env.PB4_DATA_DIR = path.join(tmp, "data");
process.env.PB4_MEDIA_DIR = path.join(tmp, "media");

const h = vi.hoisted(() => ({ imageCalls: [] as string[] }));

vi.mock("../src/providers/openai.ts", async () => {
  const { mkdirSync, writeFileSync } = await import("node:fs");
  const nodePath = await import("node:path");
  return {
    respondJson: vi.fn(async () => ({})),
    imageMimeType: () => "image/png",
    generateImageFile: vi.fn(async (opts: { outPath: string }) => {
      h.imageCalls.push(opts.outPath);
      mkdirSync(nodePath.dirname(opts.outPath), { recursive: true });
      writeFileSync(opts.outPath, "reconstruction");
    }),
  };
});
vi.mock("../src/providers/runway.ts", () => ({ generateMotion: vi.fn(async () => {}) }));

const { archiveAnchors, acquireStill, seedArchiveLedger, relevanceTerms } = await import("../src/production/visuals.ts");
const { fetchArchive } = await import("../src/production/wikimedia.ts");
const { ensureStoryDirs, inStory } = await import("../src/production/paths.ts");

const CAMOUFLAGE = "Abraham Crijnssen camouflaged with foliage 1942";
const SURABAYA = "Surabaya port WWII";
const DEN_HELDER = "Abraham Crijnssen museum ship Dutch Naval Museum Den Helder";

let n = 0;
function makeStory(): Story {
  const slug = `archive-acq-${n++}`;
  ensureStoryDirs(slug);
  return {
    id: slug,
    slug,
    title: "Dutch Minesweeper Disguised Itself as an Island",
    hook: "In March 1942 a minesweeper hid from Japanese aircraft by disguising itself as an island.",
    category: "Escapes & Operations",
    year: "1942",
    place: "Dutch East Indies (now Indonesia)",
    summary: "A camouflaged escape.",
    heroImage: null,
    moments: [{ title: "The escape", detail: "The Japanese advance forced every ship to flee." }],
    sources: [],
    productionNote: "",
    createdAt: new Date().toISOString(),
  };
}

// One Wikimedia search result with the given metadata and media URL.
function page(title: string, description: string, categories: string, url: string) {
  return {
    title,
    imageinfo: [
      {
        mime: "image/jpeg",
        url,
        thumburl: url,
        descriptionurl: `https://commons.wikimedia.org/wiki/${encodeURIComponent(title)}`,
        extmetadata: {
          LicenseShortName: { value: "Public domain" },
          Artist: { value: "Archive" },
          ImageDescription: { value: description },
          Categories: { value: categories },
        },
      },
    ],
  };
}

// The off-topic result from the investigation: generic era metadata only.
const BANKNOTE = page(
  "File:Japanese occupation Netherlands Indies one gulden 1942.jpg",
  "One gulden note issued by De Japansche Regeering during the Japanese occupation of the Dutch East Indies, 1942.",
  "Japanese occupation of the Dutch East Indies; Banknotes of the Netherlands Indies; 1942",
  "https://upload.wikimedia.org/banknote.jpg",
);
const CRIJNSSEN = page(
  "File:HNLMS Abraham Crijnssen camouflaged 1942.jpg",
  "The minesweeper Abraham Crijnssen camouflaged with foliage during her escape, 1942.",
  "Abraham Crijnssen (ship, 1936)",
  "https://upload.wikimedia.org/crijnssen.jpg",
);
const SURABAYA_PORT = page(
  "File:Surabaya harbour 1942.jpg",
  "The naval harbour of Surabaya before the Japanese occupation, 1942.",
  "Port of Surabaya; Surabaya in the 1940s",
  "https://upload.wikimedia.org/surabaya.jpg",
);
const DEN_HELDER_MUSEUM = page(
  "File:Abraham Crijnssen Den Helder.jpg",
  "Minesweeper Abraham Crijnssen preserved at the Marinemuseum in Den Helder; she escaped Java in 1942.",
  "Abraham Crijnssen (ship, 1936); Marinemuseum Den Helder",
  "https://upload.wikimedia.org/denhelder.jpg",
);

// Stub Wikimedia: `search` picks the results for a query, `bytes` the media per URL.
function stubWikimedia(search: (q: string) => any[], bytes: Record<string, string>) {
  const calls = { search: [] as string[], media: [] as string[] };
  global.fetch = vi.fn(async (url: any) => {
    const u = new URL(String(url));
    if (u.pathname.endsWith("api.php")) {
      const q = u.searchParams.get("gsrsearch")!;
      calls.search.push(q);
      const pages = Object.fromEntries(search(q).map((p, i) => [String(i + 1), p]));
      return { ok: true, json: async () => ({ query: { pages } }) } as any;
    }
    calls.media.push(String(url));
    const body = bytes[String(url)];
    if (body === undefined) return { ok: false } as any;
    return { ok: true, arrayBuffer: async () => new Uint8Array(Buffer.from(body)).buffer } as any;
  }) as any;
  return calls;
}

function archiveShot(index: number, assetId: string, archiveQuery: string) {
  return { index, edit: "new", assetId, presentation: "base", framing: "wide", startSec: index, endSec: index + 1, truth: "archive", motion: "hold", wantsMotion: false, prompt: `reconstruction of ${assetId}`, purpose: "p", mustShow: [], mustNotShow: [], wordStart: 0, wordEnd: 0, archiveQuery } as any;
}

const sha = (s: string) => createHash("sha256").update(Buffer.from(s)).digest("hex");

beforeEach(() => {
  h.imageCalls.length = 0;
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe("shot anchors from archiveQuery", () => {
  test("strong anchors are the shot's own proper nouns, never generic era words", () => {
    expect(archiveAnchors(CAMOUFLAGE)).toEqual(["Abraham", "Crijnssen"]);
    expect(archiveAnchors(SURABAYA)).toEqual(["Surabaya"]);
    expect(archiveAnchors(DEN_HELDER)).toEqual(["Abraham", "Crijnssen", "Helder"]);
  });

  test("generic-only queries derive no anchor, keeping the old relevance behaviour", () => {
    expect(archiveAnchors("Japanese occupation Dutch East Indies 1942 WWII")).toEqual([]);
    expect(archiveAnchors("World War naval port March 1942 historical photo")).toEqual([]);
    expect(archiveAnchors("WWII 1945 museum ship")).toEqual([]);
    expect(archiveAnchors(undefined)).toEqual([]);
  });

  test("compact identifiers stay useful anchors", () => {
    expect(archiveAnchors("Soviet submarine U 137 aground Karlskrona 1981")).toEqual(["U 137", "Karlskrona"]);
    expect(archiveAnchors("K-19 A-12 B 52 U 137")).toEqual(["K-19", "A-12", "B 52", "U 137"]);
  });
});

describe("shot-specific relevance", () => {
  const story = makeStory();
  const relevance = relevanceTerms(story);

  test.each([CAMOUFLAGE, SURABAYA, DEN_HELDER])("the generic 1942 banknote is rejected for %s, even from a story-level fallback query", async (query) => {
    const calls = stubWikimedia(() => [BANKNOTE], { [BANKNOTE.imageinfo[0].url]: "banknote" });
    const out = inStory(story.slug, "archive/banknote.jpg");
    const got = await fetchArchive(`${story.place} ${story.year}`, out, relevance, { anchors: archiveAnchors(query) });
    expect(got).toBeNull();
    expect(calls.media).toEqual([]); // never downloaded
    expect(existsSync(out)).toBe(false);
  });

  test("without shot anchors the weak story terms alone would have accepted it (the old failure)", async () => {
    stubWikimedia(() => [BANKNOTE], { [BANKNOTE.imageinfo[0].url]: "banknote" });
    const got = await fetchArchive(`${story.place} ${story.year}`, inStory(story.slug, "archive/old.jpg"), relevance);
    expect(got).not.toBeNull();
  });

  test.each([
    [CAMOUFLAGE, CRIJNSSEN],
    [SURABAYA, SURABAYA_PORT],
    [DEN_HELDER, DEN_HELDER_MUSEUM],
  ])("a real on-subject result passes for %s", async (query, result) => {
    const url = result.imageinfo[0].url;
    stubWikimedia(() => [BANKNOTE, result], { [BANKNOTE.imageinfo[0].url]: "banknote", [url]: url });
    const out = inStory(story.slug, "archive/real.jpg");
    const got = await fetchArchive(`${story.place} ${story.year}`, out, relevance, { anchors: archiveAnchors(query) });
    expect(got?.assetUrl).toBe(url);
    expect(got?.sha256).toBe(sha(url));
    expect(readFileSync(out, "utf8")).toBe(url);
  });

  test("the story relevance check still applies after an anchor matches", async () => {
    const modern = page("File:Surabaya skyline 2019.jpg", "Modern Surabaya skyline.", "Surabaya", "https://upload.wikimedia.org/skyline.jpg");
    stubWikimedia(() => [modern], { "https://upload.wikimedia.org/skyline.jpg": "skyline" });
    const got = await fetchArchive(SURABAYA, inStory(story.slug, "archive/sky.jpg"), relevance, { anchors: archiveAnchors(SURABAYA) });
    expect(got).toBeNull();
  });
});

describe("anchor precedence over the story-wide terms", () => {
  const story = makeStory();
  const relevance = relevanceTerms(story);
  const run = (result: any, anchors: string[], terms = relevance) => {
    stubWikimedia(() => [result], { [result.imageinfo[0].url]: result.imageinfo[0].url });
    return fetchArchive("any query", inStory(story.slug, "archive/precedence.jpg"), terms, { anchors });
  };

  test("two distinct shot anchors pass even when no story term matches", async () => {
    // The real Commons file the old story check rejected: no Minesweeper / Island / Japanese / 1942.
    const branches = page("File:HNLMS Abraham Crijnssen Covered In Branches.jpg", "HNLMS Abraham Crijnssen covered in branches.", "Abraham Crijnssen (ship, 1936)", "https://upload.wikimedia.org/branches.jpg");
    expect(relevanceTerms(story).some((t) => JSON.stringify(branches).toLowerCase().includes(t.toLowerCase()))).toBe(false);
    const got = await run(branches, archiveAnchors(CAMOUFLAGE));
    expect(got?.assetUrl).toBe("https://upload.wikimedia.org/branches.jpg");
  });

  test("a single plain anchor still needs story relevance", async () => {
    const period = page("File:Surabaya harbour.jpg", "Surabaya harbour in 1942.", "Surabaya", "https://upload.wikimedia.org/s1.jpg");
    const undated = page("File:Surabaya harbour old.jpg", "Surabaya harbour, old view.", "Surabaya", "https://upload.wikimedia.org/s2.jpg");
    expect((await run(period, archiveAnchors(SURABAYA)))?.assetUrl).toBe("https://upload.wikimedia.org/s1.jpg");
    expect(await run(undated, archiveAnchors(SURABAYA))).toBeNull();
  });

  test("a modern Surabaya result stays rejected", async () => {
    const modern = page("File:Surabaya skyline 2019.jpg", "Modern Surabaya skyline.", "Surabaya", "https://upload.wikimedia.org/modern.jpg");
    expect(await run(modern, archiveAnchors(SURABAYA))).toBeNull();
  });

  test("a compact identifier anchor alone is sufficient", async () => {
    const u137 = page("File:U 137 aground.jpg", "Submarine U 137 aground.", "Submarines", "https://upload.wikimedia.org/u137.jpg");
    const anchors = archiveAnchors("Soviet submarine U 137 aground");
    expect(anchors).toEqual(["U 137"]);
    expect((await run(u137, anchors, ["Whiskey", "1981"]))?.assetUrl).toBe("https://upload.wikimedia.org/u137.jpg");
  });

  test("with no shot anchors the old story relevance decides", async () => {
    const anchors = archiveAnchors("Japanese occupation Dutch East Indies 1942");
    expect(anchors).toEqual([]);
    const period = page("File:Java 1942.jpg", "Java during the Japanese advance.", "1942 in the Dutch East Indies", "https://upload.wikimedia.org/java.jpg");
    const unrelated = page("File:Jakarta 2020.jpg", "Jakarta street, 2020.", "Jakarta", "https://upload.wikimedia.org/jakarta.jpg");
    expect((await run(period, anchors))?.assetUrl).toBe("https://upload.wikimedia.org/java.jpg");
    expect(await run(unrelated, anchors)).toBeNull();
  });
});

describe("duplicate archive bytes across distinct assets", () => {
  // One photo that is genuinely relevant to BOTH shots, so only the duplicate rule can stop the second.
  const SHARED = page("File:Abraham Crijnssen at Surabaya 1942.jpg", "Abraham Crijnssen in the port of Surabaya, 1942.", "Abraham Crijnssen; Surabaya", "https://upload.wikimedia.org/x.jpg");
  const UNIQUE_Y = page("File:Surabaya naval base 1942.jpg", "Surabaya naval base, 1942.", "Surabaya", "https://upload.wikimedia.org/y.jpg");
  const bytes = { "https://upload.wikimedia.org/x.jpg": "file-X", "https://upload.wikimedia.org/y.jpg": "file-Y" };

  test("file X accepted for owner A is skipped for owner B, which takes unique file Y", async () => {
    const story = makeStory();
    const a = archiveShot(1, "L05", CAMOUFLAGE);
    const b = archiveShot(14, "L14", SURABAYA);
    const ledger = new Map<string, string>();
    stubWikimedia(() => [SHARED, UNIQUE_Y], bytes);

    expect(await acquireStill(story, "long", a, null, ledger)).toBe("archive");
    expect(await acquireStill(story, "long", b, null, ledger)).toBe("archive");

    expect(readFileSync(inStory(story.slug, a.path), "utf8")).toBe("file-X");
    expect(readFileSync(inStory(story.slug, b.path), "utf8")).toBe("file-Y");
    expect(ledger.get(sha("file-X"))).toBe("long:L05");
    expect(ledger.get(sha("file-Y"))).toBe("long:L14");
    expect(h.imageCalls).toEqual([]);
  });

  test("with no unique alternative, owner B falls back to a normal reconstruction", async () => {
    const story = makeStory();
    const a = archiveShot(1, "L05", CAMOUFLAGE);
    const b = archiveShot(14, "L14", SURABAYA);
    const ledger = new Map<string, string>();
    const calls = stubWikimedia(() => [SHARED], bytes);

    expect(await acquireStill(story, "long", a, null, ledger)).toBe("archive");
    const searchesForA = calls.search.length;
    expect(await acquireStill(story, "long", b, null, ledger)).toBe("generated");

    expect(b.truth).toBe("reconstruction");
    expect(b.path).toBe("images/long-14.png");
    expect(b.source).toBeUndefined();
    expect(existsSync(inStory(story.slug, "archive/long-14.jpg"))).toBe(false);
    expect(calls.search.length - searchesForA).toBe(4); // tried every query before giving up
    expect(h.imageCalls).toEqual([inStory(story.slug, "images/long-14.png")]);
  });

  test("an archive fallback clears a stale archive credit", async () => {
    const story = makeStory();
    const a = { ...archiveShot(1, "L05", CAMOUFLAGE), source: "Mak · Public domain" };
    stubWikimedia(() => [BANKNOTE], { [BANKNOTE.imageinfo[0].url]: "banknote" });
    expect(await acquireStill(story, "long", a, null, new Map())).toBe("generated");
    expect(a.truth).toBe("reconstruction");
    expect(a.path).toBe("images/long-01.png");
    expect("source" in a).toBe(false);
  });

  test("the same asset re-acquiring its own bytes is not a duplicate", async () => {
    const story = makeStory();
    const a = archiveShot(1, "L05", CAMOUFLAGE);
    const ledger = new Map([[sha("file-X"), "long:L05"]]);
    stubWikimedia(() => [SHARED], bytes);
    expect(await acquireStill(story, "long", a, null, ledger)).toBe("archive");
  });

  test("duplicate detection survives a resume from an already-bound owner archive file", async () => {
    const story = makeStory();
    // Stored plans: owner A already holds file X on disk, with a reuse slot of the same asset.
    writeFileSync(inStory(story.slug, "archive/long-01.jpg"), "file-X");
    const a = { ...archiveShot(1, "L05", CAMOUFLAGE), path: "archive/long-01.jpg", mediaType: "image" };
    const reuse = { ...archiveShot(6, "L05", CAMOUFLAGE), edit: "reuse", path: "archive/long-01.jpg" };
    const b = archiveShot(14, "L14", SURABAYA);
    const ledger = seedArchiveLedger(story, [["long", [a, reuse, b]], ["short", []]]);
    expect([...ledger]).toEqual([[sha("file-X"), "long:L05"]]);

    stubWikimedia(() => [SHARED, UNIQUE_Y], bytes);
    expect(await acquireStill(story, "long", b, null, ledger)).toBe("archive");
    expect(readFileSync(inStory(story.slug, b.path), "utf8")).toBe("file-Y");
  });
});
