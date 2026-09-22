import type { Story } from "../../types.ts";
import type { ResearchPackage } from "../pipelineTypes.ts";

// The PB4 acceptance story. Facts drawn from the well-documented 1976 Korean
// axe murder incident and the American response, Operation Paul Bunyan.

export const paulBunyanStory: Omit<Story, "createdAt"> = {
  id: "paul-bunyan",
  slug: "paul-bunyan",
  title: "Operation Paul Bunyan",
  hook: "To trim one tree in the world's most dangerous strip of land, America sent B-52s, a carrier, and a small army.",
  category: "Conflicts & Standoffs",
  year: "1976",
  place: "Korean DMZ",
  summary:
    "In August 1976, a poplar tree in the Korean Demilitarized Zone blocked a United Nations Command sight line. A routine work detail to prune it ended in the axe killings of two American officers. Three days later the United States answered - not with a strike, but with the most heavily armed gardening operation in history.",
  heroImage: "stories/paul-bunyan/images/hero.png",
  moments: [
    { title: "A tree in the way", detail: "A tall poplar in the Joint Security Area blocked the line of sight between a UN checkpoint and an observation post." },
    { title: "The work detail", detail: "On 18 August 1976, US and South Korean soldiers went to trim the tree. North Korean guards ordered them to stop." },
    { title: "The axe attack", detail: "The North Korean soldiers seized the work party's axes and killed Captain Arthur Bonifas and Lieutenant Mark Barrett." },
    { title: "Overwhelming answer", detail: "Rather than retaliate, the US planned to simply cut the tree down - behind a wall of overwhelming force." },
    { title: "Forty-two minutes", detail: "On 21 August, engineers felled the tree in about 42 minutes while bombers, fighters and a carrier stood by. No shot was fired." },
    { title: "The stump", detail: "North Korea backed down and expressed regret. The stump was left standing, and the camp was renamed for Captain Bonifas." },
  ],
  sources: [
    { title: "Korean axe murder incident - Wikipedia", url: "https://en.wikipedia.org/wiki/Korean_axe_murder_incident", note: "Overview of the 18 August 1976 killings and Operation Paul Bunyan." },
    { title: "Joint Security Area - Wikipedia", url: "https://en.wikipedia.org/wiki/Joint_Security_Area", note: "Geography of Panmunjom and the JSA where the incident took place." },
    { title: "Camp Bonifas - Wikipedia", url: "https://en.wikipedia.org/wiki/Camp_Bonifas", note: "The base renamed after Captain Arthur Bonifas." },
  ],
  productionNote:
    "Reconstructions should feel like sober military history, not spectacle. Authentic archive of Panmunjom and the JSA is preferred where licensing allows; a live run should add institutional sources (US Army, DoD) beyond these overviews.",
  hasVideos: false,
  activeJobId: null,
};

const world = {
  period: "August 1976",
  place: "Joint Security Area, Panmunjom, Korean DMZ",
  palette: "overcast greys, olive drab, humid summer green, cold steel",
  visualDirection:
    "Sober cold-war military documentary. Overcast flat light, low contrast, restrained palette. Wide establishing frames of the flat DMZ, poplar tree, low buildings and the Bridge of No Return. Reconstruction, never fake archive.",
  recurringPeople: ["US and ROK soldiers in mid-1970s fatigues", "North Korean border guards"],
  recurringLocations: ["the lone poplar tree", "UN Command checkpoint", "the Bridge of No Return", "flat DMZ farmland"],
  referenceImages: [],
};

