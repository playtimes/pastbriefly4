import { describe, test, expect, vi, beforeEach } from "vitest";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Story } from "../src/types.ts";

// Film Grammar v2E spend: in the REAL job, each UNIQUE USED media asset is
// acquired once, by the slot that owns it. Every other slot showing that asset
// (its base again, or a detail crop) reuses the still with no provider call and no
// charge, and a Coverage asset the Editor never uses is never acquired. Each of the
// two planning calls is charged once. An invalid Coverage answer stops before the
// Editor; an invalid Editor answer stops before any acquisition. A finished job is
// never touched, and an old plan is refused on resume before any spend. Every
// provider is stubbed; runs stop at the preview gate.
const tmp = mkdtempSync(path.join(os.tmpdir(), "pb4-film-grammar-cost-"));
process.env.PROVIDER_MODE = "live";
process.env.OPENAI_API_KEY = "test-key";
process.env.ELEVENLABS_API_KEY = "test-key";
process.env.PB4_DATA_DIR = path.join(tmp, "data");
process.env.PB4_MEDIA_DIR = path.join(tmp, "media");

const LONG =
  "The submarine struck the rocks at night, far inside the restricted zone. A fisherman saw its shape at dawn and called the navy. Patrol boats arrived within hours, and they sealed the bay. Officers boarded the vessel, questioned the captain, and searched the logbooks. Radiation readings near the torpedo tubes raised a new alarm. Ten days later, the submarine was towed back out to sea.";
const SHORT = "A submarine ran aground inside a restricted zone. A fisherman reported it at dawn. The navy sealed the bay and boarded it. Ten days later it was towed away.";

const h = vi.hoisted(() => ({
  imageCalls: [] as string[],
  archiveCalls: 0,
  motionCalls: 0,
  coverageCalls: 0,
  editorCalls: 0,
  editorInput: "" as string,
  failure: "" as "" | "candidateRejected" | "shortAllInvalid" | "missingSlot" | "duplicateSlot" | "unknownSlot" | "unknownPresentation" | "v2dAnswer",
  // Deterministic word timings from the text itself (about 0.3s a word).
  timed: (text: string) => {
    let t = 0.2;
    const words = text.replace(/\s+/g, " ").trim().split(" ").map((w) => {
      const dur = 0.16 + 0.03 * w.length;
      const out = { word: w, start: t, end: t + dur };
      t += dur + (/[.!?]$/.test(w) ? 0.4 : /[,;:]$/.test(w) ? 0.18 : 0.04);
      return out;
    });
    return { durationSec: (words.at(-1)?.end ?? 0) + 0.4, words };
  },
}));

vi.mock("../src/production/research.ts", () => ({
  researchStory: vi.fn(async () => ({
    summary: "S",
    moments: [{ title: "m", detail: "d" }],
    sources: [],
    facts: [{ fact: "A concrete verified fact.", sourceTitle: "src", sourceUrl: "https://example.org" }],
    productionNote: "",
    world: { period: "1981", place: "X", palette: "p", visualDirection: "v", recurringPeople: [], recurringLocations: [], referenceImages: [] },
  })),
}));

vi.mock("../src/production/scripts.ts", () => ({
  writeScript: vi.fn(async (_s: unknown, _r: unknown, kind: string) => (kind === "long" ? LONG : SHORT)),
  auditScripts: vi.fn(async (_s: unknown, _r: unknown, drafts: { long: string; short: string }) => drafts),
}));

vi.mock("../src/production/narration.ts", () => ({
  recordNarration: vi.fn(async (_slug: string, kind: string, text: string) => ({ audioRel: `audio/${kind}.mp3`, audioMediaRel: `m/${kind}`, ...h.timed(text) })),
}));

