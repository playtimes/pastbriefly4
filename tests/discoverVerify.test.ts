import { describe, test, expect, beforeEach, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";

// Live-mode discovery with fact-checking, driven deterministically: we stub the
// OpenAI calls (respondJson) and the ffmpeg-backed placeholder writer, then run
// the real findStories so its discover → verify → save flow is exercised.
const tmp = mkdtempSync(path.join(os.tmpdir(), "pb4-verify-"));
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
const { findStories, recheckStory } = await import("../src/production/research.ts");
const { listStories, upsertStory } = await import("../src/server/store.ts");

const respond = vi.mocked(respondJson);

function candidate(over: Record<string, unknown> = {}) {
  return {
    title: "A Candidate",
    hook: "h",
    category: "Strange Everyday History",
    year: "1900",
    place: "p",
    summary: "s",
    moments: [{ title: "m", detail: "d" }],
    sources: [{ title: "src", url: "https://example.org", note: "n" }],
    productionNote: "",
    ...over,
  };
}

function verifyResult(over: Record<string, unknown> = {}) {
  return {
    verdict: "supported",
    reason: "ok",
    title: "A Candidate",
    hook: "h",
    summary: "s",
    moments: [{ title: "m", detail: "d" }],
    sources: [{ title: "src", url: "https://example.org", note: "n" }],
    productionNote: "",
    ...over,
  };
}

function seed(title: string) {
  return {
    id: `seed-${title}`,
    slug: title.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
    title,
    hook: "",
    category: "Strange Everyday History" as const,
    year: "1900",
    place: "Somewhere",
    summary: "",
    heroImage: null,
    moments: [],
    sources: [],
    productionNote: "",
    createdAt: new Date().toISOString(),
  };
}

// Discovery returns whatever `discovery` holds; verification returns the verdict
// registered for a candidate title (defaulting to "supported").
let discovery: any = { candidates: [] };
const verdicts = new Map<string, any>();

beforeEach(() => {
  respond.mockReset();
  discovery = { candidates: [] };
  verdicts.clear();
  respond.mockImplementation(async (opts: any) => {
    if (opts.schemaName === "verification") {
      const title = /^TITLE: (.*)$/m.exec(opts.input)?.[1] ?? "";
      return verdicts.get(title) ?? verifyResult({ title });
    }
    return discovery;
  });
});

describe("candidate verification before saving", () => {
  test("a supported candidate is saved", async () => {
    discovery = { candidates: [candidate({ title: "The Boston Molasses Flood" })] };

    const r = await findStories("disasters");
    expect(r.added).toContain("The Boston Molasses Flood");
    expect(listStories().some((s) => s.title === "The Boston Molasses Flood")).toBe(true);
  });

  test("a rewrite candidate is saved with the corrected title/hook/story", async () => {
    const original = "Rothschild Secretly Rigged the Market After Waterloo";
    discovery = { candidates: [candidate({ title: original, hook: "He deliberately rigged the whole market." })] };
    verdicts.set(
      original,
      verifyResult({
        verdict: "rewrite",
        title: "The Rothschild Waterloo Legend and What Actually Happened",
        hook: "A persistent legend outran the smaller documented reality.",
        summary: "The defensible version of the story.",
        moments: [{ title: "Legend vs. record", detail: "What sources actually support." }],
        sources: [{ title: "The Rothschild Archive", url: "https://rothschildarchive.org", note: "primary" }],
      })
    );

    const r = await findStories("finance");
    expect(r.added).toContain("The Rothschild Waterloo Legend and What Actually Happened");
    expect(r.added).not.toContain(original);

    const saved = listStories().find((s) => s.title === "The Rothschild Waterloo Legend and What Actually Happened");
    expect(saved).toBeTruthy();
    expect(saved!.hook).toBe("A persistent legend outran the smaller documented reality.");
    expect(saved!.summary).toBe("The defensible version of the story.");
    expect(listStories().some((s) => s.title === original)).toBe(false);
  });

  test("a rejected candidate is not saved", async () => {
    discovery = { candidates: [candidate({ title: "A Legend With No Evidence" })] };
    verdicts.set("A Legend With No Evidence", verifyResult({ verdict: "reject" }));

    const r = await findStories("myths");
    expect(r.added).not.toContain("A Legend With No Evidence");
    expect(listStories().some((s) => s.title === "A Legend With No Evidence")).toBe(false);
  });

  test("the verifier receives the candidate's central hook and sources", async () => {
    discovery = {
      candidates: [
        candidate({
          title: "A Testable Claim",
          hook: "THE CENTRAL SURPRISING CLAIM",
          sources: [{ title: "National Archives", url: "https://archives.gov/x", note: "primary" }],
        }),
      ],
    };

    await findStories("anything");
    const verifyCall = respond.mock.calls.find((c) => (c[0] as any).schemaName === "verification");
    expect(verifyCall).toBeTruthy();
    const opts = verifyCall![0] as any;
    expect(opts.input).toContain("THE CENTRAL SURPRISING CLAIM");
    expect(opts.input).toContain("National Archives");
    expect(opts.webSearch).toBe(true);
  });

  test("the verifier must normalize titles even on a supported verdict", async () => {
    discovery = { candidates: [candidate({ title: "A Candidate" })] };

    await findStories("anything");
    const verifyCall = respond.mock.calls.find((c) => (c[0] as any).schemaName === "verification");
    const p = (verifyCall![0] as any).instructions as string;

    // A "supported" verdict does not freeze the wording - the title is normalized.
    expect(p).toMatch(/normaliz/i);
    expect(p).toMatch(/does NOT mean the wording must stay/i);
    // ...but improving wording never flips the verdict.
    expect(p).toMatch(/never changes the verdict/i);
  });

  test("recheck normalizes a supported story's badly worded title", async () => {
    const badTitle = "Soviet Whiskey-class Submarine Runs Aground in Sweden, Triggering 'Whiskey on the Rocks' Incident";
    const saved = seed(badTitle);
    upsertStory(saved);
    verdicts.set(
      badTitle,
      verifyResult({
        verdict: "supported",
        title: "A Soviet Submarine Got Stuck in Sweden",
        hook: "It ran aground yards from a secret naval base.",
      })
    );

    const r = await recheckStory(saved as any);
    expect(r.verdict).toBe("supported");
    expect(r.story.title).toBe("A Soviet Submarine Got Stuck in Sweden");
    expect(listStories().find((s) => s.id === saved.id)!.title).toBe("A Soviet Submarine Got Stuck in Sweden");
    expect(listStories().some((s) => s.title === badTitle)).toBe(false);
  });

  test("recheck leaves a rejected story untouched", async () => {
    const title = "A Story The Recheck Rejects";
    const saved = seed(title);
    upsertStory(saved);
    verdicts.set(title, verifyResult({ verdict: "reject", title: "Should Not Be Applied" }));

    const r = await recheckStory(saved as any);
    expect(r.verdict).toBe("reject");
    expect(r.story.title).toBe(title);
    expect(listStories().find((s) => s.id === saved.id)!.title).toBe(title);
  });

  test("existing titles are excluded before verification", async () => {
    upsertStory(seed("Already In The Library"));
    discovery = { candidates: [candidate({ title: "Already In The Library" }), candidate({ title: "A Fresh Find" })] };

    const r = await findStories("mix");
    expect(r.added).toEqual(["A Fresh Find"]);

    // The existing title is skipped before the fact-check call - never verified.
    const verified = respond.mock.calls
      .filter((c) => (c[0] as any).schemaName === "verification")
      .map((c) => /^TITLE: (.*)$/m.exec((c[0] as any).input)![1]);
    expect(verified).not.toContain("Already In The Library");
    expect(verified).toContain("A Fresh Find");
  });
});
