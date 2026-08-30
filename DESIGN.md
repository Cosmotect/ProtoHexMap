# DESIGN.md - the shared memory of this prototype

Read this first in every new work session. It records what the prototype does, why,
and what is still open. Keep it short and current; update it when a rule changes.
The CODE is the source of truth - numbers quoted here are the config defaults and can
drift; when in doubt, read `src/config*`.

## Purpose

The world map (level select) of a larger roguelike in the Slay the Spire / Into the
Breach spirit, plus its combat layer: the player picks where to go between fights on a
fogged hex map, and combat encounters are PLAYED out on a local arena map with a
tactics engine. Non-combat encounters (shops, events, treasure, the Acolyte) resolve
through dialogs.

### Difficulty scale guideline

> On a 0-100 combat difficulty scale: regular encounters occupy 0-60, Stasis Colonies
> 50-70, bosses 80-100.

The three enemy pools live in `src/config/units.js`: `battle.enemies.bands` (regular
groups, by ring), `battle.colonies` (Stasis Colonies), `battle.bosses` (the Stasis
Seed). Power is an ENEMY-ONLY number; the party grows through ability upgrade trees
(see "Ability upgrades" below), so all old party-power yardsticks are void and the
balance must be re-measured against interactive play.

## Links

* Hosted build (a claude.ai artifact; republish to the same URL to update; publishing
  is paused until the owner asks): https://claude.ai/code/artifact/8ee75dfd-c11a-46fb-80f1-59686726facf
* The combat prototype the battle engine was ported from (no longer read; the logic
  evolves here): https://hex-box.pages.dev

## The world map

* **Field**: a hexagon - centre tile + `map.radius` (11) rings = 397 tiles, flat-top
  hexes by default (`?orient=pointy` flips; the LOCAL map always uses the opposite
  orientation). The run starts on the exact centre tile.
* **Terrain = tile TYPE (gameplay) + BIOME (colour)**:
  * Types (`config.tileTypes`): **ether** - a HOLE in the world (impassable, the
    renderer draws no mesh, the camera sees the void; the hex stays in map data so
    later mechanics can navigate it), **water** (impassable), **ground**, **hill**
    (3 supplies to enter, seen from 1 further), **mountain** (10 supplies + 5 HP per
    living unit, reveal +2, seen from 2 further). A step whose HP cost would down
    someone asks for confirmation first.
  * Biomes (`config.biomes`): grasslands, forest, mesa, desert, dunes, tundra, plus
    **wither** which worldgen never places - the Stasis paints it during play. Final
    tile colour = type colour LERPED towards the biome colour by
    `colors.biomeTintAmount` (never multiplied); `biomeTint: false` types (ether,
    water) ignore it. A biome may override the lerp amount (`tintAmount`), reach all
    types (`tintAllTypes`) and ADD `hpCost` / `terrainHeight` on top of the type -
    wither uses all three (+1 HP per step, seen from 1 further).
  * Generation (`map.js` + `noise.js`, seeded): three independent multi-octave Perlin
    fields, each rank-normalised across the map so the level knobs read as map shares -
    elevation (water below `waterLevel`, hills above `hillLevel`, mountains above
    `mountainLevel`), ether holes (above `etherLevel`), and equal biome bands.
    Frequencies are exposed in Settings > World. Generation retries until the Seed and
    every Colony site are reachable (a corridor is carved as a last resort); the first
    ring is always walkable and the guaranteed route avoids mountains.
* **Fog of war**: tiles start hidden and reveal PERMANENTLY when their distance <=
  `run.revealRadius` (0) + their `terrainHeight`; `run.revealStartRadius` (1) rings
  open around the start. The Seed hides under the fog like everything else.
* **Movement**: one step per turn to a neighbouring walkable tile, paying the tile's
  costs. Supplies are the only currency, capped at `run.startSupplies` (60).
* **Party**: `party.size` (3) units, taken from the top of `party.roster` (10
  characters; name, icon, hp - the character's ABILITIES live in
  `config/abilities.js`, exactly TWO per character). Party units have NO power
  number: they grow by unlocking ability upgrades (see "Ability upgrades").
  A unit at 0 HP is disabled until revived; all disabled = run lost. The party
  moves as one token. (Enemy power stays, on the x3 scale: /3 = bonus damage.)
