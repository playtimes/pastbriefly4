// Conservative US-dollar estimates used only for budgeting the one cost
// approval. Not invoices.

export const PRICING = {
  openai: {
    research: 0.18, // the research stage: draft + audit + final verification (3 web-search passes)
    script: 0.03, // one script completion
    visualPlan: 0.05, // one visual planning call: Coverage or Editor (both films, no web search)
    image: 0.08, // one gpt-image-1 still
  },
  elevenlabs: {
    perThousandChars: 0.3,
  },
  runway: {
    video5s: 0.6, // one 5s Gen-4.5 clip: 12 credits/s x 5s x $0.01/credit
  },
} as const;

// Every Runway motion clip is exactly this long; pricing and the renderer rely on it.
export const MOTION_CLIP_SECONDS = 5;

export function round(n: number): number {
  return Math.round(n * 100) / 100;
}

export function ttsUsd(chars: number): number {
  return round((chars / 1000) * PRICING.elevenlabs.perThousandChars);
}
