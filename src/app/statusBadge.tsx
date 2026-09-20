import React from "react";
import type { Story } from "../types.ts";

// A story is in one of three states, derived from whether its films exist yet
// and whether they've been published.
export type StoryState = "not-generated" | "generated" | "published";

export function storyState(s: Pick<Story, "hasVideos" | "published">): StoryState {
  if (!s.hasVideos) return "not-generated";
  return s.published ? "published" : "generated";
}

const LABEL: Record<StoryState, string> = {
  "not-generated": "NOT GENERATED",
  generated: "GENERATED",
  published: "PUBLISHED",
};

const TONE: Record<StoryState, string> = {
  "not-generated": "border-line text-muted",
  generated: "border-line text-ink",
  published: "border-accent text-accent",
};

export function StatusBadge({ story, className = "" }: { story: Pick<Story, "hasVideos" | "published">; className?: string }): React.ReactElement {
  const state = storyState(story);
  return (
    <span className={`text-[0.65rem] tracking-widest font-bold bg-bg/80 border rounded px-2 py-1 ${TONE[state]} ${className}`}>
      {LABEL[state]}
    </span>
  );
}
