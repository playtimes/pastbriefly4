import { describe, test, expect, vi, afterEach } from "vitest";
import { mkdirSync, mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Story } from "../src/types.ts";

// Film #5 (Project Azorian): 24 Commons searches found no usable image. The story
// identifiers were Title Case words ("Tried Raise Soviet Submarine"), the shot
// queries were too long for Commons (every word must match), and PDFs filled the
// results. Pure helpers and a stubbed fetch: nothing reaches Commons.
const tmp = mkdtempSync(path.join(os.tmpdir(), "pb4-archive-recall-"));
process.env.PB4_DATA_DIR = path.join(tmp, "data");
process.env.PB4_MEDIA_DIR = path.join(tmp, "media");

const { eventIdentifiers, relevanceTerms, archiveAnchors, anchorQuery, archiveQueries } = await import("../src/production/visuals.ts");
const { fetchArchive, commonsPacing, commonsCredit, COMMONS_USER_AGENT } = await import("../src/production/wikimedia.ts");

// Shaped like the real story row (sample data only, never in src).
const azorian: Story = {
  id: "s5",
  slug: "raise-a-submarine",
  title: "The CIA Tried to Raise a Soviet Submarine in Secret",
  hook: "The CIA built a massive ship disguised as a mining vessel, fitted it with a giant claw, and tried to recover a sunken Soviet nuclear submarine from deep in the Pacific without the Soviets knowing.",
  category: "Escapes & Operations",
  year: "1974",
  place: "Pacific Ocean, near Hawaii",
  summary: "",
  heroImage: null,
  moments: [
    { title: "K‑129 sinks", detail: "In early March 1968, the Soviet Golf II‑class submarine K‑129 sank in the North Pacific northeast of Hawaii, with all hands lost." },
    { title: "Glomar Explorer built", detail: "The CIA had the Hughes Glomar Explorer built as a deep-sea mining ship, a cover story arranged with Howard Hughes." },
    { title: "Recovery attempt", detail: "In 1974 the Glomar Explorer lifted part of K‑129 before the claw failed." },
  ],
  sources: [],
  productionNote: "",
  createdAt: "",
};

describe("story identifiers", () => {
  test("A. a K-129 typed with a non-breaking hyphen (U+2011) becomes the identifier K-129", () => {
    const ids = eventIdentifiers(azorian);
    expect(ids).toContain("K-129");
    expect(ids).not.toContain("K‑129");
    expect(archiveAnchors("Soviet submarine K‑129 Golf II‑class at sea 1960s")).toEqual(["K-129", "Golf"]);
  });

  test("B. an all-caps acronym such as CIA is recognised; roman numerals are not", () => {
    const ids = eventIdentifiers(azorian);
    expect(ids).toContain("CIA");
    expect(ids).not.toContain("II");
    expect(eventIdentifiers({ ...azorian, moments: [{ title: "x", detail: "The Mark III and the NATO fleet met." }] })).toContain("NATO");
  });

  test("C. Title Case prose does not fill the identifiers with its verbs; the real entities lead", () => {
    const ids = eventIdentifiers(azorian);
    for (const w of ["Tried", "Raise", "Secret", "The", "In"]) expect(ids).not.toContain(w);
    expect(ids.slice(0, 2)).toEqual(["K-129", "CIA"]); // identifiers and acronyms first
    for (const w of ["Glomar", "Explorer", "Hughes"]) expect(ids).toContain(w); // then the names the story repeats
    expect(relevanceTerms(azorian)).toEqual([...ids, "1974"]);
    // A capitalised first word of a sentence is not a proper noun on its own.
    expect(eventIdentifiers({ ...azorian, title: "x", hook: "Divers found it. Nobody knew.", moments: [] })).toEqual([]);
  });
});

describe("the anchor-first short query", () => {
  test("D. a long shot query leads with its short anchor form", () => {
    expect(anchorQuery("Hughes Glomar Explorer deck crew 1974")).toBe("Hughes Glomar Explorer");
    expect(anchorQuery("Hughes Glomar Explorer Sun Shipbuilding construction 1972 1973")).toBe("Hughes Glomar Explorer"); // at most three
    expect(anchorQuery("Howard Hughes office 1974 1975 Glomar Explorer")).toBe("Howard Hughes"); // the first run of adjacent anchors
    const queries = archiveQueries(azorian, "Hughes Glomar Explorer deck crew 1974");
    expect(queries[0]).toBe("Hughes Glomar Explorer");
    expect(queries.slice(2)).toEqual(["Hughes Glomar Explorer deck crew 1974", `${azorian.title} 1974`, `${azorian.place} 1974`]);
  });

  test("E. a K-129 query gets a short K-129 / Golf search", () => {
    expect(anchorQuery("Soviet submarine K-129 Golf II-class at sea 1960s")).toBe("K-129 Golf");
    expect(anchorQuery("Soviet submarine K‑129 at sea")).toBe("K-129"); // a numbered identifier names the subject alone
    expect(archiveQueries(azorian, "Soviet submarine K-129 Golf II-class at sea 1960s")[0]).toBe("K-129 Golf");
  });

  test("a single plain anchor never becomes a place-style lead query", () => {
    expect(anchorQuery("Japanese warships Surabaya 1942")).toBe("");
    expect(anchorQuery("WWII 1945 museum ship")).toBe("");
    expect(anchorQuery(undefined)).toBe("");
  });
});

