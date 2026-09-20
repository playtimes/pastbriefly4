import { writeFileSync, existsSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { config } from "../server/config.ts";

// Local stand-ins used when PROVIDER_MODE=mock, so the whole app (and the
// acceptance render) runs offline and free. These are clearly placeholders,
// never presented as real archive.

// A silent 16-bit mono WAV of `seconds`. Gives the film a real audio stream.
export function writeSilentWav(outPath: string, seconds: number): void {
  const rate = 44100;
  const samples = Math.max(1, Math.round(seconds * rate));
  const dataBytes = samples * 2;
  const buf = Buffer.alloc(44 + dataBytes);
  buf.write("RIFF", 0);
  buf.writeUInt32LE(36 + dataBytes, 4);
  buf.write("WAVE", 8);
  buf.write("fmt ", 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(1, 22); // mono
  buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write("data", 36);
  buf.writeUInt32LE(dataBytes, 40);
  writeFileSync(outPath, buf);
}

// ffmpeg's filter parser mangles the Windows drive colon in font paths, so we
// run ffmpeg with the fonts directory as cwd and reference fonts by name.
const FONTS_DIR = path.join(process.env.WINDIR || "C:/Windows", "Fonts");

function clean(s: string): string {
  return s.replace(/[:,'"\\%\n]/g, " ").replace(/\s+/g, " ").trim().slice(0, 60);
}

// If a story has dropped-in reference frames (real PastBriefly stills), the mock
// still-acquisition uses them instead of gray placeholders, cycling across shots.
// Lets the acceptance render use genuine PB visual material with no paid calls.
export function referenceFrame(refsDir: string, index: number): string | null {
  if (!existsSync(refsDir)) return null;
  const files = readdirSync(refsDir)
    .filter((f) => /\.(png|jpe?g|webp)$/i.test(f))
    .sort();
  if (files.length === 0) return null;
  return path.join(refsDir, files[index % files.length]);
}

// A clean placeholder still standing in for real imagery. The warm base varies
// per shot so the cut reads; a faint index differentiates shots. All visible
// text (caption, truth, subtitle) is drawn by the renderer, not baked in here.
export function writePlaceholderStill(
  outPath: string,
  opts: { width: number; height: number; index: number; label: string; truth: string; accent: string }
): void {
  const base = 0x120f0b + (opts.index % 6) * 0x030302;
  const hex = (n: number) => "0x" + n.toString(16).padStart(6, "0");
  const accent = opts.accent.replace("#", "0x");
  const tag = clean(opts.label) || String(opts.index);
  const vf = [
    `drawbox=x=0:y=ih-16:w=iw:h=16:color=${accent}:t=fill`,
    `drawtext=fontfile=georgia.ttf:text=${tag}:fontcolor=0x2a251d:fontsize=54:x=(w-text_w)/2:y=(h-text_h)/2`,
  ].join(",");
  execFileSync(
    config.ffmpeg,
    ["-f", "lavfi", "-i", `color=c=${hex(base)}:s=${opts.width}x${opts.height}`, "-vf", vf, "-frames:v", "1", "-y", path.resolve(outPath)],
    { stdio: "ignore", cwd: FONTS_DIR }
  );
}
