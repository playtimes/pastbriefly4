import { describe, test, expect } from "vitest";
import { validateFinalVideo, FINAL_VIDEO } from "../src/render/finalCheck.ts";
import type { RenderPlan } from "../src/render/types.ts";
import { readProbe, type Probe } from "../src/render/renderVideo.ts";

// The deterministic final-file contract: exact dimensions per film, 30 fps, an
// audio stream, and a real duration close to the RenderPlan's.
const plan = (kind: "long" | "short", durationInFrames: number): RenderPlan => ({
  kind, width: kind === "long" ? 1920 : 1080, height: kind === "long" ? 1080 : 1920, fps: 30, durationInFrames,
  audio: "a.mp3", audioEndFrame: durationInFrames, accent: "#c33", title: "T", year: "1967", place: "P", shots: [], subtitles: [],
});
const LONG = plan("long", 7272); // 242.4s
const SHORT = plan("short", 1514); // 50.4666…s
const probe = (over: Partial<Probe>, kind: "long" | "short" = "long"): Probe => ({
  width: kind === "long" ? 1920 : 1080, height: kind === "long" ? 1080 : 1920, fps: 30, hasAudio: true,
  durationSec: kind === "long" ? 242.4 : 1514 / 30, ...over,
});
const failure = (p: RenderPlan, pr: Probe): string => {
  try {
    validateFinalVideo(p, pr);
  } catch (e: any) {
    return e.message;
  }
  return "";
};

describe("final file contract", () => {
  test("A. a valid Long passes", () => {
    expect(() => validateFinalVideo(LONG, probe({}))).not.toThrow();
    expect(() => validateFinalVideo(LONG, probe({ fps: 30000 / 1000.1 }))).not.toThrow(); // effectively 30
  });

  test("B. a valid Short passes", () => {
    expect(() => validateFinalVideo(SHORT, probe({}, "short"))).not.toThrow();
  });

  test("C. wrong dimensions fail, including a Long/Short swap", () => {
    expect(failure(LONG, probe({ width: 1280, height: 720 }))).toBe("Final file check failed for Long: expected 1920x1080, got 1280x720.");
    expect(failure(SHORT, probe({}, "long"))).toBe("Final file check failed for Short: expected 1080x1920, got 1920x1080.");
    expect(failure(LONG, probe({ width: 0, height: 0 }))).toMatch(/expected 1920x1080, got 0x0/); // no video stream
  });

  test("D. a missing audio stream fails", () => {
    expect(failure(SHORT, probe({ hasAudio: false }, "short"))).toBe("Final file check failed for Short: audio stream is missing.");
  });

  test("E. a wrong frame rate fails", () => {
    expect(failure(LONG, probe({ fps: 25 }))).toBe("Final file check failed for Long: expected 30 fps, got 25.");
    expect(failure(LONG, probe({ fps: 29.97 }))).toMatch(/expected 30 fps, got 29.97/);
  });

  test("E2. an unknown or invalid frame rate fails plainly, never showing NaN", () => {
    for (const fps of [NaN, Infinity, -Infinity, 0, -30]) {
      const msg = failure(LONG, probe({ fps }));
      expect(msg).toBe("Final file check failed for Long: the file has no usable frame rate.");
      expect(msg).not.toMatch(/NaN|Infinity/);
    }
  });

  test("E3. 30 fps and normal ffprobe drift inside the tolerance still pass", () => {
    for (const fps of [30, 29.999, 30.001, 30000 / 1000.1, 30 + FINAL_VIDEO.fpsTolerance - 0.0001]) {
      expect(() => validateFinalVideo(LONG, probe({ fps }))).not.toThrow();
    }
  });

  test("F. zero, negative, NaN or infinite duration fails", () => {
    for (const durationSec of [0, -1, NaN, Infinity]) {
      expect(failure(LONG, probe({ durationSec }))).toBe("Final file check failed for Long: the file has no usable duration.");
    }
  });

  test("G. a duration outside the tolerance fails", () => {
    expect(failure(LONG, probe({ durationSec: 180 }))).toBe("Final file check failed for Long: expected about 242.4s, got 180.0s.");
    expect(failure(LONG, probe({ durationSec: 242.4 + FINAL_VIDEO.durationToleranceSec + 0.01 }))).toMatch(/expected about 242.4s/);
    expect(failure(SHORT, probe({ durationSec: 1514 / 30 - 0.3 }, "short"))).toMatch(/Short: expected about 50.5s/);
  });

  test("H. small container drift within the tolerance passes", () => {
    expect(FINAL_VIDEO.durationToleranceSec).toBe(0.25);
    for (const drift of [0.029, 0.064, -0.033, 0.24, -0.24]) {
      expect(() => validateFinalVideo(LONG, probe({ durationSec: 242.4 + drift }))).not.toThrow();
      expect(() => validateFinalVideo(SHORT, probe({ durationSec: 1514 / 30 + drift }, "short"))).not.toThrow();
    }
  });
});

describe("readProbe never manufactures a frame rate", () => {
  const json = (video: Record<string, unknown> | null, audio = true) =>
    JSON.stringify({
      streams: [...(video ? [{ codec_type: "video", width: 1920, height: 1080, ...video }] : []), ...(audio ? [{ codec_type: "audio" }] : [])],
      format: { duration: "242.43" },
    });

  test("a stated frame rate is read as is", () => {
    expect(readProbe(json({ r_frame_rate: "30/1" }))).toEqual({ width: 1920, height: 1080, durationSec: 242.43, fps: 30, hasAudio: true });
    expect(readProbe(json({ r_frame_rate: "30000/1001" })).fps).toBeCloseTo(29.97, 2);
    expect(readProbe(json({ r_frame_rate: "30000/1000" })).fps).toBe(30);
  });

  test("an absent, malformed or impossible r_frame_rate is NaN, not 30", () => {
    for (const r of [undefined, null, "", "30", "abc", "30/", "/1", "30/0", "0/0", "0/1", "-30/1", "30/1/1", "N/A"]) {
      const p = readProbe(json(r === undefined ? {} : { r_frame_rate: r }));
      expect(Number.isNaN(p.fps), `r_frame_rate ${JSON.stringify(r)}`).toBe(true);
    }
    const noVideo = readProbe(json(null));
    expect(Number.isNaN(noVideo.fps)).toBe(true);
    expect([noVideo.width, noVideo.height]).toEqual([0, 0]);
  });

  test("a probe with no usable frame rate is rejected by the final file check", () => {
    expect(failure(LONG, { ...readProbe(json({ r_frame_rate: "0/0" })), durationSec: 242.4 })).toBe("Final file check failed for Long: the file has no usable frame rate.");
  });
});
