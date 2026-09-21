import crypto from "node:crypto";
import { config } from "../server/config.ts";
import { respondJson } from "../providers/openai.ts";
import { listStories, storyExistsByTitle, upsertStory } from "../server/store.ts";
import { now } from "../server/db.ts";
import { CATEGORIES, type Category, type Story } from "../types.ts";
import type { ResearchPackage, StoryWorld } from "./pipelineTypes.ts";
import { paulBunyanResearch } from "./fixtures/paulBunyan.ts";
import { ensureStoryDirs, inStory, mediaRel } from "./paths.ts";
import { writePlaceholderStill } from "./mockAssets.ts";
import { existsSync } from "node:fs";

// ---- Find stories (Stories screen discovery) ----

export interface FindResult {
  added: string[];
  note: string;
}

export async function findStories(query: string): Promise<FindResult> {
  if (config.mode !== "live") {
    return { added: [], note: "Story discovery runs on live research. Set PROVIDER_MODE=live (with an OpenAI key) to find new stories. Meanwhile, search the curated stories below." };
  }

  const existing = listStories().map((s) => s.title);
  const found = await respondJson<{ candidates: RawCandidate[] }>({
    instructions: FIND_INSTRUCTIONS,
    input: `SEARCH: ${query}\n\nDo not repeat any of these existing titles:\n${existing.join("\n")}`,
    schemaName: "candidates",
    schema: FIND_SCHEMA,
    webSearch: true,
  });

  const added: string[] = [];
  for (const c of found.candidates) {
    if (storyExistsByTitle(c.title)) continue;

    // Fact-check the central claim before saving. "supported" keeps the premise
    // (wording may be tidied); "rewrite" replaces the exaggerated/disputed claim
    // with a defensible one; "reject" is discarded.
    const v = await verifyCandidate(c);
    if (v.verdict === "reject") continue;

    const title = v.title.trim() || c.title;
    if (storyExistsByTitle(title)) continue; // a rewrite may land on an existing title
    const category = (CATEGORIES as readonly string[]).includes(c.category) ? (c.category as Category) : "Strange Everyday History";
    const slug = slugify(title);
    ensureStoryDirs(slug);
    const heroAbs = inStory(slug, "images/hero.png");
    if (!existsSync(heroAbs)) writePlaceholderStill(heroAbs, { width: 1600, height: 900, index: slug.length, label: title, truth: category, accent: "#d9a066" });
    const story: Story = {
      id: crypto.randomUUID(),
      slug,
      title,
      hook: v.hook.trim() || c.hook,
      category,
      year: c.year,
      place: c.place,
      summary: v.summary.trim() || c.summary,
      heroImage: mediaRel(slug, "images/hero.png"),
      moments: v.moments.length ? v.moments : c.moments,
      sources: v.sources.length ? v.sources : c.sources,
      productionNote: v.productionNote.trim() || c.productionNote || "",
      createdAt: now(),
    };
    upsertStory(story);
    added.push(story.title);
  }
  return { added, note: added.length ? `Found ${added.length} new ${added.length === 1 ? "story" : "stories"}.` : "No new stories this time - try a different search." };
}

// Verify one candidate's central claim against reliable sources before saving.
type Verdict = "supported" | "rewrite" | "reject";
interface VerifyResult {
  verdict: Verdict;
  reason: string;
  title: string;
  hook: string;
  summary: string;
  moments: { title: string; detail: string }[];
  sources: { title: string; url: string; note: string }[];
  productionNote: string;
}

async function verifyCandidate(c: RawCandidate): Promise<VerifyResult> {
  return respondJson<VerifyResult>({
    instructions: VERIFY_INSTRUCTIONS,
    input: [
      `TITLE: ${c.title}`,
      `HOOK: ${c.hook}`,
      `SUMMARY: ${c.summary}`,
      `MOMENTS: ${JSON.stringify(c.moments)}`,
      `SOURCES: ${JSON.stringify(c.sources)}`,
    ].join("\n"),
    schemaName: "verification",
    schema: VERIFY_SCHEMA,
    webSearch: true,
  });
}

// ---- Recheck one saved story (Story page) ----

export interface RecheckResult {
  verdict: Verdict;
  reason: string;
  story: Story;
}

// Run an already-saved story back through the same candidate verifier. "rewrite"
// saves the corrected facts; "supported" and "reject" leave the story untouched.
export async function recheckStory(story: Story): Promise<RecheckResult> {
  if (config.mode !== "live") {
    throw new Error("Switch Provider mode to Live in Config to recheck this story.");
  }
  const v = await verifyCandidate(story);
  if (v.verdict !== "rewrite") return { verdict: v.verdict, reason: v.reason, story };

  const updated: Story = {
    ...story,
    title: v.title.trim() || story.title,
    hook: v.hook.trim() || story.hook,
    summary: v.summary.trim() || story.summary,
    moments: v.moments.length ? v.moments : story.moments,
    sources: v.sources.length ? v.sources : story.sources,
  };
  upsertStory(updated);
  return { verdict: v.verdict, reason: v.reason, story: updated };
}

