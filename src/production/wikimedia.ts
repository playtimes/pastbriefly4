import { writeFile } from "node:fs/promises";
import { assertPublicUrl } from "../server/security.ts";

// A small Wikimedia Commons archive helper - the one automatic archive source
// for v1. Only licences that are explicitly usable for commercial production
// are accepted; unclear rights are never used automatically.

export interface ArchiveResult {
  sourcePage: string;
  assetUrl: string;
  credit: string;
  license: string;
  localPath: string;
}

const OK_LICENSE = /^(cc0|cc[ -]by(?![ -]?nc|[ -]?nd)|public domain|pd-|no restrictions)/i;

const nrm = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, "");

// Text metadata Wikimedia gives us for one result, flattened for matching.
function resultText(page: any, meta: any): string {
  return [page.title, meta.ObjectName?.value, meta.ImageDescription?.value, meta.Categories?.value]
    .map((v) => String(v || "").replace(/<[^>]*>/g, " "))
    .join(" ");
}

// A result counts as relevant when its metadata mentions at least one event term
// (proper noun / identifier / year). With no terms the check is skipped. This is
// what stops a generic photo of the same city being accepted as archive.
function relevantTerm(page: any, meta: any, relevance: string[]): string | null {
  if (!relevance.length) return "";
  const hay = nrm(resultText(page, meta));
  for (const t of relevance) {
    const n = nrm(t);
    if (n.length >= 3 && hay.includes(n)) return t;
  }
  return null;
}

export async function fetchArchive(query: string, outPath: string, relevance: string[] = []): Promise<ArchiveResult | null> {
  const api = new URL("https://commons.wikimedia.org/w/api.php");
  api.search = new URLSearchParams({
    action: "query",
    generator: "search",
    gsrsearch: query,
    gsrnamespace: "6",
    gsrlimit: "8",
    prop: "imageinfo",
    iiprop: "url|extmetadata|mime",
    iiurlwidth: "1920",
    format: "json",
    origin: "*",
  }).toString();

  const res = await fetch(api, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) {
    console.warn(`[archive] search HTTP ${res.status} for "${query}"`);
    return null;
  }
  const pages: any[] = Object.values((await res.json())?.query?.pages ?? {});

  let badMime = 0;
  let badLicense = 0;
  let irrelevant = 0;
  for (const page of pages) {
    const info = page.imageinfo?.[0];
    if (!info || !/^image\/(jpeg|png)$/.test(info.mime || "")) {
      badMime++;
      continue;
    }
    const meta = info.extmetadata || {};
    const license = (meta.LicenseShortName?.value || meta.License?.value || "").toString();
    if (!OK_LICENSE.test(license.trim())) {
      badLicense++;
      continue;
    }

    // Real photography of the same place is not archival evidence of the event.
    const matched = relevantTerm(page, meta, relevance);
    if (matched === null) {
      irrelevant++;
      console.log(`[archive] rejected unrelated result: ${page.title} (query "${query}")`);
      continue;
    }

    const assetUrl = info.thumburl || info.url;
    try {
      assertPublicUrl(assetUrl);
      const media = await fetch(assetUrl, { signal: AbortSignal.timeout(20000) });
      if (!media.ok) continue;
      await writeFile(outPath, Buffer.from(await media.arrayBuffer()));
    } catch {
      continue;
    }
    const credit = stripHtml(meta.Artist?.value || meta.Credit?.value || "Wikimedia Commons");
    console.log(`[archive] accepted: ${page.title}${matched ? ` (matched "${matched}", query "${query}")` : ` (query "${query}")`}`);
    return { sourcePage: info.descriptionurl || "", assetUrl, credit: `${credit} · ${license}`, license, localPath: outPath };
  }
  console.log(`[archive] "${query}": ${pages.length} results, none usable (mime ${badMime}, license ${badLicense}, unrelated ${irrelevant})`);
  return null;
}

function stripHtml(s: string): string {
  return s.replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim().slice(0, 80);
}
