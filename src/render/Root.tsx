import React from "react";
import { Composition } from "remotion";
import type { RenderPlan } from "./types.ts";
import { LongVideo } from "./LongVideo.tsx";
import { ShortVideo } from "./ShortVideo.tsx";

// Dimensions/fps/duration all come from the plan (inputProps) at render time.
const emptyPlan = (kind: "long" | "short"): RenderPlan => ({
  kind,
  width: kind === "short" ? 1080 : 1920,
  height: kind === "short" ? 1920 : 1080,
  fps: 30,
  durationInFrames: 30,
  audio: "",
  audioEndFrame: 30,
  accent: "#d9a066",
  title: "",
  year: "",
  place: "",
  shots: [],
  subtitles: [],
});

function metadata(plan: RenderPlan) {
  return { durationInFrames: plan.durationInFrames, fps: plan.fps, width: plan.width, height: plan.height };
}

export const RemotionRoot: React.FC = () => (
  <>
    <Composition
      id="LongVideo"
      component={LongVideo}
      defaultProps={emptyPlan("long")}
      calculateMetadata={({ props }) => metadata(props)}
    />
    <Composition
      id="ShortVideo"
      component={ShortVideo}
      defaultProps={emptyPlan("short")}
      calculateMetadata={({ props }) => metadata(props)}
    />
  </>
);
