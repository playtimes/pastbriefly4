import React from "react";
import { mediaUrl } from "../api.ts";
import { FilmPlayer } from "../FilmPlayer.tsx";
import { More, moreItem } from "../More.tsx";
import { DISPLAY_STAGES, stageIndex, stageLabel, stageProgress, type CompletePair, type DisplayStage } from "../productionStage.ts";
import type { VisualIssue } from "../visualReview/visualIssues.ts";
import { Still } from "../visualReview/Still.tsx";
import type { FinalQaIssue, Job, TextQaSection, TextQaState, VideoKind } from "../../types.ts";
import type { ReviewTab } from "./Creating.tsx";

// The plain faces of the Production screen (/story/:slug/creating): Running,
// Text needs you, Visuals need you, Films need you and Ready, plus their small
// More menus. Hook-free: every handler is one Creating already owns.

const kicker = "text-[11px] font-semibold tracking-[0.18em] uppercase text-muted";
const attention = "text-[11px] font-semibold tracking-[0.18em] uppercase text-accent";
const title = "font-serif text-[34px] md:text-[42px] leading-[1.05] text-ink [text-wrap:balance]";
const lead = "text-[16px] leading-[1.55] text-[#c8bcad] [text-wrap:pretty]";
const rowButton = "btn btn-primary w-full sm:w-auto min-h-11 whitespace-nowrap";

const money = (n: unknown): string | null => (typeof n === "number" ? `$${n.toFixed(2)}` : null);
const things = (n: number): string => (n === 1 ? "1 thing needs your attention" : `${n} things need your attention`);

// ---------------------------------------------------------------- Running

