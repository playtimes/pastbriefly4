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

// Run an already-saved story back through the same candidate verifier. "reject"
// leaves the story untouched; "supported" and "rewrite" both save the verifier's
// normalized editorial fields (a "supported" verdict may still tidy a badly
// worded but historically correct title/hook into clearer PastBriefly language).
export async function recheckStory(story: Story): Promise<RecheckResult> {
  if (config.mode !== "live") {
    throw new Error("Switch Provider mode to Live in Config to recheck this story.");
  }
  const v = await verifyCandidate(story);
  if (v.verdict === "reject") return { verdict: v.verdict, reason: v.reason, story };

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
    return { summary: story.summary, moments: story.moments, sources: story.sources, facts: [], productionNote: story.productionNote, world: worldFromStory(story) };
  }

  const draft = await respondJson<ResearchPackage>({
    instructions: RESEARCH_INSTRUCTIONS,
    input: `STORY: ${story.title}\nYEAR: ${story.year}\nPLACE: ${story.place}\nHOOK: ${story.hook}\nSUMMARY: ${story.summary}`,
    schemaName: "research",
    schema: RESEARCH_SCHEMA,
    webSearch: true,
  });

  // Integrity audit: a second web-search pass fact-checks the draft, downgrading
  // inference-as-fact and disputed claims to attributed wording and dropping
  // sources whose URL cannot be verified.
  const audited = await respondJson<ResearchPackage>({
    instructions: RESEARCH_AUDIT_INSTRUCTIONS,
    input: `STORY: ${story.title}\nYEAR: ${story.year}\nPLACE: ${story.place}\nHOOK: ${story.hook}\n\nDRAFT RESEARCH TO AUDIT:\n${JSON.stringify(draft, null, 2)}`,
    schemaName: "research_audit",
    schema: RESEARCH_SCHEMA,
    webSearch: true,
  });

  // Final fact verification: a narrow third web-search pass. Not another rewrite -
  // it checks every concrete date, location, actor, action, sequence, measurement
  // and attribution in the audited package against the strongest available
  // sources, correcting to the stronger source on conflict and keeping separate
  // events separate. The conservative research charge in pricing.ts covers all
  // three of these calls.
  const pkg = await respondJson<ResearchPackage>({
    instructions: RESEARCH_VERIFY_INSTRUCTIONS,
    input: `STORY: ${story.title}\nYEAR: ${story.year}\nPLACE: ${story.place}\nHOOK: ${story.hook}\n\nAUDITED RESEARCH TO VERIFY:\n${JSON.stringify(audited, null, 2)}`,
    schemaName: "research_verify",
    schema: RESEARCH_SCHEMA,
    webSearch: true,
  });

  // Persist the final verified facts (never the draft or the pre-verification
  // audit) back onto the story.
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

TITLE: the title must state the unbelievable EVENT in plain English so a viewer understands the premise in about two seconds, without knowing any people, ships, wars, countries, military classes, organizations or historical nicknames. Prefer ordinary words over specialist terminology, and never let the title depend on a nickname or a proper noun to make sense. Prefer the SHORTEST plain-English title that still communicates the bizarre event: context that the film itself can explain (a period, a war, a wider consequence) should usually not be appended to the title. Apply this title test to every candidate: (1) can someone understand what happened without knowing any names, places or historical context; (2) is the strange EVENT itself stated clearly, in plain language, not article or documentary phrasing; (3) does it avoid unnecessary dates; (4) does it avoid an explanatory subtitle joined on with a comma; (5) would it make instant sense to a 20-30 year old scrolling YouTube; (6) is it still factually accurate and not exaggerated; (7) is it the shortest version that still conveys the event, with no period or context phrase added that the film can explain. If any answer is no, rewrite the title before returning the candidate. Do not mechanically strip useful context, but do not add period or context phrases when the event already makes sense without them: prefer "A Soviet Submarine Got Stuck in Sweden" over "A Soviet Submarine Got Stuck in Sweden During the Cold War", and over "Soviet Whiskey-class Submarine Runs Aground in Sweden, Triggering 'Whiskey on the Rocks' Incident"; "A Town Was Buried So Deep People Dug Tunnels Through the Snow" over "The 1917 Snow Tunnels of Cordova"; "An Army Sent Hundreds of Soldiers to Cut Down One Tree" over "The Strategic Importance of Operation Paul Bunyan" - these show STYLE only, so do not force these exact words unless historically accurate. Avoid title shapes like "The Story of…", "The Role of…", "How X Reshaped Y", "The Incident at…", "The Disaster of…", "The Strategic Importance of…", "Survival on…", and using unfamiliar proper or ship names or event nicknames as the main hook; proper names may appear when they help, but the strange event should carry the title.

