# PastBriefly 4

Pick a true historical story → **Generate films** → PB4 works automatically → if
needed, PB4 asks for one concrete decision → the Long and the Short are ready.

One package. Boring code, exceptional films.

## Quick start

```bash
npm install
npm run dev        # server on :8787, app on http://localhost:5173
```

Open http://localhost:5173. It runs in **mock mode** by default: everything works
offline and free, using local placeholder stills and silent narration so you can
see the whole product and the real Remotion renderer end to end.

For a real run, copy `.env.example` to `.env`, add provider keys, and set
`PROVIDER_MODE=live`.

## The product

The four main areas:

1. **Create** - find a story: search, categories, recommended and trending niches.
2. **Stories** - your story library and where each one is in production.
3. **Videos** - watch the Long and the Short, download, sources, previous versions.
4. **Config** - provider mode and provider credentials.

A story's own pages are part of that workflow, not extra nav items:

- **Story** - hero, hook, summary, moments, sources, then **Generate films** (or **Watch**).
- **Production** - where the story is (Researching, Writing, Recording narration,
  Creating visuals, Checking films, Rendering). PB4 checks its own text and
  visuals. It stops only when a real decision is needed, shows that one issue
  plainly, and then carries on. When the films are done it shows them, ready to watch.

## Commands

| command | what |
| --- | --- |
| `npm run dev` | run server + app |
| `npm run build` | build the app |
| `npm run typecheck` | type-check everything |
| `npm test` | run the test suite |
| `npm run studio` | open the Remotion studio |
| `npm run youtube:auth` | one-time read-only OAuth for the PastBriefly channel (owner analytics) |
| `npm run youtube:analytics -- --start YYYY-MM-DD --end YYYY-MM-DD` | official owner snapshot (default: last 28 complete days) |
| `npm run youtube:reporting:init` | create the missing Reporting API jobs (idempotent) |
| `npm run youtube:reporting:sync` | download new Reporting API CSVs |

Owner analytics credentials, tokens and raw data live only in `data/analytics/youtube/` (gitignored).

## Structure

```
src/
  app/         React + Tailwind UI (Create, Stories, Story, Production, Videos, Config)
  server/      Fastify + better-sqlite3: config, db, store, routes, worker, security
  production/  research → scripts → narration → visuals → QA → generate (the pipeline)
  providers/   openai, elevenlabs, runway, youtubeOwner
  render/      Remotion: Root, LongVideo, ShortVideo, Shot, Subtitles, PastBrieflyFrame, theme
  types.ts     shared types
media/
  style/pb1/   the canonical PB1 style reference (see its README)
  stories/     generated assets + renders per story (gitignored)
```

## Modes

- **mock** (default): local, free, offline. Placeholder stills, silent narration,
  no motion generation. Proves the full product and renderer.
- **live**: real research (OpenAI), scripts (OpenAI), stills (OpenAI images),
  narration (ElevenLabs), selective motion (Runway). You approve one maximum
  spend when you press Generate films. After that, Autopilot handles text and
  visual QA automatically and stops only for genuine human exceptions. Costs are
  reserved against the approved maximum, and completed paid work is reused on resume.

## Environment (live)

See `.env.example`. API keys are read server-side only and never sent to the
browser. The dev server binds to localhost.
