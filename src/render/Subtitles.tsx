import React from "react";
import { useCurrentFrame } from "remotion";
import type { SubtitleCue } from "./types.ts";
import { theme } from "./theme.ts";

// Phrase subtitles in PB1's caption-cue form: one short centred phrase at a time
// with a small accent rule above it, sitting on a soft radial darkening. Never
// word-by-word karaoke. It only fades where a phrase opens or closes on silence
// (a gap between cues), so continuous speech reads as one steady band.
const EDGE_FADE = 3;

export const Subtitles: React.FC<{ cues: SubtitleCue[]; format: "long" | "short"; duration: number; accent: string }> = ({
  cues,
  format,
  duration,
  accent,
}) => {
  const frame = useCurrentFrame();
  const cue = cues.find((c) => frame >= c.startFrame && frame < c.endFrame);
  if (!cue) return null;

  const short = format === "short";
  const opensAtSilence = cue.startFrame > 0 && !cues.some((c) => c.endFrame === cue.startFrame);
  const closesAtSilence = cue.endFrame < duration - 1 && !cues.some((c) => c.startFrame === cue.endFrame);
  let opacity = 1;
  if (opensAtSilence) opacity = Math.min(opacity, (frame - cue.startFrame) / EDGE_FADE);
  if (closesAtSilence) opacity = Math.min(opacity, (cue.endFrame - frame) / EDGE_FADE);
  opacity = Math.max(0, Math.min(1, opacity));

  return (
    <div
      style={{
        position: "absolute",
        left: short ? 60 : 260,
        right: short ? 176 : 260,
        bottom: short ? 300 : 96,
        display: "flex",
        justifyContent: "center",
      }}
    >
      <div style={{ position: "relative", display: "flex", flexDirection: "column", alignItems: "center", gap: 15, opacity }}>
        {/* soft radial darkening so the phrase reads over any frame */}
        <div
          style={{
            position: "absolute",
            inset: "-34px -64px -30px",
            zIndex: -1,
            background: "radial-gradient(ellipse 60% 118% at 50% 64%, rgba(9,7,5,0.52), rgba(9,7,5,0.24) 54%, transparent 78%)",
          }}
        />
        <span style={{ width: 40, height: 3, background: accent, opacity: 0.9 }} />
        <span
          style={{
            fontFamily: theme.sans,
            fontSize: short ? 43 : 32,
            fontWeight: 800,
            lineHeight: 1.17,
            letterSpacing: "-0.006em",
            color: theme.captionInk,
            textAlign: "center",
            textShadow:
              "1px 0 0 rgba(11,9,7,0.82), -1px 0 0 rgba(11,9,7,0.82), 0 1px 0 rgba(11,9,7,0.82), 0 -1px 0 rgba(11,9,7,0.82), 0 3px 14px rgba(6,4,3,0.8)",
          }}
        >
          {cue.text}
        </span>
      </div>
    </div>
  );
};
