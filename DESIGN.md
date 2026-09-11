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
    living unit, reveal +2, seen from 2 further). Terrain cost is only charged when
    climbing from strictly lower ground (`game.stepCost`, compares `terrainHeight`):
    ridge-walking mountain-to-mountain or hill-to-hill, or coming back down
    mountain-to-hill, is free. A step whose HP cost would down someone asks for
    confirmation first.
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
    (`config.battle.danger`). A STRICT, static rule (2026-09-10): a regular fight
    shows 0-2 chevrons purely by which RING BAND its tile sits in (`ringBands`
    [3, 7] - rings 1-3 show 0, 4-7 show 1, 8-11 show 2), never by enemy power. A
    Colony always shows `colony` (3), the Seed always `seed` (5) - both
    deliberately above the regular cap of 2. Reading whether a fight is
    takeable is the player's job.
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
    unlocks a random available upgrade), the black market (pick a unit, then pick
    between TWO random upgrade suggestions for that unit only, both costing 1/3
    max HP; decline allowed at either step), Nomads (a battle through the same
    combat path), or a merchant caravan (acts as a free camp). (Pure-lore events with
    no effect were removed.)
  * *Shop*: stays on its tile, revisitable; entering does not reset fatigue. Stock =
    2 guaranteed options (Training = one upgrade pick for 25, reveal 8 tiles for 15)
    + 2 random from (rest 15, relic 25 = same as Training, rumours 15, spare parts
    30 = revive at 50%). Each option sells once; hovering a visited shop lists its
    remaining stock. When the LAST option is bought the shop is consumed like any
    other encounter (marker gone, `encountersCleared` +1, fatigue untouched - its
    reset rule is 'optional'); the stock stays on the hex so the open window still
    reads correctly.
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
  shape, changes apply immediately, and persist in localStorage over the file
  defaults. Map, terrain and party values apply on the next run.
  * **What counts as "changed"** is a DEEP, order-insensitive comparison of the
    live value against the config file (`deepEqual`), not the mere presence of an
    override for that path. `JSON.stringify` compares key ORDER too, so a saved
    collection written in another order read as different from an identical one.
    An override that matches the file is deleted rather than kept, on write and
    on load, so nothing dead is left counting as a change.
  * **"Copy changes" prints one line per LEAF that differs**, not one per
    override (`diffLeaves`). The editable collections are stored whole - adding
    or deleting a creature is a change to the collection, not to one value - so
    printing overrides meant the entire bestiary as JSON because one creature's
    hp moved. Now it reads `battle.enemyTypes.husk.hp = 12  (default: 10)`, and
    an added or deleted record prints as `ADDED` / `REMOVED` with its name.
  * **A record missing from a save has two possible meanings**, and until
    2026-09-08 they were confused: the merge started from the SAVE, so anything
    the save lacked was treated as deleted. One visit to the bestiary therefore
    froze it, every creature added to the config file afterwards vanished
    silently, and Copy changes reported thirty deletions nobody made. The merge
    now starts from today's defaults, and real deletions are recorded explicitly
    as tombstones (`removed: { '<collection path>': [id, ...] }`, saved beside
    the overrides in the v2 store; an older flat save loads with none).
  * **A row's reset button appears only when there is something to undo** - when the
    live value really differs from the config file, not merely when an override
    exists for that path (typing a value back to its default writes an override
    too). `isChanged()` compares the two; before 2026-09-06 the button was drawn
    on every row and pressing it did nothing.
  * **Layout**: each tab is two piles. The small groups go into one `.settings-flow`
    - a multi-column flow, which packs items of any height with no gaps - and the
    tables sit under it at full width. This replaced a grid, where a row is as tall
    as its tallest item: one long group (encounters > visuals, a colour per
    encounter kind) stretched the first row and left a screen-sized void beside
    every short group. Giving the tables the full width is also what stops the
    Battles table needing a horizontal scrollbar.
  * A **nested group of look-alike records** is rendered as a small table instead of
    a stack of one-row boxes, and hoisted out of its parent into its own flow item
    (`looksLikeRecords` / `renderSection`). The test is deliberately strict - three
    or more sub-objects, scalars only, at most four attributes, and every record
    carrying at least half of them - so `stasis > debuffs`, where each entry has a
    different single key, stays as boxes rather than becoming a table of dashes.
  * **Where the battle numbers live**: `battle`'s plain values (the damage curve,
    the danger bands, the simulation numbers) are on the ENCOUNTERS tab, beside the
    Battles table that decides which fight happens where. The Units tab keeps the
    party, the arena rules and the editors for creatures and groups. `battle` is
    still listed in the encounters tab's `sections` so that "Reset tab" reaches it;
    the render loop skips it and renders `battleScalars()` explicitly.
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
  the world map, so one world tile visually breaks into a sub-grid (a handcrafted
  map's own radius wins - see "Handcrafted local maps" below). Tile colours are
  shades of the entered world tile with a strong ELEVATION VALUE RAMP on top
  (`local.tileShade`): each level away from the neutral middle brightens or darkens
  the tile by `perLevel` (0.17), so all five height steps read at a glance, and the
  ramp is re-applied when an ability reshapes the ground mid-fight
  (`LocalMapView.paintTile`). The pull towards each IMMEDIATE neighbouring world
  tile near the edge facing it (squared falloff, per-tile jitter) was cut hard for
  that readability - `neighborBlend` 0.16 capped at 0.25, where the old constants
  were 0.5 / 0.6 and drowned the terrain. Arena tiles have a
  BASELINE height from the entered world tile's TYPE - max(`local.tileHeight`, type's
  visual height x `local.typeHeightScale` (16)) - so a hill arena starts taller than a
  plains one; battle arenas then add rolling heights on top: `applyElevationWave`
  (three seeded sine waves) snaps each tile to a level 0..`elevationLevels` (4), drawn
  at `local.elevationStep` (0.35) world units per level (the campfire layout stays
  flat, baseline only). The levels are CENTRED on `local.elevationMid` (2): that
  middle step is the untouched ground, flush with the surrounding world tiles, and
  the arena has two steps up and two steps down around it. The wave's mix over an
  arena is about 43% middle, 25% each one step up / down, 3.5% each two steps up /
  down, so the outer steps read as rare peaks and pits; its feature size (`FREQ` in
  localmap.js) is x2 the original, which leaves ~36% of tile borders flat and ~14% a
  2-level cliff. THREE rings of surrounding world tiles stand around the arena
  as giant uninteractive backdrop hexes: bottoms on the arena floor, tops at the SAME
  type-baseline formula - so a mountain neighbour towers over a hill arena and a
  same-type neighbour sits flush with the arena's wave-less level; hidden tiles use
  the fog colour and fog height (no terrain leaks), ether and the map edge stay void.
  Arena camera: rotation only, aimed at the baseline top.
