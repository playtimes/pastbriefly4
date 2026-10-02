# Stage 16A - Long-first production design

Design document. Slice 1 (archive retention, J.2) and Slice 2 (the Long-first
vertical path, J.3) are complete. Film #6, the first real production proof of
the Long-first system, is next and has not started; 16C stays blocked until it
has produced and passed a real finished Long. `docs/ROADMAP.md` stays the source of
truth; this file records what the current code couples, the contract we are
moving to, and how the completed Stage 16B evidence shapes the Long phase's
visuals (sections F and I).

Grounded in `main` at `ecc1cb7`. Status: design complete; Slice 1 COMPLETED
(`f5548f3`); Slice 2 COMPLETED (final review passed); Film #6 next, not started.

## A. Current pair-first coupling

One job produces the Long and the Short together. Every gate below waits for
both films.

| Area | Where | Coupling |
| --- | --- | --- |
| Research | `research.ts` `researchStory()` | One package per story, no film split. **Not coupled.** |
| Scripts | `generate.ts` `runJob()` (~197-221); `scripts.ts` `writeScript()`, `auditScripts()` | Two script calls, then one joint audit whose schema requires `long` and `short` (`scripts.ts` ~466). `scratch.scripts` and `stories.scripts` are `{long, short}`. |
| Text QA | `scripts.ts` `reviewStoryDraft()`, `verifyStoryDraft()`, `reviseStoryText()`; `generate.ts` `autoTextQaForJob()` | One review of both scripts. The prompts check the Short against the Long. Repair returns both scripts or fails. One gate: `awaiting_text` plus `scratch.textApproved`. |
| Narration | `generate.ts` (~234-250), `narration.ts` `recordNarration()` | Two calls, but the step finishes only when both `scratch.narration.long` and `.short` exist. |
| Visual planning | `visuals.ts` `planVisuals()` (~2216) | One plan for both films. Coverage, repair, Editor and adjacent-repeat calls each return `{long, short}`. The asset pools are separate (`L00` / `S00`), but both prompts see both scripts. `MOTION_BUDGET = {long:5, short:3}`. |
| Acquisition | `generate.ts` (~286-363); `visuals.ts` `acquireStill()`, `searchArchive()`, `acquireMotion()`; `runway.ts` `generateMotion()` | One master (`images/hero.png`). The loops cover both films, and the archive duplicate ledger spans both. `clearWorkingVisuals()` (`paths.ts`) clears both. |
| Preview | `visuals.ts` `buildPreview()` | Needs both shot lists. One `awaiting_preview` gate with one `jobs.preview_approved` flag. |
| Asset QA | `generate.ts` `autoAssetQaForJob()` | One run and one `scratch.assetQa.clean` flag for both films. `assetQa.ts` itself works per film. |
| Director QA | `directorQaRun.ts` `runDirectorQa(kind)`; `generate.ts` `visualGateClean()`, `autoVisualQaForJob()` | QA runs per film, but the Autopilot needs Asset QA and both Director runs clean before one approval. |
| Render | `generate.ts` (~365-398) `renderPlans()`; `render/renderVideo.ts` `renderFilms()` | Both films are planned and rendered in one call, and progress is weighted across both. |
| Final-film QC | `generate.ts` `finishFilms()` (~414-482); `finalFilmQa.ts` `FINAL_SPECIALISTS` | Both files are probed and validated before `outputsValidated` is saved. Four specialists run. Any non-PASS sends the whole job to `awaiting_final`. Continue anyway (`acceptFinalForJob()`) accepts both films. |
| Registration | `generate.ts` `finishFilms()` → `store.ts` `addVideos()` | Both rows are written in one transaction, then the job is `done`. No Video row exists before that. |
| UI | `app/productionStage.ts` `latestCompletePair()`, `productionTarget()`; `screens/Creating.tsx`, `Production.tsx`, `Videos.tsx`, `Story.tsx` | A job counts as finished only with both kinds (`videos.length >= 2`, `CompletePair`). The review copy says "accepts both films". The Videos screen groups rows by job as a pair. |
| Pricing | `server/pricing.ts`; `production/estimate.ts` `planCounts()`, `estimateJob()` | Only a pair estimate: Long+Short scripts, both narrations, 2 factual + 2 visual final reviews. One `approved_max` and `spent` per job. |
| Job/resume | `jobs` table; `generate.ts` `Scratch`, `runJob()`, `films()`; `worker.ts` | Each step is skipped once its scratch key exists, and most keys hold both films. `films(scratch)` always returns both. State lives only in `jobs.scratch`. `media/stories/<slug>/jobs/` is created but never written. |

