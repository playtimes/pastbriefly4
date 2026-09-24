import { describe, test, expect, vi } from "vitest";
import { mkdtempSync, existsSync, readFileSync, readdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Story } from "../src/types.ts";
import type { PlannedShot } from "../src/production/visuals.ts";

// PB4 production motion goes through Runway: acquireMotion hands the provider the
// LOCAL still (no public asset base), a short motion prompt, and the film kind;
// pricing and the preview's remaining-motion estimate use the Runway clip price.
const tmp = mkdtempSync(path.join(os.tmpdir(), "pb4-runway-motion-"));
process.env.PROVIDER_MODE = "live";
process.env.PB4_DATA_DIR = path.join(tmp, "data");
process.env.PB4_MEDIA_DIR = path.join(tmp, "media");
delete process.env.HIGGSFIELD_PUBLIC_ASSET_BASE;

const calls = vi.hoisted(() => [] as { prompt: string; imagePath: string; kind: string; outPath: string }[]);
vi.mock("../src/providers/runway.ts", () => ({
  generateMotion: async (opts: { prompt: string; imagePath: string; kind: string; outPath: string }) => {
    calls.push(opts);
    return { taskId: "task-test" };
  },
}));

const { acquireMotion, motionPrompt, buildPreview, buildRenderPlan } = await import("../src/production/visuals.ts");
const { PRICING } = await import("../src/server/pricing.ts");
const { config, settingsStatus } = await import("../src/server/config.ts");
const { estimateJob } = await import("../src/production/estimate.ts");

function makeStory(): Story {
  return {
    id: "s1",
    slug: "whiskey-on-the-rocks",
    title: "The Whiskey on the Rocks Incident",
    hook: "A Soviet submarine ran aground.",
    category: "Conflicts & Standoffs",
    year: "1981",
    place: "Karlskrona, Sweden",
    summary: "A stranded submarine sparks a standoff.",
    heroImage: null,
    moments: [{ title: "The grounding", detail: "Stuck fast near a naval base." }],
    sources: [],
    productionNote: "",
    createdAt: new Date().toISOString(),
  } as Story;
}

function makeShot(over: Partial<PlannedShot> = {}): PlannedShot {
  return {
    index: 7,
    edit: "new",
    assetId: "L07",
    presentation: "base",
    framing: "wide",
    startSec: 0,
    endSec: 4,
    truth: "reconstruction",
    motion: "push",
    wantsMotion: true,
    prompt: "FULL STILL PROMPT: Historical editorial illustration, PB1 style envelope ...",
    purpose: "Show Swedish Navy and Coast Guard vessels converging on the grounded submarine.",
    mustShow: [],
    mustNotShow: [],
    wordStart: 0,
    wordEnd: 10,
    path: "images/long-07.png",
    ...over,
  } as PlannedShot;
}

describe("acquireMotion uses Runway with the local still", () => {
  test("passes the local image path, film kind and output path; needs no public asset base", async () => {
    calls.length = 0;
    const story = makeStory();
    const shot = makeShot();
    await acquireMotion(story, "long", shot);

    expect(calls).toHaveLength(1);
    expect(calls[0].imagePath).toBe(path.join(process.env.PB4_MEDIA_DIR!, "stories", story.slug, "images", "long-07.png"));
    expect(calls[0].kind).toBe("long");
    expect(calls[0].outPath).toBe(path.join(process.env.PB4_MEDIA_DIR!, "stories", story.slug, "motion", "long-07.mp4"));
    expect(shot.motionPath).toBe("motion/long-07.mp4");
    expect(shot.mediaType).toBe("video");
  });

  test("Short shots keep the short-NN output path and kind", async () => {
    calls.length = 0;
    const shot = makeShot({ index: 2, path: "images/short-02.png" });
    await acquireMotion(makeStory(), "short", shot);
    expect(calls[0].kind).toBe("short");
    expect(shot.motionPath).toBe("motion/short-02.mp4");
  });

  test("the motion prompt preserves the frame and never resends the still prompt", async () => {
    calls.length = 0;
    await acquireMotion(makeStory(), "long", makeShot());
    const p = calls[0].prompt;
    expect(p).toBe(motionPrompt(makeShot()));
    expect(p).not.toContain("FULL STILL PROMPT");
    expect(p).toContain("Animate only the movement already implied by this frame.");
    expect(p).toContain("Preserve the exact composition, subjects, vessel design, clothing, environment, lighting, palette and illustrated PastBriefly style of the source image.");
    expect(p).toContain("Do not add or remove objects or people. No morphing, no new text, no dramatic action, no exaggerated body movement.");
    expect(p).toContain("Context: Show Swedish Navy and Coast Guard vessels converging on the grounded submarine.");
    expect(p).toContain("slow, gentle push in");
    expect(p).not.toMatch(/[‒–—―]/);
  });

  test("camera directions follow the planned motion", () => {
    expect(motionPrompt(makeShot({ motion: "hold" }))).toContain("locked off and still");
    expect(motionPrompt(makeShot({ motion: "pan-left" }))).toContain("pan to the left");
    expect(motionPrompt(makeShot({ motion: "pan-right" }))).toContain("pan to the right");
  });
});

