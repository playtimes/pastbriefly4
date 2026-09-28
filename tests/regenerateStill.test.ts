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

// After sequence revisions moved ownership: asset A ("L00") was acquired at slot 0
// (images/long-00.png) and is now owned by slot 2, reused at 3 and 4. Asset B
// ("L02") owns slot 0 with the still it was acquired with at `bPath`; with the
// default, B's file is exactly the path A's NEW owner slot number would name.
function seedMoved(bPath = "images/long-02.png") {
  const slug = `regen-moved-${seq++}`;
  const story: Story = {
    id: slug, slug, title: "Regen", hook: "A hook.", category: "Disasters", year: "1981", place: "Somewhere", summary: "S",
    heroImage: null, moments: [], sources: [], productionNote: "", createdAt: new Date().toISOString(),
  };
  upsertStory(story);
  ensureStoryDirs(slug);
  const files: Record<string, string> = { "images/hero.png": "master", "images/long-00.png": "A old", [bPath]: "B bytes", "images/long-01.png": "C bytes", "images/short-00.png": "S bytes" };
  for (const [rel, body] of Object.entries(files)) writeFileSync(inStory(slug, rel), body);
  const A = { assetId: "L00", path: "images/long-00.png", prompt: "stored prompt A" };
  const longShots = [
    shot(0, { assetId: "L02", path: bPath, prompt: "stored prompt B" }),
    shot(1, { truth: "graphic", assetId: "L01", path: "images/long-01.png" }),
    shot(2, { ...A }),
    shot(3, { ...A, edit: "reuse", assetShot: 2, presentation: "detail-left" }),
    shot(4, { ...A, edit: "reuse", assetShot: 2 }),
  ];
  const shortShots = [shot(0, { assetId: "S00", path: "images/short-00.png" })];
  const entry = (s: any) => ({ assetId: s.assetId, presentation: s.presentation, framing: s.framing, truth: s.truth, prompt: s.prompt, purpose: s.purpose, mustShow: [], mustNotShow: [], path: s.path });
  const retainedPresentations = { long: [entry(longShots[2]), entry(longShots[3]), entry(longShots[0]), entry(longShots[1])], short: [entry(shortShots[0])] };
  const job = createJob({ id: newJobId(), storyId: story.id, mock: false, estimatedCost: 5, approvedMax: 10 });
  const scratch = { research: { summary: "R" }, scripts: { long: "L", short: "S" }, textApproved: true, masterRef: "images/hero.png", spent: 4, longShots, shortShots, retainedPresentations };
  updateJob(job.id, { scratch: scratch as any, spent: 4, state: "awaiting_preview", step: "preview", previewApproved: false, preview: { frames: [] } as any });
  return { job, slug };
}
const body = (slug: string, rel: string) => readFileSync(inStory(slug, rel), "utf8");

