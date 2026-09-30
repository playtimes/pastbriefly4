import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { config } from "../server/config.ts";
import { probeVideo } from "./renderVideo.ts";

// Evenly spaced samples of the FINISHED mp4 (the rendered pixels, never the
// source stills), in two forms over the same sample times:
// - sampledFrames(): each sample as its own JPEG. This is what Final-film QC's
//   visual specialist sees, one labelled image per cell, so no cell has to be
//   located by its position in a grid.
// - contactSheet(): the samples tiled chronologically (left to right, top to
//   bottom) into one JPEG, for people: proof reports and debugging. One ffmpeg
//   call seeks each sample as its own input and tiles them; the JPEG comes back
//   on stdout, so nothing is written to disk. The Long is a WIDE 6x4 grid: a
//   vision model shrinks a high-detail image until its shortest side is 768px.
export const CONTACT_SHEET = {
  long: { cols: 6, rows: 4, width: 320, height: 180 }, // 1962x750 sheet
  short: { cols: 4, rows: 3, width: 216, height: 384 }, // 894x1176 sheet
} as const;

const GAP = 6; // white rule between cells, so neighbouring frames never read as one image

export interface ContactSheet {
  data: Buffer; // the JPEG
  times: number[]; // each cell's frame time in seconds, in cell order
  cols: number;
  rows: number;
}

// `count` sample times across the whole film, one in the middle of each equal
// slice: the first sits in the opening slice and the last in the closing one.
export function sampleTimes(durationSec: number, count: number): number[] {
  if (!Number.isFinite(durationSec) || durationSec <= 0) throw new Error("Contact sheet: the film has no usable duration.");
  return Array.from({ length: count }, (_, i) => Math.round(((i + 0.5) * durationSec * 1000) / count) / 1000);
}

// Samples the file's own probed duration, so every sample time has a frame.
export function contactSheet(videoPath: string, kind: "long" | "short"): ContactSheet {
  const grid = CONTACT_SHEET[kind];
  const times = sampleTimes(probeVideo(videoPath).durationSec, grid.cols * grid.rows);
  const inputs = times.flatMap((t) => ["-threads", "1", "-ss", t.toFixed(3), "-i", videoPath]);
  const cells = times.map((_, i) => `[${i}:v]trim=end_frame=1,setpts=PTS-STARTPTS,scale=${grid.width}:${grid.height},setsar=1[c${i}]`);
  const graph = `${cells.join(";")};${times.map((_, i) => `[c${i}]`).join("")}concat=n=${times.length}:v=1:a=0,tile=${grid.cols}x${grid.rows}:padding=${GAP}:margin=${GAP}:color=white`;
  const data = execFileSync(
    config.ffmpeg,
    ["-v", "error", "-nostdin", ...inputs, "-filter_complex", graph, "-frames:v", "1", "-f", "image2pipe", "-c:v", "mjpeg", "-q:v", "3", "-"],
    { stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024 },
  );
  if (data.length < 3 || data[0] !== 0xff || data[1] !== 0xd8) throw new Error("Contact sheet: ffmpeg returned no JPEG.");
  return { data, times, cols: grid.cols, rows: grid.rows };
}

// Each sampled frame fits a 640px box with its aspect kept: 640x360 for a
// landscape Long, 360x640 for a portrait Short. Large enough to inspect, far
// smaller than the full render.
export const FRAME_BOX = 640;

export interface SampledFrame {
  cell: number; // 1-based, chronological
  timeSec: number;
  jpeg: Buffer;
}

// The same samples as the contact sheet (24 Long, 12 Short, one in the middle of
// each equal slice), each as its own JPEG. One ffmpeg call seeks each sample as
// its own input and writes one small JPEG per sample into a private temporary
// folder outside story media; the folder is removed on success and on failure.
export function sampledFrames(videoPath: string, kind: "long" | "short", tmpRoot = os.tmpdir()): SampledFrame[] {
  const grid = CONTACT_SHEET[kind];
  const times = sampleTimes(probeVideo(videoPath).durationSec, grid.cols * grid.rows);
  const dir = mkdtempSync(path.join(tmpRoot, "pb4-frames-"));
  try {
    const inputs = times.flatMap((t) => ["-threads", "1", "-ss", t.toFixed(3), "-i", videoPath]);
    const scale = `scale=${FRAME_BOX}:${FRAME_BOX}:force_original_aspect_ratio=decrease,setsar=1`;
    const outputs = times.flatMap((_, i) => ["-map", `${i}:v:0`, "-frames:v", "1", "-vf", scale, "-q:v", "3", "-update", "1", path.join(dir, `${i + 1}.jpg`)]);
    execFileSync(config.ffmpeg, ["-v", "error", "-nostdin", ...inputs, ...outputs], { stdio: ["ignore", "pipe", "pipe"] });
    return times.map((timeSec, i) => {
      const jpeg = readFileSync(path.join(dir, `${i + 1}.jpg`));
      if (jpeg.length < 3 || jpeg[0] !== 0xff || jpeg[1] !== 0xd8) throw new Error(`Sampled frames: ffmpeg returned no JPEG for cell ${i + 1}.`);
      return { cell: i + 1, timeSec, jpeg };
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