describe("Runway pricing", () => {
  test("one 5s Gen-4.5 clip is $0.60", () => {
    expect(PRICING.runway.video5s).toBe(0.6);
    expect((PRICING as any).higgsfield).toBeUndefined();
  });

  test("the preview's remaining motion cost uses the Runway price", () => {
    const story = makeStory();
    const L = [makeShot({ index: 1 }), makeShot({ index: 2 }), makeShot({ index: 3, wantsMotion: false })];
    const S = [makeShot({ index: 1, path: "images/short-01.png" })];
    const preview = buildPreview(story, L, S);
    expect(preview.motionSelected).toBe(3);
    expect(preview.remainingMotionCost).toBe(1.8);
  });

  test("the job estimate labels and prices motion as Runway", () => {
    const line = estimateJob(makeStory()).lines.find((l) => /motion/i.test(l.label))!;
    expect(line.label).toBe("Selective motion (Runway Gen-4.5, 5s)");
    const clips = Number(line.detail.split(" ")[0]);
    expect(line.usd).toBeCloseTo(clips * 0.6, 5);
  });
});

describe("render plan for 5s clips", () => {
  const words = Array.from({ length: 40 }, (_, i) => ({ word: "w", start: i * 0.5, end: i * 0.5 + 0.4 }));
  const narr = { audioRel: "audio/long.mp3", audioMediaRel: "", durationSec: 20, words } as any;

  test("a video event inside the clip window renders as one shot and the next event cuts in", () => {
    const clip = makeShot({ index: 0, startSec: 0, endSec: 4.5, motionPath: "motion/long-00.mp4", mediaType: "video" });
    const next = makeShot({ index: 1, assetId: "L08", startSec: 4.5, endSec: 20.5, wantsMotion: false, path: "images/long-01.png" });
    const plan = buildRenderPlan("long", makeStory(), [clip, next], narr, "#d9a066");
    expect(plan.shots).toHaveLength(2); // the edit plan owns cuts: no MAX_HOLD re-cut of the 16s still
    expect(plan.shots[0].mediaType).toBe("video");
    expect(plan.shots[0].endFrame - plan.shots[0].startFrame).toBeLessThanOrEqual(5 * 30);
    expect(plan.shots[1].mediaType).toBe("image");
  });

  test("a video event longer than the clip is refused rather than frozen on its last frame", () => {
    const shot = makeShot({ index: 0, startSec: 0, endSec: 20.5, motionPath: "motion/long-00.mp4", mediaType: "video" });
    expect(() => buildRenderPlan("long", makeStory(), [shot], narr, "#d9a066")).toThrow(/motion clip/);
  });
});

describe("Higgsfield is off the production motion path", () => {
  test("no Higgsfield provider, config or settings remain", () => {
    expect(existsSync(path.join(__dirname, "..", "src", "providers", "higgsfield.ts"))).toBe(false);
    expect((config as any).higgsfield).toBeUndefined();
    expect(config.runway.videoModel).toBe("gen4.5");
    const status = settingsStatus() as any;
    expect(status.higgsfield).toBeUndefined();
    expect(status.runway).toEqual({ apiSecretSet: expect.any(Boolean), videoModel: "gen4.5" });
  });

  test("no production source imports a Higgsfield provider", () => {
    const walk = (d: string): string[] =>
      readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
    const src = walk(path.join(__dirname, "..", "src")).filter((f) => /\.(ts|tsx)$/.test(f));
    for (const f of src) expect(readFileSync(f, "utf8")).not.toMatch(/providers\/higgsfield|HIGGSFIELD_|config\.higgsfield/);
  });
});
