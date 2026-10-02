# PastBriefly 4 Roadmap

The durable source of truth for where PB4 is and where it is going. Keep it
current. If this file and chat history disagree, this file wins.

## North star

**TRUE HISTORICAL STORIES THAT SOUND MADE UP.**

Story is the product. PastBriefly is **LONG-FIRST**.

- The Long film is the primary product.
- Shorts remain important for discovery and distribution, but they are
  downstream products of the finished Long, not produced in parallel with it.

The goal is not maximum automation as quickly as possible. The goal is
**quality high enough that automation becomes safe.**

The old parallel model (research → Long + Short produced together → finished
pair) is no longer the target direction.

Target production model:

```
Story
→ research + verification
→ Long script
→ Long narration
→ documentary visual plan
→ archive / deterministic visuals / selective generation
→ Long edit
→ Long final QC
→ finished Long
→ derive 1-3 Shorts from the finished Long
   (reuse Long research, media and scenes;
    vertical-specific recut / minimal extra media)
→ Short QC
```

Later target:

```
PB4 selects strong stories
→ produces the Long unattended
→ performs final-film QC
→ derives Shorts from the finished Long
→ sends clean films to a publishing queue
→ human only handles genuine exceptions / final policy decisions
```

Do not publish automatically until the production system has proven repeatable
quality across multiple fresh stories.

## Editorial hunting ground

The promise stays the same: TRUE HISTORICAL STORIES THAT SOUND MADE UP. What
broadens is the pool PastBriefly hunts in. "History" is not a narrow category:
search a much larger pool of extraordinary true stories.

Priority story territories:
- espionage / covert operations
- scams, frauds and corporate / financial collapses
- engineering disasters and impossible projects
- catastrophes, survival and bizarre real events
- deception, escapes and hoaxes
- strange diplomatic incidents
- unusual military / intelligence operations
- traditional historical stories (fully included)
- true-crime-adjacent stories, selectively, only when the premise is
  exceptional and fits PastBriefly

The filter is the story, not the category. A PastBriefly story still needs:
- an instantly understandable strange premise
- to be true and well sourced
- strong causal progression / escalation
- enough visual potential for a premium Long
- enough substance for a Long without padding
- a premise that sounds difficult to believe at first hearing

Do NOT chase CPM for its own sake: no pivot into unrelated categories such as
generic personal finance, AI tutorials, real estate or business advice merely
because advertiser rates may be higher. Broaden only where the stories still
feel unmistakably like PastBriefly. Which territory deserves more focus is
decided by real performance (step 16D), not in advance.

## Visual direction

PB4 should increasingly behave like an **automated documentary editor**, not an
image / video generator.

Locked visual hierarchy / editorial policy (confirmed by the 16B proofs):

A. **Real historical / documentary material** - archive photography and
   footage, documents and artifacts, when they genuinely tell the story and are
   reliable and properly licensed. Real evidence anchors truth.
B. **Deterministic explanation** - maps, diagrams, document treatments and,
   optionally, Blender spatial coverage, where they explain geography,
   mechanism, structure or spatial relationships better than a flat image.
C. **OpenAI reconstruction** - generated stills for moments with no useful
   surviving image: undocumented historical action, atmosphere / environments,
   interiors, human scenes, visual bridges and cinematic coverage archive
   cannot provide. Generated reconstructions remain an important source of
   PastBriefly visual identity.
D. **Generative video** - Runway / generative motion selectively, for rare
   hero moments where motion materially adds value. Not the default motion
   backend.

The target is real evidence anchoring truth, generated reconstruction
supplying cinematic storytelling, and deterministic visuals explaining space
and mechanism. It is NOT an archive-only documentary and NOT an AI-only
illustrated documentary. The hierarchy guides choices per moment; it is not a
quota.

Remotion remains the assembly / render layer.

## Current backend decision

The current image / Runway-heavy visual backend is **FROZEN**. Film #5 showed
it has reached diminishing returns: rearranging a homogeneous visual pool
cannot create genuine visual richness. Do not continue speculative hardening
of it and do not add another repair layer for it.

Keep the useful machinery already built:
- discovery
- research
- factual verification
- script QA
- narration
- archive acquisition
- Pixel Asset QA
- sequence QA
- final-film QC
- final visual self-repair
- spend / resume / provenance safety

## Cost principle

Lesson from Film #5: a ~$10-13 film is not automatically too expensive if it
reliably produces a premium publishable Long. The problem is spending that
amount and still getting a Long we would not publish. The Blender proof must
therefore evaluate BOTH quality and economics.

