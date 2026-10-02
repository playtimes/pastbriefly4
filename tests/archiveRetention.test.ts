import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import type { Story } from "../src/types.ts";

// Stage 16A Slice 1, archive retention: a file fetchArchive accepted and
// downloaded is also kept under DATA_DIR/archive-retained/<slug>/ with its
// provenance, and nothing about the acquisition result changes. Wikimedia is a
// stubbed global fetch and OpenAI a stub: zero provider calls.
const tmp = mkdtempSync(path.join(os.tmpdir(), "pb4-archive-retention-"));
process.env.PROVIDER_MODE = "live";
process.env.OPENAI_API_KEY = "test-key";
process.env.PB4_DATA_DIR = path.join(tmp, "data");
process.env.PB4_MEDIA_DIR = path.join(tmp, "media");

vi.mock("../src/providers/openai.ts", async (orig) => {
  const { mkdirSync, writeFileSync } = await import("node:fs");
  const nodePath = await import("node:path");
  return {
    ...(await orig<typeof import("../src/providers/openai.ts")>()),
    respondJson: vi.fn(async () => ({})),
    generateImageFile: vi.fn(async (opts: { outPath: string }) => {
      mkdirSync(nodePath.dirname(opts.outPath), { recursive: true });
      writeFileSync(opts.outPath, "reconstruction");
    }),
  };
});
vi.mock("../src/providers/runway.ts", () => ({ generateMotion: vi.fn(async () => {}) }));

const { acquireStill, recoverArchiveStill, archiveOwner } = await import("../src/production/visuals.ts");
const { ensureStoryDirs, inStory, storyDir, retainedArchiveDir, clearWorkingVisuals } = await import("../src/production/paths.ts");
const { recordArchiveReview, retainedArchiveInventory } = await import("../src/production/archiveRetention.ts");
const { clearVisualsForRebuild, newJobId } = await import("../src/production/generate.ts");
const { createJob, updateJob, upsertStory } = await import("../src/server/store.ts");
const { config, DATA_DIR, MEDIA_DIR } = await import("../src/server/config.ts");

const QUERY = "Hughes Glomar Explorer at sea 1974";
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from("glomar at sea")]);
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("cia drawing")]);
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");

let n = 0;
function makeStory(): Story {
  const slug = `retention-${n++}`;
  ensureStoryDirs(slug);
  const story: Story = {
    id: slug,
    slug,
    title: "The CIA Tried to Steal a Sunken Soviet Submarine",
    hook: "In 1974 the CIA built a ship to lift a Soviet submarine.",
    category: "Escapes & Operations",
    year: "1974",
    place: "Pacific Ocean",
    summary: "Project Azorian.",
    heroImage: null,
    moments: [{ title: "The ship", detail: "Hughes Glomar Explorer." }],
    sources: [],
    productionNote: "",
    createdAt: new Date().toISOString(),
  };
  upsertStory(story);
  return story;
}

// One Commons result; `over` replaces imageinfo fields or metadata.
function page(title: string, url: string, over: { mime?: string; license?: string; meta?: Record<string, any> } = {}) {
  return {
    title,
    imageinfo: [
      {
        mime: over.mime ?? "image/jpeg",
        url,
        thumburl: url,
        descriptionurl: `https://commons.wikimedia.org/wiki/${encodeURIComponent(title)}`,
        extmetadata: {
          LicenseShortName: { value: over.license ?? "Public domain" },
          Artist: { value: "<span>U.S. Government</span>" },
          Credit: { value: "<a href=\"https://nsarchive.gwu.edu\">National Security Archive</a>" },
          ImageDescription: { value: "USNS Glomar Explorer (T-AG-193) at sea." },
          ...over.meta,
        },
      },
    ],
  };
}
const AT_SEA = page("File:USNS Glomar Explorer (T-AG-193).jpg", "https://upload.wikimedia.org/glomar.jpg");

function stubCommons(results: any[], bytes: Record<string, Buffer>) {
  const calls = { search: 0, media: 0 };
  global.fetch = vi.fn(async (url: any) => {
    const u = new URL(String(url));
    if (u.pathname.endsWith("api.php")) {
      calls.search++;
      return { ok: true, json: async () => ({ query: { pages: Object.fromEntries(results.map((p, i) => [String(i + 1), p])) } }) } as any;
    }
    calls.media++;
    const body = bytes[String(url)];
    if (!body) return { ok: false } as any;
    return { ok: true, arrayBuffer: async () => new Uint8Array(body).buffer } as any;
  }) as any;
  return calls;
}

