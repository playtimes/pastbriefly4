# PastBriefly Historical Channel Baseline

Factual baseline only. No recommendations in this file. Analysis lives in `VIDEO-AUDIT.md`.

Final Phase 5 version (2026-09-27). Official YouTube data is now the primary source for our own channel. vidIQ figures are kept only as a cross-check.

## Sources

| Source | What it provides here | Window | Raw location (gitignored) | Status |
|---|---|---|---|---|
| **YouTube Analytics API v2** | Channel totals, per-video metrics, channel-level traffic sources, 100-point retention curve per video | **2026-08-01 to 2026-09-26**. The first upload was 2026-08-06, so this is lifetime-to-date through 2026-09-26. | `data/analytics/youtube/snapshots/2026-09-27/2026-08-01_2026-09-26/` | **Primary** for totals, per-video performance, APV, AVD, subscribers, retention, channel traffic |
| **YouTube Reporting API v1** | Daily per-video rows: basic metrics (`channel_basic_a3`), traffic source (`channel_traffic_source_a3`), thumbnail impressions and CTR (`channel_reach_basic_a1`) | **2026-08-27 to 2026-09-25** only (30 daily reports per type, see Reporting coverage) | `data/analytics/youtube/reports/` | **Enrichment only.** Partial window, never treated as lifetime |
| **YouTube Data API v3** | Inventory (id, title, publish time, duration, privacy) and public counters | Read 2026-09-27 | `snapshots/.../videos.json` | Identity and inventory only. Public counters are not mixed into window rates |
| **vidIQ** (Phase 4A/5A audit) | Earlier read of the same YouTube Analytics data via vidIQ | 2026-08-01 to 2026-09-26 | not stored | **Secondary cross-check.** 0 vidIQ credits spent in this phase |

## Scope

| Item | Value |
|---|---|
| Channel ID | `UCpAzru3r59YyCJrixIHiMPg` ("Past Briefly", created 2026-05-26) |
| Inventory | 11 Shorts, 0 long-form, 0 live. All 11 public. |
| Publication window | 2026-08-06 to 2026-09-03 |
| Snapshot retrieved | 2026-09-27 00:03 UTC |

## Official historical totals (Analytics API, 2026-08-01 to 2026-09-26)

| Metric | Value | Note |
|---|---|---|
| Views | 7,104 | per-video rows and traffic rows both sum to 7,104 |
| Engaged views | 3,065 | 43.1% of views. YouTube reports this separately from `views`. For Shorts, `views` counts plays and replays, so the two are not interchangeable. |
| Watch time | 1,817 min | per-video rows sum to 1,811 (rounding in per-row minutes) |
| Average view duration | 33 s | channel level, as computed by YouTube |
| Average percentage viewed | 83.87% | channel level, as computed by YouTube (the unweighted mean of the 11 per-video values is 73.0%) |
| Likes | 136 | |
| Comments | 4 | |
| Shares | 3 | Warship 1, Jet 1, Eclipse 1 |
| Subscribers gained | 12 | only 6 are attributed to a specific Short. The other 6 are not tied to any video (for example the channel page) |
| Subscribers lost | 1 | |
| Net subscribers | +11 | |

## Upload inventory (Analytics API window)

APV = average percentage viewed (over 100% means replays or loops). AVD = average view duration. URL form: `https://youtube.com/shorts/<id>`. Short names used in the other files are in brackets.

