import type { Framing } from "./types.ts";

// The crop an edit slot applies to its still, as a scale about a fixed origin.
// Scaling by >= 1 about a point inside the frame never exposes an edge, so every
// framing stays full-bleed. Deterministic and restrained: this is a fixed crop
// table, not a virtual camera.
export interface FramingTransform {
  scale: number;
  originX: number; // percent of the frame width
  originY: number; // percent of the frame height
}

const FRAMINGS: Record<Framing, FramingTransform> = {
  wide: { scale: 1, originX: 50, originY: 50 },
  medium: { scale: 1.18, originX: 50, originY: 48 },
  "detail-left": { scale: 1.5, originX: 22, originY: 50 },
  "detail-center": { scale: 1.5, originX: 50, originY: 46 },
  "detail-right": { scale: 1.5, originX: 78, originY: 50 },
};

export function framingTransform(framing: Framing | undefined): FramingTransform {
  return FRAMINGS[framing ?? "wide"] ?? FRAMINGS.wide;
}
