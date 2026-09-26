import { describe, test, expect, beforeAll, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import React from "react";

// Visual clarity treatments, the adaptive Long subtitle box and plain-hyphen
// spoken text. Mock mode throughout: zero provider calls.
const tmp = mkdtempSync(path.join(os.tmpdir(), "pb4-clarity-"));
process.env.PROVIDER_MODE = "mock";
process.env.PB4_DATA_DIR = path.join(tmp, "data");
process.env.PB4_MEDIA_DIR = path.join(tmp, "media");

const { recordNarration } = await import("../src/production/narration.ts");
const { planVisuals, buildRenderPlan, acquireStill, resolveReuse, clarityFor } = await import("../src/production/visuals.ts");
const { ensureStoryDirs } = await import("../src/production/paths.ts");
const { paulBunyanStory, paulBunyanResearch, paulBunyanScripts } = await import("../src/production/fixtures/paulBunyan.ts");
const { buildCues, cueUnits, LONG_CUE_MAX_UNITS } = await import("../src/production/subtitles.ts");
const { plainDashes } = await import("../src/production/text.ts");
const { stillStyle, spotlightStyle, mapFocusScale, MAP_FOCUS_END_SCALE } = await import("../src/render/Shot.tsx");
const { subtitleTextStyle, LONG_SUBTITLE_MAX_WIDTH } = await import("../src/render/Subtitles.tsx");
import type { PlannedShot } from "../src/production/visuals.ts";
import type { Shot } from "../src/render/types.ts";

const story = { ...paulBunyanStory, createdAt: new Date().toISOString() };

function planned(extra: Partial<PlannedShot>): PlannedShot {
  return { index: 1, edit: "new", assetId: "L01", presentation: "base", framing: "wide", startSec: 0, endSec: 3, truth: "reconstruction", motion: "hold", wantsMotion: false, prompt: "p", purpose: "Show the scene.", mustShow: [], mustNotShow: [], wordStart: 0, wordEnd: 5, ...extra } as PlannedShot;
}

describe("clarity selection (local, from the stored plan)", () => {
  test("an ordinary reconstruction with no focus gets no treatment", () => {
    expect(clarityFor(planned({ truth: "reconstruction", purpose: "Show the crew on deck." }))).toBeUndefined();
    // Even a route-sounding purpose does not turn a reconstruction or archive into a map treatment.
    expect(clarityFor(planned({ truth: "reconstruction", purpose: "The ship on its escape route." }))).toBeUndefined();
    expect(clarityFor(planned({ truth: "archive", purpose: "Map of the route." }))).toBeUndefined();
  });

  test("a detail presentation with a real focus gets the focus treatment", () => {
    expect(clarityFor(planned({ presentation: "detail-left", framing: "detail-left", focus: "the camouflaged bridge" }))).toBe("focus");
    expect(clarityFor(planned({ presentation: "detail-right", framing: "detail-right", focus: "   " }))).toBeUndefined();
    expect(clarityFor(planned({ presentation: "detail-center", framing: "detail-center" }))).toBeUndefined();
  });

  test("a clearly map / route graphic gets map-focus", () => {
    expect(clarityFor(planned({ truth: "graphic", purpose: "Show the escape route from Java to Fremantle.", mustShow: ["Java", "Geraldton", "Fremantle"] }))).toBe("map-focus");
    expect(clarityFor(planned({ truth: "graphic", purpose: "Locate the ship.", mustShow: ["a map of the Dutch East Indies"] }))).toBe("map-focus");
  });

  test("an ambiguous graphic, or a timeline / diagram, stays a normal hold", () => {
    expect(clarityFor(planned({ truth: "graphic", purpose: "Explain what a minesweeper does.", mustShow: ["a minesweeper silhouette"] }))).toBeUndefined();
    expect(clarityFor(planned({ truth: "graphic", purpose: "Timeline of the voyage from March to April.", mustShow: ["dates"] }))).toBeUndefined();
    expect(clarityFor(planned({ truth: "graphic", purpose: "Diagram comparing the route lengths." }))).toBeUndefined();
  });
});

describe("clarity in the render plan", () => {
  let shots: PlannedShot[];
  let narr: Awaited<ReturnType<typeof recordNarration>>;
  beforeAll(async () => {
    ensureStoryDirs(story.slug);
    const nLong = await recordNarration(story.slug, "long", paulBunyanScripts.long);
    const nShort = await recordNarration(story.slug, "short", paulBunyanScripts.short);
    const plans = await planVisuals(story, paulBunyanResearch, paulBunyanScripts, { long: nLong, short: nShort });
    shots = plans.long;
    narr = nLong;
    for (const s of shots) if (s.edit === "new") await acquireStill(story, "long", s, "images/hero.png");
    resolveReuse(story, "long", shots);
  });

  // Every graphic reads as a route map; every detail keeps its focus.
  const mapped = () => shots.map((s) => (s.truth === "graphic" ? { ...s, purpose: "The escape route across the sea." } : { ...s }));
  // The same plan with nothing a clarity treatment could key on.
  const plain = () => shots.map((s) => ({ ...s, focus: undefined, purpose: "Show it." }));

  test("the fixture exercises both treatments", () => {
    const plan = buildRenderPlan("long", story, mapped(), narr, "#d9a066");
    const kinds = new Set(plan.shots.map((s) => s.clarity));
    expect(kinds.has("focus")).toBe(true);
    expect(kinds.has("map-focus")).toBe(true);
    expect(kinds.has(undefined)).toBe(true);
    expect(buildRenderPlan("long", story, plain(), narr, "#d9a066").shots.every((s) => s.clarity === undefined)).toBe(true);
  });

  test("clarity never alters slot timing, asset, truth, motion or subtitles", () => {
    const withClarity = buildRenderPlan("long", story, mapped(), narr, "#d9a066");
    const without = buildRenderPlan("long", story, plain(), narr, "#d9a066");
    const strip = (s: Shot) => ({ ...s, clarity: undefined });
    expect(withClarity.shots.map(strip)).toEqual(without.shots.map(strip));
    expect(withClarity.durationInFrames).toBe(without.durationInFrames);
    expect(withClarity.subtitles).toEqual(without.subtitles);
  });

  test("building the render plan leaves ownership, truth and the motion budget untouched", () => {
    const input = mapped();
    const before = JSON.parse(JSON.stringify(input));
    buildRenderPlan("long", story, input, narr, "#d9a066");
    expect(input).toEqual(before);
    expect(input.filter((s) => s.wantsMotion).length).toBe(shots.filter((s) => s.wantsMotion).length);
  });

  test("a motion clip slot gets no still treatment", () => {
    const withClip = mapped().map((s) => (s.edit === "new" && s.presentation === "base" && s.truth === "graphic" ? { ...s, motionPath: "motion/x.mp4" } : s));
    const plan = buildRenderPlan("long", story, withClip.map((s) => (s.motionPath ? { ...s, endSec: s.startSec + 1 } : s)), narr, "#d9a066");
    for (const s of plan.shots) if (s.mediaType === "video") expect(s.clarity).toBeUndefined();
  });
});

describe("clarity rendering", () => {
  const shot = (extra: Partial<Shot>): Shot => ({ id: "long-01", startFrame: 0, endFrame: 90, mediaType: "image", path: "a.png", truth: "graphic", framing: "wide", ...extra });

  test("map-focus opens on the whole map, pushes, then settles", () => {
    expect(mapFocusScale(0, 1)).toBe(1);
    expect(mapFocusScale(0.1, 1)).toBe(1); // orient: still the whole map
    expect(mapFocusScale(0.4, 1)).toBeGreaterThan(1);
    expect(mapFocusScale(0.7, 1)).toBeCloseTo(MAP_FOCUS_END_SCALE);
    expect(mapFocusScale(1, 1)).toBeCloseTo(MAP_FOCUS_END_SCALE); // settled
    const s = shot({ clarity: "map-focus" });
    expect(stillStyle(s, 0, 90, "long").transform).toBe("scale(1)");
    expect(stillStyle(s, 89, 90, "long").transform).toBe(`scale(${MAP_FOCUS_END_SCALE})`);
    expect(stillStyle(s, 45, 90, "long").transformOrigin).toBe("50% 50%"); // the framing origin, no invented location
  });

  test("focus pushes a little toward the framing origin and adds one soft spotlight there", () => {
    const focus = shot({ truth: "reconstruction", framing: "detail-left", clarity: "focus" });
    const normal = shot({ truth: "reconstruction", framing: "detail-left" });
    expect(stillStyle(focus, 0, 90, "long").transform).toBe(stillStyle(normal, 0, 90, "long").transform);
    expect(stillStyle(focus, 89, 90, "long").transform).toBe("scale(1.575)"); // 1.5 * 1.05
    expect(stillStyle(normal, 89, 90, "long").transform).toBe("scale(1.545)"); // 1.5 * 1.03, unchanged
    expect(stillStyle(focus, 89, 90, "long").transformOrigin).toBe("22% 50%");
    const light = spotlightStyle(focus, 30);
    expect(String(light.background)).toContain("at 22% 50%");
    expect(String(light.background)).toContain("transparent 55%");
    expect(spotlightStyle(focus, 0).opacity).toBe(0); // fades in after the cut
    expect(light.opacity).toBe(1);
  });

  test("shots without clarity render exactly as before", () => {
    const normal = shot({ truth: "reconstruction", framing: "medium", motion: "push" });
    expect(stillStyle(normal, 89, 90, "long").transform).toBe("scale(1.215)"); // 1.18 * 1.03
    expect(stillStyle(normal, 89, 90, "short").transform).toBe("scale(1.345)"); // 1.18 * 1.14 (push)
  });
});

describe("Long subtitles: one line or two balanced lines, never three", () => {
  const timed = (text: string, gap = 0.05) => {
    let t = 0;
    return text.split(" ").map((word) => {
      const w = { word, start: t, end: t + 0.3 };
      t += 0.3 + gap;
      return w;
    });
  };

  test("a short phrase stays one cue, the Long box is bounded and balanced, Short is unchanged", () => {
    const cues = buildCues(timed("The ship hid in plain sight."), 30, "long", 10_000);
    expect(cues.map((c) => c.text)).toEqual(["The ship hid in plain sight."]);
    const long = subtitleTextStyle("long");
    // Measured in the render browser: ~42 characters a line, so ~41-char phrases
    // stay one line and longer ones wrap to two (was one ~1400px band).
    expect(LONG_SUBTITLE_MAX_WIDTH).toBe(680);
    expect(long.maxWidth).toBe(LONG_SUBTITLE_MAX_WIDTH);
    expect(long.textWrap).toBe("balance");
    expect(long.fontSize).toBe(32);
    const short = subtitleTextStyle("short");
    expect(short.maxWidth).toBeUndefined();
    expect(short.textWrap).toBeUndefined();
    expect(short.fontSize).toBe(43);
  });

  test("wide glyphs count wider, so an all-caps phrase splits earlier", () => {
    expect(cueUnits("abc")).toBe(3);
    expect(cueUnits("ABC")).toBeCloseTo(4.05);
    expect(cueUnits("mw")).toBeCloseTo(2.9);
    const caps = "MAMMOTH WARSHIPS WALLOWED WESTWARD WITH MANY WOMEN"; // 7 words, 50 chars
    const capsCues = buildCues(timed(caps), 30, "long", 10_000);
    const lowerCues = buildCues(timed(caps.toLowerCase()), 30, "long", 10_000);
    const wordsIn = (t: string) => t.split(" ").length;
    expect(wordsIn(capsCues[0].text)).toBeLessThan(wordsIn(lowerCues[0].text));
    for (const c of capsCues) expect(cueUnits(c.text)).toBeLessThanOrEqual(LONG_CUE_MAX_UNITS);
  });

  test("Long cues never exceed the hard cap, even with long words late in a phrase", () => {
    const words = "Surabaya harbourmaster Crijnssen's extraordinarily camouflaged minesweeper navigated uncharted archipelagos westward toward Australian waters".split(" ");
    const cues = buildCues(timed(words.join(" ")), 30, "long", 10_000);
    expect(cues.length).toBeGreaterThan(1);
    for (const c of cues) expect(cueUnits(c.text)).toBeLessThanOrEqual(LONG_CUE_MAX_UNITS);
    expect(cues.map((c) => c.text).join(" ")).toBe(words.join(" ")); // no word lost or split
    // A single over-long word is its own cue (one word is one line), not a crash.
    const huge = "a".repeat(80);
    expect(buildCues(timed(`Then ${huge} arrived`), 30, "long", 10_000).map((c) => c.text)).toEqual(["Then", huge, "arrived"]);
  });

  test("Short cue splitting is unchanged", () => {
    const text = "In 1942 the minesweeper escaped from Java to Australia disguised as a small island.";
    expect(buildCues(timed(text), 30, "short", 10_000).map((c) => c.text)).toEqual(["In 1942 the minesweeper escaped", "from Java to Australia disguised", "as a small island."]);
  });
});

describe("spoken text uses plain hyphens only", () => {
  test("typographic dashes become a plain hyphen; ordinary hyphens stay", () => {
    expect(plainDashes("Sweden – Norway")).toBe("Sweden - Norway");
    expect(plainDashes("Java — Australia")).toBe("Java - Australia");
    expect(plainDashes("A―B")).toBe("A-B");
    expect(plainDashes("K-19")).toBe("K-19");
    expect(plainDashes("x‐y‑z‒w−v")).toBe("x-y-z-w-v");
  });

  test("subtitle cues never show a typographic dash from aligned words", () => {
    const words = [
      { word: "Java", start: 0, end: 0.3 },
      { word: "—", start: 0.35, end: 0.4 },
      { word: "Australia–bound", start: 0.45, end: 0.9 },
    ];
    expect(buildCues(words, 30, "long", 1000).map((c) => c.text)).toEqual(["Java - Australia-bound"]);
  });
});