* **Encounters are opt-in**: `encounters.density` (0.5) of walkable tiles carry one
  (the start tile stays empty), type by weight: battle 5, event 2, treasure 0.8,
  shop 0.75, acolyte 0.15 (min 1 acolyte per map). Standing on one enables **Enter**
  (E); on an empty tile the same button makes camp: `rest.cost` (20) supplies, heals
  each living unit `rest.healFraction` (50%) of max HP, resets fatigue. Encounter
  windows have no close button; choices that abandon a reward ask for confirmation.
* **Fatigue** (`config.fatigue`): a step counter since the last reset maps through
  `byStep` (interpolated, clamped: step 4 = 0%, 5 = 5, 6 = 15, 7 = 30, 8 = 50,
  9 = 75) to the chance that arriving on a tile with a FORCEABLE encounter (battle,
  Stasis fights, event) forces the party in; the roll uses the value shown before the
  step. A forced fight opens with an enemy AMBUSH phase. `resetOn` per type: battle /
  Stasis / acolyte / camp always reset, shop / event optionally, treasure never.
  The **fatigue bar** (top centre) draws one box per step, coloured by its percentage,
  filling as the party walks and emptying on a reset; hovering a reachable tile shows
  the forced chance and the fatigue after the step.
* **The Stasis** (`config.stasis`) - the win condition and the clock:
  * One **Seed** on ring >= `seedMinRing` ('half' = floor(radius/2)); destroying it
    wins the run. `colonyCount` (4) future **Colony** sites; their only placement rule
    is `minSpacing` (5) from each other and the Seed.
  * After each player turn a line grows from the Seed towards each site by
    `lineSpeed` (0.5); when it arrives the Colony encounter spawns (never in the same
    instant the player steps there). Lines are straight 3D segments from the Seed
    cone's mid-height, drawn only over revealed tiles.
  * Each Colony carries one random **debuff** (duplicates stack): party max HP -25%,
    party ability damage -2, or +2 extra enemies. It applies to the Colony's own fight and,
    while the Colony is active, to the Seed fight. Debuffs are temporary per fight;
    damage stays.
  * **Withering**: the Seed and each active Colony gain 1/`witherEvery` (2) charge per
    turn; each whole charge repaints one tile on the rot's current front (closest
    untouched land, one ring of slack) with the wither BIOME. No range cap - left
    alone it swallows the map. Seed/Colony tiles are spared; ether never withers;
    withered water dries into walkable ground; a withered tile loses its encounter.
  * Clearing a Colony lifts its debuff and grants `rewardPicks` (2) upgrade picks.
* **Encounter types**:
  * *Battle / Stasis Seed / Stasis Colony*: interactive combat on the local map (see
    below). Enemy groups are rolled at map generation / Colony spawn and previewed as
    red danger CHEVRONS above the marker - ABSOLUTE, not party-relative
    (`config.battle.danger`): a regular fight shows 0-2 by the band its TOTAL enemy
    power falls into (`bands` [12, 36]), a Colony always shows `colony` (3), the Seed
    always `seed` (5). Reading whether a fight is takeable is the player's job.
    Regular groups come from RING BANDS (count range + total group power range, split
    evenly): rings 1-3 = 1-3 units / 3-6 power, 4-7 = 2-5 / 24-30, 8-11 = 4-8 /
    50-60, hp 14-22 each. The Seed rolls one of 5 `bosses` variants, a Colony one of
    5 `colonies` variants (leader + chaff, or an equal-power swarm). Victory: one
    ability upgrade pick (x`rewardPicks` after a Colony),
    +`battle.victorySupplies` (5) supplies, a lore line.
  * *Treasure*: +`treasure.supplies` (40); if it overflows the cap on an empty tile,
    the dialog offers "make camp first, then collect".
  * *Event*: one of `events.js` - reveal effects (nearest shop / a blob of tiles /
    hidden battles / a vantage), a supply find (10-20), a scholar (a random unit
    unlocks a random available upgrade), the black market (a chosen unit trades 1/3
    max HP for a random upgrade, decline allowed), Nomads (a battle through the same
    combat path), a merchant caravan (acts as a free camp), or plain lore.
  * *Shop*: stays on its tile, revisitable; entering does not reset fatigue. Stock =
    2 guaranteed options (Training = one upgrade pick for 25, reveal 8 tiles for 15)
    + 2 random from (rest 15, relic 25 = same as Training, rumours 15, spare parts
    30 = revive at 50%). Each option sells once; hovering a visited shop lists its
    remaining stock.
  * *Acolyte*: revives one fallen unit at `acolyte.reviveFraction` (50%) HP; not
    consumed if nobody has fallen.
  * Battle victories, treasure, shops, the Acolyte and camps each draw a flavour lore
    line from their pool (`FLAVOUR_POOL` in game.js; texts in the locale table).
