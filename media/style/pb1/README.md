# PastBriefly style reference (internal)

INTERNAL style reference for image generation. It is never shown to the viewer.

## The canonical reference

**tambora-summer-snow.png** is the one canonical PB1 style reference (the year
without a summer: cold, muted, atmospheric light). Production uses it as
`PB1_STYLE_REFERENCE` in `src/production/visuals.ts`.

Every generated reconstruction sends it for **style only**: grade, palette, light
and texture. Its scene content (the landscape, snow, figures, period) must never
leak into a new story's images.

## Continuity masters are separate

A story's continuity master is a different kind of reference: a neutral plate of
that story's recurring subject or world. A continuity shot sends the PB1 style
reference first and the master second. The master never replaces the style reference.

## What is gone

- The old Paul Bunyan acceptance image set (`media/style/paul-bunyan/`) and its
  local acceptance render have been removed.
- The other PB1 style images (vasa-listing, molasses-wave, mincemeat-identity) are
  no longer part of the active style-selection system and have been removed.

## Source

Pulled from the real PB1 repository (`playtimes/pastbriefly`, `public/history/`),
cloned read-only during the PB4 visual-authenticity pass. PB1 itself was not modified.
