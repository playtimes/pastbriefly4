import { respondJson, type InputImage } from "../providers/openai.ts";
import { stillFeedbackError, type AssetQaDecision, type Story } from "../types.ts";
import { plainDashes } from "./text.ts";
import type { PlannedShot } from "./visuals.ts";

// ---------------------------------------------------------------------------
// Pixel-aware Asset QA (v1): the Pixel Director looks at the ACTUAL saved still
// of every unique current owner asset, with the editorial intent it was made
// for. It judges the intrinsic image only; whether a visual fits its narration
// stays with the Director Sequence QA. One film per call, in small fixed batches.
// ---------------------------------------------------------------------------

// Stills per vision call. Each is sent whole at high detail as its own labelled
// image input (no contact sheet), so a batch stays small: a few ~1-3 MB stills,
// well inside one request, and few enough that every image gets real attention.
export const ASSET_QA_BATCH = 4;

// One current owner asset under review: its owner slot, its saved still and the
// intent it was made for. `regenerable` mirrors regenerateStill's own rule: a
// generated reconstruction or graphic with a generated still. Archive never is.
export interface AssetQaTarget {
  kind: "long" | "short";
  assetId: string;
  owner: number;
  truth: PlannedShot["truth"];
  path: string;
  regenerable: boolean;
  intent: Pick<PlannedShot, "purpose" | "prompt" | "framing" | "mustShow" | "mustNotShow" | "archiveQuery" | "source">;
  details: string[]; // the focus of every detail crop the film shows of it
  uses: { slot: number; caption?: string }[];
}

const isStill = (p?: string): p is string => !!p && /\.(png|jpe?g|webp)$/i.test(p);

// Every unique asset the saved film shows now, once, at its owning slot. Reuse
// slots share the owner's bytes and are never sent again. Retained presentations
// no slot uses are not part of the film, so they are never reviewed here.
export function assetQaTargets(kind: "long" | "short", shots: PlannedShot[]): AssetQaTarget[] {
  return shots
    .filter((s) => s.edit === "new" && isStill(s.path))
    .map((owner) => {
      const all = shots.filter((s) => s.assetId === owner.assetId);
      const base = all.find((s) => s.presentation === "base") ?? owner;
      return {
        kind,
        assetId: owner.assetId,
        owner: owner.index,
        truth: owner.truth,
        path: owner.path!,
        regenerable: (owner.truth === "reconstruction" || owner.truth === "graphic") && owner.path!.startsWith("images/"),
        intent: {
          purpose: base.purpose,
          prompt: base.prompt,
          framing: base.framing,
          mustShow: base.mustShow,
          mustNotShow: base.mustNotShow,
          ...(base.archiveQuery ? { archiveQuery: base.archiveQuery } : {}),
          ...(owner.source ? { source: owner.source } : {}),
        },
        details: [...new Set(all.map((s) => s.focus).filter((f): f is string => !!f))],
        uses: all.map((s) => ({ slot: s.index, ...(s.caption?.text ? { caption: s.caption.text } : {}) })),
      };
    });
}

export const chunk = <T>(list: T[], size = ASSET_QA_BATCH): T[][] => Array.from({ length: Math.ceil(list.length / size) }, (_, i) => list.slice(i * size, (i + 1) * size));

const TYPE_LABEL: Record<PlannedShot["truth"], string> = {
  reconstruction: "generated reconstruction",
  graphic: "generated graphic",
  archive: "archive photograph (authentic source, read only)",
};

// What a verification is checking: the original pixel issue and the repair note
// the one regeneration was given.
export interface AppliedRepair {
  reason: string;
  feedback: string;
}

export interface AssetQaInput {
  story: Story;
  kind: "long" | "short";
  targets: AssetQaTarget[];
  images: InputImage[]; // one per target, same order: the saved bytes, read at call time
  repairs?: Map<string, AppliedRepair>; // verification only
}

export function assetImageLabel(t: AssetQaTarget): string {
  return `IMAGE for asset ${t.assetId} (${t.kind.toUpperCase()}, ${TYPE_LABEL[t.truth]}):`;
}

