import { respondJson } from "../providers/openai.ts";
import { sampledFrames, type SampledFrame } from "../render/contactSheet.ts";
import type { FinalQaIssue, Story } from "../types.ts";
import type { ResearchPackage } from "./pipelineTypes.ts";
import { plainDashes, splitSentences } from "./text.ts";
import type { PlannedShot } from "./visuals.ts";

// ---------------------------------------------------------------------------
// Final-film QC: a read-only review of ONE finished film by two specialists,
// combined locally:
// - FACTUAL AUDIT: the final narration against the sources, with web search
//   enabled, and an explicit check of every sentence that uses high-risk causal
//   wording. PB4's own research is context, never causal authority. No image.
// - VISUAL-FAMILY AUDIT: the ACTUAL rendered mp4 as evenly sampled frames, each
//   its own image with its own label (cell, time, slot, asset, presentation),
//   plus exact sampled reuse and asset-use evidence. It first observes every
//   cell, then lists the visual motifs that repeat (they may overlap; asset ids
//   are not visual families), then decides. No web. It runs on
//   FINAL_VISUAL_QA_MODEL at high reasoning effort; the factual audit keeps the
//   configured text model.
// Exactly two reviewer calls per film, no summarizer call, no retry. It answers
// PASS or HUMAN_REVIEW and repairs nothing. Production (Stage 14B) calls each
// specialist on its own, so every result is saved as soon as it exists.
// It does not judge motion, audio, pronunciation, subtitles or cut timing:
// sampled still frames cannot show them.
//
// Stage 14A's single broad reviewer passed both Film #4 films: it echoed PB4's
// own causal synthesis, and it read 19 distinct asset ids as visual variety.
// ---------------------------------------------------------------------------

// What the final edit says about each slot, enough to explain visual reuse.
export type FinalShot = Pick<PlannedShot, "index" | "assetId" | "presentation" | "framing" | "truth" | "startSec" | "endSec">;

export interface FinalFilmInput {
  story: Pick<Story, "title" | "year" | "place">;
  kind: "long" | "short";
  script: string; // the final narration of THIS film, exactly as published
  research: Pick<ResearchPackage, "summary" | "moments" | "facts" | "sources">;
  videoPath: string; // the final rendered mp4
  durationSec: number;
  shots: FinalShot[]; // the final saved edit
}

// The small public result.
export interface FinalFilmQaResult {
  decision: "PASS" | "HUMAN_REVIEW";
  summary: string;
  factualIssues: { reason: string; text: string }[]; // text: a short fragment of the narration
  visualIssues: { reason: string }[];
}

// One structured Responses call; respondJson in live runs, injected in tests.
export type FinalFilmReviewer = (opts: Parameters<typeof respondJson>[0]) => Promise<unknown>;

export interface AssetUse {
  assetId: string;
  truth: FinalShot["truth"];
  slots: number[];
  seconds: number;
  returns: number; // times it comes back after at least one other asset
}

const pad = (n: number) => String(n).padStart(2, "0");
const clock = (sec: number) => `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, "0")}`;
const round1 = (n: number) => Math.round(n * 10) / 10;

// Exact per-asset use in the final edit, in order of first appearance.
export function assetUse(shots: FinalShot[]): AssetUse[] {
  const ordered = [...shots].sort((a, b) => a.index - b.index);
  const byId = new Map<string, AssetUse>();
  ordered.forEach((s, i) => {
    const use = byId.get(s.assetId) ?? { assetId: s.assetId, truth: s.truth, slots: [], seconds: 0, returns: 0 };
    if (use.slots.length && ordered[i - 1].assetId !== s.assetId) use.returns++;
    use.slots.push(s.index);
    use.seconds += s.endSec - s.startSec;
    byId.set(s.assetId, use);
  });
  return [...byId.values()].map((u) => ({ ...u, seconds: round1(u.seconds) }));
}

// The asset-use evidence as text: every asset, then the most used by screen time.
export function assetUseText(shots: FinalShot[], durationSec: number): string {
  const uses = assetUse(shots);
  const share = (sec: number) => Math.round((100 * sec) / durationSec);
  const line = (u: AssetUse) =>
    `${u.assetId} (${u.truth}): ${u.slots.length} slot${u.slots.length === 1 ? "" : "s"} [${u.slots.map(pad).join(", ")}], ${u.seconds}s = ${share(u.seconds)}% of runtime${u.returns ? `, returns ${u.returns} time${u.returns === 1 ? "" : "s"} after other shots` : ""}`;
  const most = [...uses].sort((a, b) => b.seconds - a.seconds).slice(0, 5);
  return [
    `${uses.length} distinct assets across ${shots.length} slots.`,
    ...uses.map(line),
    `MOST USED BY SCREEN TIME: ${most.map((u) => `${u.assetId} ${u.seconds}s (${share(u.seconds)}%)`).join("; ")}`,
  ].join("\n");
}

// Which slot and asset is on screen at a time; the last slot owns the film's tail.
function onScreen(shots: FinalShot[], t: number): FinalShot | undefined {
  const ordered = [...shots].sort((a, b) => a.index - b.index);
  return ordered.find((s) => t >= s.startSec && t < s.endSec) ?? ordered[ordered.length - 1];
}