function archiveShot(index: number, assetId: string, archiveQuery = QUERY) {
  return { index, edit: "new", assetId, presentation: "base", framing: "wide", startSec: index, endSec: index + 1, truth: "archive", motion: "hold", wantsMotion: false, prompt: `reconstruction of ${assetId}`, purpose: "p", mustShow: [], mustNotShow: [], wordStart: 0, wordEnd: 0, archiveQuery } as any;
}

const retained = (slug: string) => (existsSync(retainedArchiveDir(slug)) ? readdirSync(retainedArchiveDir(slug)).sort() : []);
const record = (slug: string, hash: string) => JSON.parse(readFileSync(path.join(retainedArchiveDir(slug), `${hash}.json`), "utf8"));

beforeEach(() => {
  config.mode = "live";
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe("1, 2. an accepted archive is retained with its provenance", () => {
  test("one file under DATA_DIR named by the full SHA-256, one sidecar; the acquisition result is unchanged", async () => {
    const story = makeStory();
    stubCommons([AT_SEA], { [AT_SEA.imageinfo[0].url]: JPEG });
    const shot = archiveShot(3, "L03");
    expect(await acquireStill(story, "long", shot, null, new Map(), undefined, undefined, "job-1")).toBe("archive");

    // The working acquisition exactly as before.
    expect(shot).toMatchObject({ truth: "archive", path: "archive/long-03.jpg", mediaType: "image", source: "U.S. Government · Public domain", wantsMotion: false });
    expect(readFileSync(inStory(story.slug, "archive/long-03.jpg")).equals(JPEG)).toBe(true);

    const hash = sha(JPEG);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(retained(story.slug)).toEqual([`${hash}.jpg`, `${hash}.json`]);
    expect(readFileSync(path.join(retainedArchiveDir(story.slug), `${hash}.jpg`)).equals(JPEG)).toBe(true);
    expect(retainedArchiveDir(story.slug)).toBe(path.join(DATA_DIR, "archive-retained", story.slug));

    const r = record(story.slug, hash);
    expect(r).toEqual({
      status: "screened archive candidate",
      sha256: hash,
      file: `${hash}.jpg`,
      story: story.slug,
      title: "File:USNS Glomar Explorer (T-AG-193).jpg",
      sourcePage: AT_SEA.imageinfo[0].descriptionurl,
      assetUrl: "https://upload.wikimedia.org/glomar.jpg",
      license: "Public domain",
      artist: "<span>U.S. Government</span>",
      rawCredit: "<a href=\"https://nsarchive.gwu.edu\">National Security Archive</a>",
      credit: "U.S. Government · Public domain",
      acquisitions: [{ at: expect.any(String), query: expect.stringContaining("Glomar"), film: "long", owner: "long:L03", jobId: "job-1" }],
      reviews: [],
    });
  });

  test("raw attribution Commons does not supply is left out, never invented", async () => {
    const story = makeStory();
    const bare = page("File:Glomar bare.jpg", "https://upload.wikimedia.org/bare.jpg", { meta: { Artist: undefined, Credit: undefined } });
    stubCommons([bare], { "https://upload.wikimedia.org/bare.jpg": JPEG });
    await acquireStill(story, "long", archiveShot(1, "L01"), null);
    const r = record(story.slug, sha(JPEG));
    expect("artist" in r).toBe(false);
    expect("rawCredit" in r).toBe(false);
    expect(r.credit).toBe("Wikimedia Commons · Public domain"); // the display credit PB4 already used
  });

  test("PNG bytes keep .png; the working path is unchanged", async () => {
    const story = makeStory();
    const drawing = page("File:Project Azorian Released Files Page 21.png", "https://upload.wikimedia.org/p21.png", { mime: "image/png" });
    stubCommons([drawing], { "https://upload.wikimedia.org/p21.png": PNG });
    const shot = archiveShot(4, "L04");
    await acquireStill(story, "long", shot, null);
    expect(shot.path).toBe("archive/long-04.jpg"); // as today
    expect(retained(story.slug)).toEqual([`${sha(PNG)}.json`, `${sha(PNG)}.png`]);
  });
});

describe("3. candidates fetchArchive did not accept are never retained", () => {
  test("bad MIME, bad licence, off-shot, unrelated, failed download, duplicate: nothing retained", async () => {
    const story = makeStory();
    const other = Buffer.from("owned by another asset");
    const results = [
      page("File:Glomar Explorer.svg", "https://upload.wikimedia.org/a.svg", { mime: "image/svg+xml" }),
      page("File:Glomar Explorer NC.jpg", "https://upload.wikimedia.org/nc.jpg", { license: "CC BY-NC 4.0" }),
      page("File:Pacific sunset.jpg", "https://upload.wikimedia.org/sunset.jpg", { meta: { ImageDescription: { value: "A sunset." } } }),
      page("File:Glomar Explorer missing.jpg", "https://upload.wikimedia.org/missing.jpg"),
      page("File:Glomar Explorer duplicate.jpg", "https://upload.wikimedia.org/dup.jpg"),
    ];
    const calls = stubCommons(results, { "https://upload.wikimedia.org/dup.jpg": other });
    const ledger = new Map([[sha(other), "long:L09"]]);
    const shot = archiveShot(2, "L02");
    expect(await acquireStill(story, "long", shot, null, ledger)).toBe("generated"); // reconstruction fallback, as today
    expect(calls.media).toBeGreaterThan(0); // the missing and the duplicate were tried, neither accepted
    expect(shot.truth).toBe("reconstruction");
    expect(existsSync(retainedArchiveDir(story.slug))).toBe(false);
  });
});

describe("4. the same bytes accepted twice", () => {
  test("one media file, one sidecar, two acquisition events", async () => {
    const story = makeStory();
    stubCommons([AT_SEA], { [AT_SEA.imageinfo[0].url]: JPEG });
    const first = archiveShot(3, "L03");
    await acquireStill(story, "long", first, null, new Map(), undefined, undefined, "job-1");
    // A later job (fresh ledger after a new job) accepts the same bytes for a Short asset.
    const again = archiveShot(1, "S01");
    await acquireStill(story, "short", again, null, new Map(), undefined, undefined, "job-2");
    const hash = sha(JPEG);
    expect(retained(story.slug)).toEqual([`${hash}.jpg`, `${hash}.json`]);
    expect(record(story.slug, hash).acquisitions.map((a: any) => [a.jobId, a.film, a.owner])).toEqual([
      ["job-1", "long", "long:L03"],
      ["job-2", "short", "short:S01"],
    ]);
  });
});

describe("5. a final-repair style rejection keeps the retained copy and its reason", () => {
  test("recovered, rejected for the slot: the working copy goes, the retained copy and the reason stay", async () => {
    const story = makeStory();
    stubCommons([AT_SEA], { [AT_SEA.imageinfo[0].url]: JPEG });
    const owner = archiveShot(5, "L05");
    owner.truth = "reconstruction"; // an archive fallback, as in Film #5
    const got = (await recoverArchiveStill(story, "long", owner, new Map(), "job-5"))!;
    expect(got).toEqual({ path: "archive/long-05.jpg", credit: "U.S. Government · Public domain", sha256: sha(JPEG) });
    expect(owner.truth).toBe("reconstruction"); // nothing is bound by the search
    // What recoverFinalArchive's reject does: note the reason, then delete the working copy.
    recordArchiveReview(story.slug, got.sha256, { film: "long", assetId: "L05", decision: "rejected", reason: "The photo shows the ship, not the claw.", by: "final visual repair", jobId: "job-5" });
    const r = record(story.slug, got.sha256);
    expect(r.reviews).toEqual([{ at: expect.any(String), film: "long", assetId: "L05", decision: "rejected", reason: "The photo shows the ship, not the claw.", by: "final visual repair", jobId: "job-5" }]);
    expect(r.acquisitions[0]).toMatchObject({ owner: "long:L05", jobId: "job-5" });
  });

  test("a review for a file that was never retained is a warning, never a failure", () => {
    const story = makeStory();
    expect(() => recordArchiveReview(story.slug, sha(Buffer.from("never retained")), { film: "long", assetId: "L01", decision: "rejected", reason: "r", by: "final visual repair" })).not.toThrow();
    expect(() => recordArchiveReview(story.slug, undefined, { film: "long", assetId: "L01", decision: "rejected", reason: "r", by: "final visual repair" })).not.toThrow();
    expect(console.warn).toHaveBeenCalled();
    expect(existsSync(retainedArchiveDir(story.slug))).toBe(false);
  });
});

describe("6. working-visual cleanup never reaches the retained archive", () => {
  test("clearWorkingVisuals and clearVisualsForRebuild remove working files only", async () => {
    const story = makeStory();
    stubCommons([AT_SEA], { [AT_SEA.imageinfo[0].url]: JPEG });
    const shot = archiveShot(3, "L03");
    await acquireStill(story, "long", shot, null);
    const kept = retained(story.slug);
    expect(kept).toHaveLength(2);

    // A visual rebuild deletes the files the old shot plan references.
    const job = createJob({ id: newJobId(), storyId: story.id, mock: false, estimatedCost: 5, approvedMax: 15 });
    updateJob(job.id, { scratch: { masterRef: "images/hero.png", spent: 0, longShots: [shot], shortShots: [] } as any, state: "awaiting_preview" });
    clearVisualsForRebuild(job.id);
    expect(existsSync(inStory(story.slug, "archive/long-03.jpg"))).toBe(false);
    expect(retained(story.slug)).toEqual(kept);

    // A new job clears the whole working archive/ folder.
    writeFileSync(inStory(story.slug, "archive/long-07.jpg"), JPEG);
    clearWorkingVisuals(story.slug);
    expect(readdirSync(inStory(story.slug, "archive"))).toEqual([]);
    expect(retained(story.slug)).toEqual(kept);
    expect(readFileSync(path.join(retainedArchiveDir(story.slug), `${sha(JPEG)}.jpg`)).equals(JPEG)).toBe(true);
  });

  test("Remotion safety: the retained folder is outside the story publicDir and the media tree", () => {
    const story = makeStory();
    const rel = (from: string) => path.relative(from, retainedArchiveDir(story.slug));
    expect(rel(storyDir(story.slug)).startsWith("..")).toBe(true);
    expect(rel(MEDIA_DIR).startsWith("..")).toBe(true);
    expect(existsSync(path.join(storyDir(story.slug), "archive-retained"))).toBe(false); // ensureStoryDirs never makes one
  });
});

describe("7. mock mode retains nothing", () => {
  test("no Commons request and no retained data from an archive shot or a repair search", async () => {
    config.mode = "mock";
    const story = makeStory();
    const calls = stubCommons([AT_SEA], { [AT_SEA.imageinfo[0].url]: JPEG });
    const shot = archiveShot(3, "L03");
    expect(await acquireStill(story, "long", shot, null)).toBe("mock");
    expect(await recoverArchiveStill(story, "long", archiveShot(4, "L04"), new Map())).toBeNull();
    expect(calls).toEqual({ search: 0, media: 0 });
    expect(existsSync(retainedArchiveDir(story.slug))).toBe(false);
    expect(existsSync(path.join(DATA_DIR, "archive-retained", story.slug))).toBe(false);
  });
});

describe("8. a retention failure never fails the acquisition", () => {
  test("the retained folder cannot be written: a warning, and the same archive result as without retention", async () => {
    const story = makeStory();
    mkdirSync(path.dirname(retainedArchiveDir(story.slug)), { recursive: true });
    writeFileSync(retainedArchiveDir(story.slug), "a file where the folder should be"); // mkdir fails
    stubCommons([AT_SEA], { [AT_SEA.imageinfo[0].url]: JPEG });
    const ledger = new Map<string, string>();
    const shot = archiveShot(3, "L03");
    expect(await acquireStill(story, "long", shot, null, ledger, undefined, undefined, "job-8")).toBe("archive");
    expect(shot).toMatchObject({ truth: "archive", path: "archive/long-03.jpg", source: "U.S. Government · Public domain", wantsMotion: false });
    expect(readFileSync(inStory(story.slug, "archive/long-03.jpg")).equals(JPEG)).toBe(true);
    expect(ledger.get(sha(JPEG))).toBe(archiveOwner("long", shot)); // the duplicate ledger as always
    expect(vi.mocked(console.warn).mock.calls.some(([m]) => /retention failed/.test(String(m)))).toBe(true);
  });

  test("a corrupt sidecar: a warning, the acquisition still succeeds", async () => {
    const story = makeStory();
    mkdirSync(retainedArchiveDir(story.slug), { recursive: true });
    writeFileSync(path.join(retainedArchiveDir(story.slug), `${sha(JPEG)}.json`), "{ not json");
    stubCommons([AT_SEA], { [AT_SEA.imageinfo[0].url]: JPEG });
    const shot = archiveShot(3, "L03");
    expect(await acquireStill(story, "long", shot, null)).toBe("archive");
    expect(shot.path).toBe("archive/long-03.jpg");
    expect(vi.mocked(console.warn).mock.calls.some(([m]) => /retention failed/.test(String(m)))).toBe(true);
  });
});

describe("9. the Slice 2 read path: retainedArchiveInventory (prompt metadata only)", () => {
  test("no retained folder is simply no candidates", () => {
    expect(retainedArchiveInventory(makeStory().slug)).toEqual([]);
  });

  test("each screened candidate's title, licence, credit, searches and slot rejections, newest first; malformed sidecars skipped; no path or hash", async () => {
    const story = makeStory();
    stubCommons([AT_SEA], { [AT_SEA.imageinfo[0].url]: JPEG });
    await acquireStill(story, "long", archiveShot(3, "L03"), null, new Map(), undefined, undefined, "job-1");
    recordArchiveReview(story.slug, sha(JPEG), { film: "long", assetId: "L03", decision: "rejected", reason: "The slot needs the ship under construction.", by: "final visual repair", jobId: "job-1" });
    // A newer candidate, then three sidecars the reader must skip.
    const drawing = page("File:Project Azorian Released Files Page 21.png", "https://upload.wikimedia.org/p21.png", { mime: "image/png" });
    stubCommons([drawing], { "https://upload.wikimedia.org/p21.png": PNG });
    await new Promise((r) => setTimeout(r, 5));
    await acquireStill(story, "long", archiveShot(4, "L04"), null);
    const dir = retainedArchiveDir(story.slug);
    writeFileSync(path.join(dir, `${sha(Buffer.from("a"))}.json`), "{ not json");
    writeFileSync(path.join(dir, `${sha(Buffer.from("b"))}.json`), JSON.stringify({ status: "approved", title: "x", acquisitions: [], reviews: [] }));
    writeFileSync(path.join(dir, "notes.json"), JSON.stringify({ status: "screened archive candidate", title: "not a sidecar name", acquisitions: [], reviews: [] }));

    const inventory = retainedArchiveInventory(story.slug);
    expect(inventory).toEqual([
      { title: "File:Project Azorian Released Files Page 21.png", license: "Public domain", credit: "U.S. Government · Public domain", queries: [expect.stringContaining("Glomar")], rejections: [] },
      { title: "File:USNS Glomar Explorer (T-AG-193).jpg", license: "Public domain", credit: "U.S. Government · Public domain", queries: [expect.stringContaining("Glomar")], rejections: ["The slot needs the ship under construction."] },
    ]);
    const text = JSON.stringify(inventory);
    expect(text).not.toContain(sha(JPEG));
    expect(text).not.toContain(DATA_DIR);
    expect(text).not.toContain("archive-retained");
  });

  test("at most `max` candidates", async () => {
    const story = makeStory();
    const dir = retainedArchiveDir(story.slug);
    mkdirSync(dir, { recursive: true });
    for (let i = 0; i < 25; i++) {
      const hash = sha(Buffer.from(`c${i}`));
      writeFileSync(path.join(dir, `${hash}.json`), JSON.stringify({ status: "screened archive candidate", sha256: hash, title: `File:${i}.jpg`, license: "CC0", credit: "c", acquisitions: [{ at: `2026-01-01T00:00:${String(i).padStart(2, "0")}.000Z`, query: "q" }], reviews: [] }));
    }
    expect(retainedArchiveInventory(story.slug)).toHaveLength(20);
    expect(retainedArchiveInventory(story.slug, 3).map((c) => c.title)).toEqual(["File:24.jpg", "File:23.jpg", "File:22.jpg"]);
  });
});