* **Camera**: perspective only, follows the player with a glide
  (`camera.followPlayer`). Left-drag pan, right-drag orbit, wheel zoom, arrows pan.
* **HUD**: one top-centre bar (supplies | fatigue boxes | turn), a bottom-centre bar
  holding just the Enter button (the battle bar replaces it during a fight), the party
  panel left, a collapsible legend bottom-right (entries expand with config-generated
  info texts), a menu top-right (M: seed, load, copy link, new map, restart, reveal,
  "Win battle" - a debug button that instantly wins the current local-map fight -
  settings, guided run). The world blurs behind open windows. The event log
  (bottom-left) is a design aid, off by default (Settings > General). UI scale and the
  log switch are browser preferences (localStorage), not config.
* **Settings window** (`settings.js`): the whole config on tabs named after the files
  (World, Encounters, Units, General, Audio). The form is generated from the config's
  shape, changes apply immediately, persist in localStorage over the file defaults,
  and every row / tab has a reset. Map, terrain and party values apply on the next run.
* **Languages** (`i18n.js`): every user-facing string is a key in a flat per-language
  table (`locales/`); only languages registered in i18n.js are selectable (English
  now). `t(key, params)` / `tn(name)`, `data-i18n` for static HTML, plurals
  `{n:one|other}`, language-neutral log entries re-rendered on switch. Event stories
  and lore live in the tables too.
* **Audio** (`audio.js`): synthesised with the Web Audio API, no files - the fatigue
  bar's rising / falling blips with per-play jitter. The voice is fixed in code; the
  only setting is `audio.volume`. Silent until the first click (browser rule).
* **New player experience**: the tutorial scenario series (see "Scenarios" below).
  `tutorial.js` is only the hint-card renderer now - queue, green dashed line to
  the thing a card talks about (HUD outline, tile ring, or encounter shape),
  input blocked outside the card with the menu always working, `hold` on arrive
  cards (then `resumeArrival`). All card numbers come from config (`text.js`).
* **Start flow**: a black fullscreen "Everlands" splash (`config.start`) masks
  loading; the game boots straight into the local map of the start tile - the party
  around a campfire in a composed, locked shot (`local.startCamera`). Clicking a party
  unit (token or panel row) opens the **roster** grid; picking an entry swaps that
  slot (`game.setPartyUnit`, turn 0 only). "Begin journey" (in the Enter button's
  slot) flies the camera out to the world map and the run begins. `?nostart=1` and
  `?scenario=<id>` skip the ceremony.
* **Seeds**: `?seed=...` in the URL, the HUD and the copy-link button; same seed =
  same map. The run-over overlay offers "Inspect the map".

## The local map and interactive combat (src/local/)

* **The arena**: a hex grid of `local.radius` (6) rings in the OPPOSITE orientation to
  the world map, so one world tile visually breaks into a sub-grid. Tile colours are
  shades of the entered world tile, pulled towards each IMMEDIATE neighbouring world
  tile near the edge facing it (squared falloff, per-tile jitter). Arena tiles have a
  BASELINE height from the entered world tile's TYPE - max(`local.tileHeight`, type's
  visual height x `local.typeHeightScale` (2)) - so a hill arena starts taller than a
  plains one; battle arenas then add rolling heights on top: `applyElevationWave`
  (three seeded sine waves) snaps each tile to a level 0..`elevationLevels` (3), drawn
  at `local.elevationStep` (0.35) world units per level (the campfire layout stays
  flat, baseline only). THREE rings of surrounding world tiles stand around the arena
  as giant uninteractive backdrop hexes: bottoms on the arena floor, tops at the SAME
  type-baseline formula - so a mountain neighbour towers over a hill arena and a
  same-type neighbour sits flush with the arena's wave-less level; hidden tiles use
  the fog colour and fog height (no terrain leaks), ether and the map edge stay void.
  Arena camera: rotation only, aimed at the baseline top.
