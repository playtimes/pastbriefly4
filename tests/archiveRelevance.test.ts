import { describe, test, expect, vi, afterEach } from "vitest";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Story } from "../src/types.ts";

const tmp = mkdtempSync(path.join(os.tmpdir(), "pb4-archive-"));
process.env.PROVIDER_MODE = "mock";
process.env.PB4_DATA_DIR = path.join(tmp, "data");
process.env.PB4_MEDIA_DIR = path.join(tmp, "media");

const { archiveQueries, relevanceTerms, eventIdentifiers } = await import("../src/production/visuals.ts");
const { fetchArchive } = await import("../src/production/wikimedia.ts");

// A submarine-grounding story (used only as sample data, not hardcoded in src):
// the event carries a distinctive identifier "U 137" that a bare place query lacks.
function makeStory(): Story {
  return {
    id: "s1",
    slug: "whiskey-on-the-rocks",
    title: "The Whiskey on the Rocks Incident",
    hook: "A Soviet submarine, U 137, ran aground deep inside Swedish waters.",
    category: "Conflicts & Standoffs",
    year: "1981",
    place: "Karlskrona, Sweden",
    summary: "A stranded submarine sparks a standoff.",
    heroImage: null,
    moments: [{ title: "The grounding", detail: "Submarine U 137 stuck fast near a naval base." }],
    sources: [],
    productionNote: "",
    createdAt: new Date().toISOString(),
  };
}

// Build the Wikimedia search response the API would return for one result.
function searchResponse(page: any) {
  return { ok: true, json: async () => ({ query: { pages: { "1": page } } }) };
}

function mediaResponse() {
  return { ok: true, arrayBuffer: async () => new ArrayBuffer(8) };
}

afterEach(() => vi.restoreAllMocks());

describe("archive query building", () => {
  test("a bare place-only query is never used as a fallback", () => {
    const story = makeStory();
    const queries = archiveQueries(story, "Karlskrona 1981 grounding");
    expect(queries).not.toContain(story.place); // "Karlskrona, Sweden" alone
    expect(queries).not.toContain("Karlskrona");
    // Specific-to-broad: identifiers lead, place+year is the broadest kept.
    expect(queries[0].toLowerCase()).toContain("u 137");
    expect(queries[queries.length - 1]).toBe(`${story.place} ${story.year}`);
  });
});

// A story written the way research returns it: dates and counts follow ordinary
// connector words ("In 1981", "On 27 October", "of 28") around the one real
// identifier. Those fragments once formed the garbage first query
// "In 1981 On 27 U 137 of 28".
function proseStory(): Story {
  return {
    ...makeStory(),
    title: "A Soviet Submarine Got Stuck in Sweden",
    hook: "In 1981, a Soviet submarine ran aground near a Swedish naval base, triggering a military response.",
    place: "Sweden (Blekinge Archipelago)",
    moments: [
      { title: "Submarine Runs Aground", detail: "On 27 October 1981, the Soviet submarine U 137 ran aground near the Karlskrona naval base." },
      { title: "Fisherman Spots the Submarine", detail: "On the morning of 28 October 1981, a fisherman reported it; one of 28 boats in the bay." },
      { title: "Escort", detail: "At 10 knots, escorted by 3 vessels for 20 miles to 5 miles out, on 6 November U 137 departed." },
    ],
  };
}

