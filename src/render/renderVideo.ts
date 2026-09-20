import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { bundle } from "@remotion/bundler";
import { selectComposition, renderMedia, ensureBrowser } from "@remotion/renderer";
import type { RenderPlan } from "./types.ts";
import { config } from "../server/config.ts";

const ENTRY = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "index.ts");

export interface FilmJob {
  plan: RenderPlan;
  compositionId: "LongVideo" | "ShortVideo";
  outPath: string;
}

// Render one or more films that share a story's asset folder. Bundles once.
export async function renderFilms(publicDir: string, jobs: FilmJob[]): Promise<void> {
  await ensureBrowser();
  const serveUrl = await bundle({ entryPoint: ENTRY, publicDir });
  for (const job of jobs) {
    const composition = await selectComposition({ serveUrl, id: job.compositionId, inputProps: job.plan });
    await renderMedia({
      composition,
      serveUrl,
      codec: "h264",
      audioCodec: "aac",
      outputLocation: job.outPath,
      inputProps: job.plan,
    });
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
  const data = JSON.parse(out);
  const video = (data.streams || []).find((s: any) => s.codec_type === "video");
  const hasAudio = (data.streams || []).some((s: any) => s.codec_type === "audio");
  const [n, d] = String(video?.r_frame_rate || "30/1").split("/").map(Number);
  return {
    width: video?.width ?? 0,
    height: video?.height ?? 0,
    durationSec: Number(data.format?.duration ?? video?.duration ?? 0),
    fps: d ? n / d : 30,
    hasAudio,
  };
}