| # | Published (UTC) | Video ID | Title | Dur | Views | Engaged | Watch min | AVD s | APV % | Likes | Com | Shares | Subs +/- |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | 2026-08-06 17:16 | `qy--42md4-s` | He Won an Olympic Marathon on Rat Poison [Rat poison] | 26s | 577 | 178 | 92 | 28 | 109.01 | 11 | 0 | 0 | +1/0 |
| 2 | 2026-08-07 16:28 | `D775RBsFDjY` | 1816: The Year Without a Summer [1816] | 34s | 300 | 93 | 28 | 15 | 45.77 | 8 | 0 | 0 | +1/0 |
| 3 | 2026-08-08 20:43 | `dJq6h3HZ9TA` | The Dead Man Who Fooled Hitler [Dead man] | 39s | 549 | 215 | 155 | 41 | 105.55 | 8 | 0 | 0 | 0/0 |
| 4 | 2026-08-09 18:38 | `0ZqVLrqlHvE` | The Warship That Sank After Just 20 Minutes [Warship] | 38s | 1,422 | 569 | 269 | 26 | 70.35 | 30 | 2 | 1 | 0/0 |
| 5 | 2026-08-10 20:31 | `3zEHWc4Sex8` | The Lake Nyos Disaster [Lake Nyos] | 39s | 59 | 26 | 9 | 19 | 49.50 | 3 | 0 | 0 | 0/0 |
| 6 | 2026-08-12 13:44 | `n_2_d6V0HDY` | The Eclipse That Tested Einstein [Eclipse] | 31s | 123 | 47 | 19 | 23 | 74.79 | 7 | 0 | 1 | 0/0 |
| 7 | 2026-08-14 08:48 | `jB86dpc-yzI` | A Pig Nearly Started a War Between Britain and America [Pig] | 38s | 1,373 | 601 | 282 | 26 | 69.35 | 17 | 0 | 0 | 0/0 |
| 8 | 2026-08-18 15:23 | `b1K79y0P3mA` | The Passenger Jet That Ran Out of Fuel Mid-Flight [Jet] | 49s | 1,172 | 555 | 523 | 55 | 112.93 | 33 | 2 | 1 | +3/0 |
| 9 | 2026-08-24 18:17 | `viSKDfP-pSk` | How One Trader Broke a 233-Year-Old Bank [Trader / Barings] | 42s | 175 | 54 | 16 | 15 | 36.37 | 5 | 0 | 0 | 0/0 |
| 10 | 2026-08-29 12:18 | `VBJlJsEkjGM` | Why the U.S. Sent 813 Troops to Cut Down One Tree [Tree / Paul Bunyan] | 43s | 1,188 | 661 | 393 | 34 | 80.94 | 12 | 0 | 0 | +1/0 |
| 11 | 2026-09-03 10:04 | `ZLMNSiKkXO0` | The First Conviction in Tupac's Murder Case Took Almost 30 Years [Tupac] | 45s | 166 | 66 | 25 | 21 | 48.62 | 2 | 0 | 0 | 0/0 |

All 11 accounted for once, and they match the 11 uploads in the Data API inventory. Data API public counters (2026-09-27) differ from the window by at most 5 views per video. Public comment counts are Warship 1 and Jet 3, while Analytics shows 2 and 2 (a comment removed, and one posted after 09-26).

## Traffic (Analytics API, channel level, 2026-08-01 to 2026-09-26)

| Source (`insightTrafficSourceType`) | Views | Share | Watch min |
|---|---|---|---|
| Shorts feed (`SHORTS`) | 6,604 | 93.0% | 1,650 |
| YouTube search (`YT_SEARCH`) | 196 | 2.8% | 24 |
| Channel pages (`YT_CHANNEL`) | 170 | 2.4% | 119 |
| Other YouTube features (`YT_OTHER_PAGE`) | 106 | 1.5% | 16 |
| Browse features (`SUBSCRIBER`) | 15 | 0.2% | 2 |
| Notifications | 6 | 0.1% | 1 |
| External (`EXT_URL`) | 4 | 0.1% | 2 |
| Sound pages | 3 | <0.1% | 0 |
| Related video, other | 0 | 0% | 0 |

Channel-page viewers averaged about 42 s per view (119 min / 170 views), against about 15 s for Shorts-feed viewers (1,650 / 6,604). The snapshot has no per-video traffic split. For the Reporting window, see below.

## Reporting coverage (Reporting API)

The jobs were created on 2026-09-27 at 00:04 UTC. YouTube then generated a backfill of the previous 30 days (report createTime 2026-09-27 08:46 to 08:53 UTC). Each report covers one Pacific-time day, running from 07:00 UTC to 07:00 UTC the next day.

| Report type | Reports | Current | Superseded | Earliest day | Latest day | Days with data rows |
|---|---|---|---|---|---|---|
| `channel_basic_a3` | 30 | 30 | 0 | 2026-08-27 | 2026-09-25 | 16 (the other 14 files contain only a header, meaning days with zero views) |
| `channel_traffic_source_a3` | 30 | 30 | 0 | 2026-08-27 | 2026-09-25 | 16 (same 14 zero-view days) |
| `channel_reach_basic_a1` | 30 | 30 | 0 | 2026-08-27 | 2026-09-25 | 28 (2026-09-19 and 2026-09-20 contain only a header) |