* **The dive**: Enter on a combat tile (or a forced fight) flies the camera into the
  tile - FOV stretch, screenshake, cloud layers, blur and flash peaking at
  `local.swapPoint`, where the world scene swaps for the arena (`local.flyInMs` /
  `flyOutMs`). The climb out starts from wherever the player left the arena camera.
  The recipe hook (`applyRecipe` in localmap.js, fed by `hex.recipe`) applies a
  handcrafted arena before the swap - see "Handcrafted local maps" below.
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
    kills, stuns, and POPPING A SHIELD - for and against); with nothing worth casting
    it approaches the party along a distance field. The shield term
    (`combat.shieldStripScore`, 14, against 10 per point of damage) exists because a
    blocked hit deals no damage: without it the AI scored such a swing as worthless,
    refused to attack a shielded unit at all, and since a shield only ever expires by
    blocking something, it stayed up for the rest of the fight (fixed 2026-09-02).
  * **Intellect classes** (`config.intellect`, the table in src/config/units.js;
    since 2026-09-06). Every creature carries an `intellect` of S / A / B / C on its
    bestiary row, and the class says which facts it is able to WEIGH when it plans
    its turn: `statuses`, `elevation`, `tags`, `ether`, `injuries`.
    S weighs all five, A drops statuses and tags, B keeps only elevation, C weighs
    nothing and simply closes to attack. It changes NO rule - a witless brute still
    takes the high-ground bonus when it happens to stand high, still dies in the
    void, still burns - it only changes what it thinks about. Mechanically: the AI
    simulates each candidate cast wearing a `blindfold`, so a mind that cannot weigh
    height sees the blow scored as if the ground were flat and a mind that cannot
    weigh the void sees the shove but not the kill; `injuries` gates the kill bonus
    and the focus-fire term; `tags` counts a burning tile as extra distance while
    walking and as a place worth shoving someone onto; `elevation` also breaks ties
    between equally close tiles in favour of the higher one.
    **Knowing friend from foe is not cleverness**: every class blesses its own side
    and curses the party. What the clever have is TARGETING - a status-reading mind
    uses each status's own `aiValue`, weighs how much the target needs it (a shield
    is worth most on a hurt ally already in reach of the party), and discounts a
    status the target already carries; a blind mind applies the same status at a
    flat `combat.blindStatusValue` to whoever it can reach. Popping a shield is
    valued by EVERY class - a creature does not need to understand shields to notice
    its blow bounced off, and without that the old refuse-to-attack deadlock would
    come back for everything below S.
  * **Statuses are a TABLE, not code** (`config.statuses`, written out in
    src/config/abilities.js; since 2026-09-05). A unit carries a bag,
    `u.status = { <id>: { turns, charges, over } }`, and the engine only knows the
    shape of a table row, never a particular status. A row is built out of verbs the
    engine already performs - `speed` (added to move points, signed), `damageDealt` /
    `damageTaken` (multipliers), `blocks` (eats a whole hit or hostile push),
    `skipsTurn`, `tickDamage` / `tickHeal` (at the start of the carrier's activation)
    - and ends by a clock (`turns`, counted down after the tick) or by use
    (`charges` + `spentOn`: 'hit' / 'attack' / 'activation').
    A status's **knobs** are its numeric fields, in one fixed order - speed,
    damageDealt, damageTaken, tickDamage, tickHeal, turns, charges - narrowed to the
    ones that row actually moved off their neutral value (0, or 1 for the two
    multipliers). An ability's `buffX` is a LIST lined up with that: `buff: 'poison',
    buffX: [4, 5]` is 4 damage a turn for 5 turns, `[null, 5]` keeps the table's
    damage and only lengthens it, a bare number is a one-entry list, and anything not
    named keeps what the table wrote. What the ability set is stored in the slot's
    `over`; `statusKnobs(def)` derives the order, and hovering a row in **Settings >
    Units > statuses** prints it. `aiValue` is how
    BAD the status is to carry, in the AI's own units (a point of damage is 10, a
    kill 45): the AI already plays every cast out on a copy of the board, so a status
    added to the table is understood, inflicted and avoided from the next fight on,
    with no AI change - the exact hole that made enemies ignore shielded units.
    The four originals (shield, crit, stun, haste/slow) are written in this
    vocabulary and behave exactly as before; poison, regen, weaken and vulnerable ship
    as worked examples, applied by nothing yet. A status needing a verb the list
    lacks still needs engine work, but then the VERB is added once and every later
    status can use it. The badges (src/status.js), the arena plaque, the party panel
    and the Settings window all read this one table.
  * **Shared rules**: an uphill step costs 2 movement, flyers glide over anything;
    attacking from 2+ levels above adds `highBonus` (1) damage, from 2+ below loses
    `lowPenalty` (1); a shield blocks one hit or push; stun skips the unit's next
    activation; pushes crash into walls (2 dmg), fall 2+ levels (2 dmg + stun) and
    crush whoever they land on (chains). **The void edge**: an arena side facing an
    ETHER world tile (or the world's rim) is a hole, not a wall - anything shoved
    over it dies instantly. main.js `worldEdgesFor` marks which of the six world
    neighbours are holes, the view turns that into the off-board tile keys
    (`computeVoidEdges`, matched by ANGLE because arena and world hexes use opposite
    orientations) and hands them to the engine as `voidEdgeKeys`; `voidEdges` (off)
    still makes EVERY edge lethal. Tile TAGS (fire: 1 dmg, 2 turns) tick when a unit activates on them,
    expire by lifetime, and support on-destroy / on-expire / on-pickup / periodic
    casts. Slowed units keep at least `minSpeed` (2).
  * **The retreat rule** (`combat.flee`, since 2026-09-02): a decided fight ends
    itself instead of being mopped up. From the round AFTER `afterRound` (7), on every
    enemy's turn, while the enemy side's remaining HP is under `hpFraction` (0.3) of
    what it had at the bell, each enemy that has not broken yet rolls
    `100 / (enemies still standing)` percent to flee - so a crowd goes a few at a
    time and the last one standing always runs. The roll happens ONCE per enemy: a
    fleeing enemy is locked in, walks for the highest ring it can reach each turn,
    never fights, and is a perfectly ordinary target the whole way. Reaching the rim
    takes it off the board with the same pop a consumed encounter marker gets on the
    world map (`LocalMapView.vanishToken`). Escaping is NOT a death: `noteDeath` is
    never called, so nothing lands in `sb.deaths` / `onUnitDeath` - **when loot
    exists, this is exactly the branch that must not roll it**. The fight still ends
    in a WIN once no enemy is left standing, so the party keeps the completion reward.
    The rolls use the engine's injectable `rng` (default `Math.random`) - the only
    randomness in an otherwise deterministic engine.
    **The Stasis is exempt**: a Stasis Seed or Colony fight never offers the roll at
    all. `prepareCombat` puts `stasis` on the combat context (game.js), main.js hands
    it to `createBattle` as `noFlee`, and the engine mirrors it on `state.noFlee`.
  * **Abilities** (`ABILITIES`): zone-based - castZone (where it can be aimed),
    dmgZone / tagZone / hZone / pushZone offsets from the aim point, rotatable
    abilities snap their zones to one of six 60-degree sectors towards the aim;
    `moveToTarget` dashes the caster. 8 starter abilities. How a unit fights is
    written on its own row in config/units.js - a roster row carries speed / flying
    / ability ids (party characters: exactly TWO), a bestiary row those plus `init`
    - resolved by `combatStatsFor(name)`, with `party.defaultCombat` as the fallback
    (numbered clones like "Husk 2" fall back to the base name).
  * **World-map ties**: an ENEMY's power adds `round(power / powerPerDamage)` (3)
    ability damage; a party unit instead fights with its RESOLVED abilities - base
    def + unlocked upgrade nodes (`def.abilityDefs`, from src/upgrades.js; the
    engine's `abilityFor(unit, id)` serves them, the battle bar reads them too).
    The Stasis "damage" debuff arrives as `partyDamageMod`, a flat penalty to
    party ability damage. A fatigue-forced fight opens with an AMBUSH - one extra
    enemy phase before round 1 (no tag ticks, no round counter).
  * **Deployment - the player places the party** (`local.deploy`): a fight the party
    WALKED INTO opens with a placement step. The arena keeps the party off the board
    during the dive (only the enemy is there as the clouds part); when the camera
    lands, the cursor carries the next unit's icon on a flat tile decal (the world
    map's cost-decal idea, an icon instead of numbers, red over an occupied tile),
    left click locks that unit in, right click takes the last one back, and the
    fight is built the moment the last unit is down (`#deploy-bar` shows who is
    being placed). A FORCED fight (fatigue ambush) gets no choice: the party is
    scattered at random, but as a GROUP - no two units further than
    `deploy.maxSpread` (6) apart (`pickClusteredTiles`). Arenas whose recipe
    authors party spawns, and "Restart battle", skip the step.
  * **Death spots**: every unit death is reported with the tile it happened ON -
    `sb.deaths` plus the `onUnitDeath` callback. A unit shoved into the void is
    reported on its LAST tile inside the arena, not the hole. Nothing consumes this
    yet: it is the hook for loot dropped by beaten enemies.
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

