# PastBriefly 4

Pick a true historical story → press **Generate Short + Long** → get a Short and a
long documentary that feel like PastBriefly → watch them in the app.

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

## The four screens

1. **Stories** - browse featured stories, categories, search, Find stories, Surprise me.
2. **Story** - hero, hook, summary, moments, sources, then **Generate Short + Long** (or **Watch**).
3. **Creating** - human-facing progress, plus one **Visual direction** review before spending on motion.
4. **Videos** - watch the Long and Short, download, sources, previous version.

## Commands

| command | what |
| --- | --- |
| `npm run dev` | run server + app |
| `npm run build` | build the app |
| `npm run typecheck` | type-check everything |
| `npm test` | run the test suite |
| `npm run render:paul-bunyan` | render the acceptance Long + Short locally (mock, no paid calls) |
| `npm run studio` | open the Remotion studio |

## Structure

```
src/
  app/         React + Tailwind UI (Stories, Story, Creating, Videos)
  server/      Fastify + better-sqlite3: config, db, store, routes, worker, security
  production/  research → scripts → narration → visuals → generate (the pipeline)
  providers/   openai, elevenlabs, higgsfield (live API clients)
  render/      Remotion: Root, LongVideo, ShortVideo, Shot, Subtitles, PastBrieflyFrame, theme
  types.ts     shared types
media/
  style/       internal PastBriefly visual references
  stories/     generated assets + renders per story
```

## Modes

- **mock** (default): local, free, offline. Placeholder stills, silent narration,
  no motion generation. Proves the full product and renderer.
- **live**: real research (OpenAI), scripts (OpenAI), stills (OpenAI images),
  narration (ElevenLabs), selective motion (Higgsfield). Every paid run is gated
  by one cost approval and one visual-direction review. Costs are reserved against
  the approved maximum, and completed paid work is reused on resume.

## Environment (live)

See `.env.example`. API keys are read server-side only and never sent to the
browser. The dev server binds to localhost.