Verification:
- 30 reports per type and 90 in total. Every report id is unique, and every indexed CSV exists.
- There is exactly one current report per period per type and no duplicates. No report has been superseded yet, because no newer backfill exists for any period.
- In every CSV, the `date` column matches the report's period.
- **2026-09-26** is in the Analytics window but not yet in Reporting.
- **Nothing before 2026-08-27 exists in Reporting.** Eight of the 11 Shorts were published before 2026-08-24, and Trader was published on 2026-08-24. Only Tree (2026-08-29) and Tupac (2026-09-03) launched inside the Reporting window.

## Reporting: traffic (2026-08-27 to 2026-09-25 only)

Reporting uses numeric `traffic_source_type` codes. The labels below follow the Reporting API documentation.

| Code | Source | Views | Share of window | Of which Tree | Of which Tupac |
|---|---|---|---|---|---|
| 24 | Shorts feed | 1,262 | 89.1% | 1,159 | 100 |
| 5 | YouTube search | 88 | 6.2% | 13 | 61 |
| 4 | Channel pages | 56 | 4.0% | 9 | 5 |
| 8 | Other YouTube features | 9 | 0.6% | 9 | 0 |
| 3 | Browse features (`what-to-watch`) | 1 | 0.1% | 0 | 1 |
| 9 | External (duckduckgo.com) | 1 | 0.1% | 0 | 0 |
| | **Total** | **1,417** | | **1,190** | **167** |

Comparison with the Analytics API traffic (not reconciled):
- **Period:** Reporting covers 30 days (2026-08-27 to 2026-09-25). Analytics covers 57 days (2026-08-01 to 2026-09-26). The 89.1% and 93.0% Shorts-feed shares describe different periods and different mixes of videos, so they are not compared.
- **Report availability:** anything before 2026-08-27, including the launches of the 9 older Shorts, exists only in the Analytics API.
- **Metric semantics:** the two APIs label sources differently. Analytics `SUBSCRIBER` corresponds to Reporting "Browse features" (3), and `YT_OTHER_PAGE` corresponds to "Other YouTube features" (8).
- **Processing:** for the two launches fully inside both windows, Reporting shows 1 to 2 more views than Analytics (Tree 1,190 against 1,188, Tupac 167 against 166), even though Reporting's window is a subset. The cause is UNKNOWN. It is probably separate processing, and it is too small to matter.

## Reporting: basic daily (2026-08-27 to 2026-09-25 only)

Only data that the Analytics snapshot lacks is listed here. For APV, AVD, subscribers and totals, the Analytics API remains the source.

- **Launch concentration:**
  - Tree: 932 views on its launch day (2026-08-29), 247 the next day, then 3. That is 99.1% of its window views in 2 days.
  - Tupac: 138 on launch day (2026-09-03), 15, then 11. That is 91.6% in 2 days.
- **Post-launch tail:** the 9 older Shorts drew 2 to 12 views each in the whole 30-day window. The last 14 days (2026-09-12 to 2026-09-25) had 32 views channel-wide, 27 of them on 2026-09-25.
- **Subscribed status:**
  - Tree: 1,187 of its 1,190 views came from viewers not subscribed.
  - Tupac: 163 of its 167.
- **Country** (all 1,417 window views): US 539 (38.0%), GB 106, PH 99, SE 94, CA 61, AU 53, MY 43, IN 31, ZA 31, NL 22.
- **Shares** in the window: 0.
- **Subscribers** in the window: +2. One is attributed to Tree, and one on 2026-09-02 is not tied to any video.

## Reach / CTR (Reporting API `channel_reach_basic_a1`, 2026-08-27 to 2026-09-25 only)

`video_thumbnail_impressions` and `video_thumbnail_impressions_ctr` are reported per video per day. The per-video CTR below is weighted by impressions: the sum of impressions x CTR, divided by total impressions. "Est. clicks" is that product, rounded.

