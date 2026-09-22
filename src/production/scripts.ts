import { config } from "../server/config.ts";
import { respondJson } from "../providers/openai.ts";
import type { Story } from "../types.ts";
import type { ResearchPackage } from "./pipelineTypes.ts";
import { paulBunyanScripts } from "./fixtures/paulBunyan.ts";

export interface Scripts {
  long: string;
  short: string;
}

// One format's narration. Long and Short are separate paid writes so a resume
// never repeats a format that already succeeded.
export async function writeScript(story: Story, research: ResearchPackage, kind: "long" | "short"): Promise<string> {
  if (story.slug === "paul-bunyan") return paulBunyanScripts[kind];
  if (config.mode !== "live") return mockScripts(story, research)[kind];

  const instructions = kind === "long" ? LONG_INSTRUCTIONS : SHORT_INSTRUCTIONS;
  const r = await respondJson<{ script: string }>({ instructions, input: input(story, research), schemaName: "script", schema: SCRIPT_SCHEMA });
  return r.script.trim();
}

export async function writeScripts(story: Story, research: ResearchPackage): Promise<Scripts> {
  const [long, short] = await Promise.all([writeScript(story, research, "long"), writeScript(story, research, "short")]);
  if (story.slug === "paul-bunyan" || config.mode !== "live") return { long, short };
  return auditScripts(story, research, { long, short });
}

// One combined fidelity audit over both finished drafts. Not a creative rewrite:
// it removes or corrects any statement not explicitly supported by the final
// verified research (invented actions, sensory details, emotions, motives,
// inferred actors, altered dates or sequence, or unearned certainty) while
// preserving the plain-English storytelling and the Long/Short format
// differences. The conservative script charge covers this third call. Exported so
// the production job (runJob) runs the exact same audit as the benchmark path,
// rather than duplicating the prompt; callers gate it on live mode themselves.
export async function auditScripts(story: Story, research: ResearchPackage, drafts: Scripts): Promise<Scripts> {
  const r = await respondJson<Scripts>({
    instructions: SCRIPT_AUDIT_INSTRUCTIONS,
    input: auditInput(story, research, drafts),
    schemaName: "script_audit",
    schema: SCRIPTS_AUDIT_SCHEMA,
  });
  return { long: r.long.trim(), short: r.short.trim() };
}

// The fact sheet is the factual spine handed to every write and to the audit:
// each date, actor, location, sequence and attribution here is fixed.
function factSheet(r: ResearchPackage): string {
  if (!r.facts?.length) return "FACT SHEET:\n(none provided)";
  const facts = r.facts.map((f, i) => `${i + 1}. ${f.fact} [${f.sourceTitle}]`).join("\n");
  return `FACT SHEET (the factual spine - keep every date, actor, sequence and attribution exactly as written):\n${facts}`;
}

function input(story: Story, r: ResearchPackage): string {
  const moments = r.moments.map((m, i) => `${i + 1}. ${m.title} - ${m.detail}`).join("\n");
  const sources = r.sources.map((s) => `- ${s.title}: ${s.note}`).join("\n");
  return `TITLE: ${story.title}\nYEAR: ${story.year}\nPLACE: ${story.place}\nHOOK: ${story.hook}\n\nSUMMARY:\n${r.summary}\n\n${factSheet(r)}\n\nMOMENTS:\n${moments}\n\nEVIDENCE:\n${sources}`;
}

function auditInput(story: Story, r: ResearchPackage, drafts: Scripts): string {
  const moments = r.moments.map((m, i) => `${i + 1}. ${m.title} - ${m.detail}`).join("\n");
  const sources = r.sources.map((s) => `- ${s.title}: ${s.note}`).join("\n");
  return `TITLE: ${story.title}\nYEAR: ${story.year}\nPLACE: ${story.place}\nHOOK: ${story.hook}\n\nFINAL VERIFIED RESEARCH\n\nSUMMARY:\n${r.summary}\n\n${factSheet(r)}\n\nMOMENTS:\n${moments}\n\nEVIDENCE:\n${sources}\n\nDRAFT LONG SCRIPT:\n${drafts.long}\n\nDRAFT SHORT SCRIPT:\n${drafts.short}`;
}

// Deterministic offline script from the research, for mock runs of any story.
function mockScripts(story: Story, r: ResearchPackage): Scripts {
  const long = [
    story.hook,
    r.summary,
    ...r.moments.map((m) => m.detail),
    `It really happened, in ${story.year}, in ${story.place}.`,
  ].join("\n\n");

  const first = r.moments[0]?.detail ?? r.summary;
  const last = r.moments.at(-1)?.detail ?? "";
  const short = `${story.hook} ${first} ${last} It really happened, in ${story.year}, in ${story.place}.`;
  return { long, short };
}

