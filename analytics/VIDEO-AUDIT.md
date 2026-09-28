# PastBriefly Short-Era Video Audit (Phase 5 final)

Source: `CHANNEL-BASELINE.md`.

The official YouTube Analytics API (2026-08-01 to 2026-09-26, effectively lifetime-to-date) is authoritative. Reporting API data (2026-08-27 to 2026-09-25 only) is used where it adds information, and its window is always stated. vidIQ is a secondary cross-check.

Every video here is a Short (26 to 49 s). **Nothing in this file says anything about long-form runtime, pacing or 4-9 minute structure.**

Evidence labels:
- **STRONG SIGNAL:** multiple independent videos support it.
- **WEAK SIGNAL:** interesting, but based on little data.
- **HYPOTHESIS:** something to test in future films.
- **UNKNOWN:** the data cannot answer it.

With 11 Shorts and 7,104 views, even a STRONG SIGNAL is an association, not a proven cause.

## 1. Per-video metrics (Analytics API, 2026-08-01 to 2026-09-26)

Sorted by views.

**How the columns are defined:**
- Eng % = engaged views / views.
- Likes /1k = likes per 1,000 views.
- Subs /1k = net subscribers per 1,000 views.
- For Shorts, `views` includes replays, so looping Shorts can show a lower Eng % (see section 4C).

| Short | Dur | Views | Engaged | Eng % | AVD s | APV % | Likes | Likes /1k | Com | Shares | Subs +/- | Subs /1k |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Warship | 38s | 1,422 | 569 | 40.0 | 26 | 70.35 | 30 | 21.1 | 2 | 1 | 0/0 | 0.00 |
| Pig | 38s | 1,373 | 601 | 43.8 | 26 | 69.35 | 17 | 12.4 | 0 | 0 | 0/0 | 0.00 |
| Tree (Paul Bunyan) | 43s | 1,188 | 661 | 55.6 | 34 | 80.94 | 12 | 10.1 | 0 | 0 | 1/0 | 0.84 |
| Jet | 49s | 1,172 | 555 | 47.4 | 55 | 112.93 | 33 | 28.2 | 2 | 1 | 3/0 | 2.56 |
| Rat poison | 26s | 577 | 178 | 30.8 | 28 | 109.01 | 11 | 19.1 | 0 | 0 | 1/0 | 1.73 |
| Dead man | 39s | 549 | 215 | 39.2 | 41 | 105.55 | 8 | 14.6 | 0 | 0 | 0/0 | 0.00 |
| 1816 | 34s | 300 | 93 | 31.0 | 15 | 45.77 | 8 | 26.7 | 0 | 0 | 1/0 | 3.33 |
| Trader (Barings) | 42s | 175 | 54 | 30.9 | 15 | 36.37 | 5 | 28.6 | 0 | 0 | 0/0 | 0.00 |
| Tupac | 45s | 166 | 66 | 39.8 | 21 | 48.62 | 2 | 12.0 | 0 | 0 | 0/0 | 0.00 |
| Eclipse | 31s | 123 | 47 | 38.2 | 23 | 74.79 | 7 | 56.9 | 0 | 1 | 0/0 | 0.00 |
| Lake Nyos | 39s | 59 | 26 | 44.1 | 19 | 49.50 | 3 | 50.8 | 0 | 0 | 0/0 | 0.00 |
| **Sum** | | **7,104** | **3,065** | | | | **136** | | **4** | **3** | **6/0** | |

All 11 appear exactly once, and the rows sum to the channel totals: views 7,104, engaged views 3,065, likes 136, comments 4, shares 3. 6 of the channel's 12 subscribers are attributed to individual Shorts.

## 2. Retention (Analytics API, same window)

AWR is `audienceWatchRatio` and can exceed 1.0 because of replays. RRP is `relativeRetentionPerformance`: it compares each moment with similar-length YouTube videos, 0.5 is typical, and it is **not** absolute retention.