// The slot and asset each named cell sampled. `times` are the film's cell times
// (cellTimes), so a cell maps to exactly the frame the reviewer saw.
export function cellSlots(shots: FinalShot[], times: number[], cells: number[]): { cell: number; slot: number; assetId: string }[] {
  return cells.flatMap((cell) => {
    const s = cell >= 1 && cell <= times.length ? onScreen(shots, times[cell - 1]) : undefined;
    return s ? [{ cell, slot: s.index, assetId: s.assetId }] : [];
  });
}

// The assets a visual issue's cells show, once each, in cell order.
export function issueAssets(shots: FinalShot[], times: number[], cells: number[]): string[] {
  return [...new Set(cellSlots(shots, times, cells).map((c) => c.assetId))];
}

export interface SampledReuse {
  assetId: string; // one saved picture
  cells: { cell: number; presentation: FinalShot["presentation"] }[];
}

// Sampled cells that show the same saved picture (one asset), with the
// presentation each shows: the same presentation is the identical frame, a
// different one is another crop of the same picture. Only pictures sampled at
// least twice, in order of first cell. Supporting evidence for the visual
// specialist, never a verdict by itself.
export function sampledReuse(shots: FinalShot[], times: number[]): SampledReuse[] {
  const byAsset = new Map<string, SampledReuse["cells"]>();
  times.forEach((t, i) => {
    const s = onScreen(shots, t);
    if (s) byAsset.set(s.assetId, [...(byAsset.get(s.assetId) ?? []), { cell: i + 1, presentation: s.presentation }]);
  });
  return [...byAsset].filter(([, cells]) => cells.length > 1).map(([assetId, cells]) => ({ assetId, cells }));
}

// One reuse line: every cell with its presentation, then which cells show the
// identical presentation. Different crops are never called the same presentation.
export function sampledReuseLine(r: SampledReuse): string {
  const byPresentation = new Map<string, number[]>();
  for (const c of r.cells) byPresentation.set(c.presentation, [...(byPresentation.get(c.presentation) ?? []), c.cell]);
  const same = [...byPresentation].filter(([, cells]) => cells.length > 1);
  const identical =
    byPresentation.size === 1
      ? `all the same presentation (${r.cells[0].presentation})`
      : same.length
        ? `same presentation: ${same.map(([p, cells]) => `${p} in cells ${cells.join(", ")}`).join("; ")}; the others are different crops of the same picture`
        : "each a different crop of the same picture";
  return `- ${r.assetId}: cells ${r.cells.map((c) => `${c.cell} (${c.presentation})`).join(", ")} - ${identical}`;
}

// The label placed immediately before one sampled frame's image. A detail
// crop's framing is its presentation, so framing is named only for a base.
export function frameLabel(shots: FinalShot[], cell: number, t: number): string {
  const s = onScreen(shots, t);
  const shown = s ? [`slot ${pad(s.index)}`, `asset ${s.assetId}`, `presentation ${s.presentation}`, ...(s.framing !== s.presentation ? [`framing ${s.framing}`] : [])] : [];
  return [`CELL ${cell}`, clock(t), ...shown].join(" | ");
}

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const clean = (v: unknown) => (typeof v === "string" ? plainDashes(v.trim()) : "");
const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").replace(/[.!?"']+$/, "").trim();

// ---------------------------------------------------------------------------
// Causal-risk extraction: deterministic, sentence level, no model.
// ---------------------------------------------------------------------------

// High-risk causal wording. "forced" / "forcing" only: "force(s)" is mostly the
// noun ("Army Air Forces"). A false positive only costs one explicit check.
const CAUSAL_CUES = /\b(because|due to|caus(?:e|es|ed|ing)(?: by)?|le(?:d|ads?|ading) to|result(?:s|ed|ing)? in|therefore|prompt(?:s|ed|ing)|forc(?:ed|ing)|in favou?r of|contribut(?:e|es|ed|ing) to)\b/gi;

// A split after an initialism ("U.S.") or a title ("Dr.") is not a sentence end.
const ABBREVIATION = /(?:\b(?:[A-Z]\.)+|\b(?:Mr|Mrs|Ms|Dr|St|Jr|Sr|Gen|Lt|Col|Capt|Sgt|Adm|Maj|No|Mt|Ft)\.)$/;

export function narrationSentences(script: string): string[] {
  const out: string[] = [];
  for (const s of splitSentences(script)) {
    if (out.length && ABBREVIATION.test(out[out.length - 1])) out[out.length - 1] += ` ${s}`;
    else out.push(s);
  }
  return out;
}

export interface CausalClaim {
  text: string; // the exact narration sentence
  cues: string[]; // the causal wording found in it, lower case
}

// Every distinct narration sentence carrying high-risk causal wording, in order.
export function causalClaims(script: string): CausalClaim[] {
  const seen = new Set<string>();
  const claims: CausalClaim[] = [];
  for (const text of narrationSentences(script)) {
    const cues = [...new Set([...text.matchAll(CAUSAL_CUES)].map((m) => m[1].toLowerCase()))];
    if (!cues.length || seen.has(text)) continue;
    seen.add(text);
    claims.push({ text, cues });
  }
  return claims;
}

