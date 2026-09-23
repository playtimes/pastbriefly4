// Conservative US-dollar estimates used only for budgeting the one cost
// approval. Not invoices.

export const PRICING = {
  openai: {
    research: 0.18, // the research stage: draft + audit + final verification (3 web-search passes)
    script: 0.03, // one script completion
    visualPlan: 0.05, // one Visual Director planning call (both films, no web search)
    image: 0.08, // one gpt-image-1 still
  },
  elevenlabs: {
    perThousandChars: 0.3,
  },
  higgsfield: {
    video: 0.35, // one 5s Kling clip
  },
} as const;

export function round(n: number): number {
  return Math.round(n * 100) / 100;
}

export function ttsUsd(chars: number): number {
  return round((chars / 1000) * PRICING.elevenlabs.perThousandChars);
}
