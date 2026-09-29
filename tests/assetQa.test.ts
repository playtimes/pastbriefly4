import { describe, test, expect, vi, beforeAll, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import type { Story } from "../src/types.ts";

// Pixel-aware Asset QA v1 at the visual preview gate. Live mode so spend is
// tracked; the vision model, image generation, motion and archive providers are
// fakes. Every still is a small local file whose bytes name its version.
const tmp = mkdtempSync(path.join(os.tmpdir(), "pb4-asset-qa-"));
process.env.PROVIDER_MODE = "live";
process.env.OPENAI_API_KEY = "test-key";
process.env.PB4_DATA_DIR = path.join(tmp, "data");
process.env.PB4_MEDIA_DIR = path.join(tmp, "media");

type Call = { schemaName: string; input: string; instructions: string; schema: any; images: { label: string; data: string; mimeType: string }[] };
const h = vi.hoisted(() => ({
  calls: [] as any[],
  // Per call: the answer for this schema, or an Error to throw.
  answer: null as null | ((o: any) => unknown),
  images: [] as { prompt: string; outPath: string }[],
  imageFail: 0, // fail this many image generations first
  other: 0,
  hold: null as null | Promise<void>,
}));

vi.mock("../src/providers/openai.ts", async () => {
  const { mkdirSync, writeFileSync } = await import("node:fs");
  const nodePath = await import("node:path");
  return {
    respondJson: vi.fn(async (o: any) => {
      h.calls.push({ ...o, images: (o.images ?? []).map((i: any) => ({ label: i.label, data: i.data.toString("utf8"), mimeType: i.mimeType })) });
      if (h.hold) await h.hold;
      if (o.schemaName !== "asset_qa" && o.schemaName !== "asset_verify") throw new Error(`unexpected provider call ${o.schemaName}`);
      const out = h.answer ? h.answer(o) : undefined;
      if (out instanceof Error) throw out;
      return out ?? passAll(o);
    }),
    imageMimeType: (p: string) => (p.endsWith(".png") ? "image/png" : "image/jpeg"),
    generateImageFile: vi.fn(async (opts: { prompt: string; outPath: string }) => {
      h.images.push(opts);
      if (h.imageFail > 0) {
        h.imageFail--;
        throw new Error("OpenAI image generation failed (500)");
      }
      mkdirSync(nodePath.dirname(opts.outPath), { recursive: true });
      writeFileSync(opts.outPath, `regenerated ${h.images.length}`);
    }),
  };
});
vi.mock("../src/providers/runway.ts", () => ({ generateMotion: vi.fn(async () => void h.other++) }));
vi.mock("../src/production/wikimedia.ts", () => ({ fetchArchive: vi.fn(async () => (h.other++, null)) }));
vi.mock("../src/render/renderVideo.ts", () => ({
  renderFilms: vi.fn(async () => void h.other++),
  probeVideo: vi.fn(() => (h.other++, { width: 0, height: 0, durationSec: 0, fps: 30, hasAudio: false })),
}));

// Every supplied asset passes (the shape each schema asks for).
function passAll(o: any) {
  const ids = Object.keys(o.schema.properties.assets.properties);
  const verify = o.schemaName === "asset_verify";
  return { assets: Object.fromEntries(ids.map((id) => [id, verify ? { decision: "PASS", reason: "" } : { decision: "PASS", reason: "", repairFeedback: null }])), summary: "Fine." };
}
// Answer with specific verdicts for some assets; every other asset passes.
const answering = (verdicts: Record<string, unknown>) => (o: any) => {
  const base = passAll(o);
  for (const [id, v] of Object.entries(verdicts)) if (id in base.assets) (base.assets as any)[id] = v;
  return base;
};

const Fastify = (await import("fastify")).default;
const { registerRoutes } = await import("../src/server/routes.ts");
const { autoAssetQaForJob, runJob, regenerateStill, clearVisualsForRebuild, newJobId, isAssetQaRunning } = await import("../src/production/generate.ts");
const aq = await import("../src/production/assetQa.ts");
const { withDirectorRepair, buildPreview, planSlots } = await import("../src/production/visuals.ts");
const { createJob, getJob, updateJob, upsertStory } = await import("../src/server/store.ts");
const { ensureStoryDirs, inStory } = await import("../src/production/paths.ts");
const { assetReviewUsd, PRICING, round } = await import("../src/server/pricing.ts");
const { setMode } = await import("../src/server/config.ts");

let app: FastifyInstance;
beforeAll(async () => {
  app = Fastify();
  await registerRoutes(app);
  await app.ready();
});
beforeEach(() => {
  h.calls = [];
  h.answer = null;
  h.images = [];
  h.imageFail = 0;
  h.other = 0;
  h.hold = null;
});

function shot(index: number, over: Record<string, unknown>) {
  return {
    index, edit: "new", assetId: `L0${index}`, presentation: "base", framing: "wide", startSec: index * 3, endSec: index * 3 + 3,
    truth: "reconstruction", motion: "hold", wantsMotion: false, prompt: `stored prompt ${index}`, purpose: `purpose ${index}`,
    mustShow: [`shows ${index}`], mustNotShow: [`no text ${index}`], wordStart: 0, wordEnd: 0, mediaType: "image", ...over,
  };
}
// Scripts and narration whose fixed slot grids (planSlots) are 7 Long slots and 2
// Short slots: the saved shots sit on that grid, as planning puts them.
const SENTENCES = ["The bats flew out over the desert at dawn.", "Nobody expected what came next that night.", "The hangar caught fire within minutes.", "Firemen raced across the airfield.", "The general was not amused at all.", "The project moved to a new site.", "It was cancelled a year later.", "The bats were never used in the war."];
const SCRIPTS = { long: SENTENCES.join(" "), short: SENTENCES.slice(0, 2).join(" ") };
const narration = (kind: "long" | "short") => {
  const words = SCRIPTS[kind].split(" ");
  return { audioRel: `audio/${kind}.mp3`, audioMediaRel: `m/${kind}`, durationSec: words.length * 0.4, words: words.map((word, i) => ({ word, start: i * 0.4, end: i * 0.4 + 0.35 })) };
};
const onGrid = (kind: "long" | "short", shots: any[]) => {
  const slots = planSlots(kind, SCRIPTS[kind], narration(kind) as any);
  if (slots.length !== shots.length) throw new Error(`fixture: ${kind} has ${shots.length} shots for ${slots.length} slots`);
  return shots.map((s, i) => ({ ...s, startSec: slots[i].startSec, endSec: slots[i].endSec }));
};
const entry = (s: any) => ({ assetId: s.assetId, presentation: s.presentation, framing: s.framing, truth: s.truth, prompt: s.prompt, purpose: s.purpose, mustShow: s.mustShow, mustNotShow: s.mustNotShow, path: s.path });

// Long: L00 reconstruction owner (reused at 2 as a detail and at 4), L01 archive,
// L03 graphic, L05 and L06 reconstructions: five owners, two batches. Short: S00
// (reused at 1 as a detail, never the identical presentation twice in a row).
// The retained pool also holds L09, which no slot shows now.
let seq = 0;
function seed(opts: { approvedMax?: number } = {}) {
  const slug = `asset-qa-${seq++}`;
  const story: Story = {
    id: slug, slug, title: "A Neutral Story", hook: "A hook.", category: "Disasters", year: "1967", place: "Somewhere", summary: "S",
    heroImage: null, moments: [], sources: [], productionNote: "", createdAt: new Date().toISOString(),
  };
  upsertStory(story);
  ensureStoryDirs(slug);
  const files = ["images/hero.png", "images/long-00.png", "archive/long-01.jpg", "images/long-03.png", "images/long-05.png", "images/long-06.png", "images/long-09.png", "images/short-00.png"];
  for (const rel of files) writeFileSync(inStory(slug, rel), `v1 ${rel}`);
  const L00 = { assetId: "L00", path: "images/long-00.png", prompt: "stored prompt 0", purpose: "purpose 0", mustShow: ["shows 0"], mustNotShow: ["no text 0"] };
  const longShots = onGrid("long", [
    shot(0, { ...L00, caption: { text: "The switch" } }),
    shot(1, { truth: "archive", path: "archive/long-01.jpg", archiveQuery: "street 1967", source: "Wikimedia Commons" }),
    shot(2, { ...L00, edit: "reuse", assetShot: 0, presentation: "detail-left", framing: "detail-left", focus: "the left sign" }),
    shot(3, { truth: "graphic", path: "images/long-03.png" }),
    shot(4, { ...L00, edit: "reuse", assetShot: 0 }),
    shot(5, { path: "images/long-05.png" }),
    shot(6, { path: "images/long-06.png" }),
  ]);
  const shortShots = onGrid("short", [
    shot(0, { assetId: "S00", path: "images/short-00.png" }),
    shot(1, { assetId: "S00", edit: "reuse", assetShot: 0, presentation: "detail-left", framing: "detail-left", focus: "the left sign", path: "images/short-00.png" }),
  ]);
  const unique = (list: any[]) => list.filter((s, i) => list.findIndex((x) => x.assetId === s.assetId && x.presentation === s.presentation) === i).map(entry);
  const retainedPresentations = { long: [...unique(longShots), entry(shot(9, { path: "images/long-09.png" }))], short: unique(shortShots) };
  const job = createJob({ id: newJobId(), storyId: story.id, mock: false, estimatedCost: 5, approvedMax: opts.approvedMax ?? 10 });
  const scratch = { research: { summary: "R" }, scripts: SCRIPTS, textApproved: true, narration: { long: narration("long"), short: narration("short") }, masterRef: "images/hero.png", spent: 4, longShots, shortShots, retainedPresentations };
  updateJob(job.id, { scratch: scratch as any, spent: 4, state: "awaiting_preview", step: "preview", previewApproved: false, preview: buildPreview(story, longShots as any, shortShots as any) });
  return { job, story, slug };
}

const reviews = () => h.calls.filter((c) => c.schemaName === "asset_qa") as Call[];
const verifies = () => h.calls.filter((c) => c.schemaName === "asset_verify") as Call[];
const idsOf = (c: Call) => Object.keys(c.schema.properties.assets.properties);
const body = (slug: string, rel: string) => readFileSync(inStory(slug, rel), "utf8");
const scratchOf = (id: string) => getJob(id)!.scratch as any;
// The two long dashes, built so this file itself contains neither.
const LONG_DASH = String.fromCharCode(0x2013, 0x2014);
const plain = (html: string) => html.replace(/<!-- -->/g, "");
const FEEDBACK = "Remove the unsupported lettering on the sign; keep the street and the vehicles as they are.";

describe("Asset QA: basic pass", () => {
  test("every unique current owner still is reviewed once, per film, in batches of four; PASS changes nothing", async () => {
    const { job, slug } = seed();
    const before = JSON.stringify({ l: scratchOf(job.id).longShots, s: scratchOf(job.id).shortShots, r: scratchOf(job.id).retainedPresentations });
    const result = await autoAssetQaForJob(job.id);

    expect(reviews().map(idsOf)).toEqual([["L00", "L01", "L03", "L05"], ["L06"], ["S00"]]); // reuses never sent twice; Long and Short apart
    expect(reviews().flatMap(idsOf)).not.toContain("L09"); // retained zero-use media is not part of the film
    expect(verifies()).toEqual([]);
    // The ACTUAL saved bytes, each labelled with its own asset id.
    const first = reviews()[0];
    expect(first.images.map((i) => i.data)).toEqual(["v1 images/long-00.png", "v1 archive/long-01.jpg", "v1 images/long-03.png", "v1 images/long-05.png"]);
    expect(first.images[0].label).toBe("IMAGE for asset L00 (LONG, generated reconstruction):");
    expect(first.images[1]).toMatchObject({ label: "IMAGE for asset L01 (LONG, archive photograph (authentic source, read only)):", mimeType: "image/jpeg" });
    expect(first.instructions).toBe(aq.PIXEL_QA_INSTRUCTIONS);
    // Identity, intent and current use; archive cannot be answered REGENERATE.
    expect(first.input).toContain("STORY: A Neutral Story (1967, Somewhere)");
    expect(first.input).toContain("ASSET L00\nfilm: LONG\ntype: generated reconstruction\nautomatic regeneration: available");
    expect(first.input).toContain("generation prompt: stored prompt 0");
    expect(first.input).toContain("must show: shows 0\nmust not show: no text 0");
    expect(first.input).toContain("detail crops the film uses: the left sign");
    expect(first.input).toContain('current use: slots 00, 02, 04; captions "The switch"');
    expect(first.input).toContain("archive search: street 1967\nsource: Wikimedia Commons");
    expect(first.input).toContain("automatic regeneration: NOT available");
    expect(first.schema.properties.assets.properties.L01.properties.decision.enum).toEqual(["PASS", "HUMAN_REVIEW"]);
    expect(first.schema.properties.assets.properties.L00.properties.decision.enum).toEqual(["PASS", "REGENERATE", "HUMAN_REVIEW"]);
    expect(reviews()[2].input).not.toMatch(/ASSET L0/);

    expect(result).toMatchObject({ status: "done", reviewed: 6, regenerated: 0, incomplete: 0, issues: [], message: "Asset QA passed." });
    expect(h.images).toEqual([]);
    expect(JSON.stringify({ l: scratchOf(job.id).longShots, s: scratchOf(job.id).shortShots, r: scratchOf(job.id).retainedPresentations })).toBe(before);
    expect(body(slug, "images/long-00.png")).toBe("v1 images/long-00.png");
    const after = getJob(job.id)!;
    expect(after.state).toBe("awaiting_preview"); // left at the Visual Preview...
    expect(after.previewApproved).toBe(false); // ...and never approved
    expect(after.spent).toBe(round(4 + assetReviewUsd(4) + assetReviewUsd(1) + assetReviewUsd(1)));
    const pub = (await app.inject({ method: "GET", url: `/api/jobs/${job.id}` })).json().job;
    expect(pub.assetQa).toMatchObject({ status: "done", message: "Asset QA passed." });
    expect(h.other).toBe(0);
  });
});

describe("Asset QA: a generated defect", () => {
  test("REGENERATE goes once through regenerateStill with the feedback; the verifier sees the NEW bytes; PASS clears it", async () => {
    const { job, slug } = seed();
    h.answer = (o) => (o.schemaName === "asset_qa" ? answering({ L00: { decision: "REGENERATE", reason: "A large unrelated letter is painted on the wall.", repairFeedback: FEEDBACK } })(o) : passAll(o));
    const result = await autoAssetQaForJob(job.id);

    // Exactly one regeneration, of the stored prompt with the feedback as the Director note, to the asset's own file.
    expect(h.images).toHaveLength(1);
    expect(h.images[0].prompt).toBe(withDirectorRepair("stored prompt 0", FEEDBACK));
    expect(h.images[0].outPath).toBe(inStory(slug, "images/long-00.png"));
    // One verification, of the regenerated asset only, reading the new saved bytes.
    expect(verifies()).toHaveLength(1);
    const v = verifies()[0];
    expect(idsOf(v)).toEqual(["L00"]);
    expect(v.instructions).toBe(aq.PIXEL_VERIFY_INSTRUCTIONS);
    expect(v.images.map((i) => i.data)).toEqual(["regenerated 1"]);
    expect(v.input).toContain("ORIGINAL PIXEL ISSUE: A large unrelated letter is painted on the wall.");
    expect(v.input).toContain(`REPAIR NOTE THE ONE REGENERATION WAS GIVEN: ${FEEDBACK}`);
    expect(v.schema.properties.assets.properties.L00.properties.decision.enum).toEqual(["PASS", "HUMAN_REVIEW"]);

    expect(result).toMatchObject({ regenerated: 1, incomplete: 0, issues: [], message: "Asset QA passed." });
    // One source of truth: owner, reuses, retained entries, preview and verifier all show the same bytes.
    const s = scratchOf(job.id);
    expect(body(slug, "images/long-00.png")).toBe("regenerated 1");
    expect([0, 2, 4].map((i) => s.longShots[i].path)).toEqual(["images/long-00.png", "images/long-00.png", "images/long-00.png"]);
    expect(s.retainedPresentations.long.filter((r: any) => r.assetId === "L00").map((r: any) => r.path)).toEqual(["images/long-00.png", "images/long-00.png"]); // base and detail-left
    expect(getJob(job.id)!.preview!.frames.filter((f) => f.asset === "L00").map((f) => f.path)).toEqual(Array(3).fill(`stories/${slug}/images/long-00.png`));
    expect(getJob(job.id)!.spent).toBe(round(4 + assetReviewUsd(4) + assetReviewUsd(1) + assetReviewUsd(1) + PRICING.openai.image + assetReviewUsd(1)));
    expect(getJob(job.id)!.previewApproved).toBe(false);
  });

  test("a verification that still sees a problem stays a human exception; there is no second regeneration", async () => {
    const { job } = seed();
    h.answer = (o) =>
      o.schemaName === "asset_qa"
        ? answering({ L03: { decision: "REGENERATE", reason: "Corrupted pseudo-text dominates the chart.", repairFeedback: "Make the two labels legible; keep the layout." } })(o)
        : answering({ L03: { decision: "HUMAN_REVIEW", reason: "The labels are still unreadable." } })(o);
    const result = await autoAssetQaForJob(job.id);
    expect(h.images).toHaveLength(1);
    expect(verifies()).toHaveLength(1);
    expect(result!.issues).toEqual([{ kind: "long", assetId: "L03", truth: "graphic", stage: "verify", reason: "The labels are still unreadable." }]);
    expect(result!.message).toBe("Asset QA needs you for 1 asset.");
    // After a reload the exception is still there.
    const pub = (await app.inject({ method: "GET", url: `/api/jobs/${job.id}` })).json().job;
    expect(pub.assetQa.issues.map((i: any) => i.assetId)).toEqual(["L03"]);
    expect(pub.state).toBe("awaiting_preview");
  });
});

describe("Asset QA: archive stills are read only", () => {
  test("an archive defect is a human exception and never triggers an image call", async () => {
    const { job, slug } = seed();
    h.answer = answering({
      L01: { decision: "REGENERATE", reason: "A modern logo is visible in the corner.", repairFeedback: "Remove the logo." },
      L05: { decision: "HUMAN_REVIEW", reason: "It is unclear whether the lane direction is right.", repairFeedback: null },
    });
    const result = await autoAssetQaForJob(job.id);
    expect(h.images).toEqual([]);
    expect(verifies()).toEqual([]);
    expect(body(slug, "archive/long-01.jpg")).toBe("v1 archive/long-01.jpg");
    expect(result!.issues).toEqual([
      { kind: "long", assetId: "L01", truth: "archive", stage: "review", reason: "A modern logo is visible in the corner. This still cannot be regenerated automatically." },
      { kind: "long", assetId: "L05", truth: "reconstruction", stage: "review", reason: "It is unclear whether the lane direction is right." },
    ]);
  });
});

describe("Asset QA: failures", () => {
  test("a failed review call regenerates nothing, is not retried, and is logged in one line without payloads", async () => {
    const { job, slug } = seed();
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    let n = 0;
    h.answer = (o) => (n++ === 0 ? new Error("OpenAI responses 500: upstream") : o.schemaName === "asset_qa" ? answering({ L06: { decision: "REGENERATE", reason: "r", repairFeedback: "Fix the wheel." } })(o) : passAll(o));
    const result = await autoAssetQaForJob(job.id);
    const logged = log.mock.calls.map((c) => c.join(" "));
    log.mockRestore();
    expect(reviews()).toHaveLength(3); // no retry
    expect(h.images).toHaveLength(1); // only the independent L06 batch was acted on
    expect(result!.issues.filter((i) => i.incomplete).map((i) => i.assetId)).toEqual(["L00", "L01", "L03", "L05"]);
    expect(result!.message).toBe("Asset QA could not complete for 4 assets. The current visuals are unchanged.");
    expect(body(slug, "images/long-00.png")).toBe("v1 images/long-00.png");
    expect(logged).toEqual([`Asset QA failed job=${job.id} stage=review asset=long:L00,L01,L03,L05 error=OpenAI responses 500: upstream`]);
  });

  test("a malformed review answer is a failed batch: nothing is regenerated", async () => {
    const { job } = seed();
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    h.answer = (o) => ({ ...passAll(o), assets: { ...passAll(o).assets, L77: { decision: "PASS", reason: "", repairFeedback: null }, L00: { decision: "REGENERATE", reason: "x", repairFeedback: "y" } } });
    const result = await autoAssetQaForJob(job.id);
    const logged = log.mock.calls.map((c) => c.join(" "));
    log.mockRestore();
    expect(h.images).toEqual([]);
    expect(result!.incomplete).toBe(6);
    expect(logged[0]).toMatch(/stage=review asset=long:L00,L01,L03,L05 error=Invalid Asset QA review: asset "L77" was not reviewed in this batch\./);
  });

  test("a failed regeneration keeps the old still, is not retried, and other assets carry on", async () => {
    const { job, slug } = seed();
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    h.imageFail = 1;
    h.answer = (o) =>
      o.schemaName === "asset_qa"
        ? answering({
            L00: { decision: "REGENERATE", reason: "The bus is fused with the lamp post.", repairFeedback: "Separate the bus from the lamp post." },
            S00: { decision: "REGENERATE", reason: "Garbled sign text.", repairFeedback: "Remove the sign text." },
          })(o)
        : passAll(o);
    const result = await autoAssetQaForJob(job.id);
    const logged = log.mock.calls.map((c) => c.join(" "));
    log.mockRestore();
    expect(h.images).toHaveLength(2); // one attempt each
    expect(body(slug, "images/long-00.png")).toBe("v1 images/long-00.png");
    expect(body(slug, "images/short-00.png")).toBe("regenerated 2");
    expect(verifies().map(idsOf)).toEqual([["S00"]]); // only the successful repair is verified
    expect(result!.issues).toHaveLength(1);
    expect(result!.issues[0]).toMatchObject({ assetId: "L00", stage: "regenerate" });
    expect(result!.issues[0].reason).toMatch(/^The bus is fused with the lamp post\. The automatic regeneration failed, so the previous still is kept: OpenAI image generation failed \(500\)$/);
    expect(logged).toEqual([`Asset QA failed job=${job.id} stage=regenerate asset=L00 error=OpenAI image generation failed (500)`]);
    expect(getJob(job.id)!.state).toBe("awaiting_preview");
  });

  test("a failed verification keeps the repaired still but marks its review incomplete", async () => {
    const { job, slug } = seed();
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    h.answer = (o) => (o.schemaName === "asset_qa" ? answering({ L05: { decision: "REGENERATE", reason: "r", repairFeedback: "Fix the lanes." } })(o) : new Error("OpenAI responses 503"));
    const result = await autoAssetQaForJob(job.id);
    const logged = log.mock.calls.map((c) => c.join(" "));
    log.mockRestore();
    expect(body(slug, "images/long-05.png")).toBe("regenerated 1");
    expect(verifies()).toHaveLength(1);
    expect(h.images).toHaveLength(1);
    expect(result).toMatchObject({ regenerated: 1, incomplete: 1, message: "The final verification could not complete for 1 regenerated asset." });
    expect(result!.issues).toEqual([{ kind: "long", assetId: "L05", truth: "reconstruction", stage: "verify", reason: "The still was regenerated, but its final pixel verification could not complete. Review it manually.", incomplete: true }]);
    expect(logged[0]).toBe(`Asset QA failed job=${job.id} stage=verify asset=long:L05 error=OpenAI responses 503`);
  });
});

describe("Asset QA: path safety after an ownership move", () => {
  test("a moved owner regenerates the asset's stored file; another asset's file at the slot-named path is untouched", async () => {
    const { job, slug } = seed();
    // L00 now owned by slot 2 (still images/long-00.png); L02 owns slot 0 with images/long-02.png.
    const s = scratchOf(job.id);
    writeFileSync(inStory(slug, "images/long-02.png"), "L02 bytes");
    s.longShots[0] = { ...s.longShots[0], assetId: "L02", path: "images/long-02.png", prompt: "stored prompt B" };
    s.longShots[2] = { ...s.longShots[2], edit: "new", presentation: "base", framing: "wide", assetShot: undefined };
    delete s.longShots[2].assetShot;
    s.longShots[4] = { ...s.longShots[4], assetShot: 2 };
    updateJob(job.id, { scratch: s });
    h.answer = (o) => (o.schemaName === "asset_qa" ? answering({ L00: { decision: "REGENERATE", reason: "r", repairFeedback: "Fix it." } })(o) : passAll(o));
    await autoAssetQaForJob(job.id);
    expect(h.images.map((i) => i.outPath)).toEqual([inStory(slug, "images/long-00.png")]);
    expect(body(slug, "images/long-00.png")).toBe("regenerated 1");
    expect(body(slug, "images/long-02.png")).toBe("L02 bytes");
    expect(verifies()[0].images.map((i) => i.data)).toEqual(["regenerated 1"]);
  });
});

describe("Asset QA: autopilot, persistence and concurrency", () => {
  test("production reaching the preview with new stills starts Asset QA on the server; a failed later stage never approves the preview", async () => {
    const { job } = seed();
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    updateJob(job.id, { state: "queued", step: "queued" });
    const { enqueueJob } = await import("../src/server/worker.ts");
    const { visualAutopilotState } = await import("../src/production/generate.ts");
    enqueueJob(job.id);
    // The Visual Autopilot runs Asset QA, then the Long Director QA, whose review
    // call this fake provider refuses: the Long run fails and the chain stops.
    for (let i = 0; i < 300 && (scratchOf(job.id).assetQa?.status !== "done" || visualAutopilotState(job.id)); i++) await new Promise((r) => setTimeout(r, 10));
    const logged = log.mock.calls.map((c) => String(c[0]));
    log.mockRestore();
    expect(scratchOf(job.id).assetQa).toMatchObject({ status: "done", message: "Asset QA passed.", clean: true });
    expect(reviews()).toHaveLength(3);
    expect(logged.some((l) => l.startsWith(`Director QA failed job=${job.id} kind=long stage=review error=`))).toBe(true);
    expect(scratchOf(job.id).directorQa).toEqual({ long: { status: "failed", error: "unexpected provider call director_qa" } });
    expect(visualAutopilotState(job.id)).toBeUndefined();
    expect(getJob(job.id)!.state).toBe("awaiting_preview");
    expect(getJob(job.id)!.previewApproved).toBe(false);
    expect(h.other).toBe(0);
  });

  test("a finished or interrupted Asset QA never runs again, and a rebuild gets a new one", async () => {
    const { job } = seed();
    await autoAssetQaForJob(job.id);
    h.calls = [];
    expect(await autoAssetQaForJob(job.id)).toBeUndefined();
    updateJob(job.id, { state: "queued" });
    expect(await runJob(job.id)).toBeUndefined(); // the preview is reached again, but it was already reviewed
    // A restart mid-run: "started" is shown as interrupted, and nothing reruns.
    updateJob(job.id, { scratch: { ...scratchOf(job.id), assetQa: { status: "started" } } });
    expect(await autoAssetQaForJob(job.id)).toBeUndefined();
    const pub = (await app.inject({ method: "GET", url: `/api/jobs/${job.id}` })).json().job;
    expect(pub.assetQa.message).toBe("Asset QA was interrupted before it finished. Review the visuals manually.");
    expect(h.calls).toEqual([]);
    clearVisualsForRebuild(job.id);
    expect(scratchOf(job.id).assetQa).toBeUndefined();
  });

  test("runJob reports a fresh preview gate so the worker can start Asset QA", async () => {
    const { job } = seed();
    updateJob(job.id, { state: "queued" });
    expect(await runJob(job.id)).toBe("preview_gate");
    expect(h.calls).toEqual([]); // runJob itself makes no Asset QA call
  });

  test("while it runs every preview action is refused", async () => {
    const { job } = seed();
    let release!: () => void;
    h.hold = new Promise((r) => (release = r));
    const run = autoAssetQaForJob(job.id);
    await new Promise((r) => setTimeout(r, 5));
    expect(isAssetQaRunning(job.id)).toBe(true);
    const pub = (await app.inject({ method: "GET", url: `/api/jobs/${job.id}` })).json().job;
    expect(pub.assetQa).toEqual({ status: "running", phase: "review" });
    for (const [url, payload] of [
      ["continue", {}],
      ["rebuild-visuals", {}],
      ["regenerate-still", { kind: "long", slot: 0 }],
      ["revise-sequence", { kind: "long", directorFeedback: "Replace slot 01." }],
      ["director-qa", { kind: "long" }],
    ] as const) {
      const res = await app.inject({ method: "POST", url: `/api/jobs/${job.id}/${url}`, payload });
      expect(res.statusCode).toBe(409);
      expect(res.json().error).toBe("Automatic Asset QA is running. Wait for it to finish.");
    }
    expect(await autoAssetQaForJob(job.id)).toBeUndefined(); // no second run
    release();
    await run;
    expect(getJob(job.id)!.previewApproved).toBe(false);
  });

  test("a manual regeneration drops that asset's exception; a dropped asset's exception is hidden", async () => {
    const { job } = seed();
    h.answer = answering({ L03: { decision: "HUMAN_REVIEW", reason: "Odd symbol.", repairFeedback: null }, L05: { decision: "HUMAN_REVIEW", reason: "Odd lanes.", repairFeedback: null } });
    await autoAssetQaForJob(job.id);
    const res = await app.inject({ method: "POST", url: `/api/jobs/${job.id}/regenerate-still`, payload: { kind: "long", slot: 3, directorFeedback: "Remove the symbol." } });
    expect(res.statusCode).toBe(200);
    expect(res.json().job.assetQa.issues.map((i: any) => i.assetId)).toEqual(["L05"]);
    const s = scratchOf(job.id);
    s.longShots[5] = { ...s.longShots[4], index: 5, assetShot: 0 }; // L05 no longer in the film
    updateJob(job.id, { scratch: s });
    expect((await app.inject({ method: "GET", url: `/api/jobs/${job.id}` })).json().job.assetQa.issues).toEqual([]);
  });
});

describe("Asset QA: spend", () => {
  test("the spend guard runs before every vision call: a call over the approved maximum is never made", async () => {
    const { job } = seed({ approvedMax: 4.05 }); // the first batch ($0.06) would pass the cap; later ones ($0.03) fit
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const result = await autoAssetQaForJob(job.id);
    const logged = log.mock.calls.map((c) => c.join(" "));
    log.mockRestore();
    expect(reviews().map(idsOf)).toEqual([["L06"]]); // the long first batch was blocked, the S00 batch then no longer fits
    expect(result!.incomplete).toBe(5);
    expect(getJob(job.id)!.spent).toBe(4.03);
    expect(logged[0]).toMatch(/stage=review asset=long:L00,L01,L03,L05 error=Approved maximum \$4\.05 would be exceeded/);
  });

  test("mock mode reviews nothing with a model and passes, with no provider call and no spend", async () => {
    const { job } = seed();
    setMode("mock");
    try {
      const result = await autoAssetQaForJob(job.id);
      expect(result).toMatchObject({ reviewed: 6, regenerated: 0, issues: [], message: "Asset QA passed." });
    } finally {
      setMode("live");
    }
    expect(h.calls).toEqual([]);
    expect(h.images).toEqual([]);
    expect(getJob(job.id)!.spent).toBe(4);
  });

  test("the calls are bounded: ceil(N/4) reviews per film, at most one image per generated owner, ceil(R/4) verifications", async () => {
    const { job } = seed();
    h.answer = (o) =>
      o.schemaName === "asset_qa"
        ? { assets: Object.fromEntries(o.schema.properties.assets.properties && Object.entries(o.schema.properties.assets.properties).map(([id, p]: any) => [id, p.properties.decision.enum.includes("REGENERATE") ? { decision: "REGENERATE", reason: "r", repairFeedback: "Fix." } : { decision: "PASS", reason: "", repairFeedback: null }])), summary: "" }
        : answering({})(o);
    const result = await autoAssetQaForJob(job.id);
    expect(reviews()).toHaveLength(3);
    expect(h.images).toHaveLength(5); // L00, L03, L05, L06, S00; never the archive L01
    expect(verifies().map(idsOf)).toEqual([["L00", "L03", "L05", "L06"], ["S00"]]);
    expect(result).toMatchObject({ regenerated: 5, issues: [] });
  });
});

describe("Asset QA answers are read strictly", () => {
  const targets = [
    { kind: "long", assetId: "L00", owner: 0, truth: "reconstruction", path: "images/long-00.png", regenerable: true, intent: {} as any, details: [], uses: [] },
    { kind: "long", assetId: "L01", owner: 1, truth: "archive", path: "archive/long-01.jpg", regenerable: false, intent: {} as any, details: [], uses: [] },
  ] as any[];
  const ok = { decision: "PASS", reason: "", repairFeedback: null };
  test("unknown, missing and listed (duplicate-capable) answers reject the whole batch", () => {
    expect(() => aq.readAssetQa(targets, { assets: { L00: ok, L01: ok, L02: ok }, summary: "" })).toThrow(/asset "L02" was not reviewed in this batch/);
    expect(() => aq.readAssetQa(targets, { assets: { L00: ok }, summary: "" })).toThrow(/asset L01 has no result/);
    expect(() => aq.readAssetQa(targets, { assets: [{ assetId: "L00", ...ok }, { assetId: "L00", ...ok }], summary: "" })).toThrow(/answer is not \{ "assets"/);
  });
  test("a malformed decision rejects the batch; REGENERATE needs feedback; a verification cannot regenerate", () => {
    expect(() => aq.readAssetQa(targets, { assets: { L00: { ...ok, decision: "FIX" }, L01: ok } })).toThrow(/decision "FIX" is not PASS, REGENERATE, HUMAN_REVIEW/);
    expect(() => aq.readAssetQa(targets, { assets: { L00: { decision: "REGENERATE", reason: "r", repairFeedback: " " }, L01: ok } })).toThrow(/REGENERATE needs repair feedback/);
    expect(() => aq.readAssetQa(targets, { assets: { L00: { decision: "REGENERATE", reason: "r" }, L01: ok } }, true)).toThrow(/Invalid Asset QA verification: asset L00: decision "REGENERATE" is not PASS, HUMAN_REVIEW/);
    const r = aq.readAssetQa(targets, { assets: { L00: { decision: "REGENERATE", reason: `Stray text ${LONG_DASH[1]} top left.`, repairFeedback: "Remove the text." }, L01: { decision: "HUMAN_REVIEW", reason: "", repairFeedback: null } }, summary: "S" });
    expect(r.verdicts.get("L00")).toEqual({ decision: "REGENERATE", reason: "Stray text - top left.", repairFeedback: "Remove the text." });
    expect(r.verdicts.get("L01")!.decision).toBe("HUMAN_REVIEW");
  });
  test("the instructions cover the rubric, keep archive read only, and use plain hyphens", () => {
    for (const s of ["REQUIRED / FORBIDDEN CONTENT", "UNEXPECTED TEXT / SYMBOLS", "GENERATED IMAGE INTEGRITY", "SPATIAL / DIRECTIONAL LOGIC", "STORY CONTAMINATION", "GRAPHICS"]) {
      expect(aq.PIXEL_QA_INSTRUCTIONS).toContain(s);
      expect(aq.PIXEL_VERIFY_INSTRUCTIONS).toContain(s);
    }
    expect(aq.PIXEL_QA_INSTRUCTIONS).toMatch(/archive is read only: never REGENERATE it/);
    expect(aq.PIXEL_QA_INSTRUCTIONS).toMatch(/only ONE regeneration attempt/);
    expect(aq.PIXEL_VERIFY_INSTRUCTIONS).toMatch(/there will be no further regeneration/);
    expect(aq.PIXEL_QA_INSTRUCTIONS + aq.PIXEL_VERIFY_INSTRUCTIONS).not.toMatch(new RegExp(`[${LONG_DASH}]`));
    expect(aq.PIXEL_QA_INSTRUCTIONS).not.toMatch(/Dagen|Swedish|RIGHT/);
  });
});

describe("Asset QA in the page", () => {
  afterEach(() => vi.restoreAllMocks());
  test("the unresolved assets reach the user as issue rows, each with its own fix; a pass adds none", async () => {
    const React = (await import("react")).default;
    const { renderToStaticMarkup } = await import("react-dom/server");
    const { visualIssuesForJob } = await import("../src/app/visualReview/visualIssues.ts");
    const { VisualException } = await import("../src/app/screens/Production.tsx");
    const { job } = seed();
    const preview = getJob(job.id)!.preview!;
    const issues = [
      { kind: "long", assetId: "L03", truth: "graphic", stage: "verify", reason: "The labels are still unreadable." },
      { kind: "long", assetId: "L01", truth: "archive", stage: "review", reason: "A modern logo is visible." },
    ];
    const needs = { status: "done", reviewed: 6, regenerated: 1, incomplete: 0, message: "Asset QA needs you for 2 assets.", issues, clean: false } as any;
    const listed = visualIssuesForJob({ preview, assetQa: needs });
    expect(listed.map((i) => [i.key, i.fix ?? null])).toEqual([
      ["asset-long-L03", "regenerate"], // the generated graphic
      ["asset-long-L01", "change"], // the archive still is never regenerated, only changed
    ]);
    expect(listed[1].note).toBe("This archive image is used as found. It cannot be regenerated.");
    const html = plain(
      renderToStaticMarkup(React.createElement(VisualException, { job: { ...job, state: "awaiting_preview", preview, assetQa: needs }, storyTitle: "T", issues: listed, version: 0, onReview: vi.fn(), onContinue: vi.fn(), continuing: false, busy: false, more: null } as any)),
    );
    expect(html).toContain("2 things need your attention");
    expect(html).toContain('data-visual-issue="asset-long-L03"');
    expect(html).toMatch(/Long · Slot [0-9]{2}/);
    expect(html).not.toMatch(/Asset L0|Asset QA|Reconstruction|Graphic/); // no engine vocabulary
    expect(html).toContain("The labels are still unreadable.");
    expect(html.match(/>Review<\/button>/g)).toHaveLength(2);
    expect(visualIssuesForJob({ preview, assetQa: { status: "done", reviewed: 6, regenerated: 1, incomplete: 0, message: "Asset QA passed.", issues: [], clean: true } })).toEqual([]);
  });

  test("while it runs the progress screen reads Checking films, with no check phase anywhere", async () => {
    const React = (await import("react")).default;
    const { renderToStaticMarkup } = await import("react-dom/server");
    const { ProductionProgress } = await import("../src/app/screens/Production.tsx");
    // The finished Stills count is still on the job at the visual gate.
    const job = { state: "awaiting_preview", step: "stills", progress: { current: 12, total: 12 }, assetQa: { status: "running", phase: "repair", current: 2, total: 3 } } as any;
    const html = plain(renderToStaticMarkup(React.createElement(ProductionProgress, { job })));
    expect(html).toContain("Checking films…</h1>");
    expect(html).toContain('aria-current="step" data-stage-current="checking"');
    const primary = html.slice(0, html.indexOf("<details"));
    for (const s of ["Repairing", "Inspecting", "2 of 3", "12 / 12", "%", "Asset QA"]) expect(primary).not.toContain(s);
    expect(html).not.toMatch(/Asset QA|repair|2 of 3/); // details included
    expect(html.slice(html.indexOf('aria-label="Production details"'))).toContain("Checking films");
    const verifying = plain(renderToStaticMarkup(React.createElement(ProductionProgress, { job: { ...job, assetQa: { status: "running", phase: "verify" } } })));
    expect(verifying).toContain("Checking films…</h1>");
  });
});