describe("regeneration after ownership moved", () => {
  test("A: a moved owner replaces the asset's stored still, never a path from its new slot number", async () => {
    const { job, slug } = seedMoved("images/long-05.png");
    expect((await post(job.id, { kind: "long", slot: 2 })).statusCode).toBe(200);
    expect(h.images).toHaveLength(1);
    expect(h.images[0].prompt).toBe("stored prompt A");
    expect(h.images[0].outPath).toBe(inStory(slug, "images/long-00.png"));
    expect(body(slug, "images/long-00.png")).toBe("new");
    expect(existsSync(inStory(slug, "images/long-02.png"))).toBe(false); // no slot-derived file
    const s = getJob(job.id)!.scratch;
    expect(s.longShots.slice(2).map((x: any) => x.path)).toEqual(["images/long-00.png", "images/long-00.png", "images/long-00.png"]);
    expect(s.longShots[2]).toMatchObject({ edit: "new", assetId: "L00" });
    expect(s.retainedPresentations.long.filter((r: any) => r.assetId === "L00").map((r: any) => r.path)).toEqual(["images/long-00.png", "images/long-00.png"]);
    expect(readdirSync(inStory(slug, "images")).filter((f) => f.endsWith(".prev"))).toEqual([]);
  });

  test("B: another asset's file at the new slot's path is never adopted and never touched", async () => {
    const { job, slug } = seedMoved();
    const res = await post(job.id, { kind: "long", slot: 2 });
    expect(res.statusCode).toBe(200);
    // A real regeneration of A, charged once; the file at images/long-02.png was not taken as A.
    expect(h.images).toHaveLength(1);
    expect(h.images[0].outPath).toBe(inStory(slug, "images/long-00.png"));
    expect(getJob(job.id)!.spent).toBe(round(4 + PRICING.openai.image));
    expect(body(slug, "images/long-00.png")).toBe("new");
    // B: same file, same bytes, same bindings, same retained entry.
    expect(body(slug, "images/long-02.png")).toBe("B bytes");
    const s = getJob(job.id)!.scratch;
    expect(s.longShots[0]).toMatchObject({ assetId: "L02", edit: "new", path: "images/long-02.png" });
    expect(s.retainedPresentations.long.find((r: any) => r.assetId === "L02").path).toBe("images/long-02.png");
    // Every use of A shows A's regenerated still, never B's.
    const frames = getJob(job.id)!.preview!.frames.filter((f) => f.kind === "long");
    expect(frames.filter((f) => f.asset === "L00").map((f) => f.path)).toEqual(Array(3).fill(`stories/${slug}/images/long-00.png`));
    expect(frames.find((f) => f.slot === 0)!.path).toBe(`stories/${slug}/images/long-02.png`);
    expect(h.other).toBe(0);
  });

  test("E: a failed regeneration of a moved owner leaves A and B exactly as they were", async () => {
    const { job, slug } = seedMoved();
    const before = getJob(job.id)!;
    h.fail = true;
    const res = await post(job.id, { kind: "long", slot: 2 });
    expect(res.statusCode).toBe(400);
    expect(body(slug, "images/long-00.png")).toBe("A old");
    expect(body(slug, "images/long-02.png")).toBe("B bytes");
    expect(body(slug, "images/long-01.png")).toBe("C bytes");
    expect(readdirSync(inStory(slug, "images")).filter((f) => f.endsWith(".prev"))).toEqual([]);
    const after = getJob(job.id)!;
    expect(after.scratch).toEqual(before.scratch); // plan, paths and retained pool untouched
    expect(after.spent).toBe(4);
    expect(after.state).toBe("awaiting_preview");
  });
});