// ---------------------------------------------------------------------------
// 1. FINAL FACTUAL AUDIT
// ---------------------------------------------------------------------------

export type CausalVerdict = "SUPPORTED_DIRECTLY" | "OVERSTATED" | "UNCERTAIN";
const CAUSAL_VERDICTS: CausalVerdict[] = ["SUPPORTED_DIRECTLY", "OVERSTATED", "UNCERTAIN"];

export interface CausalCheck {
  text: string;
  verdict: CausalVerdict;
  reason: string;
  evidenceUrls: string[];
}

export interface FactualAudit {
  decision: "PASS" | "HUMAN_REVIEW";
  summary: string;
  causalChecks: CausalCheck[];
  issues: { reason: string; text: string }[];
}

export function factualPayload(input: FinalFilmInput, claims: CausalClaim[]): string {
  const { story, kind, research } = input;
  return [
    `STORY: ${story.title} (${story.year}, ${story.place})`,
    `FILM: ${kind.toUpperCase()}, ${round1(input.durationSec)}s. The narration below is final, exactly as published.`,
    "",
    "FINAL NARRATION (exactly as published):",
    '"""',
    input.script.trim(),
    '"""',
    "",
    `CAUSAL CLAIMS REQUIRING EXPLICIT VERIFICATION (${claims.length}):`,
    ...(claims.length
      ? claims.map((c, i) => `${i + 1}. ${c.text}\n   (causal wording: ${c.cues.map((q) => `"${q}"`).join(", ")})`)
      : ["None found. causalChecks must be []."]),
    "",
    "PB4 SAVED RESEARCH - CONTEXT, NOT CAUSAL AUTHORITY (written by PastBriefly itself; it may already contain its own synthesis or causal compression):",
    `Summary: ${research.summary}`,
    "Moments (contextual leads):",
    ...research.moments.map((m) => `- ${m.title}: ${m.detail}`),
    "Facts (contextual leads):",
    ...research.facts.map((f) => `- ${f.fact} [${f.sourceTitle} - ${f.sourceUrl}]`),
    "",
    "SOURCES (check what these actually say; notes are PB4's own):",
    ...research.sources.map((s) => `- ${s.title} - ${s.url}${s.note ? ` (PB4 note: ${s.note})` : ""}`),
    "",
    'Return JSON { "causalChecks": [{ "text", "verdict", "reason", "evidenceUrls" }], "issues": [{ "reason", "text" }], "decision", "summary" }.',
  ].join("\n");
}

export const FACTUAL_AUDIT_INSTRUCTIONS = `You are the final FACTUAL auditor for PastBriefly ("true historical stories that sound made up"). One film is finished and every earlier QA stage has passed. You decide one thing: does the FINAL narration, exactly as published, state something the evidence does not support - above all, a causal claim stronger than the evidence? You see no images and judge nothing visual.

PB4'S SAVED RESEARCH IS CONTEXT, NOT CAUSAL AUTHORITY
The research package (summary, moments, facts, source notes) was written by PastBriefly itself, earlier in this same production. It may already contain its own synthesis or causal compression. For ordinary concrete facts (dates, places, names, quantities, sequence) it is strong context. For a STRONG CAUSAL CLAIM it is NOT authority: never mark a causal claim supported merely because the same causal interpretation already appears in PB4's summary, facts, moments or source notes. Independently assess what the underlying sources and fresh web evidence directly say about that relationship. The source URLs and web search are available for exactly this reason: for every causal claim, use web search to check what the best sources actually say, rather than echoing PB4's saved synthesis.

CAUSAL COMPRESSION RULE
A source saying that factor X existed, was increasingly important, coincided with the decision, contributed to it, was one concern among others, or competed for resources does NOT by itself support narration saying "because of X", "due to X", "caused by X", "X led to", "cancelled in favor of X" or "X caused the decision". Strong wording needs evidence for that strong relationship. Multiple or contributing causes are not an exclusive or direct cause: when the best evidence gives multiple material reasons, uncertainty, or X only as a contributing factor, narration that collapses them into one exclusive or simple cause is OVERSTATED, even when every date and name in the sentence is right. "In favor of X" is strong replacement and causal language: it says X displaced the thing and was the reason it ended. Keep apart documented fact, attribution, contributing context, inference, and direct causation.

CAUSAL CLAIMS REQUIRING EXPLICIT VERIFICATION
The input lists, mechanically, every narration sentence that uses high-risk causal wording. Return exactly one causalChecks entry per listed sentence, in the listed order, with "text" copied EXACTLY as listed (same characters, nothing added or removed, without the number or the cue note). Verdicts:
- SUPPORTED_DIRECTLY: the underlying sources or fresh web evidence directly establish the relationship at the strength the sentence states.
- OVERSTATED: the evidence supports a weaker relationship than the sentence states (context, contribution, coincidence, one of several reasons).
- UNCERTAIN: the evidence is disputed, thin, or does not settle the relationship.
Mechanical detection can list a sentence whose cue is not really causal (for example "a forced landing"); if that sentence is otherwise accurate it is SUPPORTED_DIRECTLY and the reason says so. "reason": what the evidence actually says about the relationship. "evidenceUrls": the full http(s) URLs you actually relied on, at least one per check. If the list is empty, causalChecks is [].

OTHER FACTUAL ISSUES
Also check the rest of the narration: dates, places, people and organizations, chronology, quantities and technical claims, attribution (who said or claimed what), and disputed points stated as settled. Flag only concrete errors.

DECIDE (after the checks)
- PASS: every causal check is SUPPORTED_DIRECTLY and issues is empty.
- HUMAN_REVIEW: at least one issue. Every OVERSTATED or UNCERTAIN check needs its own issue whose text is copied from that sentence (the whole sentence or a short fragment of it).
Each issue gives a reason (what is wrong and what the evidence supports) and text: a SHORT fragment copied from the narration that identifies the claim, not a rewrite. Do not invent defects. Do not rewrite the film or suggest edits. No ratings, no scores, no generic advice. Use plain hyphens only.

Out of scope - do not judge: visuals, motion, audio, pronunciation, voice delivery, music, subtitles, cut timing.

Return strict JSON { "causalChecks": [{ "text", "verdict", "reason", "evidenceUrls" }], "issues": [{ "reason", "text" }], "decision": "PASS" | "HUMAN_REVIEW", "summary": "<one or two plain sentences>" }.`;