## Publishing during the reset

- Publish already-good existing films / Shorts while the Blender work happens.
- Do not wait for Blender before publishing usable inventory.
- Do NOT start another expensive full film on the frozen backend.
- Production (publishing existing inventory) and R&D can proceed in parallel.
- Automatic publishing is NOT approved.

## Product and engine rules

- Story is the product.
- Quality per production hour matters more than minimum API spend.
- Keep PB4 boring and simple internally where possible.
- The user operates creative decisions, not QA machinery.
- Engine controls stay under the surface.
- Film Grammar is **frozen** unless a real production blocker proves a change is necessary.
- Prefer evidence from real production runs over speculative architecture.
- Do not build new QA layers merely because they sound useful.
- Every new stage must remove a demonstrated production failure or a meaningful human burden.
- Human review is exception-based, not mandatory inspection.
- The user operates the story and creative decisions; PB4 operates the machinery.
- KISS: no speculative architecture.

## Roadmap

### Completed

1. **PB4 foundation** - DONE. Simple React / Vite / Remotion production application.
2. **Film Grammar** - DONE / FROZEN. Stable coverage, edit-slot and media-selection system.
3. **U-137 acceptance benchmark** - DONE. End-to-end production proof and first major hardening.
4. **Film #2: HNLMS Abraham Crijnssen** - DONE. First strong production film through the new system.
5. **Visual clarity hardening** - DONE.
6. **Film #3: Dagen H calibration** - DONE. Calibration run that exposed factual, visual and sequence weaknesses.
7. **Automatic Text QA** - DONE. Review → at most one bounded repair → final verification → human exception.
8. **Retained-media durability** - DONE.
9. **Pixel Asset QA** - DONE. Reviews actual image pixels. Generated stills may
   receive one automatic regeneration and verification. Archive remains read-only.
10. **Server-side Sequence QA** - DONE. Director review → bounded repair →
    deterministic cleanup → one coordinated repair where needed → final read-only verification.
11. **Visual Autopilot** - DONE. Asset QA → Long sequence QA → Short sequence QA →
    automatic visual approval only when the final saved state is clean.
12. **Autopilot v1 checkpoint** - DONE.

    12.5. **Autopilot UI simplification** - DONE / CLOSED. The product UI exposes
    human decisions rather than QA machinery.

    12.6. **Pre-Film #4 hardening** - DONE.
    - repo hygiene / durable roadmap
    - realistic Autopilot QA budget reserve
    - deterministic final-file sanity contract

13. **Film #4 - real Autopilot acceptance** - COMPLETED.

    Result:
    - Production completed end to end.
    - The publishability criteria below were not met unchanged: the final
      narration stated a causal claim more strongly than the evidence (the Short
      said Project X-Ray was cancelled "in favor of the atomic bomb"), and the
      assembled Long kept returning to the same few visual families.
    - Both defects escaped every earlier QA stage, which checks the ingredients
      before assembly rather than the finished film.
    - The production hardening discovered during the run is complete.

    Original brief:

    Use a completely new story that PB4 was not calibrated around. Normal interaction:

    ```
    choose story → Generate → leave PB4 alone
    ```

    PB4 may interrupt only for a genuine, concrete human exception.

    Film #4 succeeds when the Long and Short are films we would be comfortable
    publishing without rebuilding them. Acceptance considers:

    - factual accuracy
    - clear premise and causal story
    - no material unsupported claims
    - no misleading historical visual
    - no obvious generated-image defect
    - no nonsensical visual sequence
    - no materially distracting repetition
    - natural narration
    - correct subtitles
    - intentional-looking motion
    - working audio
    - working render
    - the Long stays interesting through its natural runtime
    - the Short works independently
    - the overall result does not feel like generic AI video

    The point of Film #4 is to discover **real** remaining production weaknesses.
    Add no more QA before Film #4 unless it is required for (1) budget safety or
    (2) deterministic output-file correctness.