| Short | Impressions | Weighted CTR | Est. clicks | Days with impressions | Impression dates | Launch period covered? |
|---|---|---|---|---|---|---|
| Tupac | 981 | 0.61% | 6 | 13 | 2026-09-03 to 2026-09-25 | **Yes** (published 09-03) |
| Tree | 157 | 4.46% | 7 | 19 | 2026-08-29 to 2026-09-25 | **Yes** (published 08-29) |
| Jet | 176 | 0.00% | 0 | 24 | 2026-08-27 to 2026-09-25 | UNKNOWN FOR ORIGINAL LAUNCH PERIOD |
| Trader | 172 | 0.00% | 0 | 20 | 2026-08-27 to 2026-09-25 | UNKNOWN FOR ORIGINAL LAUNCH PERIOD |
| Eclipse | 162 | 0.00% | 0 | 21 | 2026-08-27 to 2026-09-25 | UNKNOWN FOR ORIGINAL LAUNCH PERIOD |
| Pig | 156 | 0.64% | 1 | 20 | 2026-08-27 to 2026-09-25 | UNKNOWN FOR ORIGINAL LAUNCH PERIOD |
| Lake Nyos | 145 | 0.69% | 1 | 18 | 2026-08-27 to 2026-09-25 | UNKNOWN FOR ORIGINAL LAUNCH PERIOD |
| 1816 | 137 | 0.00% | 0 | 18 | 2026-08-27 to 2026-09-25 | UNKNOWN FOR ORIGINAL LAUNCH PERIOD |
| Warship | 135 | 0.74% | 1 | 18 | 2026-08-27 to 2026-09-25 | UNKNOWN FOR ORIGINAL LAUNCH PERIOD |
| Dead man | 126 | 0.00% | 0 | 17 | 2026-08-27 to 2026-09-25 | UNKNOWN FOR ORIGINAL LAUNCH PERIOD |
| Rat poison | 36 | 2.78% | 1 | 16 | 2026-08-27 to 2026-09-25 | UNKNOWN FOR ORIGINAL LAUNCH PERIOD |
| **Total** | **2,383** | | **~17** | | | |

**Backfill limitation:**
- The Reporting API only backfilled about 30 days when the jobs were created (2026-09-27).
- For the 9 Shorts published between 2026-08-06 and 2026-08-24, the numbers above are post-launch tail data, weeks after their feed distribution ended. They say nothing about how those Shorts were distributed at launch.
- None of these figures is lifetime CTR.
- Reach and CTR for those 9 are **UNKNOWN FOR ORIGINAL LAUNCH PERIOD**.

**What these impressions measure:**
- These are thumbnail impressions, and they do not track Shorts-feed distribution.
- Tree drew 1,159 Shorts-feed views but only 157 thumbnail impressions.
- The 9 older Shorts show nearly identical impression counts (126 to 176) whatever their view counts (59 to 1,422).
- Their impressions cluster on 2026-08-29, 2026-08-30 and 2026-09-03, which are the Tree and Tupac launch days. That is consistent with surfaces such as the channel page being browsed by new viewers (HYPOTHESIS).
- Tupac's 981 impressions alongside 61 search views suggest it was shown as a thumbnail in search results. This is also a HYPOTHESIS, because the reach report has no surface breakdown.

## Retention baseline (Analytics API, 2026-08-01 to 2026-09-26)

**Metrics:**
- `audienceWatchRatio` (AWR) is views of that moment divided by the video's views. It exceeds 1.0 when viewers rewatch or loop, so it is not a "% still watching".
- `relativeRetentionPerformance` (RRP) compares a moment against YouTube videos of similar length. 0.5 is typical, and higher is better. It is a relative rank, not an absolute retention figure.
- Each curve has 100 points (1% steps). The values below are the exact returned rows.
- "10 s" uses the nearest row to 10 seconds, which is accurate to within half a percentage step of runtime.

