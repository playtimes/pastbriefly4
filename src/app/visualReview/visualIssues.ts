// The Visuals-need-you summary: the small concrete set of CURRENT visual
// problems, merged from state PB4 already keeps on the job, in plain words.
// Pure and presentation only. Each issue carries at most one creative fix, and
// the slot it is about, only when that slot exists in the current film: nothing
// here invents a slot, an image or an action.
import { buildFilm, canRegenerate, fmtTime, pad2, slotLabel, slotNumber, type Film, type FilmReview, type ReviewAsset } from "./model.ts";
import { NO_LEGAL_ALTERNATIVE, type Job, type PreviewFrame } from "../../types.ts";

export interface VisualIssue {
  key: string;
  film?: Film;
  where: string; // "Long · Slot 06 · 00:24"
  reasons: string[]; // every still-relevant reason, deduplicated, in plain words
  frame?: PreviewFrame; // the current visual, only for a slot in the current film
  target?: { index: number; whole: boolean }; // that slot (whole: show the image uncropped)
  fix?: IssueFix; // the one creative action that can resolve it, when there is one
  asset?: ReviewAsset; // the generated image, for "regenerate"
  note?: string; // why there is no fix here
}

// regenerate: Regenerate image (the existing still regeneration). change:
// Change visual (the existing sequence revision for that film).
export type IssueFix = "regenerate" | "change";

type IssueJob = Pick<Job, "assetQa" | "directorQa" | "visualAutopilot">;

const FILM = { long: "Long", short: "Short" } as const;
const NOTHING_TO_SHOW = "This part of the film has changed since PB4 checked it, so there is nothing to show.";
const LOOK_FIRST = "Nothing here needs fixing by itself. Continue production, or look through the film first.";

export function visualIssues(job: IssueJob, films: Record<Film, FilmReview>): VisualIssue[] {
  return [...assetIssues(job, films), ...directorIssues(job, films, "long"), ...directorIssues(job, films, "short"), ...autopilotIssues(job)];
}

// The same, straight from a job's preview (the Story page has no built films).
export function visualIssuesForJob(job: IssueJob & Pick<Job, "preview">): VisualIssue[] {
  if (!job.preview) return [];
  return visualIssues(job, { long: buildFilm(job.preview, "long"), short: buildFilm(job.preview, "short") });
}

function assetIssues(job: IssueJob, films: Record<Film, FilmReview>): VisualIssue[] {
  const qa = job.assetQa;
  if (qa?.status !== "done") return [];
  const out = new Map<string, VisualIssue>();
  for (const i of qa.issues) {
    const key = `asset-${i.kind}-${i.assetId}`;
    const reason = i.incomplete ? `PB4 could not finish checking this image. ${plain(i.reason)}` : plain(i.reason);
    const seen = out.get(key);
    if (seen) {
      addReason(seen.reasons, reason);
      continue;
    }
    const fr = films[i.kind];
    const asset = fr.assets.find((a) => a.id === i.assetId);
    if (!asset) {
      out.set(key, { key, film: i.kind, where: `${FILM[i.kind]} film`, reasons: [reason], note: NOTHING_TO_SHOW });
      continue;
    }
    const frame = fr.frames[asset.owner];
    // A generated still is regenerated. An archive image is never altered: the
    // fix is Change visual, the existing revision choosing other media the film has.
    const fix = canRegenerate(frame)
      ? { fix: "regenerate" as const, asset }
      : frame.truth === "archive"
        ? { fix: "change" as const, note: "This archive image is used as found. It cannot be regenerated." }
        : { note: "This image cannot be regenerated here." };
    out.set(key, {
      key,
      film: i.kind,
      where: `${FILM[i.kind]} · Slot ${slotLabel(frame, asset.owner)}${at(frame)}`,
      reasons: [reason],
      frame,
      target: { index: asset.owner, whole: true },
      ...fix,
    });
  }
  const issues = [...out.values()];
  // A check that stopped before it looked at anything (a restart) left no
  // per-image result: say so rather than implying the images passed.
  if (!qa.clean && qa.reviewed === 0 && issues.length === 0) {
    issues.push({ key: "asset-check", where: "Images", reasons: ["PB4's check of the images stopped before it finished."], note: LOOK_FIRST });
  }
  return issues;
}