const pad = (n: number) => String(n).padStart(2, "0");

// The text half of the call: identity, intent and current use per asset. The
// images follow, each preceded by assetImageLabel.
export function assetQaPayload(input: Pick<AssetQaInput, "story" | "kind" | "targets" | "repairs">): string {
  const { story, kind, targets, repairs } = input;
  const verify = !!repairs;
  const blocks = targets.map((t) => {
    const i = t.intent;
    const captions = t.uses.filter((u) => u.caption).slice(0, 3).map((u) => `"${u.caption}"`);
    const repair = repairs?.get(t.assetId);
    return [
      `ASSET ${t.assetId}`,
      `film: ${kind.toUpperCase()}`,
      `type: ${TYPE_LABEL[t.truth]}`,
      verify ? null : `automatic regeneration: ${t.regenerable ? "available (REGENERATE allowed)" : "NOT available (PASS or HUMAN_REVIEW only)"}`,
      `purpose: ${i.purpose}`,
      `framing: ${i.framing}`,
      t.truth === "archive" ? `archive search: ${i.archiveQuery ?? "(not recorded)"}` : `generation prompt: ${i.prompt}`,
      i.source ? `source: ${i.source}` : null,
      `must show: ${i.mustShow.join("; ") || "(not listed)"}`,
      `must not show: ${i.mustNotShow.join("; ") || "(not listed)"}`,
      t.details.length ? `detail crops the film uses: ${t.details.join(" | ")}` : null,
      `current use: slot${t.uses.length === 1 ? "" : "s"} ${t.uses.map((u) => pad(u.slot)).join(", ")}${captions.length ? `; captions ${captions.join(", ")}` : ""}`,
      repair ? `ORIGINAL PIXEL ISSUE: ${repair.reason}` : null,
      repair ? `REPAIR NOTE THE ONE REGENERATION WAS GIVEN: ${repair.feedback}` : null,
    ]
      .filter((l): l is string => l !== null)
      .join("\n");
  });
  return [
    `STORY: ${story.title} (${story.year}, ${story.place})`,
    `FILM: ${kind.toUpperCase()}. ${targets.length} asset${targets.length === 1 ? "" : "s"}; after this text each one's image follows, labelled with its asset id. Judge every image only against its own asset.`,
    "",
    blocks.join("\n\n"),
    "",
    verify
      ? `Return JSON { "assets": { "<asset id>": { "decision": "PASS" | "HUMAN_REVIEW", "reason" } }, "summary" }: one entry for each of ${targets.map((t) => t.assetId).join(", ")}.`
      : `Return JSON { "assets": { "<asset id>": { "decision", "reason", "repairFeedback" } }, "summary" }: one entry for each of ${targets.map((t) => t.assetId).join(", ")}.`,
  ].join("\n");
}

const JUDGE = `Judge only what the pixels show, read against the supplied intent:
A. REQUIRED / FORBIDDEN CONTENT - an important "must show" element is visibly absent, or a "must not show" element is visibly present.
B. UNEXPECTED TEXT / SYMBOLS - materially distracting or misleading words, letters, numbers, signage, labels, logos, emblems or symbols the intended scene does not support: for example an unexplained campaign-style symbol inside an unrelated scene, directional text in a language or script the setting does not use, or generated text posing as an authentic sign that was never requested.
C. GENERATED IMAGE INTEGRITY (generated stills) - clearly malformed bodies, hands or faces where they are materially visible, fused or impossible objects, broken vehicles, duplicated major objects, impossible structural geometry, obviously corrupted text, severe generation artefacts.
D. SPATIAL / DIRECTIONAL LOGIC - where the intent makes it relevant: road or lane direction, vehicle orientation, a before/after spatial relationship, elements moving in mutually impossible directions. Only when the pixels give a reasonably clear basis.
E. STORY CONTAMINATION - symbols or branding that belong to another story beat or event, or visual language that clearly contradicts the requested period and place. Do not pretend you can date every object.
F. GRAPHICS (generated graphics) - required numbers or labels are visibly present and legible at film scale, no corrupted pseudo-text dominates, the hierarchy is readable, and no unrelated factual labels appear.
Do not nitpick tiny background imperfections invisible at normal film scale. Whether a visual suits its narration is judged elsewhere: do not re-judge the story or the sequence.`;

