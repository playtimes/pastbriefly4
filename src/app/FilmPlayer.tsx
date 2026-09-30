import React from "react";
import type { VideoKind } from "../types.ts";

// One finished film with native controls: the Long at 16:9 across the available
// width, the Short as a true centered 9:16. Shared by Watch and the finished-film
// review at the final gate.
export function FilmPlayer({ kind, src }: { kind: VideoKind; src: string }): React.ReactElement {
  if (kind === "short") {
    return (
      <div className="flex justify-center">
        <video src={src} controls className="aspect-[9/16] w-[360px] max-w-full rounded-[20px] border border-line bg-black object-contain" />
      </div>
    );
  }
  return <video src={src} controls className="aspect-video w-full rounded-[16px] border border-line bg-black object-contain" />;
}
