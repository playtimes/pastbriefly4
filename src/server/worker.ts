import { runJob, autoTextQaForJob, autoVisualQaForJob } from "../production/generate.ts";
import { getJob, resumableJobIds } from "./store.ts";

// One local worker: a single film job runs at a time, tracked in the database,
// so a duplicate click or a page reload never starts a second job.

const queue: string[] = [];
let active: string | null = null;

export function enqueueJob(jobId: string): void {
  if (active === jobId || queue.includes(jobId)) return;
  queue.push(jobId);
  void pump();
}

export function isBusy(): boolean {
  return active !== null;
}

async function pump(): Promise<void> {
  if (active) return;
  const next = queue.shift();
  if (!next) return;
  active = next;
  try {
    // A new draft at the text gate goes to Automatic Director Text QA. It runs
    // outside the worker slot (text calls only); on PASS it approves the text and
    // requeues the job through enqueueJob, exactly like Approve & continue.
    // Freshly acquired visuals at the preview gate go to the Visual Autopilot,
    // also outside the slot: Asset QA, Director QA for Long and Short, and only
    // when all are clean the existing visual approval, requeued like Continue.
    const reached = await runJob(next);
    if (reached === "text_gate") void autoTextQaForJob(next, enqueueJob);
    if (reached === "preview_gate") void autoVisualQaForJob(next, enqueueJob);
  } catch (e) {
    console.error(`[worker] job ${next} failed:`, (e as Error).message);
  } finally {
    active = null;
    setImmediate(() => void pump());
  }
}

// On startup, resume any job left mid-flight. Completed paid work on disk is
// reused, so no provider call is duplicated.
export function resumeInterrupted(): void {
  for (const id of resumableJobIds()) {
    const j = getJob(id);
    if (j) {
      console.log(`[worker] resuming job ${id} from "${j.step}"`);
      enqueueJob(id);
    }
  }
}
