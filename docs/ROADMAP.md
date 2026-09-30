# PastBriefly 4 Roadmap

The durable source of truth for where PB4 is and where it is going. Keep it
current. If this file and chat history disagree, this file wins.

## North star

**TRUE HISTORICAL STORIES THAT SOUND MADE UP.**

- The Long film is the main product.
- The Short supports discovery and distribution.

The goal is not maximum automation as quickly as possible. The goal is
**quality high enough that automation becomes safe.**

Current target workflow:

```
Human chooses story
→ Generate
→ PB4 researches, writes, creates and checks the films
→ PB4 interrupts only for a genuine human decision
→ finished Long + Short
```

Later target:

```
PB4 selects strong stories
→ produces them unattended
→ performs final-film QC
→ sends clean films to a publishing queue
→ human only handles genuine exceptions / final policy decisions
```

Do not publish automatically until the production system has proven repeatable
quality across multiple fresh stories.

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

### Next

14. **Final-film QC** - Stage 14A proof completed; Stage 14B in progress.

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

    **Stage 14B - integration** - IN PROGRESS. Implemented and covered by
    tests; not yet validated on a real production.
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
    - Next gate: a controlled production-path validation before calling 14B
      complete.

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

### Later

After Stage 14 validation:
- Blender 2.5D visual identity proof
- compare the same PastBriefly scene against current Runway motion
- no integration decision until side-by-side review

15. **Finished-film review UX.** A simple human-facing final review and exception
    experience. Do not recreate a technical cockpit.

    15A. **Films #5 and #6 acceptance.** At least two more genuinely different
    fresh stories. The goal is repeatability: one successful Film #4 proves the
    mechanism; three strong fresh films in a row begin to justify production automation.

16. **Publishing workflow.** Initially: finished clean films → publishing queue /
    human approval. Automatic publishing comes later, only when explicitly approved
    and when the production system has demonstrated repeatable quality.

17. **Analytics loop.** Use real YouTube performance to learn:
    - which premises earn clicks
    - which hooks retain viewers
    - where Long retention falls
    - whether Shorts convert viewers into Long viewers
    - which story types work repeatedly

    Use analytics to improve editorial choices, not to create generic engagement slop.

18. **Story-selection automation.** PB4 eventually discovers, verifies and selects
    strong candidates itself, preserving the promise: TRUE HISTORICAL STORIES THAT
    SOUND MADE UP. A candidate needs:
    - an instantly understandable strange premise
    - reliable sources
    - strong causal progression and escalation
    - visual potential
    - enough material for a good Long without padding
    - a Short with its own payoff

19. **Mostly unattended PastBriefly.**

    ```
    story discovery / selection → research → writing → media → automated QA
    → final-film QC → render → publishing queue → analytics feedback
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

**Known limitation:** the system mainly checks the ingredients BEFORE final motion
and render. The finished movie itself does not yet receive intelligent playback QC
(see step 14).

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
→ choose smallest useful fix
→ verify
→ freeze again
→ produce another real film
```

Avoid large speculative refactors. No autonomous architecture expansion.
