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
