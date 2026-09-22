import { describe, test, expect, beforeEach, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Story } from "../src/types.ts";
import type { ResearchPackage } from "../src/production/pipelineTypes.ts";

// Long and Short are separate live writes with distinct directors. We stub OpenAI
// and inspect the instructions each format sends, so the editorial rules that make
// a script follow-able to a zero-context viewer are actually in force.
const tmp = mkdtempSync(path.join(os.tmpdir(), "pb4-scripts-"));
process.env.PROVIDER_MODE = "live";
process.env.PB4_DATA_DIR = path.join(tmp, "data");
process.env.PB4_MEDIA_DIR = path.join(tmp, "media");

vi.mock("../src/providers/openai.ts", () => ({ respondJson: vi.fn() }));

const { respondJson } = await import("../src/providers/openai.ts");
const { writeScript, writeScripts } = await import("../src/production/scripts.ts");
const { config } = await import("../src/server/config.ts");
const respond = vi.mocked(respondJson);

function makeStory(): Story {
  return {
    id: "s1",
    slug: "a-soviet-submarine-got-stuck-in-sweden",
    title: "A Soviet Submarine Got Stuck in Sweden",
    hook: "It ran aground yards from a secret naval base.",
    category: "Conflicts & Standoffs",
    year: "1981",
    place: "Karlskrona, Sweden",
    summary: "A stranded submarine sparks a standoff.",
    heroImage: null,
    moments: [{ title: "The grounding", detail: "Stuck fast near a naval base." }],
    sources: [],
    productionNote: "",
    createdAt: new Date().toISOString(),
  };
}

function makeResearch(): ResearchPackage {
  return {
    summary: "A stranded submarine sparks a standoff.",
    moments: [{ title: "The grounding", detail: "Stuck fast near a naval base." }],
    sources: [{ title: "src", url: "https://example.org", note: "n" }],
    facts: [{ fact: "The submarine ran aground on 27 October 1981.", sourceTitle: "SOU 2001:85", sourceUrl: "https://example.org" }],
    productionNote: "",
    world: {
      period: "1981",
      place: "Karlskrona, Sweden",
      palette: "cold, low contrast",
      visualDirection: "sober reconstruction",
      recurringPeople: [],
      recurringLocations: ["Karlskrona"],
      referenceImages: [],
    },
  };
}

function instructionsFor(kind: "long" | "short"): string {
  const call = respond.mock.calls.find((c) => (c[0] as any).schemaName === "script");
  return (call![0] as any).instructions as string;
}

beforeEach(() => {
  respond.mockReset();
  respond.mockImplementation(async () => ({ script: "narration" }) as any);
});

