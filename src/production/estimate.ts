import type { CostEstimate, Story } from "../types.ts";
import { PRICING, ttsUsd, round } from "../server/pricing.ts";
import { getScripts } from "../server/store.ts";
import { paulBunyanScripts } from "./fixtures/paulBunyan.ts";

export interface PlanCounts {
  longShots: number;
  shortShots: number;
  images: number; // generated stills
  motion: number; // motion clips
  longChars: number;
  shortChars: number;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

// Approximate counts for budgeting. The planner produces the exact numbers.
export function planCounts(story: Story): PlanCounts {
  const scripts = story.slug === "paul-bunyan" ? paulBunyanScripts : getScripts(story.id);
  const longChars = scripts?.long.length ?? 6200;
  const shortChars = scripts?.short.length ?? 850;
  const longShots = clamp(Math.round(longChars / 6 / 26), 14, 26); // ~26 spoken words/shot
  const shortShots = clamp(Math.round(shortChars / 6 / 14), 8, 12);
  const archive = 4;
  const images = longShots - archive + shortShots; // stills we generate (archive is free)
  const motion = clamp(Math.floor(longShots / 5), 3, 6) + 2;
  return { longShots, shortShots, images, motion, longChars, shortChars };
}

export function estimateJob(story: Story): CostEstimate {
  const c = planCounts(story);
  const lines = [
    { label: "Research (OpenAI web search)", usd: PRICING.openai.research, detail: "draft + audit + verification" },
    { label: "Long + Short scripts (OpenAI)", usd: round(3 * PRICING.openai.script), detail: "long + short + fidelity audit" },
    { label: "Narration (ElevenLabs)", usd: round(ttsUsd(c.longChars) + ttsUsd(c.shortChars)), detail: `~${c.longChars + c.shortChars} chars` },
    { label: "Reference image (OpenAI images)", usd: PRICING.openai.image, detail: "1 master still" },
    { label: "Cinematic stills (OpenAI images)", usd: round(c.images * PRICING.openai.image), detail: `${c.images} images` },
    { label: "Selective motion (Higgsfield, 5s)", usd: round(c.motion * PRICING.higgsfield.video), detail: `${c.motion} clips` },
  ];
  const total = round(lines.reduce((a, l) => a + l.usd, 0));
  return { total, lines };
}
