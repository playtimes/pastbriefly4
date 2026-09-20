import { existsSync } from "node:fs";
import type { Story } from "../types.ts";
import { paulBunyanStory } from "./fixtures/paulBunyan.ts";
import { listStories, upsertStory } from "../server/store.ts";
import { ensureStoryDirs, inStory, mediaRel } from "./paths.ts";
import { writePlaceholderStill } from "./mockAssets.ts";
import { now } from "../server/db.ts";

type SeedStory = Omit<Story, "createdAt">;

const seeds: SeedStory[] = [
  paulBunyanStory,
  {
    id: "pig-war",
    slug: "pig-war",
    title: "The Pig War",
    hook: "Britain and the United States nearly went to war over a single dead pig eating potatoes.",
    category: "Conflicts & Standoffs",
    year: "1859",
    place: "San Juan Island",
    summary:
      "A vague border treaty left ownership of San Juan Island unsettled between Britain and the United States. When an American settler shot a British-owned pig rooting in his garden, the quarrel escalated into a military standoff that pitted hundreds of soldiers and warships against each other — over a pig.",
    heroImage: null,
    moments: [
      { title: "An unclear border", detail: "The 1846 treaty put the boundary in a channel without saying which one, leaving San Juan Island claimed by both." },
      { title: "The pig", detail: "In 1859 an American settler shot a pig belonging to the Hudson's Bay Company as it ate his potatoes." },
      { title: "Escalation", detail: "Both sides landed troops and warships, building to a tense armed standoff over a farmyard dispute." },
      { title: "The long peace", detail: "Cooler officers refused to fire, and the islands were jointly occupied for years until arbitration settled the line." },
    ],
    sources: [{ title: "Pig War — Wikipedia", url: "https://en.wikipedia.org/wiki/Pig_War_(1859)", note: "The 1859 standoff over San Juan Island." }],
    productionNote: "Pacific Northwest light, 19th-century military camps, maps of the disputed channel.",
  },
  {
    id: "ea-nasir",
    slug: "ea-nasir",
    title: "The Complaint to Ea-nasir",
    hook: "The world's oldest written complaint is a furious review of a Bronze Age copper dealer who sold bad metal.",
    category: "Money & Deception",
    year: "1750 BCE",
    place: "Ur, Mesopotamia",
    summary:
      "Nearly 3,800 years ago a merchant named Nanni sent a clay tablet to a copper dealer named Ea-nasir, complaining about poor-quality metal and contemptuous treatment. It survives as arguably the oldest recorded customer complaint — proof that being ripped off is one of humanity's oldest experiences.",
    heroImage: null,
    moments: [
      { title: "The deal", detail: "Nanni sent money for copper ingots through an intermediary to the merchant Ea-nasir." },
      { title: "Bad copper", detail: "The metal delivered was not the quality promised, and Nanni felt insulted by the treatment." },
      { title: "The tablet", detail: "He pressed a long, aggrieved complaint into clay and had it delivered to Ea-nasir." },
      { title: "A hoard of grievances", detail: "Archaeologists later found Ea-nasir's house full of similar complaint tablets — he had many unhappy customers." },
    ],
    sources: [{ title: "Complaint tablet to Ea-nasir — Wikipedia", url: "https://en.wikipedia.org/wiki/Complaint_tablet_to_Ea-n%C4%81sir", note: "The cuneiform complaint tablet, now in the British Museum." }],
    productionNote: "The authentic tablet is the hero artifact; treat cuneiform and clay as documentary evidence, not spectacle.",
  },
  {
    id: "barings",
    slug: "barings",
    title: "The Fall of Barings Bank",
    hook: "A single trader in Singapore secretly lost more money than the 233-year-old bank was worth.",
    category: "Money & Deception",
    year: "1995",
    place: "Singapore & London",
    summary:
      "Barings, Britain's oldest merchant bank, was destroyed by one man. Nick Leeson hid mounting trading losses in a secret account until an earthquake-driven market move blew a hole so large it bankrupted the institution overnight — and it was bought for one pound.",
    heroImage: null,
    moments: [
      { title: "The trusted trader", detail: "Nick Leeson ran both trading and settlement in Barings' Singapore office, a fatal lack of oversight." },
      { title: "The hidden account", detail: "Losses were buried in an error account numbered 88888 while Leeson reported profits." },
      { title: "The Kobe earthquake", detail: "A 1995 earthquake sent Japanese markets the wrong way, and his hidden bets exploded." },
      { title: "One pound", detail: "The losses exceeded the bank's capital; Barings collapsed and was sold to ING for a single pound." },
    ],
    sources: [
      { title: "Barings Bank — Wikipedia", url: "https://en.wikipedia.org/wiki/Barings_Bank", note: "History and 1995 collapse of the bank." },
      { title: "Nick Leeson — Wikipedia", url: "https://en.wikipedia.org/wiki/Nick_Leeson", note: "The trader behind the losses." },
    ],
    productionNote: "1990s trading floors, fax and paper, the numbers themselves as native graphics.",
  },
  {
    id: "molasses-flood",
    slug: "molasses-flood",
    title: "The Boston Molasses Flood",
    hook: "A wave of molasses 25 feet high tore through Boston at 35 miles an hour, killing 21 people.",
    category: "Disasters",
    year: "1919",
    place: "Boston, USA",
    summary:
      "On a January day in 1919, a giant storage tank of molasses in Boston's North End burst, sending a sticky brown wave through the streets. It crushed buildings, swept away people and horses, and killed 21 — a disaster so strange it sounds invented, caused by a tank that was never built properly.",
    heroImage: null,
    moments: [
      { title: "The tank", detail: "A large, hastily built molasses tank loomed over the crowded North End waterfront." },
      { title: "The burst", detail: "On 15 January 1919 the tank failed, releasing millions of litres of molasses at once." },
      { title: "The wave", detail: "A wall of molasses moved fast enough to wreck an elevated railway and flatten homes." },
      { title: "The reckoning", detail: "A long inquiry blamed poor construction and helped push modern engineering oversight." },
    ],
    sources: [{ title: "Great Molasses Flood — Wikipedia", url: "https://en.wikipedia.org/wiki/Great_Molasses_Flood", note: "The 1919 Boston disaster and its aftermath." }],
    productionNote: "Cold winter light, industrial waterfront, engineering diagrams of the failed tank.",
  },
  {
    id: "vasa",
    slug: "vasa",
    title: "The Sinking of the Vasa",
    hook: "The mightiest warship in Sweden sailed less than a mile before it tipped over and sank.",
    category: "Disasters",
    year: "1628",
    place: "Stockholm, Sweden",
    summary:
      "The Vasa was meant to be the proudest warship of the Swedish empire — gilded, top-heavy with cannon, and rushed to sea by a king's ambition. On its maiden voyage in 1628 a light gust laid it over, water poured through the gunports, and it sank in the harbour in full view of the city.",
    heroImage: null,
    moments: [
      { title: "The king's ship", detail: "King Gustavus Adolphus wanted a magnificent, heavily gunned warship, and quickly." },
      { title: "Too tall, too narrow", detail: "The design was dangerously top-heavy, and a stability test before launch had already failed." },
      { title: "The maiden voyage", detail: "In August 1628 the Vasa set sail, heeled in a gust, and flooded through its open gunports." },
      { title: "Raised again", detail: "It sank almost immediately; centuries later it was salvaged nearly intact and became a museum." },
    ],
    sources: [{ title: "Vasa (ship) — Wikipedia", url: "https://en.wikipedia.org/wiki/Vasa_(ship)", note: "The 1628 warship, its sinking and salvage." }],
    productionNote: "Baltic light, carved gilded timber, the preserved hull as authentic archive.",
  },
  {
    id: "operation-mincemeat",
    slug: "operation-mincemeat",
    title: "Operation Mincemeat",
    hook: "To fool Hitler, British spies gave a corpse a fake name, a fake love life, and a briefcase of lies.",
    category: "Escapes & Operations",
    year: "1943",
    place: "Wartime Europe",
    summary:
      "In 1943 British intelligence dressed a dead man as a Royal Marines officer, chained a briefcase of false invasion plans to his wrist, and let him wash ashore in Spain. The Germans believed the papers, moved their defences to the wrong place, and the Allies landed in Sicily against thinner resistance.",
    heroImage: null,
    moments: [
      { title: "The problem", detail: "The Allies planned to invade Sicily, but it was the obvious target and heavily defended." },
      { title: "The man who never was", detail: "Intelligence officers built a complete false identity around an unclaimed body." },
      { title: "The plant", detail: "A submarine released the body off Spain, where its planted documents reached German intelligence." },
      { title: "The payoff", detail: "The deception drew German forces away, easing the real landings in Sicily." },
    ],
    sources: [{ title: "Operation Mincemeat — Wikipedia", url: "https://en.wikipedia.org/wiki/Operation_Mincemeat", note: "The 1943 deception operation." }],
    productionNote: "Documents and maps as evidence; sombre wartime tone; never sensationalise the dead man.",
  },
  {
    id: "dancing-plague",
    slug: "dancing-plague",
    title: "The Dancing Plague of 1518",
    hook: "Hundreds of people danced in the streets for days, some until they dropped dead — and no one knows why.",
    category: "Strange Everyday History",
    year: "1518",
    place: "Strasbourg",
    summary:
      "In the summer of 1518 a woman began to dance in a Strasbourg street and could not stop. Within weeks dozens, then hundreds, joined her, dancing for days without rest. Some collapsed from exhaustion or died. Authorities, baffled, at first prescribed yet more dancing.",
    heroImage: null,
    moments: [
      { title: "The first dancer", detail: "A woman named as Frau Troffea began dancing alone and did not stop." },
      { title: "The spread", detail: "Over days and weeks, dozens and then hundreds joined the compulsive dancing." },
      { title: "The wrong cure", detail: "City officials, believing the cure was more movement, provided musicians and a hall." },
      { title: "The theories", detail: "Explanations range from mass psychogenic illness to poisoning; none is certain." },
    ],
    sources: [{ title: "Dancing plague of 1518 — Wikipedia", url: "https://en.wikipedia.org/wiki/Dancing_plague_of_1518", note: "The recorded outbreak in Strasbourg." }],
    productionNote: "Renaissance town, woodcut-inspired reconstruction, restrained rather than lurid.",
  },
];

// Insert missing seed stories and give each a hero placeholder so the browse is
// cinematic offline. Existing stories are left untouched.
export function ensureSeed(): void {
  const have = new Set(listStories().map((s) => s.slug));
  for (const s of seeds) {
    ensureStoryDirs(s.slug);
    const heroAbs = inStory(s.slug, "images/hero.png");
    if (!existsSync(heroAbs)) {
      writePlaceholderStill(heroAbs, { width: 1600, height: 900, index: s.slug.length, label: s.title, truth: s.category, accent: "#d9a066" });
    }
    if (!have.has(s.slug)) {
      upsertStory({ ...s, heroImage: mediaRel(s.slug, "images/hero.png"), createdAt: now() });
    }
  }
}