describe("script directors", () => {
  test("the long director targets a ~950-1200 word film and explains before naming", async () => {
    await writeScript(makeStory(), makeResearch(), "long");
    const p = instructionsFor("long");

    expect(p).toMatch(/950-1200/);
    expect(p).toMatch(/Explain first, name second/i);
    // Zero-context clarity is the core rule, not documentary structure alone.
    expect(p).toMatch(/ZERO historical knowledge/i);
    // Do not end on a generic essay about history/geopolitics.
    expect(p).toMatch(/Land on the specific strange story/i);
    // v1.1: keep momentum after the hook instead of re-orienting.
    expect(p).toMatch(/MOVE THE STORY FORWARD/);
    // v1.1: concrete sourced events over abstract documentary summary.
    expect(p).toMatch(/CONCRETE OVER ABSTRACT/);
    expect(p).toContain("The incident attracted international attention.");
    // v1.1: no speculative rhetoric, attribute suspicions.
    expect(p).toMatch(/NO SPECULATIVE RHETORIC/);
    expect(p).toContain("Why else would");
    // v1.1: word count is guidance, not a reason to pad.
    expect(p).toMatch(/not a target to pad toward/);
    // Integrity v1: a silent final self-check before returning.
    expect(p).toMatch(/SELF-CHECK/);
    expect(p).toMatch(/no unsupported inference was added/);
    // v1.2: the script may not introduce facts absent from the audited research,
    // nor infer an unspecified actor.
    expect(p).toMatch(/FACT FIDELITY/);
    expect(p).toMatch(/introduces no factual claim that is not explicitly supported/);
    expect(p).toMatch(/no actor was inferred where the research wording is ambiguous/);
    expect(p).toContain('{ "script": string }');
  });

  test("the short director is its own write, not a crop of the long script", async () => {
    await writeScript(makeStory(), makeResearch(), "short");
    const p = instructionsFor("short");

    expect(p).toMatch(/105-130/);
    expect(p).toMatch(/NOT a summary or a crop of the long script/i);
    expect(p).toMatch(/Explain first, name second/i);
    // v1.1: the historical fact is the hook - no generic YouTube openers.
    expect(p).toMatch(/historical fact is the hook/);
    expect(p).toContain('"Imagine..."');
    // v1.1: keep momentum and attribute suspicions.
    expect(p).toMatch(/move straight to the next event/);
    expect(p).toMatch(/attribute suspicions to whoever held them/);
    // Integrity v1: a silent final self-check before returning.
    expect(p).toMatch(/SELF-CHECK/);
    expect(p).toMatch(/no unsupported inference was added/);
    // v1.2: the short script is held to the same fact-fidelity/actor rule.
    expect(p).toMatch(/FACT FIDELITY/);
    expect(p).toMatch(/introduces no factual claim that is not explicitly supported/);
    expect(p).toMatch(/no actor was inferred where the research wording is ambiguous/);
    expect(p).toContain('{ "script": string }');
  });

  test("the two formats send different directors", async () => {
    await writeScript(makeStory(), makeResearch(), "long");
    const long = (respond.mock.calls.at(-1)![0] as any).instructions as string;
    respond.mockClear();
    await writeScript(makeStory(), makeResearch(), "short");
    const short = (respond.mock.calls.at(-1)![0] as any).instructions as string;

    expect(long).not.toBe(short);
    expect(long).toMatch(/950-1200/);
    expect(short).toMatch(/105-130/);
  });

  test("the research summary and moments are handed to the writer", async () => {
    await writeScript(makeStory(), makeResearch(), "long");
    const input = (respond.mock.calls.at(-1)![0] as any).input as string;
    expect(input).toContain("A stranded submarine sparks a standoff.");
    expect(input).toContain("The grounding");
  });

  test("v1: the fact sheet is handed to both script writes as the factual spine", async () => {
    for (const kind of ["long", "short"] as const) {
      respond.mockClear();
      await writeScript(makeStory(), makeResearch(), kind);
      const input = (respond.mock.calls.at(-1)![0] as any).input as string;
      expect(input).toMatch(/FACT SHEET/);
      expect(input).toContain("The submarine ran aground on 27 October 1981.");
      expect(input).toContain("SOU 2001:85");
    }
  });
});