const LONG_INSTRUCTIONS = `You are the long-form script director for PastBriefly: "true historical stories that sound made up." Write the spoken narration for a roughly 7-9 minute film, about 950-1200 spoken words. A viewer with ZERO historical knowledge must understand every sentence the first time they hear it. Explain first, name second.

OPENING: explain the unbelievable premise immediately. The first two or three sentences must tell us what actually happened and why it is strange or dangerous, within the first ten seconds. Do not open with background history, a date dump, or jargon. Prefer "In 1981, Sweden found a Soviet submarine stuck on rocks near one of its naval bases. The submarine was called U 137." over "In October 1981, the Soviet Whiskey-class submarine S-363, known in Sweden as U 137...". Use historical names, classes or nicknames only after the viewer already knows what they refer to.

MOMENTUM: once the opening premise is established, MOVE THE STORY FORWARD. Do not restate the premise in a second orientation paragraph, explain the hook again, or repeat why the event mattered before continuing the chronology. Go from the hook straight to the next event.

CLARITY: the zero-context viewer must follow every sentence. Usually one sentence carries one main idea. Use natural spoken English, mostly short and medium sentences. Explain specialist terms in plain words before, or instead of, naming them.

STRUCTURE: build a causal story, not a history essay - premise, then the immediate problem, the explanation, the escalation, a new complication or reveal, the outcome, and the specific aftermath. Each section should naturally raise the next question. Simple curiosity transitions are fine ("Why was it there?", "Then Sweden found something stranger.", "Sweden refused."), but do not overuse rhetorical questions and do not make every line dramatic.

STYLE: warm, precise, confident, conversational, factual, restrained, and slightly dry when the facts themselves are absurd. Avoid academic prose, Wikipedia-style summary, documentary cliches, breathless hype, fake suspense, "little did they know" writing, abstract geopolitical filler, unnecessary adjectives, and phrases that sound like chapter headings. Never narrate section labels like "International Diplomatic Tension" or "Resolution and Soviet Withdrawal" - just say what happened.

CONCRETE OVER ABSTRACT: prefer concrete sourced events to generic documentary-summary sentences. Do not write lines like "The incident attracted international attention.", "Tensions steadily grew.", "The event left a deep impression.", "The incident highlighted..." or "The event demonstrated...". If a concrete sourced event can communicate the same thing, narrate the event: people doing things, governments making decisions, ships moving, troops arriving, questions being asked, measurements being taken, demands being made.

NO SPECULATIVE RHETORIC: do not add rhetorical arguments such as "Why else would...", "What else could it have been?", "Clearly..." or "Obviously...". Do not, in your own voice, call an actor hostile, deceptive, embarrassed, reckless or the like. Attribute every suspicion or interpretation to whoever held it: "Swedish officials suspected...", "The Soviet crew said...", "Investigators questioned whether...". Facts first.

ENDING: do not finish with a generic essay about history, humanity, geopolitics, sovereignty or lessons for the modern world. Land on the specific strange story, so the last lines remind the viewer why it sounded made up in the first place.

LENGTH: the 950-1200 word range is guidance, not a target to pad toward. Do not repeat a point, restate the premise, or add generic context just to reach it. Earn any added length only through concrete sourced events, useful explanation, specific escalation and important aftermath.

FACTS: use only the supplied research. The FACT SHEET is the factual spine - you may explain and connect those facts naturally, but never change a date, actor, sequence, attribution or level of certainty. Do not invent dialogue, motivations, scenes or false certainty. Where the evidence is uncertain, say so honestly.

SELF-CHECK: before returning, silently confirm that no unsupported inference was added, that every suspicion stays attributed to whoever held it, that no loaded adjectives were invented (such as "embarrassed" or "reckless"), that no "Imagine...", "how could...", or "why else..." rhetorical devices slipped in, that abstract documentary-summary language was avoided wherever a concrete event exists, and that the story moves forward rather than restating the premise. FACT FIDELITY: also confirm that the script introduces no factual claim that is not explicitly supported by the audited research - do not invent fuel state, emotions, motives, reactions, actions, military status, dialogue or sensory details - and that no actor was inferred where the research wording is ambiguous (if the research says someone "was removed from command", do not guess who removed them). Dates, attribution, uncertainty, actor and sequence must stay exactly as the research has them, so the meaning does not change. Fix any that fail, then return only the requested JSON.

OUTPUT: only the spoken narration - no headings, chapter labels, stage directions or citations. Return strict JSON { "script": string }.`;

