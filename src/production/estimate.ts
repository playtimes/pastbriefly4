import type { CostEstimate, Story } from "../types.ts";
import { PRICING, AUTOPILOT_QUALITY_RESERVE_USD, ttsUsd, round } from "../server/pricing.ts";
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
  // A Long-first job stores only the Long, so a saved draft may have no Short.
  const shortChars = (scripts as { short?: string } | null)?.short?.length ?? 850;
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
    { label: "Selective motion (Runway Gen-4.5, 5s)", usd: round(c.motion * PRICING.runway.video5s), detail: `${c.motion} clips` },
    { label: "Visual planning (OpenAI)", usd: round(2 * PRICING.openai.visualPlan), detail: "coverage + edit" },
    { label: "Final-film QC (OpenAI)", usd: round(2 * (PRICING.openai.finalFactualReview + PRICING.openai.finalVisualReview)), detail: "2 factual + 2 final visual reviews" },
    { label: "Quality reserve", usd: AUTOPILOT_QUALITY_RESERVE_USD, detail: "automatic checks and bounded repairs; unused reserve is not spent" },
  ];
  const total = round(lines.reduce((a, l) => a + l.usd, 0));
  return { total, lines };
}

// A Long-first job (Stage 16A): only the work allowed before LONG COMPLETE, so
// no Short line at all. The same constants and counts as estimateJob, Long only:
// one Long write + its Long-only fidelity audit, the Long's narration, stills
// and motion, the two Long planning calls and the Long's two Final-film QC
// specialists. The quality reserve is unchanged.
export function estimateLongFirst(story: Story): CostEstimate {
  const c = planCounts(story);
  const images = c.longShots - 4; // archive is free, as in planCounts
  const motion = clamp(Math.floor(c.longShots / 5), 3, 6);
  const lines = [
    { label: "Research (OpenAI web search)", usd: PRICING.openai.research, detail: "draft + audit + verification" },
    { label: "Long script (OpenAI)", usd: round(2 * PRICING.openai.script), detail: "long + fidelity audit" },
    { label: "Narration (ElevenLabs)", usd: ttsUsd(c.longChars), detail: `~${c.longChars} chars` },
    { label: "Reference image (OpenAI images)", usd: PRICING.openai.image, detail: "1 master still" },
    { label: "Cinematic stills (OpenAI images)", usd: round(images * PRICING.openai.image), detail: `${images} images` },
    { label: "Selective motion (Runway Gen-4.5, 5s)", usd: round(motion * PRICING.runway.video5s), detail: `${motion} clips` },
    { label: "Visual planning (OpenAI)", usd: round(2 * PRICING.openai.visualPlan), detail: "coverage + edit" },
    { label: "Final-film QC (OpenAI)", usd: round(PRICING.openai.finalFactualReview + PRICING.openai.finalVisualReview), detail: "1 factual + 1 final visual review" },
    { label: "Quality reserve", usd: AUTOPILOT_QUALITY_RESERVE_USD, detail: "automatic checks and bounded repairs; unused reserve is not spent" },
  ];
  const total = round(lines.reduce((a, l) => a + l.usd, 0));
  return { total, lines };
}