// Property order is generation order: the checks and issues come before the verdict.
export const FACTUAL_AUDIT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["causalChecks", "issues", "decision", "summary"],
  properties: {
    causalChecks: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["text", "verdict", "reason", "evidenceUrls"],
        properties: {
          text: { type: "string" },
          verdict: { type: "string", enum: CAUSAL_VERDICTS },
          reason: { type: "string" },
          evidenceUrls: { type: "array", items: { type: "string" } },
        },
      },
    },
    issues: {
      type: "array",
      items: { type: "object", additionalProperties: false, required: ["reason", "text"], properties: { reason: { type: "string" }, text: { type: "string" } } },
    },
    decision: { type: "string", enum: ["PASS", "HUMAN_REVIEW"] },
    summary: { type: "string" },
  },
} as const;

// Read the factual answer strictly against the causal claims it was given.
// Every claim must be checked exactly once with its exact text and at least one
// http(s) evidence URL; PASS needs every check SUPPORTED_DIRECTLY and no issues;
// HUMAN_REVIEW needs an issue; each OVERSTATED / UNCERTAIN check needs
// HUMAN_REVIEW and an issue whose text comes from that sentence.
export function readFactualAudit(raw: unknown, claims: string[]): FactualAudit {
  const reject = (why: string): never => {
    throw new Error(`Invalid Final-film factual audit: ${why}.`);
  };
  if (!isObject(raw)) return reject("answer is not an object");
  const { decision, summary, causalChecks, issues } = raw;
  if (decision !== "PASS" && decision !== "HUMAN_REVIEW") return reject(`decision ${JSON.stringify(decision ?? null)} is not PASS or HUMAN_REVIEW`);
  if (typeof summary !== "string") return reject("summary is missing");
  if (!Array.isArray(causalChecks) || !Array.isArray(issues)) return reject("causalChecks and issues must both be lists");

  const supplied = new Set(claims);
  const checked = new Set<string>();
  const checks = causalChecks.map((item, i): CausalCheck => {
    const n = `causal check ${i + 1}`;
    if (!isObject(item)) return reject(`${n} is not an object`);
    const text = typeof item.text === "string" ? item.text.trim() : "";
    if (!supplied.has(text)) return reject(`${n} text ${JSON.stringify(item.text ?? null)} is not one of the supplied causal sentences`);
    if (checked.has(text)) return reject(`${n} repeats ${JSON.stringify(text)}`);
    checked.add(text);
    if (!CAUSAL_VERDICTS.includes(item.verdict as CausalVerdict)) return reject(`${n} verdict ${JSON.stringify(item.verdict ?? null)} is not ${CAUSAL_VERDICTS.join(", ")}`);
    if (!clean(item.reason)) return reject(`${n} needs a reason`);
    const urls = Array.isArray(item.evidenceUrls) ? item.evidenceUrls.map((u) => (typeof u === "string" ? u.trim() : "")) : [];
    if (!urls.length || urls.some((u) => !/^https?:\/\/\S+$/.test(u))) return reject(`${n} needs at least one http(s) evidence URL and nothing else`);
    return { text, verdict: item.verdict as CausalVerdict, reason: clean(item.reason), evidenceUrls: urls };
  });
  const missing = claims.filter((c) => !checked.has(c));
  if (missing.length) reject(`no causal check for ${missing.map((c) => JSON.stringify(c)).join(", ")}`);

  const factual = issues.map((item, i) => {
    if (!isObject(item) || !clean(item.reason) || !clean(item.text)) return reject(`factual issue ${i + 1} needs a reason and a narration fragment`);
    return { reason: clean(item.reason), text: clean(item.text) };
  });
  const flagged = checks.filter((c) => c.verdict !== "SUPPORTED_DIRECTLY");
  if (decision === "PASS" && flagged.length) reject(`PASS cannot carry a ${flagged[0].verdict} causal check`);
  if (decision === "PASS" && factual.length) reject("PASS cannot carry issues");
  if (decision === "HUMAN_REVIEW" && !factual.length) reject("HUMAN_REVIEW needs at least one issue");
  for (const c of flagged) {
    const sentence = norm(c.text);
    if (!factual.some((f) => sentence.includes(norm(f.text)) || norm(f.text).includes(sentence))) reject(`${c.verdict} causal check ${JSON.stringify(c.text)} has no corresponding issue`);
  }
  return { decision, summary: clean(summary), causalChecks: checks, issues: factual };
}

