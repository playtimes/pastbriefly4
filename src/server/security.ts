import path from "node:path";
import net from "node:net";
import { MEDIA_DIR } from "./config.ts";

// Resolve a media-relative path and keep it under MEDIA_DIR.
export function safeMediaPath(rel: string): string | null {
  const resolved = path.resolve(MEDIA_DIR, "." + path.sep + rel);
  const root = path.resolve(MEDIA_DIR) + path.sep;
  return resolved.startsWith(root) ? resolved : null;
}

// Reject private/internal/non-http targets before fetching a URL.
export function assertPublicUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`Invalid URL: ${raw}`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error(`Blocked protocol: ${url.protocol}`);
  const host = url.hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".local") || !host.includes(".")) throw new Error(`Blocked host: ${host}`);
  if (net.isIP(host) && isPrivateIp(host)) throw new Error(`Blocked private address: ${host}`);
  return url;
}

function isPrivateIp(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split(".").map(Number);
    return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) || a === 0;
  }
  return ip === "::1" || ip.startsWith("fc") || ip.startsWith("fd") || ip.startsWith("fe80");
}
