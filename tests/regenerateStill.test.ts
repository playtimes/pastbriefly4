import { describe, test, expect, vi, beforeAll, beforeEach } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, readdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import type { Story } from "../src/types.ts";

// Regenerate ONE generated owner still at the visual preview gate, from its exact
// stored PlannedShot. Live mode so spend is tracked; every provider is a fake.
const tmp = mkdtempSync(path.join(os.tmpdir(), "pb4-regen-still-"));
process.env.PROVIDER_MODE = "live";
process.env.OPENAI_API_KEY = "test-key";
process.env.PB4_DATA_DIR = path.join(tmp, "data");
process.env.PB4_MEDIA_DIR = path.join(tmp, "media");

const h = vi.hoisted(() => ({
  images: [] as Array<{ prompt: string; size: string; outPath: string; referencePaths?: string[] }>,
  fail: false,
  other: 0, // any other provider, motion or render call
}));

vi.mock("../src/providers/openai.ts", async () => {
  const { mkdirSync, writeFileSync } = await import("node:fs");
  const nodePath = await import("node:path");
  return {
    respondJson: vi.fn(async () => {
      h.other++;
      throw new Error("no planning call expected");
    }),
    imageMimeType: () => "image/png",
    generateImageFile: vi.fn(async (opts: { prompt: string; size: string; outPath: string; referencePaths?: string[] }) => {
      h.images.push(opts);
      if (h.fail) throw new Error("OpenAI image generation failed (500)");
      mkdirSync(nodePath.dirname(opts.outPath), { recursive: true });
      writeFileSync(opts.outPath, "new");
    }),
  };
});
vi.mock("../src/providers/runway.ts", () => ({ generateMotion: vi.fn(async () => void h.other++) }));
vi.mock("../src/production/wikimedia.ts", () => ({ fetchArchive: vi.fn(async () => (h.other++, null)) }));
vi.mock("../src/render/renderVideo.ts", () => ({
  renderFilms: vi.fn(async () => void h.other++),
  probeVideo: vi.fn(() => (h.other++, { width: 0, height: 0, durationSec: 0, fps: 30, hasAudio: false })),
}));

const Fastify = (await import("fastify")).default;
const { registerRoutes } = await import("../src/server/routes.ts");
const { regenerateStill, newJobId } = await import("../src/production/generate.ts");
const { createJob, getJob, updateJob, upsertStory } = await import("../src/server/store.ts");
const { ensureStoryDirs, inStory } = await import("../src/production/paths.ts");
const { PRICING, round } = await import("../src/server/pricing.ts");

let app: FastifyInstance;
beforeAll(async () => {
  app = Fastify();
  await registerRoutes(app);
  await app.ready();
});
beforeEach(() => {
  h.images = [];
  h.fail = false;
  h.other = 0;
});

function shot(index: number, over: Record<string, unknown>) {
  return {
    index, edit: "new", assetId: `L0${index}`, presentation: "base", framing: "wide", startSec: index * 3, endSec: index * 3 + 3,
    truth: "reconstruction", motion: "hold", wantsMotion: false, prompt: `stored prompt ${index}`, purpose: `purpose ${index}`,
    mustShow: [], mustNotShow: [], wordStart: 0, wordEnd: 0, mediaType: "image", ...over,
  };
}

// Long: 0 reconstruction owner (useMaster), 1 archive owner, 2 reuse of 0 (a detail),
// 3 graphic owner, 4 reuse of 0 again. Short: 0 reconstruction owner.
let seq = 0;
function seed(state = "awaiting_preview") {
  const slug = `regen-still-${seq++}`;
  const story: Story = {
    id: slug, slug, title: "Regen", hook: "A hook.", category: "Disasters", year: "1981", place: "Somewhere", summary: "S",
    heroImage: null, moments: [], sources: [], productionNote: "", createdAt: new Date().toISOString(),
  };
  upsertStory(story);
  ensureStoryDirs(slug);
  const files = ["images/hero.png", "images/long-00.png", "archive/long-01.jpg", "images/long-03.png", "images/short-00.png"];
  for (const rel of files) writeFileSync(inStory(slug, rel), `old ${rel}`);
  const longShots = [
    shot(0, { path: "images/long-00.png", useMaster: true, wantsMotion: true }),
    shot(1, { truth: "archive", path: "archive/long-01.jpg", archiveQuery: "q", source: "Wikimedia" }),
    shot(2, { edit: "reuse", assetId: "L00", assetShot: 0, presentation: "detail-left", path: "images/long-00.png" }),
    shot(3, { truth: "graphic", assetId: "L03", path: "images/long-03.png" }),
    shot(4, { edit: "reuse", assetId: "L00", assetShot: 0, path: "images/long-00.png" }),
  ];
  const shortShots = [shot(0, { assetId: "S00", path: "images/short-00.png" })];
  const job = createJob({ id: newJobId(), storyId: story.id, mock: false, estimatedCost: 5, approvedMax: 10 });
  const scratch = { research: { summary: "R" }, scripts: { long: "L", short: "S" }, textApproved: true, masterRef: "images/hero.png", spent: 4, longShots, shortShots };
  updateJob(job.id, { scratch: scratch as any, spent: 4, state: state as any, step: "preview", previewApproved: false, preview: { frames: [] } as any });
  return { job, slug };
}