function directorIssues(job: IssueJob, films: Record<Film, FilmReview>, film: Film): VisualIssue[] {
  const run = job.directorQa?.[film];
  if (!run || run.status === "running") return [];
  const F = FILM[film];
  const check = (reasons: string[]): VisualIssue => ({ key: `check-${film}`, film, where: `${F} film`, reasons, note: LOOK_FIRST });
  if (run.status === "failed") return [check([`PB4 could not finish checking the ${F} film.`])];
  if (run.status === "interrupted") return [check([`PB4's check of the ${F} film was interrupted.`])];

  // The final persisted result is authoritative. One row per slot, with every
  // still-relevant reason from each final source merged into it.
  const slots = new Map<number, string[]>();
  const add = (slotId: number, reason: string) => {
    const list = slots.get(slotId) ?? [];
    addReason(list, plain(reason));
    slots.set(slotId, list);
  };
  for (const n of run.humanReview) add(n.slotId, n.reason);
  for (const n of run.unresolvedRepairs) add(n.slotId, n.reason);
  if (run.repairError) for (const n of run.requestedRepairs) add(n.slotId, `PB4 tried to fix this and could not: ${n.reason}`);
  if (run.coordinatedError) add(run.coordinatedError.target, "PB4 could not fix this part of the film by itself.");

  const fr = films[film];
  const out: VisualIssue[] = [];
  for (const [slotId, reasons] of [...slots].sort((a, b) => a[0] - b[0])) {
    const index = fr.frames.findIndex((f, i) => slotNumber(f, i) === slotId);
    const key = `slot-${film}-${slotId}`;
    if (index < 0) {
      // Persisted QA names a slot the current film no longer has: keep the issue,
      // but never point at a made-up slot.
      out.push({ key, film, where: `${F} · Slot ${pad2(slotId)}`, reasons, note: NOTHING_TO_SHOW });
      continue;
    }
    const frame = fr.frames[index];
    out.push({ key, film, where: `${F} · Slot ${pad2(slotId)}${at(frame)}`, reasons, frame, target: { index, whole: false }, fix: "change" });
  }

  // Failures no slot row carries: at most one understandable row per film.
  const problems: string[] = [];
  if (!run.verified) problems.push(`PB4 could not finish its final check of the ${F} film.`);
  if (run.repairError && !run.requestedRepairs.length) problems.push(`PB4's own fixes to the ${F} film could not be applied.`);
  if (run.cleanupError) problems.push(`PB4 could not finish removing repeated images in the ${F} film.`);
  if (!run.clean && !problems.length && !out.length) problems.push(run.summary || `PB4 is not satisfied with the ${F} film yet.`);
  if (problems.length) out.push(check(problems));
  return out;
}

function autopilotIssues(job: IssueJob): VisualIssue[] {
  if (job.visualAutopilot?.status !== "failed") return [];
  return [{ key: "autopilot", where: "Visual check", reasons: ["PB4's automatic check of the visuals stopped before it finished."], note: LOOK_FIRST }];
}

// The engine's own wording for the patterns it could not resolve, in plain
// words. Anything else is shown as written.
const PLAIN: [RegExp, string][] = [
  [/^ADJACENT REUSE remains\b.*$/s, "The same image appears twice in a row, and PB4 found no other image to use."],
  [/^CONSECUTIVE REUSE remains\b.*$/s, "The same image repeats several times in a row, and PB4 found no other image to break it up."],
  [/^ALTERNATING REUSE remains\b.*$/s, "Two images keep alternating here, and PB4 found no other image to vary it."],
  [/^OPENING REPEAT remains\b.*$/s, "The same image repeats in the opening seconds."],
  [/^Not changed: .*$/s, "PB4 could not make this change by itself."],
];
export function plain(reason: string): string {
  let r = reason.replace(NO_LEGAL_ALTERNATIVE, "PB4 found no other image in this film that could go here.").replace(/ ?Not attempted: one coordinated repair per Director QA run\./, " PB4 did not get to fix this one by itself.");
  for (const [re, text] of PLAIN) if (re.test(r)) r = text;
  return r;
}

function addReason(list: string[], reason: string): void {
  const r = reason.trim();
  if (r && !list.includes(r)) list.push(r);
}

const at = (frame?: PreviewFrame): string => (typeof frame?.startSec === "number" ? ` · ${fmtTime(frame.startSec)}` : "");

// The issue's visual in the CURRENT films (after a regeneration or a change),
// and the generated image behind it. Null when the issue has no slot.
export function issueFrame(issue: VisualIssue, films: Record<Film, FilmReview>): { frame: PreviewFrame; whole: boolean; asset: ReviewAsset } | null {
  if (!issue.film || !issue.target) return null;
  const fr = films[issue.film];
  const frame = fr.frames[issue.target.index];
  const asset = fr.assets[fr.assetOf[issue.target.index]];
  return frame && asset ? { frame: issue.target.whole ? fr.frames[asset.owner] : frame, whole: issue.target.whole, asset } : null;
}
