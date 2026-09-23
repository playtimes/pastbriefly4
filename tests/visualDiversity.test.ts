import { describe, test, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = mkdtempSync(path.join(os.tmpdir(), "pb4-visual-"));
process.env.PROVIDER_MODE = "mock";
process.env.PB4_DATA_DIR = path.join(tmp, "data");
process.env.PB4_MEDIA_DIR = path.join(tmp, "media");

const { planVisuals, buildPreview } = await import("../src/production/visuals.ts");
const { paulBunyanStory, paulBunyanResearch, paulBunyanScripts } = await import("../src/production/fixtures/paulBunyan.ts");
const { recordNarration } = await import("../src/production/narration.ts");
const { ensureStoryDirs } = await import("../src/production/paths.ts");

const story = { ...paulBunyanStory, createdAt: new Date().toISOString() };

async function plan() {
  ensureStoryDirs(story.slug);
  const long = await recordNarration(story.slug, "long", paulBunyanScripts.long);
  const short = await recordNarration(story.slug, "short", paulBunyanScripts.short);
  return planVisuals(story, paulBunyanResearch, paulBunyanScripts, { long, short });
}

describe("visual planning diversity", () => {
  test("graphic shots read as graphics, not reconstructions", async () => {
    const { long } = await plan();
    const graphics = long.filter((s) => s.truth === "graphic");
    expect(graphics.length).toBeGreaterThan(0);
    for (const g of graphics) {
      expect(g.prompt).toMatch(/information graphic/i);
      expect(g.prompt).not.toMatch(/cinematic editorial historical reconstruction/i);
      expect(g.useMaster).toBe(false);
    }
  });

  test("graphic prompts ask for minimal text and do not inject narration sentences", async () => {
    const { long } = await plan();
    const graphics = long.filter((s) => s.truth === "graphic");
    expect(graphics.length).toBeGreaterThan(0);
    for (const g of graphics) {
      expect(g.prompt).toMatch(/minimal or no text/i);
      // No "Subject: <sentence>" - the readable explanation is left to captions.
      expect(g.prompt).not.toMatch(/Subject:/);
    }
  });

  test("the master reference is used only on a minority of shots", async () => {
    const { long } = await plan();
    const withMaster = long.filter((s) => s.useMaster).length;
    expect(withMaster).toBeGreaterThan(0); // continuity still happens
    expect(withMaster).toBeLessThan(long.length / 2); // but does not dictate every frame
  });

  test("preview counts archive, reconstruction and graphic separately", async () => {
    const { long, short } = await plan();
    const preview = buildPreview(story, long, short);
    const all = [...long, ...short];
    const graphic = all.filter((s) => s.truth === "graphic").length;
    const reconstruction = all.filter((s) => s.truth === "reconstruction").length;
    expect(preview.graphic).toBe(graphic);
    expect(preview.reconstruction).toBe(reconstruction);
    // Graphics are their own bucket, never folded into reconstruction.
    expect(preview.archive + preview.reconstruction + preview.graphic).toBe(all.length);
  });

  test("Long carries materially more visual beats than Short", async () => {
    const { long, short } = await plan();
    expect(long.length).toBeGreaterThan(short.length);
  });
});