| Short | AWR 4 s | AWR 7 s | AWR 10 s | AWR 25% | AWR 50% | AWR end | Drop 4->7 s | RRP 25% | RRP 50% | RRP end |
|---|---|---|---|---|---|---|---|---|---|---|
| Jet | 1.79 | 1.55 | 1.39 | 1.33 | **1.12** | **1.01** | 0.23 | 0.52 | 0.59 | 0.95 |
| Rat poison | 1.52 | 1.22 | 1.12 | 1.27 | **1.04** | 0.84 | 0.30 | 0.51 | 0.56 | 0.85 |
| Dead man | 1.62 | 1.27 | 1.09 | 1.12 | 0.96 | 0.86 | 0.35 | 0.50 | 0.55 | 0.94 |
| Tree | 1.38 | 1.07 | 0.89 | 0.86 | 0.76 | 0.56 | 0.31 | 0.51 | 0.59 | 0.87 |
| Eclipse | 1.13 | 0.94 | 0.85 | 0.94 | 0.72 | 0.38 | 0.19 | 0.45 | 0.52 | 0.67 |
| Warship | 1.15 | 0.88 | 0.80 | 0.81 | 0.65 | 0.47 | 0.27 | 0.34 | 0.42 | 0.83 |
| Pig | 1.24 | 0.94 | 0.81 | 0.82 | 0.59 | 0.45 | 0.30 | 0.46 | 0.53 | 0.94 |
| Tupac | 1.09 | 0.73 | 0.64 | 0.61 | 0.38 | 0.25 | 0.36 | 0.33 | 0.30 | 0.71 |
| 1816 | 0.94 | 0.70 | 0.54 | 0.61 | 0.35 | 0.17 | 0.24 | 0.13 | 0.12 | 0.45 |
| Lake Nyos | 1.12 | 0.65 | 0.50 | 0.50 | 0.35 | 0.31 | 0.46 | 0.20 | 0.33 | 0.69 |
| Trader | 0.98 | 0.58 | 0.43 | 0.42 | 0.28 | 0.17 | 0.40 | 0.16 | 0.24 | 0.86 |

Second-based points use the nearest 1% row, which is accurate to within about 0.25 s.

## 3. Reach / CTR and per-video traffic (Reporting API, 2026-08-27 to 2026-09-25 only)

| Short | Impressions | Weighted CTR | Shorts-feed views | Search views | Coverage |
|---|---|---|---|---|---|
| Tree | 157 | 4.46% | 1,159 of 1,190 (97.4%) | 13 | Launch covered (published 2026-08-29) |
| Tupac | 981 | 0.61% | 100 of 167 (59.9%) | 61 (36.5%) | Launch covered (published 2026-09-03) |
| Other 9 Shorts | 36 to 176 each | 0% to 2.78% on 0-1 est. clicks | 0-2 each | 0-4 each | **UNKNOWN FOR ORIGINAL LAUNCH PERIOD** (post-launch tail only, see baseline) |

- Impressions and CTR for the two launches come from different surfaces and are not a like-for-like comparison. Tree's 4.46% is about 7 clicks, and Tupac's 0.61% is about 6.
- Thumbnail impressions do not measure Shorts-feed distribution. Tree had 1,159 feed views against 157 impressions.
- Low tail impressions for older Shorts are **not** evidence of poor launch distribution.

## 4. Reassessment of the earlier signals (official data)

### A. Feed gate: which stories got strong Shorts-feed distribution

**Observed**
- Four Shorts got 1,172 to 1,422 views (Warship, Pig, Tree, Jet). The next highest is 577 (Rat poison).
- Engaged views gives the same top four (555 to 661), against at most 215 for all others. The gap therefore does not come from counting replays.
- At the channel level, 93.0% of views came from the Shorts feed.
- Per-video traffic exists only for the two launches in the Reporting window:
  - Tree's launch was 97.4% Shorts feed.
  - Tupac's was only 59.9% Shorts feed (100 views), with 36.5% (61 views) from search. It is the only Short with material search traffic.
- The four top premises are a warship that sank, a pig that nearly started a war, 813 troops sent to cut down a tree, and a passenger jet that ran out of fuel. Each is one concrete, visible object or animal plus a physical event, stated completely in the title.

**Labels**
- **STRONG SIGNAL:** channel distribution comes from the Shorts feed. Search, browse and external traffic are marginal. This holds at channel level and for the one strong launch with per-video data (Tree).
- **STRONG SIGNAL:** distribution happens in the first 1-2 days. Tree got 99.1% of its window views in 2 days and Tupac 91.6% (Reporting daily). The earlier vidIQ channel-daily read showed the same for the other uploads.
- **WEAK SIGNAL:** in this sample, immediately understandable concrete premises (object or animal plus physical event, or trivial cause plus outsized response) were more likely to receive strong feed distribution. The four winners support it. But two concrete-premise Shorts (Rat poison, Dead man) reached only 549-577 views, and each shape has only 2 examples.
- **WEAK SIGNAL:** Tupac drew a large share of search traffic and few feed views. A famous-name, legal-process premise may be searched rather than fed. This rests on one video.
- **UNKNOWN:** feed "shown vs swiped away" per Short is not exposed by either API. The feed-gate decision itself is therefore only visible indirectly, through views.
- **UNKNOWN:** reach/CTR at launch for 9 of 11 Shorts (backfill limitation).

