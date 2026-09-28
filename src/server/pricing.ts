// Conservative US-dollar estimates used only for budgeting the one cost
// approval. Not invoices.

export const PRICING = {
  openai: {
    research: 0.18, // the research stage: draft + audit + final verification (3 web-search passes)
    script: 0.03, // one script completion
    visualPlan: 0.05, // one visual planning call: Coverage or Editor (both films, no web search)
    image: 0.08, // one gpt-image-1 still
    // Pixel Asset QA: one vision call (the text model with image inputs) is billed
    // by tokens, so it is budgeted per call plus per image. At gpt-4.1 rates ($2/M
    // input, $8/M output) a high-detail still is at most ~1,500 input tokens
    // (~$0.003) plus its intent text and a short verdict; $0.01 per image and
    // $0.02 per call (instructions, story line, summary) keep ~3x headroom.
    assetReviewCall: 0.02,
    assetReviewImage: 0.01,
  },
  elevenlabs: {
    perThousandChars: 0.3,
  },
  runway: {
    video5s: 0.6, // one 5s Gen-4.5 clip: 12 credits/s x 5s x $0.01/credit
  },
} as const;

// Not provider pricing: authorization headroom added to the cost approval so the
// bounded automatic checks and repairs of a normal run fit inside the approved
// maximum without asking for more. Nothing charges it; only successful paid calls
// are recorded as spend, so unused reserve is never recorded as spend.
export const AUTOPILOT_QUALITY_RESERVE_USD = 1.5;

// Every Runway motion clip is exactly this long; pricing and the renderer rely on it.
export const MOTION_CLIP_SECONDS = 5;

export function round(n: number): number {
  return Math.round(n * 100) / 100;
}

// One Asset QA vision call reviewing `images` stills.
export function assetReviewUsd(images: number): number {
  return round(PRICING.openai.assetReviewCall + images * PRICING.openai.assetReviewImage);
}

export function ttsUsd(chars: number): number {
  return round((chars / 1000) * PRICING.elevenlabs.perThousandChars);
}
