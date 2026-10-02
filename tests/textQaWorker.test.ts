import { describe, test, expect, vi } from "vitest";

// The worker starts Automatic Director Text QA only when runJob reports a NEW
// draft at the text gate. It hands Text QA no requeue: Text QA never approves,
// so only the manual Approve & continue route requeues the job. The pipeline
// itself is stubbed.
const h = vi.hoisted(() => ({ reached: {} as Record<string, "text_gate" | "preview_gate" | undefined>, ran: [] as string[] }));

vi.mock("../src/production/generate.ts", () => ({
  runJob: vi.fn(async (id: string) => (h.ran.push(id), h.reached[id])),
  autoTextQaForJob: vi.fn(async () => undefined),
  autoVisualQaForJob: vi.fn(async () => undefined),
}));
vi.mock("../src/server/store.ts", () => ({ getJob: vi.fn(), resumableJobIds: vi.fn(() => []) }));

const { enqueueJob } = await import("../src/server/worker.ts");
const { autoTextQaForJob, autoVisualQaForJob } = await import("../src/production/generate.ts");

const settle = () => new Promise((r) => setTimeout(r, 10));

describe("worker and Automatic Text QA", () => {
  test("a new draft at the text gate starts Text QA, without any requeue", async () => {
    h.reached["new-draft"] = "text_gate";
    enqueueJob("new-draft");
    await settle();
    expect(autoTextQaForJob).toHaveBeenCalledOnce();
    expect(autoTextQaForJob).toHaveBeenCalledWith("new-draft"); // it never approves or requeues
  });

  test("any other stop does not start Text QA", async () => {
    vi.mocked(autoTextQaForJob).mockClear();
    enqueueJob("preview-gate");
    await settle();
    expect(h.ran).toContain("preview-gate");
    expect(autoTextQaForJob).not.toHaveBeenCalled();
    expect(autoVisualQaForJob).not.toHaveBeenCalled();
  });

  test("fresh visuals at the preview gate start the Visual Autopilot with the worker's own requeue", async () => {
    vi.mocked(autoTextQaForJob).mockClear();
    h.reached["new-visuals"] = "preview_gate";
    enqueueJob("new-visuals");
    await settle();
    expect(autoVisualQaForJob).toHaveBeenCalledOnce();
    expect(autoVisualQaForJob).toHaveBeenCalledWith("new-visuals", enqueueJob);
    expect(autoTextQaForJob).not.toHaveBeenCalled();
  });
});