HOOK: the hook adds the next layer of curiosity - why it gets even stranger or what happened next. Do not make the title vague and hide the premise in the hook; the title is the instantly understandable premise, the hook is the escalation. The hook must describe concrete actions or consequences - what someone actually did, or what actually happened next - not an abstract label for it. Avoid summary phrases such as "diplomatic crisis", "international incident", "dramatic standoff", "tensions escalated" or "major political consequences" when the same idea can be shown through what concretely happened. Prefer a shape like "A Soviet submarine got stuck near a Swedish naval base. Sweden surrounded it, and the Soviets wanted it back." over "It triggered a dramatic Cold War standoff and diplomatic crisis."

Return the strongest TRUE version of the premise in concrete language, not academic framing - e.g. "A Dutch Warship Escaped by Disguising Itself as an Island" over "The Strategic Role of HNLMS Abraham Crijnssen in the Dutch East Indies". Truth is mandatory and truth alone is not enough - but do not manufacture drama or exaggerate facts; the verifier will catch unsupported claims. Use reputable sources (museums, government, archives, academic or strong secondary). Never invent citations. Return 3-5 candidates as strict JSON.`;

const VERIFY_INSTRUCTIONS = `You are a historical fact-checker for PastBriefly. Given one discovered story candidate (title, hook, summary, key moments, sources), use web search to determine whether its CENTRAL surprising claim is actually supported by reliable sources.

Prefer museums, national archives, government sources, universities, academic publications, established historical institutions, and strong reputable secondary sources. Do NOT treat unsourced blogs, copied trivia pages, SEO history sites, social posts, or conspiracy material as sufficient evidence for the central claim. A candidate should ideally have at least two credible supporting sources when practical. Never invent citations.

Choose a verdict:
- "supported": the central hook is directly supported by credible historical sources. Keep the premise and this verdict, but still normalize the title and hook into PastBriefly language (see below).
- "rewrite": there is a real story underneath, but the original hook exaggerates, simplifies, or presents a disputed claim as fact. Rewrite the title, hook, summary and moments so the surprising claim itself becomes historically defensible - do not preserve the sensational version merely because it sounds better.
- "reject": the central premise is false, legendary, poorly evidenced, or depends mainly on conspiracy/myth. Discard it.

TITLE NORMALIZATION (applies to every kept story, including "supported"): a "supported" verdict does NOT mean the wording must stay as written. The returned title must pass the same zero-context, plain-English title test - understandable in about two seconds by someone who knows none of the people, ships, wars, countries, military classes, organizations or historical nicknames involved. If the title contains unexplained jargon, leans on an unfamiliar proper noun, uses an event nickname as its main idea, reads like an article or documentary heading, or the bizarre event could simply be said more plainly, rewrite the title (and the hook if needed) while preserving the facts. Prefer the SHORTEST plain-English title that still conveys the bizarre event, and do not append period or context phrases (like "During the Cold War") that the film itself can explain: prefer "A Soviet Submarine Got Stuck in Sweden" over "A Soviet Submarine Got Stuck in Sweden During the Cold War", and over "Soviet Whiskey-class Submarine Runs Aground in Sweden, Triggering 'Whiskey on the Rocks' Incident". The hook must state concrete actions or consequences, not abstract labels such as "diplomatic crisis", "dramatic standoff", "global diplomatic incident" or "major Cold War crisis" - say what the people or countries actually did instead. Improving the wording never changes the verdict - only the evidence does.

Always return title, hook, summary, moments, sources and productionNote reflecting the verified (possibly rewritten) story, plus a short reason. Return strict JSON.`;

const RESEARCH_INSTRUCTIONS = `You research one historical story for a PastBriefly documentary. The research package must make the eventual script easy to follow, so build a simple causal spine, not an academic summary.

The summary and moments together should form a clear chain: WHAT happened -> WHY it mattered -> WHAT happened next -> WHAT escalated or changed -> HOW it ended. Each step should make the next one make sense.

MOMENTS: return the key events in order, with enough distinct events to support a 7-9 minute long-form film. Aim for roughly 8-12 meaningful moments when the evidence supports them, and never fewer than the strong sources establish. Each moment must be a concrete event or development - real people, actions and places - not an abstract chapter category, and each must be a DISTINCT event or development rather than a rephrasing of another moment. For a chronology such as a grounding, a discovery, a first boarding or contact, a rescue response, containment, interrogation, radiation or technical measurements, an official assessment or public statement, refloating, a seaworthiness decision, departure or handback, and concrete aftermath, treat each as its own moment when the evidence establishes it. Do NOT invent, pad or split trivial details merely to reach a count, and do NOT collapse events that happened on different dates into a single moment. Prefer "Sweden Surrounds the Submarine", "Inspectors Find Something Suspicious", "The Soviets Demand It Back", "Sweden Finally Lets It Leave" over "International Diplomatic Tension", "Technical Inspection and Espionage Suspicion", "Resolution and Soviet Withdrawal". These titles are internal production structure, but they must still describe actual events plainly. In each moment detail, cover one clear event at a time, keep the important cause and effect, name concrete people/actions/places, and explain any specialist term the first time it is needed. Do not write academic summary prose and do not invent drama.