export const PIXEL_QA_INSTRUCTIONS = `You are the Pixel Director for PastBriefly ("true historical stories that sound made up"), inspecting the ACTUAL saved still of each asset of one film before a person approves the visuals. Each asset comes with its identity, the editorial intent it was made for and where the film uses it, then its image.

${JUDGE}

Decide once per asset:
- PASS: no material pixel problem.
- REGENERATE: an intrinsic problem that is clear from the image and its intent, on an asset marked "automatic regeneration: available", which one regeneration of the same shot can reasonably fix without changing the story or the sequence. Give repairFeedback: one or two short, specific sentences saying what to correct and what to preserve, e.g. "Remove the unsupported lettering on the sign; keep the street and vehicles as they are." There is only ONE regeneration attempt, so name every correction the image needs.
- HUMAN_REVIEW: an archive photograph with a material issue (archive is read only: never REGENERATE it), ambiguous image evidence, a fix that would need a different source rather than a regeneration, or a factual or historical judgement beyond what the pixels and the intent prove.
When unsure between REGENERATE and HUMAN_REVIEW, choose HUMAN_REVIEW. A reason is one or two plain sentences about what the image shows now; for PASS it may be short. repairFeedback is null unless the decision is REGENERATE. Use plain hyphens only.

Return strict JSON { "assets": { "<asset id>": { "decision", "reason", "repairFeedback" } }, "summary": "<one or two plain sentences>" } with exactly one entry per supplied asset.`;

export const PIXEL_VERIFY_INSTRUCTIONS = `You are the Pixel Director for PastBriefly, performing the final read-only verification of stills that were just regenerated ONCE to fix a pixel issue. Each asset comes with its intent, the original pixel issue and the repair note the regeneration was given, then its NEW saved image.

You cannot repair anything and there will be no further regeneration. For each asset check that the original issue is gone, and that the new image did not introduce another obvious material problem.

${JUDGE}

Decide once per asset:
- PASS: the original issue is gone and there is no new material problem.
- HUMAN_REVIEW: the original issue remains, a new material problem appeared, or you cannot tell. Say what the image shows now.
Use plain hyphens only.

Return strict JSON { "assets": { "<asset id>": { "decision", "reason" } }, "summary": "<one or two plain sentences>" } with exactly one entry per supplied asset.`;

// Keyed by asset id, so each asset gets exactly one entry by construction. An
// asset that cannot be regenerated (archive) cannot be answered REGENERATE.
export function assetQaSchema(targets: AssetQaTarget[], verify = false) {
  const entry = (t: AssetQaTarget) =>
    verify
      ? { type: "object", additionalProperties: false, required: ["decision", "reason"], properties: { decision: { type: "string", enum: ["PASS", "HUMAN_REVIEW"] }, reason: { type: "string" } } }
      : {
          type: "object",
          additionalProperties: false,
          required: ["decision", "reason", "repairFeedback"],
          properties: {
            decision: { type: "string", enum: t.regenerable ? ["PASS", "REGENERATE", "HUMAN_REVIEW"] : ["PASS", "HUMAN_REVIEW"] },
            reason: { type: "string" },
            repairFeedback: { type: ["string", "null"] },
          },
        };
  return {
    type: "object",
    additionalProperties: false,
    required: ["assets", "summary"],
    properties: {
      assets: { type: "object", additionalProperties: false, required: targets.map((t) => t.assetId), properties: Object.fromEntries(targets.map((t) => [t.assetId, entry(t)])) },
      summary: { type: "string" },
    },
  };
}

export interface AssetVerdict {
  decision: AssetQaDecision;
  reason: string;
  repairFeedback: string | null;
}

