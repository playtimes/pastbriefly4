import { describe, test, expect, beforeAll } from "vitest";
import { mkdtempSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";

const tmp = mkdtempSync(path.join(os.tmpdir(), "pb4-render-"));
process.env.PROVIDER_MODE = "mock";
process.env.PB4_DATA_DIR = path.join(tmp, "data");
process.env.PB4_MEDIA_DIR = path.join(tmp, "media");

const { renderFilms, probeVideo } = await import("../src/render/renderVideo.ts");
const { writeSilentWav, writePlaceholderStill } = await import("../src/production/mockAssets.ts");
const { config } = await import("../src/server/config.ts");
import type { RenderPlan } from "../src/render/types.ts";

const pub = path.join(tmp, "pub");
const longOut = path.join(tmp, "long.mp4");
const shortOut = path.join(tmp, "short.mp4");
const clipOut = path.join(tmp, "clip-hold.mp4");

// Average RGB of one output frame, via ffmpeg scaled to a single pixel.
function pixelAt(file: string, sec: number): [number, number, number] {
  const buf = execFileSync(config.ffmpeg, ["-v", "error", "-ss", String(sec), "-i", file, "-frames:v", "1", "-vf", "scale=1:1", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"]);
  return [buf[0], buf[1], buf[2]];
}

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
    // A 1s clip: red for its first half, blue for its second, so the final frame is blue.
    execFileSync(config.ffmpeg, [
      "-v", "error", "-y",
      "-f", "lavfi", "-i", "color=c=red:s=320x180:d=0.5:r=30",
      "-f", "lavfi", "-i", "color=c=blue:s=320x180:d=0.5:r=30",
      "-filter_complex", "concat=n=2:v=1:a=0", "-pix_fmt", "yuv420p", path.join(pub, "clip.mp4"),
    ]);
    // The clip sits under a 3s shot: it must play once, then hold its final frame.
    const clipPlan: RenderPlan = {
      ...plan("long"),
      durationInFrames: 90,
      audioEndFrame: 30,
      subtitles: [],
      shots: [{ id: "long-00", startFrame: 0, endFrame: 90, mediaType: "video", path: "clip.mp4", truth: "archive" }],
    };
    await renderFilms(pub, [
      { plan: plan("long"), compositionId: "LongVideo", outPath: longOut },
      { plan: plan("short"), compositionId: "ShortVideo", outPath: shortOut },
      { plan: clipPlan, compositionId: "LongVideo", outPath: clipOut },
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

  test("a clip shorter than its shot holds its final frame: no black tail, no loop, no jump back", () => {
    const blue = (px: number[]) => px[2] > 90 && px[2] > px[0] + 40;
    const red = (px: number[]) => px[0] > 90 && px[0] > px[2] + 40;
    expect(red(pixelAt(clipOut, 0.2))).toBe(true); // the clip plays from its start
    for (const t of [1.2, 1.9, 2.8]) {
      const px = pixelAt(clipOut, t);
      expect(blue(px), `frame at ${t}s was ${px}`).toBe(true); // held final frame, never black or back to red
    }
  });
});
