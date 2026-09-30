import { describe, test, expect, beforeAll } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";

// The whole-film contact sheet of Final-film QC, built with the real ffmpeg from
// tiny synthetic films: red opening, green middle, blue ending. The first cell
// must be red and the last blue, so the sheet spans the whole film in order.
const tmp = mkdtempSync(path.join(os.tmpdir(), "pb4-contact-sheet-"));
process.env.PROVIDER_MODE = "mock";
process.env.PB4_DATA_DIR = path.join(tmp, "data");
process.env.PB4_MEDIA_DIR = path.join(tmp, "media");

const { contactSheet, sampledFrames, sampleTimes, CONTACT_SHEET } = await import("../src/render/contactSheet.ts");
const { probeVideo } = await import("../src/render/renderVideo.ts");
const { config } = await import("../src/server/config.ts");

const ff = (args: string[], input?: Buffer) => execFileSync(config.ffmpeg, ["-v", "error", ...args], input ? { input } : {});

// Red, green, blue segments of the given seconds at the given size.
function film(file: string, size: string, [red, green, blue]: number[]): string {
  ff([
    "-y",
    "-f", "lavfi", "-i", `color=c=red:s=${size}:d=${red}:r=30`,
    "-f", "lavfi", "-i", `color=c=green:s=${size}:d=${green}:r=30`,
    "-f", "lavfi", "-i", `color=c=blue:s=${size}:d=${blue}:r=30`,
    "-filter_complex", "concat=n=3:v=1:a=0", "-c:v", "libx264", "-pix_fmt", "yuv420p", file,
  ]);
  return file;
}

