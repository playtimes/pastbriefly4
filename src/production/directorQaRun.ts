import type {
  CoordinatedRepairReport,
  DirectorQaFinding,
  DirectorQaPhase,
  DirectorQaReport,
  DirectorQaResult,
  DirectorQaSlotNote,
  DirectorRepairIntent,
  DirectorVerifyReport,
  SequenceCleanupReport,
  SequenceRevisionReport,
} from "../types.ts";

// ---------------------------------------------------------------------------
// Run Director QA: the step order and the final result, on the server. The
// steps themselves are the existing production functions (bound in
// generate.ts); this file only sequences them and merges their reports.
// ---------------------------------------------------------------------------

// `cleanup` is the deterministic repetition cleanup that follows every reviewed
// run; `coordinated` the one coordinated-neighbourhood repair, when one ran;
// `verify` the final read-only Director verification of the saved film, whose
// findings supersede the initial review's semantic findings.
type Reviewed = { qa: DirectorQaReport; cleanup: SequenceCleanupReport; coordinated: CoordinatedRepairReport | null; verify: DirectorVerifyReport | null };
export type DirectorQaOutcome =
  | { status: "failed"; error: string } // the review failed: nothing changed
  | ({ status: "complete"; repair: SequenceRevisionReport | null } & Reviewed) // repair null: none was needed
  | ({ status: "repairFailed"; error: string } & Reviewed); // the Director repair changed nothing

export interface DirectorQaSteps {
  review: (kind: "long" | "short") => Promise<DirectorQaReport>;
  repair: (kind: "long" | "short", repairs: DirectorQaFinding[]) => Promise<SequenceRevisionReport>;
  cleanup: (kind: "long" | "short") => Promise<SequenceCleanupReport>;
  // `intent` is passed only when the target was a Director QA repair.
  coordinate?: (kind: "long" | "short", slotId: number, reason: string, intent?: DirectorRepairIntent) => Promise<CoordinatedRepairReport>;
  verify?: (kind: "long" | "short") => Promise<DirectorVerifyReport>;
  onPhase?: (phase: DirectorQaPhase) => void;
}

const pad = (n: number) => String(n).padStart(2, "0");

// ONE Director review, at most ONE repair (only when the review asked for one),
// ONE deterministic cleanup step (at most one repair call), then at most ONE
// coordinated repair, for the earliest automatic repair still unresolved (any
// other unresolved slot becomes human review), then ONE read-only verification.
// At most five text calls. Never retries and never loops. Every failure becomes
// an outcome to show.
export async function runDirectorQa(kind: "long" | "short", steps: DirectorQaSteps): Promise<DirectorQaOutcome> {
  const message = (e: any, fallback: string) => e?.message || fallback;
  steps.onPhase?.("reviewing");
  let qa: DirectorQaReport;
  try {
    qa = await steps.review(kind);
  } catch (e) {
    return { status: "failed", error: message(e, "The Director review failed.") };
  }
  let repair: SequenceRevisionReport | null = null;
  let repairError: string | null = null;
  if (qa.repairs.length) {
    steps.onPhase?.("repairing");
    try {
      repair = await steps.repair(kind, qa.repairs);
    } catch (e) {
      repairError = message(e, "The automatic repair failed.");
    }
  }
  steps.onPhase?.("cleaning");
  let cleanup: SequenceCleanupReport;
  try {
    cleanup = await steps.cleanup(kind);
  } catch (e) {
    cleanup = { ran: false, changed: [], unresolved: [], remaining: [], error: message(e, "The automatic cleanup failed.") };
  }
  // Every automatic repair still unresolved failed as a one-slot change (the
  // revision's own reason, an illegal pick, or no fitting alternative).
  const pending = new Map<number, string>();
  for (const u of [...(repair?.unresolved ?? []), ...cleanup.unresolved]) if (!pending.has(u.slotId)) pending.set(u.slotId, u.reason);
  const [first, ...rest] = [...pending].sort((a, b) => a[0] - b[0]);
  let coordinated: CoordinatedRepairReport | null = null;
  if (first && steps.coordinate) {
    steps.onPhase?.("coordinating");
    try {
      // The target's original Director finding (reason + instruction), when it
      // was a Director repair, travels with the one-slot repair's reason.
      const finding = qa.repairs.find((r) => r.slotId === first[0]);
      coordinated = finding
        ? await steps.coordinate(kind, first[0], first[1], { reason: finding.reason, instruction: finding.instruction })
        : await steps.coordinate(kind, first[0], first[1]);
    } catch (e) {
      const error = message(e, "The coordinated repair failed.");
      coordinated = { target: first[0], changed: [], humanReview: [{ slotId: first[0], reason: `Coordinated repair could not resolve Slot ${pad(first[0])}. The previous valid edit is kept. ${error}` }], remaining: cleanup.remaining, error };
    }
    coordinated = { ...coordinated, humanReview: [...coordinated.humanReview, ...rest.map(([slotId, reason]) => ({ slotId, reason: `${reason} Not attempted: one coordinated repair per Director QA run.` }))] };
  }
  // The terminal step: one read-only verification of the saved film. Nothing
  // runs after it, whatever it finds.
  let verify: DirectorVerifyReport | null = null;
  if (steps.verify) {
    steps.onPhase?.("verifying");
    try {
      verify = await steps.verify(kind);
    } catch (e) {
      // The latest deterministic patterns were computed on the saved film by the last step that ran.
      verify = { summary: "", humanReview: [], patterns: coordinated ? coordinated.remaining : cleanup.remaining, error: message(e, "The final Director verification failed.") };
    }
  }
  return repairError === null
    ? { status: "complete", qa, repair, cleanup, coordinated, verify }
    : { status: "repairFailed", qa, error: repairError, cleanup, coordinated, verify };
}

