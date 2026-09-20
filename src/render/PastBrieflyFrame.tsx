import React from "react";
import { AbsoluteFill } from "remotion";
import { theme, GRADE, PAPER } from "./theme.ts";

// The persistent brand frame, matching PB1: the two-stop grade, faint paper,
// the @PASTBRIEFLY channel mark and the year/place dateline. Sits above the
// shots, below the editorial copy and subtitles.
export const PastBrieflyFrame: React.FC<{
  format: "long" | "short";
  year: string;
  place: string;
  accent: string;
}> = ({ format, year, place, accent }) => {
  const short = format === "short";
  const pad = short ? 54 : 60;

  return (
    <AbsoluteFill style={{ pointerEvents: "none", "--accent": accent } as React.CSSProperties}>
      <AbsoluteFill style={{ background: GRADE }} />
      <AbsoluteFill style={{ backgroundImage: PAPER, opacity: 0.13, mixBlendMode: "screen" }} />

      <div
        style={{
          position: "absolute",
          top: short ? 72 : 52,
          left: pad,
          right: pad,
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
        }}
      >
        <div
          style={{
            display: "inline-flex",
            alignItems: "center",
            minHeight: short ? 44 : 40,
            padding: "0 15px",
            border: "2px solid rgba(255,249,233,0.44)",
            background: "rgba(15,14,12,0.72)",
            color: theme.ink,
            fontFamily: theme.heavy,
            fontSize: short ? 19 : 17,
            fontWeight: 900,
            letterSpacing: "0.1em",
          }}
        >
          <span style={{ width: 10, height: 10, marginRight: 10, borderRadius: "50%", background: accent }} />
          @PASTBRIEFLY
        </div>

        {(year || place) && (
          <div
            style={{
              display: "flex",
              gap: 12,
              alignItems: "center",
              color: theme.muted,
              fontFamily: theme.sans,
              fontSize: short ? 20 : 18,
              fontWeight: 850,
              letterSpacing: "0.08em",
              textShadow: "0 2px 10px #000",
            }}
          >
            {year && <span style={{ color: accent, fontWeight: 950 }}>{year}</span>}
            {place}
          </div>
        )}
      </div>
    </AbsoluteFill>
  );
};