| Short | Dur | AWR 1% | AWR 10 s | AWR 25% | AWR 50% | AWR 75% | AWR end | RRP 25% | RRP 50% | RRP end |
|---|---|---|---|---|---|---|---|---|---|---|
| Jet | 49s | 1.99 | 1.39 | 1.33 | 1.12 | 1.06 | 1.01 | 0.52 | 0.59 | 0.95 |
| Rat poison | 26s | 1.79 | 1.12 | 1.27 | 1.04 | 0.93 | 0.84 | 0.51 | 0.56 | 0.85 |
| Dead man | 39s | 1.85 | 1.09 | 1.12 | 0.96 | 0.92 | 0.86 | 0.50 | 0.55 | 0.94 |
| Tree | 43s | 1.57 | 0.89 | 0.86 | 0.76 | 0.65 | 0.56 | 0.51 | 0.59 | 0.87 |
| Eclipse | 31s | 1.32 | 0.85 | 0.94 | 0.72 | 0.60 | 0.38 | 0.45 | 0.52 | 0.67 |
| Warship | 38s | 1.46 | 0.80 | 0.81 | 0.65 | 0.55 | 0.47 | 0.34 | 0.42 | 0.83 |
| Pig | 38s | 1.41 | 0.81 | 0.82 | 0.59 | 0.52 | 0.45 | 0.46 | 0.53 | 0.94 |
| Tupac | 45s | 1.28 | 0.64 | 0.61 | 0.38 | 0.33 | 0.25 | 0.33 | 0.30 | 0.71 |
| 1816 | 34s | 1.18 | 0.54 | 0.61 | 0.35 | 0.24 | 0.17 | 0.13 | 0.12 | 0.45 |
| Lake Nyos | 39s | 1.38 | 0.50 | 0.50 | 0.35 | 0.35 | 0.31 | 0.20 | 0.33 | 0.69 |
| Trader | 42s | 1.13 | 0.43 | 0.42 | 0.28 | 0.19 | 0.17 | 0.16 | 0.24 | 0.86 |

Rat poison is 26 s long, so its "10 s" point is already at 38% of runtime.

**Early-loss shape:** AWR loss per second in fixed windows (0-2 s, 2-4 s, 4-7 s, 7-10 s, 10-15 s).
- The 4-7 s window has the fastest loss in 10 of the 11 Shorts.
- Eclipse ties its 0-2 s and 4-7 s windows.
- Warship's loss is spread almost evenly from the first second to 7 s.
- The AWR drop from 4 s to 7 s ranges from 0.19 (Eclipse) to 0.46 (Lake Nyos), with a median of 0.30.

## Cross-check against the vidIQ audit

vidIQ read the same underlying YouTube Analytics data, and the retention curves agree to two decimals. Where the earlier audit differs or had gaps:

| Item | vidIQ audit said | Official data |
|---|---|---|
| Watch time | 1,802 (daily) / 1,811 (per-video) min | 1,817 min channel total, 1,811 per-video sum |
| Channel APV | ~82% (Shorts-feed row of the traffic report) | 83.87% channel-level APV, 33 s AVD |
| Shares | not available | 3 (Warship, Jet, Eclipse) |
| Engaged views | not available | 3,065 (43.1% of views) |
| Impressions / CTR | not available | available only for 2026-08-27 to 2026-09-25, and they do not measure the Shorts feed |
| Per-video traffic | not retrieved | available for 2026-08-27 to 2026-09-25 only (Tree, Tupac launches) |
| Eclipse RRP 25% | 0.46 | 0.455 (rounding) |
| Recent activity | "2026-09-13 to 2026-09-26: 5 views" | Reporting shows 32 views for 2026-09-13 to 2026-09-25, 27 of them on 2026-09-25 (Pig 8, Eclipse 4, Warship 3, Jet 3, others 1-2). This was probably Analytics data latency for the latest days at the time vidIQ read it (cause UNKNOWN). The channel is still near-dormant between uploads. |
| "Sharpest early decline at 4-7 s in all 11" | stated for all 11 | true for 10 of 11. Eclipse ties 0-2 s and 4-7 s, and Warship's loss starts from the first second. |

## Important limitation

**There is no historical PastBriefly long-form dataset.**
- Every number above comes from Shorts of 26 to 49 seconds, distributed mostly by the Shorts feed.
- None of it measures long-form CTR, long-form retention, runtime, pacing or 4-9 minute structure.
- The whole channel has 7,104 views, 12 subscribers gained and 4 comments, so nothing here is statistically significant.
