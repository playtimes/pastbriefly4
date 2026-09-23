import { describe, test, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";

// v1A.2 Visual Director: ONE structured planning call decides what the viewer
// should SEE for both films. Timing (narration beats) is built and mapped
// locally, never by the model. Mock mode never touches a provider - it uses a
// tiny deterministic fallback planner.
const tmp = mkdtempSync(path.join(os.tmpdir(), "pb4-visual-director-"));
process.env.PROVIDER_MODE = "mock";
process.env.PB4_DATA_DIR = path.join(tmp, "data");
process.env.PB4_MEDIA_DIR = path.join(tmp, "media");

const { planVisuals, buildBeats, openAiVisualDirector, DIRECTOR_INSTRUCTIONS } = await import("../src/production/visuals.ts");
import type { DirectorInput, DirectorPlans, DirectorShot } from "../src/production/visuals.ts";
const { paulBunyanStory, paulBunyanResearch, paulBunyanScripts } = await import("../src/production/fixtures/paulBunyan.ts");
const { recordNarration } = await import("../src/production/narration.ts");
const { ensureStoryDirs } = await import("../src/production/paths.ts");
const { wordCount, groupBeats } = await import("../src/production/text.ts");

const story = { ...paulBunyanStory, createdAt: new Date().toISOString() };

async function narration() {
  ensureStoryDirs(story.slug);
  const long = await recordNarration(story.slug, "long", paulBunyanScripts.long);
  const short = await recordNarration(story.slug, "short", paulBunyanScripts.short);
  return { long, short };
}

// The mock (offline) plan, produced by the fallback planner - no provider.
async function mockPlan() {
  return planVisuals(story, paulBunyanResearch, paulBunyanScripts, await narration());
}

describe("mock mode plans offline, with no provider", () => {
  test("planVisuals uses the deterministic fallback planner, not the model", async () => {
    // In mock mode planVisuals routes to the offline fallback director. Its output
    // is fully deterministic, so matching its exact signature proves no model call
    // happened: reconstruction purposes are the fixed fallback string, and a
    // graphic lands on every fifth beat.
    const plans = await mockPlan();
    expect(plans.long.length).toBeGreaterThan(0);
    expect(plans.short.length).toBeGreaterThan(0);
    expect(plans.long[1].purpose).toMatch(/^Show the key action of this moment at/);
    expect(plans.long[4].truth).toBe("graphic"); // fallback places a graphic at i % 5 === 4
  });
});

describe("every shot has a reason to exist", () => {
  test("each shot carries an informational purpose and concrete constraints", async () => {
    const { long } = await mockPlan();
    for (const s of long) {
      expect(s.purpose.length).toBeGreaterThan(8);
      expect(s.purpose).not.toMatch(/atmosphere|cinematic|tension|mood/i);
      expect(s.mustShow.length).toBeGreaterThan(0);
      expect(s.mustNotShow.join(" ")).toMatch(/modern/i); // anachronism guard is always present
    }
  });

  test("reconstruction prompts are built from purpose and constraints", async () => {
    const { long } = await mockPlan();
    const recon = long.filter((s) => s.truth === "reconstruction");
    expect(recon.length).toBeGreaterThan(0);
    for (const s of recon) {
      expect(s.prompt).toContain("Purpose:");
      expect(s.prompt).toContain("Must show:");
      expect(s.prompt).toContain("Do not show:");
      expect(s.prompt).toContain(s.purpose); // the purpose is the spine of the prompt
    }
  });

  test("graphic shots describe the information they must convey and hold still", async () => {
    const { long } = await mockPlan();
    const graphics = long.filter((s) => s.truth === "graphic");
    expect(graphics.length).toBeGreaterThan(0);
    for (const g of graphics) {
      expect(g.prompt).toMatch(/information graphic/i);
      expect(g.prompt).toContain("It must make clear:");
      expect(g.prompt).not.toMatch(/cinematic editorial historical reconstruction/i);
      expect(g.wantsMotion).toBe(false);
      expect(g.useMaster).toBe(false); // graphics never borrow the master
    }
  });

  test("motion is only ever set on reconstructions, never on graphics or archive", async () => {
    const plans = await mockPlan();
    for (const s of [...plans.long, ...plans.short]) {
      if (s.wantsMotion) {
        expect(s.truth).toBe("reconstruction");
        expect(s.motion).not.toBe("hold");
      }
      if (s.truth !== "reconstruction") expect(s.wantsMotion).toBe(false);
    }
  });

  test("only the opener carries a headline caption; later beats have none", async () => {
    const { long } = await mockPlan();
    expect(long[0].caption?.variant).toBe("opener");
    for (const s of long.slice(1)) expect(s.caption).toBeUndefined();
  });

  test("the master reference is borrowed only by a minority of reconstructions", async () => {
    const { long } = await mockPlan();
    const withMaster = long.filter((s) => s.useMaster);
    expect(withMaster.length).toBeGreaterThan(0);
    expect(withMaster.length).toBeLessThan(long.length / 2);
    for (const s of withMaster) expect(s.truth).toBe("reconstruction");
  });
});

describe("narration beats are created and mapped locally", () => {
  test("buildBeats partitions every word contiguously and long has more beats than short", async () => {
    const { long: nLong, short: nShort } = await narration();
    const longBeats = buildBeats("long", paulBunyanScripts.long, nLong);
    const shortBeats = buildBeats("short", paulBunyanScripts.short, nShort);

    expect(longBeats[0].wordStart).toBe(0);
    for (let i = 1; i < longBeats.length; i++) expect(longBeats[i].wordStart).toBe(longBeats[i - 1].wordEnd);
    expect(longBeats.at(-1)!.wordEnd).toBe(wordCount(paulBunyanScripts.long));

    // Materially more visual progression than a single beat, and Long > Short.
    expect(longBeats.length).toBeGreaterThan(shortBeats.length);
    expect(longBeats.length).toBeGreaterThan(10);
  });
});

describe("planVisuals maps director decisions with local timing and index", () => {
  // A fake director that returns one deterministic decision per beat, so we can
  // prove the mapping, not the model. Timing and index must come from the beats.
  const fakeDirector = async (input: DirectorInput): Promise<DirectorPlans> => ({
    long: input.beats.long.map((b, i): DirectorShot => ({
      beatId: b.id,
      purpose: `Purpose number ${i}`,
      truth: i === 2 ? "graphic" : i === 3 ? "archive" : "reconstruction",
      mustShow: ["a specific stranded submarine"],
      mustNotShow: ["a wrong national flag"],
      wantsMotion: i === 1 || i === 2, // beat 2 is a graphic: motion must be forced off
      motion: i === 1 ? "pan-left" : "push",
      prompt: `scene ${i}`,
      archiveQuery: i === 3 ? "specific archive query" : "",
      useMaster: i === 1 || i === 2, // beat 2 is a graphic: master must be forced off
    })),
    short: input.beats.short.map((b): DirectorShot => ({
      beatId: b.id,
      purpose: "Short film purpose",
      truth: "reconstruction",
      mustShow: ["x"],
      mustNotShow: ["y"],
      wantsMotion: false,
      motion: "hold",
      prompt: "short scene",
      archiveQuery: "",
      useMaster: false,
    })),
  });

  test("index and word ranges are assigned locally from the beats", async () => {
    const narr = await narration();
    const beats = buildBeats("long", paulBunyanScripts.long, narr.long);
    const plans = await planVisuals(story, paulBunyanResearch, paulBunyanScripts, narr, fakeDirector);

    expect(plans.long.length).toBe(beats.length);
    plans.long.forEach((s, i) => {
      expect(s.index).toBe(i);
      expect(s.wordStart).toBe(beats[i].wordStart);
      expect(s.wordEnd).toBe(beats[i].wordEnd);
    });
    expect(plans.long[0].wordStart).toBe(0);
  });

  test("director purposes, motion, master and archiveQuery are preserved", async () => {
    const plans = await planVisuals(story, paulBunyanResearch, paulBunyanScripts, await narration(), fakeDirector);

    // Purpose is used verbatim in the shot and the prompt.
    expect(plans.long[5].purpose).toBe("Purpose number 5");
    // A moving reconstruction keeps its motion, master and (no) archive query.
    const s1 = plans.long[1];
    expect(s1.truth).toBe("reconstruction");
    expect(s1.wantsMotion).toBe(true);
    expect(s1.motion).toBe("pan-left");
    expect(s1.useMaster).toBe(true);
    expect(s1.archiveQuery).toBeUndefined();
    expect(s1.prompt).toContain("Purpose number 1");
    expect(s1.prompt).toContain("scene 1");
    expect(s1.prompt).toContain("a specific stranded submarine");
    expect(s1.prompt).toContain("a wrong national flag");
    expect(s1.prompt).toContain("Wide 16:9 composition");
  });

  test("a graphic decision cannot carry motion or the master", async () => {
    const plans = await planVisuals(story, paulBunyanResearch, paulBunyanScripts, await narration(), fakeDirector);
    const g = plans.long[2];
    expect(g.truth).toBe("graphic");
    expect(g.wantsMotion).toBe(false);
    expect(g.useMaster).toBe(false);
    expect(g.motion).toBe("hold");
    expect(g.archiveQuery).toBeUndefined();
    expect(g.prompt).toMatch(/information graphic/i);
  });

  test("an archive decision keeps its specific query; non-archive shots have none", async () => {
    const plans = await planVisuals(story, paulBunyanResearch, paulBunyanScripts, await narration(), fakeDirector);
    const a = plans.long[3];
    expect(a.truth).toBe("archive");
    expect(a.archiveQuery).toBe("specific archive query");
    expect(a.wantsMotion).toBe(false); // archive never animates
    for (const s of plans.long.filter((x) => x.truth !== "archive")) expect(s.archiveQuery).toBeUndefined();
  });

  test("the Short film is planned independently, not cropped from the Long", async () => {
    const plans = await planVisuals(story, paulBunyanResearch, paulBunyanScripts, await narration(), fakeDirector);
    expect(plans.short.length).not.toBe(plans.long.length);
    expect(plans.short[0].purpose).toBe("Short film purpose");
  });
});

describe("the live director makes exactly one structured call with the full context", () => {
  test("openAiVisualDirector calls respondJson once and includes facts, scripts and both beat lists", async () => {
    const narr = await narration();
    const input: DirectorInput = {
      story,
      research: paulBunyanResearch,
      scripts: paulBunyanScripts,
      beats: {
        long: buildBeats("long", paulBunyanScripts.long, narr.long),
        short: buildBeats("short", paulBunyanScripts.short, narr.short),
      },
    };

    let calls = 0;
    let captured: any = null;
    const fakeRespond = (async (opts: any) => {
      calls++;
      captured = opts;
      return { long: [], short: [] };
    }) as any;

    await openAiVisualDirector(input, fakeRespond);

    expect(calls).toBe(1); // ONE call plans both films
    expect(captured.schemaName).toBe("visual_plan");
    // Final verified facts, both scripts and both beat lists are all in the payload.
    expect(captured.input).toContain(paulBunyanResearch.facts[0].fact);
    expect(captured.input).toContain("LONG SCRIPT");
    expect(captured.input).toContain("SHORT SCRIPT");
    expect(captured.input).toContain("LONG BEATS");
    expect(captured.input).toContain("SHORT BEATS");
    expect(captured.input).toContain(paulBunyanResearch.world.visualDirection);
    // No web search - planning uses the provided research, not the internet.
    expect(captured.webSearch).toBeFalsy();
  });
});

// ---------------------------------------------------------------------------
// v1A.3: fact grounding, denser beats, honest prompt assembly, single frames.
// ---------------------------------------------------------------------------
describe("v1A.3 planning fixes", () => {
  test("mock planning still works without a fact sheet", async () => {
    // Mock mode uses the deterministic fallback and must not demand facts.
    const noFacts = { ...paulBunyanResearch, facts: [] };
    const plans = await planVisuals(story, noFacts as any, paulBunyanScripts, await narration());
    expect(plans.long.length).toBeGreaterThan(0);
    expect(plans.short.length).toBeGreaterThan(0);
  });

  test("a long compound sentence is split into several beats, ranges stay contiguous", () => {
    // Sentence grouping alone would keep this as ONE beat; punctuation splitting
    // must turn it into several, without ever dropping or overlapping a word.
    const oneLongSentence =
      "The convoy rolled in at dawn, engineers carried chainsaws to the tree, a security platoon fanned out around them, attack helicopters circled overhead, heavy bombers held far above, and an aircraft carrier waited off the coast.";
    const beats = groupBeats(oneLongSentence, 6);
    expect(beats.length).toBeGreaterThan(3);
    expect(beats[0].wordStart).toBe(0);
    for (let i = 1; i < beats.length; i++) expect(beats[i].wordStart).toBe(beats[i - 1].wordEnd);
    expect(beats.at(-1)!.wordEnd).toBe(wordCount(oneLongSentence));
    for (const b of beats) expect(b.wordEnd - b.wordStart).toBeGreaterThan(1); // no empty/tiny fragments
  });

  test("beat splitting can exceed the sentence count when sentences are long", () => {
    // Three long, comma-rich sentences. The old sentence grouping capped this at 3
    // beats (too static for a script written in long sentences, like the real U137
    // script); punctuation splitting must produce more, with ranges still contiguous.
    const text =
      "The convoy rolled in at dawn, engineers carried chainsaws, and a platoon fanned out. Overhead, helicopters circled, bombers held high, and fighters escorted them. Off the coast, a carrier waited, its task force ready, while the border stood at full alert.";
    const beats = groupBeats(text, 9);
    expect(beats.length).toBeGreaterThan(3); // more beats than the 3 sentences
    expect(beats[0].wordStart).toBe(0);
    for (let i = 1; i < beats.length; i++) expect(beats[i].wordStart).toBe(beats[i - 1].wordEnd);
    expect(beats.at(-1)!.wordEnd).toBe(wordCount(text));
  });

  test("prompts are not prefixed with the blanket story-world visual direction", async () => {
    const { long } = await mockPlan();
    for (const s of long) {
      expect(s.prompt).not.toContain(paulBunyanResearch.world.visualDirection);
    }
  });

  test("the full director scene is used verbatim, never truncated", async () => {
    const longScene =
      "A wide, eye-level reconstruction of the engineers steadying the poplar as the first cut bites, the security platoon ringed behind them in loose cover, the low DMZ buildings and the empty bridge held far back in misted light, every figure in period-correct mid-1970s fatigues, the whole frame quiet and watchful rather than heroic and composed to read clearly at a glance without any caption at all.";
    expect(longScene.length).toBeGreaterThan(200);
    const director = async (input: DirectorInput): Promise<DirectorPlans> => ({
      long: input.beats.long.map((b): DirectorShot => ({
        beatId: b.id, purpose: "Show the engineers taking the first cut.", truth: "reconstruction",
        mustShow: ["engineers with a chainsaw"], mustNotShow: [], wantsMotion: false, motion: "hold",
        prompt: longScene, archiveQuery: "", useMaster: false,
      })),
      short: [],
    });
    const plans = await planVisuals(story, paulBunyanResearch, paulBunyanScripts, await narration(), director);
    expect(plans.long[0].prompt).toContain(longScene); // the whole scene survives, no "..." cut
  });

  test("deterministic guards never contradict a scene-specific mustShow", async () => {
    // A legacy/aftermath beat may legitimately require modern equipment. No blanket
    // "no modern equipment" guard may be injected to fight the director's mustShow.
    const director = async (input: DirectorInput): Promise<DirectorPlans> => ({
      long: input.beats.long.map((b): DirectorShot => ({
        beatId: b.id, purpose: "Show a modern patrol vessel on watch.", truth: "reconstruction",
        mustShow: ["modern Swedish naval vessel"], mustNotShow: ["Soviet insignia"], wantsMotion: false, motion: "hold",
        prompt: "A modern patrol boat holding station in the archipelago.", archiveQuery: "", useMaster: false,
      })),
      short: [],
    });
    const plans = await planVisuals(story, paulBunyanResearch, paulBunyanScripts, await narration(), director);
    const s = plans.long[0];
    expect(s.mustShow).toContain("modern Swedish naval vessel");
    expect(s.mustNotShow).toEqual(["Soviet insignia"]); // exactly the director's list, nothing injected
    expect(s.mustNotShow.join(" ")).not.toMatch(/modern vehicles|anachronistic/i);
    expect(s.prompt).not.toMatch(/Do not show:[^.]*modern vehicles/i);
  });

  test("an archive beat's stored prompt is a clean reconstruction fallback, not fake archival footage", async () => {
    const director = async (input: DirectorInput): Promise<DirectorPlans> => ({
      long: input.beats.long.map((b): DirectorShot => ({
        beatId: b.id, purpose: "Show the felled poplar's stump left standing as a marker.", truth: "archive",
        mustShow: ["the poplar stump"], mustNotShow: [], wantsMotion: false, motion: "hold",
        prompt: "The stump left standing after the tree came down.", archiveQuery: "Operation Paul Bunyan tree 1976", useMaster: false,
      })),
      short: [],
    });
    const plans = await planVisuals(story, paulBunyanResearch, paulBunyanScripts, await narration(), director);
    const a = plans.long[0];
    expect(a.truth).toBe("archive");
    expect(a.archiveQuery).toBe("Operation Paul Bunyan tree 1976"); // acquisition still drives it
    // The stored prompt is a reconstruction fallback (used only if archive is
    // missing): purpose-led, not a graphic, and it never fakes archival material.
    expect(a.prompt).toContain("Purpose:");
    expect(a.prompt).toMatch(/reconstruction/i);
    expect(a.prompt).not.toMatch(/information graphic/i);
    expect(a.prompt).not.toMatch(/archival (footage|photo|photograph)/i);
  });

  test("graphics carry no cinematic/reconstruction tail", async () => {
    const { long } = await mockPlan();
    for (const g of long.filter((s) => s.truth === "graphic")) {
      expect(g.prompt).not.toMatch(/reconstruction/i);
      expect(g.prompt).not.toMatch(/cinematic/i);
    }
  });

  test("the director instructions demand one drawable frame, not a montage", () => {
    expect(DIRECTOR_INSTRUCTIONS).toMatch(/one drawable frame/i);
    expect(DIRECTOR_INSTRUCTIONS).toMatch(/montage/i);
    expect(DIRECTOR_INSTRUCTIONS).toMatch(/split screen/i);
  });
});

// ---------------------------------------------------------------------------
// v1A.4: "no new visual" reuse, plus tightened factual / one-frame / archive
// / repetition instructions. Small, focused - no giant snapshots.
// ---------------------------------------------------------------------------
describe("v1A.4 no-new-visual reuse", () => {
  // A director that asks to reuse the previous visual on beat 0 (must be ignored)
  // and on beat 2 (must fold into beat 1's shot). Every other beat is a fresh
  // reconstruction with a distinct scene so we can prove the visual is preserved.
  const reuseDirector = async (input: DirectorInput): Promise<DirectorPlans> => ({
    long: input.beats.long.map((b, i): DirectorShot => ({
      beatId: b.id,
      purpose: `Purpose ${i}`,
      truth: "reconstruction",
      mustShow: ["a concrete subject"],
      mustNotShow: [],
      wantsMotion: false,
      motion: "hold",
      prompt: `scene ${i}`,
      archiveQuery: "",
      useMaster: false,
      reusePrevious: i === 0 || i === 2, // beat 0 reuse must be ignored; beat 2 folds into beat 1
    })),
    short: [],
  });

  test("reusePrevious is never honoured on beat 0 - it always creates a real visual", async () => {
    const narr = await narration();
    const plans = await planVisuals(story, paulBunyanResearch, paulBunyanScripts, narr, reuseDirector);
    expect(plans.long[0].wordStart).toBe(0);
    expect(plans.long[0].prompt).toContain("scene 0"); // beat 0 produced its own visual
  });

  test("a reused later beat creates no new shot and extends the previous shot's wordEnd", async () => {
    const narr = await narration();
    const beats = buildBeats("long", paulBunyanScripts.long, narr.long);
    const plans = await planVisuals(story, paulBunyanResearch, paulBunyanScripts, narr, reuseDirector);

    // Only beat 2 is reused (beat-0 reuse is ignored), so exactly one shot is saved.
    expect(plans.long.length).toBe(beats.length - 1);
    // Beat 1's shot now spans beat 2 as well, and the previous visual is preserved.
    expect(plans.long[1].prompt).toContain("scene 1");
    expect(plans.long[1].wordEnd).toBe(beats[2].wordEnd);
    // Word coverage stays contiguous across the fold (next shot is beat 3).
    expect(plans.long[2].wordStart).toBe(beats[3].wordStart);
    expect(plans.long[2].wordStart).toBe(plans.long[1].wordEnd);
  });

  test("an unsupported beat is represented by reuse instead of an invented filler shot", async () => {
    // The reused beat (2) must not appear as its own "scene 2" filler visual anywhere.
    // Match the exact assembled scene ("Scene: scene 2.") so it can't collide with
    // "scene 20", "scene 21", etc. from later beats.
    const narr = await narration();
    const plans = await planVisuals(story, paulBunyanResearch, paulBunyanScripts, narr, reuseDirector);
    expect(plans.long.some((s) => s.prompt.includes("Scene: scene 2."))).toBe(false);
  });

  test("indexes stay sequential and contiguous after a reuse fold", async () => {
    const narr = await narration();
    const plans = await planVisuals(story, paulBunyanResearch, paulBunyanScripts, narr, reuseDirector);
    plans.long.forEach((s, i) => expect(s.index).toBe(i));
    for (let i = 1; i < plans.long.length; i++) expect(plans.long[i].wordStart).toBe(plans.long[i - 1].wordEnd);
  });
});

describe("v1A.4 tightened director instructions", () => {
  test("forbid inventing event-specific visual facts just to make an image", () => {
    expect(DIRECTOR_INSTRUCTIONS).toMatch(/do not invent/i);
    expect(DIRECTOR_INSTRUCTIONS).toMatch(/press conferences/i);
    expect(DIRECTOR_INSTRUCTIONS).toMatch(/equipment upgrades/i);
    expect(DIRECTOR_INSTRUCTIONS).toMatch(/crowds/i);
  });

  test("one-frame rule explicitly forbids collage, split-focus and dual action", () => {
    expect(DIRECTOR_INSTRUCTIONS).toMatch(/collage/i);
    expect(DIRECTOR_INSTRUCTIONS).toMatch(/split-focus/i);
    expect(DIRECTOR_INSTRUCTIONS).toMatch(/two different actions/i);
    expect(DIRECTOR_INSTRUCTIONS).toMatch(/hatch/i);
    expect(DIRECTOR_INSTRUCTIONS).toMatch(/one location, one moment, one primary action/i);
  });

  test("archive fallback instruction forbids faking readable historical documents", () => {
    expect(DIRECTOR_INSTRUCTIONS).toMatch(/reconstruction fallback/i);
    expect(DIRECTOR_INSTRUCTIONS).toMatch(/never fabricate/i);
    expect(DIRECTOR_INSTRUCTIONS).toMatch(/newspaper headline/i);
    expect(DIRECTOR_INSTRUCTIONS).toMatch(/communiqué/i);
    expect(DIRECTOR_INSTRUCTIONS).toMatch(/no readable text/i);
  });

  test("repetition rule prefers reuse or a supported detail over another arbitrary angle", () => {
    expect(DIRECTOR_INSTRUCTIONS).toMatch(/reusePrevious/);
    expect(DIRECTOR_INSTRUCTIONS).toMatch(/new camera angle merely/i);
  });

  test("beat targets are described as guidance, not a quota", () => {
    expect(DIRECTOR_INSTRUCTIONS).toMatch(/not a quota/i);
  });
});

// ---------------------------------------------------------------------------
// v1A.5: reuse discipline. Instructions-only tightening (no new fields, no AI
// calls, no schema change): abstract/unsupported beats must prefer reusePrevious,
// plausible-but-unsupported scenes are forbidden, negations/limitations must not
// be dramatized, archive requires a plausible real asset, and repeated geography
// prefers reuse over another map.
// ---------------------------------------------------------------------------
describe("v1A.5 reuse discipline instructions", () => {
  test("abstract, unsupported beats must prefer reusePrevious as the default", () => {
    // The abstract categories are named and tied to a mandatory reuse.
    expect(DIRECTOR_INSTRUCTIONS).toMatch(/reusePrevious IS THE DEFAULT/i);
    expect(DIRECTOR_INSTRUCTIONS).toMatch(/interpretation, suspicion, uncertainty/i);
    expect(DIRECTOR_INSTRUCTIONS).toMatch(/policy significance/i);
    expect(DIRECTOR_INSTRUCTIONS).toMatch(/reusePrevious MUST be true/);
  });

  test("plausible is not supported: likely-looking scenes may not be invented", () => {
    expect(DIRECTOR_INSTRUCTIONS).toMatch(/historically plausible is not enough/i);
    expect(DIRECTOR_INSTRUCTIONS).toMatch(/PLAUSIBLE IS NOT SUPPORTED/);
    // The forbidden invention list is explicit.
    expect(DIRECTOR_INSTRUCTIONS).toMatch(/may NOT invent meetings, rooms, confrontations/i);
    expect(DIRECTOR_INSTRUCTIONS).toMatch(/merely because they sound likely/i);
  });

  test("negations and limitations must not be dramatized into a confrontation", () => {
    expect(DIRECTOR_INSTRUCTIONS).toMatch(/DO NOT DRAMATIZE NEGATIONS OR LIMITATIONS/);
    expect(DIRECTOR_INSTRUCTIONS).toMatch(/did not happen, was prevented, was limited/i);
    expect(DIRECTOR_INSTRUCTIONS).toMatch(/access was limited/i);
    expect(DIRECTOR_INSTRUCTIONS).toMatch(/blocking another person at a hatch/i);
  });

  test("archive requires a plausible real historical asset, not an abstract outcome", () => {
    expect(DIRECTOR_INSTRUCTIONS).toMatch(/specific real historical asset[^.]*plausibly exists/i);
    // The abstract outcomes that must NOT trigger an archive choice are named.
    expect(DIRECTOR_INSTRUCTIONS).toMatch(/Do NOT choose archive for an abstract outcome/i);
    expect(DIRECTOR_INSTRUCTIONS).toMatch(/an apology, a reimbursement, a policy change or public concern/i);
  });

  test("repeated geography prefers reuse over another map, and a shot must add information", () => {
    expect(DIRECTOR_INSTRUCTIONS).toMatch(/already communicated the same geography or spatial relationship/i);
    expect(DIRECTOR_INSTRUCTIONS).toMatch(/rather than generating another similar map/i);
    expect(DIRECTOR_INSTRUCTIONS).toMatch(/A new shot must add new information\./);
  });
});