// Average RGB of one grid cell of the sheet (cells sit inside a 6px white rule).
function cellColor(jpeg: Buffer, kind: "long" | "short", cell: number): [number, number, number] {
  const g = CONTACT_SHEET[kind];
  const x = 6 + (cell % g.cols) * (g.width + 6) + 20;
  const y = 6 + Math.floor(cell / g.cols) * (g.height + 6) + 20;
  const buf = ff(["-f", "image2pipe", "-i", "-", "-vf", `crop=${g.width - 40}:${g.height - 40}:${x}:${y},scale=1:1`, "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], jpeg);
  return [buf[0], buf[1], buf[2]];
}
const dominant = ([r, g, b]: [number, number, number]) => (r > g && r > b ? "red" : g > r && g > b ? "green" : "blue");

// Average RGB of one whole sampled frame.
function frameColor(jpeg: Buffer): [number, number, number] {
  const buf = ff(["-f", "image2pipe", "-i", "-", "-vf", "scale=1:1", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], jpeg);
  return [buf[0], buf[1], buf[2]];
}

// Each film lives alone in its own folder, so a test can see anything written beside it.
const filmDir = (name: string) => {
  const dir = path.join(tmp, name);
  mkdirSync(dir);
  return dir;
};
let longFilm = "";
let shortFilm = "";
beforeAll(() => {
  longFilm = film(path.join(filmDir("long"), "long.mp4"), "320x180", [2, 8, 2]); // 12s
  shortFilm = film(path.join(filmDir("short"), "short.mp4"), "180x320", [1, 4, 1]); // 6s
}, 60000);

function readableJpeg(data: Buffer, name: string) {
  expect(data.subarray(0, 3)).toEqual(Buffer.from([0xff, 0xd8, 0xff]));
  const file = path.join(tmp, name);
  writeFileSync(file, data);
  const probe = probeVideo(file);
  return [probe.width, probe.height];
}

describe("contact sheet sampling", () => {
  test("samples sit in the middle of equal slices, from the opening slice to the closing one", () => {
    const t = sampleTimes(240, 24);
    expect(t).toHaveLength(24);
    expect(t[0]).toBe(5);
    expect(t[23]).toBe(235);
    expect(t.every((x, i) => i === 0 || x > t[i - 1])).toBe(true);
    expect(sampleTimes(60, 12)).toEqual([2.5, 7.5, 12.5, 17.5, 22.5, 27.5, 32.5, 37.5, 42.5, 47.5, 52.5, 57.5]);
    expect(() => sampleTimes(0, 12)).toThrow(/no usable duration/);
  });

  test("Long: one readable 6x4 JPEG spanning the whole film in order, nothing written to disk", () => {
    const sheet = contactSheet(longFilm, "long");
    expect(sheet.times).toHaveLength(24);
    expect([sheet.cols, sheet.rows]).toEqual([6, 4]);
    expect(sheet.times[0]).toBeLessThan(0.5);
    expect(sheet.times[23]).toBeGreaterThan(11.5);
    const [width, height] = readableJpeg(sheet.data, "long-sheet.jpg");
    expect([width, height]).toEqual([6 * 320 + 7 * 6, 4 * 180 + 5 * 6]);
    expect(Math.min(width, height)).toBeLessThanOrEqual(768); // never shrunk by the vision model
    expect(Math.max(width, height)).toBeLessThanOrEqual(2048);
    expect(dominant(cellColor(sheet.data, "long", 0))).toBe("red");
    expect(dominant(cellColor(sheet.data, "long", 12))).toBe("green");
    expect(dominant(cellColor(sheet.data, "long", 23))).toBe("blue");
    expect(readdirSync(path.dirname(longFilm))).toEqual(["long.mp4"]); // no frames or sheet left beside the film
  }, 60000);

  test("Short: one readable 4x3 JPEG spanning the whole film in order, nothing written to disk", () => {
    const sheet = contactSheet(shortFilm, "short");
    expect(sheet.times).toEqual([0.25, 0.75, 1.25, 1.75, 2.25, 2.75, 3.25, 3.75, 4.25, 4.75, 5.25, 5.75]);
    expect(readableJpeg(sheet.data, "short-sheet.jpg")).toEqual([4 * 216 + 5 * 6, 3 * 384 + 4 * 6]);
    expect(dominant(cellColor(sheet.data, "short", 0))).toBe("red");
    expect(dominant(cellColor(sheet.data, "short", 6))).toBe("green");
    expect(dominant(cellColor(sheet.data, "short", 11))).toBe("blue");
    expect(readdirSync(path.dirname(shortFilm))).toEqual(["short.mp4"]);
  }, 60000);

  test("an unreadable film fails and leaves nothing behind", () => {
    const dir = filmDir("broken");
    const broken = path.join(dir, "broken.mp4");
    writeFileSync(broken, "not a video");
    expect(() => contactSheet(broken, "short")).toThrow();
    expect(readdirSync(dir)).toEqual(["broken.mp4"]);
  }, 60000);
});

// The frames the visual specialist actually sees: each sample as its own JPEG.
describe("sampled frames", () => {
  // A private temporary root per test, so leftovers are visible.
  const tmpRoot = (name: string) => {
    const dir = path.join(tmp, `frames-tmp-${name}`);
    mkdirSync(dir);
    return dir;
  };
  const LONG_SEC = 12;
  const SHORT_SEC = 6;

  test("A/C/D. Long: 24 chronological JPEGs at the equal-slice midpoints, first slice to last", () => {
    const root = tmpRoot("long");
    const frames = sampledFrames(longFilm, "long", root);
    expect(frames.map((f) => f.cell)).toEqual(Array.from({ length: 24 }, (_, i) => i + 1));
    const duration = probeVideo(longFilm).durationSec;
    expect(frames.map((f) => f.timeSec)).toEqual(sampleTimes(duration, 24)); // D: (i + 0.5) * duration / 24
    expect(frames[0].timeSec).toBeLessThan(LONG_SEC / 24); // C: inside the opening slice
    expect(frames[23].timeSec).toBeGreaterThan((LONG_SEC * 23) / 24); // C: inside the closing slice
    expect(dominant(frameColor(frames[0].jpeg))).toBe("red");
    expect(dominant(frameColor(frames[12].jpeg))).toBe("green");
    expect(dominant(frameColor(frames[23].jpeg))).toBe("blue");
    expect(readdirSync(root)).toEqual([]); // H: temporary folder removed on success
  }, 60000);

  test("B. Short: 12 chronological JPEGs at the equal-slice midpoints", () => {
    const root = tmpRoot("short");
    const frames = sampledFrames(shortFilm, "short", root);
    expect(frames.map((f) => [f.cell, f.timeSec])).toEqual([0.25, 0.75, 1.25, 1.75, 2.25, 2.75, 3.25, 3.75, 4.25, 4.75, 5.25, 5.75].map((t, i) => [i + 1, t]));
    expect(frames[0].timeSec).toBeLessThan(SHORT_SEC / 12);
    expect(frames[11].timeSec).toBeGreaterThan((SHORT_SEC * 11) / 12);
    expect(dominant(frameColor(frames[0].jpeg))).toBe("red");
    expect(dominant(frameColor(frames[6].jpeg))).toBe("green");
    expect(dominant(frameColor(frames[11].jpeg))).toBe("blue");
    expect(readdirSync(root)).toEqual([]);
  }, 60000);

  test("E/F. every frame is a readable JPEG that keeps the film's aspect ratio (640x360 Long, 360x640 Short)", () => {
    for (const [film, kind, size] of [[longFilm, "long", [640, 360]], [shortFilm, "short", [360, 640]]] as const) {
      const frames = sampledFrames(film, kind, tmpRoot(`read-${kind}`));
      for (const f of frames) expect(f.jpeg.subarray(0, 3), `${kind} cell ${f.cell}`).toEqual(Buffer.from([0xff, 0xd8, 0xff]));
      for (const f of [frames[0], frames[frames.length >> 1], frames[frames.length - 1]]) expect(readableJpeg(f.jpeg, `${kind}-frame-${f.cell}.jpg`), `${kind} cell ${f.cell}`).toEqual(size);
      const src = probeVideo(film);
      expect(size[0] / size[1]).toBeCloseTo(src.width / src.height, 2);
    }
  }, 60000);

  test("G. nothing is written beside the film or into story media", () => {
    sampledFrames(longFilm, "long", tmpRoot("media"));
    expect(readdirSync(path.dirname(longFilm))).toEqual(["long.mp4"]);
    expect(existsSync(process.env.PB4_MEDIA_DIR!)).toBe(false);
  }, 60000);

  test("H. the temporary folder is removed when extraction fails", () => {
    const root = tmpRoot("fail");
    const real = config.ffmpeg;
    config.ffmpeg = path.join(tmp, "no-such-ffmpeg.exe"); // probing (ffprobe) succeeds, extraction then fails
    try {
      expect(() => sampledFrames(longFilm, "long", root)).toThrow();
    } finally {
      config.ffmpeg = real;
    }
    expect(readdirSync(root)).toEqual([]);
    const broken = path.join(filmDir("broken-frames"), "broken.mp4");
    writeFileSync(broken, "not a video");
    expect(() => sampledFrames(broken, "short", root)).toThrow();
    expect(readdirSync(root)).toEqual([]);
  }, 60000);
});