FACT SHEET: also return a "facts" array - the factual spine of the film. Each entry is ONE concrete, production-relevant fact with the strongest source that supports it: { fact, sourceTitle, sourceUrl }. Facts must be concrete, not summaries: include the important dates, actors, locations and sequence (e.g. "U 137 ran aground in Gåsefjärden on 27 October 1981."). For a disputed point, put the attribution INSIDE the fact (e.g. "Swedish authorities assessed that radiation measurements were consistent with possible nuclear-armed torpedoes."). Do not duplicate facts, do not include vague "this caused tensions" filler, and do not invent URLs - each sourceUrl must be one of the real sources you return. Do not create fact IDs or a claim system.

SOURCES: return reliable cited sources (museums, government, archives, academic, strong reputable secondary). Never invent or reconstruct a source URL. Every source URL you return must come directly from an actual web-search result or a page you actually consulted during this research. If you cannot establish the real URL for a source, omit that source rather than guessing - a source title alone is never enough to reconstruct its likely domain or path. Prefer fewer real, verifiable sources over a longer list of questionable ones.

Also return a short production note and a small visual world (period, place, palette, visual direction). Research must stay factual and source-grounded. Return strict JSON.`;

const RESEARCH_AUDIT_INSTRUCTIONS = `You are a historical integrity auditor for PastBriefly. You are given a DRAFT research package (summary, moments, sources, productionNote, visual world) for one story. Use fresh web search to fact-check it, then return a corrected package in the SAME schema. This is the last factual pass before the scripts are written, so the audited package must be trustworthy.

AUDIT EVERY FACTUAL CLAIM: inspect the summary, every moment title and detail, every source, the productionNote, and the factual parts of the visual world (period, place, real people and locations). For each claim ask: is this directly supported by the sources; is an inference being written as fact; is the wording stronger than the evidence; is this disputed; do credible sources conflict; is the date, person, location or action actually supported? Correct or remove claims that fail. Do NOT keep a dramatic claim just because it makes the story better - if it is not supported, weaken it to what the evidence shows or cut it.

DISPUTED HISTORY (critical): when credible evidence disagrees, do NOT manufacture a resolution. Use attributed wording and keep the different kinds of claim separate: observed fact, contemporary allegation or suspicion, official assessment, and later interpretation are not the same thing. Write "Swedish authorities assessed...", "The Soviet crew said...", "A later Swedish inquiry concluded...", "Some researchers have argued..." rather than flattening a contested question into a settled fact. Never write "It was definitely espionage" or "Officials ultimately proved there were no nuclear weapons" unless the available evidence genuinely establishes it. Also remove loose speculative wording such as "accidentally - or perhaps deliberately". Do not falsely balance evidence either: if one conclusion comes from an official inquiry and another from a single later researcher, describe each accurately rather than presenting them as equal.

SOURCE HIERARCHY: when credible sources disagree, rank the evidence roughly as (1) official contemporary documents, government inquiries and archives; (2) primary-source institutional material; (3) major reputable reporting; (4) reputable secondary history; (5) tertiary or reference sources such as encyclopedias. Do not mechanically discard a lower-ranked source, but when two sources conflict on a concrete fact - a date, location, sequence, person, action or measurement - prefer the stronger source or explicitly preserve the disagreement with attributed wording. Do not let Wikipedia, tourism or location pages, blogs or niche news sites override an official source on basic chronology without a clear, stated reason.

CROSS-CHECK BEFORE RETURNING: before returning the audited package, specifically cross-check the dates, the sequence of events, who performed each action, the location, and the attribution across the whole package, so they are internally consistent and match the strongest available sources.

EXPLICIT ACTORS: write each moment detail so the actor is explicit wherever a later script could otherwise misread it. Prefer "Soviet authorities later removed Captain X from command" over "Captain X was removed from command". Do not force an actor onto a fact the evidence leaves unspecified - if who performed an action is genuinely unknown, keep it unspecified rather than guessing - but never leave the actor ambiguous when the evidence does identify them.

SOURCES: every returned source URL must be a URL you actually found or consulted during THIS audit. Never invent or reconstruct a likely URL from a title or domain. If you cannot verify a URL, remove that source. Prefer a small set of strong sources - government or official reports, national archives, museums, universities, reputable major reporting - over many weak ones. Each source note must accurately describe what that source actually supports; do not claim a source supports something it does not.

