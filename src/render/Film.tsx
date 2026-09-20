import React from "react";
import { AbsoluteFill, Audio, Sequence, staticFile } from "remotion";
import type { RenderPlan } from "./types.ts";
import { Shot } from "./Shot.tsx";
import { Subtitles } from "./Subtitles.tsx";
import { PastBrieflyFrame } from "./PastBrieflyFrame.tsx";
import { theme } from "./theme.ts";

// Both films are the same assembly: hard-cut shots, the brand frame, phrase
// subtitles, one narration track. The only difference is the format.
export const Film: React.FC<RenderPlan> = (plan) => {
  const accent = plan.accent || theme.accent;
  return (
    <AbsoluteFill style={{ backgroundColor: theme.bg }}>
      {plan.shots.map((shot) => (
        <Sequence key={shot.id} from={shot.startFrame} durationInFrames={Math.max(1, shot.endFrame - shot.startFrame)} name={shot.id}>
          <Shot shot={shot} durationInFrames={shot.endFrame - shot.startFrame} format={plan.kind} accent={accent} />
        </Sequence>
      ))}

      <PastBrieflyFrame format={plan.kind} year={plan.year} place={plan.place} accent={accent} />
      <Subtitles cues={plan.subtitles} format={plan.kind} duration={plan.durationInFrames} accent={accent} />

      <Sequence from={0} durationInFrames={Math.max(1, plan.audioEndFrame)} name="narration">
        <Audio src={staticFile(plan.audio)} />
      </Sequence>
    </AbsoluteFill>
  );
};