### B. Watch gate: which stories held viewers once watched

**Observed**
- **Strongest absolute holds:**
  - Jet: AWR above 1.0 for the whole video, never below 1.007.
  - Rat poison: 1.04 at 50%.
  - Dead man: 0.96 at 50%.
  - Tree: 0.76 at 50%, the best non-looping Short.
- Eclipse held well (0.72 at 50%, APV 74.79%) despite only 123 views.
- Four Shorts have much weaker absolute retention (APV 36-50%, AWR 50% of 0.28-0.38): Trader, 1816, Tupac and Lake Nyos.
- **Clean split at 10 s:**
  - Those four are at AWR 0.43-0.64 at 10 s.
  - Every other Short is at 0.80 or higher.
  - All four also have 300 views or fewer.

**Labels**
- **STRONG SIGNAL (association):** the four weakest absolute-retention Shorts are all low-view (at most 300), and all four fell below 0.65 AWR by 10 s. The direction of cause is UNKNOWN, because YouTube uses early retention to decide distribution, and low distribution can also change who watches.
- **WEAK SIGNAL:** good retention was necessary but not sufficient for reach. Eclipse, Rat poison and Dead man held as well as or better than Warship and Pig, but got 123-577 views.
- **STRONG SIGNAL (descriptive):** the 4-7 s window has the fastest per-second loss in 10 of 11 curves. Eclipse ties, and Warship loses steadily from 0 s. What is on screen at 4-7 s is UNKNOWN, because the published Short scripts are not in the repo.
- Note: the size of the 4->7 s drop does **not** separate winners from losers. Jet lost 0.23 and 1816 lost 0.24, while Lake Nyos lost 0.46 and Dead man 0.35. **What separates them is the level at 10 s.** It is set by how high the curve starts (loops) plus how much is lost in the first 10 s.

### C. Rewatch / looping

**Observed**
- Three Shorts exceed 100% APV: Jet 112.93% (AVD 55 s on a 49 s Short), Rat poison 109.01% (28 s on 26 s) and Dead man 105.55% (41 s on 39 s).
- All three end at AWR of 0.84 or more. Jet ends at 1.01, so the last second is watched by at least as many as there are views, which means replays.
- Channel-page viewers averaged about 42 s per view against about 15 s for Shorts-feed viewers.
- The looping Shorts have middling-to-low Eng % (30.8% to 47.4%), consistent with replays counting as views. That reading is a HYPOTHESIS, since YouTube does not publish per-video replay counts.

**Labels**
- **STRONG SIGNAL (descriptive):** 3 independent Shorts show replay behaviour (APV over 100%, end AWR of 0.84 or more).
- **WEAK SIGNAL:** looping did not by itself produce top distribution. Rat poison and Dead man had 549-577 views. Jet is the only looper in the top four.
- **Not supported:** a runtime rule. The loopers are 26 s, 39 s and 49 s, the shortest, a middle one and the longest Short.

### D. Midpoint retention (AWR at 50%)

Jet 1.12, Rat poison 1.04, Dead man 0.96, Tree 0.76, Eclipse 0.72, Warship 0.65, Pig 0.59, Tupac 0.38, 1816 0.35, Lake Nyos 0.35, Trader 0.28.

The top-four-by-views Shorts range from 0.59 to 1.12 at midpoint. Pig and Warship, the two most-viewed, have the 6th and 7th best midpoints.

### E. End retention (AWR at 100%)

Jet 1.01, Dead man 0.86, Rat poison 0.84, Tree 0.56, Warship 0.47, Pig 0.45, Eclipse 0.38, Lake Nyos 0.31, Tupac 0.25, 1816 0.17, Trader 0.17.

### F. Relative retention (RRP)

- At 50%: Jet and Tree 0.59, Rat poison 0.56, Dead man 0.55, Pig 0.53, Eclipse 0.52, Warship 0.42, Lake Nyos 0.33, Tupac 0.30, Trader 0.24, 1816 0.12.
- Warship is the most-viewed Short but below typical for its length at 25% (0.34) and 50% (0.42). High feed distribution did not require above-typical relative retention. **WEAK SIGNAL** (one video).
- End RRP is 0.67 to 0.95 for 10 of 11 (1816: 0.45). This compares end-of-video retention with similar-length videos. It does **not** mean most viewers reached the end: Trader has end RRP 0.86 but end AWR 0.17.

## 5. Specific observations verified

