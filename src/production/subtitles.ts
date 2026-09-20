import type { WordTiming } from "../providers/elevenlabs.ts";
import type { SubtitleCue } from "../render/types.ts";

// Turn aligned words into short, readable phrases — broken on punctuation,
// natural pauses and length. Never word-by-word.
export function buildCues(words: WordTiming[], fps: number, kind: "long" | "short", maxFrame: number): SubtitleCue[] {
  const maxWords = kind === "short" ? 5 : 7;
  const maxChars = kind === "short" ? 34 : 52;
  const cues: SubtitleCue[] = [];
  let buf: WordTiming[] = [];

  const flush = () => {
    if (!buf.length) return;
    const text = buf.map((w) => w.word).join(" ");
    const startFrame = Math.round(buf[0].start * fps);
    const endFrame = Math.min(maxFrame, Math.max(startFrame + 1, Math.round(buf.at(-1)!.end * fps)));
    cues.push({ startFrame, endFrame, text });
    buf = [];
  };

  for (let i = 0; i < words.length; i++) {
    buf.push(words[i]);
    const w = words[i];
    const next = words[i + 1];
    const gap = next ? next.start - w.end : Infinity;
    const chars = buf.map((b) => b.word).join(" ").length;
    if (/[.!?]$/.test(w.word) || buf.length >= maxWords || chars >= maxChars || gap > 0.35) flush();
  }
  flush();
  return cues;
}