## Handcrafted local maps - map codes (src/local/mapcode.js)

Any encounter that opens a local map can trade the random generator for an
AUTHORED arena. The authoring format is the MAP CODE: plain text, one line per
statement, built to be scanned by human eyes and pasted around.

* **The format**: `id:` (required), `radius:` (optional - the arena takes the
  code's size, any 1..12 rings), then tile lines
  `q,r: <type> [elevation] [tags...] [!Enemy Name]`. (A `danger:` header line
  existed until 2026-09-10; it's gone now - a battle tile's chevrons come
  purely from its ring band, see `config.battle.danger.ringBands`.) Only
  tiles that differ from plain ground at the neutral elevation are listed. Types:
  `ground`; `wall` (a rock column - nobody walks or flies through, a shove
  against it crashes like the arena rim); `ether` (a hole - nobody walks in, a
  shove over it kills, exactly like a lethal void edge). Tags are tile tag ids
  from `COMBAT_TAGS` (today: `fire`) and come up PERMANENT - an authored
  brazier is terrain, it does not gutter out like a cast's fire. `!` pins one
  bestiary enemy (by id or display name) to the tile. `#` comments. The parser
  (`parseMapCode` / `buildRecipe` / `recipeFromCode`) validates everything
  against the config and reports readable per-line errors; a broken code is
  skipped with a console warning, never crashes a run.
* **Storage + rates** (`config/encounters.js craftedMaps`): per encounter kind
  - `combat` and `shop` for now - a `rate` (chance a placed encounter uses a
  crafted map instead of a generated arena) and a `maps` list of code strings.
  Three sample maps ship: the-causeway (radius 4), ember-hollow (radius 6),
  wayside-hollow (shop, radius 3).
* **Assignment** (`Game.assignCraftedMaps`): rolled at world generation on a
  rng of its OWN (seed ^ 0x5eedca), after every other roll - tuning the rates
  never reshuffles an existing seed's map, enemies or shop stock. A crafted
  battle's authored enemies REPLACE the rolled group (so the tile's hover, the
  fight and the simulation all agree); its chevrons always come from the
  tile's ring band (`dangerRank`), independent of the recipe. Shops only
  STORE their recipe for now - the shop flow does not open a local map yet.
  Scenario maps skip
  crafted assignment entirely; the Virtual Playtester's world runs keep the
  crafted ENEMIES but fight them on a generated arena (the headless harness
  does not read recipes yet - a known divergence).
