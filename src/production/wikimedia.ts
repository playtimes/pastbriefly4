import { writeFile } from "node:fs/promises";
import { assertPublicUrl } from "../server/security.ts";

// A small Wikimedia Commons archive helper — the one automatic archive source
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

export async function fetchArchive(query: string, outPath: string): Promise<ArchiveResult | null> {
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
  if (!res.ok) return null;
  const pages: any[] = Object.values((await res.json())?.query?.pages ?? {});

  for (const page of pages) {
    const info = page.imageinfo?.[0];
    if (!info || !/^image\/(jpeg|png)$/.test(info.mime || "")) continue;
    const meta = info.extmetadata || {};
    const license = (meta.LicenseShortName?.value || meta.License?.value || "").toString();
    if (!OK_LICENSE.test(license.trim())) continue;

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
    return { sourcePage: info.descriptionurl || "", assetUrl, credit: `${credit} · ${license}`, license, localPath: outPath };
  }
  return null;
}

function stripHtml(s: string): string {
  return s.replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim().slice(0, 80);
}
