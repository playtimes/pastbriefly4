import { describe, test, expect, beforeAll } from "vitest";
import { mkdtempSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = mkdtempSync(path.join(os.tmpdir(), "pb4-render-"));
process.env.PROVIDER_MODE = "mock";
process.env.PB4_DATA_DIR = path.join(tmp, "data");
process.env.PB4_MEDIA_DIR = path.join(tmp, "media");

const { renderFilms, probeVideo } = await import("../src/render/renderVideo.ts");
const { writeSilentWav, writePlaceholderStill } = await import("../src/production/mockAssets.ts");
import type { RenderPlan } from "../src/render/types.ts";

const pub = path.join(tmp, "pub");
const longOut = path.join(tmp, "long.mp4");
const shortOut = path.join(tmp, "short.mp4");

function plan(kind: "long" | "short"): RenderPlan {
  const w = kind === "short" ? 1080 : 1920;
  const h = kind === "short" ? 1920 : 1080;
  return {
    kind,
    width: w,
    height: h,
    fps: 30,
    durationInFrames: 30,
    audio: "audio.wav",
    audioEndFrame: 30,
    accent: "#d9a066",
    title: "Test",
    year: "1976",
    place: "DMZ",
    shots: [
      { id: `${kind}-00`, startFrame: 0, endFrame: 15, mediaType: "image", path: "img.png", truth: "reconstruction", motion: "push", caption: { kicker: "1976", text: "Test" } },
      { id: `${kind}-01`, startFrame: 15, endFrame: 30, mediaType: "image", path: "img.png", truth: "graphic", motion: "hold" },
    ],
    subtitles: [{ startFrame: 0, endFrame: 20, text: "a test phrase" }],
  };
}

describe("Remotion renderer", () => {
  beforeAll(async () => {
    mkdirSync(pub, { recursive: true });
    writeSilentWav(path.join(pub, "audio.wav"), 1);
    writePlaceholderStill(path.join(pub, "img.png"), { width: 1920, height: 1920, index: 1, label: "T", truth: "reconstruction", accent: "#d9a066" });
    await renderFilms(pub, [
      { plan: plan("long"), compositionId: "LongVideo", outPath: longOut },
      { plan: plan("short"), compositionId: "ShortVideo", outPath: shortOut },
    ]);
  }, 180000);

  test("Long renders 1920x1080 with audio and decodes", () => {
    const p = probeVideo(longOut);
    expect([p.width, p.height]).toEqual([1920, 1080]);
    expect(p.hasAudio).toBe(true);
    expect(p.durationSec).toBeGreaterThan(0.5);
  });

  test("Short renders 1080x1920 with audio and decodes", () => {
    const p = probeVideo(shortOut);
    expect([p.width, p.height]).toEqual([1080, 1920]);
    expect(p.hasAudio).toBe(true);
    expect(p.durationSec).toBeGreaterThan(0.5);
  });
});
