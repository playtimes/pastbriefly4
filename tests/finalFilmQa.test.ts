import { describe, test, expect, vi, beforeAll } from "vitest";
import { mkdtempSync } from "node:fs";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";

// Final-film QC: causal-risk extraction, the two specialist
// audits and their strict readers, the local combination and the asset-use
// evidence, with an injected reviewer. The contact sheet is built with the real
// ffmpeg from a tiny synthetic film (and counted). No provider is ever called:
// the real respondJson is replaced by one that fails the test if reached.
const tmp = mkdtempSync(path.join(os.tmpdir(), "pb4-final-film-qa-"));
process.env.PROVIDER_MODE = "mock";
process.env.PB4_DATA_DIR = path.join(tmp, "data");
process.env.PB4_MEDIA_DIR = path.join(tmp, "media");

vi.mock("../src/providers/openai.ts", async (orig) => ({
  ...(await orig<typeof import("../src/providers/openai.ts")>()),
  respondJson: async () => {
    throw new Error("unexpected provider call");
  },
}));

// Counts every frame sampling (and any contact sheet) a review makes.
const samplings = vi.hoisted(() => [] as string[]);
vi.mock("../src/render/contactSheet.ts", async (orig) => {
  const real = await orig<typeof import("../src/render/contactSheet.ts")>();
  return {
    ...real,
    sampledFrames: (videoPath: string, kind: "long" | "short", tmpRoot?: string) => {
      samplings.push(videoPath);
      return real.sampledFrames(videoPath, kind, tmpRoot);
    },
    contactSheet: (videoPath: string, kind: "long" | "short") => {
      samplings.push(`sheet:${videoPath}`);
      return real.contactSheet(videoPath, kind);
    },
  };
});

const {
  reviewFinalFilm,
  reviewFinalFactual,
  reviewFinalVisual,
  finalQaIssues,
  FINAL_VISUAL_QA_MODEL,
  causalClaims,
  narrationSentences,
  readFactualAudit,
  readVisualAudit,
  combineFinalFilmQa,
  assetUse,
  assetUseText,
  sampledReuse,
  sampledReuseLine,
  frameLabel,
  FACTUAL_AUDIT_INSTRUCTIONS,
  VISUAL_AUDIT_INSTRUCTIONS,
} = await import("../src/production/finalFilmQa.ts");
const { config } = await import("../src/server/config.ts");
const { sampledFrames } = await import("../src/render/contactSheet.ts");
import type { FinalFilmInput, FinalShot, FinalFilmReviewer, FactualAudit, VisualAudit } from "../src/production/finalFilmQa.ts";

const LONG_SEC = 12;
const SHORT_SEC = 6;
let longFilm = "";
let shortFilm = "";
beforeAll(() => {
  const make = (file: string, size: string, sec: number) => {
    execFileSync(config.ffmpeg, ["-v", "error", "-y", "-f", "lavfi", "-i", `testsrc2=s=${size}:r=30:d=${sec}`, "-c:v", "libx264", "-pix_fmt", "yuv420p", file]);
    return file;
  };
  longFilm = make(path.join(tmp, "long.mp4"), "320x180", LONG_SEC);
  shortFilm = make(path.join(tmp, "short.mp4"), "180x320", SHORT_SEC);
}, 60000);

// Equal slots over the film, one asset id per slot, each its base presentation.
function edit(ids: string[], durationSec: number, truth: (id: string) => FinalShot["truth"] = () => "reconstruction"): FinalShot[] {
  const len = durationSec / ids.length;
  return ids.map((assetId, index) => ({ index, assetId, presentation: "base", framing: "wide", truth: truth(assetId), startSec: index * len, endSec: (index + 1) * len }));
}

// Film #4-like research: PB4's own synthesis already leans toward the atomic
// bomb, while the concrete evidence gives mixed reasons (technical uncertainty,
// readiness, atomic work as a competing priority).
const RESEARCH: FinalFilmInput["research"] = {
  summary: "During the Second World War, the US Navy and Army Air Forces tested incendiary bombs carried by bats, before the program was ended in 1944 amid a shifting focus to the atomic bomb program.",
  moments: [{ title: "Carlsbad fire", detail: "Escaped armed bats set fire to buildings at Carlsbad Army Airfield in May 1943." }],
  facts: [
    { fact: "Project X-Ray was a US military program to use bats carrying small incendiary bombs.", sourceTitle: "Smithsonian Magazine", sourceUrl: "https://example.org/smithsonian-bat-bomb" },
    { fact: "Officials judged the weapon would not be combat-ready until mid-1945.", sourceTitle: "Naval History and Heritage Command", sourceUrl: "https://example.org/nhhc-x-ray" },
    { fact: "The program was ended in 1944 amid the increasing priority of the atomic bomb program.", sourceTitle: "Smithsonian Magazine", sourceUrl: "https://example.org/smithsonian-bat-bomb" },
  ],
  sources: [
    { title: "Smithsonian Magazine", url: "https://example.org/smithsonian-bat-bomb", note: "program history; overtaken by atomic bomb priority" },
    { title: "Naval History and Heritage Command", url: "https://example.org/nhhc-x-ray", note: "program end and readiness concerns" },
  ],
};

const FILM4_SENTENCE = "By spring 1944, the program was cancelled in favor of the atomic bomb.";
const SHORT_SCRIPT = `In 1943 the U.S. military strapped tiny firebombs to bats. Some escaped and burned down part of an airfield in Carlsbad. ${FILM4_SENTENCE}`;

function input(over: Partial<FinalFilmInput> = {}): FinalFilmInput {
  return {
    story: { title: "The Bat Bomb", year: "1943", place: "Carlsbad, New Mexico" },
    kind: "short",
    script: SHORT_SCRIPT,
    research: RESEARCH,
    videoPath: shortFilm,
    durationSec: SHORT_SEC,
    shots: edit(["S00", "S01", "S02", "S03"], SHORT_SEC),
    ...over,
  };
}
const longInput = (shots = edit(["L00", "L01", "L02"], LONG_SEC)) => input({ kind: "long", videoPath: longFilm, durationSec: LONG_SEC, shots });

const cells = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => from + i);

// Specialist answers.
const SUPPORTED = { text: FILM4_SENTENCE, verdict: "SUPPORTED_DIRECTLY", reason: "Sources state it directly.", evidenceUrls: ["https://example.org/nhhc-x-ray"] };
const OVERSTATED = {
  text: FILM4_SENTENCE,
  verdict: "OVERSTATED",
  reason: "The sources give technical uncertainty and readiness concerns, with atomic work as a competing priority; none says it was cancelled in favor of the atomic bomb.",
  evidenceUrls: ["https://example.org/nhhc-x-ray", "https://example.org/smithsonian-bat-bomb"],
};
const FACTUAL_ISSUE = { reason: "Collapses several material reasons into one replacement cause.", text: "cancelled in favor of the atomic bomb" };
const FACTUAL_PASS = { causalChecks: [SUPPORTED], issues: [], decision: "PASS", summary: "The narration matches the sources." };
const FACTUAL_REVIEW = { causalChecks: [OVERSTATED], issues: [FACTUAL_ISSUE], decision: "HUMAN_REVIEW", summary: "One causal claim is stronger than the evidence." };

