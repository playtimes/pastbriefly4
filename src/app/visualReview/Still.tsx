import React from "react";
import { mediaUrl } from "../api.ts";
import { framingTransform } from "../../render/framing.ts";
import type { PreviewFrame } from "../../types.ts";

// One still as the film shows it: full-bleed cover with the renderer's own crop
// for the slot's framing, so a detail slot reads as the detail it is. `version`
// busts the browser cache after a still is regenerated in place.
export function Still({ frame, version, whole = false, className = "" }: { frame: PreviewFrame; version: number; whole?: boolean; className?: string }): React.ReactElement {
  const t = framingTransform(whole ? "wide" : frame.framing);
  return (
    <img
      src={version ? `${mediaUrl(frame.path)}?v=${version}` : mediaUrl(frame.path)}
      alt=""
      draggable={false}
      className={`absolute inset-0 w-full h-full object-cover ${className}`}
      style={t.scale === 1 ? undefined : { transform: `scale(${t.scale})`, transformOrigin: `${t.originX}% ${t.originY}%` }}
    />
  );
}

export const TRUTH_LABEL: Record<PreviewFrame["truth"], string> = { archive: "Archive", reconstruction: "Reconstruction", graphic: "Graphic" };
export const TRUTH_LETTER: Record<PreviewFrame["truth"], string> = { archive: "A", reconstruction: "R", graphic: "G" };

const FRAMING_LABEL: Record<string, string> = {
  wide: "Wide",
  medium: "Medium",
  "detail-left": "Detail left",
  "detail-center": "Detail center",
  "detail-right": "Detail right",
};

export function framingLabel(f: PreviewFrame): string {
  const framing = FRAMING_LABEL[f.framing ?? "wide"] ?? f.framing ?? "Wide";
  return f.presentation && f.presentation !== "base" ? framing : `${framing} · base view`;
}

export function LinkIcon({ size = 11, color = "currentColor" }: { size?: number; color?: string }): React.ReactElement {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1" />
      <path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1" />
    </svg>
  );
}

export function RefreshIcon({ size = 15 }: { size?: number }): React.ReactElement {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M20 11a8 8 0 1 0-2.3 5.7" />
      <path d="M20 4v7h-7" />
    </svg>
  );
}