const post = (id: string, payload: unknown) => app.inject({ method: "POST", url: `/api/jobs/${id}/regenerate-still`, payload });
const plan = (id: string) => {
  const s = getJob(id)!.scratch;
  // Everything but the acquired media fields must be identical before and after.
  const strip = (x: any) => ({ ...x, path: undefined, mediaType: undefined });
  return JSON.stringify([s.longShots.map(strip), s.shortShots.map(strip), s.research, s.scripts, s.masterRef]);
};

describe("regenerate one owner still", () => {
  test("regenerates exactly one owner from its stored plan and charges one image", async () => {
    const { job, slug } = seed();
    const before = plan(job.id);

    const res = await post(job.id, { kind: "long", slot: 0 });
    expect(res.statusCode).toBe(200);

    // One image call, from the stored prompt, framing and master rule, to the same file.
    expect(h.images).toHaveLength(1);
    expect(h.images[0].prompt).toBe("stored prompt 0");
    expect(h.images[0].size).toBe("1536x1024");
    expect(h.images[0].outPath).toBe(inStory(slug, "images/long-00.png"));
    expect(h.images[0].referencePaths).toContain(inStory(slug, "images/hero.png")); // useMaster kept
    expect(readFileSync(inStory(slug, "images/long-00.png"), "utf8")).toBe("new");

    // Only that asset changed on disk; no backup left behind.
    expect(readFileSync(inStory(slug, "images/long-03.png"), "utf8")).toBe("old images/long-03.png");
    expect(readFileSync(inStory(slug, "archive/long-01.jpg"), "utf8")).toBe("old archive/long-01.jpg");
    expect(readFileSync(inStory(slug, "images/short-00.png"), "utf8")).toBe("old images/short-00.png");
    expect(readFileSync(inStory(slug, "images/hero.png"), "utf8")).toBe("old images/hero.png");
    expect(readdirSync(inStory(slug, "images")).filter((f) => f.endsWith(".prev"))).toEqual([]);

    const after = getJob(job.id)!;
    expect(after.id).toBe(job.id); // same job
    expect(plan(job.id)).toBe(before); // same plan: no re-planning
    expect(after.spent).toBe(round(4 + PRICING.openai.image)); // exactly one $0.08 image
    expect(after.state).toBe("awaiting_preview");
    expect(after.previewApproved).toBe(false);

    // Every reuse of the asset shows the refreshed owner still, and the preview is rebuilt.
    const long = after.scratch.longShots;
    expect(long[2].path).toBe("images/long-00.png");
    expect(long[4].path).toBe("images/long-00.png");
    const frames = after.preview!.frames.filter((f) => f.kind === "long");
    expect(frames).toHaveLength(5);
    expect(frames.find((f) => f.slot === 0)).toMatchObject({ edit: "new", path: `stories/${slug}/images/long-00.png` });
    expect(frames.filter((f) => f.path === `stories/${slug}/images/long-00.png`).map((f) => f.slot)).toEqual([0, 2, 4]);

    // No motion, render, archive or planning call.
    expect(h.other).toBe(0);
    expect(long[0].motionPath).toBeUndefined();
  });

  test("a graphic owner can be regenerated too (no references)", async () => {
    const { job, slug } = seed();
    expect((await post(job.id, { kind: "long", slot: 3 })).statusCode).toBe(200);
    expect(h.images).toHaveLength(1);
    expect(h.images[0].prompt).toBe("stored prompt 3");
    expect(h.images[0].referencePaths).toBeUndefined();
    expect(readFileSync(inStory(slug, "images/long-00.png"), "utf8")).toBe("old images/long-00.png");
  });

  test("a Short owner regenerates at portrait size", async () => {
    const { job } = seed();
    expect((await post(job.id, { kind: "short", slot: 0 })).statusCode).toBe(200);
    expect(h.images.map((i) => i.size)).toEqual(["1024x1536"]);
  });

  test("a reuse slot cannot trigger generation", async () => {
    const { job } = seed();
    const res = await post(job.id, { kind: "long", slot: 2 });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/reuses asset L00/);
    expect(h.images).toHaveLength(0);
    expect(getJob(job.id)!.spent).toBe(4);
  });

  test("a genuine archive owner cannot trigger generation", async () => {
    const { job, slug } = seed();
    const res = await post(job.id, { kind: "long", slot: 1 });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/archive/);
    expect(h.images).toHaveLength(0);
    expect(existsSync(inStory(slug, "archive/long-01.jpg"))).toBe(true);
  });

  test("only an awaiting_preview job can regenerate", async () => {
    for (const state of ["running", "queued", "done", "failed", "awaiting_text"]) {
      const { job } = seed(state);
      const res = await post(job.id, { kind: "long", slot: 0 });
      expect(res.statusCode).toBe(409);
      await expect(regenerateStill(job.id, "long", 0)).rejects.toThrow(/visual preview/);
      expect(getJob(job.id)!.state).toBe(state);
    }
    expect(h.images).toHaveLength(0);
  });

  test("an unknown slot or bad payload is refused", async () => {
    const { job } = seed();
    expect((await post(job.id, { kind: "long", slot: 99 })).statusCode).toBe(400);
    expect((await post(job.id, { kind: "wide", slot: 0 })).statusCode).toBe(400);
    expect((await post(job.id, { kind: "long" })).statusCode).toBe(400);
    expect(h.images).toHaveLength(0);
  });

  test("the budget preflight refuses before any call or file change", async () => {
    const { job, slug } = seed();
    updateJob(job.id, { approvedMax: 4.05 });
    const res = await post(job.id, { kind: "long", slot: 0 });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/Approved maximum/);
    expect(h.images).toHaveLength(0);
    expect(readFileSync(inStory(slug, "images/long-00.png"), "utf8")).toBe("old images/long-00.png");
    expect(getJob(job.id)!.spent).toBe(4);
  });

  test("a failed generation restores the old still and changes nothing", async () => {
    const { job, slug } = seed();
    const before = getJob(job.id)!;
    h.fail = true;
    const res = await post(job.id, { kind: "long", slot: 0 });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/image generation failed/);

    expect(readFileSync(inStory(slug, "images/long-00.png"), "utf8")).toBe("old images/long-00.png");
    expect(readdirSync(inStory(slug, "images")).filter((f) => f.endsWith(".prev"))).toEqual([]);
    const after = getJob(job.id)!;
    expect(after.scratch).toEqual(before.scratch); // plan and paths untouched
    expect(after.spent).toBe(4); // nothing charged
    expect(after.state).toBe("awaiting_preview");
    expect(after.previewApproved).toBe(false);

    // Recoverable: the same request succeeds once the provider works again.
    h.fail = false;
    expect((await post(job.id, { kind: "long", slot: 0 })).statusCode).toBe(200);
    expect(getJob(job.id)!.spent).toBe(round(4 + PRICING.openai.image));
  });
});

