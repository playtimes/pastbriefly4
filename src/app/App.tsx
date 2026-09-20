import React, { useEffect, useState } from "react";
import { Create } from "./screens/Create.tsx";
import { Story } from "./screens/Story.tsx";
import { Creating } from "./screens/Creating.tsx";
import { Videos } from "./screens/Videos.tsx";
import { VideosLibrary } from "./screens/VideosLibrary.tsx";
import { Settings } from "./screens/Settings.tsx";
import { resolveRoute, activeNav, type Nav } from "./route.ts";

export function navigate(path: string): void {
  window.location.hash = path;
}

function useRoute(): string {
  const [route, setRoute] = useState(() => window.location.hash.slice(1) || "/");
  useEffect(() => {
    const on = () => setRoute(window.location.hash.slice(1) || "/");
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  return route;
}

const NAV: { key: Nav; label: string; path: string }[] = [
  { key: "create", label: "Create", path: "/" },
  { key: "videos", label: "Videos", path: "/videos" },
  { key: "config", label: "Config", path: "/settings" },
];

export function App(): React.ReactElement {
  const route = useRoute();
  const screen = resolveRoute(route);
  const active = activeNav(route);

  let view: React.ReactElement;
  switch (screen.name) {
    case "settings":
      view = <Settings />;
      break;
    case "videos":
      view = <VideosLibrary />;
      break;
    case "creating":
      view = <Creating slug={screen.slug} />;
      break;
    case "watch":
      view = <Videos slug={screen.slug} />;
      break;
    case "story":
      view = <Story slug={screen.slug} />;
      break;
    default:
      view = <Create />;
  }

  return (
    <div className="min-h-screen md:flex">
      {/* Desktop: a quiet fixed sidebar. */}
      <aside className="hidden md:flex md:flex-col md:fixed md:inset-y-0 md:w-[250px] border-r border-line bg-sidebar px-5 py-[30px]">
        <Brand />
        <nav className="mt-[38px] flex flex-col gap-1">
          {NAV.map((item) => (
            <NavLink key={item.key} item={item} active={active === item.key} />
          ))}
        </nav>
      </aside>

      {/* Mobile: a simple top nav that collapses the sidebar. */}
      <header className="md:hidden sticky top-0 z-20 backdrop-blur bg-sidebar/90 border-b border-line">
        <div className="px-4 py-3 flex items-center gap-4">
          <Brand compact />
          <nav className="ml-auto flex items-center gap-1">
            {NAV.map((item) => (
              <NavLink key={item.key} item={item} active={active === item.key} compact />
            ))}
          </nav>
        </div>
      </header>

      <main className="flex-1 md:ml-[250px]">
        <div className="mx-auto max-w-6xl px-4 md:px-10 py-8 md:py-12">{view}</div>
      </main>
    </div>
  );
}

function Brand({ compact }: { compact?: boolean }): React.ReactElement {
  return (
    <button onClick={() => navigate("/")} className="flex items-center gap-[11px]">
      <span className="w-[30px] h-[30px] rounded-lg bg-accent grid place-items-center font-serif text-[17px] text-white shadow-[0_4px_16px_rgba(229,9,20,0.35)]">
        PB
      </span>
      {!compact && (
        <span className="flex flex-col leading-none text-left">
          <span className="font-serif text-[22px] text-ink">PastBriefly</span>
          <span className="text-[9.5px] tracking-[0.24em] text-dim uppercase mt-1">Story Studio</span>
        </span>
      )}
    </button>
  );
}

// Sidebar icons: 18px, 1.6 stroke, currentColor.
function NavIcon({ nav }: { nav: Nav }): React.ReactElement {
  const p = { width: 18, height: 18, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.6 };
  if (nav === "videos") {
    return (
      <svg {...p} strokeLinejoin="round">
        <rect x="3" y="5" width="18" height="14" rx="3.2" />
        <path d="M10.3 9.2l4.6 2.8-4.6 2.8z" fill="currentColor" stroke="none" />
      </svg>
    );
  }
  if (nav === "config") {
    return (
      <svg {...p} strokeLinecap="round">
        <line x1="4" y1="8.5" x2="20" y2="8.5" />
        <line x1="4" y1="15.5" x2="20" y2="15.5" />
        <circle cx="10" cy="8.5" r="2.6" />
        <circle cx="15" cy="15.5" r="2.6" />
      </svg>
    );
  }
  return (
    <svg {...p} strokeLinejoin="round">
      <path d="M12 3l1.9 5.7L20 10.5l-6.1 1.8L12 18.5l-1.9-6.2L4 10.5l6.1-1.8z" />
    </svg>
  );
}

function NavLink({ item, active, compact }: { item: { key: Nav; label: string; path: string }; active: boolean; compact?: boolean }): React.ReactElement {
  if (compact) {
    return (
      <button
        onClick={() => navigate(item.path)}
        className={`px-3 py-1.5 rounded-lg text-sm font-medium transition ${active ? "text-accent" : "text-dim hover:text-ink"}`}
      >
        {item.label}
      </button>
    );
  }
  return (
    <button
      onClick={() => navigate(item.path)}
      className={`flex items-center gap-[13px] rounded-[11px] px-[13px] py-[11px] text-[14.5px] font-medium transition ${
        active ? "text-ink bg-accent/12 shadow-[inset_2px_0_0_#e50914]" : "text-dim hover:text-ink hover:bg-[rgba(245,235,222,0.04)]"
      }`}
    >
      <NavIcon nav={item.key} />
      {item.label}
    </button>
  );
}