// One plain observation per cell, 1..n; `describe` overrides chosen cells.
function observe(n: number, describe: Record<number, string> = {}) {
  return cells(1, n).map((cell) => ({ cell, description: describe[cell] ?? `ship moored at a harbor quay, view ${cell}` }));
}
const SHORT_OBSERVATIONS = observe(12, {
  1: "soldiers loading crates at a depot",
  2: "soldiers loading crates onto a truck",
  3: "soldier stacking crates in a shed",
  4: "dark sky over desert scrub",
  5: "desert scrub under a night sky",
  6: "moon above desert hills",
  7: "hangar on fire at night",
  8: "hangar roof burning",
  9: "firefighters in front of a burning hangar",
  10: "typed memo filling the frame",
  11: "typed memo with a stamp",
  12: "hand signing a typed memo",
});
const SHORT_PASS = {
  cellObservations: SHORT_OBSERVATIONS,
  families: [
    { name: "Soldiers loading crates", description: "Men handling crates at a depot.", cells: [1, 2, 3] },
    { name: "Desert night sky", description: "Dark sky over desert scrub.", cells: [4, 5, 6] },
    { name: "Burning hangar", description: "A hangar on fire.", cells: [7, 8, 9] },
    { name: "Typed memo close-up", description: "A typed page filling the frame.", cells: [10, 11, 12] },
  ],
  issues: [],
  decision: "PASS",
  summary: "Four distinct families, evenly spread.",
};
const SHORT_REVIEW = {
  ...SHORT_PASS,
  issues: [{ reason: "Burning hangar returns across the film.", cells: [7, 8, 9] }],
  decision: "HUMAN_REVIEW",
  summary: "One family dominates.",
};
const LONG_PASS = {
  cellObservations: observe(24),
  families: [{ name: "Harbor quay", description: "Ships at a quay.", cells: cells(1, 24) }],
  issues: [],
  decision: "PASS",
  summary: "One harbor throughout.",
};
const LONG_REVIEW = { ...LONG_PASS, issues: [{ reason: "Harbor quay fills the whole film.", cells: [1, 12, 24] }], decision: "HUMAN_REVIEW", summary: "One scene throughout." };

// An injected reviewer that records every call and answers by specialist.
function recorder(answers: { factual: unknown; visual: unknown }) {
  const calls: Parameters<FinalFilmReviewer>[0][] = [];
  const reviewer: FinalFilmReviewer = async (opts) => {
    calls.push(opts);
    return opts.schemaName === "final_film_factual_audit" ? answers.factual : answers.visual;
  };
  return { calls, reviewer };
}

describe("causal-risk extraction", () => {
  test("A. catches every high-risk causal cue, case-insensitively", () => {
    const cases: [string, string][] = [
      ["The raid failed because the fuses were wet.", "because"],
      ["The test was delayed due to rain.", "due to"],
      ["The bats caused a fire.", "caused"],
      ["The fire was caused by escaped bats.", "caused by"],
      ["The fire led to an inquiry.", "led to"],
      ["The fire resulted in a new hangar.", "resulted in"],
      ["Therefore the Navy took over.", "therefore"],
      ["The letter prompted a test.", "prompted"],
      ["The weather forced a delay.", "forced"],
      ["It was dropped IN FAVOR OF another weapon.", "in favor of"],
      ["Doubts contributed to the end of the program.", "contributed to"],
    ];
    for (const [sentence, cue] of cases) expect(causalClaims(sentence), sentence).toEqual([{ text: sentence, cues: [cue] }]);
  });

  test("B. the exact Film #4 Short sentence is extracted", () => {
    expect(causalClaims(SHORT_SCRIPT)).toEqual([{ text: FILM4_SENTENCE, cues: ["in favor of"] }]);
  });

  test("C. ordinary non-causal sentences are not extracted", () => {
    const plain = "The bats were released over the desert. The Army Air Forces tested it in 1943. The lead engineer arrived in May. He was in favor. The cause was secret for decades? Nobody knew!";
    expect(causalClaims(plain).map((c) => c.text)).toEqual(["The cause was secret for decades?"]); // "cause" is causal wording
    expect(causalClaims("The bats were released over the desert. The Army Air Forces tested it in 1943. The lead engineer arrived in May. He was in favor.")).toEqual([]);
  });

  test("sentences are exact, initialisms do not split them, repeats are checked once", () => {
    const script = "In 1942 the U.S. military, prompted by a dentist's letter, built bat bombs.  Dr. Adams led to  the test site. In 1942 the U.S. military, prompted by a dentist's letter, built bat bombs.";
    expect(narrationSentences(script)[0]).toBe("In 1942 the U.S. military, prompted by a dentist's letter, built bat bombs.");
    expect(causalClaims(script)).toEqual([
      { text: "In 1942 the U.S. military, prompted by a dentist's letter, built bat bombs.", cues: ["prompted"] },
      { text: "Dr. Adams led to the test site.", cues: ["led to"] },
    ]);
  });
});