// ---------------------------------------------------------------------------
// 2. FINAL VISUAL-FAMILY AUDIT
// Evidence first: one plain observation for EVERY cell, then the visual motifs
// that visibly repeat. Motifs may overlap (a frame can show a setting and a
// cross-cutting element), so a motif spread across the film is never hidden by
// an exclusive partition. Only then the verdict.
// ---------------------------------------------------------------------------

export interface CellObservation {
  cell: number;
  description: string;
}

// A repeated visual motif: at least two cells, and a cell may be in several.
export interface VisualFamily {
  name: string;
  description: string;
  cells: number[];
}

export interface VisualAudit {
  decision: "PASS" | "HUMAN_REVIEW";
  summary: string;
  cellObservations: CellObservation[];
  families: VisualFamily[];
  issues: { reason: string; cells: number[] }[];
}

export function visualPayload(input: FinalFilmInput, times: number[]): string {
  const { story, kind } = input;
  const cells = times.map((t, i) => {
    const s = onScreen(input.shots, t);
    return `Cell ${i + 1}: ${clock(t)}${s ? ` slot ${pad(s.index)} ${s.assetId}:${s.presentation} (${s.truth})` : ""}`;
  });
  const reuse = sampledReuse(input.shots, times);
  return [
    `STORY: ${story.title} (${story.year}, ${story.place})`,
    `FILM: ${kind.toUpperCase()}, ${round1(input.durationSec)}s. The sampled frames are the finished render.`,
    "",
    `SAMPLED FRAMES: ${times.length} separate images, one per cell, sampled evenly across the whole finished film and sent in chronological order (cell 1 first). Each image comes immediately after its own label "CELL <n> | <time> | slot <slot> | asset <id> | presentation <kind>" (a base also names its framing). Each cell's time and what the edit shows there:`,
    cells.join("\n"),
    "",
    "EXACT SAMPLED REUSE (cells that show the same saved picture, with the presentation each shows; the same presentation is the identical frame, a different one is another crop of the same picture; supporting evidence only, not a verdict):",
    ...(reuse.length ? reuse.map(sampledReuseLine) : ["None: no saved picture is sampled more than once."]),
    "",
    "ASSET USE (exact, from the final saved edit; supporting evidence only - asset ids are production identities, not visual families):",
    assetUseText(input.shots, input.durationSec),
    "",
    `Your cellObservations must describe every cell 1-${times.length} exactly once.`,
    'Return JSON { "cellObservations": [{ "cell", "description" }], "families": [{ "name", "description", "cells" }], "issues": [{ "reason", "cells" }], "decision", "summary" }.',
  ].join("\n");
}

