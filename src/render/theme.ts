// The PastBriefly look, taken from the real PB1 implementation: near-black warm
// base, warm cream type, one story accent used as a solid ink block, a restrained
// two-stop grade, a faint paper/scanline screen. Kept as plain tokens so both
// compositions read the same identity.

export const theme = {
  bg: "#11100e",
  ink: "#fff9e9",
  muted: "rgba(255,249,233,0.85)",
  accent: "#d3513d", // warm default; each film passes its own
  onAccent: "#15130f", // dark ink over an accent block
  captionInk: "#fff4e0",
  cutFlash: "#fff4d8",
  // Heavy poster sans for kicker/headline/emphasis; plain sans for body/meta.
  heavy: "'Arial Black', 'Segoe UI', system-ui, sans-serif",
  sans: "'Segoe UI', system-ui, -apple-system, Arial, sans-serif",
} as const;

// PB1's grade: a top-and-bottom darkening plus a gentle centre vignette, so
// editorial copy at top and bottom always sits on enough contrast.
export const GRADE =
  "linear-gradient(180deg, rgba(9,8,7,0.55) 0%, transparent 27%, transparent 64%, rgba(9,8,7,0.79) 100%)," +
  "radial-gradient(circle at 50% 42%, transparent 44%, rgba(8,7,6,0.27) 100%)";

// PB1's paper: fine horizontal scanlines with one soft highlight, screen-blended.
export const PAPER =
  "repeating-linear-gradient(0deg, transparent 0 3px, rgba(255,255,255,0.07) 3px 4px)," +
  "radial-gradient(circle at 24% 17%, rgba(255,255,255,0.18), transparent 22%)";

// PB1 grades the artwork itself, not just the overlay, so stills feel filmic.
export const ART_FILTER = "saturate(0.86) contrast(1.05) brightness(0.9)";
