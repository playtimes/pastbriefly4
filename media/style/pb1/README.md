# PastBriefly visual references (internal)

INTERNAL style references for image generation — the PastBriefly world a new
story's reconstruction should feel related to. They are never shown to the viewer.

## Source

Pulled from the real PB1 repository (`playtimes/pastbriefly`, `public/history/`),
which was cloned read-only during the PB4 visual-authenticity pass. PB1 itself was
not modified. The renderer's visual language (grade, paper, cream type, accent
blocks, kicker/headline hierarchy, subtitle cues, cut flash) was matched to PB1's
actual `src/styles/*` and `src/components/card/*`, not just re-derived from a spec.

## Selected frames (chosen to be distinct, not near-duplicates)

- **vasa-listing.png** — the warship heeling as it floods. Water, sky and a single
  large subject: PB1's restrained palette and strong subject separation at their
  clearest. A "ship / open air" reference.
- **molasses-wave.png** — the Boston flood surge. A disaster in motion with heavy,
  physical material (not glossy) and warm brown-on-grime tones. A "catastrophe /
  material weight" reference.
- **tambora-summer-snow.png** — the year without a summer. Cold, muted, atmospheric
  light and a quiet landscape — the opposite mood to the flood, so the set spans
  PB1's range. An "atmosphere / muted daylight" reference.
- **mincemeat-identity.png** — the espionage deception close-up. Documents and a
  contained, low-key interior: PB1's evidence/reconstruction look. An "interior /
  close subject / paperwork" reference.

## Using these for a live run

List a story's chosen reference paths in its `StoryWorld.referenceImages` so
OpenAI image generation uses them as continuity references. Nothing else changes.

The six real PB1 *Operation Paul Bunyan* frames live in `../paul-bunyan/` and are
staged into the story's `refs/` by `npm run render:paul-bunyan`, which is how the
local acceptance Long and Short are built from genuine PB1 imagery (mock, no paid
calls).
