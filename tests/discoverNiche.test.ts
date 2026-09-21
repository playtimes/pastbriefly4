import { describe, test, expect, beforeEach, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";

// Live-mode discovery, driven deterministically: we stub the OpenAI web research
// (respondJson) and the ffmpeg-backed placeholder writer so the real findStories
// and discover logic run without any network or media dependency.
const tmp = mkdtempSync(path.join(os.tmpdir(), "pb4-niche-"));
process.env.PROVIDER_MODE = "live";
process.env.PB4_DATA_DIR = path.join(tmp, "data");
process.env.PB4_MEDIA_DIR = path.join(tmp, "media");

vi.mock("../src/providers/openai.ts", () => ({ respondJson: vi.fn() }));
vi.mock("../src/production/mockAssets.ts", () => ({
  writePlaceholderStill: vi.fn(),
  writeSilentWav: vi.fn(),
  referenceFrame: vi.fn(() => null),
}));

const { respondJson } = await import("../src/providers/openai.ts");
const { discover } = await import("../src/production/discover.ts");
const { upsertStory } = await import("../src/server/store.ts");

const respond = vi.mocked(respondJson);

let n = 0;
function seedStory(title: string, haystack = ""): void {
  n++;
  upsertStory({
    id: `seed-${n}`,
    slug: `seed-${n}`,
    title,
    hook: haystack,
    category: "Strange Everyday History",
    year: "1900",
    place: "Somewhere",
    summary: haystack,
    heroImage: null,
    moments: [],
    sources: [],
    productionNote: "",
    createdAt: new Date().toISOString(),
  });
}

function candidate(title: string) {
  return { title, hook: "h", category: "Strange Everyday History", year: "1900", place: "p", summary: "s", moments: [], sources: [], productionNote: "" };
}

// Live discovery now fact-checks each candidate before saving (a second
// respondJson call, schemaName "verification"). By default discovery finds
// nothing and every candidate is "supported"; a test queues a discovery result
// with mockResolvedValueOnce (consumed by the first call, which is discovery).
beforeEach(() => {
  respond.mockReset();
  respond.mockImplementation(async (opts: any) => {
    if (opts.schemaName === "verification") {
      const title = /^TITLE: (.*)$/m.exec(opts.input)?.[1] ?? "";
      return { verdict: "supported", reason: "ok", title, hook: "h", summary: "s", moments: [], sources: [], productionNote: "" } as any;
    }
    return { candidates: [] } as any;
  });
});

describe("niche discovery vs. normal search", () => {
  test("two niche requests each use their own query", async () => {
    await discover({ prompt: "Cold War Espionage", niche: true });
    await discover({ prompt: "Ancient Roman Engineering", niche: true });

    const inputs = respond.mock.calls.map((c) => c[0].input as string);
    expect(inputs.some((i) => i.includes("Cold War Espionage"))).toBe(true);
    expect(inputs.some((i) => i.includes("Ancient Roman Engineering"))).toBe(true);
    // Each niche sends a distinct query - not one shared search.
    expect(inputs[0]).not.toBe(inputs[1]);
  });

  test("live niche discovery returns only newly added stories, no loose library matches", async () => {
    seedStory("The Roman Aqueduct Swindle"); // existing story that loosely matches "roman"
    respond.mockResolvedValueOnce({ candidates: [candidate("A Brand New Roman Tale")] } as any);

    const r = await discover({ prompt: "Ancient Roman Engineering", niche: true });
    const titles = r.stories.map((s) => s.title);
    expect(titles).toContain("A Brand New Roman Tale");
    expect(titles).not.toContain("The Roman Aqueduct Swindle");
    expect(r.stories).toHaveLength(1);
  });

  test("manual search still folds in relevant existing library matches", async () => {
    seedStory("The Venetian Glass Conspiracy", "secrets of venice");
    respond.mockResolvedValueOnce({ candidates: [] } as any); // nothing newly discovered this time

    const r = await discover({ prompt: "venetian", niche: false });
    expect(r.stories.map((s) => s.title)).toContain("The Venetian Glass Conspiracy");
  });

  test("existing titles are excluded from live discovery", async () => {
    seedStory("Operation Already Known");
    respond.mockResolvedValueOnce({
      candidates: [candidate("Operation Already Known"), candidate("A Genuinely New Episode")],
    } as any);

    const r = await discover({ prompt: "daring operations", niche: true });
    const titles = r.stories.map((s) => s.title);
    expect(titles).toContain("A Genuinely New Episode");
    expect(titles).not.toContain("Operation Already Known"); // not rediscovered

    // The existing title is sent to the discovery model as an explicit exclusion.
    const discoveryInput = respond.mock.calls.find((c) => c[0].schemaName === "candidates")![0].input as string;
    expect(discoveryInput).toContain("Operation Already Known");
  });
});