describe("event identifiers", () => {
  const garbage = ["In 1981", "On 27", "of 28", "at 10", "At 10", "by 3", "for 20", "to 5", "On 6"];

  test("a U-137-like story keeps U 137 and drops the prose fragments", () => {
    const ids = eventIdentifiers(proseStory());
    expect(ids).toContain("U 137");
    for (const g of garbage) expect(ids).not.toContain(g);
    expect(ids.filter((t) => /\d/.test(t))).toEqual(["U 137"]);
  });

  test("real compact identifiers survive", () => {
    const story = { ...makeStory(), hook: "The K-19 and an A-12 flew past, with a B 52 and U 137 nearby.", moments: [] };
    expect(eventIdentifiers(story).slice(0, 4)).toEqual(["K-19", "A-12", "B 52", "U 137"]);
  });

  test("lowercase and capitalised connector fragments are rejected generically", () => {
    const story = { ...makeStory(), title: "X", hook: "In 1981 On 27 of 28 at 10 by 3 for 20 to 5 May 4 From 12.", moments: [] };
    expect(eventIdentifiers(story).filter((t) => /\d/.test(t))).toEqual([]);
  });

  test("the story year still reaches the relevance terms separately", () => {
    const terms = relevanceTerms(proseStory());
    expect(terms).toContain("U 137");
    expect(terms).toContain("1981");
    expect(terms).not.toContain("In 1981");
  });

  test("archive queries lead with the identifier and keep the specific-to-broad order", () => {
    const story = proseStory();
    const queries = archiveQueries(story, "Soviet submarine aground Karlskrona 1981");
    expect(queries[0].startsWith("U 137")).toBe(true);
    for (const g of garbage) expect(queries[0]).not.toContain(g);
    expect(queries.slice(1)).toEqual(["Soviet submarine aground Karlskrona 1981", `${story.title} ${story.year}`, `${story.place} ${story.year}`]);
  });
});

describe("archive relevance check", () => {
  test("an unrelated photo of the same place is rejected", async () => {
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((m?: any) => void logs.push(String(m)));
    const fetchMock = vi.fn(async () =>
      searchResponse({
        title: "File:Karlskrona harbour 2015.jpg",
        imageinfo: [
          {
            mime: "image/jpeg",
            url: "https://upload.wikimedia.org/harbour.jpg",
            thumburl: "https://upload.wikimedia.org/harbour.jpg",
            descriptionurl: "https://commons.wikimedia.org/wiki/File:Karlskrona_harbour_2015.jpg",
            extmetadata: {
              LicenseShortName: { value: "CC0" },
              ImageDescription: { value: "Karlskrona harbour, Sweden, photographed in 2015." },
              Categories: { value: "Coasts of Sweden" },
            },
          },
        ],
      }) as any,
    );
    global.fetch = fetchMock as any;

    const out = path.join(tmp, "reject.jpg");
    const got = await fetchArchive("Karlskrona 1981", out, relevanceTerms(makeStory()));

    expect(got).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1); // never downloaded the rejected image
    expect(logs.some((l) => l.includes("rejected unrelated result"))).toBe(true);
  });

  test("event-specific metadata is accepted", async () => {
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((m?: any) => void logs.push(String(m)));
    const fetchMock = vi.fn(async (url: any) => {
      if (String(url).includes("api.php")) {
        return searchResponse({
          title: "File:Soviet submarine U 137 aground 1981.jpg",
          imageinfo: [
            {
              mime: "image/jpeg",
              url: "https://upload.wikimedia.org/u137.jpg",
              thumburl: "https://upload.wikimedia.org/u137.jpg",
              descriptionurl: "https://commons.wikimedia.org/wiki/File:U137.jpg",
              extmetadata: {
                LicenseShortName: { value: "CC0" },
                ImageDescription: { value: "The Soviet submarine U 137 grounded near Karlskrona in October 1981." },
                Categories: { value: "U 137" },
              },
            },
          ],
        }) as any;
      }
      return mediaResponse() as any;
    });
    global.fetch = fetchMock as any;

    const out = path.join(tmp, "accept.jpg");
    const got = await fetchArchive("U 137 1981", out, relevanceTerms(makeStory()));

    expect(got).not.toBeNull();
    expect(got!.localPath).toBe(out);
    expect(fetchMock).toHaveBeenCalledTimes(2); // searched, then downloaded the match
    expect(logs.some((l) => l.includes("accepted"))).toBe(true);
  });
});
