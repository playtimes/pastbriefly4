import { describe, test, expect, vi, beforeEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Story } from "../src/types.ts";

// Visual production integrity: a fresh job never reuses an older job's story-
// scoped shot files, spend is charged only for real image generation, and the
// preview shows both films. Every provider is stubbed; runs stop at the preview
// gate. Jobs are seeded past text, narration and planning so only visuals run.
const tmp = mkdtempSync(path.join(os.tmpdir(), "pb4-visual-integrity-"));
process.env.PROVIDER_MODE = "live";
process.env.OPENAI_API_KEY = "test-key";
process.env.ELEVENLABS_API_KEY = "test-key";
process.env.PB4_DATA_DIR = path.join(tmp, "data");
process.env.PB4_MEDIA_DIR = path.join(tmp, "media");

const h = vi.hoisted(() => ({
  imageCalls: [] as string[],
  // Snapshot of which stale files still existed when the master was generated.
  staleAtMaster: null as null | string[],
  staleProbe: [] as string[],
  archiveHit: false,
}));

vi.mock("../src/providers/openai.ts", async () => {
  const { mkdirSync, writeFileSync, existsSync } = await import("node:fs");
  const nodePath = await import("node:path");
  return {
    respondJson: vi.fn(async () => ({})),
    imageMimeType: () => "image/png",
    generateImageFile: vi.fn(async (opts: { outPath: string }) => {
      if (opts.outPath.endsWith("hero.png")) h.staleAtMaster = h.staleProbe.filter((p) => existsSync(p));
      h.imageCalls.push(opts.outPath);
      mkdirSync(nodePath.dirname(opts.outPath), { recursive: true });
      writeFileSync(opts.outPath, "new");
    }),
  };
});

vi.mock("../src/production/wikimedia.ts", () => ({
  fetchArchive: vi.fn(async () => (h.archiveHit ? { credit: "Archive credit" } : null)),
}));
vi.mock("../src/providers/runway.ts", () => ({ generateMotion: vi.fn(async () => {}) }));

const { runJob, newJobId } = await import("../src/production/generate.ts");
const { createJob, getJob, updateJob, upsertStory } = await import("../src/server/store.ts");
const { inStory, ensureStoryDirs } = await import("../src/production/paths.ts");
const { buildPreview, planSlots } = await import("../src/production/visuals.ts");
const { PRICING, round } = await import("../src/server/pricing.ts");
const { VisualReview, ReviewView } = await import("../src/app/visualReview/VisualReview.tsx");
const { buildFilm, initialReview, reviewReducer } = await import("../src/app/visualReview/model.ts");

let n = 0;
function makeStory(): Story {
  const slug = `integrity-${n++}`;
  const story: Story = {
    id: slug,
    slug,
    title: "Test Story",
    hook: "A hook.",
    category: "Disasters",
    year: "1900",
    place: "Somewhere",
    summary: "A summary.",
    heroImage: null,
    moments: [{ title: "m", detail: "d" }],
    sources: [],
    productionNote: "",
    createdAt: new Date().toISOString(),
  };
  upsertStory(story);
  ensureStoryDirs(slug);
  return story;
}

function shot(index: number, extra: Record<string, unknown> = {}) {
  return { index, edit: "new", assetId: `L${String(index).padStart(2, "0")}`, presentation: "base", framing: "wide", startSec: index, endSec: index + 1, truth: "reconstruction", motion: "hold", wantsMotion: false, prompt: `scene ${index}`, purpose: "p", mustShow: [], mustNotShow: [], wordStart: 0, wordEnd: 0, ...extra };
}

// Scripts and narration whose fixed slot grids (planSlots) are 2 Long slots and
// 1 Short slot: the saved shots sit on that grid, as planning puts them.
const SCRIPTS = { long: "The bats flew out over the desert at dawn. Nobody expected what came next that night.", short: "The bats flew out over the desert at dawn." };
const nar = (kind: "long" | "short") => {
  const words = SCRIPTS[kind].split(" ");
  return { audioRel: `audio/${kind}.mp3`, audioMediaRel: `m/${kind}`, durationSec: words.length * 0.4, words: words.map((word, i) => ({ word, start: i * 0.4, end: i * 0.4 + 0.35 })) };
};