## B. Locked future contract

```
ONE STORY JOB
→ LONG PHASE
→ durable LONG COMPLETE
→ later SHORT DERIVATION phase
```

Before LONG COMPLETE, the Short does not exist:
- no Short script
- no Short narration
- no Short visual plan
- no Short media generation
- no Short Runway
- no Short render
- no Short provider spend

The Long phase reuses today's stages with the Short removed from each, not a
new pipeline.

## C. LONG COMPLETE invariant

LONG COMPLETE requires all of:
1. The final Long file passes the deterministic check (`validateFinalVideo()` in
   `render/finalCheck.ts`, today called per film from `finishFilms()`).
2. Long Final-film QC (Long factual + Long visual) is PASS, or a person
   explicitly resolves it (the existing Continue anyway, scoped to the Long).
3. The Long is independently durable: its Video row is written and the job
   records LONG COMPLETE before any Short work starts.

A later Short failure must not invalidate, unregister, re-render or remove the
Long. Short failures stay on the Short phase.

## D. Storage finding

Checked against `src/server/db.ts` and the live DB schema:

```sql
videos (id TEXT PRIMARY KEY, story_id, job_id, kind TEXT NOT NULL, path,
        width, height, duration_sec, fps, has_audio, created_at)
```

- `kind` exists (`VideoKind = "long" | "short"`, `types.ts`). There is no CHECK,
  no UNIQUE on `(job_id, kind)`, and nothing requires two rows per job. The only
  index is the primary-key autoindex.
- `store.ts` `addVideo(v)` already inserts one row as an idempotent upsert on
  `id`. `addVideos()` is only a transaction wrapper around it.
- Ids are deterministic, `${job.id}-${kind}`.

**Conclusion:** registering the Long alone now and the Short later needs **no
schema migration**. `addVideo()` is enough for both. The pair is enforced only
in code: `finishFilms()`, `addVideos` usage, and the UI checks listed in A.

Caveats for implementation, not blockers:
- Nothing links a Short to its source Long except `story_id` / `job_id`. That is
  enough while Short derivation stays inside the same job.
- `path` is fixed at `stories/<slug>/renders/{kind}.mp4`, so a later job for
  the same story overwrites the file that older rows point to. This happens
  today. The Short never writes `renders/long.mp4`, so Short work cannot
  overwrite the Long.
- `hasVideos` (`store.ts`) becomes true on the first row. That matches
  "Long is a finished product".

## E. Existing machinery to keep

Conceptually unchanged, re-scoped to one film where needed:
- **Research / source package** (`researchStory()`, facts, sources, world). It
  is already film-agnostic, and the Short will reuse it.
- **Provenance**: truth labels (`archive` / `reconstruction` / `graphic`),
  archive attribution, and the Runway `.req.json` journal.
- **Archive acquisition**: the anchor-first Commons search (`searchArchive()` /
  `fetchArchive()`), the duplicate-bytes ledger, and Pixel QA of archive. These
  become more central under section I; only their retention changes.
- **Budget / spend safety**: `approved_max`, `spent`, `budget()` / `record()`,
  `AUTOPILOT_QUALITY_RESERVE_USD`, record-only-on-success.
