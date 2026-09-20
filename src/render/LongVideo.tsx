import React from "react";
import type { RenderPlan } from "./types.ts";
import { Film } from "./Film.tsx";

// 1920x1080. Same brand DNA as the Short, calmer density.
export const LongVideo: React.FC<RenderPlan> = (plan) => <Film {...plan} kind="long" />;
