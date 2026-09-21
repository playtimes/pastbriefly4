// Pure hash-route resolution shared by the app shell (and unit-tested). Keeping
// it free of React lets the dashboard navigation be verified without a DOM.

export type Screen =
  | { name: "create" }
  | { name: "stories" } // the saved-stories library
  | { name: "videos" } // the Videos library (drill into a story to watch)
  | { name: "settings" }
  | { name: "story"; slug: string }
  | { name: "creating"; slug: string }
  | { name: "watch"; slug: string };

// The three permanent sidebar destinations. Story/Creating/Watch are drill-downs
// and never appear as menu entries.
export type Nav = "create" | "stories" | "videos" | "config";

export function resolveRoute(route: string): Screen {
  const parts = route.split("/").filter(Boolean); // "/story/pig-war/watch" -> ["story","pig-war","watch"]
  if (parts[0] === "settings") return { name: "settings" };
  if (parts[0] === "stories") return { name: "stories" };
  if (parts[0] === "videos") return { name: "videos" };
  if (parts[0] === "story" && parts[1]) {
    if (parts[2] === "creating") return { name: "creating", slug: parts[1] };
    if (parts[2] === "watch") return { name: "watch", slug: parts[1] };
    return { name: "story", slug: parts[1] };
  }
  return { name: "create" };
}

// Which sidebar item is highlighted for a given route. Story detail and Creating
// belong to the Create flow; watching a story belongs to Videos.
export function activeNav(route: string): Nav {
  const s = resolveRoute(route);
  if (s.name === "settings") return "config";
  if (s.name === "stories") return "stories";
  if (s.name === "videos" || s.name === "watch") return "videos";
  return "create";
}