14. **Final-film QC** - COMPLETED.

    **Stage 14A - specialist proof** - COMPLETED. The broad single-reviewer
    proof failed: it echoed PB4's causal synthesis and treated distinct asset
    ids as visual variety. A separate factual audit caught Film #4 Short's
    "cancelled in favor of the atomic bomb" causal compression. The dense
    contact-sheet visual input produced unreliable cell observations, even when
    its verdict was right.

    Stage 14A3 replaced that input with 24 / 12 individually labelled sampled
    frames, plus exact sampled-reuse and whole-film asset-use evidence. This
    solved the visual grounding problem. GPT-4.1 remained too permissive on the
    Long's final visual judgment. A controlled identical-payload evaluation
    with GPT-6 Astra at reasoning high passed: it returned grounded
    HUMAN_REVIEW for the Long's whole-film repetition (19 accurate cell
    observations, 5 reasonable/ambiguous, 0 materially wrong) and handled the
    L00 recurrence coherently. GPT-6 Astra with reasoning high is the visual
    Final-film QC candidate model. The proof is not integrated into production.

    **Stage 14B - integration** - COMPLETED.
    - Final-film QC runs after the deterministic final-file validation of both
      renders. Once both files pass, a durable marker means Retry, restart and
      acceptance never motion or render them again.
    - Four specialists per live production (Long factual, Long visual, Short
      factual, Short visual), all run even after a HUMAN_REVIEW. Each result is
      saved with its charge as soon as it exists, so a resume starts at the
      first missing specialist. Mock mode calls none of them.
    - The factual specialist keeps the configured text model with web search;
      the visual specialist uses GPT-6 Astra at reasoning high for that call
      only.
    - HUMAN_REVIEW becomes awaiting_final / Films need you, with only film,
      area, reason and a narration fragment made public. The one decision is
      Continue anyway.
    - PASS, or Continue anyway, registers the Long + Short pair in one
      transaction; only then is the job done / Ready.
    - No automatic final-film repair in Stage 14B.

    Controlled production-path validation - PASSED. The actual runJob path ran
    against an isolated copy of Film #4:
    - exactly 4 Final-film QC calls ran
    - the known defects were caught: Long visual (whole-film repetition) and
      Short factual ("cancelled in favor of the atomic bomb")
    - each specialist result persisted independently
    - the job stopped at awaiting_final with no Video rows
    - public finalQa exposed only the approved compact issue shape
    - Continue anyway resumed with zero provider calls and zero rerender
    - Long + Short registered atomically and the job reached Ready
    - tracked Final-film QC spend was exactly $1.70
    - real Film #4 DB / media and the repo were untouched

    Non-blocking observations:
    - factual web search is enabled, but actual tool use is not observable or
      guaranteed (the validation run made no searches)
    - GPT-6 Astra visual calls can take around 1-2 minutes
    - specialist issue wording may be too technical for the final user-facing
      UX

    Areas still not checked after assembly, for later Stage 14 slices only if
    Films #5 / #6 show real defects there:
    - generated Runway motion
    - TTS pronunciation, glitches and delivery problems
    - subtitle behaviour in the finished film
    - awkward cuts visible only in playback
    - pacing across complete sections
    - the interaction of motion, stills, narration and subtitles
    - final-film audio defects

    Prefer ONE useful finished-film QC layer over several overlapping systems.

15. **Finished-film review UX** - COMPLETED. A simple human-facing final review and
    exception experience. Do not recreate a technical cockpit.
    - awaiting_final lets the user watch the actual unregistered Long / Short
      renders.
    - Concerns are grouped by film with plain Fact / Visual presentation.
    - Stored engine reasons remain unchanged behind "Why PB4 stopped".
    - Continue anyway keeps pair-level acceptance semantics.
    - Isolated Film #4 UI review passed.
    - No repair machinery was added.

