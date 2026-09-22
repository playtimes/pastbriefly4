import { describe, test, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = mkdtempSync(path.join(os.tmpdir(), "pb4-visual-"));
process.env.PROVIDER_MODE = "mock";
process.env.PB4_DATA_DIR = path.join(tmp, "data");
process.env.PB4_MEDIA_DIR = path.join(tmp, "media");

const { planShots, buildPreview } = await import("../src/production/visuals.ts");
const { paulBunyanStory, paulBunyanResearch, paulBunyanScripts } = await import("../src/production/fixtures/paulBunyan.ts");
const { recordNarration } = await import("../src/production/narration.ts");
const { ensureStoryDirs } = await import("../src/production/paths.ts");

const story = { ...paulBunyanStory, createdAt: new Date().toISOString() };

async function plan() {
  ensureStoryDirs(story.slug);
  const narr = await recordNarration(story.slug, "long", paulBunyanScripts.long);
  return planShots("long", paulBunyanScripts.long, story, paulBunyanResearch.world, narr);
}

describe("visual planning diversity", () => {
  test("consecutive reconstruction shots never share a composition shape", async () => {
    const shots = await plan();
    const recon = shots.filter((s) => s.truth === "reconstruction");
    // The shape phrase leads the prompt, so distinct shapes => distinct prompts.
    for (let i = 1; i < recon.length; i++) {
      if (recon[i].index === recon[i - 1].index + 1) {
        expect(recon[i].prompt).not.toBe(recon[i - 1].prompt);
      }
    }
  });

  test("the master reference is used only on a minority of shots", async () => {
    const shots = await plan();
    const withMaster = shots.filter((s) => s.useMaster).length;
    expect(withMaster).toBeGreaterThan(0); // continuity still happens
    expect(withMaster).toBeLessThan(shots.length / 2); // but does not dictate every frame
  });

  test("graphic shots read as graphics, not reconstructions", async () => {
    const shots = await plan();
    const graphics = shots.filter((s) => s.truth === "graphic");
    expect(graphics.length).toBeGreaterThan(0);
    for (const g of graphics) {
      expect(g.prompt).toMatch(/information graphic/i);
      expect(g.prompt).not.toMatch(/cinematic editorial historical reconstruction/i);
      expect(g.useMaster).toBe(false);
    }
  });

  test("graphic prompts ask for minimal text and do not inject narration sentences", async () => {
    const shots = await plan();
    const graphics = shots.filter((s) => s.truth === "graphic");
    expect(graphics.length).toBeGreaterThan(0);
    for (const g of graphics) {
      expect(g.prompt).toMatch(/minimal or no text/i);
      // No "Subject: <sentence>" - the readable explanation is left to captions.
      expect(g.prompt).not.toMatch(/Subject:/);
    }
  });

  test("preview counts archive, reconstruction and graphic separately", async () => {
    const shots = await plan();
    const preview = buildPreview(story, shots, []);
    const graphic = shots.filter((s) => s.truth === "graphic").length;
    const reconstruction = shots.filter((s) => s.truth === "reconstruction").length;
    expect(preview.graphic).toBe(graphic);
    expect(preview.reconstruction).toBe(reconstruction);
    // Graphics are their own bucket, never folded into reconstruction.
    expect(preview.archive + preview.reconstruction + preview.graphic).toBe(shots.length);
  });

  test("archive queries are moment-specific, not one generic story-title query", async () => {
    const shots = await plan();
    const queries = shots.filter((s) => s.truth === "archive").map((s) => s.archiveQuery!);
    expect(queries.length).toBeGreaterThan(1);
    // Anchored on place/year but carrying different moment subjects.
    for (const q of queries) expect(q).toContain(story.place);
    expect(new Set(queries).size).toBeGreaterThan(1);
  });
});
