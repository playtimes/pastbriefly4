# Handoff: PB4 Create Page Redesign

## Overview
A premium, editorial redesign of the PastBriefly **Create** dashboard page. It keeps the existing app structure (sidebar with Create / Videos / Config, shared story-results area, manual search, niche browsing) and only restyles the Create page to a warm dark, cinematic look with the PB2 red accent.

**This is a visual redesign only. All existing PB4 behaviour stays.** Do not change data, routes, caching, or the Videos/Config screens.

## About the Design Files
The files in this bundle are **design references created in HTML** (`PB4-Create.html` is a self-contained render; `Create.dc.html` is the source). They are prototypes showing the intended look and behaviour — **not production code to paste directly**. Recreate them in the PB4 React + Tailwind codebase using its existing components, hooks, and data layer.

The prototype uses **mock niches, mock stories, and fake gradient artwork** purely so the layout is visible. **Ignore all of that.** Wire the real UI to PB4's actual data.

## Fidelity
**High-fidelity.** Colors, typography, spacing, radii, and hover states are final. Match them closely.

---

## What to KEEP (existing real behaviour — do not touch)
- Real YouTube / OpenAI niche data
- Existing SQLite caching
- Real story discovery
- Existing routes
- Config API-key handling
- Videos screen
- Current sidebar navigation (Create / Videos / Config — **do not add nav items**)

## What to REMOVE / IGNORE from the mock
- "Archivist / Free workspace" sidebar footer
- Hard-coded niches
- Hard-coded stories
- Fake gradient story artwork
- Fake search state

---

## Layout

