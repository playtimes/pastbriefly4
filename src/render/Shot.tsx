import React from "react";
import { AbsoluteFill, Img, OffthreadVideo, interpolate, staticFile, useCurrentFrame } from "remotion";
import type { Shot as ShotType, Caption } from "./types.ts";
import { theme, ART_FILTER } from "./theme.ts";

// One shot: a still (with simple motion) or a clip, plus its editorial copy in
// the PB1 language — accent kicker block, heavy outlined headline with an inline
// emphasis highlight, a SOURCE line — and a brief cream cut-flash on entry.
export const Shot: React.FC<{ shot: ShotType; durationInFrames: number; format: "long" | "short"; accent: string }> = ({
  shot,
  durationInFrames,
  format,
  accent,
}) => {
  const frame = useCurrentFrame();
  const short = format === "short";

  return (
    <AbsoluteFill style={{ backgroundColor: theme.bg }}>
      <Media shot={shot} frame={frame} duration={durationInFrames} format={format} />

      {shot.truth === "reconstruction" && <TruthLabel />}
      {shot.caption && <CaptionBlock caption={shot.caption} short={short} frame={frame} accent={accent} />}
      {shot.source && <SourceLine text={shot.source} short={short} />}

      {/* hard editorial cut: a brief warm cream flash as the shot enters */}
      <AbsoluteFill
        style={{
          backgroundColor: theme.cutFlash,
          mixBlendMode: "screen",
          opacity: interpolate(frame, [0, 3], [0.5, 0], { extrapolateRight: "clamp" }),
        }}
      />
    </AbsoluteFill>
  );
};

const Media: React.FC<{ shot: ShotType; frame: number; duration: number; format: "long" | "short" }> = ({ shot, frame, duration, format }) => {
  const src = staticFile(shot.path);
  if (shot.mediaType === "video") {
    return <OffthreadVideo src={src} style={{ width: "100%", height: "100%", objectFit: "cover", filter: ART_FILTER }} />;
  }

  // Long stills (the real PB1 frames are portrait) must not be hard-cropped into
  // 16:9 — that destroys the composition. Seat the full still, contained, over a
  // blurred/graded fill of itself: a premium PastBriefly way to hold a portrait
  // image in a wide frame. Motion is a gentle breath so the composition is kept.
  if (format === "long") {
    const t = duration > 1 ? frame / (duration - 1) : 0;
    const breath = 1 + t * 0.03;
    return (
      <AbsoluteFill>
        <Img
          src={src}
          style={{ width: "100%", height: "100%", objectFit: "cover", filter: "saturate(0.6) contrast(1.02) brightness(0.42) blur(30px)", transform: "scale(1.14)" }}
        />
        <AbsoluteFill style={{ background: "radial-gradient(circle at 50% 46%, transparent 34%, rgba(9,8,7,0.55) 100%)" }} />
        <AbsoluteFill style={{ display: "flex", alignItems: "center", justifyContent: "center" }}>
          <Img
            src={src}
            style={{
              maxWidth: "100%",
              maxHeight: "100%",
              objectFit: "contain",
              filter: ART_FILTER,
              transform: `scale(${breath})`,
              transformOrigin: "center",
              boxShadow: "0 26px 90px rgba(0,0,0,0.62)",
            }}
          />
        </AbsoluteFill>
      </AbsoluteFill>
    );
  }

  // Short is already vertical, so the portrait still fills the 9:16 frame.
  const { scale, x } = motionTransform(shot.motion ?? "hold", frame, duration);
  return (
    <Img
      src={src}
      style={{
        width: "100%",
        height: "100%",
        objectFit: "cover",
        filter: ART_FILTER,
        transform: `scale(${scale}) translateX(${x}%)`,
        transformOrigin: "center",
      }}
    />
  );
};

// Simple, story-serving motion only. Slight overscale avoids exposing edges.
function motionTransform(motion: ShotType["motion"], frame: number, duration: number): { scale: number; x: number } {
  const t = duration > 1 ? frame / (duration - 1) : 0;
  switch (motion) {
    case "push":
      return { scale: 1.04 + t * 0.1, x: 0 };
    case "pan-left":
      return { scale: 1.12, x: interpolate(t, [0, 1], [4, -4]) };
    case "pan-right":
      return { scale: 1.12, x: interpolate(t, [0, 1], [-4, 4]) };
    case "hold":
    default:
      return { scale: 1.03, x: 0 };
  }
}