// Long documentary narration (~7 minutes). Documentary structure end to end.
const long = `
There is a strip of land two and a half miles wide that runs across the middle of Korea, and by any honest measure it is the most dangerous border on Earth. It is called the Demilitarized Zone, which is one of history's darker jokes, because there is almost nothing demilitarized about it. And in the summer of 1976, the most explosive object in that entire zone was a tree.

To understand how a poplar tree nearly started a war, you have to stand where the soldiers stood. At the very center of the DMZ sits a small area called the Joint Security Area, at a village named Panmunjom. This is the one place where soldiers from both sides could walk the same ground. It was tense, it was watched, and it was crowded with observation posts, checkpoints, and men with orders to notice everything.

The problem was one of those poplars. It had grown tall and full, and its branches had spread directly across the line of sight between a United Nations Command checkpoint and an observation post a little further on. When the leaves were out, the men at the observation post simply could not see the checkpoint they were meant to watch. In a place where seeing the other side was the entire job, a blind spot was not a small thing.

So on the eighteenth of August, 1976, a small work detail went out to prune it. Not to cut it down. Just to trim the branches so the two posts could see each other again. There were American and South Korean soldiers, a handful of workers with axes, and a couple of officers supervising. It was, on paper, gardening.

North Korean guards came to watch, which was normal. Their officer told the detail to stop. That, too, had happened before, and the work continued. But this time the mood turned. More North Korean soldiers arrived by truck. Their commander, an officer the Americans had nicknamed for his temper, took off his watch, wrapped it in a handkerchief, and put it in his pocket. Then he gave an order.

The North Korean soldiers took the axes from the work party and turned them on the men. In the violence that followed, Captain Arthur Bonifas and First Lieutenant Mark Barrett were killed. They had gone out to trim a tree, and they did not come back. The whole attack lasted only a few minutes, and it left the United States facing a decision that had nothing to do with landscaping.

Because now there was a body of a murdered officer, a second one dying, and a tree still standing exactly where it had been. Whatever happened next would be read by both Koreas, by China, and by the Soviet Union, as a statement about American nerve.

The temptation to retaliate was obvious, and dangerous. A strike could start a second Korean War along the most heavily fortified line in the world. But doing nothing was its own message, and not a good one. So American commanders reached for a third option, and it was a strange and brilliant one. They would not attack anyone. They would simply go back and finish the job. They would cut the tree down. And they would do it behind a wall of force so enormous that no one on the other side would dare to lift a finger.

They called it Operation Paul Bunyan, after the giant lumberjack of American folklore. On the twenty-first of August, a convoy rolled into the Joint Security Area. At its heart was a team of engineers with chainsaws, there to remove one poplar. Around them stood a security platoon, and behind that, a company of infantry. Many of the men carried axe handles and were trained in taekwondo, a deliberate, pointed detail.

That was only what stood on the ground. Overhead, attack helicopters circled. Behind them, in the sky further back, flew B-52 bombers that had come from Guam, escorted by fighter aircraft. F-4 Phantoms and F-111s held in the air nearby. Off the coast, the aircraft carrier Midway had moved into position with its own task force. Artillery and infantry along the border had been brought to full readiness, and thousands more troops waited behind them. All of this, assembled and pointed at a single tree.

The engineers went to work. The North Korean soldiers watched from their side, and this time they did not move. Trucks blocked the bridges. Men stood ready. And in about forty-two minutes, the chainsaws finished what the axes had started three days before. The poplar came down. Not a shot was fired.

The Americans had made their point without firing it. They left a portion of the trunk standing, a stump, as a kind of marker. Within hours, North Korea did something it almost never did. Its leader, Kim Il-sung, sent a message expressing regret over the deaths. From a government that dealt in defiance, regret was extraordinary.

The tree was gone, the sight line was clear, and the war that everyone feared did not come. The checkpoint that had been the source of all the trouble was later removed, and the base near the Joint Security Area was renamed Camp Bonifas, after the captain who was killed. His name now sits on the gate of one of the loneliest outposts in the world.

Operation Paul Bunyan is remembered because it is almost absurd. A nuclear-capable bomber fleet, a carrier battle group, and a small army were mobilized to carry out a task any gardener could do in an afternoon. But that was exactly the point. The message was not in the tree. The message was in the overwhelming, silent, disciplined force that surrounded it, and in the fact that it was never used. Sometimes the loudest thing an army can do is cut down a tree, and dare the other side to say a word.
`.trim();

// Short narration (~55 seconds).
const short = `
In 1976, the most dangerous object in the Korean Demilitarized Zone was a tree. A single poplar had grown across the line of sight between two United Nations Command posts, so soldiers were sent to trim it. North Korean guards ordered them to stop. When they didn't, the guards seized the work party's own axes and killed two American officers. Now the United States had a choice. Retaliate, and risk a second Korean War. Or back down. Instead they picked a third option. Three days later, they came back to cut the tree down - escorted by attack helicopters, B-52 bombers from Guam, fighter jets, and an aircraft carrier off the coast. Twenty men with chainsaws felled the tree in forty-two minutes. North Korea didn't fire a shot. It was the most heavily armed gardening operation in history, and it worked.
`.trim();

// The factual spine handed to the scripts. Concrete, sourced, no filler.
const facts = [
  { fact: "On 18 August 1976, a US and South Korean work detail went to prune a poplar tree blocking a UN Command sight line in the Joint Security Area at Panmunjom.", sourceTitle: "Korean axe murder incident - Wikipedia", sourceUrl: "https://en.wikipedia.org/wiki/Korean_axe_murder_incident" },
  { fact: "North Korean soldiers seized the work party's axes and killed Captain Arthur Bonifas and First Lieutenant Mark Barrett.", sourceTitle: "Korean axe murder incident - Wikipedia", sourceUrl: "https://en.wikipedia.org/wiki/Korean_axe_murder_incident" },
  { fact: "On 21 August 1976, US and South Korean forces carried out Operation Paul Bunyan, cutting the tree down behind overwhelming force without firing a shot.", sourceTitle: "Korean axe murder incident - Wikipedia", sourceUrl: "https://en.wikipedia.org/wiki/Korean_axe_murder_incident" },
  { fact: "After the operation, North Korean leader Kim Il-sung expressed regret over the deaths, which was rare from that government.", sourceTitle: "Korean axe murder incident - Wikipedia", sourceUrl: "https://en.wikipedia.org/wiki/Korean_axe_murder_incident" },
  { fact: "The base near the Joint Security Area was later renamed Camp Bonifas after Captain Arthur Bonifas.", sourceTitle: "Camp Bonifas - Wikipedia", sourceUrl: "https://en.wikipedia.org/wiki/Camp_Bonifas" },
];

export const paulBunyanResearch: ResearchPackage = {
  summary: paulBunyanStory.summary,
  moments: paulBunyanStory.moments,
  sources: paulBunyanStory.sources,
  facts,
  productionNote: paulBunyanStory.productionNote,
  world,
};

export const paulBunyanScripts = { long, short };