* **Engine support**: `createBattle` takes `wallKeys` / `etherKeys`
  (impassable for walking AND flying; wall = crash on shove, ether = death on
  shove) and `startTags` (pre-lit tile tags, made permanent). Placement,
  deployment clicks and random spawns all refuse non-ground tiles.
* **The preview tool** (Menu -> Tuning -> Preview map code): paste any code,
  fix what it lists as errors, and the camera dives into the CURRENT world
  tile's arena built from that code - the same fly-in a fight uses, enemies
  standing as mannequins, no battle bound, no game state touched. The floating
  "Exit preview" button (or Esc) flies back to the world. A debug tool by
  design: it lives in the menu next to Settings.

## Ability upgrades - how the party grows (src/upgrades.js + src/config/upgrades.js)

Party units have no power stat: every reward that used to raise power now unlocks
one node of an ability's UPGRADE TREE, and the ability itself gets stronger.

* **Trees** (`config/upgrades.js`): one directed graph per ability id, keyed
  `ABILITY_UPGRADES[abilityId][nodeId]`. A node lists `requires` (ALL parents must
  be unlocked; multi-parent capstones merge branches; none = a root) and its
  effects: `add` {damage, heal, buffX - a list adds slot by slot}, `castZoneAdd` / `dmgZoneAdd` / `tagZoneAdd`
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
  shop's Training / Relic options (pay first, then pick); the scholar event unlocks
  a RANDOM available upgrade directly; the black market drafts TWO random upgrades
  for one chosen unit (`game.blackMarketOffers()`) and the player picks which one
  to actually learn (`game.blackMarketDeal(index, ref)`).
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
* 2026-09-02 Shield deadlock fixed (see the AI scoring note above), the **retreat
  rule** added (the Stasis exempt from it), keys **1 / 2 / 3** select the active unit's abilities in bar order
  (own abilities first, then an activatable relic - relics do not exist yet, so the
  third key finds nothing until they do), and the world map's forced-encounter banner
  reads **"Ambushed!"** instead of "Exhausted!". Biomes lost their flat `color`: every
  generated biome now carries color0..color8 and the legend swatch asks
  `biomeColorFor` for the layer the run is on. Wither keeps its flat `color` on
  purpose - it is the same rot on every layer. Owner's config calls: the layer gate
  weight up to 1 (from 0.03), both void floors to -5, world fogNear 20, water
  #23479c, camera follow off, and a repaint of the layer 4 / 5 biome palettes.
* 2026-09-05 **Statuses turned into config** (see the table bullet above). The four
  hardcoded fields on a unit (shield / critBuff / stunned / haste) became one bag
  driven by `config.statuses`; durations exist for the first time (nothing had a
  clock before - a shield was spent by a hit, a stun by an activation, and that was
  the whole system); `shieldStripScore` retired into the shield row's `aiValue`, so
  every status carries its own worth in one place. Two things fell out of it:
  `COMBAT_CONFIG` is now folded into `CONFIG`, so the arena's combat rules and the
  status table are editable in Settings > Units like everything else and the engine
  is handed the live object; and the enemy AI's candidate filter gained `ab.buff`,
  which fixed a quiet old bug - an ability that only applies a status (Guard) was
  thrown away before it was ever scored, so **enemies carrying Guard had never once
  used it**. Verified by A/B in the engine (each of the four originals measured
  against a control run) and by a new browser check on the table and the badges.
* 2026-09-06 **Intellect classes added** (see the bullet above): enemies no longer
  all think alike. Assigned across the bestiary as mindless swarm C, ordinary
  soldiery B, elites A, leaders S - a first pass, and every row is a dropdown in
  Settings > Units. Verified by head-to-head runs where only the class changes:
  B and up take the high ground while C walks the flat; A and up shove a party unit
  into a rim hole while B and C never see it; A and up finish a unit that is one blow
  from death while B and C spread their blows; only S walks around a fire; S covers
  the ally that is about to be hit while the rest shield themselves; and every class
  still swings at a shielded unit.
* 2026-09-06 (b) Merged the owner's in-progress edits found on disk mid-session: the
  **Soft Tick** bestiary row (its key had a space and its colour was written as CSS
  `#A1254A`, so the file did not parse - now `softTick` with `0xa1254a`, plus the
  `power` and `intellect` it was missing) and the **Softening Bite** ability, whose
  `buff: 'vulnerable'` named a status that did not exist; the worked example
  `expose` was renamed to `vulnerable` to match, since the ability said it first.
  That surfaced a trap worth knowing: an ability's `buffX` used to default to 1, so
  a multiplier status applied by an ability that never set it landed as a
  meaningless x1. `buffX` now defaults to null, meaning "use the value in the status
  table", which is what a designer expects.
