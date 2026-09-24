import { describe, test, expect } from "vitest";
import { mkdtempSync, writeFileSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

// Visual planning: timing (narration beats -> fixed edit slots) is built and
// mapped locally, never by a model. Since Film Grammar v2E two structured calls
// plan both films: the Coverage Director proposes each film's media library and
// the Editor assigns one legal presentation of it to every fixed slot. Mock mode
// never touches a provider - it uses tiny deterministic fallback planners.
const tmp = mkdtempSync(path.join(os.tmpdir(), "pb4-visual-director-"));
process.env.PROVIDER_MODE = "mock";
process.env.PB4_DATA_DIR = path.join(tmp, "data");
process.env.PB4_MEDIA_DIR = path.join(tmp, "media");

const {
  planVisuals, buildBeats, planSlots, openAiCoverageDirector, openAiEditor, validateCoverage, buildPresentations, masterPrompt, COVERAGE_INSTRUCTIONS, EDITOR_INSTRUCTIONS,
  stillReferencePaths, masterReferencePaths, PB1_STYLE_REFERENCE,
} = await import("../src/production/visuals.ts");
import type { CoverageAsset, CoverageInput, EditorInput, EditorPlans, PlannedShot, VisualDirectors } from "../src/production/visuals.ts";
const { minimalAsset, fillEdit } = await import("./slotPlan.ts");
const { paulBunyanStory, paulBunyanResearch, paulBunyanScripts } = await import("../src/production/fixtures/paulBunyan.ts");
const { recordNarration } = await import("../src/production/narration.ts");
const { ensureStoryDirs, inStory } = await import("../src/production/paths.ts");
const { wordCount } = await import("../src/production/text.ts");

const story = { ...paulBunyanStory, createdAt: new Date().toISOString() };

async function narration() {
  ensureStoryDirs(story.slug);
  const long = await recordNarration(story.slug, "long", paulBunyanScripts.long);
  const short = await recordNarration(story.slug, "short", paulBunyanScripts.short);
  return { long, short };
}

// The mock (offline) plan, produced by the fallback planners - no provider.
async function mockPlan() {
  return planVisuals(story, paulBunyanResearch, paulBunyanScripts, await narration());
}

// Test planners: the Coverage Director returns the given Long assets (and the Short
// ones); the Editor fills every slot `pick` leaves open with "L00:base" / "S00:base",
// or the next legal presentation where that would repeat an adjacent slot.
function planners(long: Partial<CoverageAsset>[], pick: (slotId: number) => [string, number] | undefined = () => undefined, short: Partial<CoverageAsset>[] = [{}]): VisualDirectors {
  return {
    coverage: async (_i: CoverageInput) => ({ longAssets: long.map((a) => minimalAsset(a)), shortAssets: short.map((a) => minimalAsset(a)) }) as never,
    editor: async (input: EditorInput): Promise<EditorPlans> => {
      const ids = (kind: "long" | "short", p: (id: number) => string | undefined) =>
        fillEdit(input.slots[kind].map((s) => s.id), input.presentations[kind].map((x) => x.id), p);
      const long = ids("long", (id) => pick(id)?.[0]);
      const short = ids("short", () => undefined);
      return {
        long: input.slots.long.map((s, i) => ({ slotId: s.id, presentationId: long[i], motionPriority: pick(s.id)?.[1] ?? 0 })),
        short: input.slots.short.map((s, i) => ({ slotId: s.id, presentationId: short[i], motionPriority: 0 })),
      };
    },
  };
}

describe("mock mode plans offline, with no provider", () => {
  test("planVisuals uses the deterministic fallback planners, not the model", async () => {
    // In mock mode planVisuals routes to the offline fallback planners. Their output
    // is fully deterministic, so matching its exact signature proves no model call
    // happened: reconstruction purposes are the fixed fallback string, and every
    // fourth asset (L03) is a graphic.
    const plans = await mockPlan();
    expect(plans.long.length).toBeGreaterThan(0);
    expect(plans.short.length).toBeGreaterThan(0);
    expect(plans.long[1].purpose).toMatch(/^Show the key action of this moment at/);
    expect(plans.long.find((s) => s.assetId === "L03")?.truth).toBe("graphic");
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
    // A reframe reuses its source asset (and its prompt) with its own purpose.
    const recon = long.filter((s) => s.edit === "new" && s.truth === "reconstruction");
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

describe("planVisuals maps the library and the edit with local timing and index", () => {
  // Deterministic test planners, so we prove the mapping, not the model. Timing
  // and index must come from the slots. L00 is a moving, master-borrowing
  // reconstruction; L01 is a graphic that asks for motion and the master (both
  // must be forced off); L02 is archive with a specific query. The Editor gives
  // the graphic and archive priority 0: a priority there is rejected outright.
  const lib: Partial<CoverageAsset>[] = [
    { purpose: "Purpose of the reconstruction", mustShow: [{ description: "a specific stranded submarine", region: "center" }], mustNotShow: ["a wrong national flag"], prompt: "scene one", useMaster: true, motionCapable: true },
    { truth: "graphic", purpose: "Show where the tree stood.", useMaster: true, motionCapable: true },
    { truth: "archive", purpose: "Show the real site.", archiveQuery: "specific archive query" },
  ];
  const pick = (i: number): [string, number] | undefined => (i === 1 ? ["L00:base", 2] : i === 2 ? ["L01:base", 0] : i === 3 ? ["L02:base", 0] : undefined);
  const fake = () => planners(lib, pick, [{ purpose: "Short film purpose" }]);

  test("index and word ranges are assigned locally from the slots", async () => {
    const narr = await narration();
    const slots = planSlots("long", paulBunyanScripts.long, narr.long);
    const plans = await planVisuals(story, paulBunyanResearch, paulBunyanScripts, narr, fake());

    expect(plans.long.length).toBe(slots.length);
    plans.long.forEach((s, i) => {
      expect(s.index).toBe(i);
      expect(s.wordStart).toBe(slots[i].wordStart);
      expect(s.wordEnd).toBe(slots[i].wordEnd);
    });
    expect(plans.long[0].wordStart).toBe(0);
  });

  test("asset purposes, motion, master and archiveQuery are preserved", async () => {
    const plans = await planVisuals(story, paulBunyanResearch, paulBunyanScripts, await narration(), fake());

    // The asset's purpose is used verbatim on every slot that shows it.
    expect(plans.long[5].purpose).toBe("Purpose of the reconstruction");
    // The selected motion slot keeps its motion, master and (no) archive query.
    const s1 = plans.long[1];
    expect(s1.truth).toBe("reconstruction");
    expect(s1.wantsMotion).toBe(true);
    expect(s1.motion).toBe("push");
    expect(s1.useMaster).toBe(true);
    expect(s1.archiveQuery).toBeUndefined();
    expect(s1.prompt).toContain("Purpose of the reconstruction");
    expect(s1.prompt).toContain("scene one");
    expect(s1.prompt).toContain("a specific stranded submarine");
    expect(s1.prompt).toContain("a wrong national flag");
    expect(s1.prompt).toContain("Wide 16:9 composition");
  });

  test("a graphic asset cannot carry motion or the master", async () => {
    const plans = await planVisuals(story, paulBunyanResearch, paulBunyanScripts, await narration(), fake());
    const g = plans.long[2];
    expect(g.truth).toBe("graphic");
    expect(g.wantsMotion).toBe(false);
    expect(g.useMaster).toBe(false);
    expect(g.motion).toBe("hold");
    expect(g.archiveQuery).toBeUndefined();
    expect(g.prompt).toMatch(/information graphic/i);
  });

  test("an archive asset keeps its specific query; non-archive shots have none", async () => {
    const plans = await planVisuals(story, paulBunyanResearch, paulBunyanScripts, await narration(), fake());
    const a = plans.long[3];
    expect(a.truth).toBe("archive");
    expect(a.archiveQuery).toBe("specific archive query");
    expect(a.wantsMotion).toBe(false); // archive never animates
    for (const s of plans.long.filter((x) => x.truth !== "archive")) expect(s.archiveQuery).toBeUndefined();
  });

  test("the Short film is planned independently, not cropped from the Long", async () => {
    const plans = await planVisuals(story, paulBunyanResearch, paulBunyanScripts, await narration(), fake());
    expect(plans.short.length).not.toBe(plans.long.length);
    expect(plans.short[0].purpose).toBe("Short film purpose");
    expect(plans.short.every((s) => s.assetId.startsWith("S"))).toBe(true);
  });
});

describe("the live planners each make exactly one structured call with the full context", () => {
  async function inputs() {
    const narr = await narration();
    const slots = { long: planSlots("long", paulBunyanScripts.long, narr.long), short: planSlots("short", paulBunyanScripts.short, narr.short) };
    const library = { long: validateCoverage("long", [minimalAsset()]), short: validateCoverage("short", [minimalAsset({ truth: "graphic" })]) };
    const presentations = { long: buildPresentations(library.long), short: buildPresentations(library.short) };
    const base = { story, research: paulBunyanResearch, scripts: paulBunyanScripts, slots };
    return { coverage: base, editor: { ...base, library, presentations } };
  }
  const capture = () => {
    const seen: any[] = [];
    const respond = (async (opts: any) => {
      seen.push(opts);
      return {};
    }) as any;
    return { seen, respond };
  };

  test("the Coverage Director calls respondJson once with facts, scripts and both slot grids", async () => {
    const { coverage } = await inputs();
    const { seen, respond } = capture();
    await openAiCoverageDirector(coverage, respond);
    expect(seen).toHaveLength(1); // ONE call proposes both libraries
    expect(seen[0].schemaName).toBe("coverage_plan");
    expect(seen[0].instructions).toBe(COVERAGE_INSTRUCTIONS);
    // Final verified facts, both scripts and both slot grids are all in the payload.
    expect(seen[0].input).toContain(paulBunyanResearch.facts[0].fact);
    expect(seen[0].input).toContain("LONG SCRIPT");
    expect(seen[0].input).toContain("SHORT SCRIPT");
    expect(seen[0].input).toContain("LONG SLOTS");
    expect(seen[0].input).toContain("SHORT SLOTS");
    expect(seen[0].input).toContain(paulBunyanResearch.world.visualDirection);
    // No web search - planning uses the provided research, not the internet.
    expect(seen[0].webSearch).toBeFalsy();
  });

  test("the Editor calls respondJson once with the slots, the library and a schema of legal presentation ids", async () => {
    const { editor } = await inputs();
    const { seen, respond } = capture();
    await openAiEditor(editor, respond);
    expect(seen).toHaveLength(1);
    expect(seen[0].schemaName).toBe("edit_plan");
    expect(seen[0].instructions).toBe(EDITOR_INSTRUCTIONS);
    expect(seen[0].input).toContain(paulBunyanResearch.facts[0].fact);
    expect(seen[0].input).toContain("LONG MEDIA LIBRARY");
    expect(seen[0].input).toContain("SHORT MEDIA LIBRARY");
    expect(seen[0].input).toContain("LONG SLOTS");
    expect(seen[0].schema.properties.long.items.properties.presentationId.enum).toEqual(["L00:base", "L00:detail-center"]);
    expect(seen[0].schema.properties.short.items.properties.presentationId.enum).toEqual(["S00:base"]);
    expect(seen[0].webSearch).toBeFalsy();
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

  test("prompts are not prefixed with the blanket story-world visual direction", async () => {
    const { long } = await mockPlan();
    for (const s of long) {
      expect(s.prompt).not.toContain(paulBunyanResearch.world.visualDirection);
    }
  });

  test("the full Coverage scene is used verbatim, never truncated", async () => {
    const longScene =
      "A wide, eye-level reconstruction of the engineers steadying the poplar as the first cut bites, the security platoon ringed behind them in loose cover, the low DMZ buildings and the empty bridge held far back in misted light, every figure in period-correct mid-1970s fatigues, the whole frame quiet and watchful rather than heroic and composed to read clearly at a glance without any caption at all.";
    expect(longScene.length).toBeGreaterThan(200);
    const plans = await planVisuals(
      story, paulBunyanResearch, paulBunyanScripts, await narration(),
      planners([{ purpose: "Show the engineers taking the first cut.", mustShow: [{ description: "engineers with a chainsaw", region: "center" }], prompt: longScene }]),
    );
    expect(plans.long[0].prompt).toContain(longScene); // the whole scene survives, no "..." cut
  });

  test("deterministic guards never contradict a scene-specific mustShow", async () => {
    // A legacy/aftermath asset may legitimately require modern equipment. No blanket
    // "no modern equipment" guard may be injected to fight the asset's mustShow.
    const plans = await planVisuals(
      story, paulBunyanResearch, paulBunyanScripts, await narration(),
      planners([{ purpose: "Show a modern patrol vessel on watch.", mustShow: [{ description: "modern Swedish naval vessel", region: "center" }], mustNotShow: ["Soviet insignia"], prompt: "A modern patrol boat holding station in the archipelago." }]),
    );
    const s = plans.long[0];
    expect(s.mustShow).toContain("modern Swedish naval vessel");
    expect(s.mustNotShow).toEqual(["Soviet insignia"]); // exactly the asset's list, nothing injected
    expect(s.mustNotShow.join(" ")).not.toMatch(/modern vehicles|anachronistic/i);
    expect(s.prompt).not.toMatch(/Do not show:[^.]*modern vehicles/i);
  });

  test("an archive asset's stored prompt is a clean reconstruction fallback, not fake archival footage", async () => {
    const plans = await planVisuals(
      story, paulBunyanResearch, paulBunyanScripts, await narration(),
      planners([{ truth: "archive", purpose: "Show the felled poplar's stump left standing as a marker.", mustShow: [{ description: "the poplar stump", region: "center" }], prompt: "The stump left standing after the tree came down.", archiveQuery: "Operation Paul Bunyan tree 1976" }, {}]),
    );
    const a = plans.long[0];
    expect(a.truth).toBe("archive");
    expect(a.archiveQuery).toBe("Operation Paul Bunyan tree 1976"); // acquisition still drives it
    // The stored prompt is a reconstruction fallback (used only if archive is
    // missing): purpose-led, not a graphic, and it never fakes archival material.
    expect(a.prompt).toContain("Purpose:");
    expect(a.prompt).toMatch(/reconstruction/i);
    expect(a.prompt).not.toMatch(/information graphic/i);
    // The PB1 direction explicitly disclaims fake archival imagery rather than asking
    // for it, so the fallback never requests archival footage/photography.
    expect(a.prompt).toMatch(/not a fake archival photograph/i);
  });

  test("graphics carry no cinematic/reconstruction tail", async () => {
    const { long } = await mockPlan();
    for (const g of long.filter((s) => s.truth === "graphic")) {
      expect(g.prompt).not.toMatch(/reconstruction/i);
      expect(g.prompt).not.toMatch(/cinematic/i);
    }
  });

  test("the Coverage instructions demand one frame per asset, not a montage", () => {
    expect(COVERAGE_INSTRUCTIONS).toMatch(/ONE ASSET = ONE FRAME/);
    expect(COVERAGE_INSTRUCTIONS).toMatch(/montage/i);
    expect(COVERAGE_INSTRUCTIONS).toMatch(/split screen/i);
  });
});

// ---------------------------------------------------------------------------
// v1A.4 "no new visual" reuse. Since Film Grammar v2D a visual that serves several
// phrases is one fixed edit slot that PB4 built over several beats; no planner can
// group or extend anything.
// ---------------------------------------------------------------------------
describe("no new visual: one slot covers several phrase beats", () => {
  // In the mock grid, Long slot 0 covers beats 0-1 and slot 5 covers beats 6-7.
  const oneAsset = () => planners([{ prompt: "the one scene" }]);

  test("the first slot always starts at beat 0 with a real visual", async () => {
    const narr = await narration();
    const plans = await planVisuals(story, paulBunyanResearch, paulBunyanScripts, narr, oneAsset());
    expect(plans.long[0].wordStart).toBe(0);
    expect(plans.long[0].prompt).toContain("the one scene");
  });

  test("a slot over several beats is one shot covering all their words and screen time", async () => {
    const narr = await narration();
    const beats = buildBeats("long", paulBunyanScripts.long, narr.long);
    const plans = await planVisuals(story, paulBunyanResearch, paulBunyanScripts, narr, oneAsset());
    expect(plans.long.length).toBeLessThan(beats.length);
    expect(plans.long[5]).toMatchObject({ startBeat: 6, endBeat: 7, wordStart: beats[6].wordStart, wordEnd: beats[7].wordEnd, startSec: beats[6].startSec, endSec: beats[7].endSec });
    expect(plans.long[6].wordStart).toBe(beats[8].wordStart);
    expect(plans.long[6].wordStart).toBe(plans.long[5].wordEnd);
  });

  test("a covered phrase gets no invented filler shot of its own", async () => {
    const narr = await narration();
    const beats = buildBeats("long", paulBunyanScripts.long, narr.long);
    const plans = await planVisuals(story, paulBunyanResearch, paulBunyanScripts, narr, oneAsset());
    expect(plans.long.some((s) => s.wordStart === beats[7].wordStart)).toBe(false);
  });

  test("indexes stay sequential and word coverage contiguous", async () => {
    const narr = await narration();
    const plans = await planVisuals(story, paulBunyanResearch, paulBunyanScripts, narr, oneAsset());
    plans.long.forEach((s, i) => expect(s.index).toBe(i));
    for (let i = 1; i < plans.long.length; i++) expect(plans.long[i].wordStart).toBe(plans.long[i - 1].wordEnd);
  });
});

describe("v1A.4 tightened instructions, carried into the Coverage Director", () => {
  test("forbid inventing event-specific visual facts just to make an image", () => {
    expect(COVERAGE_INSTRUCTIONS).toMatch(/do NOT invent/);
    expect(COVERAGE_INSTRUCTIONS).toMatch(/press conferences/i);
    expect(COVERAGE_INSTRUCTIONS).toMatch(/sonar equipment/i);
    expect(COVERAGE_INSTRUCTIONS).toMatch(/crowds/i);
  });

  test("one-frame rule explicitly forbids collage, split-focus and dual action", () => {
    expect(COVERAGE_INSTRUCTIONS).toMatch(/collage/i);
    expect(COVERAGE_INSTRUCTIONS).toMatch(/split-focus/i);
    expect(COVERAGE_INSTRUCTIONS).toMatch(/two different actions/i);
    expect(COVERAGE_INSTRUCTIONS).toMatch(/hatch/i);
    expect(COVERAGE_INSTRUCTIONS).toMatch(/one location, one moment, one primary action/i);
  });

  test("archive fallback instruction forbids faking readable historical documents", () => {
    expect(COVERAGE_INSTRUCTIONS).toMatch(/reconstruction fallback/i);
    expect(COVERAGE_INSTRUCTIONS).toMatch(/never fabricate/i);
    expect(COVERAGE_INSTRUCTIONS).toMatch(/newspaper headline/i);
    expect(COVERAGE_INSTRUCTIONS).toMatch(/communiqué/i);
    expect(COVERAGE_INSTRUCTIONS).toMatch(/no readable text/i);
  });

  test("repetition prefers reuse and real details over near-duplicate assets", () => {
    expect(COVERAGE_INSTRUCTIONS).toMatch(/do not manufacture near-duplicates: the Editor reuses assets and cuts to their details/);
    expect(EDITOR_INSTRUCTIONS).toMatch(/REPETITION AND OVERUSE/);
    expect(EDITOR_INSTRUCTIONS).toMatch(/A base followed by one of its details is a natural documentary cut/);
  });

  test("the library is not a quota of new images", () => {
    expect(COVERAGE_INSTRUCTIONS).toMatch(/A LIBRARY, NOT A QUOTA/);
    expect(COVERAGE_INSTRUCTIONS).toMatch(/Do not create one asset per slot/);
    expect(COVERAGE_INSTRUCTIONS).not.toMatch(/30-40 beats/);
  });
});

// ---------------------------------------------------------------------------
// v1A.5: reuse discipline. Instructions-only (no AI calls): abstract/unsupported
// phrases never get an invented scene, plausible-but-unsupported scenes are
// forbidden, negations/limitations must not be dramatized, archive requires a
// plausible real asset, and repeated geography prefers reuse over another map.
// ---------------------------------------------------------------------------
describe("v1A.5 reuse discipline instructions", () => {
  test("abstract, unsupported phrases are never illustrated with an invented scene", () => {
    expect(COVERAGE_INSTRUCTIONS).toMatch(/When narration is abstract \(interpretation, suspicion, consequence, policy, reflection\), do not invent a physical scene for it/);
    expect(EDITOR_INSTRUCTIONS).toMatch(/ABSTRACT NARRATION - when a slot mainly carries interpretation, suspicion, consequence, policy, transition or reflection/);
    expect(EDITOR_INSTRUCTIONS).toMatch(/Do not pick an unrelated scene just because it is new/);
    for (const t of [COVERAGE_INSTRUCTIONS, EDITOR_INSTRUCTIONS]) expect(t).not.toMatch(/hold IS THE DEFAULT|reusePrevious/i);
  });

  test("plausible is not supported: likely-looking scenes may not be invented", () => {
    expect(COVERAGE_INSTRUCTIONS).toMatch(/PLAUSIBLE IS NOT SUPPORTED: historically likely is not enough/);
    expect(COVERAGE_INSTRUCTIONS).toMatch(/do NOT invent event-specific meetings, rooms or interiors/);
  });

  test("negations and limitations must not be dramatized into a confrontation", () => {
    expect(COVERAGE_INSTRUCTIONS).toMatch(/Do not dramatize negations or limitations/);
    expect(COVERAGE_INSTRUCTIONS).toMatch(/did not happen, was prevented, limited/i);
    expect(COVERAGE_INSTRUCTIONS).toMatch(/access was limited/i);
    expect(COVERAGE_INSTRUCTIONS).toMatch(/blocking another person at a hatch/i);
  });

  test("archive requires a plausible real historical subject, not an abstract outcome", () => {
    expect(COVERAGE_INSTRUCTIONS).toMatch(/specific real historical person, vessel, event, photograph, document, newspaper or film plausibly exists/);
    expect(COVERAGE_INSTRUCTIONS).toMatch(/Do NOT choose archive for an abstract outcome/);
    expect(COVERAGE_INSTRUCTIONS).toMatch(/an apology, a reimbursement, a policy change or public concern/);
  });

  test("repeated geography prefers reuse over another map, and an asset must add information", () => {
    expect(COVERAGE_INSTRUCTIONS).toMatch(/do not propose another similar map from a slightly different angle: the Editor reuses it/);
    expect(COVERAGE_INSTRUCTIONS).toMatch(/A new asset must add new information\./);
  });
});

// ---------------------------------------------------------------------------
// PB1 Reconstruction Style v1: the successful PB1 historical editorial illustration
// language is now the DEFAULT for every generated reconstruction (per-shot stills,
// the archive reconstruction fallback and the master), while all Still Generation v1
// factual / anti-slop safeguards are preserved. One canonical PB1 style reference is
// wired in for reconstructions and the master; graphics and real archive keep no PB1
// reference. Prompt-envelope + reference-wiring only, no AI calls here.
// ---------------------------------------------------------------------------
describe("PB1 reconstruction style prompts", () => {
  test("reconstruction stills ask for PB1 historical editorial illustration, not fake-archive photography", async () => {
    const { long } = await mockPlan();
    const recon = long.filter((s) => s.truth === "reconstruction");
    expect(recon.length).toBeGreaterThan(0);
    for (const s of recon) {
      expect(s.prompt).toMatch(/historical editorial illustration in the PastBriefly reconstruction style/i);
      expect(s.prompt).toMatch(/painterly but detailed/i);
      expect(s.prompt).toMatch(/not a fake archival photograph/i);
      // No longer asks for observational / photojournalistic fake-archive photography.
      expect(s.prompt).not.toMatch(/observational photograph/i);
      expect(s.prompt).not.toMatch(/photojournalistic/i);
      expect(s.prompt).not.toMatch(/35mm/i);
    }
  });

  test("reconstruction stills forbid decorative flags/emblems and invented insignia unless Must show requires them", async () => {
    const { long } = await mockPlan();
    for (const s of long.filter((x) => x.truth === "reconstruction")) {
      expect(s.prompt).toMatch(/do not add flags, banners, emblems, insignia/i);
      expect(s.prompt).toMatch(/uniform patches/i);
      expect(s.prompt).toMatch(/unless such an item is explicitly named in Must show/i);
    }
  });

  test("reconstruction stills forbid staged line-ups / symmetrical posing and use minimum people", async () => {
    const { long } = await mockPlan();
    for (const s of long.filter((x) => x.truth === "reconstruction")) {
      expect(s.prompt).toMatch(/no line-ups/i);
      expect(s.prompt).toMatch(/symmetrical or ceremonial/i);
      expect(s.prompt).toMatch(/minimum number of people/i);
      expect(s.prompt).toMatch(/candid/i); // candid / natural asymmetry safeguard kept
    }
  });

  test("reconstruction stills demand period clothing and forbid modern PPE/electronics unless supported", async () => {
    const { long } = await mockPlan();
    for (const s of long.filter((x) => x.truth === "reconstruction")) {
      expect(s.prompt).toMatch(/period-appropriate/i);
      expect(s.prompt).toMatch(/modern PPE/i);
      expect(s.prompt).toMatch(/modern electronics/i);
    }
  });

  test("reconstruction stills drop the old photographic and glossy hero-poster tails", async () => {
    const { long } = await mockPlan();
    for (const s of long.filter((x) => x.truth === "reconstruction")) {
      expect(s.prompt).not.toContain("premium material rendering");
      expect(s.prompt).not.toContain("Grounded historical-editorial reconstruction in the consistent PastBriefly style");
      expect(s.prompt).not.toMatch(/rendered as an observational photograph/i);
    }
  });

  test("reconstruction prompts explain the PB1 reference is style only, never content to copy", async () => {
    const { long } = await mockPlan();
    for (const s of long.filter((x) => x.truth === "reconstruction")) {
      expect(s.prompt).toMatch(/style reference image only for its illustration treatment/i);
      expect(s.prompt).toMatch(/do not copy its people, landscape, objects, composition or historical content/i);
      expect(s.prompt).toMatch(/factual scene is defined only by this prompt's Purpose, Scene, Must show and Do not show/i);
    }
  });

  test("a useMaster reconstruction marks the second reference as continuity only; a normal one does not", async () => {
    const { long } = await mockPlan();
    const withMaster = long.filter((s) => s.edit === "new" && s.truth === "reconstruction" && s.useMaster);
    const withoutMaster = long.filter((s) => s.edit === "new" && s.truth === "reconstruction" && !s.useMaster);
    expect(withMaster.length).toBeGreaterThan(0);
    expect(withoutMaster.length).toBeGreaterThan(0);
    for (const s of withMaster) expect(s.prompt).toMatch(/second reference image, when present, is a subject and world continuity reference only/i);
    for (const s of withoutMaster) expect(s.prompt).not.toMatch(/second reference/i);
  });

  test("the master prompt uses the PB1 direction and the style-only reference note", () => {
    const p = masterPrompt(story, paulBunyanResearch.world);
    expect(p).toMatch(/historical editorial illustration in the PastBriefly reconstruction style/i);
    expect(p).toMatch(/no propaganda-poster styling/i);
    expect(p).toMatch(/style reference image only for its illustration treatment/i);
    expect(p).not.toMatch(/observational photograph/i);
    expect(p).toContain(paulBunyanResearch.world.palette); // palette preserved
    expect(p).toMatch(/Wide 16:9/); // aspect-ratio handling preserved
    expect(p).not.toContain("Cinematic editorial, premium"); // old glossy hero wording removed
  });

  test("the master prompt is a neutral continuity reference plate of the recurring subject, not a story scene", () => {
    const p = masterPrompt(story, paulBunyanResearch.world);
    // Neutral continuity/reference view of the defining subject, clearly visible.
    expect(p).toMatch(/neutral continuity reference plate/i);
    expect(p).toMatch(/recurring subject/i);
    expect(p).toMatch(/neutral three-quarter or broad side angle/i);
    expect(p).toMatch(/read its overall form/i);
    expect(p).toMatch(/not a scene or moment from the story/i);
    // Explicitly a reference plate, not a defining ESTABLISHING scene of the story.
    expect(p).not.toMatch(/defining establishing reconstruction of/i);
  });

  test("the master prompt forbids people, vehicles/equipment, buildings/staged activity, symbols and action", () => {
    const p = masterPrompt(story, paulBunyanResearch.world);
    expect(p).toMatch(/do not show:[^]*people/i); // no people
    expect(p).toMatch(/vehicles, equipment or props other than the subject itself/i); // no extra vehicles/equipment
    expect(p).toMatch(/buildings or built structures/i); // no buildings
    expect(p).toMatch(/staged or narrative activity/i); // no staged activity
    expect(p).toMatch(/dramatic action/i); // no dramatic action
    expect(p).toMatch(/flags, banners, emblems, insignia/i); // no flags/emblems/insignia
    expect(p).toMatch(/no readable markings, text, numbers or signage/i); // no readable markings
    expect(p).toMatch(/no invented supporting scene/i); // no invented scene
  });

  test("the master prompt keeps PB1 reconstruction language and the style-only reference, without photographic wording", () => {
    const p = masterPrompt(story, paulBunyanResearch.world);
    // Retains PB1 reconstruction language and the PB1 style-only reference instruction.
    expect(p).toMatch(/PastBriefly reconstruction style/i);
    expect(p).toMatch(/do not copy its people, landscape, objects, composition or historical content/i);
    // Keeps the anti-photographic safeguards rather than reverting to photo language.
    expect(p).toMatch(/not a fake archival photograph/i);
    expect(p).toMatch(/no hyper-real AI photography/i);
    // Does NOT reintroduce standalone photographic / photojournalistic direction.
    expect(p).not.toMatch(/observational photograph/i);
    expect(p).not.toMatch(/photojournalistic/i);
    expect(p).not.toMatch(/premium material rendering/i);
    expect(p).not.toMatch(/DSLR|35mm lens|shot on/i);
  });

  test("the archive reconstruction fallback receives the same PB1 style rules", async () => {
    const plans = await planVisuals(
      story, paulBunyanResearch, paulBunyanScripts, await narration(),
      planners([{ truth: "archive", purpose: "Show the felled poplar's stump left standing.", mustShow: [{ description: "the poplar stump", region: "center" }], prompt: "The stump left standing after the tree came down.", archiveQuery: "Operation Paul Bunyan tree 1976" }, {}]),
    );
    expect(plans.long[0].truth).toBe("archive");
    expect(plans.long[0].prompt).toMatch(/historical editorial illustration in the PastBriefly reconstruction style/i);
    expect(plans.long[0].prompt).toMatch(/do not add flags, banners, emblems, insignia/i);
  });

  test("graphic prompts do NOT receive PB1 reconstruction styling or the style reference note", async () => {
    const { long } = await mockPlan();
    const graphics = long.filter((s) => s.truth === "graphic");
    expect(graphics.length).toBeGreaterThan(0);
    for (const g of graphics) {
      expect(g.prompt).not.toMatch(/historical editorial illustration in the PastBriefly reconstruction style/i);
      expect(g.prompt).not.toMatch(/painterly but detailed/i);
      expect(g.prompt).not.toMatch(/style reference image only/i);
      expect(g.prompt).toMatch(/information graphic/i);
    }
  });
});

// ---------------------------------------------------------------------------
// PB1 reference wiring: reconstructions and the master generate from the one
// canonical PB1 style reference; graphics and real archive stills do not. The PB1
// style reference is never displaced by the master continuity reference.
// ---------------------------------------------------------------------------
describe("PB1 reference wiring", () => {
  const shot = (over: Partial<PlannedShot>): PlannedShot => ({
    index: 0, edit: "new", assetId: "L00", presentation: "base", framing: "wide", startSec: 0, endSec: 1, truth: "reconstruction", motion: "hold", wantsMotion: false, prompt: "p",
    purpose: "x", mustShow: [], mustNotShow: [], wordStart: 0, wordEnd: 1, ...over,
  });

  test("the canonical reference is the tracked PB1 tambora frame and it exists", () => {
    expect(PB1_STYLE_REFERENCE.replace(/\\/g, "/")).toMatch(/media\/style\/pb1\/tambora-summer-snow\.png$/);
    expect(existsSync(PB1_STYLE_REFERENCE)).toBe(true);
  });

  test("a normal reconstruction passes exactly the PB1 style reference", () => {
    expect(stillReferencePaths(story, shot({ useMaster: false }), null)).toEqual([PB1_STYLE_REFERENCE]);
  });

  test("a useMaster reconstruction passes the PB1 style reference first, then the master", () => {
    ensureStoryDirs(story.slug);
    const masterRel = "images/hero.png";
    writeFileSync(inStory(story.slug, masterRel), "x");
    const refs = stillReferencePaths(story, shot({ useMaster: true }), masterRel);
    expect(refs).toEqual([PB1_STYLE_REFERENCE, inStory(story.slug, masterRel)]);
    expect(refs![0]).toBe(PB1_STYLE_REFERENCE); // the master never displaces the PB1 style reference
  });

  test("a useMaster reconstruction whose master file is missing still passes just the PB1 reference", () => {
    expect(stillReferencePaths(story, shot({ useMaster: true }), "images/missing.png")).toEqual([PB1_STYLE_REFERENCE]);
  });

  test("master generation passes the PB1 style reference", () => {
    expect(masterReferencePaths()).toEqual([PB1_STYLE_REFERENCE]);
  });

  test("a graphic still receives no PB1 style reference", () => {
    expect(stillReferencePaths(story, shot({ truth: "graphic" }), null)).toBeUndefined();
  });

  test("a real archive still (before any fallback) receives no PB1 style reference", () => {
    expect(stillReferencePaths(story, shot({ truth: "archive" }), null)).toBeUndefined();
  });

  test("an archive shot that fell back to reconstruction does receive the PB1 style reference", () => {
    // acquireStill flips shot.truth to "reconstruction" when archive acquisition fails,
    // so the fallback is wired like any other reconstruction.
    expect(stillReferencePaths(story, shot({ truth: "reconstruction", useMaster: false }), null)).toEqual([PB1_STYLE_REFERENCE]);
  });
});