| Claim | Official value | Verdict |
|---|---|---|
| Passenger Jet about 112.93% APV | 112.93% | Correct |
| Jet about 55 s AVD on a 49 s Short | 55 s on 49 s | Correct |
| Jet 3 subscribers gained | 3 gained, 0 lost | Correct |
| Jet AWR still about 1.0 at the end | 1.007 at 100%. It never drops below 1.0 anywhere in the curve. | Correct |
| Paul Bunyan (Tree) about 80.94% APV | 80.94% | Correct |
| Paul Bunyan strong midpoint retention | AWR 50% 0.76 (4th of 11 in absolute terms, best non-looper). RRP 50% 0.59 (tied best with Jet) | Correct, with nuance: strongest *relative* midpoint, 4th in *absolute* terms |
| Pig War / Warship high reach/views but lower APV than Jet | 1,373 / 1,422 views, APV 69.35 / 70.35 against 112.93 | Views and APV correct. "Reach" in the impressions sense is **UNKNOWN FOR ORIGINAL LAUNCH PERIOD**, so "high views / feed distribution" is the supported wording. |
| Dead Man / Rat Poison over 100% APV but materially lower views | 105.55% / 109.01%, 549 / 577 views (39-49% of the top four) | Correct |
| Barings / 1816 / Tupac / Lake Nyos materially weaker absolute retention | APV 36.37 / 45.77 / 48.62 / 49.50, AWR 50% 0.28 / 0.35 / 0.38 / 0.35 | Correct. Eclipse (74.79%, 0.72) is **not** in this group despite its low views. |

## 6. Story shapes (derived from these 11, unchanged)

| Shape | Shorts | Views | APV % |
|---|---|---|---|
| Absurd trigger, outsized response | Pig, Tree | 1,373 / 1,188 | 69.35 / 80.94 |
| Machine in peril (vehicle or vessel in physical danger) | Warship, Jet | 1,422 / 1,172 | 70.35 / 112.93 |
| One improbable individual | Rat poison, Dead man, Trader | 577 / 549 / 175 | 109.01 / 105.55 / 36.37 |
| Natural catastrophe | 1816, Lake Nyos | 300 / 59 | 45.77 / 49.50 |
| Institutional / intellectual process | Tupac, Eclipse | 166 / 123 | 48.62 / 74.79 |

- **WEAK SIGNAL:** the two shapes with feed wins each have 2 of 2 over 1,100 views. With 2 videos per shape, this does not show that military, animals or machines "always win".
- **WEAK SIGNAL:** "one improbable individual" produced both of the non-Jet loopers. Their retention is high but their distribution is middling.
- **WEAK SIGNAL (confounded):** both natural catastrophes used label titles ("The Lake Nyos Disaster", "1816: The Year Without a Summer") and both had weak retention and views. Topic and title cannot be separated.
- **HYPOTHESIS:** premises whose strangeness needs background (a bank's age, a legal timeline, what an eclipse "tested") lose feed viewers before the strangeness lands. Trader and Tupac fit this on both views and retention. Eclipse fits on views but held well.

## 7. Subscribers and engagement

- 12 subscribers were gained channel-wide and 6 are attributed to Shorts: Jet 3, and Rat poison, 1816 and Tree 1 each. **UNKNOWN:** with 0 to 3 subscribers per Short, conversion differences are indistinguishable from chance.
- Shares total 3 (Warship, Jet, Eclipse). **UNKNOWN:** too few to compare.
- Comments total 4 (Warship 2, Jet 2), both "machine in peril". **WEAK SIGNAL** (2 videos, 4 comments).
- Eclipse (56.9 likes /1k) and Lake Nyos (50.8) have the highest like rates on the smallest view counts. **UNKNOWN** whether that reflects the story or a small audience of channel-page and subscriber viewers.
- Among the top four, Jet has the most likes, comments and subscribers. **WEAK SIGNAL** (one video).

## 8. What did NOT work (unchanged in direction, now on official data)

1. **Low hold in the first 10 s.** All four Shorts below 0.65 AWR at 10 s had 300 views or fewer. **STRONG SIGNAL (association).** The cause is UNKNOWN without the openings.
2. **Label titles that name an event without stating what happened** (Lake Nyos, 1816). **WEAK SIGNAL** (2 videos, confounded with topic).
3. **Premises that need background to feel strange** (Trader, Tupac, and Eclipse on views only). **WEAK SIGNAL.**
4. **Search is not a substitute for the feed.** Tupac's 61 search views did not make up for a weak feed launch. **WEAK SIGNAL** (one video).

## Out of scope for this data

- Every signal above comes from 26-49 second Shorts. None of it describes long-form runtime, pacing, act structure or long-form viewer behaviour.
- Reporting reach/CTR covers 2026-08-27 to 2026-09-25 only and is never treated as lifetime.
