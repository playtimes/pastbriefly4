import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { retainedArchiveDir } from "./paths.ts";
import type { ArchiveResult } from "./wikimedia.ts";

// Archive retention (Stage 16A Slice 1). A file fetchArchive accepted and
// downloaded is also kept, story-scoped, under DATA_DIR/archive-retained/<slug>/,
// so it survives when the working archive/ copy is deleted (a final-repair
// rejection, a new job, a visual rebuild). One media file per byte identity
// (<full sha256>.jpg|png) plus one JSON provenance record (<full sha256>.json).
//
// Retained means SCREENED ARCHIVE CANDIDATE: it passed fetchArchive's acquisition
// screening (image MIME, licence policy, query anchors / story relevance,
// duplicate check, a successful download). It is NOT production-approved, NOT
// judged factually right for any shot, and NOT passed by Pixel Asset QA for any
// future use. Nothing reads this folder into a film.
//
// Retention is durability support, never a production gate: both functions log
// a warning and return on any failure.

export interface RetainedAcquisition {
  at: string;
  query: string;
  film: "long" | "short";
  owner: string; // the archive ledger owner, e.g. "long:L05"
  jobId?: string;
}

export interface RetainedReview {
  at: string;
  film: "long" | "short";
  assetId: string;
  decision: "rejected"; // for that slot only; the candidate may still suit another use
  reason: string;
  by: "final visual repair";
  jobId?: string;
}

export interface RetainedArchive {
  status: "screened archive candidate";
  sha256: string;
  file: string;
  story: string;
  // Commons provenance from the first acquisition, exactly as Commons supplied it.
  title: string;
  sourcePage: string;
  assetUrl: string;
  license: string;
  artist?: string; // raw Commons Artist field
  rawCredit?: string; // raw Commons Credit field
  credit: string; // the normalised display credit PB4 shows
  acquisitions: RetainedAcquisition[];
  reviews: RetainedReview[];
}

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// The real image type: the bytes' signature, else the MIME Commons declared.
function imageExt(bytes: Buffer, mime: string): "jpg" | "png" | null {
  if (bytes.subarray(0, 8).equals(PNG)) return "png";
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "jpg";
  return mime === "image/png" ? "png" : mime === "image/jpeg" ? "jpg" : null;
}

function writeAtomic(file: string, data: string | Buffer): void {
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, data);
  renameSync(tmp, file);
}

function readRecord(sidecar: string): RetainedArchive | null {
  return existsSync(sidecar) ? (JSON.parse(readFileSync(sidecar, "utf8")) as RetainedArchive) : null;
}

// Keep one accepted candidate (its working file at got.localPath) and append this
// acquisition. The same bytes accepted again add an event, never a second file.
export function retainArchiveCandidate(slug: string, got: ArchiveResult, acquisition: Omit<RetainedAcquisition, "at">): void {
  try {
    if (!/^[0-9a-f]{64}$/.test(got.sha256)) throw new Error(`not a full SHA-256: "${got.sha256}"`);
    const bytes = readFileSync(got.localPath);
    if (createHash("sha256").update(bytes).digest("hex") !== got.sha256) throw new Error("the working file no longer matches its SHA-256");
    const dir = retainedArchiveDir(slug);
    mkdirSync(dir, { recursive: true });
    const sidecar = path.join(dir, `${got.sha256}.json`);
    const prior = readRecord(sidecar);
    const ext = imageExt(bytes, got.mime);
    if (!prior && !ext) throw new Error(`unrecognised image type (${got.mime})`);
    const record: RetainedArchive = prior ?? {
      status: "screened archive candidate",
      sha256: got.sha256,
      file: `${got.sha256}.${ext}`,
      story: slug,
      title: got.title,
      sourcePage: got.sourcePage,
      assetUrl: got.assetUrl,
      license: got.license,
      artist: got.artist, // undefined (absent in Commons) is left out of the JSON
      rawCredit: got.rawCredit,
      credit: got.credit,
      acquisitions: [],
      reviews: [],
    };
    const media = path.join(dir, record.file);
    if (!existsSync(media)) writeAtomic(media, bytes);
    record.acquisitions.push({ at: new Date().toISOString(), ...acquisition });
    writeAtomic(sidecar, JSON.stringify(record, null, 2));
  } catch (e: any) {
    console.warn(`[archive] retention failed for ${got.title || got.localPath} (production continues): ${e?.message || e}`);
  }
}

// Note a review outcome on an already-retained candidate, by its SHA-256. The
// retained file itself is never touched or bound to anything.
export function recordArchiveReview(slug: string, sha256: string | undefined, review: Omit<RetainedReview, "at">): void {
  try {
    if (!sha256 || !/^[0-9a-f]{64}$/.test(sha256)) throw new Error("no retained identity");
    const sidecar = path.join(retainedArchiveDir(slug), `${sha256}.json`);
    const record = readRecord(sidecar);
    if (!record) throw new Error("no retained record");
    record.reviews.push({ at: new Date().toISOString(), ...review });
    writeAtomic(sidecar, JSON.stringify(record, null, 2));
  } catch (e: any) {
    console.warn(`[archive] could not record the review of ${sha256 ?? "an unretained file"}: ${e?.message || e}`);
  }
}
