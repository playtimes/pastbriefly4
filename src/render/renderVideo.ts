import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { bundle } from "@remotion/bundler";
import { selectComposition, renderMedia, ensureBrowser } from "@remotion/renderer";
import type { RenderPlan } from "./types.ts";
import { config } from "../server/config.ts";
import { masterAudio } from "./master.ts";

const ENTRY = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "index.ts");

export interface FilmJob {
  plan: RenderPlan;
  compositionId: "LongVideo" | "ShortVideo";
  outPath: string;
}

// Render one or more films that share a story's asset folder. Bundles once. Each
// film's audio is then mastered in place to upload loudness (video copied).
// onProgress reports 0-1 across ALL films, weighted by each film's frame count,
// so a four-minute long film counts for more than a one-minute Short.
export async function renderFilms(publicDir: string, jobs: FilmJob[], onProgress?: (fraction: number) => void): Promise<void> {
  await ensureBrowser();
  const serveUrl = await bundle({ entryPoint: ENTRY, publicDir });
  const compositions = [];
  for (const job of jobs) compositions.push(await selectComposition({ serveUrl, id: job.compositionId, inputProps: job.plan }));
  const total = compositions.reduce((n, c) => n + c.durationInFrames, 0) || 1;
  let before = 0;
  for (const [i, job] of jobs.entries()) {
    const composition = compositions[i];
    await renderMedia({
      composition,
      serveUrl,
      codec: "h264",
      audioCodec: "aac",
      outputLocation: job.outPath,
      inputProps: job.plan,
      onProgress: ({ progress }) => onProgress?.((before + progress * composition.durationInFrames) / total),
    });
    masterAudio(job.outPath);
    before += composition.durationInFrames;
  }
}

export interface Probe {
  width: number;
  height: number;
  durationSec: number;
  fps: number;
  hasAudio: boolean;
}

// Read real dimensions/duration/audio from a rendered file via ffprobe.
export function probeVideo(file: string): Probe {
  const out = execFileSync(
    config.ffprobe,
    ["-v", "error", "-show_entries", "stream=codec_type,width,height,r_frame_rate,duration", "-show_entries", "format=duration", "-of", "json", file],
    { encoding: "utf8" }
  );
  return readProbe(out);
}

// ffprobe's JSON as a Probe. A frame rate ffprobe cannot state (no video stream,
// a missing or malformed r_frame_rate, a zero denominator, a non-positive result)
// is NaN, never an assumed 30, so the final file check rejects it.
export function readProbe(json: string): Probe {
  const data = JSON.parse(json);
  const video = (data.streams || []).find((s: any) => s.codec_type === "video");
  const hasAudio = (data.streams || []).some((s: any) => s.codec_type === "audio");
  const rate = /^\s*(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)\s*$/.exec(String(video?.r_frame_rate ?? ""));
  const fps = rate ? Number(rate[1]) / Number(rate[2]) : NaN;
  return {
    width: video?.width ?? 0,
    height: video?.height ?? 0,
    durationSec: Number(data.format?.duration ?? video?.duration ?? 0),
    fps: Number.isFinite(fps) && fps > 0 ? fps : NaN,
    hasAudio,
  };
}
