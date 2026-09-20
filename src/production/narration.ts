import { config } from "../server/config.ts";
import { narrate as elevenNarrate, type WordTiming } from "../providers/elevenlabs.ts";
import { inStory, mediaRel } from "./paths.ts";
import { writeSilentWav } from "./mockAssets.ts";
import { words as splitWords } from "./text.ts";

export interface Narration {
  audioRel: string; // story-folder-relative (for staticFile)
  audioMediaRel: string; // media-relative (for HTTP)
  durationSec: number;
  words: WordTiming[];
}

export async function recordNarration(slug: string, kind: "long" | "short", text: string): Promise<Narration> {
  if (config.mode === "live") {
    const rel = `audio/${kind}.mp3`;
    const timings = await elevenNarrate(text, inStory(slug, rel));
    const durationSec = (timings.at(-1)?.end ?? 0) + 0.4;
    return { audioRel: rel, audioMediaRel: mediaRel(slug, rel), durationSec, words: timings };
  }

  // Mock: deterministic word timings + a silent track of the matching length.
  const timings = mockTimings(text);
  const durationSec = (timings.at(-1)?.end ?? 1) + 0.6;
  const rel = `audio/${kind}.wav`;
  writeSilentWav(inStory(slug, rel), durationSec);
  return { audioRel: rel, audioMediaRel: mediaRel(slug, rel), durationSec, words: timings };
}

function mockTimings(text: string): WordTiming[] {
  const ws = splitWords(text);
  const timings: WordTiming[] = [];
  let t = 0.3;
  for (const w of ws) {
    const dur = Math.min(0.6, Math.max(0.18, 0.16 + w.replace(/[^a-zA-Z]/g, "").length * 0.028));
    timings.push({ word: w, start: t, end: t + dur });
    t += dur;
    if (/[.!?]$/.test(w)) t += 0.34;
    else if (/[,;:]$/.test(w)) t += 0.14;
    else t += 0.03;
  }
  return timings;
}