FACT SHEET: audit the "facts" array like every other claim. Each fact must be concrete and directly supported, with its dates, actors, location and sequence matching the corrected moments and summary. Put attribution inside any disputed fact rather than stating it as settled. Remove duplicates and vague filler, and make sure every sourceUrl is a real source you kept in this package - drop or repoint any fact whose source you removed. Do not add fact IDs or a claim system.

PRESERVE DISTINCT CHRONOLOGY: do not thin the package by merging separately dated events. When the draft (or the evidence) establishes genuinely distinct events - especially events that happened on different dates - keep them as separate moments rather than folding them into one. Auditing is for correcting or removing unsupported claims, not for compressing a well-evidenced chronology; a story with strong sourcing should keep roughly 8-12 distinct moments.

Keep the package usable: preserve the concrete causal spine and the visual world, keep genuinely distinct events (especially those on different dates) as separate moments rather than merging them, and only change what the evidence requires. Return the corrected package as strict JSON in the same schema.`;

const RESEARCH_VERIFY_INSTRUCTIONS = `You are the FINAL FACT VERIFICATION for a PastBriefly research package. You are given an already-audited package (summary, moments, sources, productionNote, visual world). Use fresh web search to verify it against the strongest available sources, then return the corrected package in the SAME schema. This is the last factual pass before the scripts are written.

This is NOT another rewrite. It is a narrow factual verification pass. Do not restyle, re-dramatize or re-summarize the package. Change wording only where a concrete fact is wrong, unsupported, or mis-sequenced.

VERIFY EVERY CONCRETE FACT: check every concrete date, location, actor, action, sequence, measurement and attribution in the package against the strongest available sources. For each, confirm it is actually supported; if it is not, correct it to what the sources show or remove it.

SOURCE PREFERENCE: rank evidence as (1) official documents, government inquiries and archives; (2) primary institutional sources; (3) major reputable contemporary reporting; (4) reputable secondary sources; (5) tertiary or reference sources such as encyclopedias. When a stronger source conflicts with a weaker source on a concrete fact, correct the package to the stronger source unless there is a documented reason not to. Do not let a reference, tourism or blog page override an official chronology.

CHRONOLOGY: build the sequence of events from the strongest sources before returning. Never merge different dates or different events together, and preserve the distinct chronology whenever strong sources establish it - do not drop, thin or fold together separately dated events to shorten the package. If the evidence says a vessel was refloated on one date, inspected for seaworthiness on another, and departed territorial waters on another, keep those as separate events with their own dates - do not collapse them into one. Where the strong sources establish a rich sequence, the verified package should keep roughly 8-12 distinct moments rather than compressing them; this verification pass may not reduce a well-evidenced chronology to fewer moments than the sources support.

ACTOR FIDELITY (mandatory): make the actor of every action explicit wherever the evidence establishes it. If Swedish tugs performed an action, return Swedish tugs; if Soviet authorities performed an action, return Soviet authorities. Never leave the actor ambiguous when the evidence identifies them, and never swap one actor for another. Where the evidence genuinely does not establish who acted, leave it unspecified rather than guessing.

DISPUTED INTERPRETATIONS: still remain attributed. Do not manufacture certainty - keep observed fact, contemporary suspicion, official assessment and later interpretation distinct, exactly as the audited package does.

FINAL FACT SHEET (you own it): the "facts" array is the factual spine handed to the scripts, so this pass is responsible for it. Before returning, confirm that every fact agrees with the final moments and summary; that its dates, actors, sequence and location agree with the rest of the package; that its sourceTitle and sourceUrl name a real source in this package that genuinely supports the fact; and that disputed points keep their attribution inside the fact. Correct or remove any fact that fails. Keep each fact concrete (a real date, actor, location or sequence), drop duplicates and vague filler, and do not invent URLs or add fact IDs.

SOURCES: every source URL in the final package must be a URL you actually verified during THIS pass. Never invent or reconstruct a likely URL. If you cannot verify a URL, remove that source. Each note must accurately describe what its source supports.

Preserve the concrete causal spine and the visual world. Return the verified package as strict JSON in the same schema.`;

const momentSchema = { type: "object", additionalProperties: false, required: ["title", "detail"], properties: { title: { type: "string" }, detail: { type: "string" } } };
const sourceSchema = { type: "object", additionalProperties: false, required: ["title", "url", "note"], properties: { title: { type: "string" }, url: { type: "string" }, note: { type: "string" } } };
const factSchema = { type: "object", additionalProperties: false, required: ["fact", "sourceTitle", "sourceUrl"], properties: { fact: { type: "string" }, sourceTitle: { type: "string" }, sourceUrl: { type: "string" } } };

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
  required: ["summary", "moments", "sources", "facts", "productionNote", "world"],
  properties: {
    summary: { type: "string" },
    moments: { type: "array", items: momentSchema },
    sources: { type: "array", items: sourceSchema },
    facts: { type: "array", items: factSchema },
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