- **Narration timing**: word timings drive slot boundaries and subtitles.
- **QA concepts**: Text QA (review → one repair → verify), Pixel Asset QA,
  Director sequence QA (already per film), Final-film QC (already per film via
  `FinalFilmInput.kind`), and the one bounded final visual self-repair.
- **Resume / durability**: skip-if-saved scratch steps, the
  `outputsValidated` marker, per-specialist result persistence, and
  requeue-on-restart.
- **Remotion assembly**: `LongVideo` composition, `Shot`, `PastBrieflyFrame`,
  and `Subtitles`, as long as Remotion stays the assembly layer.

## F. After 16B: decided and still deferred

16B is complete (see ROADMAP 16B). It decided:
- Blender is **optional deterministic supporting coverage**, not the new
  production engine. Do not hardcode a Blender-first visual planner, and do not
  choose a Blender production architecture (scene authoring, asset library,
  render farm, Remotion hand-off) until a real Long demonstrates the need.
- Long-phase visuals are **archive-led mixed media** under the locked
  hierarchy (section I). OpenAI reconstruction stays supported for genuine
  gaps; Runway stays selective.

Still deferred:
- Do not refactor `planVisuals()` just to make today's frozen backend
  Long-only. When the Long phase's planning changes, it changes toward
  section I, in its own slice.
- Do not redesign Film Grammar (frozen per ROADMAP).
- Do not design the full 16C Short system: moment selection, vertical recut,
  extra vertical media.
- Long-only pricing and the motion budget are settled in Slice 2 (section J),
  not before.

The implementation order is fixed in section J: archive retention first, then
one honest Long-first vertical path. A finish-only "Long-first" step is
rejected (J.1).

## G. Compatibility

- Existing jobs, including Project Azorian (currently `awaiting_final`), keep
  their pair-first semantics. Resume, Continue anyway and pair registration
  behave exactly as today for any job created before Long-first exists.
- Stage 16A does not migrate or reinterpret any existing scratch or job state.
  A future implementation must tell the two job kinds apart explicitly, not by
  inferring from missing Short keys.
- The existing pair rows in `videos` stay valid. The UI must keep showing them.

## H. Non-goals

- No implementation of Long-first production in 16A.
- No Stage 16C (Short derivation) design or code.
- No Blender integration into PB4. Blender is approved only as optional
  supporting coverage (section I); no production architecture is chosen.
- No Film Grammar change and no refactor of the frozen image / Runway backend.
- No schema migration.
- No generalized media-asset system.
- No change to Project Azorian or any existing job, DB row or media.
- No Film #6.

## I. Long-phase visuals after 16B

When the Long phase's visual planning is implemented (Slice 2, section J), it
follows the locked hierarchy in ROADMAP "Visual direction". This is guidance
per moment, not a quota.

1. **Real material first** where it genuinely tells the story: archive
   photographs, documents, artifacts, properly licensed.
2. **Deterministic explanation** where it explains geography, mechanism or
   structure better than a flat image: maps, diagrams, document treatments,
   and optional Blender coverage.
3. **OpenAI reconstruction** for genuine gaps: undocumented action,
   environments, interiors, human scenes, visual bridges.
4. **Runway** only for rare hero moments.

**Archive retention (demonstrated by 16B).** The mixed proof's biggest gain
came from real archive that Film #5 had found and lost. Two code paths drop
verified discoveries today:
- `wikimedia.ts` `fetchArchive()` keeps the first acceptable result per
  query; the other valid candidates are never recorded.
- The final visual repair deletes a recovered archive file that fails Pixel
  QA for its slot's purpose (`generate.ts` `recoverFinalArchive()`, `rmSync`).
  Film #5's real ship-at-sea photograph was lost this way. It was rejected
  only because the slot asked for the ship under construction.