* 2026-09-06 (c) **Worldflake layers merged from 8 to 6** on the owner's instruction:
  old layers 1+2 are now a single layer, and old 7+8 are now a single layer; old
  layers 3, 4, 5, 6 kept their relative order but were renumbered 2, 3, 4, 5. New
  numbering end to end: new 1 = old 1+2, new 2 = old 3, new 3 = old 4, new 4 = old 5,
  new 5 = old 6, new 6 = old 7+8. `config.layers.startLayer` moved from 4 to 3 (the
  SAME physical layer under the new numbering, so no in-run behaviour changed) and
  `unlockOrder` was renumbered the same way: `[4,5,3,6,2,7,1,8,0]` -> `[3,4,2,5,1,6,0]`.
  Every biome's palette shrank from `color0..color8` to `color0..color6`; per the
  owner's call, each merged layer kept the FIRST old layer's colour (old color1 ->
  new color1, old color7 -> new color6) and dropped the other half of the pair (old
  color2, old color8). `tools/smoke-test.cjs`'s layer-gate/layer-selector assertions
  were updated to the new numbers (start layer 3, first gate unlock 4, selector order
  "4,3"). The worldflake LORE (land/air % table per layer, and the "layer 8 is the
  core's asymmetric counterpart" rule) lives in project memory, not here - see
  `worldflake.md`, updated the same day. **Not done, flagged for the owner:** no
  in-game text or asset actually changes look/feel per layer yet beyond the biome
  tint, so this was a pure renumbering + palette-slot removal, not a content pass.
* 2026-09-06 (c) A cleanup pass over the configs, and the spawn table gains a layer.
  * **Fixed: every enemy fought with Strike.** main.js built the arena's enemy defs
    from the bestiary row but copied only the body and the power, so `abilityIds`,
    `init`, `speed` and `flying` were dropped and each creature fell back to the
    nameless default. Giving a creature its own ability in the config had no effect
    in play. The smoke test now compares a bestiary row against the unit the arena
    actually built.
  * **Bestiary colours are '#rrggbb' strings**, the spelling the abilities already
    used. The Settings colour widget remembers which spelling a value had, so
    editing one never rewrites a file's style (the tile types, biomes and the
    colours block still hold 0xrrggbb numbers).
  * **The party's combat stats left config/abilities.js.** A character was written
    twice: name / icon / hp on the roster in config/units.js, and init / speed /
    flying / abilities in a UNIT_COMBAT table over in the abilities config. The
    roster row now carries all of it, exactly as a bestiary row does for a creature,
    with `party.defaultCombat` as the nameless fallback; `combatStatsFor` moved to
    config/units.js with the data. The dead `spawnId` / `spawnZone` fields went from
    the ability factory (nothing has ever read them; summoning will need its own
    field when it arrives).
  * **Haste and slow are two statuses, not one signed one.** A single row has one
    `aiValue`, so it could not be a blessing at one end and a curse at the other -
    the AI read a speed PENALTY as a gift and handed it to its allies. Each end
    states its own worth now (haste -6, slow +9), and each writes its own sign
    (haste is speed +1, slow is speed -1).
  * **Which groups spawn where is a GRID now**: a row per kind of fight (the three
    ring bands, the Colonies, the Seed) and a column per layer, in
    `battle.spawns`. `enemies.bands` keeps only its `maxRing`; `battle.bosses` and
    `battle.colonies` are gone. Every layer starts with what the old flat lists
    held, so nothing changed in play until a cell is edited, and an empty cell
    plays the nearest filled layer of the same row. Edited in **Settings >
    Encounters > Battles**, which replaces the wall of tick boxes that used to sit
    on the Units tab: press + for a searchable list of groups, press a group to
    take it out, list one twice to double its odds.
* 2026-09-06 (d) **Fixed: saved settings from an older build took the page down.**
  Settings are stored as a snapshot of the config AS IT WAS THAT DAY, so a save made
  before the roster rows carried their own `abilities` restored a party of rows with
  none, `unitAbilityIds` handed back undefined and the first party card threw
  (`ui.js`, `.map` of undefined) - the whole page with it. Reported from the hosted
  build by the owner, who had added a character through the Settings window; that is
  what saves the WHOLE roster and freezes its shape.
  Two guards now, because either alone leaves a hole:
  * `combatStatsFor` fills anything a roster row is missing from `party.defaultCombat`,
    so an incomplete row can never crash the game again - it just plays plainly.
  * saved overrides are MERGED over today's defaults on load rather than replacing
    them (`healOverride` in settings.js: lists of records match by `name` then by
    position, tables of records by key), and an override pointing at config that no
    longer exists is dropped. This heals an old save in place: the owner's characters
    get their real abilities back rather than a generic fallback, and the settings
    they actually chose survive.
  The smoke test now boots a second page with exactly that stale save and checks it
  comes up, keeps what it should and heals the rest.

* 2026-09-06 (e) **`init` came off the party roster.** Turn order inside a fight is
  decided by the enemy queue alone (`engine.js`: `sb.enemyQ = ... sort((a, b) => b.init
  - a.init || a.idx - b.idx)`, filtered to `isEnemy`; `ui.js` sorts the enemy strip the
  same way). The party acts in the order the player clicks, so a character's `init` was
  a number nobody read - it only invited balancing effort that could not land. Removed
  from all ten roster rows, from `party.defaultCombat`, from `NEW_ROSTER` and from the
  roster table in the Settings window. It stays on every BESTIARY row, where it is real.
  `makeInstance` now ends `init: def.init ?? cs.init ?? 0` so a party unit gets a
  harmless 0 rather than `undefined`. The smoke test guards the split: no roster row or
  `defaultCombat` may carry `init`, and every bestiary row must.


* 2026-09-07 **`amountIs` and `amountSign` are gone; `buffX` is a list.** The owner
  called both redundant and was right on each count. `amountSign` was a negative
  number written the long way round - a status now writes its own sign (`slow` is
  speed -1) and an ability hands over the number it means (`buffX: [-2]`).
  `amountIs` named the ONE field buffX could reach, which the status's own verbs
  already imply and which made a second field unreachable: no ability could say how
  long its poison lasts. Its only real job was choosing between fields when a status
  has several, and a list does that better.
  * A status's KNOBS are its numeric fields in one fixed order (speed, damageDealt,
    damageTaken, tickDamage, tickHeal, turns, charges), narrowed to the ones the row
    moved off their neutral value. `statusKnobs(def)` derives it; nothing is written
    down, so editing a status in the Settings window changes its knobs on the spot,
    and hovering the row prints the order.
  * `buffX` lines up with that list. A bare number still works as a one-entry list,
    so every ability written before this change means exactly what it meant.
  * The slot on a unit changed from `{ turns, charges, amount }` to
    `{ turns, charges, over }`, where `over` holds only the knobs the ability named.
    `turns` and `charges` are knobs like any other, which is how an ability can now
    set a duration; they simply also happen to be what counts down.
  * `resolveAbility` learned to add a list slot by slot, so an upgrade node's
    `add: { buffX: [...] }` bumps the knobs it names - and it copies the list, so an
    upgraded ability can no longer write into the shared config table.
  * This also fixed a live mistake the old shape invited: `enraged` had been authored
    pointing at the speed of a status that changes no speed, so its badge read 0.
  * The badge shows the SIZE of the first knob, not the stored number: the table
    writes `slow` as -1 while every locale string reads "moves {n} tiles less", so
    the sign lives in the status's name.


