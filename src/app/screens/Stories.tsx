import React, { useEffect, useState } from "react";
import { api, mediaUrl } from "../api.ts";
import { navigate } from "../App.tsx";
import type { Story } from "../../types.ts";

const GRADE = "[filter:saturate(0.92)_contrast(1.03)]";

// The saved-stories library: only stories the user explicitly saved. Drill into
// one to open the existing Story route.
export function Stories(): React.ReactElement {
  const [stories, setStories] = useState<Story[] | null>(null);

  useEffect(() => {
    api.stories().then((r) => setStories(r.stories.filter((s) => s.saved)));
  }, []);

  return (
    <div className="flex flex-col gap-8">
      <header className="flex flex-col gap-2">
        <p className="kicker">Library</p>
        <h1 className="text-4xl md:text-5xl">Stories</h1>
      </header>

      {!stories ? (
        <p className="text-muted">Loading…</p>
      ) : stories.length === 0 ? (
        <p className="text-muted">No saved stories yet.</p>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-5">
          {stories.map((s) => (
            <button key={s.id} onClick={() => navigate(`/story/${s.slug}`)} className="surface overflow-hidden text-left group flex flex-col">
              <div className="relative overflow-hidden">
                {s.heroImage ? (
                  <img
                    src={mediaUrl(s.heroImage)}
                    alt=""
                    className={`w-full h-48 object-cover transition duration-500 group-hover:scale-[1.03] group-hover:brightness-105 ${GRADE}`}
                  />
                ) : (
                  <div className="w-full h-48 bg-panel" />
                )}
                <div className="absolute inset-x-0 bottom-0 h-16 bg-gradient-to-t from-panel to-transparent" />
              </div>
              <div className="p-4">
                <p className="kicker mb-1">{s.category}</p>
                <h3 className="text-xl mb-1.5">{s.title}</h3>
                <p className="text-muted text-sm line-clamp-2">{s.hook}</p>
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