15A. **Film #5: Project Azorian** - COMPLETED as an R&D / acceptance result,
    not the start of another repair cycle. (Originally planned as "Films #5 and
    #6 acceptance"; Film #6 is now deferred until after the Blender proof, 16B.)

    What it proved:
    - Final-film QC works and catches meaningful whole-film repetition.
    - Commons query recall had a real defect: 0 of 6 archives found, from Title
      Case story identifiers, over-long shot queries and PDF-dominated
      results. Improved with an anchor-first short query, image-only search,
      better identifiers and paced, identified requests.
    - One bounded final visual self-repair was implemented safely: after a
      visual HUMAN_REVIEW, flagged archive fallbacks get one more archive
      search and the existing Pixel Asset QA; the remaining flagged non-motion,
      non-graphic slots get at most one existing-media sequence revision per
      film, checked once by the existing Director verification; only the
      changed film is re-rendered and audited once more. It never repeats.
    - The real Long-only repair used its one allowed attempt. Both recovered
      archives were rejected by Pixel QA; the sequence revision moved all 10
      flagged slots and passed Director verification.
    - Spend ended at $12.15 / $12.53.
    - The repair removed the original repeated families but created new
      repetition by redistributing the same limited visual pool. The new Long
      visual audit still returned HUMAN_REVIEW.
    - No second repair is allowed or desired. Do NOT add another repair layer
      for this backend.
    - The current image / Runway-heavy visual backend has reached diminishing
      returns (see Current backend decision).

    Project Azorian remains awaiting_final. It is NOT publishable / Ready as a
    production-system result. The Short may be used separately as channel
    inventory by human decision; that is not a production-system acceptance
    claim.

16B. **Blender 2.5D visual proof** - COMPLETED. Isolated R&D under
    `data/proofs/16b-azorian-glomar/` (gitignored); nothing integrated, $0
    provider spend, Film #5 untouched.

    What it proved:
    - **Isolated Blender spatial proof: PASS.** One reusable Glomar Explorer
      scene produced three genuinely different camera setups with real
      parallax. Extra cameras are cheap once the scene exists, and an RTX 4060
      Ti 8 GB has ample headroom. A single quality pass improved it but did not
      make Blender a premium standalone look: next to real photographs it still
      reads as stylized CG / a model.
    - **Mixed-media proof: PASS.** A 71.57-second section of the existing
      Azorian Long, re-cut with its unchanged narration from real archive (CIA
      documents, real ship photographs, artifacts, an approved CIA painting)
      plus two Blender shots, read clearly more like an edited documentary than
      Film #5 over the same narration: 11 distinct sources in 12 shots, no
      repeated generated image family, a healthier Long rhythm.
    - **The biggest gain came from real archive, not Blender.** PB4 had already
      found some of this material during Film #5 and discarded it because the
      edit did not select it. That is a demonstrated production weakness.
    - **Blender earned 9 of 71.57 seconds** as supporting coverage: structure
      and spatial orientation, and a moment with no archive. It looked weakest
      directly beside real views of the same ship.
    - The existing Runway clips and generated Glomar stills showed a ship
      configuration the sources do not support, so no new Runway spend was
      made for the proof.

    Conclusions:
    - Archive-first mixed documentary editing is validated.
    - Blender is approved as **optional deterministic supporting coverage**
      where spatial understanding adds value. It is NOT the primary visual
      backend.
    - OpenAI reconstruction remains part of the hierarchy for genuine visual
      gaps; generative video remains selective (see Visual direction).
    - No further isolated Blender R&D until a real Long demonstrates a need.
    - **Archive retention:** useful, verified archive discoveries (with their
      provenance) should not be discarded merely because the current edit does
      not select them. Keep this KISS: no asset-management platform.
    - Low-resolution archive still needs a sensible editorial presentation;
      handle it when a real Long needs it.
    - Breadcrumb only, not a fix and not a new QA layer: Film #5's narration
      says construction started in November 1972, while the recovered launch
      photograph is dated 1 November 1972.

    Film #6 has NOT started.

### Next

16A. **Long-first production reset** - DESIGN COMPLETE; Slice 1 COMPLETE;
    Slice 2 COMPLETE. NEXT: Film #6, the first real production proof of the
    Long-first system (not started). See `docs/STAGE-16A-LONG-FIRST-DESIGN.md`.
    - The Long-first contract stands: ONE job, serial Long → durable LONG
      COMPLETE → Short derivation.
    - Before LONG COMPLETE the Short does not exist.
    - Independent Long video registration needs no `videos` schema migration.
    - Existing jobs, including Project Azorian, keep pair-first semantics.

    Implementation order (design section J):
    1. **Slice 1 - archive retention: COMPLETE** (implemented, passed final
       Director review; `f5548f3`). Acquired, screened archive and its
       provenance survive, story-scoped, even when the edit does not select
       it. Small and boring: no asset platform.
    2. **Slice 2 - one honest Long-first vertical path: COMPLETE**
       (implementation finished, final review passed). Every new production
       job is Long-first; jobs without the flow marker (Project Azorian
       included) stay pair-first. For new jobs: Long
       script → Long Text QA → Long narration → Long visuals → Long render →
       Long Final-film QC → durable LONG COMPLETE → independent Long
       registration, with zero Short work or spend before LONG COMPLETE:
       before LONG COMPLETE, the Short does not exist.
    3. **Film #6: NEXT** - the first real production proof of the Long-first
       system. Film #6 has NOT started. The engineering is complete; no real
       Long has been produced through it yet.
    4. Then 16C, which stays BLOCKED until the Long-first system has produced
       and passed a real finished Long through Film #6.

    Rejected: a finish-only "Long-first" flow that stays pair-first upstream
    and only registers the Long earlier. It breaks the contract and leaves
    transitional semantics to remove later.

16C. **Long → Short derivation** - BLOCKED until the Long-first system has
    produced and passed a real finished Long through Film #6. Only once the
    Long-first approach works:

    ```
    finished Long
    → identify the strongest self-contained moments
    → derive 1-3 Shorts
    → reuse Long research / assets / scenes
    → add minimal vertical-specific media only when needed
    ```

    Do not build this before the Long-first proof is working.

16D. **Editorial lane test** - after the Long-first production path and the
    archive-led visual approach are working. Before narrowing the channel
    around one subcategory, produce and compare at least three strong Longs
    from different high-interest lanes (see Editorial hunting ground):
    1. espionage / covert operation
    2. business / scam / collapse
    3. engineering disaster / impossible project

    Use real YouTube performance to learn which territory deserves more focus.
    Useful signals:
    - impressions
    - CTR
    - early retention / first 30 seconds
    - average view duration
    - returning viewers
    - subscribers gained relative to views

    No winning lane is pre-selected. The result feeds the analytics loop (18)
    and story selection (19).

### Later

17. **Publishing workflow.** Initially: finished clean films → publishing queue /
    human approval. Automatic publishing comes later, only when explicitly approved
    and when the production system has demonstrated repeatable quality.

18. **Analytics loop.** Use real YouTube performance to learn:
    - which premises earn clicks
    - which hooks retain viewers
    - where Long retention falls
    - whether Shorts convert viewers into Long viewers
    - which story types work repeatedly
    - which editorial lanes deserve more focus (starting from the 16D lane test)

    Use analytics to improve editorial choices, not to create generic engagement slop.

19. **Story-selection automation.** PB4 eventually discovers, verifies and selects
    strong candidates itself from the whole Editorial hunting ground, preserving
    the promise: TRUE HISTORICAL STORIES THAT SOUND MADE UP. A candidate needs:
    - an instantly understandable strange premise
    - reliable sources
    - strong causal progression and escalation
    - visual potential
    - enough material for a good Long without padding
    - a Short with its own payoff

20. **Mostly unattended PastBriefly.**

    ```
    story discovery / selection → research → Long writing → Long media
    → automated QA → Long render → Long final-film QC
    → derived Shorts → Short QC → publishing queue → analytics feedback
    ```

    Human involvement is limited to:
    - genuinely ambiguous factual or editorial decisions
    - exceptional creative problems
    - unusual spend approval
    - publishing policy and final release decisions where required

## Current QA checkpoint

The existing pre-render QA is considered **sufficient for Film #4**.

- **Research:** draft research with web search; integrity audit with fresh web
  search; final fact verification with fresh web search.
- **Text:** Long and Short generation; script fidelity audit; Director Text QA;
  at most one repair; final verification.
- **Visual assets:** actual saved-pixel inspection; at most one generated-still
  regeneration; verification of the regenerated pixels; archive is never
  automatically altered.
- **Sequence:** narration / visual relevance, opening clarity, repetition, payoff
  progression, filler, factual graphics; bounded repair; deterministic cleanup;
  at most one coordinated repair; final verification.
- **Autopilot:** advances only when Asset QA, Long QA and Short QA are all clean;
  otherwise it stops for the human.

**After render:** Final-film QC (step 14) now reviews each finished film: a
factual audit and a whole-film visual audit (sampled frames, repetition
evidence), with at most one bounded final visual self-repair (step 15A).

**Known limitation:** finished-film QC does not yet check generated motion, TTS
delivery, subtitles in playback, awkward cuts, pacing or audio defects (see the
list under step 14).

## Known later hardening: restart durability

Automatic QA is deliberately safe across failures, but some active Autopilot state
lives only in server memory. A server restart at a QA gate can fall back to human
control instead of autonomously continuing that exact bounded QA operation.

This is safe, but not yet fully unattended. Do not fix it before Film #4 unless it
becomes an actual production blocker.

## Deferred cleanup

The remaining Paul Bunyan fixture and its production special cases are
intentionally kept until after Film #4 proves the generic production path. Do not
remove them merely for tidiness.

## Working method

```
inspect actual result
→ identify demonstrated problem
→ discuss / choose the smallest next decision
→ human approves
→ scoped implementation task
→ inspect / verify
→ stop at the next human gate
```

- The repo is the durable source of truth; chat / memory is continuity, not
  authority.
- KISS. Avoid large speculative refactors. No autonomous architecture expansion.
- The user operates the story / creative decisions; PB4 operates the machinery.
- Human review is exception-based.
- Film Grammar stays frozen unless a genuine blocker proves otherwise.
