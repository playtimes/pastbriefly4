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

export function RefreshIcon({ size = 15 }: { size?: number }): React.ReactElement {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M20 11a8 8 0 1 0-2.3 5.7" />
      <path d="M20 4v7h-7" />
    </svg>
  );
}