* **The dive**: Enter on a combat tile (or a forced fight) flies the camera into the
  tile - FOV stretch, screenshake, cloud layers, blur and flash peaking at
  `local.swapPoint`, where the world scene swaps for the arena (`local.flyInMs` /
  `flyOutMs`). The climb out starts from wherever the player left the arena camera.
  A recipe hook (`applyRecipe` in localmap.js, fed by `hex.recipe`) is reserved for
  future handcrafted arenas and runs before the swap.
* **Everything changes at the peak** (2026-08-29). The cinematic offers callers two
  moments, and which one a job belongs to is the rule of the whole transition:
  * `onSwap` - the swap point, screen fully clouded. EVERY change of game state or
    of the interface goes here: `body.local-mode` on and off, the battle bar, the
    start screen's HUD, the encounter itself starting, the arena being torn down on
    the way out. Nothing the player can see is allowed to change anywhere else.
  * `onArrived` - the camera has landed. Only "hand control over" belongs here.
  The one thing that would break the rule is a fatigue AMBUSH: it opens with an
  enemy phase, and animations are not state - played at the swap they would happen
  behind the clouds. So `createBattle({ deferOpening: true })` builds the fight at
  the swap (the HUD is the battle's before the clouds part) and holds only that
  opening back until `battle.start()` on arrival. A normal fight opens with
  `startPlayerPhase()`, which animates nothing, and needs no deferring.
  `cinematic.inArena()` is "the arena is on screen, or the dive is past its swap
  and committed to it" - the test callers use before starting an encounter.
* **The unit plaque** (`localview.js`, the `PLAQUE` block): ONE billboard over each
  unit's head carrying the portrait, the HP numbers and the health bar together -
  icon box on the left, "24 / 40" above a bar on the right, the arrangement of a
  party-panel row. The bar copies `.unit .bar` from style.css exactly: same track,
  the same green, the same switch to the danger red below half HP, and a dark
  segment line every `party.hpSegment` HP, so a bar is read the same way in the
  panel and on the field. One sprite rather than two stacked ones is also what
  keeps the plaque centred over the unit - two of different widths never were.
  Sizes live in the `PLAQUE` constant, deliberately not in the settings window.
* **Unit placement happens once**. `build()` (during the dive) places both sides on
  their REAL starting tiles and remembers them; `beginBattle()` re-uses that layout
  instead of rolling again, and only re-places when the board does not match the
  fight being started (the campfire layout, or a fight begun without a dive).
  Rolling twice was why every unit visibly jumped a moment after the camera landed.
* **The combat engine** (`local/battle/engine.js` + `bhex.js`; definitions in
  `src/config/abilities.js`, deliberately NOT in the settings window):
  * **Player phase - one simultaneous turn**: select any unit and reposition it
    FREELY within its range, which is always measured from the tile it started the
    round on - so a move is taken back by simply clicking elsewhere. Casting an
    ability commits the turn so far: the caster is finished and every unit standing
    away from its starting tile locks in place; units still at home keep their
    freedom. The phase ends by itself once every living unit has cast; **End turn**
    (button or E) ends it early for the whole party. Player haste is not consumed by
    repositioning.
  * **Enemy phase**: enemies act by initiative (ties by index), one move + one cast
    each. The AI simulates every reachable cast and scores the outcome (damage,
    kills, stuns - for and against); with nothing worth casting it approaches the
    party along a distance field.
  * **Shared rules**: an uphill step costs 2 movement, flyers glide over anything;
    attacking from 2+ levels above adds `highBonus` (1) damage, from 2+ below loses
    `lowPenalty` (1); a shield blocks one hit or push; stun skips the unit's next
    activation; pushes crash into walls (2 dmg), fall 2+ levels (2 dmg + stun) and
    crush whoever they land on (chains); `voidEdges` (off) can make edge shoves
    lethal. Tile TAGS (fire: 1 dmg, 2 turns) tick when a unit activates on them,
    expire by lifetime, and support on-destroy / on-expire / on-pickup / periodic
    casts. Slowed units keep at least `minSpeed` (2).
  * **Abilities** (`ABILITIES`): zone-based - castZone (where it can be aimed),
    dmgZone / tagZone / hZone / pushZone offsets from the aim point, rotatable
    abilities snap their zones to one of six 60-degree sectors towards the aim;
    `moveToTarget` dashes the caster. 8 starter abilities; `UNIT_COMBAT` gives every
    unit name its init / speed / flying / ability ids (party characters: exactly
    TWO), with a `default` fallback (numbered clones like "Husk 2" fall back to the
    base name).
  * **World-map ties**: an ENEMY's power adds `round(power / powerPerDamage)` (3)
    ability damage; a party unit instead fights with its RESOLVED abilities - base
    def + unlocked upgrade nodes (`def.abilityDefs`, from src/upgrades.js; the
    engine's `abilityFor(unit, id)` serves them, the battle bar reads them too).
    The Stasis "damage" debuff arrives as `partyDamageMod`, a flat penalty to
    party ability damage. A fatigue-forced fight opens with an AMBUSH - one extra
    enemy phase before round 1 (no tag ticks, no round counter).
  * **Presentation**: the engine is pure state; everything visual goes through
    callbacks (onChange / onFloater / onLog / onAnim / onEnd). The view draws
    movement / cast ranges as hex-outline rings (bright over a dark backing, pulsing;
    the hovered ring goes solid white and its tile rises), DOM floaters for combat
    numbers, and the battle bar (`#battle-bar`: active unit, ability buttons, End
    turn) in place of the status bar. The party panel's HP updates live as hits land;
    deaths only become official at the end of the fight.
  * **Wiring**: `game.startCombat` -> `prepareCombat` (rolls the enemies, applies
    Stasis debuffs to the party, logs the opening, returns a context) ->
    `game.combatDelegate` (main.js: builds the engine over the arena via localview
    `beginBattle` / `bindBattle`) -> on the engine's end main.js writes surviving HP
    back into the party and calls `game.finishCombat` (debuffs lifted, deaths,
    rewards, dialogs, win / lose states). With no delegate, `resolveBattle` falls back
    to the legacy auto-simulation (`battle.js`: damage roll 2-8 triangular x
    `powerBase` (1.15) ^ (power gap / 3), low-HP desperation bonus, enemies prefer
    healthier targets) - kept for headless tests. `battle.js` also still generates
    every enemy group.
  * **Debug handles**: `window.game`, `__renderer`, `__cinematic`, `__localView`,
    `__startScreen`, `__battle` (with `debugResolve(won)` to decide a fight
    instantly).
* **Balance is RAW**: ability numbers are first guesses; the difficulty ladder was
  tuned for the auto-simulation and needs re-measuring against interactive play.

## Ability upgrades - how the party grows (src/upgrades.js + src/config/upgrades.js)

Party units have no power stat: every reward that used to raise power now unlocks
one node of an ability's UPGRADE TREE, and the ability itself gets stronger.

* **Trees** (`config/upgrades.js`): one directed graph per ability id, keyed
  `ABILITY_UPGRADES[abilityId][nodeId]`. A node lists `requires` (ALL parents must
  be unlocked; multi-parent capstones merge branches; none = a root) and its
  effects: `add` {damage, heal, buffX}, `castZoneAdd` / `dmgZoneAdd` / `tagZoneAdd`
  offset lists, `pushDistAdd`, and `flags` - booleans for upgrade-specific ability
  logic the engine can branch on (reserved for the unique upgrades to come). Every
  current ability has a 5-node tree (2 roots, 2 mids, 1 two-parent capstone) mixing
  numeric bumps with cast / effect shape growth. Texts:
  `upgrade.<ability>.<node>.name/.desc` in the locales. The plan is 16+ characters
  x 2 abilities = 32+ trees; a tree is found purely by ability id.
* **Resolution** (`src/upgrades.js`, pure functions): a unit carries
  `upgrades: ["ability:node", ...]`; `resolveAbility(id, unlocked)` folds the
  unlocked nodes over the base def in tree order (order-independent),
  `resolvedAbilitiesFor(unit)` feeds the combat engine, `availableUpgrades(unit)`
  is the unlockable pool (parents all unlocked, not yet taken), `treeLayout`
  drives the UI's SVG graphs.
* **Rewards**: after a won battle the game drafts ONE random available upgrade per
  living unit (`game.upgradeOffers()`) and the player unlocks exactly one of the
  offers (a Colony grants `rewardPicks` such choices back to back; offers re-drawn
  before each, so freshly opened children can appear). The same chooser serves the
  shop's Training / Relic options (pay first, then pick); the scholar event and
  the black market unlock a RANDOM available upgrade directly.
* **Sim proxy**: the legacy auto-resolve still compares power numbers, so a party
  unit's hidden `power` = `battle.simPower.base + perUpgrade x unlocked count`,
  refreshed on every unlock. Nothing displays it; interactive combat ignores it.
* **UI**: the roster's DETAIL WINDOW (start screen, below the grid; hover a card
  to preview) shows portrait, backstory (`unit.<Name>.story`), and per ability its
  description (`ability.<id>.desc`) plus the tree as an SVG (owned / open / locked
  node states). The party panel shows two ability CHIPS per unit (icon + name,
  "+n" = unlocked count, tooltip lists them) where the power rating used to sit.

## Scenarios - hand-authored maps (the tutorial series, src/scenarios/)

The tutorial does not use the generator: it teaches through LEVEL GEOMETRY, so its
maps are authored by hand as SCENARIOS - plain data objects that fix everything the
world normally rolls. `Game` takes the scenario as a third constructor argument;
everything downstream (renderer, HUD, combat) sees an ordinary, just small, map.

* **Format** (`src/scenarios/scenario.js` documents it; `tutorial1.js` is the first
  map): explicit tile table (type / biome / revealed), encounters with exact enemy
  groups, shop stock, fixed event ids and treasure amounts, an optional fixed party
  and supplies, scripted `ambushes` (a forced fight fires at an exact step count on
  an empty tile - fatigue stops rolling dice entirely in scenario mode), a `goal`
  (`{ type: 'reach', tile }` with the hidden waypoint marker, or `{ type: 'seed' }` -
  destroying the scripted Seed wins) and an optional `configPatch` (per-run CONFIG
  overrides, applied and undone by main.js). A scripted Stasis: a `stasisSeed`
  encounter becomes the Seed, and `stasis.colonies` lists the future Colony sites
  with an authored `arriveTurn` (used as the line distance), `debuff`, `title` and
  garrison - Game's ordinary Stasis machinery (lines, spawning, withering, curses)
  runs on top unchanged. `buildScenarioMap` returns the same shape `generateMap`
  does. A scenario without a Stasis simply has none (guards in advanceStasis / the
  renderer).
* **Entry**: `?scenario=<id>` (registry in `src/scenarios/index.js`), fixed seed,
  no splash / campfire / roster - a scenario drops straight onto its map. Restart
  keeps the scenario; New map leaves it. Reaching the goal ends the run as a
  scenario victory (`end.scenario`); the `next` field chains the maps.
* **Hint cards**: a scenario lists its own cards as `{ id, at, ... }` triggers
  (`at: 'start' | 'arrive' (tile, optional hold) | 'encounter' (encounterType) |
  'combatStart' | 'camp' | ...`); texts live in the locales as
  `scenario.<map>.card.<id>.title/.text` (config placeholders work). The card
  renderer is the old guide's (queue, green line, input block), but in scenario
  mode the HUD stays fully visible and the card header shows the MAP's name -
  the level teaches, the cards only point. main.js sends the extra
  `combatStart` trigger when the battle engine takes over.
* **Progression**: completing a map is stored in localStorage
  (`hexmap-tutorial-progress`); Menu > Learn > **Tutorial** opens the first
  unfinished map of the chain (`next` links them); after a scenario win the end
  overlay offers "Next map" when a next exists. Restart replays the map.
* **Why**: fully deterministic, so every tutorial map gets an end-to-end
  walkthrough in the smoke test and cannot break silently (the old seeded NPE
  broke whenever worldgen changed).
* **Arena recipes are LIVE**: a battle encounter's `recipe` now really shapes
  its arena - `tiles: { 'q,r': { elevation } }` authors the heights (the random
  elevation wave stays off when a recipe brings its own), and
  `spawns: { party: [keys], enemies: [keys] }` pins units to authored tiles
  positionally (extras fall back to random). Flows through the existing
  `hex.recipe` -> flyIn -> localview path, so normal runs can use recipes too.
* **Status**: map 1 "The Road" COMPLETE (corridor: move, fog, unavoidable first
  fight, cache-pays-for-camp beat, waypoint; 4 hint cards; next: tutorial2).
  Map 2 "The Fork" COMPLETE: a Y island - short steep road (hill + mountain
  prices) vs long flat road (shop with fixed stock + cache); compressed fatigue
  via configPatch ({2:0,3:30,4:70,5:100}) with a scripted two-Husk ambush at
  step 4 (the 4th tile of EITHER road is deliberately empty so it always
  lands); the waypoint guarded by a fight on an authored plateau arena
  (enemies spawn on high ground, a ramp on one side, a sheer drop on the
  other - the shove lesson). 5 hint cards. Map 3 "The Withering" COMPLETE:
  a radius-3 fully revealed island with a visible mini-Seed from turn one;
  the accelerated Stasis clock (configPatch: lineSpeed 1, witherEvery 1) and a
  single scripted Colony ("Rot Chorus", arriveTurn 6, maxHp curse) make the
  time pressure the lesson - dawdle and the island rots under your feet; a weak
  (0 chevrons) and a strong (2 chevrons) fight teach reading danger marks; goal
  type 'seed'. 4 hint cards; last map of the chain (no Next). The old seeded
  NPE (`?npe=1`, `NPE_SEED`) is REMOVED - the scenario series replaced it.

## How the code is split

`game.js` owns truth (state, rules) and emits events: `reveal`, `move`, `encounter`,
`change`, `log`, `end`, `arrive` (holdable), `forced`, `dialog`, plus the Stasis
events `colony`, `wither`, `stasis`. `render.js` and `ui.js` only listen and draw;
nothing in a renderer may change game state. The local-map system lives in
`src/local/` and touches the world only through `MapRenderer.overrideFrame` (the
cinematic drives the shared WebGL renderer) and the `combatDelegate` /
`finishCombat` hooks on Game (see the combat wiring above).

Data shapes:

```
unit   = { name, icon, hp, maxHp, upgrades: ['ability:node'], power (sim proxy only), alive }
hex    = { q, r, ring, key, type, biome, passable, supplyCost, encounter, isStart,
           isSeed, isColony, revealed, visited, x, y }
state  = { status, party, supplies, maxSupplies, turn, position, shortestPathLength,
           fatigueSteps, fatigue, coloniesCleared, endReason }
stasis = { seed, colonies: [{ hex, distance, progress, active, cleared, debuff }], witherCharge }
```

## Open questions

1. Should fog ever re-cover tiles (line of sight), or stay permanent? Currently permanent.
2. Is "supplies" the resource we want, or days / food / something tied to combat?
3. Party HP never grows, only abilities do (through the upgrade trees). Is that the
   pacing we want, or should HP / healing scale too?
4. Map variants: branching lanes? Bigger fields? Multiple Seeds?
5. How is combat balance measured now that fights are interactive? The planned tool
   is a bot that plays roughly like a human (movement + decisions) - a separate,
   large undertaking.

## Roadmap (suggested order)

1. Combat content: more abilities and unit kits, handcrafted arena recipes (tile
   layouts, set dressing, lighting) assigned to encounters at spawn.
2. Re-balance the difficulty ladder against interactive combat.
3. Path preview on hover (total cost to reach a tile).
4. Save / load a run in the browser (localStorage), so a refresh does not reset.
5. Polish: tile textures, fog clouds, more sound.

## Conventions for working on this project

* One feature per request, with acceptance criteria in plain words.
* Numbers go into the config files, never hard-coded elsewhere.
* Every change is verified in a headless browser before delivery (`tools/smoke-test.cjs`).
* No em or en dashes in any text, plain hyphens only.
* Parallel work sessions happen: re-read this file (and re-sync the sources) at the
  start of every task, and update it when a rule or decision changes.