// The final fidelity audit is a single combined pass over both finished drafts,
// run only after the Long and Short writes complete. It returns corrected
// scripts that must match the final verified research, not the drafts.
describe("script fidelity audit", () => {
  // Writes return a plain narration; the combined audit returns { long, short }.
  function mockWritesAndAudit() {
    respond.mockReset();
    respond.mockImplementation(async (opts: any) => {
      if (opts.schemaName === "script_audit") return { long: "AUDITED LONG", short: "AUDITED SHORT" } as any;
      return { script: "draft narration" } as any;
    });
  }

  function auditCall() {
    return respond.mock.calls.find((c) => (c[0] as any).schemaName === "script_audit")![0] as any;
  }

  test("live writeScripts performs long + short + one combined fidelity audit", async () => {
    mockWritesAndAudit();
    await writeScripts(makeStory(), makeResearch());

    const schemas = respond.mock.calls.map((c) => (c[0] as any).schemaName);
    // Two "script" writes plus exactly one "script_audit".
    expect(schemas.filter((s) => s === "script")).toHaveLength(2);
    expect(schemas.filter((s) => s === "script_audit")).toHaveLength(1);
    expect(respond).toHaveBeenCalledTimes(3);
  });

  test("the script audit receives the final research and both draft scripts", async () => {
    mockWritesAndAudit();
    await writeScripts(makeStory(), makeResearch());
    const input = auditCall().input as string;

    expect(input).toMatch(/FINAL VERIFIED RESEARCH/);
    expect(input).toContain("A stranded submarine sparks a standoff.");
    expect(input).toContain("The grounding");
    // Both finished drafts are handed to the audit.
    expect(input).toMatch(/DRAFT LONG SCRIPT/);
    expect(input).toMatch(/DRAFT SHORT SCRIPT/);
    expect(input).toContain("draft narration");
  });

  test("v1: the fidelity audit receives the fact sheet as the factual spine", async () => {
    mockWritesAndAudit();
    await writeScripts(makeStory(), makeResearch());
    const input = auditCall().input as string;

    expect(input).toMatch(/FACT SHEET/);
    expect(input).toContain("The submarine ran aground on 27 October 1981.");
  });

  test("the returned scripts are the audited scripts, not the drafts", async () => {
    mockWritesAndAudit();
    const scripts = await writeScripts(makeStory(), makeResearch());

    expect(scripts.long).toBe("AUDITED LONG");
    expect(scripts.short).toBe("AUDITED SHORT");
  });

  test("the audit forbids unsupported facts and actor/date/sequence drift", async () => {
    mockWritesAndAudit();
    await writeScripts(makeStory(), makeResearch());
    const p = auditCall().instructions as string;

    // Not another creative rewrite - a fidelity pass against the final research.
    expect(p).toMatch(/FINAL SCRIPT FIDELITY AUDIT/);
    expect(p).toMatch(/NOT another creative rewrite/i);
    expect(p).toMatch(/explicitly supported by the FINAL verified research/);
    // Actor/date/sequence drift is corrected, with the concrete tug example.
    expect(p).toMatch(/never change who performed an action/);
    expect(p).toMatch(/Soviet tugs refloated the submarine/);
    // Invented color (the radio-silence example) is removed.
    expect(p).toMatch(/radio silence/);
    expect(p).toMatch(/harmless color/);
    // The Short/Long format differences survive the audit.
    expect(p).toMatch(/Short\/Long format differences/);
    expect(p).toContain('{ "long": string, "short": string }');
  });

  test("v1.3: the audit is surgical - it preserves supported detail and does not summarize", async () => {
    mockWritesAndAudit();
    await writeScripts(makeStory(), makeResearch());
    const p = auditCall().instructions as string;

    // A fact checker, not an editor: correct or remove unsupported facts only.
    expect(p).toMatch(/fact checker, not an editor/i);
    expect(p).toMatch(/CORRECT OR REMOVE UNSUPPORTED FACTS/);
    // Supported sentences are left alone (tiny fidelity wording changes aside).
    expect(p).toMatch(/if a sentence IS factually supported, leave it alone/i);
    // Preserve supported detail, causal explanation, context, transitions, structure.
    expect(p).toMatch(/PRESERVE SUPPORTED DETAIL AND STRUCTURE/);
    expect(p).toMatch(/preserve all supported factual detail/i);
    expect(p).toMatch(/causal explanation/);
    expect(p).toMatch(/overall structure and approximate length/);
    // It must not summarize/condense or shrink the Long into an overview.
    expect(p).toMatch(/Do NOT summarize or condense/i);
    expect(p).toMatch(/do NOT turn the Long into a condensed overview/i);
    expect(p).toMatch(/do not compress it toward the Short/);
    // Existing factual restrictions remain in force.
    expect(p).toMatch(/explicitly supported by the FINAL verified research/);
    expect(p).toMatch(/never change who performed an action/);
  });

  test("mock mode returns deterministic scripts with no audit", async () => {
    const prev = config.mode;
    config.mode = "mock";
    try {
      respond.mockReset();
      respond.mockImplementation(async () => ({ script: "narration" }) as any);
      const scripts = await writeScripts(makeStory(), makeResearch());

      // No provider calls at all, and no fidelity audit.
      expect(respond).not.toHaveBeenCalled();
      const schemas = respond.mock.calls.map((c) => (c[0] as any).schemaName);
      expect(schemas).not.toContain("script_audit");
      // Deterministic offline scripts derived from the research.
      expect(scripts.long).toContain("A stranded submarine sparks a standoff.");
      expect(scripts.short).toContain("Stuck fast near a naval base.");
    } finally {
      config.mode = prev;
    }
  });
});
