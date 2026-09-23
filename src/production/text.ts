// Small text helpers shared by narration, scripts and subtitle building.

export function splitSentences(text: string): string[] {
  return text
    .replace(/\s+/g, " ")
    .trim()
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export function words(text: string): string[] {
  return text.replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
}

export function wordCount(text: string): number {
  return words(text).length;
}

// Group consecutive sentences into ~count groups on sentence boundaries, and
// return each group's [wordStart, wordEnd) index range over the whole text.
export interface Group {
  text: string;
  wordStart: number;
  wordEnd: number; // exclusive
}

export function groupSentences(text: string, count: number): Group[] {
  const sentences = splitSentences(text);
  const total = wordCount(text);
  const target = Math.max(1, Math.floor(total / Math.max(1, count)));

  const groups: Group[] = [];
  let buf: string[] = [];
  let bufWords = 0;
  let wordCursor = 0;

  const flush = () => {
    if (!buf.length) return;
    const text = buf.join(" ");
    groups.push({ text, wordStart: wordCursor, wordEnd: wordCursor + bufWords });
    wordCursor += bufWords;
    buf = [];
    bufWords = 0;
  };

  for (const s of sentences) {
    buf.push(s);
    bufWords += wordCount(s);
    if (bufWords >= target && groups.length < count - 1) flush();
  }
  flush();
  return groups;
}

// 0 = no break, 1 = soft clause break (comma/semicolon/colon/dash), 2 = hard
// sentence end. A dash may be its own token (deDashed " - ") or trail a word.
function breakStrength(token: string): 0 | 1 | 2 {
  if (/[.!?]["'”’)\]]?$/.test(token)) return 2;
  if (/[,;:]$/.test(token)) return 1;
  if (/[-–—]$/.test(token) || /^[-–—]+$/.test(token)) return 1;
  return 0;
}

// Split a script into ~count visual beats, cutting on punctuation so a long
// sentence can become several beats (a comma/semicolon/colon/dash, else a
// sentence end, else a forced word-count cut for a runaway clause). Timing stays
// local: every beat carries its exact [wordStart, wordEnd) range and the ranges
// partition the whole text contiguously with no gaps. Tiny fragments are merged
// back into a neighbour so we never manufacture empty beats just to hit a number.
export function groupBeats(text: string, count: number): Group[] {
  const toks = words(text);
  const total = toks.length;
  if (total === 0) return [];
  const c = Math.max(1, count);
  const target = Math.max(1, Math.round(total / c));
  const minBeat = Math.min(target, Math.max(3, Math.floor(target * 0.5)));
  const maxBeat = Math.max(target + 1, Math.ceil(target * 1.7));

  const groups: Group[] = [];
  let start = 0;
  let buf: string[] = [];
  const flush = (end: number) => {
    if (!buf.length) return;
    groups.push({ text: buf.join(" "), wordStart: start, wordEnd: end });
    start = end;
    buf = [];
  };

  for (let i = 0; i < total; i++) {
    buf.push(toks[i]);
    if (i === total - 1) break; // the tail is flushed once, after the loop
    const len = buf.length;
    const brk = breakStrength(toks[i]);
    if (len >= target && brk > 0) flush(i + 1);
    else if (len >= maxBeat) flush(i + 1); // runaway clause with no punctuation: hard cut
  }
  flush(total);

  return mergeTinyGroups(groups, minBeat);
}

// Fold any beat shorter than minBeat into a neighbour, keeping ranges contiguous.
function mergeTinyGroups(groups: Group[], minBeat: number): Group[] {
  if (groups.length <= 1) return groups;
  const out: Group[] = [];
  for (const g of groups) {
    const prev = out[out.length - 1];
    if (prev && g.wordEnd - g.wordStart < minBeat) {
      prev.text = `${prev.text} ${g.text}`;
      prev.wordEnd = g.wordEnd;
    } else {
      out.push({ ...g });
    }
  }
  // A tiny opening beat has no previous neighbour above; merge it forward instead.
  if (out.length > 1 && out[0].wordEnd - out[0].wordStart < minBeat) {
    const [first, second] = out;
    second.wordStart = first.wordStart;
    second.text = `${first.text} ${second.text}`;
    out.shift();
  }
  return out;
}
