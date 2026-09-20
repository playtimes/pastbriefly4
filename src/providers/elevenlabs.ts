import { writeFile } from "node:fs/promises";
import { config } from "../server/config.ts";

// Live ElevenLabs narration. One call returns audio + character alignment:
//   POST /v1/text-to-speech/{voice_id}/with-timestamps
//   -> { audio_base64, alignment: { characters, character_start_times_seconds, character_end_times_seconds } }
// PENDING LIVE VERIFICATION before any paid run.

const API = "https://api.elevenlabs.io/v1";

export interface WordTiming {
  word: string;
  start: number; // seconds
  end: number;
}

// Narrate `text`, save the mp3 to outPath, and return per-word timings.
export async function narrate(text: string, outPath: string): Promise<WordTiming[]> {
  const { apiKey, voiceId, model } = config.elevenlabs;
  if (!apiKey) throw new Error("ELEVENLABS_API_KEY not set. Add it to .env to run live.");
  if (!voiceId) throw new Error("ELEVENLABS_VOICE_ID not set. Add it to .env to run live.");

  const res = await fetch(`${API}/text-to-speech/${voiceId}/with-timestamps`, {
    method: "POST",
    headers: { "xi-api-key": apiKey, "Content-Type": "application/json" },
    body: JSON.stringify({ text, model_id: model }),
  });
  if (!res.ok) throw new Error(`ElevenLabs ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const body = await res.json();
  await writeFile(outPath, Buffer.from(body.audio_base64, "base64"));
  return wordsFromChars(body.alignment);
}

// Collapse character-level alignment into word timings.
function wordsFromChars(a: { characters: string[]; character_start_times_seconds: number[]; character_end_times_seconds: number[] }): WordTiming[] {
  const words: WordTiming[] = [];
  let cur = "";
  let start = 0;
  for (let i = 0; i < a.characters.length; i++) {
    const ch = a.characters[i];
    if (/\s/.test(ch)) {
      if (cur) words.push({ word: cur, start, end: a.character_end_times_seconds[i - 1] ?? start });
      cur = "";
    } else {
      if (!cur) start = a.character_start_times_seconds[i];
      cur += ch;
    }
  }
  if (cur) words.push({ word: cur, start, end: a.character_end_times_seconds.at(-1) ?? start });
  return words;
}