// ---- Deep research for a chosen story (generate pipeline) ----

export async function researchStory(story: Story): Promise<ResearchPackage> {
  if (story.slug === "paul-bunyan") return paulBunyanResearch;

  if (config.mode !== "live") {
    return { summary: story.summary, moments: story.moments, sources: story.sources, productionNote: story.productionNote, world: worldFromStory(story) };
  }

  const pkg = await respondJson<ResearchPackage>({
    instructions: RESEARCH_INSTRUCTIONS,
    input: `STORY: ${story.title}\nYEAR: ${story.year}\nPLACE: ${story.place}\nHOOK: ${story.hook}\nSUMMARY: ${story.summary}`,
    schemaName: "research",
    schema: RESEARCH_SCHEMA,
    webSearch: true,
  });
  // Persist verified facts back onto the story.
  upsertStory({ ...story, summary: pkg.summary, moments: pkg.moments, sources: pkg.sources, productionNote: pkg.productionNote });
  return pkg;
}

function worldFromStory(s: Story): StoryWorld {
  return {
    period: s.year,
    place: s.place,
    palette: "restrained, period-accurate, low contrast",
    visualDirection: `Sober historical documentary reconstruction of ${s.title}. ${s.productionNote}`.trim(),
    recurringPeople: [],
    recurringLocations: [s.place].filter(Boolean),
    referenceImages: [],
  };
}

export function slugify(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "").slice(0, 60) || crypto.randomUUID().slice(0, 8);
}

// ---- Prompts / schemas (live only) ----

const FIND_INSTRUCTIONS = `You find ENTERTAINING true historical stories for PastBriefly: "true historical stories that sound made up." The audience is broad, especially 18-44, and does NOT already care about history. The premise itself must carry the curiosity.

THE ZERO-CONTEXT TEST (apply to every candidate): if you told the premise in one sentence to a 25-year-old who knows nothing about the people, the war, the country, the politics or the period, would they immediately want to hear the rest? If not, drop it. A good candidate can be understood in one sentence, sounds unusual even without historical knowledge, has an obvious visual opening, escalates to a reveal or payoff, and has enough reliable material for both a Short and a 6-10 minute documentary.

WANT: an instantly understandable bizarre premise with a strong "wait, that actually happened?" reaction - escalation, twist, irony, deception, escape, disaster or absurdity, with real stakes. Shapes we love (do NOT copy these; match their SHAPE): a warship disguised itself as an island to escape; two countries nearly went to war over a pig; a city was hit by a deadly wave of molasses; a corpse with fake documents was used to deceive Nazi Germany; an army mobilized soldiers and aircraft to cut down one tree; an ancient customer wrote an angry complaint about bad copper.

Bias the mix toward: strange military operations, bizarre diplomatic incidents, espionage and deception, scams and financial disasters, unusual escapes, engineering disasters, weird legal or commercial disputes, unbelievable survival stories, historical hoaxes, accidental catastrophes, and strange everyday history with real stakes.

AVOID ordinary biography and significance stories - "Person X played an important role in Event Y", "Person X contributed intelligence to Battle Y", "Person X was an influential politician/general/scientist", "an important invention was created", "a famous battle happened", "a significant person overcame adversity" - UNLESS the central premise itself is bizarre, cinematic, counterintuitive or immediately surprising. The problem with these is that the viewer needs historical context before the story becomes interesting; PastBriefly stories must work BEFORE the context. Do not fill the results with biographies.

TITLE: the title must state the unbelievable thing in plain English so a viewer understands the premise in about two seconds. Apply this title test to every candidate: (1) can someone understand what happened without knowing any names, places or historical context; (2) is the strange EVENT itself stated clearly in the title; (3) is it plain language, not article or documentary phrasing; (4) would it make instant sense to a 20-30 year old scrolling YouTube; (5) is it still factually accurate and not exaggerated. If any answer is no, rewrite the title before returning the candidate. Prefer "A Town Was Buried So Deep People Dug Tunnels Through the Snow" over "The 1917 Snow Tunnels of Cordova"; "Shipwreck Survivors Lived on Penguins and Eggs" over "Shipwrecked on the Island of Desolation"; "An Oil Tanker Exploded While Refueling in Los Angeles Harbor" over "The SS Sansinena's Explosive Fire on the Water" - these show STYLE only, so do not force these exact words unless historically accurate. Avoid title shapes like "The Story of…", "The Role of…", "How X Reshaped Y", "The Incident at…", "The Disaster of…", "The Strategic Importance of…", "Survival on…", and using unfamiliar proper or ship names as the main hook; proper names may appear when they help, but the strange event should carry the title.

HOOK: the hook adds the next layer of curiosity - why it gets even stranger or what happened next. Do not make the title vague and hide the premise in the hook; the title is the instantly understandable premise, the hook is the escalation.

Return the strongest TRUE version of the premise in concrete language, not academic framing - e.g. "A Dutch Warship Escaped by Disguising Itself as an Island" over "The Strategic Role of HNLMS Abraham Crijnssen in the Dutch East Indies". Truth is mandatory and truth alone is not enough - but do not manufacture drama or exaggerate facts; the verifier will catch unsupported claims. Use reputable sources (museums, government, archives, academic or strong secondary). Never invent citations. Return 3-5 candidates as strict JSON.`;