Design rule, kept KISS (implemented by Slice 1, section J.2):
- An archive file PB4 has actually acquired survives beyond the slot that
  found it, story-scoped, with its provenance. "Acquired" means it passed
  `fetchArchive()`'s existing screening (usable licence, on-subject anchors,
  event relevance, unique bytes) and was downloaded. Search results that were
  never accepted are not retained.
- Being "not selected", or failing Pixel QA *for one slot's purpose*, is not a
  reason to destroy it. The review outcome is recorded next to it, so later
  planning can judge it.
- Retention never puts anything in a film. The owner asset and the edit still
  decide what appears.
- No asset-management platform, no cross-story library, no new QA layer.

**Provenance stays with the material:** truth label, source page, license,
and the credit shown on screen. A licence that requires attribution
(for example CC BY-SA) must carry it through to the edit.

**Blender stays optional.** It is used only where spatial understanding adds
value and no better real or deterministic material exists. Its fidelity
matters most beside archive of the same subject. Nothing in the planner
should assume Blender exists.

## J. Implementation plan

### J.1 Order, and the rejected finish-only step

1. **Slice 1 - archive retention** (J.2). COMPLETED.
2. **Slice 2 - one honest Long-first vertical path** (J.3). COMPLETED.
3. **Film #6** - the first real production proof of the Long-first system.
   Next; not started.
4. **16C - Long → Short derivation**, blocked until the Long-first system has
   produced and passed a real finished Long through Film #6.

**Rejected:** a "Long-first" job that stays pair-first upstream and only
registers the Long earlier at the finish. It would still write, narrate, plan,
acquire, animate, render and pay for a Short before LONG COMPLETE, breaking
contract B. It would also create a transitional job semantic that a later slice
must remove. No such flow is built. The first Long-first job PB4 runs satisfies
the full contract.

### J.2 Slice 1 - archive retention

Status: COMPLETED. Implemented and passed final Director review; committed as
`f5548f3` (feat: retain screened archive candidates).

**Demonstrated defect.**
- Archive files PB4 acquired and screened are destroyed in three places:
  - `recoverFinalArchive()` deletes a recovered file that fails Pixel QA for
    its slot (`generate.ts`, `rmSync`). This is how Film #5's real
    ship-at-sea photograph was lost.
  - `clearWorkingVisuals()` deletes the whole `archive/` folder when a new job
    starts on the story (`paths.ts`).
  - `clearVisualsForRebuild()` deletes referenced files.
- Even archive that is used loses most of its provenance.
  `fetchArchive()` returns `sourcePage`, `assetUrl`, `license` and `sha256`,
  but `searchArchive()` keeps only `{path, credit}`. The Commons title is only
  logged.

**Smallest behavior change.** When `fetchArchive()` accepts a file (live
only), `searchArchive()` also copies it into a story-scoped retained folder
with one provenance sidecar. That covers normal acquisition and the final
repair's second search, which both go through `searchArchive()`.
`recoverFinalArchive()` records its rejection reason in that sidecar before
deleting the *working* copy. Nothing else changes:
- the working copies, edits, deletion paths, Pixel QA and the ledger behave
  exactly as today;
- the film never reads the retained folder.

**Storage shape.** Files only; no DB table, no `videos` / `jobs` schema change:

```
<DATA_DIR>/archive-retained/<slug>/
  <full sha256>.jpg | .png   the accepted bytes (identity = full sha256;
                             type from the bytes, else the Commons MIME)
  <full sha256>.json         provenance sidecar
```