Two-column app shell (this likely already exists — restyle, don't rebuild):

- **Sidebar**: fixed `250px`, full height, sticky. Background `#0b0807`, right border `1px solid rgba(245,235,222,0.07)`. Padding `30px 20px`.
- **Main**: fluid, `padding: 46px 52px 80px`, inner content wrapper `max-width: 1220px; margin: 0 auto`.

Main vertical order:
1. Page header (`Create` + subtitle)
2. Search control row
3. **Shared results area** (only rendered after a manual search OR a niche click)
4. Trending niches
5. Popular niches
6. Recommended for PastBriefly

Section-to-section vertical rhythm: results block `margin-top: 52px`; first niche section `margin-top: 56px`; subsequent niche sections `margin-top: 48px`.

---

## Components

### Sidebar
- **Brand**: 30×30 rounded square (`border-radius: 8px`, `background: #e50914`, `box-shadow: 0 4px 16px rgba(229,9,20,0.35)`) with serif "PB". Next to it, wordmark "PastBriefly" in Instrument Serif 22px `#f3ebde`, and an uppercase kicker "STORY STUDIO" (9.5px, `letter-spacing: 2.4px`, `#7c7266`). *(Kicker optional — omit if it doesn't fit your brand.)*
- **Nav items**: icon (18px, 1.6 stroke, `currentColor`) + label (14.5px, weight 500), `gap: 13px`, `padding: 11px 13px`, `border-radius: 11px`.
  - Active (Create): `color: #f7efe4`, `background: rgba(229,9,20,0.12)`, left bar via `box-shadow: inset 2px 0 0 #e50914`.
  - Inactive: `color: #8f8579`; hover `color: #f3ebde`, `background: rgba(245,235,222,0.04)`.
  - Icons: Create = 4-point sparkle; Videos = play in rounded rect; Config = sliders.
- **No footer.** Remove the mock's avatar/workspace block.

### Page header
- H1 "Create": Instrument Serif, weight 400, `52px`, `line-height: 1`, `letter-spacing: -0.5px`, `#f6efe4`.
- Subtitle: 17.5px, `line-height: 1.5`, `#a89e92`, `max-width: 720px`. Copy: *"Hunt down the true stories from history that sound completely made up — the near-misses, the swindles and the escapes — and shape them into your next video."* (adjust to real product voice).

### Search control row
`display: flex; gap: 12px; flex-wrap: wrap`. All controls height `56px`, `border-radius: 999px`.
- **Search input**: `flex: 1; min-width: 280px`. Background `#17110f`, border `1px solid rgba(245,235,222,0.11)`, text `#f3ebde`, `15.5px`, padding `0 22px 0 52px`. Magnifier icon (`#7c7266`) absolutely positioned left. Placeholder `#7c7266`: *"Try "Cold War stories", "strange money scandals", "ancient disasters"…"*. Focus: `border-color: rgba(229,9,20,0.55)`, `background: #1b1512`. **Enter key triggers search.**
- **Category select**: native `<select>`, `min-width: 200px`, `appearance: none`, padding `0 46px 0 20px`, text `#cabfb0` 14.5px, custom chevron (`#8f8579`) at right. Same bg/border as input. Options must be the app's **real** categories. *(Mock category labels: All categories / Conflicts & Standoffs / Money & Deception / Disasters / Escapes & Operations / Strange Everyday History — replace with the real category source.)*
- **Search button**: `padding: 0 34px`, `background: #e50914`, `color: #fff`, 15px weight 600, `box-shadow: 0 8px 24px rgba(229,9,20,0.28)`. Hover `background: #f5121d`, stronger shadow.

### Shared results area (rendered only after search or niche click)
- Header row: `border-bottom: 1px solid rgba(245,235,222,0.08)`, `padding-bottom: 20px`, baseline-aligned:
  - Eyebrow: 11px uppercase `letter-spacing: 2.6px` weight 600 `#e50914`. Text = "Search results" for manual search, "Browsing niche" for a niche click.
  - H2: Instrument Serif 33px `#f4ecdf`. Text = `Stories for <query>` (manual) or `Stories in <niche title>` (niche).
- Grid: `repeat(auto-fill, minmax(290px, 1fr))`, `gap: 22px`, `margin-top: 26px`.
- **Story card** (image-led, links to existing Story page):
  - Card: `border-radius: 16px; overflow: hidden; background: #14100e; border: 1px solid rgba(245,235,222,0.08); cursor: pointer`. Hover: `translateY(-4px)`, `border-color: rgba(245,235,222,0.2)`, transition `0.25s`.
  - Image: `aspect-ratio: 16/9`. **Use the real story thumbnail** (`object-fit: cover`). Provide a solid `#14100e` fallback when no image (do NOT recreate the mock's fake gradients). Bottom inner shadow `inset 0 -60px 60px -30px rgba(0,0,0,0.5)` for legibility.
  - Caption block: `padding: 17px 19px 20px`. Title = Instrument Serif 21px `#f4ecdf`, clamped to 2 lines. Hook = 13.5px `#968b7e`, clamped to 2 lines, `margin-top: 9px`.
  - Show **only** image + title + one short hook. No channel names, raw video titles, scores, or badges.

### Niche cards (Trending / Popular / Recommended — identical component)
- Section header row: `border-bottom: 1px solid rgba(245,235,222,0.08)`, `padding-bottom: 18px`. Left: H2 Instrument Serif 28px `#f4ecdf` ("Trending niches" / "Popular niches" / "Recommended for PastBriefly"). Right (optional): muted 12.5px `#7c7266` context label.
- Grid: `repeat(auto-fill, minmax(310px, 1fr))`, `gap: 18px`, `margin-top: 22px`.
- **Card** is a `<button>` (whole card clickable):
  - `min-height: 176px`, `padding: 24px 24px 20px`, `border-radius: 15px`, `background: #14100e`, `border: 1px solid rgba(245,235,222,0.08)`, flex column, `text-align: left`.
  - Hover: `translateY(-3px)`, `border-color: rgba(229,9,20,0.4)`, `background: #181310`, transition `0.25s`.
  - Title: Instrument Serif 24px `#f4ecdf`, clamped **max 2 lines**. Use the **real niche title**.
  - Description: 14px `line-height: 1.5` `#968b7e`, clamped **max 2 lines**. Use a concise real editorial description. **No emojis, no scores, no source snippets, no raw video titles.**
  - Footer action pinned bottom (`margin-top: auto; padding-top: 16px`): "FIND STORIES →", 12px uppercase `letter-spacing: 1.4px` weight 600 `#e50914`. This is the affordance — it must read as *browse this niche*, not *fill the search box*.

---

## Interactions & Behaviour

### Manual search
- User types a prompt and/or picks a category → clicks **Search** (or presses Enter) → call the **real discovery** with `{ query, category }`.
- **Preserve the user's entered text** in the input after searching.
- Render results in the shared results area with eyebrow "Search results" and heading `Stories for <query>` (fall back to a neutral heading if query empty).

### Niche click
- Clicking a niche card calls **real discovery directly for that niche** (pass the niche id/title to the same discovery entrypoint).
- **Do NOT modify the manual search input** — leave whatever the user typed untouched.
- Render results in the **same shared results area** with eyebrow "Browsing niche" and heading `Stories in <niche title>`.

### Story click
- Clicking a story card navigates to the **existing Story page/route** for that story.

### Results visibility
- The results area is hidden on first load. It appears after the first manual search or niche click and stays populated by the most recent action.

---

## State
Minimal — reuse PB4's existing discovery hook/store. The only page-local state:
- `query` (string, controlled input) — persists across niche clicks.
- `category` (string) — controlled select.
- `resultsMode`: `null | 'search' | 'niche'` — drives whether the results area shows and which eyebrow/heading to use.
- `resultsLabel` (string) — the query text or the niche title used in the heading.
- Story results themselves come from the existing discovery layer (loading/error/data states already handled there — surface a simple loading and empty state in the grid).

No new store, context, or abstraction layer. Keep it in the Create page component.

## Design Tokens
```
Background (page):        #0e0a09
Background (sidebar):     #0b0807
Surface (cards):          #14100e
Surface (input/select):   #17110f
Surface (input focus):    #1b1512
Surface (niche hover):    #181310
Accent (PB2 red):         #e50914
Accent hover:             #f5121d
Accent tint bg:           rgba(229,9,20,0.12)
Text (headings):          #f6efe4 / #f4ecdf
Text (body):              #f3ebde
Text (muted):             #a89e92 / #968b7e
Text (dim/labels):        #7c7266 / #8f8579
Border (hairline):        rgba(245,235,222,0.07–0.11)
Border (hover):           rgba(245,235,222,0.2) / rgba(229,9,20,0.4)

Radius: controls 999px · story card 16px · niche card 15px · nav item 11px · brand 8px
Control height: 56px
Fonts: headings/titles = Instrument Serif (400); UI/body = Hanken Grotesk (300–700)
Section gaps: 56 / 48 (niche sections), 52 (results)
Card grids: niches minmax(310px,1fr) gap 18 · stories minmax(290px,1fr) gap 22
Transitions: 0.25s ease on transform/border/background
```

## Tailwind notes
- Add the two fonts (Instrument Serif, Hanken Grotesk) to your font stack and expose as `font-serif`/`font-sans` (or custom `font-display`). Map the hex tokens above to your `tailwind.config` theme rather than inlining arbitrary values everywhere.
- Line clamping: `line-clamp-2`.
- Whole-card click = render the niche card as a `<button>` (or a `<div role="button">`) so hover/focus and keyboard activation work.

## Assets
No image assets in this bundle. Story imagery must come from the real story data; the mock's gradient tiles are placeholders only.

## Files in this bundle
- `PB4-Create.html` — self-contained visual reference (open in a browser).
- `Create.dc.html` — source of the reference (component markup + demo logic; **demo logic/data is mock, ignore it**).
- `Create.reference.jsx` — a paste-adjacent React + Tailwind starting point for the Create page, with `// INTEGRATION:` comments marking every place to wire real PB4 data/routes.

## After implementing
Run in the PB4 repo:
```
<your typecheck command>   # e.g. npm run typecheck / tsc --noEmit
<your test command>        # e.g. npm test
<your build command>       # e.g. npm run build
```
Do **not** touch production/video generation. Do **not** commit or push.