describe("Regenerate still button", () => {
  test("appears only on generated owner frames, and only with a handler", async () => {
    const React = (await import("react")).default;
    const { renderToStaticMarkup } = await import("react-dom/server");
    const { PreviewFrames } = await import("../src/app/previewFrames.tsx");
    const { buildPreview } = await import("../src/production/visuals.ts");
    const { job } = seed();
    const s = getJob(job.id)!.scratch;
    const { frames } = buildPreview({ slug: "x" } as Story, s.longShots, s.shortShots);

    const count = (html: string, text: string) => html.split(text).length - 1;
    const withButton = renderToStaticMarkup(React.createElement(PreviewFrames, { frames, onRegenerate: () => {} }));
    // Long owners 0 (reconstruction) and 3 (graphic), Short owner 0; not archive 1 or reuses 2 and 4.
    expect(count(withButton, "Regenerate still")).toBe(3);
    const busy = renderToStaticMarkup(React.createElement(PreviewFrames, { frames, onRegenerate: () => {}, regenerating: "long-3" }));
    expect(count(busy, "Regenerating…")).toBe(1);
    expect(count(busy, "disabled")).toBe(3);
    expect(renderToStaticMarkup(React.createElement(PreviewFrames, { frames }))).not.toContain("Regenerate still");
  });
});