describe("Commons search hygiene", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    commonsPacing.gapMs = 0;
  });
  const out = () => path.join(tmp, "media", `x-${Math.random()}.jpg`);
  function stub(reply: () => any) {
    const calls: { url: URL; headers: any }[] = [];
    global.fetch = vi.fn(async (url: any, init: any) => {
      calls.push({ url: new URL(String(url)), headers: init?.headers });
      return reply();
    }) as any;
    return calls;
  }

  test("F. every search is restricted to bitmap images and identifies PastBriefly", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const calls = stub(() => ({ ok: true, json: async () => ({ query: { pages: {} } }) }));
    expect(await fetchArchive("Hughes Glomar Explorer", out(), [])).toBeNull();
    expect(calls[0].url.searchParams.get("gsrsearch")).toBe("Hughes Glomar Explorer filetype:bitmap");
    expect(calls[0].headers["User-Agent"]).toBe(COMMONS_USER_AGENT);
    expect(COMMONS_USER_AGENT).toMatch(/^PastBriefly\//);
  });

  test("a rate limit or HTTP failure is reported as a failed search, not as zero results", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    stub(() => ({ ok: false, status: 429 }));
    expect(await fetchArchive("K-129 Golf", out(), [])).toBeNull();
    stub(() => ({ ok: true, status: 200, json: async () => { throw new SyntaxError("Unexpected token 'Y'"); } })); // "You are making too many requests"
    expect(await fetchArchive("K-129 Golf", out(), [])).toBeNull();
    stub(() => ({ ok: true, json: async () => ({}) }));
    expect(await fetchArchive("K-129 Golf", out(), [])).toBeNull();
    expect(warn.mock.calls.map((c) => c[0])).toEqual([
      '[archive] search failed: HTTP 429 (rate limited) for "K-129 Golf"; not a zero-result search',
      '[archive] search failed: non-JSON response (likely rate limited) for "K-129 Golf"; not a zero-result search',
    ]);
    expect(log.mock.calls.map((c) => c[0])).toContain('[archive] "K-129 Golf": 0 results');
  });

  test("a Commons author rendered twice in consecutive elements is credited once; named authors are unchanged", async () => {
    // The exact shape Film #5 recovered: "Unknown authorUnknown author · Public domain".
    const doubled = '<span lang="en">Unknown author</span><span class="author">Unknown author</span>';
    expect(commonsCredit(doubled)).toBe("Unknown author");
    expect(commonsCredit('<a href="//commons.wikimedia.org/wiki/User:X">John Smith</a>')).toBe("John Smith");
    expect(commonsCredit("U.S. Government")).toBe("U.S. Government");
    expect(commonsCredit('<a href="/wiki/A">Jane Doe</a> and <a href="/wiki/B">John Roe</a>')).toBe("Jane Doe and John Roe");
    expect(commonsCredit("Sirhan Sirhan")).toBe("Sirhan Sirhan"); // plain text is never de-duplicated

    // Through the search: the stored credit keeps the license, the author once.
    vi.spyOn(console, "log").mockImplementation(() => {});
    const page = {
      title: "File:Released Files Page 21.jpg",
      imageinfo: [{ mime: "image/jpeg", url: "https://upload.wikimedia.org/p21.jpg", descriptionurl: "https://commons.wikimedia.org/wiki/File:P21.jpg", extmetadata: { Artist: { value: doubled }, LicenseShortName: { value: "Public domain" } } }],
    };
    global.fetch = vi.fn(async (url: any) =>
      String(url).startsWith("https://commons.wikimedia.org/") ? { ok: true, json: async () => ({ query: { pages: { 1: page } } }) } : { ok: true, arrayBuffer: async () => new Uint8Array([0xff, 0xd8, 0xff]).buffer },
    ) as any;
    const dest = out();
    mkdirSync(path.dirname(dest), { recursive: true });
    const got = await fetchArchive("Released Files", dest, []);
    expect(got?.credit).toBe("Unknown author · Public domain");
    expect(got?.license).toBe("Public domain");
  });

  test("searches are paced by a fixed gap, never burst", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const at: number[] = [];
    global.fetch = vi.fn(async () => {
      at.push(Date.now());
      return { ok: true, json: async () => ({ query: { pages: {} } }) };
    }) as any;
    commonsPacing.gapMs = 80;
    for (let i = 0; i < 3; i++) await fetchArchive(`q${i}`, out(), []);
    expect(at[1] - at[0]).toBeGreaterThanOrEqual(75);
    expect(at[2] - at[1]).toBeGreaterThanOrEqual(75);
  });
});