// A job whose research, scripts, narration and shot plans are already done, so
// runJob goes straight to the master and still acquisition. A grid slot a test
// leaves out gets a shot that already has its still.
function seedJob(story: Story, opts: { masterRef?: string; longShots?: any[]; shortShots?: any[]; approvedMax?: number } = {}) {
  const job = createJob({ id: newJobId(), storyId: story.id, mock: false, estimatedCost: 5, approvedMax: opts.approvedMax ?? 15 });
  const onGrid = (kind: "long" | "short", given: any[]) =>
    planSlots(kind, SCRIPTS[kind], nar(kind) as any).map((slot, i) => {
      if (given[i]) return { ...given[i], startSec: slot.startSec, endSec: slot.endSec };
      const rel = `images/${kind}-${String(i).padStart(2, "0")}.png`;
      writeFileSync(inStory(story.slug, rel), "done");
      return shot(i, { path: rel, startSec: slot.startSec, endSec: slot.endSec });
    });
  const scratch = {
    research: { summary: "S", moments: [], sources: [], facts: [], productionNote: "", world: { period: "1900", place: "X", palette: "p", visualDirection: "v", recurringPeople: [], recurringLocations: [], referenceImages: [] } },
    scripts: SCRIPTS,
    textApproved: true,
    narration: { long: nar("long"), short: nar("short") },
    longShots: onGrid("long", opts.longShots ?? [shot(0), shot(1)]),
    shortShots: onGrid("short", opts.shortShots ?? [shot(0)]),
    spent: 0,
    ...(opts.masterRef ? { masterRef: opts.masterRef } : {}),
  };
  updateJob(job.id, { scratch: scratch as any, spent: 0 });
  return job;
}

const calls = (slug: string, rel: string) => h.imageCalls.filter((p) => p === inStory(slug, rel)).length;
const text = (slug: string, rel: string) => readFileSync(inStory(slug, rel), "utf8");

beforeEach(() => {
  h.imageCalls.length = 0;
  h.staleAtMaster = null;
  h.staleProbe = [];
  h.archiveHit = false;
});

describe("fresh-job visual cleanup", () => {
  test("a fresh job regenerates shots instead of reusing an older job's files", async () => {
    const story = makeStory();
    for (const rel of ["images/long-00.png", "images/long-01.png", "images/short-00.png"]) writeFileSync(inStory(story.slug, rel), "OLD");
    const job = seedJob(story);

    await runJob(job.id);
    expect(getJob(job.id)!.state).toBe("awaiting_preview");
    for (const rel of ["images/long-00.png", "images/long-01.png", "images/short-00.png"]) {
      expect(text(story.slug, rel)).toBe("new");
      expect(calls(story.slug, rel)).toBe(1);
    }
    // hero + 3 shots, all really generated and charged once each
    expect(getJob(job.id)!.spent).toBe(round(4 * PRICING.openai.image));
  });

  test("cleanup runs before the new master and leaves unrelated story files alone", async () => {
    const story = makeStory();
    const stale = ["images/long-00.png", "images/short-05.png", "archive/long-03.jpg", "motion/long-00.mp4"];
    const keep = ["audio/long.mp3", "renders/long.mp4", "refs/frame-00.png", "images/pb1-style.png"];
    for (const rel of [...stale, ...keep]) {
      mkdirSync(path.dirname(inStory(story.slug, rel)), { recursive: true });
      writeFileSync(inStory(story.slug, rel), "OLD");
    }
    h.staleProbe = stale.map((rel) => inStory(story.slug, rel));
    const job = seedJob(story);

    await runJob(job.id);
    expect(h.staleAtMaster).toEqual([]); // every stale file was gone before the master call
    expect(h.imageCalls[0]).toBe(inStory(story.slug, "images/hero.png")); // master first, then stills
    expect(existsSync(inStory(story.slug, "archive/long-03.jpg"))).toBe(false);
    expect(existsSync(inStory(story.slug, "motion/long-00.mp4"))).toBe(false);
    expect(existsSync(inStory(story.slug, "images/short-05.png"))).toBe(false);
    for (const rel of keep) expect(text(story.slug, rel)).toBe("OLD");
  });

  test("resume with an existing masterRef does not wipe the current job's assets", async () => {
    const story = makeStory();
    const job = seedJob(story);
    await runJob(job.id);
    expect(getJob(job.id)!.scratch.masterRef).toBe("images/hero.png");

    // Mark the current job's files, drop one shot's path to force the stills
    // loop to run again, and resume the same job.
    writeFileSync(inStory(story.slug, "images/hero.png"), "CURRENT");
    writeFileSync(inStory(story.slug, "images/short-00.png"), "CURRENT");
    mkdirSync(inStory(story.slug, "motion"), { recursive: true });
    writeFileSync(inStory(story.slug, "motion/long-00.mp4"), "CURRENT");
    const scratch = getJob(job.id)!.scratch as any;
    delete scratch.longShots[1].path;
    updateJob(job.id, { scratch, state: "running" });
    h.imageCalls.length = 0;

    await runJob(job.id);
    expect(text(story.slug, "images/hero.png")).toBe("CURRENT");
    expect(text(story.slug, "images/short-00.png")).toBe("CURRENT");
    expect(text(story.slug, "motion/long-00.mp4")).toBe("CURRENT");
    expect(calls(story.slug, "images/hero.png")).toBe(0);
  });
});

