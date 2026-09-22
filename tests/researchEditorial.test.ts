import { describe, test, expect, beforeEach, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Story } from "../src/types.ts";

// The research prompt is the editorial policy for the causal spine and, in v1.1,
// for source integrity. We run the real researchStory in live mode with a stubbed
// OpenAI and inspect the instructions sent to the research call.
const tmp = mkdtempSync(path.join(os.tmpdir(), "pb4-research-"));
process.env.PROVIDER_MODE = "live";
process.env.PB4_DATA_DIR = path.join(tmp, "data");
process.env.PB4_MEDIA_DIR = path.join(tmp, "media");

vi.mock("../src/providers/openai.ts", () => ({ respondJson: vi.fn() }));

const { respondJson } = await import("../src/providers/openai.ts");
const { researchStory } = await import("../src/production/research.ts");
const { getStory } = await import("../src/server/store.ts");
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
    moments: [],
    sources: [],
    productionNote: "",
    createdAt: new Date().toISOString(),
  };
}

function pkg() {
  return {
    summary: "s",
    moments: [{ title: "m", detail: "d" }],
    sources: [{ title: "src", url: "https://example.org", note: "n" }],
    facts: [{ fact: "The submarine ran aground on 27 October 1981.", sourceTitle: "src", sourceUrl: "https://example.org" }],
    productionNote: "",
    world: {
      period: "1981",
      place: "Karlskrona, Sweden",
      palette: "cold",
      visualDirection: "sober",
      recurringPeople: [],
      recurringLocations: [],
      referenceImages: [],
    },
  };
}

function callWith(schemaName: string) {
  return respond.mock.calls.find((c) => (c[0] as any).schemaName === schemaName)![0] as any;
}

function researchInstructions(): string {
  return callWith("research").instructions as string;
}

function auditInstructions(): string {
  return callWith("research_audit").instructions as string;
}

function verifyInstructions(): string {
  return callWith("research_verify").instructions as string;
}

beforeEach(() => {
  respond.mockReset();
  respond.mockImplementation(async () => pkg() as any);
});

describe("research editorial policy", () => {
  test("the research prompt builds a concrete causal spine", async () => {
    await researchStory(makeStory());
    const p = researchInstructions();

    expect(p).toMatch(/causal spine/i);
    // Moments are concrete events, not abstract chapter categories.
    expect(p).toMatch(/concrete event or development/i);
  });

  test("v1.3: the research prompt asks for distinct chronological moments and long-form depth", async () => {
    await researchStory(makeStory());
    const p = researchInstructions();

    // Enough distinct events to support a 7-9 minute long film, ~8-12 moments.
    expect(p).toMatch(/7-9 minute/);
    expect(p).toMatch(/roughly 8-12 meaningful moments/);
    // Each moment is a genuinely distinct event, not a rephrasing of another.
    expect(p).toMatch(/DISTINCT event or development/);
    // Do not pad to a count, and do not collapse different-date events into one.
    expect(p).toMatch(/do NOT invent, pad or split trivial details/i);
    expect(p).toMatch(/do NOT collapse events that happened on different dates/i);
  });

  test("v1: the research schema and prompt produce a sourced fact sheet", async () => {
    const returned = await researchStory(makeStory());
    const p = researchInstructions();

    // The draft prompt asks for a concrete, sourced fact sheet - the factual spine.
    expect(p).toMatch(/FACT SHEET/);
    expect(p).toMatch(/factual spine/i);
    expect(p).toMatch(/sourceUrl/);
    // The research schema requires a facts array in every pass.
    const schema = callWith("research").schema as any;
    expect(schema.required).toContain("facts");
    expect(schema.properties.facts.type).toBe("array");
    // The persisted/returned package carries the fact sheet through to the scripts.
    expect(Array.isArray(returned.facts)).toBe(true);
    expect(returned.facts[0].fact).toContain("27 October 1981");
  });

  test("v1: the final verification owns and checks the fact sheet", async () => {
    await researchStory(makeStory());
    const p = verifyInstructions();

    expect(p).toMatch(/FINAL FACT SHEET/);
    // It must reconcile the facts with the moments/summary and their real sources.
    expect(p).toMatch(/agrees with the final moments and summary/);
    expect(p).toMatch(/sourceTitle and sourceUrl/);
    // Disputed points keep their attribution inside the fact.
    expect(p).toMatch(/disputed points keep their attribution inside the fact/);
  });

  test("the research prompt forbids inventing or reconstructing source URLs", async () => {
    await researchStory(makeStory());
    const p = researchInstructions();

    // v1.1 source integrity: never guess a URL; omit rather than fabricate.
    expect(p).toMatch(/Never invent or reconstruct a source URL/);
    expect(p).toMatch(/actual web-search result/);
    expect(p).toMatch(/omit that source rather than guessing/);
    expect(p).toMatch(/a source title alone is never enough/i);
    expect(p).toMatch(/fewer real, verifiable sources/);
  });
});