export const VISUAL_AUDIT_INSTRUCTIONS = `You are the final VISUAL-FAMILY auditor for PastBriefly ("true historical stories that sound made up"). One film is finished and rendered, and every earlier QA stage has passed, including the per-asset checks. You decide one thing: does the finished film, seen as a whole, keep falling back on the same visual motifs often enough that a viewer is likely to experience it as recycled, monotonous or visually thin?

You receive the finished film as separate sampled frames, one image per cell, sampled evenly across the whole runtime and sent in chronological order. Each image comes immediately after its own label naming its cell number, time, slot, asset and presentation: that label, not the image's position, tells you which cell it is. You also receive the exact sampled reuse (cells that show the same saved picture) and exact asset-use metadata from the final edit. The cells are samples of the rendered film, evidence of what it looks like, not every frame.

ASSET IDS ARE NOT VISUAL FAMILIES
Asset ids are production identities, not proof of visual diversity. Several different asset ids may look nearly identical: for example, different assets can all be a similar podium-and-crowd scene, a similar vehicle on a road, or a similar close-up of a document. One asset may also appear in visually different crops. A high count of distinct asset ids, or a small share for every single asset, does NOT mean the film looks varied. What the cells visibly show is the primary evidence; the asset metadata only helps to locate cells and to notice where different ids look alike.
EXACT SAMPLED REUSE lists cells that show the same saved picture, with the presentation each shows: the same presentation is the identical frame, a different presentation is another crop of the same picture and may or may not look alike - judge that from the images. It is exact supporting evidence of a repeat, not a verdict: an exact repeat can be a deliberate callback, and a visual family can also join different assets that merely look alike.

STEP 1 - CELL OBSERVATIONS (every cell, before anything else)
Describe every cell exactly once, in order: "cell" is its number, "description" is the dominant visible scene or content in plain concrete words, plus any prominent element that runs across scenes (weather, lighting, an effect filling the frame). Examples of the kind of description wanted: "two people standing beside a damaged vehicle", "paper document on a desk", "ship moored at a harbor quay". Never an asset id, a truth type (archive, reconstruction, graphic) or a generic label such as "historical illustration". Look at each cell on its own: take its number from the label right before its image, and describe what is actually in that image.

STEP 2 - REPEATED VISUAL MOTIFS (built from the observations)
List only motifs that visibly REPEAT: a family needs at least two cells. Families MAY OVERLAP: one cell can belong to several, for example both "vehicle on a rural road" and "heavy rain". Use this to capture cross-cutting elements (a recurring effect, weather, colour or object that appears inside otherwise different scenes) as well as recurring scenes. List every cell where a motif is visible, so its real extent is shown. Group near-identical frames together even when their asset ids differ. A cell that repeats nothing needs no family.
- "name": the visible scene or motif in a few words. Never an asset id, a truth type or a generic style label.
- "description": what those cells visibly share.
- "cells": the cell numbers, each once.

STEP 3 - DECISION: LOCAL SEQUENCE VS WHOLE-FILM RECURRENCE
Ask: does the finished film keep falling back on the same motifs often enough that a viewer is likely to experience it as recycled, monotonous or visually thin?
Several ADJACENT cells sharing a motif during ONE coherent narrative event (one continuous scene or episode) are a local sequence: a sequence may legitimately stay visually related, and adjacency alone is not a reason to flag. A contiguous run is a concern only if its frames are near-identical and visually stagnant.
Be much more concerned about WHOLE-FILM RECURRENCE:
- the same motif returning after other visual material, across distant sections of the film
- multiple visually similar assets creating the same repeated look
- the film falling back on a small handful of scene types or one pervasive cross-cutting element
- callbacks becoming the dominant visual vocabulary rather than occasional returns
Do NOT flag merely because: the central historical object or subject returns naturally; the film has one consistent style; an intentional callback occurs once or twice; a map returns when geography genuinely matters. No fixed number or percentage decides it: judge whether a viewer would feel it.

Out of scope - do not judge: facts, motion or animation, pronunciation, voice, audio, music, subtitles, cut timing. Sampled still frames cannot show them.

- PASS: issues is empty.
- HUMAN_REVIEW: at least one issue. Each issue names the repeated motif (by its family name), states its actual extent accurately - which cells and times, and whether it is one contiguous run or returns across distant sections; never overstate it - and why that hurts the whole film. "cells": at least two cells that demonstrate it, each one listed in a returned family.
Do not invent defects. Do not suggest edits. No ratings, no scores, no generic advice. Use plain hyphens only.

Return strict JSON { "cellObservations": [{ "cell", "description" }], "families": [{ "name", "description", "cells": [<cell numbers>] }], "issues": [{ "reason", "cells": [<cell numbers>] }], "decision": "PASS" | "HUMAN_REVIEW", "summary": "<one or two plain sentences>" }.`;

// Property order is generation order: observations, then motifs, then the verdict.
export const VISUAL_AUDIT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["cellObservations", "families", "issues", "decision", "summary"],
  properties: {
    cellObservations: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["cell", "description"],
        properties: { cell: { type: "integer" }, description: { type: "string" } },
      },
    },
    families: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["name", "description", "cells"],
        properties: { name: { type: "string" }, description: { type: "string" }, cells: { type: "array", items: { type: "integer" } } },
      },
    },
    issues: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["reason", "cells"],
        properties: { reason: { type: "string" }, cells: { type: "array", items: { type: "integer" } } },
      },
    },
    decision: { type: "string", enum: ["PASS", "HUMAN_REVIEW"] },
    summary: { type: "string" },
  },
} as const;

// Words that name a production identity or a style, not a visible scene. A
// family name or cell description made only of these (and asset ids) says
// nothing about the frames.
const NOT_A_SCENE = new Set(
  "a an and the of with in on family families group cluster set shot shots frame frames cell cells image images picture pictures asset assets scene scenes visual visuals style styled generic misc miscellaneous other others various mixed assorted remaining archive archival reconstruction reconstructed graphic graphics historical historic illustration illustrations illustrated painting paintings painted photo photos photograph photographs photographic footage still stills black white sepia colour color monochrome vintage".split(" "),
);

