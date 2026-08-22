// Event encounters: which events exist, how likely they are, and what they do.
// The stories themselves live in the locale tables (event.<id>.title / .text and
// lore.<id>.title / .text in src/locales/*.js), so they can be translated and audited.
//
// Tone reference for writers: science fiction adventure in an artificial, layered
// world (the worldflake), breathable ether between its landmasses, light that can
// come from below, a core whose nodes make matter appear and vanish. No named
// peoples or factions beyond roles (acolytes of the Great Forge, nomads, pilgrims).
//
// Each entry: { id, weight, effect }; effect is applied by game.js applyEvent() with
// the numbers from config.events.
export const EVENTS = [
  { id: 'signpost', weight: 1, effect: 'revealShop' },
  { id: 'pilgrim', weight: 1, effect: 'revealBlob' },
  { id: 'rumors', weight: 1, effect: 'revealBattles' },
  { id: 'vantage', weight: 1, effect: 'vantage' },
  { id: 'fortunate', weight: 1, effect: 'supplies' },
  { id: 'scholar', weight: 1, effect: 'power' },
  { id: 'procession', weight: 1, effect: 'revealAcolyte' },
  { id: 'blackmarket', weight: 1, effect: 'blackMarket' },
  { id: 'nomads', weight: 1, effect: 'battle' },
  { id: 'caravan', weight: 1, effect: 'rest' },
  { id: 'lore', weight: 2, effect: 'lore' },
];

// Plain flavour texts, no effect. One is shown by the "Learned about the world" event.
export const LORE_IDS = ['light', 'shelf', 'island', 'road', 'night', 'hum', 'swimmers', 'salvage', 'rain', 'marker'];
