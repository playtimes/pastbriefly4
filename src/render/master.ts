import { spawnSync } from "node:child_process";
import { renameSync, rmSync } from "node:fs";
import { config } from "../server/config.ts";

// Upload loudness for every finished film: EBU R128 two-pass loudnorm to -16 LUFS
// integrated with a -1.5 dBTP true-peak ceiling. LRA is only loudnorm's target
// range; narration sits far below it, so it never widens or squeezes the mix.
export const MASTER = { I: -16, TP: -1.5, LRA: 11 } as const;

// Runs ffmpeg with the given arguments and returns its stderr (where loudnorm
// prints its JSON). Throws on a non-zero exit. Injectable so tests need no ffmpeg.
export type FfmpegRun = (args: string[]) => string;

const runFfmpeg: FfmpegRun = (args) => {
  const r = spawnSync(config.ffmpeg, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) {
    const tail = String(r.stderr ?? "").trim().split(/\r?\n/).slice(-3).join(" | ");
    throw new Error(`ffmpeg failed (${r.error?.message ?? `exit ${r.status}`}): ${tail}`);
  }
  return String(r.stderr ?? "");
};

interface Measured {
  input_i: string;
  input_tp: string;
  input_lra: string;
  input_thresh: string;
  target_offset: string;
}

// The last loudnorm JSON block in ffmpeg's stderr.
export function parseLoudnorm(stderr: string): Measured {
  const blocks = stderr.match(/\{[^{}]*"input_i"[^{}]*\}/g);
  if (!blocks) throw new Error("Audio mastering: loudnorm printed no measurement.");
  return JSON.parse(blocks[blocks.length - 1]);
}

// Master a rendered mp4's audio in place. Pass 1 measures; pass 2 applies the
// measured values (linear gain when it fits under the ceiling, otherwise loudnorm's
// own dynamic mode). The video stream is copied untouched; only audio is re-encoded
// to AAC. Pass 2 writes a temporary file that replaces the render only after ffmpeg
// succeeds, so a failure leaves the original render intact and no partial file.
// Digital silence (mock narration) has no measurable loudness and is left as is.
export function masterAudio(file: string, run: FfmpegRun = runFfmpeg): "mastered" | "silent" {
  const target = `loudnorm=I=${MASTER.I}:TP=${MASTER.TP}:LRA=${MASTER.LRA}`;
  const m = parseLoudnorm(run(["-hide_banner", "-nostdin", "-nostats", "-i", file, "-map", "0:a:0", "-af", `${target}:print_format=json`, "-f", "null", "-"]));
  if (![m.input_i, m.input_tp, m.input_lra, m.input_thresh, m.target_offset].every((v) => Number.isFinite(Number(v)))) return "silent";

  const measured = `measured_I=${m.input_i}:measured_TP=${m.input_tp}:measured_LRA=${m.input_lra}:measured_thresh=${m.input_thresh}:offset=${m.target_offset}`;
  const tmp = file.replace(/\.mp4$/i, "") + ".mastering.mp4";
  try {
    run([
      "-hide_banner", "-nostdin", "-nostats", "-y", "-i", file,
      "-map", "0:v:0", "-map", "0:a:0",
      "-c:v", "copy",
      "-af", `${target}:${measured}:linear=true:print_format=json`,
      "-c:a", "aac", "-b:a", "320k", "-ar", "48000", // loudnorm resamples internally; keep 48 kHz
      "-map_metadata", "0", "-movflags", "+faststart",
      tmp,
    ]);
    renameSync(tmp, file);
  } finally {
    rmSync(tmp, { force: true });
  }
  return "mastered";
}