// The two planning calls, told apart by schemaName. Coverage: the Long library is a
// reconstruction with elements left/center/right (L00), a graphic (L01), an archive
// asset whose acquisition fails and so generates its reconstruction fallback (L02),
// and a reconstruction the Editor never uses (L03). The Short library is one used
// reconstruction (S00) and one unused (S01). "candidateRejected" adds invalid,
// motion-capable candidates (last in the Long, first in the Short): they are
// discarded before the Editor, so the ids above are unchanged. "shortAllInvalid"
// makes every Short candidate invalid. The Long has six single-beat slots:
// L00 base, L00 detail-left, L01, L02, L00 detail-right, L00 base again. The Short
// has four: S00 base, detail-center, detail-left, base again.
vi.mock("../src/providers/openai.ts", async () => {
  const { mkdirSync, writeFileSync } = await import("node:fs");
  const nodePath = await import("node:path");
  const { minimalAsset } = await import("./slotPlan.ts");
  const regions = [{ description: "rocks beneath the hull", region: "left" }, { description: "grounded submarine", region: "center" }, { description: "patrol boat", region: "right" }];
  const a = (slotId: number, presentationId: string, motionPriority = 0) => ({ slotId, presentationId, motionPriority });
  const rejected = (n: number) => minimalAsset({ purpose: `Rejected candidate ${n}.`, mustShow: [{ description: "naval or coast guard vessel", region: "right" }], motionCapable: true });
  return {
    respondJson: vi.fn(async (opts: { schemaName?: string; input?: string }) => {
      if (opts.schemaName === "coverage_plan") {
        h.coverageCalls++;
        return {
          longAssets: [
            minimalAsset({ mustShow: regions, motionCapable: true }),
            minimalAsset({ truth: "graphic", purpose: "Show the bay and the grounding site." }),
            minimalAsset({ truth: "archive", archiveQuery: "U 137 aground 1981" }),
            minimalAsset({ purpose: "An asset the Editor never uses." }),
            ...(h.failure === "candidateRejected" ? [rejected(1)] : []),
          ],
          shortAssets:
            h.failure === "shortAllInvalid"
              ? [rejected(2), rejected(3)]
              : [...(h.failure === "candidateRejected" ? [rejected(2)] : []), minimalAsset({ mustShow: regions }), minimalAsset({ purpose: "Unused in the Short." })],
        };
      }
      h.editorCalls++;
      h.editorInput = String(opts.input);
      if (h.failure === "v2dAnswer") {
        const v2d = (slotId: number) => ({ slotId, edit: "new", framing: "wide", truth: "reconstruction", wantsMotion: false, sourceSlotId: -1, sourceElementIndex: -1 });
        return { long: [0, 1, 2, 3, 4, 5].map(v2d), short: [0, 1, 2, 3].map(v2d) };
      }
      let long = [a(0, "L00:base"), a(1, "L00:detail-left"), a(2, "L01:base"), a(3, "L02:base"), a(4, "L00:detail-right"), a(5, "L00:base")];
      if (h.failure === "missingSlot") long = long.filter((x) => x.slotId !== 4);
      if (h.failure === "duplicateSlot") long = [...long, a(2, "L01:base")];
      if (h.failure === "unknownSlot") long = [...long, a(6, "L00:base")];
      if (h.failure === "unknownPresentation") long = long.map((x) => (x.slotId === 2 ? a(2, "L01:detail-left") : x));
      const short = [a(0, "S00:base"), a(1, "S00:detail-center"), a(2, "S00:detail-left"), a(3, "S00:base")];
      return { long, short };
    }),
    imageMimeType: () => "image/png",
    generateImageFile: vi.fn(async (opts: { outPath: string }) => {
      h.imageCalls.push(opts.outPath);
      mkdirSync(nodePath.dirname(opts.outPath), { recursive: true });
      writeFileSync(opts.outPath, "img");
    }),
  };
});

vi.mock("../src/production/wikimedia.ts", () => ({
  fetchArchive: vi.fn(async () => {
    h.archiveCalls++;
    return null;
  }),
}));
vi.mock("../src/providers/runway.ts", () => ({
  generateMotion: vi.fn(async () => {
    h.motionCalls++;
  }),
}));

const { runJob, newJobId } = await import("../src/production/generate.ts");
const { createJob, getJob, updateJob, upsertStory } = await import("../src/server/store.ts");
const { PRICING, round, ttsUsd } = await import("../src/server/pricing.ts");
const { ensureStoryDirs } = await import("../src/production/paths.ts");

let n = 0;
function makeStory(): Story {
  const slug = `film-grammar-cost-${n++}`;
  const story: Story = {
    id: slug, slug, title: "Test Story", hook: "A hook.", category: "Disasters", year: "1981", place: "Somewhere",
    summary: "A summary.", heroImage: null, moments: [{ title: "m", detail: "d" }], sources: [], productionNote: "", createdAt: new Date().toISOString(),
  };
  upsertStory(story);
  return story;
}

// Everything before visual planning: research, three script calls and narration.
const TEXT = () => PRICING.openai.research + 3 * PRICING.openai.script + ttsUsd(LONG.length) + ttsUsd(SHORT.length);

beforeEach(() => {
  h.imageCalls.length = 0;
  h.archiveCalls = 0;
  h.motionCalls = 0;
  h.coverageCalls = 0;
  h.editorCalls = 0;
  h.editorInput = "";
  h.failure = "";
});