const VERIFY_INSTRUCTIONS = `You are a historical fact-checker for PastBriefly. Given one discovered story candidate (title, hook, summary, key moments, sources), use web search to determine whether its CENTRAL surprising claim is actually supported by reliable sources.

Prefer museums, national archives, government sources, universities, academic publications, established historical institutions, and strong reputable secondary sources. Do NOT treat unsourced blogs, copied trivia pages, SEO history sites, social posts, or conspiracy material as sufficient evidence for the central claim. A candidate should ideally have at least two credible supporting sources when practical. Never invent citations.

Choose a verdict:
- "supported": the central hook is directly supported by credible historical sources. Keep the premise intact; you may clean up wording.
- "rewrite": there is a real story underneath, but the original hook exaggerates, simplifies, or presents a disputed claim as fact. Rewrite the title, hook, summary and moments so the surprising claim itself becomes historically defensible - do not preserve the sensational version merely because it sounds better.
- "reject": the central premise is false, legendary, poorly evidenced, or depends mainly on conspiracy/myth. Discard it.

Always return title, hook, summary, moments, sources and productionNote reflecting the verified (possibly rewritten) story, plus a short reason. Return strict JSON.`;

const RESEARCH_INSTRUCTIONS = `You research one historical story for a documentary. Return a concise summary, the key story moments in order, reliable cited sources (museums, government, archives, academic, strong secondary - never invented), a short production note, and a small visual world (period, place, palette, visual direction). Return strict JSON.`;

const momentSchema = { type: "object", additionalProperties: false, required: ["title", "detail"], properties: { title: { type: "string" }, detail: { type: "string" } } };
const sourceSchema = { type: "object", additionalProperties: false, required: ["title", "url", "note"], properties: { title: { type: "string" }, url: { type: "string" }, note: { type: "string" } } };

const FIND_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["candidates"],
  properties: {
    candidates: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["title", "hook", "category", "year", "place", "summary", "moments", "sources", "productionNote"],
        properties: {
          title: { type: "string" },
          hook: { type: "string" },
          category: { type: "string", enum: CATEGORIES as unknown as string[] },
          year: { type: "string" },
          place: { type: "string" },
          summary: { type: "string" },
          moments: { type: "array", items: momentSchema },
          sources: { type: "array", items: sourceSchema },
          productionNote: { type: "string" },
        },
      },
    },
  },
};

const VERIFY_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["verdict", "reason", "title", "hook", "summary", "moments", "sources", "productionNote"],
  properties: {
    verdict: { type: "string", enum: ["supported", "rewrite", "reject"] },
    reason: { type: "string" },
    title: { type: "string" },
    hook: { type: "string" },
    summary: { type: "string" },
    moments: { type: "array", items: momentSchema },
    sources: { type: "array", items: sourceSchema },
    productionNote: { type: "string" },
  },
};

const RESEARCH_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["summary", "moments", "sources", "productionNote", "world"],
  properties: {
    summary: { type: "string" },
    moments: { type: "array", items: momentSchema },
    sources: { type: "array", items: sourceSchema },
    productionNote: { type: "string" },
    world: {
      type: "object",
      additionalProperties: false,
      required: ["period", "place", "palette", "visualDirection", "recurringPeople", "recurringLocations", "referenceImages"],
      properties: {
        period: { type: "string" },
        place: { type: "string" },
        palette: { type: "string" },
        visualDirection: { type: "string" },
        recurringPeople: { type: "array", items: { type: "string" } },
        recurringLocations: { type: "array", items: { type: "string" } },
        referenceImages: { type: "array", items: { type: "string" } },
      },
    },
  },
};

interface RawCandidate {
  title: string;
  hook: string;
  category: string;
  year: string;
  place: string;
  summary: string;
  moments: { title: string; detail: string }[];
  sources: { title: string; url: string; note: string }[];
  productionNote?: string;
}
