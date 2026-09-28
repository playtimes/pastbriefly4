import { fileTokenProvider, initReportingJobs, ownerPaths, syncReports } from "../src/providers/youtubeOwner.ts";

// npm run youtube:reporting:init   create any missing PB4 reporting jobs (idempotent)
// npm run youtube:reporting:sync   download generated reports not yet stored

async function main() {
  const cmd = process.argv[2];
  const paths = ownerPaths();
  const auth = fileTokenProvider(paths);
  const log = (s: string) => console.log(s);

  if (cmd === "init") {
    const file = await initReportingJobs(auth, { paths, log });
    console.log(`${file.jobs.length} job(s) recorded in ${paths.jobs}`);
    if (file.unsupported.length) console.log(`Not offered for this channel: ${file.unsupported.join(", ")}`);
  } else if (cmd === "sync") {
    const { downloaded } = await syncReports(auth, { paths, log });
    console.log(downloaded ? `Downloaded ${downloaded} report(s) to ${paths.reports}` : "Nothing new to download.");
  } else {
    throw new Error("Usage: youtube-reporting.ts init|sync");
  }
}

main().catch((e) => {
  console.error(`youtube:reporting failed: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