* 2026-09-10 **Tile tags became config, and the AI learned to read them.**
  * **Tags are part of the config object** (`config.tags`, still the `COMBAT_TAGS`
    table in src/config/abilities.js - same object, not a copy). They were the last
    piece of arena content that could only be changed by opening a file. They now
    have their own table on **Settings > Units**, beside the statuses, and the four
    hook columns are DROPDOWNS of ability ids rather than text boxes, because a
    typo in a hook fails silently.
  * **A tag can already do anything an ability can**, and always could: its own
    tick is only `dmg` / `heal`, but each of its four hooks - `onPeriodic` (+
    `everyX`), `onPickup` (needs `collectible`), `onExpire`, `onDestroy` - casts a
    whole ability at the tag's tile, statuses and all. A tag has no side: the cast
    lands on whoever is standing there, party or enemy.
  * **What the AI could not see**: it measured a tile by `t.dmg` alone, so a pool
    that only poisons scored a flat zero and every class walked into it. `tagHarm`
    now adds each hook's ability - its damage, its healing, and the `aiValue` of
    the status it applies, divided by 10 to come back into damage units. A tag that
    HEALS or blesses comes out negative, so a mind that reads tiles will step onto
    it. This lands in both places that already asked: the approach walk, and the
    per-unit term in cast scoring - which is what makes a creature avoid standing
    on bad ground while it attacks, and prefer shoving someone onto it.
    One honest limit: the worth is the STATUS's `aiValue`, not the amount a hook's
    `buffX` actually applies. A pool that poisons far harder than the table's own
    poison should be given its own status row with its own aiValue - the same
    reason haste and slow are two rows rather than one signed one.
* 2026-09-10 **The intellect classes moved to config/units.js.** A class is
  something a CREATURE has - every bestiary row names one in its `intellect`
  column - so the table belongs beside the bestiary, not in the abilities file it
  happened to start in. `INTELLECT` and `intellectOf` are exported from there and
  `intellect: INTELLECT` is a member of `UNITS`, so `config.intellect` is the same
  path the engine always read; only the import in settings.js moved. The unused
  `BLIND_STATUS_VALUE` export went with it - the number the engine actually reads
  is `combat.blindStatusValue`, and two spellings of one number is exactly how
  `enraged` came to point at a field it did not have.
* 2026-09-10 **The aim preview: what a cast would touch.** Selecting an ability
  rings every tile it MAY be aimed at; hovering one of those now fills in the tiles
  a cast there would actually affect.
  * `battle.aimPreview(k)` (engine) is a pure query returning `{ anchor, kind, hit,
    tag, push, height, dash }`. It reads the same zones with the same rotation and
    the same `tilePass` filter `resolveCast` reads, so the hint cannot drift from
    the cast. A tile nothing may be aimed at returns null.
  * The view (`syncAimFx` in localview.js) paints one filled hex per touched tile,
    ADDITIVE so it reads as light on the tile rather than paint over it, coloured by
    CONSEQUENCE rather than by ability: `colors.aimHitFill` / `aimHealFill` /
    `aimBuffFill` for the blast, `aimPushFill` for a shove (the tile, then the way
    it is pushed, fading), `aimRaiseFill` where the ground changes height,
    `aimTagFill` where a tag is left, `aimDashFill` where the caster ends up.
    `local.aimFxOpacity` sets how bright they are. Rebuilt only when the tile under
    the cursor changes.
  * **One honest limit**, stated in the code: a shove is drawn as the tiles it AIMS
    through, not where the victim ends up. Collisions, crushes and falls resolve in
    waves against everything else the same cast moves, and playing that out would
    mean simulating the cast to draw a hint about it.
* 2026-09-10 **`tools/engine-test.mjs`** (`npm run test:engine`): headless rules
  checks that run in seconds. The smoke test drives the real browser and stays the
  authority on anything the player can see, but some rules are far easier to state
  as a fight built by hand than as a click path. Note the two traps it documents:
  the engine needs `instant: true` for a whole enemy phase to resolve inside
  `endTurn`, and passing an `onAnim` stub that never calls `anim.enter()` gives a
  test in which nothing ever moves.
* 2026-09-10 Defaults: `audio.volume` 0.35 -> 0.05, `weakTick.color` -> `#a0c437`,
  and `battle.spawns` layers 0-2 emptied in all five rows. An empty cell plays the
  nearest filled layer, so those three still draw layer 3's fights - the cells are
  simply free now to be given their own rosters without being cleared by hand
  first.


* 2026-09-11 **The ability reference lives in the config now.** The top of
  src/config/abilities.js spells out every knob an ability has - where it can be
  pointed, what it does and in what order, and what is NOT possible without engine
  work. It also explains the thing that reads as a bug and is not: with
  `rotatable: true` the game lights up every tile the dmgZone would cover and treats
  a click there as a click on the castZone tile that covers it, so Lance shows 18
  tiles for a castZone of 6. It does not extend reach - the far click casts from the
  near tile and hits the same three - but it is invisible unless someone says so.
* 2026-09-11 **`lineOffsets(minD, maxD)` and `hexLine(a, b)`** (bhex.js). The first
  is the star to `ringOffsets`' blob: only the six straight spokes, nothing in
  between them, for anything that travels in a line. It was possible to write that
  shape by hand all along - a castZone is a plain list of offsets - but nobody could
  guess that from the config, which is the same failure the reference above fixes.
  `hexLine` is the standard cube-interpolated hex line, used by the dash below.