describe("Film Grammar v2E spend", () => {
  test("each unique used asset is acquired once: reuse, detail crops and repeats add zero image cost", async () => {
    const story = makeStory();
    const job = createJob({ id: newJobId(), storyId: story.id, mock: false, estimatedCost: 5, approvedMax: 15 });
    await runJob(job.id, { autoApproveText: true }); // stops at the preview gate

    const done = getJob(job.id)!;
    expect(done.state).toBe("awaiting_preview");
    expect([h.coverageCalls, h.editorCalls]).toEqual([1, 1]);
    const s = done.scratch as any;
    expect([s.longShots.length, s.shortShots.length]).toEqual([6, 4]); // one planned shot per slot
    const all = [...s.longShots, ...s.shortShots];
    const owners = all.filter((e: any) => e.edit === "new");
    expect(owners.map((e: any) => e.assetId)).toEqual(["L00", "L01", "L02", "S00"]); // unused L03 / S01 never planned
    expect(all.some((e: any) => e.assetId === "L03" || e.assetId === "S01")).toBe(false);
    expect(s.longShots[1]).toMatchObject({ edit: "reuse", assetId: "L00", presentation: "detail-left", framing: "detail-left", focus: "rocks beneath the hull", assetShot: 0 });
    expect(s.longShots[5]).toMatchObject({ edit: "reuse", assetId: "L00", presentation: "base", assetShot: 0 });

    // One image per unique used asset (the archive one via its reconstruction fallback), plus the master.
    expect(h.imageCalls.length).toBe(owners.length + 1);
    expect(h.imageCalls.filter((p) => /hero\.png$/.test(p))).toHaveLength(1);
    expect(h.archiveCalls).toBeGreaterThan(0);
    for (const film of [s.longShots, s.shortShots]) {
      for (const r of film.filter((e: any) => e.edit === "reuse")) expect(r.path).toBe(film[r.assetShot].path); // resolved without a provider call
    }
    expect(new Set(s.longShots.map((e: any) => e.path)).size).toBe(3);

    expect(done.spent).toBe(round(TEXT() + 2 * PRICING.openai.visualPlan + (owners.length + 1) * PRICING.openai.image));
    expect(done.preview).toMatchObject({ moments: 10, uniqueAssets: 4, reusedPresentations: 6, archive: 0, reconstruction: 3, graphic: 1, motionSelected: 0 });
    expect(h.motionCalls).toBe(0);
  });

  test("rejected Coverage candidates are recorded and never reach the Editor, acquisition, motion or spend", async () => {
    h.failure = "candidateRejected";
    const story = makeStory();
    const job = createJob({ id: newJobId(), storyId: story.id, mock: false, estimatedCost: 5, approvedMax: 15 });
    await runJob(job.id, { autoApproveText: true }); // stops at the preview gate

    const done = getJob(job.id)!;
    expect(done.state).toBe("awaiting_preview");
    expect([h.coverageCalls, h.editorCalls]).toEqual([1, 1]);
    const s = done.scratch as any;
    const reason = 'mustShow[0] "naval or coast guard vessel" is an either/or element; each element must be one concrete visible thing';
    expect(s.coverageRejected).toEqual([{ film: "long", index: 4, reason }, { film: "short", index: 0, reason }]);
    expect(h.editorInput).not.toMatch(/Rejected candidate|coast guard/);
    expect(h.editorInput).toMatch(/LONG MEDIA LIBRARY \(4 assets/);
    expect(h.editorInput).toMatch(/SHORT MEDIA LIBRARY \(2 assets/);
    const all = [...s.longShots, ...s.shortShots];
    expect(all.some((e: any) => /Rejected candidate/.test(e.purpose))).toBe(false);
    // Short ids were assigned after filtering: S00 is the valid reconstruction with regions, so its details exist.
    expect(s.shortShots[1]).toMatchObject({ assetId: "S00", presentation: "detail-center", focus: "grounded submarine" });
    // Exactly the spend, images and motion of the same job without the rejected candidates.
    expect(all.filter((e: any) => e.edit === "new").map((e: any) => e.assetId)).toEqual(["L00", "L01", "L02", "S00"]);
    expect(h.imageCalls.length).toBe(5);
    expect(h.motionCalls).toBe(0);
    expect(done.spent).toBe(round(TEXT() + 2 * PRICING.openai.visualPlan + 5 * PRICING.openai.image));
  });

  test("a Coverage answer with zero valid Short candidates stops before the Editor; only the Coverage call is charged", async () => {
    h.failure = "shortAllInvalid";
    const story = makeStory();
    const job = createJob({ id: newJobId(), storyId: story.id, mock: false, estimatedCost: 5, approvedMax: 15 });
    await expect(runJob(job.id, { autoApproveText: true })).rejects.toThrow(/^Invalid coverage plan: short has no valid candidates \(2 proposed, all rejected: #0 mustShow\[0\] "naval or coast guard vessel" is an either\/or element/);

    const after = getJob(job.id)!;
    expect(after.state).toBe("failed");
    expect([h.coverageCalls, h.editorCalls]).toEqual([1, 0]);
    expect(h.imageCalls.length + h.archiveCalls + h.motionCalls).toBe(0); // not even the master
    expect(after.spent).toBe(round(TEXT() + PRICING.openai.visualPlan));
    expect((after.scratch as any).longShots).toBeUndefined(); // nothing invalid is stored
  });

  test.each([
    ["a missing slot", "missingSlot", /^Invalid edit plan: long is missing an assignment for slot 4; every slot gets exactly one assignment\.$/],
    ["a duplicate slot", "duplicateSlot", /^Invalid edit plan: long item 6: slotId 2 is duplicated/],
    ["an unknown slot", "unknownSlot", /^Invalid edit plan: long item 6: slotId 6 is unknown \(slots are 0-5\)\.$/],
    ["an unknown presentation", "unknownPresentation", /^Invalid edit plan: long slot 2 \(beats 2-2, \d\.\d\ds\): presentationId "L01:detail-left" is not a legal long presentation\.$/],
    ["an old v2D per-slot decision", "v2dAnswer", /^Invalid edit plan: long slot 0 \(beats 0-0, \d\.\d\ds\): presentationId null is not a legal long presentation\.$/],
  ] as const)("an Editor answer with %s fails before any acquisition; both planning calls are charged", async (_name, flag, reason) => {
    h.failure = flag;
    const story = makeStory();
    const job = createJob({ id: newJobId(), storyId: story.id, mock: false, estimatedCost: 5, approvedMax: 15 });
    await expect(runJob(job.id, { autoApproveText: true })).rejects.toThrow(reason);

    const after = getJob(job.id)!;
    expect(after.state).toBe("failed");
    expect([h.coverageCalls, h.editorCalls]).toEqual([1, 1]);
    expect(h.imageCalls.length + h.archiveCalls + h.motionCalls).toBe(0);
    expect(after.spent).toBe(round(TEXT() + 2 * PRICING.openai.visualPlan));
    expect((after.scratch as any).longShots).toBeUndefined();
  });

  test("a finished job is never touched: no planning, no media, no change", async () => {
    const story = makeStory();
    const job = createJob({ id: newJobId(), storyId: story.id, mock: false, estimatedCost: 5, approvedMax: 15 });
    const scratch = { scripts: { long: LONG, short: SHORT }, textApproved: true, spent: 10.13 };
    updateJob(job.id, { state: "done", scratch: scratch as any, spent: 10.13 });
    const before = getJob(job.id)!;

    await runJob(job.id, { autoApproveText: true, autoApprovePreview: true });

    expect(getJob(job.id)).toEqual(before);
    expect(h.coverageCalls + h.editorCalls + h.imageCalls.length + h.archiveCalls + h.motionCalls).toBe(0);
  });

  test("an old v1 plan is refused on resume with a rebuild message, before any spend", async () => {
    const story = makeStory();
    ensureStoryDirs(story.slug);
    const job = createJob({ id: newJobId(), storyId: story.id, mock: false, estimatedCost: 5, approvedMax: 15 });
    const v1Shot = (index: number) => ({ index, truth: "reconstruction", motion: "hold", wantsMotion: false, prompt: "p", purpose: "x", mustShow: [], mustNotShow: [], wordStart: 0, wordEnd: 1 });
    const scratch = {
      research: { summary: "S", moments: [], sources: [], facts: [], productionNote: "", world: { period: "1981", place: "X", palette: "p", visualDirection: "v", recurringPeople: [], recurringLocations: [], referenceImages: [] } },
      scripts: { long: LONG, short: SHORT },
      textApproved: true,
      narration: { long: { audioRel: "audio/long.mp3", audioMediaRel: "m", ...h.timed(LONG) }, short: { audioRel: "audio/short.mp3", audioMediaRel: "m", ...h.timed(SHORT) } },
      longShots: [v1Shot(0), v1Shot(1)],
      shortShots: [v1Shot(0)],
      masterRef: "images/hero.png",
      spent: 2.5,
    };
    updateJob(job.id, { scratch: scratch as any, spent: 2.5 });

    await expect(runJob(job.id)).rejects.toThrow(/before Film Grammar v2E.*Rebuild the visuals/);
    const after = getJob(job.id)!;
    expect(after.state).toBe("failed");
    expect(after.spent).toBe(2.5);
    expect(h.imageCalls.length).toBe(0);
    expect(h.archiveCalls).toBe(0);
  });
});