It lives under `DATA_DIR`, outside the story folder (Remotion's `publicDir`)
and outside the media tree, so no render bundles it and neither
`clearWorkingVisuals()` nor a visual rebuild can reach it.

Sidecar fields (`RetainedArchive` in `archiveRetention.ts`):
- `status: "screened archive candidate"`, `sha256`, `file`, `story`
- `title`, `sourcePage`, `assetUrl`, `license` (as Commons gives them,
  unaltered), `artist` / `rawCredit` (the raw Commons Artist / Credit fields,
  left out when Commons gives none), `credit` (PB4's display credit)
- `acquisitions: [{ at, query, film, owner, jobId }]`, appended when the same
  bytes are accepted again
- `reviews: [{ at, film, assetId, decision: "rejected", reason, by, jobId }]`,
  appended where a verdict already exists (the final repair's rejection)

One media file per hash; a repeat adds an acquisition event only.

**Provenance rules.**
- Only what `fetchArchive()` already accepts is retained. Its licence filter is
  unchanged.
- Licence and credit are stored exactly as received; nothing is inferred.
- An attribution licence (CC BY / BY-SA) keeps its credit and source page,
  so any later use can attribute it.
- Retained does not mean factually verified for a slot. Truth labels still
  apply only when an edit binds the file and Asset QA reviews it.

**Likely files.**
- `src/production/wikimedia.ts`: `ArchiveResult` gains the Commons title, the
  MIME type and the raw Artist / Credit fields. The query comes from
  `searchArchive()`.
- `src/production/visuals.ts`: `searchArchive()` calls retention after a
  success.
- A small helper (e.g. `src/production/archiveRetention.ts`, two functions:
  retain, note outcome).
- `src/production/generate.ts`: `recoverFinalArchive()` notes the rejection
  before `rmSync`.
- `src/production/paths.ts`: retained-folder path. `clearWorkingVisuals()`
  stays unchanged and is tested not to reach it.

**Tests.**
- An accepted archive is retained with a complete sidecar, and the
  shot / edit / credit is unchanged.
- Results that `fetchArchive()` rejects (licence, off-shot, unrelated,
  duplicate) are not retained.
- The same bytes accepted twice give one file and two `acquired` entries.
- A final-repair rejection deletes the working copy, keeps the retained copy,
  and records the reason (the Film #5 case).
- `clearWorkingVisuals()` and `clearVisualsForRebuild()` leave
  `archive-retained/` intact.
- Mock mode retains nothing.
- A retention write failure is logged and never fails the paid acquisition.
- The existing archive acquisition / relevance / recall / repair tests pass
  unchanged.

**Non-goals.**
- No planner change, and nothing reads the retained folder yet.
- No backfill: nothing is reconstructed for Film #5 or older stories.
- No new stage, UI, CMS, cross-story library or cache.
- No change to which file a shot gets.
- No storage of search results that were never accepted.

**Compatibility.** Additive for every job, legacy included. The retained
folder is under `DATA_DIR`, not in the story folder that is Remotion's
`publicDir`, so it adds nothing to any render bundle.

### J.3 Slice 2 - one honest Long-first vertical path

Status: COMPLETED. The implementation is finished and its final review passed.
Every new production job created through Generate is Long-first; jobs without
the flow marker (every job created before, Project Azorian included) stay
pair-first; before LONG COMPLETE, the Short does not exist. The engineering is
complete; the first real Long production proof (Film #6) has not happened yet.
The corrections below come from the implementation-ready inspection of the
actual code and replace the earlier assumptions where they differ.

**Lifecycle (new Long-first jobs only):**

```
research + verification
→ Long script → Long script audit → Long Text QA → story review gate
→ Long narration
→ Long visual planning → master reference → Long acquisition
→ Long Asset QA → Long Director QA → visual gate
→ Long motion where selected
→ Long render → deterministic final-file validation
→ Long Final-film QC (+ the one bounded Long visual repair)
→ addVideo(long) → durable LONG COMPLETE → job done
```

Before LONG COMPLETE there is no Short script, Text QA, narration, plan,
acquisition, image, Runway clip, render, QC or spend. Scratch never gains a
Short key in this phase.

**The text gate is human.** Automatic Text QA never approves: its PASS means the
draft is ready for the Director's review. Revise story (the existing evidence),
and **Research more** (Film #6 showed a strong story whose verified evidence
pack was too thin: one targeted three-pass research refresh of the current
package from the Director's request, then a new draft by the normal writer and
fidelity audit, saved only if all of it succeeds) both re-run Text QA on the new
draft. The job stays at awaiting_text, pre-media, until Approve & continue.

**No empty Short state.** Absence means absence: a Long-first job never
persists a placeholder such as `short: ""`, `short: {}`, `shortShots: []`,
`retainedPresentations.short` or `finalFilmQa.short`. Where a shared helper
needs two lists (`buildPreview`, the existing edit repair), the Long-first path
passes an empty list as a function argument only; it is never saved. The mock
script writer builds only the requested format, so a Long-first mock run never
constructs a Short either.

**State / versioning.**
- One saved discriminator, `scratch.flow = "long-first"`, written in the same
  insert that creates the job. That means `createJob()` takes optional initial
  scratch, so a crash can never leave a new job unmarked.
- No flow means legacy pair-first, forever. A job created before Slice 2 ships
  stays legacy even if it resumes afterwards; existing scratch is never
  reinterpreted.
- No new job types and no parent / child jobs.
- LONG COMPLETE is `scratch.longComplete = { videoId, at }`, saved with
  `state: "done"` in ONE job update right after `addVideo(long)`.
  `addVideo()` is an idempotent upsert on `${jobId}-long` (it keeps the row's
  `created_at`), so a crash between the two re-registers safely on resume: the
  validated file is only re-probed, the saved QC results skip every reviewer,
  nothing is rendered or charged again, and one row exists. No extra
  transaction is needed.
- Inside the flow, the code works over an explicit film list,
  `filmKinds(scratch)`: `["long"]` for Long-first, `["long","short"]` for
  legacy. `films(scratch)` and the production loops that hard-coded both films
  go through it, so they stay one code path instead of being copied.

**Pair couplings that must change for this flow:**

| Area | Today | Long-first |
| --- | --- | --- |
| Scripts | `writeScript` per kind, then the pair `auditScripts()` (schema needs long + short) | Long write + a Long-only audit; `scratch.scripts` / `stories.scripts` hold only `long` |
| Text QA | `reviewStoryDraft` / `verifyStoryDraft` / `reviseStoryText`, `textQaInput()` send both scripts; prompts check Short against Long; repair returns both | Long-only input, schema and prompt; the cross-film consistency check drops out |
| Story review | `reviewFromJob()` (`routes.ts`) needs `shortScript`; UI shows both | Long only |
| Narration | done only when both exist | Long only |
| Visual planning | `planVisuals()` makes TWO joint model calls (Coverage, Editor) returning `{long, short}`; the Coverage repair and edit repair already ask only about the films that have targets | Long-only Coverage and Editor (prompt, schema, payload, mock fallback) in `planLongVisuals()`; the two repair calls are reused unchanged; see below |
| Preview / gates | `buildPreview(story, long, short)`; `visualGateClean()` needs both Director runs; Autopilot runs Long then Short QA | Long-only preview; gate needs Asset QA + the Long Director run |
| Asset QA / motion / render | loops over both films; `renderFilms` gets both | Long only |
| Final QC / finish | `finishFilms()` validates both, four specialists, pair registration; the final repair needs both factual PASS; Continue anyway accepts both | Long validation, Long factual + visual, the repair scoped to the Long and needing only the Long's factual PASS, `addVideo(long)`, LONG COMPLETE |
| Pricing | `estimateJob()` / `planCounts()` price both films | Long-phase estimate only (below) |
| UI / Ready | `latestCompletePair()`, `videos.length >= 2`, "accepts both films", Visual Review builds both, Videos assumes a pair | A Long-first job is finished with its Long; Long-only review / Ready copy; legacy views unchanged |

**Further pair couplings the inspection found (all handled for Long-first,
unchanged for legacy):**
- `planCounts()` read `scripts.short.length` and threw on a stored Long-only
  draft, which would have broken the story page and Generate (500).
- `jobProgress()` counted scripts and narration out of 2.
- Resume checks: narration needed both films (`!narration.long ||
  !narration.short`) and planning needed both plans (`!longShots ||
  !shortShots`), so a Long-first job would have re-narrated and re-planned,
  and paid again, on every resume.
- Seven `buildPreview(story, longShots, shortShots!)` call sites (preview gate,
  Director review / cleanup, sequence revision, still regeneration, final
  repair).
- `FinalFilmQaRecord.short` was required, and `finalFilmResults()` read it
  unguarded; `finishFilms()` probed both files and required both films PASS;
  `finalVisualRepairPlan()` required the Short's factual PASS and visual audit;
  `resumeFinalVisualRepairForJob()` probed `renders/short.mp4`.
- `visualGateClean()` waited for both Director runs, and the Visual Autopilot
  always ran the Short's Director QA (a Long-first job would never be approved).
- `toPublic()` exposes no scratch, so the UI could not tell a Long-first job;
  story detail had no way to tell a finished Long from a legacy lone video;
  `ReadyPanel` dereferenced the Short and would crash.
- `createJob()` could not take initial scratch.

**Planning boundary.**
- `planVisuals()` is not refactored and keeps its pair shape. Most of the
  planner already works per film: `planSlots()`, `screenCoverage()`,
  `validateEdit()`, `archiveHolds()`, `adjacentRepeatTargets()`,
  `normalizeMotionPriorities()`, `selectMotion()`, `assembleEdit()` and Film
  Grammar take `kind`; `buildPresentations()` takes one film's assets.
- Only Coverage and Editor are joint. `planLongVisuals()` (in `visuals.ts`)
  gives the Long its own Coverage and Editor calls around the same per-film
  machinery and reuses the existing Coverage repair and edit repair calls. It
  needed no new exports: it lives beside the private helpers it uses. The pair
  prompts, payloads and schemas are pinned byte-for-byte to their pre-Slice-2
  hashes by a test.
- The Long-only Coverage prompt is where section I's hierarchy enters, as
  guidance rather than quotas: real material first, then graphics / maps for
  explanation, reconstruction for genuine gaps and cinematic storytelling,
  motion selective. It names no Blender backend. Blender coverage stays a later,
  need-driven addition.
- **Retained archive (decided: Coverage only).** The Long Coverage call is
  given this story's retained archive (Slice 1) as a compact inventory labelled
  SCREENED ARCHIVE CANDIDATES (screened, not approved): title, licence, credit,
  the searches that found each, and any slot rejection reason, at most 20, read
  by `retainedArchiveInventory()`; malformed sidecars are skipped and no path or
  hash reaches the prompt. Any archive it then plans goes through the normal
  `searchArchive()` → `fetchArchive()` screening into `archive/long-NN.jpg` and
  Pixel Asset QA. Retained bytes are never reused directly or rendered from
  `DATA_DIR`: the sidecar keeps only the Commons title, not the description and
  categories `fetchArchive()` screens anchors against, so a direct reuse would
  be a second, weaker screening. Deferred unless real production shows the need.
- **Known limitation.** A brand-new story has no retained archive, so the
  inventory does not help a new story's FIRST Coverage call (Film #6's first
  plan included). It helps a visual rebuild, a later job for the same story,
  later re-planning and the future Short derivation.
- **Master reference (decided: unchanged).** The master still stays
  unconditional (one image, $0.08). `scratch.masterRef` is also the
  "visual work started" sentinel that clears an older job's working files, and
  `images/hero.png` doubles as the story thumbnail, so skipping it would be
  unrelated lifecycle work.

**Pricing / spend.**
- `estimateLongFirst()` covers only pre-LONG COMPLETE work, from the same
  `PRICING` constants and `planCounts()` as the pair estimate:
  - research (`research`)
  - Long script + Long fidelity audit (`2 x script`)
  - Long narration (`ttsUsd(longChars)`)
  - master still (`image`)
  - Long stills (`(longShots - 4) x image`) and Long motion
    (`clamp(floor(longShots / 5), 3, 6) x video5s`)
  - Long Coverage + Editor (`2 x visualPlan`)
  - Long Final-film QC (`finalFactualReview + finalVisualReview`)
  - the quality reserve (`AUTOPILOT_QUALITY_RESERVE_USD`)
- With today's constants and default counts that is $9.39 (the pair estimate
  is $12.53). Generate and the story page use it for every new job;
  `estimateJob()` is unchanged.
- **Reserve (decided: unchanged at $1.50 for the first proof).** It still
  covers real Long-only bounded work (Text QA and its repair, planner repairs,
  archive-hold repair, Asset QA and still regeneration, Director QA, and the
  final visual repair with its $0.75 re-audit). Actual Film #6 spend is
  measured before any tuning.
- `budget()` / `record()`, `approved_max`, `spent` and record-only-on-success
  are unchanged.
- No Short reserve is needed before LONG COMPLETE.
- The later Short derivation is authorized as a continuation of the same job:
  - an explicit new approval raises `approved_max` (the existing
    `raiseApprovedMax` pattern);
  - the same `budget()` / `record()` / skip-if-saved resume rules apply;
  - Long scratch keys and the Long video are read-only from then on.
  - Details belong to 16C.

**Test strategy.**
- **Whole-path test.** One mock end-to-end Long-first job, plus a live-mode
  test with stubbed providers. They assert that every provider call is Long,
  that scratch never has a Short key before LONG COMPLETE, that
  `renders/short.mp4` / `audio/short.*` are never written, and that recorded
  spend contains no Short item.
- **Unit tests per changed coupling.** Long-only audit, Text QA, planner calls,
  preview, gate, finish and estimate.
- **Resume tests.** At every step, including between `addVideo(long)` and
  `longComplete`: no duplicate rows, no re-charge, no re-render.
- **Final repair.** Scoped to the Long and still bounded once.
- **Routes.** `generate` creates flow jobs with the Long estimate;
  accept-final accepts the Long.
- **UI helpers.** A Long-only finished job.
- **Legacy regression.** The whole existing suite passes unchanged for jobs
  without `flow`. That is the compatibility guarantee, Project Azorian
  included.

**Compatibility.**
- Legacy jobs keep the exact pair-first code path, gates, specialists, Continue
  anyway and pair registration.
- Existing `videos` rows and UI views stay valid.
- No `videos` migration: `kind` + `addVideo()` suffice (section D).
- `stories.scripts` may hold a Long-only object for flow jobs. Readers such as
  `planCounts()` and the story page accept a missing `short`.
- UI: the public job carries `flow` only for a Long-first job; story detail
  lists `longCompleteJobIds`, so a LONG COMPLETE job's lone Long is Ready while
  a legacy lone video still never counts (or hides the last pair). Ready, the
  story page, Watch, Visual Review and Story Review show no empty Short.

**Deliberately deferred.**
- 16C: Short derivation, its pricing and continuation approval.
- Blender integration.
- Low-resolution archive presentation.
- Direct reuse of retained archive bytes.
- Retiring the legacy pair path.
- Film Grammar changes.
- Reserve tuning, after real Long-first spend is measured.

**Why this is the smallest honest slice.**
- The contract forbids any Short work before LONG COMPLETE, so every stage of
  the Long path must be Long-only at once. Any narrower slice is the rejected
  transitional flow.
- It stays small by reusing the per-film machinery that already exists and
  changing only the joint calls, gates and finish. That means one discriminator,
  one marker, no new tables, no 16C and no new visual engine.

### J.4 16C boundary (not designed here)

```
LONG COMPLETE → later derive 1-3 Shorts → reuse Long research / media / scenes
→ minimal extra vertical media → Short QC
```

It stays blocked until the Long-first system has produced and passed a real
finished Long through Film #6. A Short failure never touches the Long.
