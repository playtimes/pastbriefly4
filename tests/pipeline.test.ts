import { describe, test, expect, beforeAll } from "vitest";
import { existsSync, mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = mkdtempSync(path.join(os.tmpdir(), "pb4-pipe-"));
process.env.PROVIDER_MODE = "mock";
process.env.PB4_DATA_DIR = path.join(tmp, "data");
process.env.PB4_MEDIA_DIR = path.join(tmp, "media");

const { recordNarration } = await import("../src/production/narration.ts");
const { planVisuals, buildRenderPlan, acquireStill, resolveReuse } = await import("../src/production/visuals.ts");
const { ensureStoryDirs, inStory } = await import("../src/production/paths.ts");
const { paulBunyanStory, paulBunyanResearch, paulBunyanScripts } = await import("../src/production/fixtures/paulBunyan.ts");
const { groupSentences, wordCount } = await import("../src/production/text.ts");
const { buildCues } = await import("../src/production/subtitles.ts");
import type { RenderPlan } from "../src/render/types.ts";

const story = { ...paulBunyanStory, createdAt: new Date().toISOString() };

async function makePlan(kind: "long" | "short"): Promise<RenderPlan> {
  ensureStoryDirs(story.slug);
  // Two planning calls (coverage, then edit) plan both films; select the one under test.
  const nLong = await recordNarration(story.slug, "long", paulBunyanScripts.long);
  const nShort = await recordNarration(story.slug, "short", paulBunyanScripts.short);
  const plans = await planVisuals(story, paulBunyanResearch, paulBunyanScripts, { long: nLong, short: nShort });
  const shots = plans[kind];
  const narr = kind === "long" ? nLong : nShort;
  for (const s of shots) if (s.edit === "new") await acquireStill(story, kind, s, "images/hero.png");
  resolveReuse(story, kind, shots);
  return buildRenderPlan(kind, story, shots, narr, "#d9a066");
}

describe("render plan", () => {
  let long: RenderPlan;
  let short: RenderPlan;
  beforeAll(async () => {
    long = await makePlan("long");
    short = await makePlan("short");
  });

  test("dimensions match the format", () => {
    expect([long.width, long.height]).toEqual([1920, 1080]);
    expect([short.width, short.height]).toEqual([1080, 1920]);
  });

  test("shots are contiguous with no gaps and cover the whole timeline", () => {
    for (const plan of [long, short]) {
      expect(plan.shots[0].startFrame).toBe(0);
      for (let i = 1; i < plan.shots.length; i++) {
        expect(plan.shots[i].startFrame).toBe(plan.shots[i - 1].endFrame);
      }
      expect(plan.shots.at(-1)!.endFrame).toBe(plan.durationInFrames);
    }
  });

  test("every shot references a media file that exists", () => {
    for (const plan of [long, short]) {
      for (const s of plan.shots) expect(existsSync(inStory(story.slug, s.path))).toBe(true);
    }
  });

  test("no accidental extremely long still hold", () => {
    for (const plan of [long, short]) {
      for (const s of plan.shots) expect((s.endFrame - s.startFrame) / plan.fps).toBeLessThanOrEqual(16);
    }
  });

  test("subtitles stay inside the duration and are ordered", () => {
    for (const plan of [long, short]) {
      for (const c of plan.subtitles) {
        expect(c.startFrame).toBeGreaterThanOrEqual(0);
        expect(c.endFrame).toBeLessThanOrEqual(plan.durationInFrames);
        expect(c.endFrame).toBeGreaterThan(c.startFrame);
      }
    }
  });

  test("audio ends within the composition", () => {
    for (const plan of [long, short]) expect(plan.audioEndFrame).toBeLessThanOrEqual(plan.durationInFrames);
  });
});

describe("text grouping", () => {
  test("sentence groups partition every word contiguously", () => {
    const groups = groupSentences(paulBunyanScripts.long, 18);
    expect(groups[0].wordStart).toBe(0);
    for (let i = 1; i < groups.length; i++) expect(groups[i].wordStart).toBe(groups[i - 1].wordEnd);
    expect(groups.at(-1)!.wordEnd).toBe(wordCount(paulBunyanScripts.long));
  });
});

describe("subtitles", () => {
  test("short cues are phrases, not single words", () => {
    const words = [
      { word: "The", start: 0, end: 0.3 },
      { word: "tree", start: 0.3, end: 0.7 },
      { word: "was", start: 0.7, end: 0.9 },
      { word: "gone.", start: 0.9, end: 1.4 },
    ];
    const cues = buildCues(words, 30, "short", 100);
    expect(cues.length).toBe(1);
    expect(cues[0].text.split(" ").length).toBeGreaterThan(1);
  });
});
