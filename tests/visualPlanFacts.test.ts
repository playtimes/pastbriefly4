import { describe, test, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";

// Live visual planning is only as truthful as its inputs. A ResearchPackage with
// no verified facts (e.g. legacy research from before the fact sheet) must be
// refused BEFORE any provider call, so live visuals are never planned ungrounded.
// Mock mode's fact-free fallback is covered in visualDirector.test.ts.
const tmp = mkdtempSync(path.join(os.tmpdir(), "pb4-visual-facts-"));
process.env.PROVIDER_MODE = "live";
process.env.OPENAI_API_KEY = "test-key";
process.env.PB4_DATA_DIR = path.join(tmp, "data");
process.env.PB4_MEDIA_DIR = path.join(tmp, "media");

const { planVisuals } = await import("../src/production/visuals.ts");
import type { VisualDirectors } from "../src/production/visuals.ts";
const { minimalAsset } = await import("./slotPlan.ts");
const { paulBunyanStory, paulBunyanResearch, paulBunyanScripts } = await import("../src/production/fixtures/paulBunyan.ts");

const story = { ...paulBunyanStory, createdAt: new Date().toISOString() };
const fakeNarr = () => ({ audioRel: "a", audioMediaRel: "a", durationSec: 300, words: [{ word: "a", start: 0, end: 0.5 }] });
const narration = { long: fakeNarr(), short: fakeNarr() } as any;

// If planning ever reached a planner despite missing facts, this makes it loud.
const fail = async (): Promise<never> => {
  throw new Error("planners must not run without facts");
};
const trap: VisualDirectors = { coverage: fail, editor: fail };

// A minimal valid library and edit so the "facts present" path can proceed without a provider.
const okDirectors: VisualDirectors = {
  coverage: async () => ({ longAssets: [minimalAsset()], shortAssets: [minimalAsset()] }) as never,
  editor: async (input) => ({
    long: input.slots.long.map((s) => ({ slotId: s.id, presentationId: s.id % 2 ? "L00:detail-center" : "L00:base", motionPriority: 0 })),
    short: input.slots.short.map((s) => ({ slotId: s.id, presentationId: s.id % 2 ? "S00:detail-center" : "S00:base", motionPriority: 0 })),
  }),
};

describe("live visual planning requires a fact sheet", () => {
  test("planVisuals rejects an empty facts array in live mode, before any call", async () => {
    const noFacts = { ...paulBunyanResearch, facts: [] };
    await expect(planVisuals(story, noFacts as any, paulBunyanScripts, narration, trap)).rejects.toThrow(
      /Visual planning requires verified facts/,
    );
  });

  test("with verified facts present, live planning proceeds", async () => {
    const plans = await planVisuals(story, paulBunyanResearch, paulBunyanScripts, narration, okDirectors);
    expect(plans.long.length).toBeGreaterThan(0);
    expect(plans.long[0].purpose).toBe("Show the moment.");
  });
});