* 2026-09-11 **A dash may be aimed at an occupied tile.** `moveToTarget` used to
  strike every occupied tile off the aim list, which made a CHARGING SHOVE
  impossible to express: the whole point of one is to aim at the target, ram it out
  of the way and take its place.
  * Aiming (`dashAimOk`) now asks only whether the TERRAIN allows it - a solid tag
    or an impassable tile still says no, a unit does not.
  * Where the caster stops is settled at resolution (`dashLanding`), which runs
    LAST, after the cast's own shoves. It walks `hexLine` towards the aim point and
    takes the furthest tile it can stand on, stopping in front of the first thing
    still in the way. So the ram that clears the tile lands on it; the one whose
    shove was blocked by a wall, an ally or another enemy pulls up short. Landing on
    its own tile means it never moved.
  * The whole ability is config: `castZone: lineOffsets(1, 3)`, `dmgZone: [[0, 0]]`,
    `pushZone: [[0, 0, 0, 1]]`, `rotatable: true`, `moveToTarget: true`.
* 2026-09-11 **The aim preview now simulates the moving half.** Where the zones
  fall (hit / tag / height) is still read straight off the ability and is exact by
  construction. What MOVES cannot be: shoves resolve in waves against everything
  else the same cast moves, and a charge only reaches the target's tile if the ram
  cleared it. So `aimPreview` plays the cast out on a copy of the board - the same
  machinery the enemy AI uses - and reports the real outcome: `push` became
  `{uid, from, to}` per unit that actually moves, and `dash` is the tile the caster
  actually reaches, with `dashShort` true when it stopped in front of what it was
  aimed at. This removed the "intent, not outcome" caveat the previous entry
  carried. The view fills the tile a victim leaves solid and the tile it lands on
  lighter.


* 2026-09-11 (b) **Fixed: a charge could be aimed through a body.** Standing in
  front of enemy A with enemy B behind it, Charge Headbutt offered B as a target.
  The cast then HALF happened: B took the hit and the shove, while the caster,
  blocked by A, never moved - an ability reaching across a body it could not pass.
  * `dashAimOk` now checks the whole run, not just the destination: everything
    strictly between the caster and the aim point must be empty ground (`hexLine`),
    and only the aim point itself may be occupied. A charge is a run across the
    floor, not a teleport.
  * A dash no longer generates dmgZone ALIASES either. Aliases exist so a rotatable
    ability can be aimed by clicking the enemy you mean to hit rather than the tile
    in front of you, but for a charge the aim point is also the DESTINATION, so an
    alias lights up a tile the unit is not going to. Same confusion, same fix.
  * Note this was never a resolution bug: `dashLanding` correctly refused to move
    and `aimPreview` correctly showed no dash. The mistake was offering the aim.
* 2026-09-11 (c) **The aim-preview fills no longer z-fight the highlight rings.**
  They were two nearly coplanar surfaces sharing the same pixels. The fill is now
  NARROWER than the ring's dark backing (0.68 of the tile radius against the
  backing's 0.72), so they never overlap in the plane at all - which fixes it for
  good, where nudging one a hair higher only moves the problem around. The fills
  also sit a little above the rings now, stacking upwards where a tile carries
  several marks.
* 2026-09-10 (d) **"power" is gone.** No unit, party or enemy, carries a power
  number any more - it fed a damage-multiplier in auto-resolve (`src/battle.js`)
  and a flat bonus in the interactive engine (`src/local/battle/engine.js`),
  both now removed along with `battle.powerBase`, `battle.powerStep`,
  `battle.simPower` and the bestiary's `power` column. A unit's actual hit now
  comes ONLY from the ability it used (`config/abilities.js` `damage`, plus any
  unlocked upgrade adds) - so two enemies sharing an ability (most still do)
  hit for the same amount regardless of tier, until stronger enemies are given
  their own, stronger abilities. The Stasis "damage" debuff, which used to lean
  on the power number for auto-resolve fights only, now applies the same
  `damageMod` penalty in BOTH combat systems. `tools/smoke-test.cjs` was found
  to already fail before this change, at an unrelated step (it never completes
  party deployment, so `window.__battle` never appears) - not something this
  change touched or fixed.
