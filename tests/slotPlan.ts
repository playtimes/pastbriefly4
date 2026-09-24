// Minimal valid Film Grammar v2E planning answers for job-level tests that mock
// respondJson. The two planning calls are told apart by schemaName: the Coverage
// Director ("coverage_plan") gets one reconstruction asset per film (L00 / S00),
// and the Editor ("edit_plan") alternates "L00:base" / "L00:detail-center" (S00 in
// the Short) over every fixed slot, so no two adjacent slots repeat, read from the "LONG SLOTS (#0-#N)" / "SHORT SLOTS (#0-#N" headers of its payload.
export function minimalAsset(over: Record<string, unknown> = {}) {
  return {
    truth: "reconstruction", purpose: "Show the moment.", mustShow: [{ description: "the subject", region: "center" }], mustNotShow: [],
    prompt: "a specific scene", archiveQuery: "", useMaster: false, baseFraming: "wide", motionCapable: false, ...over,
  };
}

export function slotCount(payload: unknown, film: "LONG" | "SHORT"): number {
  return Number(new RegExp(`${film} SLOTS \\(#0-#(\\d+)`).exec(String(payload ?? ""))?.[1] ?? -1) + 1;
}

export function minimalPlan(opts: { schemaName?: string; input?: unknown } | undefined): unknown {
  if (opts?.schemaName === "coverage_plan") return { longAssets: [minimalAsset()], shortAssets: [minimalAsset()] };
  const film = (n: number, id: string) => Array.from({ length: n }, (_, slotId) => ({ slotId, presentationId: `${id}:${slotId % 2 ? "detail-center" : "base"}`, motionPriority: 0 }));
  return { long: film(slotCount(opts?.input, "LONG"), "L00"), short: film(slotCount(opts?.input, "SHORT"), "S00") };
}

// A test Editor's presentation per slot: the picked one where given, otherwise the
// first of `order` that repeats neither the previous slot nor the next pick
// (adjacent identical presentations are an Editor failure).
export function fillEdit(slotIds: number[], order: string[], pick: (slotId: number) => string | undefined): string[] {
  const out: string[] = [];
  slotIds.forEach((id, i) => out.push(pick(id) ?? order.find((p) => p !== out[i - 1] && p !== pick(id + 1)) ?? order[0]));
  return out;
}