// Read the visual answer strictly. Every cell 1..cellCount is observed exactly
// once in visible terms; each repeated motif holds at least two distinct valid
// cells (motifs may overlap and need not cover every cell); PASS carries no
// issues, HUMAN_REVIEW at least one; every issue cites at least two distinct
// cells, each inside a returned motif.
export function readVisualAudit(raw: unknown, cellCount: number, assetIds: string[]): VisualAudit {
  const reject = (why: string): never => {
    throw new Error(`Invalid Final-film visual audit: ${why}.`);
  };
  if (!isObject(raw)) return reject("answer is not an object");
  const { decision, summary, cellObservations, families, issues } = raw;
  if (decision !== "PASS" && decision !== "HUMAN_REVIEW") return reject(`decision ${JSON.stringify(decision ?? null)} is not PASS or HUMAN_REVIEW`);
  if (typeof summary !== "string") return reject("summary is missing");
  if (!Array.isArray(cellObservations) || !Array.isArray(families) || !Array.isArray(issues)) return reject("cellObservations, families and issues must all be lists");

  const ids = new Set(assetIds.map((id) => id.toLowerCase()));
  const visible = (text: string) => text.toLowerCase().split(/[^a-z0-9]+/).some((w) => w && !NOT_A_SCENE.has(w) && !ids.has(w) && !/^\d+$/.test(w));
  const validCell = (c: unknown, where: string) => {
    if (!Number.isInteger(c) || (c as number) < 1 || (c as number) > cellCount) reject(`${where} has cell ${JSON.stringify(c)}, outside 1-${cellCount}`);
    return c as number;
  };
  // At least `min` distinct valid cells.
  const cellList = (v: unknown, min: number, where: string): number[] => {
    if (!Array.isArray(v) || v.length < min) return reject(`${where} needs at least ${min} cells`);
    const cells = v.map((c) => validCell(c, where));
    const dup = cells.find((c, i) => cells.indexOf(c) !== i);
    if (dup !== undefined) reject(`${where} lists cell ${dup} twice`);
    return cells;
  };

  const observed = new Set<number>();
  const observations = cellObservations.map((item, i): CellObservation => {
    if (!isObject(item)) return reject(`cell observation ${i + 1} is not an object`);
    const cell = validCell(item.cell, `cell observation ${i + 1}`);
    if (observed.has(cell)) reject(`cell ${cell} is observed twice`);
    observed.add(cell);
    const description = clean(item.description);
    if (!description) reject(`cell ${cell} needs a description`);
    if (!visible(description)) reject(`cell ${cell} is described by an asset id, truth type or style, not what is visible`);
    return { cell, description };
  });
  const unobserved = Array.from({ length: cellCount }, (_, i) => i + 1).filter((c) => !observed.has(c));
  if (unobserved.length) reject(`no observation for cell${unobserved.length === 1 ? "" : "s"} ${unobserved.join(", ")}`);

  const inFamily = new Set<number>();
  const motifs = families.map((item, i): VisualFamily => {
    if (!isObject(item)) return reject(`family ${i + 1} is not an object`);
    const name = clean(item.name);
    const where = `family ${i + 1} (${JSON.stringify(name)})`;
    if (!name || !clean(item.description)) return reject(`family ${i + 1} needs a name and a description`);
    if (!visible(name)) reject(`${where} names an asset id, truth type or style, not a visible scene`);
    const cells = cellList(item.cells, 2, where);
    cells.forEach((c) => inFamily.add(c));
    return { name, description: clean(item.description), cells };
  });

  const visual = issues.map((item, i) => {
    if (!isObject(item) || !clean(item.reason)) return reject(`visual issue ${i + 1} needs a reason`);
    const cells = cellList(item.cells, 2, `visual issue ${i + 1}`);
    const loose = cells.filter((c) => !inFamily.has(c));
    if (loose.length) reject(`visual issue ${i + 1} cites cell${loose.length === 1 ? "" : "s"} ${loose.join(", ")} outside every returned family`);
    return { reason: clean(item.reason), cells };
  });
  if (decision === "PASS" && visual.length) reject("PASS cannot carry issues");
  if (decision === "HUMAN_REVIEW" && !visual.length) reject("HUMAN_REVIEW needs at least one issue");
  return { decision, summary: clean(summary), cellObservations: observations, families: motifs, issues: visual };
}

// ---------------------------------------------------------------------------
// Combined, locally: either specialist asking for review means HUMAN_REVIEW.
// ---------------------------------------------------------------------------

export function combineFinalFilmQa(factual: FactualAudit, visual: VisualAudit): FinalFilmQaResult {
  const review = factual.decision === "HUMAN_REVIEW" || visual.decision === "HUMAN_REVIEW";
  return {
    decision: review ? "HUMAN_REVIEW" : "PASS",
    summary: `Factual: ${factual.summary} Visual: ${visual.summary}`,
    factualIssues: factual.issues,
    visualIssues: visual.issues.map((i) => ({ reason: i.reason })),
  };
}

// ---------------------------------------------------------------------------
// The specialist entry points. Each is exactly one reviewer call, no retry; a
// failed or malformed answer throws, so nothing silently passes.
// ---------------------------------------------------------------------------

// The visual specialist's own model, for that one call only: every other PB4
// OpenAI call keeps the configured text model.
export const FINAL_VISUAL_QA_MODEL = "gpt-6-astra";
export const FINAL_VISUAL_QA_REASONING = { effort: "high" } as const;

function assertReviewable(input: FinalFilmInput): void {
  if (!input.script.trim()) throw new Error("Final-film QC: the film has no narration.");
  if (!input.shots.length) throw new Error("Final-film QC: the film has no edit.");
}

// The factual audit: the final narration only (no image), with web search on,
// on the configured text model.
export async function reviewFinalFactual(input: FinalFilmInput, reviewer: FinalFilmReviewer = respondJson): Promise<FactualAudit> {
  assertReviewable(input);
  const claims = causalClaims(input.script);
  return readFactualAudit(
    await reviewer({
      instructions: FACTUAL_AUDIT_INSTRUCTIONS,
      input: factualPayload(input, claims),
      schemaName: "final_film_factual_audit",
      schema: FACTUAL_AUDIT_SCHEMA,
      webSearch: true,
    }),
    claims.map((c) => c.text),
  );
}