* 2026-09-10 (e) **The battle-spawn table moved to config/encounters.js.** It
  used to live in config/units.js as `battle.spawns`, built by a helper that
  copied one list onto every layer. It is now `ENCOUNTERS.battleSpawns` in
  config/encounters.js, spelled out one layer at a time for all 5 rows (inner,
  middle, outer, colonies, seed) x 7 layers (0-6) so each layer can be edited on
  its own - wired back onto `CONFIG.battle.spawns` by a single line in
  config.js so every existing reader (`src/battle.js`, `src/settings.js`'s
  Battles tab) needed no change. Content is unchanged: layers 0-2 still start
  empty (playing layer 3's roster), layers 3-6 still carry what the old table
  held.


## Open questions

1. Should fog ever re-cover tiles (line of sight), or stay permanent? Currently permanent.
2. Is "supplies" the resource we want, or days / food / something tied to combat?
3. Party HP never grows, only abilities do (through the upgrade trees). Is that the
   pacing we want, or should HP / healing scale too?
4. Map variants: branching lanes? Bigger fields? Multiple Seeds?
5. Combat balance is measured by the VIRTUAL PLAYTESTER (see its section above):
   all three phases are live - the combat gym, the world runner (full headless
   campaigns) and the playstyle personas with per-decision pick records. Open
   next: tuning the personas until the owner likes HOW they play, then using
   the numbers to re-balance.

## Roadmap (suggested order)

1. Combat content: more abilities and unit kits, more handcrafted map codes
   (the format, walls / ether / tags / pinned enemies and the preview tool are
   live - see "Handcrafted local maps"); still open: set dressing and lighting.
2. Re-balance the difficulty ladder against interactive combat.
3. Path preview on hover (total cost to reach a tile).
4. Save / load a run in the browser (localStorage), so a refresh does not reset.
5. Polish: tile textures, fog clouds, more sound.

## The Virtual Playtester (tools/playtester/)

An automated system that PLAYS the game headlessly - no browser, no UI - and
turns the results into balance data, Slay-the-Spire-metrics style. It imports
the very modules the game ships (the combat engine, the bestiary builders, the
upgrade resolver), so it can never drift into testing a different game; its
bots act only through the public player API and see only what a player sees.
It REPORTS findings; changing the game in response is always a separate,
owner-approved request.

* **Engine instant mode**: `createBattle({ instant: true })` collapses every
  pacing setTimeout into a synchronous call (the `wait` helper) - a whole
  enemy phase resolves before `endTurn()` returns. Rules untouched; the game
  itself never passes the flag. This is the one game-side hook the harness
  needed.
* **The harness** (`headless.mjs`): one fight = the live arena recipe (local
  map + elevation wave), seeded random-distinct-tile placement, resolved
  party abilityDefs, an engine in instant mode and a bot on the sticks.
  Everything is reproducible from (seed, group, party spec, bot); the bot
  rolls its own seeded rng, separate from the game's. `buildParty` unlocks N
  upgrade-tree nodes the way a run would (one available pick at a time), so
  "N upgrades" is the gym's progression axis.
* **The bots** (`bots.mjs`): policies with one entry point,
  `actUnit(battle, unit, rng)`. `greedy` - competent-first-timer heuristics:
  score every legal aim by its EXACT rotated footprint (never clip an ally or
  the caster, never bloom-heal an enemy), close distance first with high
  ground as a tie-break, heal real wounds. `random` - the lower bound and
  crash-finder. Bot numbers are COMPARATIVE (before vs after a patch), not
  absolute difficulty.
* **The gym** (`gym.mjs`, `npm run gym`): sweeps enemy groups x party
  progression points x N seeds, one JSON line per fight (plus a header that
  makes the log self-describing), `--patch file.json` applies dotted-path
  CONFIG overrides for A/B experiments on identical seeds. Roughly 20-50
  fights/s single-process. **The report** (`report.mjs`, `npm run gym:report`)
  aggregates a log into the bestiary difficulty ladder (win rate with a 95%
  margin, rounds, HP left) as report.md; two logs = an experiment diff with
  noise-aware markers. The harness guards its own spawns (everyone in one
  walkable height component) so soft-locks do not pollute the statistics.
* **The world runner** (`worldrun.mjs`): plays a COMPLETE campaign in Node -
  a real `Game` on a real generated worldflake. Every fight is delegated the
  way main.js delegates it (`game.combatDelegate` -> the shared `runArena`
  core in instant mode, wounds written back by partyIndex, then
  `finishCombat({ won, rounds, interactive: true })`), and every window the
  game opens ('dialog' events) is queued during the action and answered after
  it returns through the same public calls the buttons make (claimSupplies,
  upgradeOffers + applyUpgradePick, shopBuy, restoreUnit, blackMarketOffers +
  blackMarketDeal). Every upgrade screen also writes a per-decision 'pick'
  record (offered refs vs the taken one) - the Slay-the-Spire lesson. Known
  divergences from the live game, both cosmetic to the rules: no deployment
  step (spawns are random, walkable-component guarded) and no scripted void
  edges. The engine's rng is seeded now, so a whole campaign replays
  identically from its seed.
* **The personas** (`worldbot.mjs`): the overworld policy plus three
  parameter sets - `cautious` (fights only what looks safe, camps early,
  hoards, grinds before the Seed), `bold` (the intended baseline: calculated
  risks, shops, black-market deals) and `rusher` (beelines the Seed; if THIS
  wins often, the map is too easy). Decisions read only the public API and
  only REVEALED tiles; with revealRadius 0 exploring literally means stepping
  into the fog, and an impassable fogged tile is learned by bumping into it,
  like a player clicking blind. Courage is measured in danger chevrons and
  grows with the party's upgrade count. The upgrade CHOOSER is a seeded
  random pick on purpose: pick-rate stats then measure what the game offers,
  not a bot-invented meta.
* **The campaign runner** (`campaign.mjs`, `npm run campaign`): N seeds per
  persona, one 'run' line each (outcome, end reason, turns, fights, forced
  fights, colonies, deaths, upgrades, supplies, the per-fight log) plus the
  'pick' lines; `--patch` works like the gym's. `report.mjs` recognises a
  campaign log automatically (`npm run campaign:report`): per-persona
  outcome/pace/economy tables, a loss-anatomy table (HOW runs end), the
  upgrade pick rates, and a per-persona win-rate diff when given two logs.
  A run that stops moving is recorded as 'stalled' with its reason - that is
  a finding about the policy or the map, not an error.
* **Day-one findings** (2026-09-03, greedy bot, default trio, 30 seeds/cell;
  REPORTED ONLY, nothing changed in the game by the owner's decision):
  the inner band is a clean 100% at 0 upgrades; the middle band jumps to
  0-3% at 0 upgrades and only reaches 60-80% at 12 - a cliff, not a ramp;
  the outer band and every boss are 0% even at 12; colonies disagree wildly
  with each other (Stasis Brood 57% vs Colony Anchor 0% at 12). Open bugs the
  gym exposed: the Sweep upgrade's ring can HIT ITS OWN CASTER in melee, and
  units can SPAWN ON SEALED PLATEAUS the height graph lets nobody leave or
  reach, which soft-locks a fight forever (`localview.placeUnits` has no
  walkable-component guard; the harness's own placement does).
* **Campaign findings** (2026-09-03, 10 seeds/persona, light validation runs
  only; REPORTED ONLY): every persona loses every run, mostly 'end.fell'
  (killed in a fight) around turn 17-30 despite a 47-76% per-fight win rate -
  consistent with the gym's middle-band cliff. One notable scale problem: a
  1-chevron fight reads as "moderate risk" but is near-unwinnable for a
  fresh party, so even the cautious persona (courage 1) walks into deaths
  the danger chevrons approved. Nobody found or cleared a Colony in these
  samples.

## Conventions for working on this project

* One feature per request, with acceptance criteria in plain words.
* Numbers go into the config files, never hard-coded elsewhere.
* Every change is verified in a headless browser before delivery (`tools/smoke-test.cjs`).
* No em or en dashes in any text, plain hyphens only.
* Parallel work sessions happen: re-read this file (and re-sync the sources) at the
  start of every task, and update it when a rule or decision changes.
