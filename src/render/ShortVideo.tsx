import React from "react";
import type { RenderPlan } from "./types.ts";
import { Film } from "./Film.tsx";

// 1080x1920. More of classic PB1: strong captions, warm accent, hard cuts.
export const ShortVideo: React.FC<RenderPlan> = (plan) => <Film {...plan} kind="short" />;