const TruthLabel: React.FC = () => (
  <div
    style={{
      position: "absolute",
      top: 0,
      right: 0,
      padding: "10px 14px",
      fontFamily: theme.sans,
      fontSize: 15,
      letterSpacing: 3,
      color: "rgba(255,249,233,0.55)",
      textTransform: "uppercase",
    }}
  >
    Reconstruction
  </div>
);

// PB1 wraps the emphasis substring in the headline as an accent-block highlight.
function highlightCaption(text: string, emphasis: string | undefined): React.ReactNode {
  if (!emphasis) return text;
  const at = text.toUpperCase().indexOf(emphasis.toUpperCase());
  if (at === -1) return text;
  return (
    <>
      {text.slice(0, at)}
      <mark
        style={{
          margin: "0 0.04em",
          padding: "0.015em 0.1em 0.035em",
          background: "var(--accent)",
          color: theme.onAccent,
          lineHeight: 0.98,
          textShadow: "none",
          whiteSpace: "nowrap",
        }}
      >
        {text.slice(at, at + emphasis.length)}
      </mark>
      {text.slice(at + emphasis.length)}
    </>
  );
}

// Two deliberate registers of the PB1 headline styling. The opener is the strong
// PB1 title lockup — heavy outlined headline over an accent kicker block, used at
// the start of the film. Later story-moments use the calmer "moment" register:
// the same type language, smaller and with a soft shadow rather than the poster
// outline, so the film settles into documentary presentation after the opening.
const CaptionBlock: React.FC<{ caption: Caption; short: boolean; frame: number; accent: string }> = ({ caption, short, frame, accent }) => {
  const opener = caption.variant === "opener";
  const enter = interpolate(frame, [4, 16], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const off = short ? 3 : 2;
  const outline = `${-off}px ${-off}px 0 #12100d, ${off}px ${-off}px 0 #12100d, ${-off}px ${off}px 0 #12100d, ${off}px ${off}px 0 #12100d, 0 10px 22px rgba(0,0,0,0.72)`;
  const softShadow = "0 3px 16px rgba(0,0,0,0.8), 0 1px 2px rgba(0,0,0,0.9)";

  const headlineSize = opener ? (short ? 66 : 52) : short ? 46 : 34;
  const kickerSize = opener ? (short ? 21 : 18) : short ? 17 : 15;

  return (
    <div
      style={{
        position: "absolute",
        left: short ? 54 : 72,
        right: short ? 96 : 72,
        bottom: short ? 520 : 250,
        opacity: enter,
        transform: `translateY(${(1 - enter) * (opener ? 22 : 14)}px)`,
        display: "flex",
        flexDirection: "column",
        alignItems: "flex-start",
        gap: opener ? 16 : 12,
        "--accent": accent,
      } as React.CSSProperties}
    >
      {caption.kicker && (
        <div
          style={{
            padding: opener ? "9px 14px 10px" : "6px 11px 7px",
            background: accent,
            color: theme.onAccent,
            fontFamily: theme.heavy,
            fontSize: kickerSize,
            fontWeight: 900,
            lineHeight: 1,
            letterSpacing: "0.115em",
            opacity: opener ? 1 : 0.94,
          }}
        >
          {caption.kicker}
        </div>
      )}
      <div
        style={{
          fontFamily: theme.heavy,
          fontSize: headlineSize,
          fontWeight: 900,
          lineHeight: 1.1,
          letterSpacing: "-0.03em",
          color: theme.ink,
          maxWidth: short ? "100%" : opener ? "72%" : "64%",
          textShadow: opener ? outline : softShadow,
        }}
      >
        {highlightCaption(caption.text, caption.emphasis)}
      </div>
    </div>
  );
};

const SourceLine: React.FC<{ text: string; short: boolean }> = ({ text, short }) => (
  <div
    style={{
      position: "absolute",
      left: short ? 54 : 72,
      bottom: short ? 460 : 200,
      fontFamily: theme.sans,
      fontSize: short ? 20 : 17,
      fontWeight: 800,
      letterSpacing: "0.1em",
      color: "rgba(255,249,233,0.76)",
      textShadow: "0 2px 8px #000",
      maxWidth: "70%",
    }}
  >
    SOURCE • {text}
  </div>
);
