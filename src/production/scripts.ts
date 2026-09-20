import { config } from "../server/config.ts";
import { respondJson } from "../providers/openai.ts";
import type { Story } from "../types.ts";
import type { ResearchPackage } from "./pipelineTypes.ts";
import { paulBunyanScripts } from "./fixtures/paulBunyan.ts";

export interface Scripts {
  long: string;
  short: string;
}

export async function writeScripts(story: Story, research: ResearchPackage): Promise<Scripts> {
  if (story.slug === "paul-bunyan") return paulBunyanScripts;
  if (config.mode !== "live") return mockScripts(story, research);

  // Two separate writes: the long and the short are written for their format.
  const [long, short] = await Promise.all([
    respondJson<{ script: string }>({ instructions: LONG_INSTRUCTIONS, input: input(story, research), schemaName: "script", schema: SCRIPT_SCHEMA }),
    respondJson<{ script: string }>({ instructions: SHORT_INSTRUCTIONS, input: input(story, research), schemaName: "script", schema: SCRIPT_SCHEMA }),
  ]);
  return { long: long.script.trim(), short: short.script.trim() };
}

function input(story: Story, r: ResearchPackage): string {
  const moments = r.moments.map((m, i) => `${i + 1}. ${m.title} — ${m.detail}`).join("\n");
  const sources = r.sources.map((s) => `- ${s.title}: ${s.note}`).join("\n");
  return `TITLE: ${story.title}\nYEAR: ${story.year}\nPLACE: ${story.place}\nHOOK: ${story.hook}\n\nSUMMARY:\n${r.summary}\n\nMOMENTS:\n${moments}\n\nEVIDENCE:\n${sources}`;
}

// Deterministic offline script from the research, for mock runs of any story.
function mockScripts(story: Story, r: ResearchPackage): Scripts {
  const long = [
    story.hook,
    r.summary,
    ...r.moments.map((m) => `${m.detail} It is one of the turning points in the story of ${story.title}.`),
    `That is why ${story.title} is remembered — a true story that sounds invented, and yet every strange part of it happened.`,
  ].join("\n\n");

  const first = r.moments[0]?.detail ?? r.summary;
  const last = r.moments.at(-1)?.detail ?? "";
  const short = `${story.hook} ${first} ${last} It really happened, in ${story.year}, in ${story.place}.`;
  return { long, short };
}

const LONG_INSTRUCTIONS = `Write the narration for a 6-10 minute PastBriefly documentary. Real documentary structure: a strong opening hook, orientation, causal development, escalation or reversal, the outcome, and a short consequence or epilogue. Warm, precise, factual — never breathless. Only the spoken narration, no headings, stage directions or citations. Base everything on the supplied facts; invent nothing. Return strict JSON { "script": string }.`;

const SHORT_INSTRUCTIONS = `Write the narration for a 45-60 second PastBriefly Short. Immediate premise, a fast causal explanation, and a real payoff. It must be written for the format — not a crop of the long film. Only the spoken narration. Base everything on the supplied facts; invent nothing. Return strict JSON { "script": string }.`;

const SCRIPT_SCHEMA = { type: "object", additionalProperties: false, required: ["script"], properties: { script: { type: "string" } } };
