import type { StoryMoment, Source, Fact } from "../types.ts";

// Shared visual context that keeps generated stills feeling like one place and
// production. Not a framework - just planning context.
export interface StoryWorld {
  period: string;
  place: string;
  palette: string;
  visualDirection: string;
  recurringPeople: string[];
  recurringLocations: string[];
  referenceImages: string[]; // media-relative PB style refs
}

export interface ResearchPackage {
  summary: string;
  moments: StoryMoment[];
  sources: Source[];
  // The factual spine handed to the scripts: concrete, sourced facts (dates,
  // actors, locations, sequence, attribution). Owned by the final verification.
  facts: Fact[];
  productionNote: string;
  world: StoryWorld;
}

// One planned visual moment before its asset is acquired.
export interface VisualMoment {
  truth: "archive" | "reconstruction" | "graphic";
  motion: "hold" | "push" | "pan-left" | "pan-right";
  wantsMotion: boolean; // a candidate for Higgsfield in a live run
  prompt: string; // reconstruction/graphic image prompt
  archiveQuery?: string; // Wikimedia search terms for archive shots
  caption?: { kicker?: string; text: string; emphasis?: string };
  source?: string;
}