const SHORT_INSTRUCTIONS = `You are the Short script director for PastBriefly: "true historical stories that sound made up." Write the spoken narration for a fast PastBriefly Short, about 105-130 spoken words. This is written for the Short format - NOT a summary or a crop of the long script. A viewer with ZERO historical knowledge must understand every sentence the first time they hear it. Explain first, name second.

OPENING: the bizarre premise must be clear in the first one or two sentences. Start directly with what happened - the historical fact is the hook. Do not open with generic YouTube constructions like "Imagine...", "Picture this...", "You won't believe..." or "What if I told you...". Do not start with background, historical context, ship classifications, formal event names, or a date unless the date itself is the surprising part. Aim for the clarity of "In 1981, Sweden discovered a Soviet submarine stuck on rocks near one of its biggest naval bases. The Soviets wanted it back. Sweden had questions."

MOMENTUM: once the premise is clear, move straight to the next event. Do not restate the premise or explain again why it mattered before continuing.

STRUCTURE: a clean mini-story - premise, then a complication, an escalation or reveal, and a payoff. Every sentence must earn its place.

CLARITY: one main idea per sentence, natural spoken English, no unexplained jargon, no abstract section language, no bare list of facts, no conclusion essay.

PACE: move quickly without sounding frantic, using concrete actions and consequences. Prefer "Swedish troops surrounded the submarine." over "The incident rapidly escalated into a significant diplomatic confrontation." Do not add speculative rhetoric ("Why else would...", "Clearly...", "Obviously...") and do not, in your own voice, call an actor hostile, deceptive, embarrassed or reckless - attribute suspicions to whoever held them.

ENDING: end on the specific payoff or absurdity of the story. Do not end with "It remains an important reminder...", "This incident demonstrated..." or "History would remember...".

LENGTH: 105-130 words is guidance, not a target to pad toward. Do not repeat or add generic context to reach it.

FACTS: use only the supplied research - no invention or exaggeration. The FACT SHEET is the factual spine: connect those facts naturally but never change a date, actor, sequence, attribution or level of certainty.

SELF-CHECK: before returning, silently confirm that no unsupported inference was added, that every suspicion stays attributed to whoever held it, that no loaded adjectives were invented (such as "embarrassed" or "reckless"), that no "Imagine...", "how could...", or "why else..." rhetorical devices slipped in, that abstract documentary-summary language was avoided wherever a concrete event exists, and that the story moves forward rather than restating the premise. FACT FIDELITY: also confirm that the script introduces no factual claim that is not explicitly supported by the audited research - do not invent fuel state, emotions, motives, reactions, actions, military status, dialogue or sensory details - and that no actor was inferred where the research wording is ambiguous (if the research says someone "was removed from command", do not guess who removed them). Dates, attribution, uncertainty, actor and sequence must stay exactly as the research has them, so the meaning does not change. Fix any that fail, then return only the requested JSON.

OUTPUT: only the spoken narration - no headings, stage directions or citations. Return strict JSON { "script": string }.`;

const SCRIPT_AUDIT_INSTRUCTIONS = `You are the FINAL SCRIPT FIDELITY AUDIT for PastBriefly. You are given a story's title, hook, year and place, the FINAL verified research package, and two finished draft scripts (Long and Short). Return corrected Long and Short scripts in the SAME shape: { "long": string, "short": string }.

This is NOT another creative rewrite, and it is NOT an editor's pass. You are a fact checker, not an editor. Its ONLY job is to CORRECT OR REMOVE UNSUPPORTED FACTS. Keep the plain-English storytelling, the causal flow, the title clarity and the existing Short/Long format differences. Do not turn the scripts back into academic prose, and do not restyle sentences that are already accurate.

THE RULE: every factual statement in both scripts must be explicitly supported by the FINAL verified research package. The package includes a FACT SHEET - its factual spine - and any date, actor, sequence, attribution or certainty stated there is fixed. If a detail is not in the final research, it does not belong in the script. Conversely, if a sentence IS factually supported, leave it alone - make a tiny wording change only where one is needed for factual fidelity, and otherwise do not touch it.

Correct or remove: invented actions, invented sensory details, invented emotions, invented motives, invented military behavior, invented dialogue, invented physical condition, inferred actors, altered dates, altered sequence, and any certainty stronger than the research supports.

ACTORS, DATES, SEQUENCE: never change who performed an action, when it happened, or the order of events away from the research. If the research says "Swedish tugs refloated the submarine", the script may NOT say "Soviet tugs refloated the submarine". Keep separate events separate - do not merge different dates or actions.

NO INVENTED COLOR: if the research does not mention it, the script may not add it. If the research does not mention radio silence, the script may not say "the vessel tried to signal radio silence". Do not add "harmless color" just because it sounds cinematic - if a detail is not in the final research package, remove it.

PRESERVE SUPPORTED DETAIL AND STRUCTURE (critical): removing unsupported material will naturally shorten a script, but trimming SUPPORTED material to make a script shorter or tighter is NOT your job. You must preserve all supported factual detail, all causal explanation, all useful context, all supported transitions, and the draft's overall structure and approximate length. Do NOT summarize or condense the scripts, do NOT rewrite them shorter merely for elegance, do NOT remove supported detail just because it is non-essential, and do NOT turn the Long into a condensed overview. The Long must stay a full ~950-1200 word film - do not compress it toward the Short - and the Short must stay a fast, concise 105-130 word piece.

Preserve everything that is already supported: plain-English storytelling, causal flow, title clarity, and the Short/Long format differences (the Long stays a ~950-1200 word film, the Short stays a fast 105-130 word piece). Only change what fidelity requires.

Return only the two corrected scripts as strict JSON { "long": string, "short": string }.`;

const SCRIPT_SCHEMA = { type: "object", additionalProperties: false, required: ["script"], properties: { script: { type: "string" } } };
const SCRIPTS_AUDIT_SCHEMA = { type: "object", additionalProperties: false, required: ["long", "short"], properties: { long: { type: "string" }, short: { type: "string" } } };