// Read one batch answer strictly. The answer must be keyed by asset id with
// exactly the supplied ids (an unknown or missing id, a list, or a decision
// outside the allowed set rejects the WHOLE batch). REGENERATE needs usable
// repair feedback; on an asset that cannot be regenerated it becomes
// HUMAN_REVIEW. A verification may only PASS or send to HUMAN_REVIEW.
export function readAssetQa(targets: AssetQaTarget[], raw: unknown, verify = false): { verdicts: Map<string, AssetVerdict>; summary: string } {
  const what = verify ? "Asset QA verification" : "Asset QA review";
  const reject = (why: string): never => {
    throw new Error(`Invalid ${what}: ${why}.`);
  };
  const answer = (raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {}) as { assets?: unknown; summary?: unknown };
  const assets = answer.assets;
  if (!assets || typeof assets !== "object" || Array.isArray(assets)) return reject('answer is not { "assets": { "<asset id>": {...} } }');
  const ids = new Set(targets.map((t) => t.assetId));
  for (const key of Object.keys(assets)) if (!ids.has(key)) reject(`asset ${JSON.stringify(key)} was not reviewed in this batch`);
  const allowed: AssetQaDecision[] = verify ? ["PASS", "HUMAN_REVIEW"] : ["PASS", "REGENERATE", "HUMAN_REVIEW"];
  const verdicts = new Map<string, AssetVerdict>();
  for (const t of targets) {
    const item = (assets as Record<string, unknown>)[t.assetId];
    if (!item || typeof item !== "object" || Array.isArray(item)) return reject(`asset ${t.assetId} has no result`);
    const { decision, reason, repairFeedback } = item as { decision?: unknown; reason?: unknown; repairFeedback?: unknown };
    if (typeof decision !== "string" || !allowed.includes(decision as AssetQaDecision)) return reject(`asset ${t.assetId}: decision ${JSON.stringify(decision ?? null)} is not ${allowed.join(", ")}`);
    const why = plainDashes(typeof reason === "string" ? reason.trim() : "");
    if (decision === "PASS") {
      verdicts.set(t.assetId, { decision, reason: why, repairFeedback: null });
      continue;
    }
    if (decision === "HUMAN_REVIEW") {
      verdicts.set(t.assetId, { decision, reason: why || "The Pixel Director flagged this still for a person.", repairFeedback: null });
      continue;
    }
    const note = typeof repairFeedback === "string" ? plainDashes(repairFeedback.trim()) : "";
    if (!note || stillFeedbackError(note)) return reject(`asset ${t.assetId}: REGENERATE needs repair feedback of 1-2,000 characters`);
    verdicts.set(
      t.assetId,
      t.regenerable
        ? { decision: "REGENERATE", reason: why || note, repairFeedback: note }
        : { decision: "HUMAN_REVIEW", reason: `${why || note} This still cannot be regenerated automatically.`, repairFeedback: null },
    );
  }
  return { verdicts, summary: plainDashes(typeof answer.summary === "string" ? answer.summary.trim() : "") };
}

export type AssetReviewer = (input: AssetQaInput, respond?: typeof respondJson) => Promise<unknown>;

export const openAiAssetReview: AssetReviewer = (input, respond = respondJson) =>
  respond<unknown>({ instructions: PIXEL_QA_INSTRUCTIONS, input: assetQaPayload(input), schemaName: "asset_qa", schema: assetQaSchema(input.targets), images: input.images });

export const openAiAssetVerify: AssetReviewer = (input, respond = respondJson) =>
  respond<unknown>({ instructions: PIXEL_VERIFY_INSTRUCTIONS, input: assetQaPayload(input), schemaName: "asset_verify", schema: assetQaSchema(input.targets, true), images: input.images });

// Mock mode never calls a provider: every asset passes.
export const fallbackAssetReview: AssetReviewer = async (input) => ({
  assets: Object.fromEntries(input.targets.map((t) => [t.assetId, { decision: "PASS", reason: "", repairFeedback: null }])),
  summary: "No pixel review model was called (mock mode).",
});
export const fallbackAssetVerify: AssetReviewer = async (input) => ({
  assets: Object.fromEntries(input.targets.map((t) => [t.assetId, { decision: "PASS", reason: "" }])),
  summary: "No pixel review model was called (mock mode).",
});
