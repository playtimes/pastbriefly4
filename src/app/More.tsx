import React from "react";

// The one understated disclosure for fallback and debug controls. A native
// <details>, so it needs no hooks and no menu system: collapsed by default, its
// buttons stay in the React tree and in static markup (tests find them by text),
// and while it is open a click outside or Escape closes it.
export function More({ children, align = "right", label = "More" }: { children: React.ReactNode; align?: "left" | "right"; label?: string }): React.ReactElement {
  return (
    <details className="relative" data-more onToggle={dismissOnOutside}>
      <summary
        className="list-none [&::-webkit-details-marker]:hidden cursor-pointer inline-flex h-10 items-center gap-2 px-3.5 rounded-full text-[13.5px] font-medium text-[#8f8579] whitespace-nowrap hover:text-[#f3ebde] hover:bg-[rgba(245,235,222,0.04)]"
      >
        {label} <span aria-hidden="true">⋯</span>
      </summary>
      <div
        onClick={closeAfterAction}
        className={`absolute z-20 mt-2 ${align === "right" ? "right-0" : "left-0"} w-max min-w-[240px] max-w-[min(88vw,400px)] rounded-xl border border-[rgba(245,235,222,0.14)] bg-[#1a1411] p-2 shadow-[0_20px_50px_rgba(0,0,0,0.5)] flex flex-col`}
      >
        {children}
      </div>
    </details>
  );
}

// A plain menu row. Disabled rows stay visible so the option is discoverable.
export const moreItem =
  "text-left px-3 py-2.5 rounded-lg text-[14px] text-[#e8dfd2] hover:bg-[rgba(245,235,222,0.05)] disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-transparent";

// Choosing an action closes the menu (a nested disclosure, like the details
// read-out, keeps it open).
function closeAfterAction(e: React.MouseEvent<HTMLDivElement>): void {
  const target = e.target as HTMLElement;
  if (!target.closest("button:not(:disabled)")) return;
  e.currentTarget.closest("details")?.removeAttribute("open");
}

// While open: a pointer press outside, or Escape, closes it. The listeners live
// only as long as the menu is open.
function dismissOnOutside(e: React.SyntheticEvent<HTMLDetailsElement>): void {
  const el = e.currentTarget;
  if (!el.open || typeof document === "undefined") return;
  const close = (ev: Event) => {
    if (ev.type === "keydown" ? (ev as KeyboardEvent).key !== "Escape" : el.contains(ev.target as Node)) return;
    el.open = false;
    if (ev.type === "keydown") el.querySelector("summary")?.focus();
  };
  const done = () => {
    if (el.open) return;
    document.removeEventListener("pointerdown", close);
    document.removeEventListener("keydown", close);
    el.removeEventListener("toggle", done);
  };
  document.addEventListener("pointerdown", close);
  document.addEventListener("keydown", close);
  el.addEventListener("toggle", done);
}