describe("factual audit reader", () => {
  const claims = [FILM4_SENTENCE];

  test("PASS with every check SUPPORTED_DIRECTLY and no issues parses", () => {
    expect(readFactualAudit(FACTUAL_PASS, claims)).toEqual(FACTUAL_PASS);
  });

  test("D. every supplied causal sentence must be checked exactly once", () => {
    const two = [FILM4_SENTENCE, "The fire led to an inquiry."];
    const other = { ...SUPPORTED, text: "The fire led to an inquiry." };
    expect(readFactualAudit({ ...FACTUAL_PASS, causalChecks: [SUPPORTED, other] }, two).causalChecks).toHaveLength(2);
    expect(readFactualAudit({ ...FACTUAL_PASS, causalChecks: [] }, []).causalChecks).toEqual([]);
  });

  test("E. missing, duplicate or substituted causal-check text is rejected", () => {
    const bad: [unknown, RegExp][] = [
      [{ ...FACTUAL_PASS, causalChecks: [] }, /no causal check for "By spring 1944/],
      [{ ...FACTUAL_PASS, causalChecks: [SUPPORTED, SUPPORTED] }, /repeats/],
      [{ ...FACTUAL_PASS, causalChecks: [{ ...SUPPORTED, text: "By spring 1944, the program was cancelled." }] }, /not one of the supplied causal sentences/],
      [{ ...FACTUAL_PASS, causalChecks: [{ ...SUPPORTED, text: FILM4_SENTENCE.slice(0, -1) }] }, /not one of the supplied causal sentences/],
      [{ ...FACTUAL_PASS, causalChecks: [{ ...SUPPORTED, evidenceUrls: [] }] }, /evidence URL/],
      [{ ...FACTUAL_PASS, causalChecks: [{ ...SUPPORTED, evidenceUrls: ["Smithsonian Magazine"] }] }, /evidence URL/],
      [{ ...FACTUAL_PASS, causalChecks: [{ ...SUPPORTED, verdict: "PARTLY" }] }, /verdict "PARTLY"/],
      [{ ...FACTUAL_PASS, causalChecks: [{ ...SUPPORTED, reason: " " }] }, /needs a reason/],
    ];
    for (const [raw, why] of bad) expect(() => readFactualAudit(raw, claims), JSON.stringify(raw)).toThrow(why);
  });

  test("F. PASS is rejected when a causal check is OVERSTATED or UNCERTAIN", () => {
    expect(() => readFactualAudit({ ...FACTUAL_PASS, causalChecks: [OVERSTATED] }, claims)).toThrow(/PASS cannot carry a OVERSTATED causal check/);
    expect(() => readFactualAudit({ ...FACTUAL_PASS, causalChecks: [{ ...OVERSTATED, verdict: "UNCERTAIN" }] }, claims)).toThrow(/PASS cannot carry a UNCERTAIN causal check/);
    expect(() => readFactualAudit({ ...FACTUAL_PASS, issues: [FACTUAL_ISSUE] }, claims)).toThrow(/PASS cannot carry issues/);
  });

  test("G. OVERSTATED / UNCERTAIN needs HUMAN_REVIEW with a corresponding issue", () => {
    expect(readFactualAudit(FACTUAL_REVIEW, claims)).toEqual(FACTUAL_REVIEW);
    const uncertain = { ...FACTUAL_REVIEW, causalChecks: [{ ...OVERSTATED, verdict: "UNCERTAIN" }], issues: [{ reason: "Disputed.", text: FILM4_SENTENCE }] };
    expect(readFactualAudit(uncertain, claims).decision).toBe("HUMAN_REVIEW");
    // An issue about something else does not cover the flagged sentence.
    const unrelated = { ...FACTUAL_REVIEW, issues: [{ reason: "Wrong year.", text: "In 1943" }] };
    expect(() => readFactualAudit(unrelated, claims)).toThrow(/OVERSTATED causal check "By spring 1944.*" has no corresponding issue/);
    expect(() => readFactualAudit({ ...FACTUAL_REVIEW, issues: [] }, claims)).toThrow(/HUMAN_REVIEW needs at least one issue/);
  });

  test("a factual issue unrelated to the causal list is allowed", () => {
    const r = readFactualAudit({ causalChecks: [SUPPORTED], issues: [{ reason: "The fire was in May 1943, not 1942.", text: "In 1943" }], decision: "HUMAN_REVIEW", summary: "One date." }, claims);
    expect(r.issues).toHaveLength(1);
  });

  test("malformed answers are rejected", () => {
    const bad: unknown[] = [null, [], "PASS", { ...FACTUAL_PASS, decision: "pass" }, { ...FACTUAL_PASS, summary: undefined }, { ...FACTUAL_PASS, causalChecks: undefined }, { ...FACTUAL_REVIEW, issues: [{ reason: "no fragment" }] }, { ...FACTUAL_PASS, causalChecks: [null] }];
    for (const raw of bad) expect(() => readFactualAudit(raw, claims), JSON.stringify(raw)).toThrow(/Invalid Final-film factual audit/);
  });

  test("model dashes become plain hyphens", () => {
    const [em, en] = [String.fromCharCode(0x2014), String.fromCharCode(0x2013)]; // typographic dashes a model might return
    const r = readFactualAudit({ ...FACTUAL_REVIEW, summary: `Overstated ${em} one claim`, issues: [{ ...FACTUAL_ISSUE, reason: `1943${en}1944 mixed reasons` }] }, claims);
    expect(r.summary).toBe("Overstated - one claim");
    expect(r.issues[0].reason).toBe("1943-1944 mixed reasons");
  });
});

describe("visual audit reader", () => {
  const ids = ["S00", "S01", "S02", "S03"];
  const withObservations = (cellObservations: unknown[]) => ({ ...SHORT_PASS, cellObservations });

  test("C. every Long cell 1..24 must be observed exactly once", () => {
    expect(readVisualAudit(LONG_PASS, 24, ids).cellObservations.map((o) => o.cell)).toEqual(cells(1, 24));
    expect(() => readVisualAudit({ ...LONG_PASS, cellObservations: observe(23) }, 24, ids)).toThrow(/no observation for cell 24\./);
    expect(() => readVisualAudit({ ...LONG_PASS, cellObservations: observe(12) }, 24, ids)).toThrow(/no observation for cells 13, 14, .*24/);
  });

  test("D. every Short cell 1..12 must be observed exactly once", () => {
    expect(readVisualAudit(SHORT_PASS, 12, ids)).toEqual(SHORT_PASS);
    expect(() => readVisualAudit(LONG_PASS, 12, ids)).toThrow(/cell observation 13 has cell 13, outside 1-12/);
  });

  test("E. a missing, duplicate, out-of-range or empty cell observation is rejected", () => {
    expect(() => readVisualAudit(withObservations(SHORT_OBSERVATIONS.slice(0, 11)), 12, ids)).toThrow(/no observation for cell 12\./);
    expect(() => readVisualAudit(withObservations([...SHORT_OBSERVATIONS, SHORT_OBSERVATIONS[4]]), 12, ids)).toThrow(/cell 5 is observed twice/);
    for (const bad of [0, 13, 2.5, "3", undefined]) {
      const obs = SHORT_OBSERVATIONS.map((o) => (o.cell === 3 ? { ...o, cell: bad } : o));
      expect(() => readVisualAudit(withObservations(obs), 12, ids), String(bad)).toThrow(/outside 1-12/);
    }
    for (const description of ["", "  ", undefined]) {
      const obs = SHORT_OBSERVATIONS.map((o) => (o.cell === 3 ? { ...o, description } : o));
      expect(() => readVisualAudit(withObservations(obs), 12, ids), String(description)).toThrow(/cell 3 needs a description/);
    }
    for (const description of ["S01", "reconstruction", "Historical illustration", "archival photo"]) {
      const obs = SHORT_OBSERVATIONS.map((o) => (o.cell === 3 ? { ...o, description } : o));
      expect(() => readVisualAudit(withObservations(obs), 12, ids), description).toThrow(/cell 3 is described by an asset id, truth type or style/);
    }
    expect(() => readVisualAudit(withObservations([null, ...SHORT_OBSERVATIONS.slice(1)]), 12, ids)).toThrow(/cell observation 1 is not an object/);
  });

  test("F/G/H. repeated families may overlap, one cell may sit in several, and not every cell needs a family", () => {
    const overlapping = {
      ...SHORT_REVIEW,
      families: [
        { name: "Hangar on fire", description: "A burning hangar.", cells: [7, 8, 9] },
        { name: "Dark night sky", description: "Night sky filling the upper frame.", cells: [4, 5, 6, 7, 8] },
      ],
      issues: [{ reason: "Dark night sky runs under two different events.", cells: [4, 7, 8] }],
    };
    const r = readVisualAudit(overlapping, 12, ids);
    expect(r.families.map((f) => f.cells)).toEqual([[7, 8, 9], [4, 5, 6, 7, 8]]); // F: cells 7 and 8 in both
    expect(r.families.filter((f) => f.cells.includes(7))).toHaveLength(2); // G
    const covered = new Set(r.families.flatMap((f) => f.cells));
    expect(cells(1, 12).filter((c) => !covered.has(c))).toEqual([1, 2, 3, 10, 11, 12]); // H: observed but in no family
    expect(r.cellObservations).toHaveLength(12);
    expect(readVisualAudit({ ...SHORT_PASS, families: [] }, 12, ids).families).toEqual([]); // nothing repeats: no families
  });

  test("I. one family cannot list the same cell twice", () => {
    const families = SHORT_PASS.families.map((f, i) => (i === 0 ? { ...f, cells: [1, 2, 3, 3] } : f));
    expect(() => readVisualAudit({ ...SHORT_PASS, families }, 12, ids)).toThrow(/family 1 \("Soldiers loading crates"\) lists cell 3 twice/);
  });

  test("J. a family with only one cell (or none) is rejected", () => {
    for (const c of [[7], []]) {
      const families = [...SHORT_PASS.families, { name: "Lone lighthouse", description: "A lighthouse.", cells: c }];
      expect(() => readVisualAudit({ ...SHORT_PASS, families }, 12, ids), JSON.stringify(c)).toThrow(/family 5 \("Lone lighthouse"\) needs at least 2 cells/);
    }
  });

  test("family cells must be valid, and names must be a visible scene, not an asset id, truth type or style", () => {
    for (const bad of [0, 13, -1, 2.5, "3"]) {
      const families = SHORT_PASS.families.map((f, i) => (i === 0 ? { ...f, cells: [1, 2, 3, bad] } : f));
      expect(() => readVisualAudit({ ...SHORT_PASS, families }, 12, ids), String(bad)).toThrow(/outside 1-12/);
    }
    const rename = (name: string) => ({ ...SHORT_PASS, families: SHORT_PASS.families.map((f, i) => (i === 0 ? { ...f, name } : f)) });
    for (const name of ["S01", "S00 and S01", "Archive", "reconstruction shots", "Historical illustration", "Archival photos", "Other", "Family 2", ""]) {
      expect(() => readVisualAudit(rename(name), 12, ids), name).toThrow(/Invalid Final-film visual audit/);
    }
    expect(readVisualAudit(rename("Map of the Pacific"), 12, ids).families[0].name).toBe("Map of the Pacific");
  });

  test("K. an issue must cite at least two distinct valid cells", () => {
    const issue = (cellList: unknown) => ({ ...SHORT_REVIEW, issues: [{ reason: "Burning hangar returns.", cells: cellList }] });
    expect(() => readVisualAudit(issue([7]), 12, ids)).toThrow(/visual issue 1 needs at least 2 cells/);
    expect(() => readVisualAudit(issue([]), 12, ids)).toThrow(/visual issue 1 needs at least 2 cells/);
    expect(() => readVisualAudit(issue(undefined), 12, ids)).toThrow(/visual issue 1 needs at least 2 cells/);
    expect(() => readVisualAudit(issue([7, 7]), 12, ids)).toThrow(/visual issue 1 lists cell 7 twice/);
    expect(() => readVisualAudit(issue([7, 13]), 12, ids)).toThrow(/visual issue 1 has cell 13, outside 1-12/);
    expect(() => readVisualAudit({ ...SHORT_REVIEW, issues: [{ reason: " ", cells: [7, 8] }] }, 12, ids)).toThrow(/visual issue 1 needs a reason/);
  });

  test("L. every issue cell must belong to a returned repeated family", () => {
    const families = [{ name: "Burning hangar", description: "A hangar on fire.", cells: [7, 8, 9] }];
    expect(readVisualAudit({ ...SHORT_REVIEW, families, issues: [{ reason: "Burning hangar.", cells: [7, 9] }] }, 12, ids).issues[0].cells).toEqual([7, 9]);
    expect(() => readVisualAudit({ ...SHORT_REVIEW, families, issues: [{ reason: "Burning hangar.", cells: [7, 9, 10, 11] }] }, 12, ids)).toThrow(
      /visual issue 1 cites cells 10, 11 outside every returned family/,
    );
    expect(() => readVisualAudit({ ...SHORT_REVIEW, families: [] }, 12, ids)).toThrow(/cites cells 7, 8, 9 outside every returned family/);
  });

  test("O. PASS / HUMAN_REVIEW invariants remain", () => {
    expect(() => readVisualAudit({ ...SHORT_REVIEW, decision: "PASS" }, 12, ids)).toThrow(/PASS cannot carry issues/);
    expect(() => readVisualAudit({ ...SHORT_PASS, decision: "HUMAN_REVIEW" }, 12, ids)).toThrow(/HUMAN_REVIEW needs at least one issue/);
    const bad: unknown[] = [null, [], { ...SHORT_PASS, decision: "pass" }, { ...SHORT_PASS, summary: undefined }, { ...SHORT_PASS, cellObservations: undefined }, { ...SHORT_PASS, families: "none" }, { ...SHORT_PASS, issues: undefined }];
    for (const raw of bad) expect(() => readVisualAudit(raw, 12, ids), JSON.stringify(raw)).toThrow(/Invalid Final-film visual audit/);
  });
});

describe("the two specialist calls", () => {
  test("H/I. the factual specialist: narration, source URLs, research as context, the causal list; web search on, no image", async () => {
    const { calls, reviewer } = recorder({ factual: FACTUAL_PASS, visual: SHORT_PASS });
    await reviewFinalFilm(input(), reviewer);
    const call = calls.find((c) => c.schemaName === "final_film_factual_audit")!;
    // H
    expect(call.input).toContain(SHORT_SCRIPT);
    for (const s of RESEARCH.sources) expect(call.input).toContain(s.url);
    for (const f of RESEARCH.facts) expect(call.input).toContain(f.fact);
    expect(call.input).toContain(RESEARCH.summary);
    expect(call.input).toContain("PB4 SAVED RESEARCH - CONTEXT, NOT CAUSAL AUTHORITY");
    expect(call.input).toContain(`CAUSAL CLAIMS REQUIRING EXPLICIT VERIFICATION (1):\n1. ${FILM4_SENTENCE}\n   (causal wording: "in favor of")`);
    expect(call.instructions).toBe(FACTUAL_AUDIT_INSTRUCTIONS);
    expect(FACTUAL_AUDIT_INSTRUCTIONS).toContain("PB4'S SAVED RESEARCH IS CONTEXT, NOT CAUSAL AUTHORITY");
    expect(FACTUAL_AUDIT_INSTRUCTIONS).toMatch(/never mark a causal claim supported merely because the same causal interpretation already appears in PB4's summary, facts, moments or source notes/);
    // I
    expect(call.webSearch).toBe(true);
    expect(call.images ?? []).toHaveLength(0);
  }, 60000);

  test("J. the causal-compression rule separates multiple / contributing causes from exclusive or direct causal wording", () => {
    expect(FACTUAL_AUDIT_INSTRUCTIONS).toMatch(/existed, was increasingly important, coincided with the decision, contributed to it, was one concern among others, or competed for resources does NOT by itself support narration saying "because of X", "due to X", "caused by X", "X led to", "cancelled in favor of X"/);
    expect(FACTUAL_AUDIT_INSTRUCTIONS).toContain("Multiple or contributing causes are not an exclusive or direct cause");
    expect(FACTUAL_AUDIT_INSTRUCTIONS).toMatch(/collapses them into one exclusive or simple cause is OVERSTATED/);
    expect(FACTUAL_AUDIT_INSTRUCTIONS).toContain('"In favor of X" is strong replacement and causal language');
    expect(FACTUAL_AUDIT_INSTRUCTIONS).toMatch(/use web search to check what the best sources actually say, rather than echoing PB4's saved synthesis/);
  });

  test("J/K/L/M/N. Short: 12 labelled JPEG frames in cell order, each label naming its own cell, time, slot and asset; no web search, no research", async () => {
    const { calls, reviewer } = recorder({ factual: FACTUAL_PASS, visual: SHORT_PASS });
    await reviewFinalFilm(input(), reviewer);
    const call = calls.find((c) => c.schemaName === "final_film_visual_audit")!;
    // J
    expect(call.images).toHaveLength(12);
    // K / L / M: one label per image, for that image's own cell, in chronological order.
    // 12 samples of 6s sit at 0.25s + 0.5s * i; four equal slots of 1.5s each.
    call.images!.forEach((image, i) => {
      const t = 0.25 + 0.5 * i;
      const slot = Math.floor(t / 1.5);
      expect(image.label).toBe(`CELL ${i + 1} | 0:0${Math.floor(t)} | slot 0${slot} | asset S0${slot} | presentation base | framing wide`);
      expect(image.mimeType).toBe("image/jpeg");
    });
    // M: each image is the frame sampled for that cell, in cell order.
    const frames = sampledFrames(shortFilm, "short");
    expect(call.images!.map((image) => image.data)).toEqual(frames.map((f) => f.jpeg));
    // The text still maps every cell, and the reuse and asset-use evidence travel with it.
    expect(call.input).toContain("SAMPLED FRAMES: 12 separate images, one per cell");
    expect(call.input).toMatch(/^Cell 1: 0:00 slot 00 S00:base \(reconstruction\)$/m);
    expect(call.input).toMatch(/^Cell 12: 0:05 slot 03 S03:base \(reconstruction\)$/m);
    expect(call.input).toContain("4 distinct assets across 4 slots.");
    expect(call.input).toContain("supporting evidence only - asset ids are production identities, not visual families");
    expect(call.input).toContain("Your cellObservations must describe every cell 1-12 exactly once.");
    expect(call.instructions).toBe(VISUAL_AUDIT_INSTRUCTIONS);
    // N
    expect(call.webSearch).toBeFalsy();
    expect(call.input).not.toContain(SHORT_SCRIPT);
    expect(call.input).not.toContain(RESEARCH.facts[0].fact);
  }, 60000);

  test("M. the visual instructions say asset ids are not visual families and pixel evidence is primary", () => {
    expect(VISUAL_AUDIT_INSTRUCTIONS).toContain("ASSET IDS ARE NOT VISUAL FAMILIES");
    expect(VISUAL_AUDIT_INSTRUCTIONS).toContain("Asset ids are production identities, not proof of visual diversity");
    expect(VISUAL_AUDIT_INSTRUCTIONS).toContain("Several different asset ids may look nearly identical");
    expect(VISUAL_AUDIT_INSTRUCTIONS).toContain("One asset may also appear in visually different crops");
    expect(VISUAL_AUDIT_INSTRUCTIONS).toMatch(/A high count of distinct asset ids, or a small share for every single asset, does NOT mean the film looks varied/);
    expect(VISUAL_AUDIT_INSTRUCTIONS).toContain("What the cells visibly show is the primary evidence");
  });

  test("N. the visual instructions separate one contiguous narrative sequence from recurrence across distant sections", () => {
    expect(VISUAL_AUDIT_INSTRUCTIONS).toContain("STEP 3 - DECISION: LOCAL SEQUENCE VS WHOLE-FILM RECURRENCE");
    expect(VISUAL_AUDIT_INSTRUCTIONS).toMatch(/Several ADJACENT cells sharing a motif during ONE coherent narrative event .* are a local sequence: a sequence may legitimately stay visually related, and adjacency alone is not a reason to flag/);
    expect(VISUAL_AUDIT_INSTRUCTIONS).toContain("A contiguous run is a concern only if its frames are near-identical and visually stagnant.");
    expect(VISUAL_AUDIT_INSTRUCTIONS).toContain("the same motif returning after other visual material, across distant sections of the film");
    expect(VISUAL_AUDIT_INSTRUCTIONS).toMatch(/whether it is one contiguous run or returns across distant sections; never overstate it/);
    expect(VISUAL_AUDIT_INSTRUCTIONS).toContain("No fixed number or percentage decides it");
  });

  test("the visual instructions put observations, then overlapping motifs, before the verdict, and do not seed Film #4", () => {
    expect(VISUAL_AUDIT_INSTRUCTIONS).toMatch(/STEP 1 - CELL OBSERVATIONS \(every cell, before anything else\)[\s\S]*STEP 2 - REPEATED VISUAL MOTIFS[\s\S]*STEP 3 - DECISION/);
    expect(VISUAL_AUDIT_INSTRUCTIONS).toContain("Families MAY OVERLAP: one cell can belong to several");
    expect(VISUAL_AUDIT_INSTRUCTIONS).toContain("a family needs at least two cells");
    expect(VISUAL_AUDIT_INSTRUCTIONS).toContain("A cell that repeats nothing needs no family.");
    expect(VISUAL_AUDIT_INSTRUCTIONS).not.toMatch(/\b(fire|flames?|smoke|bats?|workshop|workbench|airfield|runway)\b/i);
  });

  test("I/L/M. Long: 24 labelled JPEG frames in cell order", async () => {
    const { calls, reviewer } = recorder({ factual: FACTUAL_PASS, visual: LONG_PASS });
    await reviewFinalFilm(longInput(), reviewer);
    const call = calls.find((c) => c.schemaName === "final_film_visual_audit")!;
    expect(call.images).toHaveLength(24);
    expect(call.images!.map((image) => Number(/^CELL (\d+) \|/.exec(image.label)![1]))).toEqual(cells(1, 24));
    expect(call.images![0].label).toBe("CELL 1 | 0:00 | slot 00 | asset L00 | presentation base | framing wide");
    expect(call.images![23].label).toBe("CELL 24 | 0:11 | slot 02 | asset L02 | presentation base | framing wide");
    expect(call.input).toContain("SAMPLED FRAMES: 24 separate images, one per cell");
    expect(call.input).toMatch(/^Cell 24: 0:11 slot 02 L02:base \(reconstruction\)$/m);
    expect(call.webSearch).toBeFalsy();
  }, 60000);

  test("the instructions bind each image to its cell by its label, not by position", () => {
    expect(VISUAL_AUDIT_INSTRUCTIONS).toContain("that label, not the image's position, tells you which cell it is");
    expect(VISUAL_AUDIT_INSTRUCTIONS).toContain("take its number from the label right before its image");
    expect(VISUAL_AUDIT_INSTRUCTIONS).not.toMatch(/contact sheet|grid/i);
  });
});

describe("combined result", () => {
  const f = (raw: unknown): FactualAudit => readFactualAudit(raw, [FILM4_SENTENCE]);
  const v = (raw: unknown): VisualAudit => readVisualAudit(raw, 12, []);

  test("U. factual PASS + visual PASS -> PASS", () => {
    expect(combineFinalFilmQa(f(FACTUAL_PASS), v(SHORT_PASS))).toEqual({
      decision: "PASS",
      summary: "Factual: The narration matches the sources. Visual: Four distinct families, evenly spread.",
      factualIssues: [],
      visualIssues: [],
    });
  });

  test("V. factual HUMAN_REVIEW + visual PASS -> HUMAN_REVIEW", () => {
    expect(combineFinalFilmQa(f(FACTUAL_REVIEW), v(SHORT_PASS))).toMatchObject({ decision: "HUMAN_REVIEW", factualIssues: [FACTUAL_ISSUE], visualIssues: [] });
  });

  test("W. factual PASS + visual HUMAN_REVIEW -> HUMAN_REVIEW", () => {
    expect(combineFinalFilmQa(f(FACTUAL_PASS), v(SHORT_REVIEW))).toMatchObject({ decision: "HUMAN_REVIEW", factualIssues: [], visualIssues: [{ reason: "Burning hangar returns across the film." }] });
  });

  test("X. both HUMAN_REVIEW -> both issue sets are preserved", () => {
    const r = combineFinalFilmQa(f(FACTUAL_REVIEW), v(SHORT_REVIEW));
    expect(r.decision).toBe("HUMAN_REVIEW");
    expect(r.factualIssues).toEqual([FACTUAL_ISSUE]);
    expect(r.visualIssues).toEqual([{ reason: "Burning hangar returns across the film." }]);
    expect(r.summary).toBe("Factual: One causal claim is stronger than the evidence. Visual: One family dominates.");
  });

  test("O/Y/Z. exactly two reviewer calls (one visual) and one frame sampling per film, no summarizer", async () => {
    for (const film of [input(), longInput()]) {
      const visual = film.kind === "short" ? SHORT_REVIEW : LONG_REVIEW;
      const { calls, reviewer } = recorder({ factual: FACTUAL_REVIEW, visual });
      samplings.length = 0;
      const r = await reviewFinalFilm(film, reviewer);
      expect(calls.map((c) => c.schemaName)).toEqual(["final_film_factual_audit", "final_film_visual_audit"]);
      expect(samplings).toEqual([film.videoPath]); // frames sampled once; no contact sheet
      expect(r.decision).toBe("HUMAN_REVIEW");
      expect(r.specialists.factual.causalChecks[0].verdict).toBe("OVERSTATED");
      expect(r.specialists.visual.families.length).toBeGreaterThan(0);
    }
  }, 60000);

  test("a failed or malformed specialist answer fails the review; nothing silently passes", async () => {
    await expect(reviewFinalFilm(input(), recorder({ factual: { ...FACTUAL_PASS, causalChecks: [] }, visual: SHORT_PASS }).reviewer)).rejects.toThrow(/Invalid Final-film factual audit/);
    await expect(reviewFinalFilm(input(), recorder({ factual: FACTUAL_PASS, visual: { ...SHORT_PASS, cellObservations: [] } }).reviewer)).rejects.toThrow(/Invalid Final-film visual audit/);
    const failing: FinalFilmReviewer = async () => {
      throw new Error("provider down");
    };
    await expect(reviewFinalFilm(input(), failing)).rejects.toThrow("provider down");
  }, 60000);

  test("Stage 14B entry points: each specialist is exactly one call; only the visual one overrides the model, to GPT-6 Astra at high reasoning", async () => {
    const { calls, reviewer } = recorder({ factual: FACTUAL_REVIEW, visual: SHORT_PASS });
    samplings.length = 0;
    const factual = await reviewFinalFactual(input(), reviewer);
    expect(calls.map((c) => c.schemaName)).toEqual(["final_film_factual_audit"]);
    expect(samplings).toEqual([]); // the factual audit never touches the film
    expect([calls[0].model, calls[0].reasoning, calls[0].webSearch]).toEqual([undefined, undefined, true]);
    expect(factual.decision).toBe("HUMAN_REVIEW");

    const visual = await reviewFinalVisual(input(), reviewer);
    expect(calls.map((c) => c.schemaName)).toEqual(["final_film_factual_audit", "final_film_visual_audit"]);
    expect(samplings).toHaveLength(1);
    expect([calls[1].model, calls[1].reasoning, calls[1].webSearch]).toEqual([FINAL_VISUAL_QA_MODEL, { effort: "high" }, undefined]);
    expect(FINAL_VISUAL_QA_MODEL).toBe("gpt-6-astra");
    expect(config.openai.model).not.toBe(FINAL_VISUAL_QA_MODEL);
    expect(visual.decision).toBe("PASS");
  }, 60000);

  test("the public issues: film, area, reason and a fact's fragment only, Long before Short; an unfinished film adds nothing", () => {
    const f = (raw: unknown): FactualAudit => readFactualAudit(raw, [FILM4_SENTENCE]);
    const v = (raw: unknown): VisualAudit => readVisualAudit(raw, 12, []);
    const record = { outputsValidated: true as const, long: { factual: f(FACTUAL_REVIEW), visual: v(SHORT_PASS) }, short: { factual: f(FACTUAL_PASS), visual: v(SHORT_REVIEW) } };
    expect(finalQaIssues(record)).toEqual([
      { film: "long", area: "fact", ...FACTUAL_ISSUE },
      { film: "short", area: "visual", reason: "Burning hangar returns across the film." },
    ]);
    expect(finalQaIssues({ ...record, short: { factual: f(FACTUAL_PASS) } }).map((i) => i.film)).toEqual(["long"]);
    expect(finalQaIssues({ outputsValidated: true, long: { factual: f(FACTUAL_PASS), visual: v(SHORT_PASS) }, short: {} })).toEqual([]);
  });
});

describe("exact sampled reuse", () => {
  // 24 equal slots over 12s: cell n shows slot n-1. L00 sits in slots 0, 11, 12 and 19.
  const ids = cells(0, 23).map((i) => ([0, 11, 12, 19].includes(i) ? "L00" : `L${String(i + 1).padStart(2, "0")}`));
  const times = cells(0, 23).map((i) => 0.25 + 0.5 * i);
  const withPresentations = (p: Record<number, FinalShot["presentation"]>) => edit(ids, LONG_SEC).map((s) => (p[s.index] ? { ...s, presentation: p[s.index], framing: p[s.index] } : s));

  test("the same asset in the same presentation, sampled in cells 1, 12, 13 and 20, is one reuse group", () => {
    const reuse = sampledReuse(edit(ids, LONG_SEC), times);
    expect(reuse).toEqual([{ assetId: "L00", cells: [1, 12, 13, 20].map((cell) => ({ cell, presentation: "base" })) }]);
    expect(sampledReuseLine(reuse[0])).toBe("- L00: cells 1 (base), 12 (base), 13 (base), 20 (base) - all the same presentation (base)");
  });

  test("different presentations of the same asset are never called the same presentation", () => {
    const mixed = sampledReuse(withPresentations({ 11: "detail-left", 19: "detail-right" }), times);
    expect(mixed[0].cells.map((c) => [c.cell, c.presentation])).toEqual([[1, "base"], [12, "detail-left"], [13, "base"], [20, "detail-right"]]);
    const line = sampledReuseLine(mixed[0]);
    expect(line).toBe("- L00: cells 1 (base), 12 (detail-left), 13 (base), 20 (detail-right) - same presentation: base in cells 1, 13; the others are different crops of the same picture");
    expect(line).not.toContain("all the same presentation");
    const allDifferent = sampledReuse(withPresentations({ 0: "detail-left", 11: "detail-center", 12: "detail-right" }), times.slice(0, 13));
    expect(sampledReuseLine(allDifferent[0])).toBe("- L00: cells 1 (detail-left), 12 (detail-center), 13 (detail-right) - each a different crop of the same picture");
  });

  test("a picture sampled only once is omitted, even if it fills several slots", () => {
    expect(sampledReuse(edit(ids, LONG_SEC), times.slice(0, 11))).toEqual([]); // L00 only in cell 1
    const long = edit(["A", "A", "A", "B"], 4); // A fills three slots, but one sample lands on it
    expect(sampledReuse(long, [1.5, 3.5])).toEqual([]);
  });

  test("reuse is evidence in the visual payload, never a verdict by itself", async () => {
    const shots = edit(ids, LONG_SEC);
    const { calls, reviewer } = recorder({ factual: FACTUAL_PASS, visual: LONG_PASS });
    const r = await reviewFinalFilm(longInput(shots), reviewer);
    expect(calls[1].input).toContain("EXACT SAMPLED REUSE (cells that show the same saved picture");
    expect(calls[1].input).toContain("- L00: cells 1 (base), 12 (base), 13 (base), 20 (base) - all the same presentation (base)");
    expect(r.decision).toBe("PASS");
    expect(r.visualIssues).toEqual([]);
    // Twelve different pictures, one per sample: nothing to report.
    const distinct = recorder({ factual: FACTUAL_PASS, visual: SHORT_PASS });
    await reviewFinalFilm(input({ shots: edit(cells(0, 11).map((i) => `S${String(i).padStart(2, "0")}`), SHORT_SEC) }), distinct.reviewer);
    expect(distinct.calls[1].input).toContain("None: no saved picture is sampled more than once.");
  }, 60000);

  test("frame labels name the cell, time, slot, asset and presentation (framing only when it adds something)", () => {
    const shots = withPresentations({ 11: "detail-left" });
    expect(frameLabel(shots, 1, times[0])).toBe("CELL 1 | 0:00 | slot 00 | asset L00 | presentation base | framing wide");
    expect(frameLabel(shots, 12, times[11])).toBe("CELL 12 | 0:05 | slot 11 | asset L00 | presentation detail-left");
  });
});

describe("asset-use evidence", () => {
  test("counts appearances, cumulative screen time and returns after other shots", () => {
    // 10 slots of 1.5s: L01 at 0, 2, 3, 7; L02 at 1, 5; L03 at 4, 6, 8, 9.
    const shots = edit(["L01", "L02", "L01", "L01", "L03", "L02", "L03", "L01", "L03", "L03"], 15, (id) => (id === "L02" ? "archive" : "reconstruction"));
    expect(assetUse(shots)).toEqual([
      { assetId: "L01", truth: "reconstruction", slots: [0, 2, 3, 7], seconds: 6, returns: 2 },
      { assetId: "L02", truth: "archive", slots: [1, 5], seconds: 3, returns: 1 },
      { assetId: "L03", truth: "reconstruction", slots: [4, 6, 8, 9], seconds: 6, returns: 2 },
    ]);
    const text = assetUseText(shots, 15);
    expect(text).toContain("3 distinct assets across 10 slots.");
    expect(text).toContain("L01 (reconstruction): 4 slots [00, 02, 03, 07], 6s = 40% of runtime, returns 2 times after other shots");
    expect(text).toContain("L02 (archive): 2 slots [01, 05], 3s = 20% of runtime, returns 1 time after other shots");
    expect(text).toContain("MOST USED BY SCREEN TIME: L01 6s (40%); L03 6s (40%); L02 3s (20%)");
  });

  test("slot order, not array order, decides returns", () => {
    const shots = edit(["A", "B", "A"], 3).reverse();
    expect(assetUse(shots).map((u) => [u.assetId, u.returns])).toEqual([["A", 1], ["B", 0]]);
  });
});

// What Film #4 taught: both misses must be caught structurally, end to end.
describe("Film #4 regression fixtures", () => {
  test("factual: saved research that already leans atomic does not stop the Short's stronger claim coming back OVERSTATED", async () => {
    const { calls, reviewer } = recorder({ factual: FACTUAL_REVIEW, visual: SHORT_PASS });
    const r = await reviewFinalFilm(input(), reviewer);
    const factualCall = calls[0];
    // PB4's own synthesis reaches the reviewer as context, labelled as such...
    expect(factualCall.input).toContain("amid a shifting focus to the atomic bomb program");
    expect(factualCall.input).toContain("amid the increasing priority of the atomic bomb program");
    expect(factualCall.input).toContain("(PB4 note: program history; overtaken by atomic bomb priority)");
    expect(factualCall.input).toContain("CONTEXT, NOT CAUSAL AUTHORITY");
    // ...and the stronger sentence is still put to an explicit check.
    expect(r.specialists.causalClaims.map((c) => c.text)).toEqual([FILM4_SENTENCE]);
    expect(r.specialists.factual.causalChecks).toEqual([OVERSTATED]);
    expect(r.decision).toBe("HUMAN_REVIEW");
    expect(r.factualIssues).toEqual([FACTUAL_ISSUE]);
    expect(r.visualIssues).toEqual([]);
    // A reviewer that echoes the synthesis cannot skip the sentence or pass it unchecked.
    await expect(reviewFinalFilm(input(), recorder({ factual: { ...FACTUAL_PASS, causalChecks: [] }, visual: SHORT_PASS }).reviewer)).rejects.toThrow(/no causal check for "By spring 1944/);
  }, 60000);

  test("visual: many distinct asset ids, one scene returning across distant sections and a cross-cutting element on top -> HUMAN_REVIEW with concrete cells", async () => {
    // 24 slots, 20 distinct asset ids, no asset above 2 slots: metadata that looks varied.
    const ids = ["L00", "L01", "L02", "L03", "L04", "L05", "L06", "L07", "L08", "L09", "L10", "L11", "L12", "L13", "L14", "L15", "L16", "L17", "L18", "L19", "L00", "L01", "L05", "L19"];
    const shots = edit(ids, LONG_SEC); // cell n shows slot n-1
    // What the frames show: a truck on a rural road returns from opening to end
    // through four different asset ids, and heavy rain runs through most of the
    // film, inside the road scenes and inside otherwise different scenes.
    const ROAD = [1, 6, 11, 17, 23];
    const RAIN = [1, 3, 4, 6, 8, 9, 11, 13, 14, 17, 19, 20, 23];
    const observations = observe(24, {
      ...Object.fromEntries(ROAD.map((c) => [c, "army truck on a muddy rural road in heavy rain"])),
      ...Object.fromEntries(RAIN.filter((c) => !ROAD.includes(c)).map((c) => [c, `heavy rain over a village street, view ${c}`])),
      5: "paper document on a desk",
      12: "officer at a desk with a telephone",
      21: "paper map pinned to a wall",
    });
    const answer = {
      cellObservations: observations,
      families: [
        { name: "Truck on a rural road", description: "The same army truck on a muddy road, near-identical framing.", cells: ROAD },
        { name: "Heavy rain", description: "Rain streaks fill the frame, over roads and village streets alike.", cells: RAIN },
        { name: "Village street", description: "A narrow village street.", cells: [3, 4, 8, 9, 13, 14, 19, 20] },
      ],
      issues: [
        {
          reason: "Truck on a rural road returns five times across the whole film (0:00, 0:02, 0:05, 0:08, 0:11) through four different asset ids, and heavy rain runs through 13 of 24 cells from the opening to the end, so the film keeps falling back on the same wet road-and-street look.",
          cells: [...new Set([...ROAD, ...RAIN])].sort((a, b) => a - b),
        },
      ],
      decision: "HUMAN_REVIEW",
      summary: "Twenty assets, but a very small visual vocabulary.",
    };
    const { calls, reviewer } = recorder({ factual: FACTUAL_PASS, visual: answer });
    const r = await reviewFinalFilm(longInput(shots), reviewer);
    // The metadata looked varied...
    expect(calls[1].input).toContain("20 distinct assets across 24 slots.");
    expect(new Set(ROAD.map((c) => ids[c - 1])).size).toBe(4);
    // ...the evidence shows the overlap: road cells are also rain cells.
    const [road, rain] = r.specialists.visual.families;
    expect(road.cells.every((c) => rain.cells.includes(c))).toBe(true);
    expect(r.specialists.visual.cellObservations).toHaveLength(24);
    expect(Math.min(...road.cells)).toBe(1);
    expect(Math.max(...road.cells)).toBe(23); // opening to end, not one local run
    expect(r.decision).toBe("HUMAN_REVIEW");
    expect(r.specialists.visual.issues[0].cells).toEqual(RAIN); // the road cells are all rain cells
    expect(r.visualIssues).toEqual([{ reason: answer.issues[0].reason }]);
    expect(r.factualIssues).toEqual([]);
  }, 60000);

  test("calibration: one coherent local sequence of adjacent related cells can PASS", async () => {
    // Cells 7-10 all show one continuous event; nothing returns elsewhere.
    const observations = observe(12, {
      7: "barn catching fire at night",
      8: "barn roof collapsing in flames",
      9: "villagers carrying buckets toward the burning barn",
      10: "smoking ruins of the barn at dawn",
    });
    const local = {
      cellObservations: observations,
      families: [{ name: "Barn fire at night", description: "One continuous barn-fire episode.", cells: [7, 8, 9, 10] }],
      issues: [],
      decision: "PASS",
      summary: "One contiguous barn-fire sequence tells a single event; nothing recurs across distant sections.",
    };
    const { reviewer } = recorder({ factual: FACTUAL_PASS, visual: local });
    const r = await reviewFinalFilm(input(), reviewer);
    expect(r.decision).toBe("PASS");
    expect(r.specialists.visual.families[0].cells).toEqual([7, 8, 9, 10]);
    // The same family can equally support a stagnation issue: the schema carries both outcomes.
    const stagnant = { ...local, issues: [{ reason: "Barn fire at night holds near-identical frames for four samples in a row.", cells: [7, 8, 9, 10] }], decision: "HUMAN_REVIEW" };
    expect(readVisualAudit(stagnant, 12, []).decision).toBe("HUMAN_REVIEW");
  }, 60000);
});
