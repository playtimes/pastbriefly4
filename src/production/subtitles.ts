import type { WordTiming } from "../providers/elevenlabs.ts";
import type { SubtitleCue } from "../render/types.ts";
import { plainDashes } from "./text.ts";

// Long cues are shown in a bounded two-line box (see Subtitles.tsx). A cue closes
// once it reaches LONG_CUE_CHARS, and a word that would carry it past
// LONG_CUE_MAX_UNITS starts the next cue instead, so no Long cue can outgrow two
// lines. Units are characters with wide glyphs (capitals, m, w) counted wider, so
// an all-caps phrase splits earlier. Measured in the render browser at the box
// width, 58 units of any realistic narration wraps to at most two lines. Only a
// single word longer than the cap can exceed it, and one word is one cue.
export const LONG_CUE_CHARS = 52;
export const LONG_CUE_MAX_UNITS = 58;
export function cueUnits(text: string): number {
  let units = 0;
  for (const ch of text) units += /[A-Z]/.test(ch) ? (ch === "I" ? 0.6 : /[MW]/.test(ch) ? 1.7 : 1.35) : /[mw]/.test(ch) ? 1.45 : 1;
  return units;
}

// Turn aligned words into short, readable phrases - broken on punctuation,
// natural pauses and length. Never word-by-word.
export function buildCues(words: WordTiming[], fps: number, kind: "long" | "short", maxFrame: number): SubtitleCue[] {
  const maxWords = kind === "short" ? 5 : 7;
  const maxChars = kind === "short" ? 34 : LONG_CUE_CHARS;
  const cues: SubtitleCue[] = [];
  let buf: WordTiming[] = [];
  const text = () => buf.map((b) => plainDashes(b.word)).join(" ");

  const flush = () => {
    if (!buf.length) return;
    const startFrame = Math.round(buf[0].start * fps);
    const endFrame = Math.min(maxFrame, Math.max(startFrame + 1, Math.round(buf.at(-1)!.end * fps)));
    cues.push({ startFrame, endFrame, text: text() });
    buf = [];
  };

  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (kind === "long" && buf.length && cueUnits(`${text()} ${plainDashes(w.word)}`) > LONG_CUE_MAX_UNITS) flush();
    buf.push(w);
    const next = words[i + 1];
    const gap = next ? next.start - w.end : Infinity;
    const chars = text().length;
    if (/[.!?]$/.test(w.word) || buf.length >= maxWords || chars >= maxChars || gap > 0.35) flush();
  }
  flush();
  return cues;
}