// The final result of a reviewed run, as the Director panel shows it: what
// changed automatically (Director repairs, cleanup and the coordinated repair,
// counted apart) and the exceptions that still need a person, one line per slot.
export function directorQaResult(outcome: Exclude<DirectorQaOutcome, { status: "failed" }>): DirectorQaResult {
  const { qa, cleanup, coordinated, verify } = outcome;
  const repair = outcome.status === "complete" ? outcome.repair : null;
  const bySlot = (lists: DirectorQaSlotNote[][]) => {
    const out = new Map<number, string>();
    for (const item of lists.flat()) out.set(item.slotId, out.has(item.slotId) ? `${out.get(item.slotId)} ${item.reason}` : item.reason);
    return [...out].sort((a, b) => a[0] - b[0]).map(([slotId, reason]) => ({ slotId, reason }));
  };
  // A slot a later step changed, or the coordinated repair handed to a person, is no longer an open unresolved repair.
  const handled = new Set([...cleanup.changed, ...(coordinated?.changed ?? []), ...(coordinated?.humanReview ?? []).map((h) => h.slotId)]);
  const unresolved = bySlot([repair?.unresolved ?? [], cleanup.unresolved]).filter((u) => !handled.has(u.slotId));
  // The final verification is the only source of CURRENT semantic findings: the
  // initial review's findings and summary may describe visuals later repairs
  // replaced, so they are never used once a verification step ran (even a
  // failed one). The patterns are the ones computed on the final saved film.
  const semantic = verify ? (verify.error ? [] : verify.humanReview) : qa.humanReview;
  const patterns = verify ? verify.patterns : coordinated ? coordinated.remaining : cleanup.remaining;
  const human = bySlot([semantic, patterns, coordinated?.humanReview ?? []]);
  // Clean describes the FINAL saved film, not whether repairs happened: the final
  // verification completed, nothing needs a person, no repair is left unresolved,
  // and no step failed (a failed Director repair, cleanup or coordinated repair
  // leaves its problem for a person). Automatic changes are only informational.
  const clean = !!verify && !verify.error && outcome.status === "complete" && !cleanup.error && !coordinated?.error && !unresolved.length && !human.length;
  return {
    ...(outcome.status === "repairFailed" ? { repairError: outcome.error } : {}),
    ...(cleanup.error ? { cleanupError: cleanup.error } : {}),
    ...(coordinated?.error ? { coordinatedError: { target: coordinated.target, error: coordinated.error } } : {}),
    verified: !!verify && !verify.error,
    ...(verify?.error ? { verifyError: verify.error } : {}),
    automaticChanges: repair?.changed.length ?? 0,
    cleanupChanges: cleanup.changed.length,
    coordinatedChanges: coordinated?.changed.length ?? 0,
    changed: [...new Set([...(repair?.changed ?? []), ...cleanup.changed, ...(coordinated?.changed ?? [])])].sort((a, b) => a - b),
    unresolvedRepairs: unresolved,
    requestedRepairs: outcome.status === "repairFailed" ? qa.repairs.map(({ slotId, reason }) => ({ slotId, reason })) : [],
    humanReview: human,
    summary: verify ? verify.summary : qa.summary,
    clean,
  };
}