// The visual-family audit: every sampled frame of the final mp4 as its own
// labelled image, no web search. `frames` are sampled here unless given; they
// are never kept.
export async function reviewFinalVisual(input: FinalFilmInput, reviewer: FinalFilmReviewer = respondJson, frames?: SampledFrame[]): Promise<VisualAudit> {
  assertReviewable(input);
  const sampled = frames ?? sampledFrames(input.videoPath, input.kind);
  return readVisualAudit(
    await reviewer({
      instructions: VISUAL_AUDIT_INSTRUCTIONS,
      input: visualPayload(input, sampled.map((f) => f.timeSec)),
      schemaName: "final_film_visual_audit",
      schema: VISUAL_AUDIT_SCHEMA,
      images: sampled.map((f) => ({ label: frameLabel(input.shots, f.cell, f.timeSec), data: f.jpeg, mimeType: "image/jpeg" })),
      model: FINAL_VISUAL_QA_MODEL,
      reasoning: FINAL_VISUAL_QA_REASONING,
    }),
    sampled.length,
    input.shots.map((s) => s.assetId),
  );
}

export interface FinalFilmReview extends FinalFilmQaResult {
  // The two specialist answers behind the combined result, for the proof runner.
  specialists: { causalClaims: CausalClaim[]; factual: FactualAudit; visual: VisualAudit };
}

// One film, both specialists, exactly two calls: the frames are sampled once
// (from the final mp4, never kept) before any paid call, then the factual audit,
// then the visual-family audit.
export async function reviewFinalFilm(input: FinalFilmInput, reviewer: FinalFilmReviewer = respondJson): Promise<FinalFilmReview> {
  assertReviewable(input);
  const frames = sampledFrames(input.videoPath, input.kind);
  const factual = await reviewFinalFactual(input, reviewer);
  const visual = await reviewFinalVisual(input, reviewer, frames);
  return { ...combineFinalFilmQa(factual, visual), specialists: { causalClaims: causalClaims(input.script), factual, visual } };
}

// ---------------------------------------------------------------------------
// Production record (private job scratch) and its small public reading.
// ---------------------------------------------------------------------------

export type FinalFilmKind = "long" | "short";
export type FinalSpecialist = "factual" | "visual";

// Saved under the job's scratch as `finalFilmQa`. `outputsValidated` is the
// durable marker that BOTH final mp4s exist and passed the file contract, so
// nothing renders them again. Each specialist result is saved as soon as it
// exists; `accepted` is the person's Continue anyway. No prompt or image bytes.
export interface FinalFilmQaRecord {
  outputsValidated: true;
  accepted?: true;
  long: { factual?: FactualAudit; visual?: VisualAudit };
  short: { factual?: FactualAudit; visual?: VisualAudit };
  visualRepair?: FinalVisualRepair;
  // An explicit resume of an awaiting_final job may limit the repair to one film;
  // the other film's edit, file and results are then never touched.
  repairOnly?: FinalFilmKind;
}

// The ONE automatic final visual repair a job may get after a visual
// HUMAN_REVIEW (see generate.ts): archive recovery, then at most one existing-
// media sequence revision per flagged film. Saved before any work starts, so it
// never runs twice. `rerender` lists films whose edit changed (or may have) but
// whose file is not rendered yet; a restart renders them first.
export interface FinalVisualRepair {
  attempted: true;
  tried: { film: FinalFilmKind; assetId: string }[];
  recovered: { film: FinalFilmKind; assetId: string; source: string }[];
  rejected: { film: FinalFilmKind; assetId: string; reason: string }[];
  sequence?: { film: FinalFilmKind; targets: number[]; changed: number[]; outcome: string }[];
  rerender?: FinalFilmKind[];
}

// The four specialists, in the order production runs them.
export const FINAL_SPECIALISTS: [FinalFilmKind, FinalSpecialist][] = [
  ["long", "factual"],
  ["long", "visual"],
  ["short", "factual"],
  ["short", "visual"],
];

// Each film's combined result, once both of its specialists have answered.
export function finalFilmResults(record: FinalFilmQaRecord): Partial<Record<FinalFilmKind, FinalFilmQaResult>> {
  const out: Partial<Record<FinalFilmKind, FinalFilmQaResult>> = {};
  for (const film of ["long", "short"] as const) {
    const { factual, visual } = record[film];
    if (factual && visual) out[film] = combineFinalFilmQa(factual, visual);
  }
  return out;
}

// What a person is shown: the concrete concern per film and area, and for a fact
// the short narration fragment. Never checks, evidence, cells, families,
// summaries or models.
export function finalQaIssues(record: FinalFilmQaRecord): FinalQaIssue[] {
  const results = finalFilmResults(record);
  return (["long", "short"] as const).flatMap((film) => [
    ...(results[film]?.factualIssues ?? []).map((i): FinalQaIssue => ({ film, area: "fact", reason: i.reason, text: i.text })),
    ...(results[film]?.visualIssues ?? []).map((i): FinalQaIssue => ({ film, area: "visual", reason: i.reason })),
  ]);
}
