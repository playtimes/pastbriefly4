import { describe, test, expect, beforeEach, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Story } from "../src/types.ts";
import type { ResearchPackage } from "../src/production/pipelineTypes.ts";

// Text Integrity v1.1: rules drawn from failures in the first real production
// job. We stub OpenAI and inspect the instructions each existing call sends.
const tmp = mkdtempSync(path.join(os.tmpdir(), "pb4-text-integrity-"));
process.env.PROVIDER_MODE = "live";
process.env.PB4_DATA_DIR = path.join(tmp, "data");
process.env.PB4_MEDIA_DIR = path.join(tmp, "media");

vi.mock("../src/providers/openai.ts", () => ({ respondJson: vi.fn() }));

const { respondJson } = await import("../src/providers/openai.ts");
const { researchStory } = await import("../src/production/research.ts");
const { writeScripts } = await import("../src/production/scripts.ts");
const respond = vi.mocked(respondJson);

function makeStory(): Story {
  return {
    id: "s1",
    slug: "a-stranded-ship",
    title: "A Stranded Ship",
    hook: "It ran aground near a naval base.",
    category: "Conflicts & Standoffs",
    year: "1981",
    place: "Somewhere",
    summary: "A stranded ship sparks a standoff.",
    heroImage: null,
    moments: [],
    sources: [],
    productionNote: "",
    createdAt: new Date().toISOString(),
  };
}

function pkg(): ResearchPackage {
  return {
    summary: "A stranded ship sparks a standoff.",
    moments: [{ title: "m", detail: "d" }],
    sources: [{ title: "src", url: "https://example.org", note: "n" }],
    facts: [{ fact: "The ship ran aground on 27 October 1981.", sourceTitle: "src", sourceUrl: "https://example.org" }],
    productionNote: "",
    world: { period: "1981", place: "Somewhere", palette: "cold", visualDirection: "sober", recurringPeople: [], recurringLocations: [], referenceImages: [] },
  };
}

function instructions(schemaName: string, pick: (c: any) => boolean = () => true): string {
  const call = respond.mock.calls.find((c) => (c[0] as any).schemaName === schemaName && pick(c[0]));
  return (call![0] as any).instructions as string;
}

beforeEach(() => {
  respond.mockReset();
  respond.mockImplementation(async (opts: any) => {
    if (opts.schemaName === "script_audit") return { long: "L", short: "S" } as any;
    if (opts.schemaName === "script") return { script: "narration" } as any;
    return pkg() as any;
  });
});

async function scriptPrompts() {
  await writeScripts(makeStory(), pkg());
  const long = instructions("script", (o) => /long-form script director/.test(o.instructions));
  const short = instructions("script", (o) => /Short script director/.test(o.instructions));
  const audit = instructions("script_audit");
  return { long, short, audit, all: [long, short, audit] };
}

describe("text integrity v1.1", () => {
  test("research audit and final verification keep the summary as story content, not audit commentary", async () => {
    await researchStory(makeStory());
    for (const p of [instructions("research_audit"), instructions("research_verify")]) {
      expect(p).toMatch(/SUMMARY IS THE STORY/);
      expect(p).toMatch(/ONLY a concise factual summary of the historical story/);
      expect(p).toMatch(/Never put audit findings, verification commentary, confidence notes, methodology, source-quality commentary or reviewer notes in the summary/);
      expect(p).toMatch(/Correct the package IN PLACE/);
      expect(p).toMatch(/not a description of your audit/);
      expect(p).toMatch(/Preserve useful supported story detail/);
    }
  });

  test("no inferred ownership or use of labels and classifications", async () => {
    const { all } = await scriptPrompts();
    for (const p of all) {
      expect(p).toMatch(/never infer who coined, used or preferred a historical label/i);
      expect(p).toMatch(/state it neutrally/);
      expect(p).toMatch(/NATO reporting name, nickname, Western label or local label/);
      // General rule, not hardcoded to one story.
      expect(p).not.toMatch(/Whiskey class/);
    }
  });

  test("dated events stay chronological and sequence words cannot contradict dates", async () => {
    const { all } = await scriptPrompts();
    for (const p of all) {
      expect(p).toMatch(/concrete dated events must stay in chronological order/);
      expect(p).toMatch(/Never use "then", "later", "after", "next", "a few days later" or similar sequence words if the following event actually happened earlier/);
      expect(p).toMatch(/make the time jump explicit/);
    }
  });

  test("weak control or status language is not upgraded into arrest or custody", async () => {
    const { all } = await scriptPrompts();
    for (const p of all) {
      expect(p).toMatch(/"guarded", "questioned", "restricted", "remained aboard" or "under observation"/);
      expect(p).toMatch(/detained, arrested, imprisoned or held in custody/);
      expect(p).toMatch(/explicitly supports that exact status/);
    }
  });

  test("technical findings keep measurement, location and certainty; suspicion stays attributed; no 'carrying radiation'", async () => {
    const { all } = await scriptPrompts();
    for (const p of all) {
      expect(p).toMatch(/exact object of measurement, the location and the level of certainty/);
      expect(p).toMatch(/"Detected probable X near Y" must not become "carrying X", "contained X" or "proved X"/);
      expect(p).toMatch(/Do not add general scientific significance/);
      expect(p).toMatch(/Suspicion of a weapon or cargo stays attributed as suspicion/);
      expect(p).toMatch(/"carrying radiation"/);
    }
  });

  test("the single final audit checks chronology, terminology and scientific precision", async () => {
    const { audit } = await scriptPrompts();
    // Still exactly one audit call.
    expect(respond.mock.calls.filter((c) => (c[0] as any).schemaName === "script_audit")).toHaveLength(1);
    expect(audit).toMatch(/SILENT CHECKLIST/);
    for (const item of [
      /every factual statement is supported/,
      /terminology attribution/,
      /explicitly compare every date and the order of every dated event against the fact sheet/,
      /sequence words/,
      /actor\/action matching/,
      /legal\/control-status wording/,
      /technical\/scientific precision/,
      /uncertainty and attribution/,
      /no unsupported causal statement/,
      /no contradiction between the opening and the ending/,
    ]) {
      expect(audit).toMatch(item);
    }
    // Still a fidelity pass, not a creative rewrite.
    expect(audit).toMatch(/NOT another creative rewrite/);
    expect(audit).toMatch(/preserving the story voice/);
  });

  test("Long aims for 900-1100 words through unused verified material, not padding", async () => {
    const { long, audit } = await scriptPrompts();
    expect(long).toMatch(/roughly 900-1100 spoken words when the verified research contains enough concrete material/);
    expect(long).toMatch(/use additional VERIFIED moments, sequence, explanation and consequences already present in the research/);
    expect(long).toMatch(/Never repeat a point, restate the premise, add generic context, speculate, or stretch sentences merely to reach length/);
    expect(long).toMatch(/Factual density beats target length/);
    expect(long).toMatch(/under about 850 words, confirm that no useful verified fact or moment was omitted/);
    expect(audit).toMatch(/~900-1100 word film/);
    expect(audit).not.toMatch(/950-1200/);
  });
});
