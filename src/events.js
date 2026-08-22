// Event encounters: a bit of writing, then an effect.
// Tone: science fiction adventure. The setting: an artificial, layered world
// (the worldflake), breathable ether between its landmasses, light that can come
// from below, and a core whose nodes make matter appear and vanish.
// Deliberately no named peoples or factions beyond what the game already uses
// (acolytes of the Great Forge, nomads, pilgrims, scholars as roles, not cultures).
//
// Each entry: { id, title, weight, text, effect }
//   effect: the rule applied by game.js applyEvent(). The "params" are read from
//   config.events so the numbers can be tuned without touching this file.

export const EVENTS = [
  {
    id: 'signpost',
    title: 'Signpost',
    weight: 1,
    effect: 'revealShop',
    text: 'A post of pale alloy stands at a fork in the path, taller than the Vanguard and untouched by weather. Its single arm carries no words, only a row of notches and a crude drawing of scales. Whoever keeps a stall out here wanted to be found, and the direction is unmistakable.',
  },
  {
    id: 'pilgrim',
    title: 'Friendly pilgrim',
    weight: 1,
    effect: 'revealBlob',
    text: 'A lone traveller shares the party\'s fire, wrapped in a coat stitched from sailcloth and carrying nothing but a staff and a walking song. In exchange for warm food, the pilgrim scratches a map into the dirt with the staff\'s tip: ridges, a dry gully, a place to cross. It is rough, it is partial, and it is correct.',
  },
  {
    id: 'rumors',
    title: 'Rumours',
    weight: 1,
    effect: 'revealBattles',
    text: 'Smoke on the wind, then voices. A group of drovers, moving fast, warn the party of raiders working the nearby ridges. They point: there, and there, and one more past the rocks. The drovers do not stop to argue about it. They have seen what is out there.',
  },
  {
    id: 'vantage',
    title: 'Vantage point',
    weight: 1,
    effect: 'vantage',
    text: 'The trail climbs to a spur of stone that ends in open ether. From here the land unrolls in every direction, and a shaft of light from some gap in the layers below picks out every peak for leagues, lit from underneath, casting shadows upward into the haze. The Archer sketches quickly before the light moves on.',
  },
  {
    id: 'fortunate',
    title: 'Fortunate find',
    weight: 1,
    effect: 'supplies',
    text: 'A cache, wedged under an overhang and sealed with a lid of fused glass: dried rations, a coil of line, a lamp that still takes a charge. Left by someone who meant to come back, long enough ago that the moss has crossed the lid. The party takes what will keep and leaves the rest in order.',
  },
  {
    id: 'scholar',
    title: 'Wandering scholar',
    weight: 1,
    effect: 'power',
    text: 'An old surveyor with an instrument case and a limp walks with the party for half a day. The conversation drifts from the mechanics of the layers to the mechanics of staying alive out here: where to stand, when to run, how to read a charge before it comes. It is the most useful lesson anyone has had in years.',
  },
  {
    id: 'procession',
    title: 'Forge procession',
    weight: 1,
    effect: 'revealAcolyte',
    text: 'A caravan of the acolytes of the Great Forge crosses the party\'s path: hooded figures walking beside long carts, each cart carrying a sealed crucible that hums faintly and sheds warmth into the cold air. They speak little, but one of them turns and points the way to where a brother of theirs keeps the fire.',
  },
  {
    id: 'blackmarket',
    title: 'Black market',
    weight: 1,
    effect: 'blackMarket',
    text: 'In the shadow of a stranded hull, trade is being done in things that have no honest name. A dealer with steady hands offers the party a procedure: a graft of core-touched alloy, grown into the bone. It makes a fighter harder to put down. It also takes something that does not come back.',
  },
  {
    id: 'nomads',
    title: 'Nomads',
    weight: 1,
    effect: 'battle',
    text: 'The nomads are courteous at first: water shared, routes compared, a question about the party\'s supplies that is asked twice. The third time it is not a question. Steel comes out on both sides, and the conversation is over.',
  },
  {
    id: 'caravan',
    title: 'The merchant\'s caravan',
    weight: 1,
    effect: 'rest',
    text: 'The caravan announces itself an hour before it arrives: a line of lanterns strung between tall-wheeled wagons, and music. Its owner, a merchant dressed in more cloth than the whole party owns, rides out to meet them, decides their stories are worth a dinner, and will not hear of a refusal. That night there is roast meat, warm bedding, and a physician who looks at every wound without being asked. The merchant listens to the party\'s route with the attention of someone who buys and sells such things, laughs in the right places, and in the morning sends them off fed, rested, and a little uneasy about how much they said.',
  },
  {
    id: 'lore',
    title: 'Learned about the world',
    weight: 2,
    effect: 'lore',
    // The text is picked from LORE_TEXTS below.
  },
];

