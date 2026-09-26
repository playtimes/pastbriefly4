import React from "react";
import { AbsoluteFill, Img, OffthreadVideo, interpolate, staticFile, useCurrentFrame } from "remotion";
import type { Shot as ShotType, Caption } from "./types.ts";
import { theme, ART_FILTER } from "./theme.ts";
import { framingTransform } from "./framing.ts";

// One shot: a still (with simple motion) or a clip, plus its editorial copy in
// the PB1 language - accent kicker block, heavy outlined headline with an inline
// emphasis highlight, a SOURCE line - and a brief cream cut-flash on entry.
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
      {shot.clarity === "focus" && shot.mediaType === "image" && <AbsoluteFill style={spotlightStyle(shot, frame)} />}

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
    // A motion clip is a finite edit slot: the edit plan never gives it more
    // screen time than the clip itself, so the next event cuts in as it ends.
    return <OffthreadVideo src={src} muted style={{ width: "100%", height: "100%", objectFit: "cover", filter: ART_FILTER }} />;
  }
  return <Img src={src} style={stillStyle(shot, frame, duration, format)} />;
};

// Every still is full-bleed: objectFit cover crops the source (1536x1024 for Long,
// portrait for Short) cleanly into the canvas, with no blurred duplicate behind it
// and no floating-picture shadow. The event's framing sets a restrained crop; Long
// adds a slow breath and Short keeps its simple planned motion on top.
export function stillStyle(shot: ShotType, frame: number, duration: number, format: "long" | "short"): React.CSSProperties {
  const f = framingTransform(shot.framing);
  const t = duration > 1 ? frame / (duration - 1) : 0;
  if (shot.clarity === "map-focus") {
    // Orient, then focus: the whole map, a gentle push toward the framing origin,
    // then a settled hold. Starts at scale 1 so the viewer first sees the region.
    return {
      width: "100%",
      height: "100%",
      objectFit: "cover",
      filter: ART_FILTER,
      transform: `scale(${round3(mapFocusScale(t, f.scale))})`,
      transformOrigin: `${f.originX}% ${f.originY}%`,
    };
  }
  // A focus detail pushes a little further toward its region than the usual breath.
  const push = shot.clarity === "focus" ? FOCUS_PUSH : format === "long" ? 0.03 : 0;
  const base = format === "long" ? { scale: 1, x: 0 } : motionTransform(shot.motion ?? "hold", frame, duration);
  const { scale, x } = { scale: base.scale + t * push, x: base.x };
  return {
    width: "100%",
    height: "100%",
    objectFit: "cover",
    filter: ART_FILTER,
    transform: `scale(${round3(f.scale * scale)})${x ? ` translateX(${round3(x)}%)` : ""}`,
    transformOrigin: `${f.originX}% ${f.originY}%`,
  };
}

// Clarity timing: hold the whole map for the first 15% of the slot, ease the push
// in over the middle, and settle for the last 30%. The end crop stays modest so a
// route's ends remain on screen.
export const MAP_FOCUS_END_SCALE = 1.12;
const FOCUS_PUSH = 0.05;
export function mapFocusScale(t: number, framingScale: number): number {
  const end = Math.max(1, framingScale) * MAP_FOCUS_END_SCALE;
  const p = Math.min(1, Math.max(0, (t - 0.15) / 0.55));
  const eased = p * p * (3 - 2 * p); // smoothstep: no jolt at either end
  return 1 + (end - 1) * eased;
}

// One restrained guide for a focus detail: a soft spotlight that gently darkens
// the frame away from the framing origin, faded in just after the cut. It never
// covers the region itself and carries no text, arrow or bounce.
export function spotlightStyle(shot: ShotType, frame: number): React.CSSProperties {
  const f = framingTransform(shot.framing);
  return {
    pointerEvents: "none",
    background: `radial-gradient(ellipse 46% 58% at ${f.originX}% ${f.originY}%, transparent 55%, rgba(8,6,4,0.34) 100%)`,
    opacity: interpolate(frame, [6, 24], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" }),
  };
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

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
// PB1 title lockup - heavy outlined headline over an accent kicker block, used at
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
