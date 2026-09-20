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
    const category = (CATEGORIES as readonly string[]).includes(c.category) ? (c.category as Category) : "Strange Everyday History";
    const slug = slugify(c.title);
    ensureStoryDirs(slug);
    const heroAbs = inStory(slug, "images/hero.png");
    if (!existsSync(heroAbs)) writePlaceholderStill(heroAbs, { width: 1600, height: 900, index: slug.length, label: c.title, truth: category, accent: "#d9a066" });
    const story: Story = {
      id: crypto.randomUUID(),
      slug,
      title: c.title,
      hook: c.hook,
      category,
      year: c.year,
      place: c.place,
      summary: c.summary,
      heroImage: mediaRel(slug, "images/hero.png"),
      moments: c.moments,
      sources: c.sources,
      productionNote: c.productionNote ?? "",
      createdAt: now(),
    };
    upsertStory(story);
    added.push(story.title);
  }
  return { added, note: added.length ? `Found ${added.length} new ${added.length === 1 ? "story" : "stories"}.` : "No new stories this time — try a different search." };
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

const FIND_INSTRUCTIONS = `You find TRUE historical stories that sound made up — the PastBriefly promise. Prefer concrete, surprising, well-documented episodes with a strong hook, a real explanation, and a meaningful payoff (like Operation Paul Bunyan, the complaint to Ea-nasir, the fall of Barings, the Pig War, the Boston Molasses Flood). Avoid generic trivia and anything poorly sourced. Use reputable sources (museums, government, archives, academic or strong secondary). Never invent citations. Return 3-5 candidates as strict JSON.`;

const RESEARCH_INSTRUCTIONS = `You research one historical story for a documentary. Return a concise summary, the key story moments in order, reliable cited sources (museums, government, archives, academic, strong secondary — never invented), a short production note, and a small visual world (period, place, palette, visual direction). Return strict JSON.`;

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