// Plain flavour texts, no effect. One is shown by the "Learned about the world" event.
export const LORE_TEXTS = [
  {
    title: 'Light from below',
    text: 'Halfway across a ridge the shadows flip. Somewhere beneath the party, two continents on the lower layers drift apart and a shaft of starlight climbs up through the ether, lighting the underside of every cloud. For a quarter of an hour the whole valley is lit wrong, bottom-up, and nobody speaks. Then the gap closes and ordinary dusk returns.',
  },
  {
    title: 'The shelf that was not there',
    text: 'The map says solid ground. The ground says otherwise: a long shelf of grey stone is simply gone, its edge still warm and smelling of ozone. The party watches as a patch of air at the far end thickens, flickers, and resolves into a boulder that was not there a breath ago. Whatever the core is doing today, it is doing it close to the surface. They take the long way round.',
  },
  {
    title: 'Falling island',
    text: 'A fragment of some upper layer comes down through the ether in slow motion, trailing soil and a skin of frozen mist. It passes a few hundred metres off, turning lazily, and for a moment the party can read the strata in its side like pages. It leaves no crater. It never lands; it just keeps falling, into the layers below, and out of their story.',
  },
  {
    title: 'Old road',
    text: 'Under the moss the party finds paving, laid so precisely that the seams are still tight after what must be ages. The road points straight at the horizon and then straight off the edge of the landmass into open ether, as if whoever built it expected the next stretch of ground to be there. Perhaps, once, it was.',
  },
  {
    title: 'Geographic night',
    text: 'Night arrives at noon. A landmass on a higher layer slides between the party and the star, and the temperature drops ten degrees in as many minutes. The ether overhead glows faintly on its own, a cold inner light that is enough to walk by. The Archer uses the dark to count three distant fires that were invisible by day.',
  },
  {
    title: 'The hum',
    text: 'Everyone feels it before anyone hears it: a vibration in the teeth, then in the ground, a note too low to be sound. Loose gravel stands up in rows. The Mystic says it is the core, one of its nodes changing its rate, and that it will pass. It passes. The rows of gravel stay.',
  },
  {
    title: 'Ether swimmers',
    text: 'Where the landmass ends, the party rests at the drop and watches things move in the open ether below: slow, translucent, big as barns, drifting between layers with no obvious effort. Whether they are alive in any sense the party would recognise is a question for another day. The Vanguard throws a stone. Nothing reacts.',
  },
  {
    title: 'Salvage',
    text: 'A hull, or most of one, wedged into a ravine and half dissolved into the rock, as if the stone had grown around it. Its skin is still faintly warm. Inside, everything that could be useful was taken long ago. On the bulkhead someone has scratched a tally of days that runs into the hundreds, then stops.',
  },
  {
    title: 'Rain that goes up',
    text: 'The weather on this layer has opinions. A shower begins at the party\'s feet and rises, drops climbing through the lit ether like sparks, to fall on someone else far above. The Mystic holds out a hand and catches one on the way up. It is ordinary water.',
  },
  {
    title: 'Survey marker',
    text: 'A metal post, knee high, perfectly plumb, engraved with a string of symbols and a number. There is another on the next rise, and another beyond that, all pointing the same way. Somebody measured this place once, carefully, and then left. The party follows the line for an hour before it turns toward the edge and they turn back.',
  },
];