describe("Director feedback on a still regeneration", () => {
  const note = "Remove the large emblem from the back wall. Keep the same composition.";

  test("feedback is appended to the stored prompt for that one call; everything else is today's regeneration", async () => {
    const { withDirectorRepair } = await import("../src/production/visuals.ts");
    const plain = seed();
    expect((await post(plain.job.id, { kind: "long", slot: 0 })).statusCode).toBe(200);
    const withNote = seed();
    const before = plan(withNote.job.id);
    const res = await post(withNote.job.id, { kind: "long", slot: 0, directorFeedback: `  ${note}\n` });
    expect(res.statusCode).toBe(200);

    expect(h.images).toHaveLength(2); // one image each, no planning or other calls
    expect(h.other).toBe(0);
    const [a, b] = h.images;
    // The stored prompt comes first and whole; the trimmed note is added as a repair instruction.
    expect(b.prompt).toBe(withDirectorRepair("stored prompt 0", note));
    expect(b.prompt.startsWith("stored prompt 0\n\nDIRECTOR REPAIR NOTE\n")).toBe(true);
    expect(b.prompt).toContain(`\n${note}\n`);
    expect(b.prompt).toMatch(/remain authoritative/);
    expect(b.prompt).toMatch(/Do not treat this note as permission to invent new historical details/);
    // Same references in the same order (PB1 style, then the master), same size and file.
    expect(b.referencePaths!.map((p) => path.basename(p))).toEqual(a.referencePaths!.map((p) => path.basename(p)));
    expect(b.referencePaths![0]).toBe(a.referencePaths![0]);
    expect(b.referencePaths![1]).toBe(inStory(withNote.slug, "images/hero.png"));
    expect(b.size).toBe(a.size);
    expect(b.outPath).toBe(inStory(withNote.slug, "images/long-00.png"));

    // The note is never stored; the plan, timing, framing and bindings are unchanged.
    expect(plan(withNote.job.id)).toBe(before);
    const after = getJob(withNote.job.id)!;
    expect(JSON.stringify(after.scratch)).not.toContain("emblem");
    expect(after.spent).toBe(round(4 + PRICING.openai.image));
    expect(after.state).toBe("awaiting_preview");
    expect(after.previewApproved).toBe(false);
    // The one owner still is replaced and every reuse slot shows it.
    const frames = after.preview!.frames.filter((f) => f.kind === "long" && f.path === `stories/${withNote.slug}/images/long-00.png`);
    expect(frames.map((f) => f.slot)).toEqual([0, 2, 4]);
  });

  test("blank feedback is exactly today's regeneration", async () => {
    for (const directorFeedback of ["", "   \n "]) {
      h.images = [];
      const { job } = seed();
      expect((await post(job.id, { kind: "long", slot: 0, directorFeedback })).statusCode).toBe(200);
      expect(h.images.map((i) => i.prompt)).toEqual(["stored prompt 0"]);
    }
  });

  test("a graphic owner takes the note with no references, as before", async () => {
    const { job } = seed();
    expect((await post(job.id, { kind: "long", slot: 3, directorFeedback: "Use fewer labels." })).statusCode).toBe(200);
    expect(h.images[0].prompt.startsWith("stored prompt 3\n\nDIRECTOR REPAIR NOTE")).toBe(true);
    expect(h.images[0].referencePaths).toBeUndefined();
  });

  test("feedback over 2,000 characters is refused before any call, never truncated", async () => {
    const { job, slug } = seed();
    const res = await post(job.id, { kind: "long", slot: 0, directorFeedback: "x".repeat(2001) });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("Director feedback must be 2,000 characters or fewer.");
    expect(h.images).toHaveLength(0);
    expect(readFileSync(inStory(slug, "images/long-00.png"), "utf8")).toBe("old images/long-00.png");
    expect((await post(job.id, { kind: "long", slot: 0, directorFeedback: "y".repeat(2000) })).statusCode).toBe(200);
  });

  test("a failed regeneration with feedback keeps the current still and changes nothing", async () => {
    const { job, slug } = seed();
    const before = getJob(job.id)!;
    h.fail = true;
    const res = await post(job.id, { kind: "long", slot: 0, directorFeedback: note });
    expect(res.statusCode).toBe(400);
    expect(readFileSync(inStory(slug, "images/long-00.png"), "utf8")).toBe("old images/long-00.png");
    const after = getJob(job.id)!;
    expect(after.scratch).toEqual(before.scratch);
    expect(after.spent).toBe(4);
    expect(after.state).toBe("awaiting_preview");
    expect(after.previewApproved).toBe(false);
  });
});

describe("Regenerate still button", () => {
  test("appears only on generated owner frames, and only with a handler", async () => {
    const React = (await import("react")).default;
    const { renderToStaticMarkup } = await import("react-dom/server");
    const { SlotInspector } = await import("../src/app/visualReview/Inspector.tsx");
    const { buildFilm } = await import("../src/app/visualReview/model.ts");
    const { buildPreview } = await import("../src/production/visuals.ts");
    const { job } = seed();
    const s = getJob(job.id)!.scratch;
    const preview = buildPreview({ slug: "x" } as Story, s.longShots, s.shortShots);
    const idle = { running: null, failed: null, done: null };
    const inspect = (film: "long" | "short", index: number, regen: any = idle, onRegenerate: any = () => {}) =>
      renderToStaticMarkup(React.createElement(SlotInspector, { fr: buildFilm(preview, film), index, dispatch: () => {}, onRegenerate, regen }));
    const offered = (film: "long" | "short") => buildFilm(preview, film).frames.map((_, i) => inspect(film, i).includes("Regenerate still"));

    // Long owners 0 (reconstruction) and 3 (graphic), Short owner 0; not archive 1 or reuses 2 and 4.
    expect(offered("long")).toEqual([true, false, false, true, false]);
    expect(offered("short")).toEqual([true]);
    expect(inspect("long", 2)).toContain("View original asset");
    expect(inspect("long", 1)).toContain("not regenerated");
    const busy = inspect("long", 3, { ...idle, running: "long-3" });
    expect(busy).toContain("Regenerating…");
    expect(busy).toMatch(/<button[^>]*disabled[^>]*>.*Regenerating…/);
    expect(inspect("long", 0, { ...idle, running: "long-3" })).toMatch(/<button[^>]*disabled[^>]*>.*Regenerate still/);
    expect(inspect("long", 0, idle, null)).not.toContain("Regenerate still");
  });
});