// What PB4 is doing, in one of six plain stages. A percentage shows only when it
// honestly describes the stage (see stageProgress). The stage list and the
// production read-out are there for anyone who asks, folded away.
export function ProductionProgress({ job, storyTitle, previous }: { job: Job; storyTitle?: string; previous?: DisplayStage }): React.ReactElement {
  const current = stageIndex(job, previous);
  const pct = stageProgress(job);
  return (
    <div className="flex flex-col gap-7 max-w-[560px]">
      <div className="flex flex-col gap-2">
        <p className={kicker}>{storyTitle ? `In production · ${storyTitle}` : "In production"}</p>
        <h1 className={title}>{stageLabel(job, previous)}…</h1>
        <p className="text-[14px] text-muted tabular-nums" data-stage-step>
          Step {Math.min(current + 1, DISPLAY_STAGES.length)} of {DISPLAY_STAGES.length}
          {pct !== null && ` · ${pct}%`}
        </p>
      </div>
      <div className="flex gap-1.5" aria-hidden="true">
        {DISPLAY_STAGES.map(([k], i) => (
          <span key={k} className={`relative flex-1 h-1 rounded-full overflow-hidden ${i < current ? "bg-[rgba(245,235,222,0.4)]" : "bg-line"}`}>
            {i === current && <span className={`absolute inset-y-0 left-0 rounded-full bg-accent transition-[width] duration-500 ${pct === null ? "w-full animate-pulse" : ""}`} style={pct === null ? undefined : { width: `${pct}%` }} />}
          </span>
        ))}
      </div>
      <p className="text-muted">You can leave this page. PB4 keeps working and stops only if it needs you.</p>
      <div className="flex flex-col pt-2 border-t border-line text-[13.5px]">
        <details className="group/stages">
          <summary className="list-none [&::-webkit-details-marker]:hidden cursor-pointer py-2.5 text-dim hover:text-ink">Show stages</summary>
          <ol aria-label="Production" className="flex flex-col gap-2.5 pb-3 text-[14.5px]">
            {DISPLAY_STAGES.map(([key, label], i) => (
              <li key={key} {...(i === current ? { "aria-current": "step" as const, "data-stage-current": key } : {})} className={`flex items-center gap-3 ${i === current ? "text-ink font-medium" : i < current ? "text-muted" : "text-dim"}`}>
                <span aria-hidden="true" className={`w-4 text-center text-[11px] ${i === current ? "text-accent" : ""}`}>
                  {i < current ? "✓" : i === current ? "●" : "○"}
                </span>
                {label}
              </li>
            ))}
          </ol>
        </details>
        <ProductionDetails job={job} previous={previous} />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- Text needs you

export type TextQaStop = Extract<TextQaState, { status: "stopped" }>;

export const SECTION_LABEL: Record<TextQaSection, string> = { story: "Story", hook: "Hook", spine: "Story spine", facts: "Facts & Sources", long: "Long script", short: "Short script" };

// The Advanced story review tab each Text QA section lives on.
export const SECTION_TAB: Record<TextQaSection, ReviewTab> = { story: "story", hook: "story", spine: "story", facts: "facts", long: "long", short: "short" };

// Why PB4 stopped at the story: one row per issue, each opening its own simple
// issue view. Everything else waits in More.
export function TextException(props: {
  storyTitle: string;
  qa?: TextQaStop; // absent when the Text QA result was lost (server memory, e.g. a restart)
  onReview: (issue: number) => void;
  onOpenReview: () => void; // the Advanced story review, when there is no issue to open
  more: React.ReactNode;
}): React.ReactElement {
  const issues = props.qa?.issues ?? [];
  return (
    <div className="flex flex-col gap-7 max-w-[760px]">
      <div className="flex flex-col gap-2.5">
        <p className={attention}>{props.storyTitle ? `Text needs you · ${props.storyTitle}` : "Text needs you"}</p>
        <h1 className={title}>{issues.length ? things(issues.length) : "Your story needs a look"}</h1>
        {!issues.length && <p className={lead}>PB4 could not finish checking the story. Read it, then continue.</p>}
      </div>
      {issues.length > 0 && (
        <ol aria-label="Text issues" className="flex flex-col border-t border-line">
          {issues.map((i, n) => (
            <li key={n} data-text-issue={i.section} className="grid grid-cols-[36px_minmax(0,1fr)] sm:grid-cols-[36px_minmax(0,1fr)_auto] gap-x-4 gap-y-3 items-start py-5 border-b border-line">
              <span className="font-serif text-[24px] leading-none text-accent tabular-nums">{String(n + 1).padStart(2, "0")}</span>
              <div className="flex flex-col gap-1.5 min-w-0">
                <span className={kicker}>{SECTION_LABEL[i.section]}</span>
                <span className="text-[15.5px] leading-[1.55] text-ink [text-wrap:pretty] break-words">{i.reason}</span>
              </div>
              <button onClick={() => props.onReview(n)} className={`${rowButton} col-start-2 sm:col-start-auto`}>
                Review issue
              </button>
            </li>
          ))}
        </ol>
      )}
      <div className="flex flex-wrap items-center gap-x-5 gap-y-3">
        {!issues.length && (
          <button onClick={props.onOpenReview} className="btn btn-primary">
            Open story review
          </button>
        )}
        {props.more}
      </div>
    </div>
  );
}

// The text gate's secondary actions: read the whole story, or continue past an
// open issue. Both quiet.
export function TextMore(props: { onWholeStory: () => void; onApprove: () => void; approving: boolean }): React.ReactElement {
  return (
    <More align="left">
      <button onClick={props.onWholeStory} className={moreItem}>
        Read the whole story
      </button>
      <button onClick={props.onApprove} disabled={props.approving} className={moreItem}>
        {props.approving ? "Continuing…" : "Continue anyway"}
      </button>
    </More>
  );
}

// ---------------------------------------------------------------- Visuals need you

// The current visual exceptions, one row each with its own Review. With none
// left (all fixed, or nothing PB4 could check) the one decision is to continue.
export function VisualException(props: {
  job: Job;
  storyTitle: string;
  issues: VisualIssue[];
  version: number;
  onReview: (issue: VisualIssue) => void;
  onContinue: () => void;
  continuing: boolean;
  busy: boolean; // a still, a sequence revision or a Director QA run is in flight
  more: React.ReactNode;
}): React.ReactElement {
  const { issues, job } = props;
  const n = issues.length;
  const checked = !!job.assetQa || !!job.directorQa?.long || !!job.directorQa?.short;
  return (
    <div className="flex flex-col gap-7 max-w-[820px]">
      <div className="flex flex-col gap-2.5">
        <p className={attention}>{props.storyTitle ? `Visuals need you · ${props.storyTitle}` : "Visuals need you"}</p>
        <h1 className={title}>{n ? things(n) : checked ? "Nothing left to fix" : "The visuals need a look"}</h1>
        {!n && <p className={lead}>{checked ? "Continue production when you are ready." : "PB4 could not check these visuals automatically. Continue, or look through the films first."}</p>}
      </div>
      {n > 0 && (
        <ol aria-label="Visual issues" className="flex flex-col border-t border-line">
          {issues.map((i, k) => (
            <li key={i.key} data-visual-issue={i.key} className="grid grid-cols-[36px_minmax(0,1fr)] sm:grid-cols-[36px_minmax(0,1fr)_120px_auto] gap-x-[18px] gap-y-3 items-center py-[18px] border-b border-line">
              <span className="font-serif text-[24px] leading-none text-accent tabular-nums self-start sm:self-center">{String(k + 1).padStart(2, "0")}</span>
              <div className="flex flex-col gap-1.5 min-w-0">
                <span className={kicker}>{i.where}</span>
                {i.reasons.map((r, j) => (
                  <span key={j} className="text-[15px] leading-[1.5] text-ink [text-wrap:pretty] break-words">
                    {r}
                  </span>
                ))}
              </div>
              <span className="hidden sm:flex justify-center">
                {i.frame && (
                  <span data-issue-thumb className={`relative overflow-hidden rounded-md bg-sidebar border border-[rgba(245,235,222,0.08)] ${i.film === "short" ? "w-12 aspect-[9/16]" : "w-[120px] aspect-video"}`}>
                    <Still frame={i.frame} version={props.version} whole />
                  </span>
                )}
              </span>
              <span className="col-start-2 sm:col-start-auto">
                <button onClick={() => props.onReview(i)} className={rowButton}>
                  Review
                </button>
              </span>
            </li>
          ))}
        </ol>
      )}
      <div className="flex flex-wrap items-center gap-x-5 gap-y-3">
        {!n && (
          <button onClick={props.onContinue} disabled={props.busy || props.continuing} data-action="continue" className="btn btn-primary">
            {props.continuing ? "Continuing…" : "Continue production"}
          </button>
        )}
        {props.more}
      </div>
    </div>
  );
}

// The visual gate's secondary actions: look through the films, continue past an
// open issue, or start the visuals again. All quiet.
export function VisualMore(props: { onFilms: () => void; onContinue: () => void; onRebuild: () => void; continuing: boolean; rebuilding: boolean; busy: boolean; showContinue?: boolean }): React.ReactElement {
  const locked = props.busy || props.continuing || props.rebuilding;
  return (
    <More align="left">
      <button onClick={props.onFilms} className={moreItem}>
        Look through the films
      </button>
      {props.showContinue !== false && (
        <button onClick={props.onContinue} disabled={locked} data-action="continue" className={moreItem}>
          {props.continuing ? "Continuing…" : "Continue anyway"}
        </button>
      )}
      <button onClick={props.onRebuild} disabled={locked} data-action="rebuild" className={moreItem}>
        {props.rebuilding ? "Starting again…" : "Redo all visuals"}
      </button>
    </More>
  );
}

// ---------------------------------------------------------------- Films need you

const FILMS: VideoKind[] = ["long", "short"];
const FILM_LABEL: Record<VideoKind, string> = { long: "Long", short: "Short" };
const FILM_NAME: Record<VideoKind, string> = { long: "Long documentary", short: "Short" };
const AREA_LABEL: Record<FinalQaIssue["area"], string> = { fact: "Fact", visual: "Visual" };
// Presentation copy only: the stored reason is shown as it is, beneath it.
const AREA_HEADLINE: Record<FinalQaIssue["area"], string> = {
  fact: "This claim may be stronger than the evidence.",
  visual: "This film may feel visually repetitive.",
};

// The finished render at the final gate. It is not a Video row until the films
// are accepted, so it is addressed by its fixed place in the story's media.
export const finalRenderUrl = (slug: string, film: VideoKind): string => mediaUrl(`stories/${slug}/renders/${film}.mp4`);

const concerns = (n: number): string => (n === 1 ? "1 concern" : `${n} concerns`);
const quiet = "btn btn-ghost min-h-11";

// One concern: a plain headline, the narration it is about (facts), and PB4's
// own reason folded away. The disclosure is the browser's own: opening it is
// local to the page and touches nothing else.
function FinalConcern({ issue, label }: { issue: FinalQaIssue; label: string }): React.ReactElement {
  return (
    <li data-final-issue={`${issue.film}-${issue.area}`} className="flex flex-col gap-2 py-4 border-b border-line last:border-b-0 min-w-0">
      <span className={kicker}>{label}</span>
      <span className="text-[15.5px] leading-[1.55] text-ink font-medium [text-wrap:pretty]">{AREA_HEADLINE[issue.area]}</span>
      {issue.text && <q className="font-serif text-[19px] leading-[1.4] text-ink [text-wrap:pretty] break-words">{issue.text}</q>}
      <details data-final-detail className="text-[13.5px]">
        <summary className="list-none [&::-webkit-details-marker]:hidden cursor-pointer w-fit text-dim hover:text-ink">Why PB4 stopped</summary>
        <p data-final-reason className="mt-2 leading-[1.55] text-muted [text-wrap:pretty] break-words">
          {issue.reason}
        </p>
      </details>
    </li>
  );
}

// Both films are rendered and checked, and something concrete is left. The
// concerns are grouped by film, each group with one way in: watch that film.
// Continue anyway accepts both films as they are and stays quiet here.
export function FinalException(props: { storyTitle: string; issues: FinalQaIssue[]; onReview: (film: VideoKind) => void; onContinue: () => void; continuing: boolean }): React.ReactElement {
  const { issues } = props;
  const groups = FILMS.map((film) => [film, issues.filter((i) => i.film === film)] as const).filter(([, list]) => list.length > 0);
  return (
    <div className="flex flex-col gap-7 max-w-[760px]">
      <div className="flex flex-col gap-2.5">
        <p className={attention}>{props.storyTitle ? `Films need you · ${props.storyTitle}` : "Films need you"}</p>
        <h1 className={title}>{issues.length ? things(issues.length) : "The finished films need a look"}</h1>
      </div>
      {groups.length > 0 && (
        <div aria-label="Film issues" className="flex flex-col gap-4">
          {groups.map(([film, list]) => (
            <section key={film} data-final-film={film} className="flex flex-col gap-1 rounded-[16px] border border-line bg-panel p-5 md:p-6">
              <div className="flex flex-wrap items-center justify-between gap-x-5 gap-y-3 pb-2">
                <div className="flex flex-col gap-1">
                  <h2 className="font-serif text-[22px] leading-none text-ink">{FILM_NAME[film]}</h2>
                  <span className="text-[13.5px] text-muted">{concerns(list.length)}</span>
                </div>
                <button onClick={() => props.onReview(film)} className={rowButton}>
                  Review {FILM_LABEL[film]}
                </button>
              </div>
              <ul className="flex flex-col border-t border-line">
                {list.map((i, n) => (
                  <FinalConcern key={n} issue={i} label={`${FILM_LABEL[i.film]} · ${AREA_LABEL[i.area]}`} />
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}
      <div className="flex flex-wrap items-center gap-x-5 gap-y-3">
        <button onClick={props.onContinue} disabled={props.continuing} data-action="accept-final" className={groups.length ? quiet : "btn btn-primary"}>
          {props.continuing ? "Continuing…" : "Continue anyway"}
        </button>
      </div>
    </div>
  );
}

// One finished film, before it is accepted: the actual render, what PB4 noticed
// about this film only, and the same pair-level Continue anyway. Watching,
// switching and going back change nothing on the server.
export function FinalFilmReview(props: {
  slug: string;
  film: VideoKind;
  issues: FinalQaIssue[];
  onFilm: (film: VideoKind) => void;
  onBack: () => void;
  onContinue: () => void;
  continuing: boolean;
}): React.ReactElement {
  const { film, issues } = props;
  const mine = issues.filter((i) => i.film === film);
  const both = FILMS.every((f) => issues.some((i) => i.film === f));
  return (
    <div className="flex flex-col gap-7 max-w-[1040px]">
      <div className="flex flex-col gap-4">
        <button onClick={props.onBack} className="inline-flex w-fit items-center gap-2 text-[14px] text-[#cabfb0] transition hover:text-accent">
          <span className="text-[15px] leading-none">←</span> Back to issues
        </button>
        <div className="flex flex-wrap items-center justify-between gap-4">
          <h1 className={title}>{FILM_NAME[film]}</h1>
          {both && (
            <div className="inline-flex rounded-full border border-line bg-[#15100e] p-[5px]">
              {FILMS.map((f) => (
                <button key={f} onClick={() => props.onFilm(f)} aria-pressed={f === film} className={`h-10 rounded-full px-[22px] text-[14px] font-semibold transition ${f === film ? "bg-accent text-white" : "text-[#8f8579] hover:text-ink"}`}>
                  {FILM_NAME[f]}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
      <FilmPlayer key={film} kind={film} src={finalRenderUrl(props.slug, film)} />
      {mine.length > 0 && (
        <section className="flex flex-col max-w-[760px]">
          <p className={kicker}>PB4 noticed</p>
          <ul className="flex flex-col">
            {mine.map((i, n) => (
              <FinalConcern key={n} issue={i} label={AREA_LABEL[i.area]} />
            ))}
          </ul>
        </section>
      )}
      <div className="flex flex-wrap items-center gap-x-5 gap-y-3 border-t border-line pt-5 max-w-[760px]">
        <button onClick={props.onContinue} disabled={props.continuing} data-action="accept-final" className={quiet}>
          {props.continuing ? "Continuing…" : "Continue anyway"}
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- Ready

function runtime(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

// Production finished: the pair this job rendered, what it cost, and a way to
// watch each film on the existing Watch page. Persistent: a reload shows it again.
export function ReadyPanel({ storyTitle, job, pair, onWatch }: { storyTitle: string; job: Job; pair: CompletePair; onWatch: (film: VideoKind) => void }): React.ReactElement {
  const card = "flex-1 min-w-0 flex flex-col gap-4 rounded-[16px] border border-line bg-panel p-5 md:p-6";
  const cost = money(job.spent);
  return (
    <div className="flex flex-col gap-8 max-w-[760px]">
      <div className="flex flex-col gap-2.5">
        <p className={`${kicker} flex items-center gap-2`}>
          <span aria-hidden="true" className="w-1.5 h-1.5 rounded-full bg-[#5aa06a]" />
          Ready
        </p>
        <h1 className={title}>{storyTitle}</h1>
      </div>
      <div className="flex flex-col md:flex-row gap-4">
        {([["long", "Long documentary", pair.long], ["short", "Short", pair.short]] as const).map(([kind, label, video]) => (
          <div key={kind} data-ready={kind} className={card}>
            <div className="flex items-baseline justify-between gap-3">
              <span className="font-serif text-[22px] leading-none text-ink">{label}</span>
              <span className="text-[14px] text-muted tabular-nums">{runtime(video.durationSec)}</span>
            </div>
            <button onClick={() => onWatch(kind)} className={`btn ${kind === "long" ? "btn-primary" : "btn-ghost"} w-full min-h-11`}>
              Watch {kind === "long" ? "Long" : "Short"}
            </button>
          </div>
        ))}
      </div>
      {cost && (
        <p className="text-[13.5px] text-dim tabular-nums">
          Production cost · <span className="text-ink">{cost}</span>
          {job.mock ? " (local mode)" : ""}
        </p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- Production details

// The plain facts behind a running production: where it is and what it has
// spent. Folded away. PB4's internal checks are not shown here.
export function ProductionDetails({ job, previous }: { job: Job; previous?: DisplayStage }): React.ReactElement {
  const rows: [string, string][] = [["Stage", stageLabel(job, previous)]];
  const spent = money(job.spent);
  const approved = money(job.approvedMax);
  if (spent) rows.push(["Spent so far", approved ? `${spent} of ${approved} approved` : spent]);
  const estimate = money(job.estimatedCost);
  if (estimate) rows.push(["Estimated total", estimate]);
  return (
    <details data-production-details>
      <summary className="list-none [&::-webkit-details-marker]:hidden cursor-pointer py-2.5 text-dim hover:text-ink">Production details</summary>
      <dl aria-label="Production details" className="pb-2 pt-1 flex flex-col gap-2 text-[13px]">
        {rows.map(([k, v]) => (
          <div key={k} className="flex justify-between gap-6 max-w-[360px]">
            <dt className="text-dim">{k}</dt>
            <dd className="m-0 text-muted tabular-nums">{v}</dd>
          </div>
        ))}
      </dl>
    </details>
  );
}