describe("still spend reflects real generation", () => {
  test("an existing file is reused without a new charge", async () => {
    const story = makeStory();
    // Resumed job (master exists): long-00 was written before a crash but never
    // recorded in scratch, so acquireStill finds it on disk.
    writeFileSync(inStory(story.slug, "images/hero.png"), "hero");
    writeFileSync(inStory(story.slug, "images/long-00.png"), "EARLIER");
    const job = seedJob(story, { masterRef: "images/hero.png" });

    await runJob(job.id);
    expect(calls(story.slug, "images/long-00.png")).toBe(0);
    expect(text(story.slug, "images/long-00.png")).toBe("EARLIER");
    // only long-01 and short-00 were generated
    expect(getJob(job.id)!.spent).toBe(round(2 * PRICING.openai.image));
  });

  test("a successful archive still gets no image charge", async () => {
    const story = makeStory();
    writeFileSync(inStory(story.slug, "images/hero.png"), "hero");
    h.archiveHit = true;
    const job = seedJob(story, { masterRef: "images/hero.png", longShots: [shot(0, { truth: "archive", archiveQuery: "q" })], shortShots: [] });

    await runJob(job.id);
    const s = (getJob(job.id)!.scratch as any).longShots[0];
    expect(s.truth).toBe("archive");
    expect(s.path).toBe("archive/long-00.jpg");
    expect(h.imageCalls).toEqual([]);
    expect(getJob(job.id)!.spent).toBe(0);
  });

  test("an archive fallback reconstruction is charged exactly once", async () => {
    const story = makeStory();
    writeFileSync(inStory(story.slug, "images/hero.png"), "hero");
    const job = seedJob(story, { masterRef: "images/hero.png", longShots: [shot(0, { truth: "archive", archiveQuery: "q" })], shortShots: [] });

    await runJob(job.id);
    const s = (getJob(job.id)!.scratch as any).longShots[0];
    expect(s.truth).toBe("reconstruction");
    expect(s.path).toBe("images/long-00.png");
    expect(calls(story.slug, "images/long-00.png")).toBe(1);
    expect(getJob(job.id)!.spent).toBe(PRICING.openai.image);
  });

  test("an archive shot is budget-checked for its possible fallback before acquisition", async () => {
    const story = makeStory();
    writeFileSync(inStory(story.slug, "images/hero.png"), "hero");
    const job = seedJob(story, { masterRef: "images/hero.png", approvedMax: 0.05, longShots: [shot(0, { truth: "archive", archiveQuery: "q" })], shortShots: [] });

    await expect(runJob(job.id)).rejects.toThrow(/Approved maximum/);
    expect(h.imageCalls).toEqual([]);
    expect(getJob(job.id)!.spent).toBe(0);
  });
});

describe("visual preview shows both films", () => {
  const story = { slug: "preview-story" } as Story;
  const longShots = [shot(0, { path: "images/long-00.png" }), shot(1, { path: "images/long-01.png", wantsMotion: true })] as any[];
  const shortShots = [shot(0, { path: "images/short-00.png", truth: "graphic" })] as any[];

  test("includes Long and Short frames, each tagged with its film", () => {
    const p = buildPreview(story, longShots, shortShots);
    expect(p.frames.map((f) => [f.kind, f.path])).toEqual([
      ["long", "stories/preview-story/images/long-00.png"],
      ["long", "stories/preview-story/images/long-01.png"],
      ["short", "stories/preview-story/images/short-00.png"],
    ]);
    expect(p.moments).toBe(3);
  });

  test("renders a landscape Long section and a portrait Short section", () => {
    const p = buildPreview(story, longShots, shortShots);
    const props = { preview: p, version: 0, onBack() {}, onContinue() {}, onRebuild() {}, continuing: false, rebuilding: false, regen: { running: null, failed: null, done: null } };
    const films = { long: buildFilm(p, "long"), short: buildFilm(p, "short") };
    const longHtml = renderToStaticMarkup(React.createElement(VisualReview, props));
    const shortState = reviewReducer(initialReview(p), { type: "film", film: "short" });
    const shortHtml = renderToStaticMarkup(React.createElement(ReviewView, { ...props, films, state: shortState, dispatch() {} }));
    // One film at a time: Long by default as a 16:9 stage, Short as a 9:16 stage.
    expect(longHtml).toContain('data-review-film="long"');
    expect(longHtml).toContain('data-stage="long"');
    expect(longHtml).toMatch(/data-stage="long"[^>]*aspect-video/);
    expect(longHtml.match(/data-strip="/g)?.length).toBe(2); // the Long slots only
    expect(shortHtml).toContain('data-review-film="short"');
    expect(shortHtml).toMatch(/data-stage="short"[^>]*aspect-\[9\/16\]/);
    expect(shortHtml).not.toContain('data-stage="long"');
    expect(shortHtml.match(/data-strip="/g)?.length).toBe(1);
    expect(shortHtml).toContain("Generated graphic");
  });
});
