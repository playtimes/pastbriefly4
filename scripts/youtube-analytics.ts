import { fileTokenProvider, ownerPaths, resolveRange, takeSnapshot } from "../src/providers/youtubeOwner.ts";

// npm run youtube:analytics [-- --start YYYY-MM-DD --end YYYY-MM-DD] [--videos id1,id2]
// Official owner snapshot for one labelled date range. Without dates: the 28
// complete days ending yesterday (UTC). Retention is fetched for every upload
// unless --videos narrows it.

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const { startDate, endDate } = resolveRange({ start: arg("start"), end: arg("end") });
  const videoIds = arg("videos")?.split(",").map((s) => s.trim()).filter(Boolean);
  const paths = ownerPaths();
  console.log(`Snapshot range ${startDate}..${endDate}`);
  const dir = await takeSnapshot(fileTokenProvider(paths), { startDate, endDate, videoIds, paths, log: (s) => console.log(s) });
  console.log(`Snapshot written to ${dir}`);
}

main().catch((e) => {
  console.error(`youtube:analytics failed: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