describe("research integrity audit", () => {
  test("live research performs draft -> audit -> final verification", async () => {
    await researchStory(makeStory());

    // Three web-search-backed calls: draft, then audit, then final verification.
    expect(respond).toHaveBeenCalledTimes(3);
    const draftCall = callWith("research");
    const auditCall = callWith("research_audit");
    const verifyCall = callWith("research_verify");
    expect(draftCall.webSearch).toBe(true);
    expect(auditCall.webSearch).toBe(true);
    expect(verifyCall.webSearch).toBe(true);
    // The audit is fed the draft package to fact-check.
    expect(auditCall.input).toMatch(/DRAFT RESEARCH TO AUDIT/);
  });

  test("the final verification receives the audited package", async () => {
    respond.mockReset();
    const draft = { ...pkg(), summary: "DRAFT summary with an unsupported claim." };
    const audited = { ...pkg(), summary: "AUDITED summary, attributed." };
    const verified = { ...pkg(), summary: "VERIFIED summary, cross-checked." };
    respond
      .mockResolvedValueOnce(draft as any)
      .mockResolvedValueOnce(audited as any)
      .mockResolvedValueOnce(verified as any);

    await researchStory(makeStory());

    // The verification pass is handed the audited package (not the raw draft).
    const verifyCall = callWith("research_verify");
    expect(verifyCall.input).toMatch(/AUDITED RESEARCH TO VERIFY/);
    expect(verifyCall.input).toContain("AUDITED summary, attributed.");
  });

  test("only the final verified package is persisted and returned", async () => {
    respond.mockReset();
    const draft = { ...pkg(), summary: "DRAFT summary with an unsupported claim." };
    const audited = { ...pkg(), summary: "AUDITED summary, attributed." };
    const verified = { ...pkg(), summary: "VERIFIED summary, cross-checked." };
    respond
      .mockResolvedValueOnce(draft as any)
      .mockResolvedValueOnce(audited as any)
      .mockResolvedValueOnce(verified as any);

    const story = makeStory();
    const returned = await researchStory(story);

    // The caller (and therefore writeScripts) receives the final verified package.
    expect(returned.summary).toBe("VERIFIED summary, cross-checked.");
    // And the verified facts - not the draft or the audit - are what gets persisted.
    expect(getStory(story.id).summary).toBe("VERIFIED summary, cross-checked.");
  });

  test("the final verification checks chronology and actor fidelity", async () => {
    await researchStory(makeStory());
    const p = verifyInstructions();

    // A narrow verification pass, not another rewrite.
    expect(p).toMatch(/FINAL FACT VERIFICATION/);
    expect(p).toMatch(/NOT another rewrite/i);
    // Chronology is rebuilt from the strongest sources; separate events stay separate.
    expect(p).toMatch(/CHRONOLOGY/);
    expect(p).toMatch(/Never merge different dates or different events/);
    // Actor fidelity is mandatory and must not swap one actor for another.
    expect(p).toMatch(/ACTOR FIDELITY/);
    expect(p).toMatch(/never swap one actor for another/);
    // Stronger source wins concrete conflicts.
    expect(p).toMatch(/SOURCE PREFERENCE/);
    expect(p).toMatch(/correct the package to the stronger source/);
  });

  test("v1.3: the final verification may not merge or thin separately dated events", async () => {
    await researchStory(makeStory());
    const p = verifyInstructions();

    // The pre-existing rule against merging distinct events stays in force.
    expect(p).toMatch(/Never merge different dates or different events/);
    // v1.3: distinct chronology is preserved, not thinned to shorten the package.
    expect(p).toMatch(/preserve the distinct chronology whenever strong sources establish it/);
    expect(p).toMatch(/do not drop, thin or fold together separately dated events/i);
    // A richly-sourced sequence keeps its depth rather than being compressed.
    expect(p).toMatch(/roughly 8-12 distinct moments/);
    expect(p).toMatch(/may not reduce a well-evidenced chronology/i);
  });

  test("v1.3: the audit keeps genuinely distinct dated events separate", async () => {
    await researchStory(makeStory());
    const p = auditInstructions();

    expect(p).toMatch(/PRESERVE DISTINCT CHRONOLOGY/);
    expect(p).toMatch(/do not thin the package by merging separately dated events/i);
    // Auditing removes unsupported claims; it does not compress a good chronology.
    expect(p).toMatch(/not for compressing a well-evidenced chronology/);
  });

  test("the audit instructions handle disputed evidence with attribution", async () => {
    await researchStory(makeStory());
    const p = auditInstructions();

    expect(p).toMatch(/audit/i);
    expect(p).toMatch(/disputed/i);
    expect(p).toMatch(/do NOT manufacture a resolution/);
    expect(p).toMatch(/attributed wording/);
    // Observed fact vs allegation vs official assessment vs later interpretation.
    expect(p).toMatch(/official assessment/);
    expect(p).toMatch(/later interpretation/);
    // Inference must not be written as fact.
    expect(p).toMatch(/inference being written as fact/);
  });

  test("the audit instructions forbid inventing or reconstructing source URLs", async () => {
    await researchStory(makeStory());
    const p = auditInstructions();

    expect(p).toMatch(/Never invent or reconstruct/);
    expect(p).toMatch(/actually found or consulted/);
    expect(p).toMatch(/cannot verify a URL, remove that source/i);
  });

  test("v1.2: the audit ranks conflicting sources and prefers the stronger one", async () => {
    await researchStory(makeStory());
    const p = auditInstructions();

    expect(p).toMatch(/SOURCE HIERARCHY/);
    expect(p).toMatch(/official contemporary documents/);
    // A concrete conflict is resolved toward the stronger source, not flattened.
    expect(p).toMatch(/prefer the stronger source/);
    // Reference/tourism pages must not override an official chronology by default.
    expect(p).toMatch(/without a clear, stated reason/);
  });

  test("v1.2: the audit cross-checks chronology and actors before returning", async () => {
    await researchStory(makeStory());
    const p = auditInstructions();

    expect(p).toMatch(/CROSS-CHECK BEFORE RETURNING/);
    expect(p).toMatch(/who performed each action/);
    // Moment actors must be explicit so a later script cannot misread them.
    expect(p).toMatch(/EXPLICIT ACTORS/);
    expect(p).toMatch(/never leave the actor ambiguous/);
  });

  test("mock mode stays one deterministic pass and never audits or verifies", async () => {
    const prev = config.mode;
    config.mode = "mock";
    try {
      respond.mockReset();
      const story = makeStory();
      const returned = await researchStory(story);

      // No provider calls at all - no draft, no audit, no verification. The package
      // is derived straight from the story.
      expect(respond).not.toHaveBeenCalled();
      expect(returned.summary).toBe(story.summary);
    } finally {
      config.mode = prev;
    }
  });
});
