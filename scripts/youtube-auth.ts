import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import type { AddressInfo } from "node:net";
import {
  assertGrantedScopes,
  buildAuthUrl,
  exchangeCode,
  getMyChannel,
  loadClient,
  ownerPaths,
  pkcePair,
  queryAnalytics,
  resolveRange,
  saveTokens,
  verifyChannel,
} from "../src/providers/youtubeOwner.ts";

// npm run youtube:auth
// Installed-app OAuth with a temporary 127.0.0.1 loopback listener and PKCE.
// Tokens are saved only after the authenticated channel is verified as PastBriefly.

const TIMEOUT_MS = 5 * 60 * 1000;

function openBrowser(url: string): void {
  const [cmd, args] =
    process.platform === "win32" ? ["rundll32", ["url.dll,FileProtocolHandler", url]] : process.platform === "darwin" ? ["open", [url]] : ["xdg-open", [url]];
  execFile(cmd, args as string[], () => {});
}

// Start the listener, send the user to Google, and resolve with the code once
// Google redirects back. The listener is always closed afterwards.
async function waitForCode(clientId: string): Promise<{ code: string; redirectUri: string; verifier: string }> {
  const { verifier, challenge } = pkcePair();
  const state = randomBytes(16).toString("hex");
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const redirectUri = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  try {
    const code = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Timed out waiting for Google sign-in (5 minutes).")), TIMEOUT_MS);
      server.on("request", (req, res) => {
        const u = new URL(req.url ?? "/", redirectUri);
        if (u.pathname !== "/") {
          res.writeHead(404).end();
          return;
        }
        const err = u.searchParams.get("error");
        const got = u.searchParams.get("code");
        const ok = !err && got && u.searchParams.get("state") === state;
        res.writeHead(ok ? 200 : 400, { "Content-Type": "text/plain; charset=utf-8" });
        res.end(ok ? "PB4: YouTube authorization received. You can close this tab." : "PB4: authorization failed. Check the terminal.");
        clearTimeout(timer);
        if (err) reject(new Error(`Google returned an error: ${err}`));
        else if (!ok) reject(new Error("Authorization response missing code or state mismatch."));
        else resolve(got);
      });
      const url = buildAuthUrl({ clientId, redirectUri, state, codeChallenge: challenge });
      console.log("Opening Google sign-in. If no browser opens, visit:\n");
      console.log(url + "\n");
      openBrowser(url);
    });
    return { code, redirectUri, verifier };
  } finally {
    server.close();
  }
}

async function main() {
  const paths = ownerPaths();
  const client = loadClient(paths);
  const { code, redirectUri, verifier } = await waitForCode(client.clientId);
  const tokens = await exchangeCode(client, code, redirectUri, verifier);
  assertGrantedScopes(tokens.scope);
  const auth = async () => tokens.access_token;

  const channel = await getMyChannel(auth);
  verifyChannel(channel);
  console.log(`Channel verified: ${channel.id} (${channel.title})`);

  const { startDate, endDate } = resolveRange({});
  const probe = await queryAnalytics(auth, { startDate, endDate, metrics: ["views"] });
  console.log(`Analytics API access OK (${startDate}..${endDate}: ${probe.rows[0]?.views ?? "no rows"} views)`);

  saveTokens(tokens, paths);
  console.log(`Token saved locally to ${paths.token}`);
}

main().catch((e) => {
  console.error(`youtube:auth failed: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
