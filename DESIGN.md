# DESIGN.md - the shared memory of this prototype

Read this first in every new work session. It records what the prototype does, why,
and what is still open. Keep it short and current; update it when a rule changes.
The CODE is the source of truth - numbers quoted here are config defaults and can
drift; when in doubt, read `src/config/*`.

## Purpose

The world map (level select) of a larger roguelike in the Slay the Spire / Into the
Breach spirit, plus its combat layer: the player picks where to go between fights on a
fogged hex map, and combat encounters are played out on a local arena map with a
tactics engine. The Hack terminal and the shop are played on that same local map
(a hack with the engine, a shop with nothing but a keeper to click); the other
non-combat encounters (events, treasure, the Acolyte) resolve through dialogs.

### Difficulty scale guideline

> On a 0-100 combat difficulty scale: regular encounters occupy 0-60, Stasis Colonies
> 50-70, bosses 80-100.

A fight IS a handcrafted map - its arena and its pinned enemies together (see
"Handcrafted local maps" below). The five difficulty pools are the rows of
`battleMaps` in `src/config/encounters.js`: `inner` / `middle` / `outer` (regular
fights, keyed by the tile's ring band), `colonies` and `seed`, one column per
worldflake layer. There is no party-power number; the party grows only through
ability upgrade trees (see "Ability upgrades"), so difficulty has to be judged by
interactive play, not by a stat total.

## Links

* Hosted build (a claude.ai artifact; republish to the same URL to update; publishing
  is paused until the owner asks): https://claude.ai/code/artifact/8ee75dfd-c11a-46fb-80f1-59686726facf
* The combat prototype the battle engine was originally ported from (no longer read;
  the logic evolves here now): https://hex-box.pages.dev

## How the code is split

`game.js` (the `Game` class) is the sole owner of run state and the only code that
mutates it. It exposes read methods (`reachable()`, `stepCost()`, `canMoveTo()`,
`livingUnits()`, `dangerRank()`, ...) and action methods (`moveTo()`, `enter()`,
`startCombat()`, `shopBuy()`, `applyUpgradePick()`, ...), and after any mutation calls
`emit(type, payload)`. `render.js` (the Three.js world renderer) and `ui.js` (the DOM
HUD) only subscribe via `game.on(...)` and call `Game`'s read methods to decide what
to draw - neither ever assigns into `Game`'s state directly. `main.js` is the wiring
layer: it constructs `Game`, the renderer, the UI, the tutorial and settings windows,
and the combat cinematic, and dispatches every `Game` event to them from one
`game.on(...)` block.

Current event types: `change`, `log`, `move`, `end`, `arrive`, `wither`, `stasis`,
`colony`, `encounter`, `forced`, `dialog`, `shop`, `camp`, `reveal`.

**The local-map boundary.** `src/local/` knows nothing of fog, fatigue or encounter
types - only hex/tile data and the combat engine's own state. It connects to the rest
of the game through a small number of hooks on `Game`, all wired in `main.js`:
`game.combatDelegate(ctx)` (drives an interactive fight instead of auto-resolving one),
`game.combatIntro(hex, resume)` (forced-encounter dives), `game.finishCombat(ctx, result)`
(the arena reports back `{ won, rounds, interactive: true }` and `Game` applies
deaths/rewards/state transitions), and `game.hackDelegate` (the same pattern for the
Hack terminal). The shop needs no delegate: `Game` emits `shop` when the encounter
opens and `main.js`'s shop bridge, already in the arena by then, stands the keeper
up (see "The shop"). The camera transition (`src/local/transition.js`,
`createCombatCinematic`) reaches into the shared renderer through exactly one hook,
`renderer.overrideFrame`, swapping in the local arena's own Three.js scene mid-flight
without touching world meshes or `Game` state.

**`src/local/`:**
* `localmap.js` - pure data: builds the flat local hex grid (opposite orientation to
  the world grid) and lays a handcrafted recipe onto it; also generates the Hack
  board (`buildHackRecipe`).
* `localview.js` - `LocalMapView`, the Three.js side of the arena: its own
  scene/camera/controls, tile painting, unit bodies, status plaques, deployment and
  tile picking.
* `mapcode.js` - parses/serializes handcrafted map codes into recipes.
* `transition.js` - the dive/fly-out camera sequence between world and local scenes.
* `battle/engine.js` - `createBattle`, the turn-based combat rules engine (movement,
  ability resolution, statuses, enemy AI); pure state and callbacks
  (`onChange`, `onFloater`, `onLog`, `onAnim`, `onEnd`), no DOM or Three.js.
* `battle/entity.js` - `Entity`, anything interactive that stands on the board, and
  `Unit`, the Entity with agency (what the player and the AI control); see
  "Entities and units" below. The Hack's node and mine and the shop's keeper are
  its subclasses.
* `battle/bhex.js` - hex math for ability shapes (`ringOffsets`, `lineOffsets`, `DIRS`).
* (The Hack terminal has no folder of its own since 2026-09-24: its board builder
  is in `localmap.js`, its pieces in `battle/entity.js`, its rules in
  `battle/engine.js`, its panel and disc stacks in `localview.js`, its flow in
  `main.js`, its knobs in `config/encounters.js` - see "The Hack terminal" below.)

**`src/config/`** - every tunable number; `config.js` spreads the pieces into one
`CONFIG` object so the rest of the code always reads `CONFIG.<section>`:
* `world.js` - map shape, worldflake layers, tile types, biomes, generation noise.
* `encounters.js` - encounter placement/weights, the Stasis (Seed/Colony) rules,
  fatigue rules, shop/treasure/event/rest tuning.
* `entities.js` - party roster, bestiary, intellect classes, tile tags; exports
  `combatStatsFor(name)` and `tagDefById(id)`.
* `abilities.js` - `ABILITIES`, `ABILITY_UPGRADES`, `STATUSES`; abilities are pure
  data read by one executor (`resolveCast` in `battle/engine.js`).
* `localmap.js` - arena rules, camera, colours, backdrop (`COMBAT_CONFIG`).

**`src/locales/`** - `en.js` is the reference table (every key the game uses); `ru.js`
exists and is kept up to date but is not currently wired into `i18n.js`'s language
list, so the game only runs in English today.

**`src/scenarios/`** - `index.js` (registry), `scenario.js` (`buildScenarioMap` turns
authored scenario data into the same map shape `map.js` produces, so nothing
downstream special-cases it), and the three tutorial maps themselves.

**Cross-cutting:** a single seeded `mulberry32` RNG (`rng.js`, `createRng(seed)`) is
threaded through `Game` as `this.rng`, so the same seed reproduces the same map and
fights (`?seed=` links are shareable); all UI text goes through `t(key, params)` /
`tn(name)` (`i18n.js`) against flat locale tables with `{name}` placeholders and
`{n:one|other}` plural forms, falling back to English then the raw key; damage
numbers are a small notation - `parseDamage`/`formatDamage`/`addDamage` in
`damage.js` read/write `"5x4"` (5 damage, 4 hits) - the one place "x" notation is
interpreted; and `text.js` plus the Settings window generate their copy and editable
forms directly from `CONFIG`'s shape, so no gameplay number should live hardcoded
outside `src/config/*`.

**Core data shapes:**

```js
// Party unit, built from config.party.roster:
{ name, icon, hp, maxHp, upgrades: [], alive: true, isPlayer: true }
// upgrades: "<abilityId>:<nodeId>" refs (unlocked ability-tree nodes)

// World-map hex, built by map.js generateMap / scenarios/scenario.js:
{
  q, r,                  // axial coordinates
  ring,                   // hex distance from centre
  key,                     // "q,r"
  type,                     // 'ether' | 'water' | 'mountain' | 'hill' | 'ground'
  biome,                     // config.biomes key
  passable, supplyCost,       // from the tile type
  encounter,                   // null | 'battle' | 'stasisSeed' | 'stasisColony' |
                                //   'shop' | 'treasure' | 'event' | 'acolyte' | 'gate' | 'hack'
  isStart, isSeed, isColony,
  revealed, visited,
  x, y,                          // 2D plane position
  enemies,                        // rolled enemy list, until the fight consumes it
  recipe,                          // the handcrafted local-map code for this fight
  shop,                             // { stock, bought, seen } once a shop rolls
}

// Run state, Game.state:
{
  status,                 // 'playing' | 'won' | 'lost'
  party,                    // array of party units
  supplies, maxSupplies,
  turn,
  position,                  // hex the party stands on
  shortestPathLength,
  fatigueSteps, fatigue,       // steps since last encounter; rolled % (fatigue is off by default)
  encountersCleared, coloniesCleared,
  lastBattle,
  pendingSupplies,               // { amount, source } | null, awaiting a claim/overflow choice
  endReason,                       // [locale key, params]
}

// Stasis, Game.stasis:
{
  seed,                     // the Seed hex, or null on a scenario without one
  colonies: [
    { hex, distance, progress, active, cleared, debuff, script }
  ],
  witherCharge: Map(),        // source hex key -> accumulated wither charge
}
```

## The world map

**Field and generation.** Axial coordinates (`src/hex.js`), default `radius: 11`
(397 tiles). `map.js generateMap(config, rng, layer)` places the Stasis Seed on an
outer ring and 4 future Colony sites (minimum spacing between them), samples three
independent Perlin fields (elevation, ether holes, biome band) via `noise.js`. A
retry loop (and, failing that, a forced corridor) guarantees the Seed and every
Colony site are reachable, and only THEN - as the last step, on the final list of
walkable tiles - are the encounters placed (see "Encounter placement" below). The
seed for the run's RNG comes from `?seed=` (a number, or any string, hashed).

**Encounter placement** (`map.js placeEncounters`, config `encounters`; since
2026-09-26 - until then every eligible tile rolled independently, which gave seeds
with two fights in the first three rings or every cache in one corner). The
eligible tiles (walkable, supply-free, not the start / Seed / Colony sites, past
`minDistanceFromStart`) are split into the ring bands of
`config.battle.enemies.bands` (inner 1-3, middle 4-7, outer 8-11) and each band
is seeded on its own: it holds about `density` x its tiles worth of encounters;
each type takes its `weight`'s share of those (the table is
`encounters.types: { id: { weight, guaranteed } }`, a weight being a number or one
per band), rounded seeded-randomly so a rare type (the gate) still turns up;
`guaranteed` is the band's MINIMUM of the type (one number per band in band
order, a plain number meaning every band) and lifts the share before placing.
Within a band each type is spread EVENLY over the free tiles with `src/spread.js
evenSpread` - the Hack board's placer (random picks at the widest spacing that
fits, keeping their distance from the same type already down in earlier bands) -
rarest type first. `unique` types are capped at one per map. A VALIDATOR then
recounts every band and places more of any type still short of its minimum, on a
free tile or over the band's most plentiful type, and warns in the console when a
band is simply too small for its minima. `map.encounterReport` records, per band,
the tiles, the quotas, what was placed and what the validator added.
`npm run test:encounters` (`tools/encounter-distribution.mjs`) generates hundreds of seeds
and checks the minima, the uniqueness, the eligibility, the determinism and the
spread (no type with more than half its tiles in one sextant).

**Terrain and layers.** Five tile types (`ether`, `water`, `ground`, `hill`,
`mountain`) and six generated biomes (`grasslands`, `forest`, `mesa`, `desert`,
`dunes`, `tundra`), plus a seventh, `wither`, which is never placed at generation -
it is painted onto tiles at runtime by the Stasis. The worldflake has 7 layers,
numbered 0 (core) through 6; a run happens on one layer (`layers.startLayer: 3`) and
a layer today only reskins the biome palette (`color0..color6` per biome) - there is
no per-layer content yet beyond that tint. `layers.unlockOrder` is the meta order the
rare `gate` encounter unlocks, stored in `localStorage`.

**Fog of war.** Permanent - nothing ever un-reveals a tile. Moving reveals within
`run.revealRadius` (0 by default, so normally just the tile stood on) plus that
tile's own `revealBonus`; the run start and certain shop/event effects reveal a
fixed radius or a scripted set of tiles. **The reveal queue** (since 2026-09-26):
every reveal funnels through `Game.finishReveal`, and while the world map is off
screen (an arena, the start screen - `main.js` tells the game through
`holdReveals`, driven by the cinematic's `onWorldShown`) the tiles are chosen at
once (so the rules and the log counts stay deterministic; a queued tile no longer
counts as hidden, see `isHidden`) but only queued; when the world map is fully
back (a fly-out has landed) the queue is released in order and the tiles animate
in. So Information or Rumors bought in a shop's arena show themselves the moment
the party is back on the map, never behind the arena.

**Movement and supplies.** One step = one adjacent hex. Every step costs
`run.stepSupplyCost` (1) plus the tile type's own `supplyCost` (hill 2, mountain 5),
but the tile-type cost only applies when climbing to strictly higher ground; walking
level or downhill only pays the flat step cost. HP cost from a tile's `hpCost`
(wither: 1) applies on every step onto it. A step that would empty supplies is still
legal - **running out of supplies ends the run** (`game.js checkEndOfRun()`), unless
an encounter is still in flight (an unresolved fight, or an unclaimed supply pickup),
in which case the verdict waits until that resolves, since winning or collecting can
restock the party above zero.

**Party.** Three starting units, chosen from a twelve-character roster
(`config/entities.js`). Each roster entry defines `name`, `icon`, `hp` (doubles as
`maxHp`), `speed`, `flying`, exactly two `abilities` (each with its own upgrade
tree), and flavor `story`. Swappable before turn 0 from the start-screen roster grid.

**Encounters and forcing.** Generated types: `battle`, `event`, `shop`, `treasure`,
`acolyte`, `gate`, `hack`, plus `stasisSeed` on the Seed hex and `stasisColony` when
a Stasis line arrives; `rest` is a camp the player builds on an empty tile (cost 20),
not a generated type. `config.fatigue.enabled` is currently `false`; with it off,
`fatigue.forceable` (`battle`, `stasisSeed`, `stasisColony`, `event`) still defines
which encounter types can drag the party in on arrival, but the chance is a flat
100% rather than a rolled percentage - stepping onto a revealed tile holding one of
those types always forces entry. Everything else is opt-in via the Enter button.
Flipping `fatigue.enabled` back on restores the old rolled, rising chance of ambush;
it is a config toggle, not a removed mechanic. One special case: if the party enters
a `treasure` tile with supplies already at or below zero, the pickup is forced
immediately (`game.js onEnter()`) rather than left to the Enter button, since the
very next end-of-run check would otherwise erase the reward before the player could
act on it. A forced encounter shows a banner reading "Stumbled into a fight" (combat
types: `battle`, `stasisSeed`, `stasisColony`) or "Stumbled into something..." (tinted
blue, everything else forced). Combat itself always lets the player act first, forced
or not (see "The combat engine").

**The Stasis.** One Seed always spawns with the map. Four Colony sites are chosen at
generation and stay inert until a line grown from the Seed reaches them
(`advanceStasis()`, once per player turn, `lineSpeed` tiles/turn); on arrival the
site becomes a live `stasisColony` encounter with a rolled arena and a random debuff
(`maxHp`, `damage`, or `extraEnemies`, from `config.stasis.debuffs`). The Seed
(always) and every active Colony each accrue wither charge every turn
(`1 / witherEvery`) and spend whole charges converting the nearest untouched,
non-ether tile to the `wither` biome, wiping any encounter standing on it; there is
no range cap, so unopposed rot eventually reaches the whole map. Clearing a Colony
removes its debuff and grants `stasis.rewardPicks` (2) upgrade picks instead of the
usual one; an active Colony's debuff also stacks onto the Seed fight.

**Camera, HUD, Settings.** The world camera is a perspective-only, tilt/zoom-limited
orbit around the party with optional follow. The HUD shows the party panel, the
fatigue bar (hidden while fatigue is disabled), the event log, hover tooltips and the
legend. The Settings window (`settings.js`) is a live editor bound directly to the
shared `CONFIG` object, so edits reach the running game immediately; UI scale and log
visibility persist across sessions.

**Languages and audio.** `en.js` is the only wired-in language today (`ru.js` is
maintained on disk but not registered in `i18n.js`'s language list). All sound is
synthesized in-browser (`audio.js`, oscillator + envelope + filter, nothing loaded
from files); its only current use is the fatigue-bar step blips, so with fatigue
disabled by default the game is effectively silent.

**Start flow and seeds.** The game boots into a local "campfire" start screen on the
start tile, letting the player swap roster members before "Begin journey" flies the
camera out and the run begins (the splash screen ahead of it is skipped via
`?nostart` or `?scenario=`). `?scenario=<id>` boots straight into a hand-authored
tutorial map with a fixed seed instead of the generator (see "Scenarios").
`?orient=flat|pointy` overrides world hex orientation for comparison testing.

## The local map and interactive combat

**The arena.** Tile elevation runs `0..elevationLevels` (4 today) around a neutral
mid-level; `LocalMapView.paintTile` blends each tile's colour toward black below the
mid-level and toward white above it (a value ramp rather than a brightness multiply,
since multiply is invisible on near-black tiles). The arena's baseline height and
edge-tile colour both take a weak cue from the world tile that was entered. The
local camera is rotation-only (fov/tilt/distance, no pan/zoom). The dive-in
(`local/transition.js`) swaps the world scene for the arena scene partway through a
timed camera flight and carries the world camera's bearing into the arena.

**Aim locks.** With locked aiming on (`combat.lockedAim`, currently always true),
clicking a target does not fire immediately - it stores a lock (`ability id, anchor,
tiles, damage`) on the unit, and the unit STAYS selected (until 2026-09-26 the
selection jumped to the next unlocked unit; the player now picks the next one).
Any unit can walk freely during the player phase (its range measured from its
position at the start of the round) and hold one lock at a time; re-aiming replaces
the lock, walking clears it. A second walk animates from where the unit stands now,
not from its start tile (the price is still measured from the start). **End Turn**
fires every standing lock in party-panel order (the cards stand top to bottom in
firing order - no number badges since 2026-09-26 - and the order carries to the
next fight), one at a time with a short delay between casts (`combat.volleyStepMs`),
not simultaneously. **Reset party** (the engine's `resetParty`) takes every lock back
and puts every unit back on the tile it started the round on; nothing has been paid
or fired yet, so it is an exact undo (a trap a walk set off stays set off).

**The party panel in a fight** (`ui.js`). The party panel stands on the RIGHT
everywhere (world map, campfire, arena) and the Local Map Info panel (the fight's
title, effects and the enemy roster) on the LEFT.
In a fight the panel reads, top to bottom: Reset party, a separator, the unit
cards, a separator, End turn (End turn left the battle bar on 2026-09-26). A press
on a card is a DRAG by default - the card follows the pointer to a new place in
the firing order; only a release less than a tenth of the card's height from the
press counts as a click, which selects the unit as a click on its body in the
arena does (the engine's `selectUnit`, which also puts down an ability being
aimed). The selected unit's card has a green wash; a DISABLED unit's card - downed
or dead - is more transparent with a grey frame, on both panels. Health bars on
the cards (party panel, enemy roster, TAB party view) keep their side's colour
whatever the amount - party green, enemy red - as the overhead cards do.
Combat therefore reads as the units acting one after another, as they originally
did - except that the player lays the whole turn out first, sees its result, and
can rearrange it before committing.

**The overlap bonus is ordered.** A damaging ability gets `combat.stack
.bonusPerOverlap` (1) extra BASE damage on every hex that an earlier ability of the
same volley already hit, once per such ability: the first blow on a hex gets
nothing, the second +1, the third +2 (Gorm's headbutt then Viridi's glaive on one
tick: the headbutt plain, the glaive +1). The engine keeps a per-tile ledger while
the volley fires (`st.overlap`); only the party's own casts count. This replaced the
x2/x3 multipliers and, briefly, a flat +1 for every overlapping ability regardless of
order (both 2026-09-22).

**The forecast on the overhead cards, and ghosts.** Before firing, the engine plays
every standing lock plus the currently hovered aim out on a scratch copy of the
board, in firing order, and `previewState()` reports two boards: the one the
SELECTED unit will find (after the casts of the units before it in the order) and
the one the volley leaves. The arena shows both on the units' overhead cards
(`local.unitPlaques`, back on): each card hangs over the tile its unit will stand on
when the selected unit acts - with Viridi selected after Gorm, the tick his headbutt
shoves is already carded over its new tile, and Gorm's card is over his post-charge
tile - and reads the unit's hp now -> after the whole volley: the bar keeps its
card's frame colour throughout (party green, enemy red - no red-below-half switch)
and the part about to go is that colour, much darker (a heal's return, lighter). A
unit the volley kills simply reads "8 -> 0"; there are no damage billboards, no
"will die" marker and no greying. A walk does not disturb any of this - only the
volley itself (`sb.firing`) takes the forecast down. When a ghost, or a card, lands
on a tile another unit is still standing on (one that leaves or dies earlier in
the volley), it rides a storey higher (`PLAQUE.stackLift`), so bodies and cards
never sit in each other. Anything the play-out
actually relocates - a shove, a crash, a fall, a chain crush, a charge landing, a
corpse push - is drawn as a translucent ghost body at its destination with a line
back to origin (`previewMoves()`); VOID marks a drop over the edge, a burst a barrier
breaking. `previewTotals()` (the per-tile arithmetic: parts with their ordered bonus,
total, dealt, overkill, target) is still there for the tests and for
`rules.decoratePreview`, but nothing draws it.

**Aim outlines.** The highlighted tile outline for a locked or hovered ability shows
only the tiles actually in its damage zone. The tile a player aims *at* is not added
to the outline on its own - for a pattern whose shape does not cover its own anchor
tile, that anchor must not be drawn as if it were part of the hit zone
(`localview.js addAimOutlines`).

**Entities and units** (`local/battle/entity.js`, since 2026-09-24). An ENTITY is any
potentially interactive object on the board: a tile, a name, hp, and the hooks the
engine calls without knowing what the thing is - `blocks(mover)`, `pushable`,
`takeDamage(amt, ctx)`, `onDeath(ctx)`, `interact(unit, ctx)` (the last is the hook
for a door or a lever; the shop's keeper is what wires it to input) - plus `clone()`, how a
simulation copies it. The base answers plainly (blocks its tile, cannot be shoved,
damage comes off hp, does nothing when used); an object with rules of its own is a
subclass overriding what it needs, constructed by the encounter and handed to
`createBattle` as `entities`, and the engine keeps it in `sb.objects`, treating it
through the hooks alone: it blocks walking like a barrier, takes an ability's blow,
is shoved if pushable (crash, fall, crush, the void apply), dies, and shows in the
forecast (`previewState` covers objects; a moved one is a ghost). The `ctx` a hook
gets says which board the blow lands on (the real one or a simulation's copy), who
struck, and carries a token per cast (`cast`), so an object can count attacks.
A UNIT extends Entity with agency: the fighting stats (speed, flying, abilities,
initiative, intellect), the status bag and triggers, the aim lock and the turn's
bookkeeping. Its construction from a def and its simulation copy live in the
class; the rules that read those - statuses, walking, casting, the AI - stay in the
engine, since they lean on the config tables and the rest of the board. The Hack's
node and mine are the first Entity subclasses (the bottom of `entity.js`); a door, a
barrel that rolls when shoved and leaves fire when it bursts, an emitter that turns
when used are the kind of thing the class is for. None of it is config: the
bestiary describes creatures only. The shop's keeper (`Shopkeeper`, same file) is
the first entity that never fights: it stands on its tile and, used (clicked),
opens the shop window - see "The shop".

**Rules/tags plugin hooks.** `createBattle` accepts optional `rules` and `tags`
objects that let a caller extend the engine without forking it. `rules` may supply:
`attach(sb)` (once, before anything happens), `onBarrierHit(...)` (a real hit on a
barrier tag), `onHazardHit(...)` (a hazard tag under a fired ability's zone, hit or
not), `onTurnFired(sb, {fired})` (after a volley resolves), `checkEnd(sb)` (returns
`'win'|'lose'|falsy`; when present it fully replaces the last-side-standing check),
`decoratePreview(entry, sb)` (annotate a damage-preview entry), and
`debugResolve(sb, won)` (override the debug instant-win/loss helper). `entities`
is a list of Entity objects to stand on the board (see "Entities and units"). This
is generic engine surface, not hack-specific - the Hack encounter is simply its one
current consumer (see below).

**Enemy AI.** Each enemy scores every (ability, reachable tile, target) combination
by playing it out on a blinded simulation and summing weighted damage, kill bonuses,
status harm and a positioning term, then takes the best positive score or else walks
toward the party. Capability is gated by an intellect class (`config/entities.js
INTELLECT`, one of `C`/`B`/`A`/`S`, dumbest to smartest) that turns on progressively
more of: reading elevation, reading tags/hazards, valuing ether/void danger, and
weighing which ally is closest to death.

**Statuses.** A config-driven table (`config.statuses`), each row carrying
multipliers (`tickHP`, `speed`, `damageDealt`, `damageTaken`), agency effects
(`stunned`, `disarmed`), what it ignores (`crash`/`fall`/`crush`), a lifetime
(turns, charges, or "spent on" a trigger) and an `aiValue` the enemy AI reads.
Current rows: `shield`, `crit`, `stun`, `disarm`, `haste`, `slow`, `nerveAgent`,
`regen`, `weaken`, `vulnerable`, `enraged`, `collisionImmune`. An ability or upgrade
overrides a status's numbers via `statusEffectOverride` / `statusEffectAdd` rather
than a flat multiplier field, so a status applied without an explicit value always
falls back to the table's own default instead of landing as a no-op.

**Shared rules.** A shove into a void tile (an ether hole, or an edge the arena
marks as lethal) kills instantly. A shove into a wall, or across a height jump of 2
or more, crashes for flat impact damage; a shove into an occupied tile collides both
units; a large enough drop crushes and can chain into further pushes. Walls and
ether holes are both authored terrain, equally unwalkable - they differ only in what
happens when something is shoved into them.

**Damage notation.** `damage.js` parses a plain number (one hit) or `"BxT"` (T hits
of B each) into `{ base, times }`, and an upgrade's delta form (`"4"`, `"4x"`,
`"x4"`, `"4x4"`) into the base and/or hit-count it adds. Every damage-modifying
effect - elevation, statuses, the overlap bonus, a Stasis debuff - changes the base,
applied identically to every hit.

**Retreat.** From round 8 on, while the enemy side's total HP is below 30% of what
it started the fight with, each surviving enemy rolls a chance to flee toward the
nearest arena edge on its own turn instead of acting; a fled enemy is still a normal
target while it runs and grants no loot on escape. Stasis fights (Seed and Colony)
are exempt from this rule entirely.

**Ability zones.** An ability is defined by `castZone`/`castAny` (where it may be
aimed), `dmgZone` (damage/heal/status offsets from the aim point), `pushZone`,
`hZone`/`hMode` (terrain height changes), `tagZone`/`tagId` (tile tags it places),
`rotatable` (whether its zones turn to face the aim direction), and `moveToTarget`
(a caster dash, resolved last). Upgrade nodes extend these via `dmgZoneAdd` /
`castZoneAdd` / `tagZoneAdd` / `pushDistAdd` / `costAdd` / `statusEffectAdd` /
`add: { damage, heal }`.

**Deployment.** A fight the player walked into and chose to enter offers click-to-
deploy when the map allows it: the cursor carries the next unit's icon, left-click
places it, right-click undoes the last placement. A forced (ambush) fight skips this
and auto-scatters the party as a loose group instead. Either way, combat itself
always lets the player act first now - the engine used to give a forced fight an
extra enemy-only opening phase before round 1; it no longer does. A forced fight
still shows round 1 labelled "Ambush!" in the battle bar as a cosmetic note, cleared
at the end of that round.

**Down but not out (DBNO, since 2026-09-26; `combat.downed`).** A unit - party or
enemy - brought to 0 hp does not leave the arena: it is DOWNED (`Unit.downed`,
derived: 0 hp, not `fled`, not `gone`). It lies on its tile, its token tipped 90
degrees onto its side (`LocalMapView.setTokenDowned`), shows no overhead card, and
can do nothing. A downed body takes no damage and no status, but it CAN be shoved
like anyone (a collision hurts only the other party to it; over the edge it is
gone for good). It is an obstacle: walkers route around it (fliers may pass over,
not stop), a charge stops in front of it, a solid tag cannot be placed on it.
A heal landing on it REVIVES it (`sRevive`): the heal becomes its hp, its statuses
are cleared, and it acts from its side's next phase. The enemy AI values getting an
ally back up as much as putting a party member down. Only a shove into the void
takes a unit off the board for good (`gone`, the token vanishes) - that, and an
enemy running off. A side with nobody standing loses. A party member still downed
when a fight is WON gets up with `reviveFraction` (a quarter) of its max hp, rounded
up (`game.finishCombat`, from the `downed` list `main.js` reports); after a lost
fight they fall as before. A unit a cast puts down is a body by the time the
cast's shoves resolve, so it is shoved with the rest (this replaced the old
corpse push, where it only knocked into whatever stood behind it).

**Death handling.** A unit going down (or into the void) is recorded with its cause,
tile and round for a future loot system (`sb.deaths`, once per unit - a revived and
re-downed unit is not recorded twice), but nothing reads that record yet.

**Wiring.** `main.js` sets `game.combatDelegate`: if the camera is already in the
arena it starts the fight directly, otherwise it triggers the dive-in cinematic and
starts once the camera lands (or deployment finishes). The delegate resolves party
and enemy ability definitions, places units, and constructs `createBattle` with all
of the engine's callbacks bound to the arena view.

**Debug handles.** `window.__battle`, `__deaths`, `__renderer`, `__cinematic`,
`__localView`, `__partyView`, `__startScreen`, (in a hack) `__hack` and
`__hackView`, and (in a shop) `__shop` are exposed for manual and automated
inspection. Menu -> **Win encounter** / **Restart encounter** act on whatever
encounter the local map is running - a fight or a hack (a shop has nothing to win
or restart): the win is the engine's `debugResolve`, the restart rebuilds the same
fight (same tiles, same enemies) or the same hack board (same recipe) with the
party's HP back to what it was on entry.

### Handcrafted local maps - map codes (src/local/mapcode.js)

**Every fight plays on a handcrafted map** - there is no random arena generator and
no separate enemy-group table; a combat map is the whole fight, its terrain and its
enemies together. The authoring format is the MAP CODE: plain text, one line per
statement.

* **Format**: header lines `id:` (required), `title:` (optional, defaults to the id
  with dashes turned to spaces and capitalised), `radius:` (optional, 1-12, default
  from config); then tile lines `q,r: <type> [elevation] [tags...] [!Enemy Name | @npc]`.
  Types: `ground`, `wall` (blocks walking and flying, crashes a shove like the arena
  rim), `ether` (blocks walking, kills a shoved unit like a lethal void edge). Tags
  are ids from `COMBAT_TAGS` and are permanent scenery, unlike a cast's fire. `!`
  pins one bestiary enemy (by id or display name) to a `ground` tile; the pinned
  enemies are the fight's only enemies. `@` pins an NPC instead - a non-fighting
  entity the encounter builds (`@shopkeeper` on a shop map is where the keeper
  stands); one occupant per tile. Unlisted tiles stay plain ground at the
  neutral elevation. `parseMapCode` / `buildRecipe` validate everything and report
  readable per-line errors; a broken code is skipped with a console warning, never
  crashes a run.
* **Authoring rules**: a non-flying unit cannot cross a height gap greater than one
  level, so a plateau needs a graded ramp; flying creatures are exempt. Every pinned
  enemy and every free ground tile should be reachable, since a forced fight can
  drop the party on any walkable tile. Radius stays 4-7 in practice (the arena
  camera does not zoom).
* **Storage and count**: codes live as strings in `config.craftedMaps.combat.maps`
  and `config.craftedMaps.shop.maps` (`src/config/encounters.js`). 47 combat maps
  ship today plus one shop map (every shop tile rolls one of the shop maps at
  world generation - there is no rate; see "The shop"). `battleMaps` (wired onto `CONFIG.battle.maps`) is a
  table of fight kind (`inner`/`middle`/`outer`/`colonies`/`seed`) by worldflake
  layer; only layer 3 is populated (11/11/10/10/5 maps), every other layer falls
  back to the nearest filled layer of the same row.
* **Assignment**: `makeArena(rng, config, ring, pool, layer)` (`src/battle.js`)
  picks the row, resolves the layer fallback, and rolls one map id; a broken code
  falls through the rest of that cell rather than re-rolling. World generation rolls
  a battle tile's and the Seed's map at map-build time; a Colony rolls its map when
  it spawns; any fight conjured onto a bare tile rolls at that point too. A scripted
  scenario fight skips this and plays the recipe the scenario script gives, or flat
  ground if it authors none.
* **Engine support**: `createBattle` takes `wallKeys`, `etherKeys` (impassable to
  walking and flying; wall crashes a shove, ether kills one) and `startTags`
  (pre-placed permanent tile tags), all built from the recipe.
* **Preview tool**: Menu -> Preview map code pastes any code, validates it, and
  flies the camera into the built arena with its enemies standing as inert
  mannequins - no battle bound, no game state touched.

### The Hack terminal (config.hack)

**A second kind of encounter on the same arena.** It began (2026-09-15) as a
quarantined experiment in its own folder, `src/local/hack/`, to see whether
pattern-matching on the grid - no enemies, just static targets - could carry a play
mode by itself. It could, and on 2026-09-24 it became an ordinary part of the game:
the folder is gone and each piece lives where its kind of code lives, still in one
clearly marked section per file so the hack's logic stays apart from a fight's:
* `config/encounters.js` `hack` - every knob (board, rules, badges, discs); on the
  Settings window's Encounters tab like the rest.
* `local/localmap.js` "THE HACK BOARD" - `buildHackRecipe`, the board generator.
* `local/battle/entity.js` "THE HACK'S PIECES" - `HackNode`, `HackMine`.
* `local/battle/engine.js` "THE HACK'S RULES" - `createHackRules`.
* `local/localview.js` "THE HACK VIEW" - `createHackView` (the panel, the disc
  stacks); its styles under "the Hack terminal's panel" in `style.css`.
* `main.js` "the Hack terminal" - the bridge: `enterHack`, `hackDelegate`,
  `finishHack`, `abortHack`; `game.js` - `startHack` / `finishHack` and the `'hack'`
  case in `enter()`; `text.js` - the `turns` / `badgeN` placeholders.
* `locales/en.js` + `ru.js` - `visual.hack.*`, `log.hack.failed`, `hack.*` (the lore,
  the win / loss windows, the panel).
* `tools/hack-test.cjs` - the headless playtest.

**The idea.** The board holds static NODES and MINES - objects with rules of their
own (`HackNode` and `HackMine` in `battle/entity.js`, subclasses of the engine's
Entity, handed to `createBattle` as `entities`). Units aim their ordinary abilities
and End Turn fires the locks in order. A node takes exactly ONE damage from any
attack that lands on it, whatever the attack is worth - it remembers the cast its
last disc went to and ignores that cast's further blows; the overlap bonus and
multi-hit abilities are for creatures - so a node of 1-3 hp needs that many
attacks. The party has a turn budget of volleys; nodes cleared are graded into
BADGES, and the badge count sets how many upgrade choices the reward screen
offers. A node variant with rules of its own (one that bursts, one that heals its
neighbours, one that must be hit twice in a volley) is another subclass in the
folder, overriding what it needs; nothing in the engine or the config knows it.

**The board** (`buildHackRecipe` in `localmap.js`): a flat arena, radius `H.radius`
(7), no elevation wave; the party seated at the centre (`partyStart: 'centre'`,
within `partyRingMax`) or in a cluster on one side of the rim (`'edge'`), the first
ring around them kept free. `H.nodes` (16) nodes and `H.mines` (8) mines are spread
EVENLY over the rest: a blue-noise scatter - the pieces are thrown down at random
but at the widest spacing the board can fit that many at (the spacing steps down
until they all fit), with `nodeSpacing` (2, never adjacent) and `mineSpacing` (1)
as the floors it never goes below - so every board is different but no board has
heaps of nodes here and bare ground there. (Until 2026-09-24 the pieces went down
by one of twenty probabilistic layouts - clusters, rings, noise fields - which
read on the board as splotches; the layouts are gone. There are no handcrafted
hack boards; if some are wanted they are map codes and belong in
`config.craftedMaps`, next to the combat and shop maps.) Each node's hp is a seeded
roll in `H.nodeHp` ([1, 3]), part of the same stream as the rest of the board; the
bridge builds the pieces from the recipe's keys and rolls.
`tools/hack-layouts-sheet.mjs` draws ten seeded boards as an SVG contact sheet to
eyeball the spread. The placer is `src/spread.js evenSpread`, shared with the world
map's encounter placement.

**The turn** reuses the ordinary fight's aim-lock flow. Nodes and mines occupy
their tiles (they block walking; fliers glide over, as over a barrier). A node at 0
hp is cleared (its `onDeath` tells the rules). A blow on a mine costs the caster
`mineDamage` (3) hp, never below 1 (`mineLethal`), and spends the mine. The forecast
on the caster's own card shows the cost beforehand, since the hook runs on the
play-out's copy too.

**The turn budget and badges.** `turns` (5) volleys, or earlier once every node is
down. Three badge thresholds (`H.badges`, nodes cleared) each light up once reached;
the badges earned set how many upgrade options the regular post-battle reward screen
offers (one badge = no real choice, two = a choice of two, three = the usual choice
of three). Zero badges is a failure: the encounter is consumed with no reward and
the run continues. A hack, won or lost, always resets fatigue progress.

**Reaching it.** `hack` is an ordinary weighted encounter type at world generation,
entered like a battle (same dive, no deployment step - the layout seats the party)
but never forceable; it is entered only by choice.

**Architecture.** It runs as a rules plug-in on the shared `createBattle` engine, not
a separate engine: the nodes and mines are its objects (`entities`), and
`createHackRules` (engine.js) supplies `attach`, `nodeCleared` (wired to each
node's `onCleared`: a node down counts, a badge lights), `onTurnFired`, `checkEnd`,
`decoratePreview` (a mine's cost on a `previewTotals` entry - read by the tests,
drawn by nothing since the billboards went) and `debugResolve` (Menu -> Win
encounter). Menu -> Restart encounter rebuilds the same board from the recipe the
bridge kept (`hackEntry`), the party's HP back to what it was on entry. `createHackView`
(localview.js) layers a turn/badge panel and the PIECES onto the arena without
touching the LocalMapView (the arena draws nothing for an object): a node is a stack of bevelled discs,
one per hp, in its colour (`H.discs`); damage takes discs off the bottom and the
survivors settle down onto the tile; the discs the planned volley would take are
drawn dark (the engine's `previewState`, re-read whenever the arena's forecast
signature changes); the node's icon rides on the topmost disc, and a mine is its
icon on the tile. The bridge in `main.js` is the hack's twin of the combat bridge
(dive in, build the pieces and the engine with its rules, bind, finish, abort);
`game.js` builds the combat-shaped context and reuses `finishCombat`'s reward path
for a win. The engine and the config tables carry nothing hack-specific beyond
`config.hack` itself and the two sections named above: only the generic rules
hooks and the Entity base are used.

**Open items.** Balance (node counts, hp range, badge thresholds) is a first
guess pending play. The hex-upgrade progression this mode was built to explore -
upgrades installed into individual hexes of an ability, changing what happens when
two units' patterns overlap - is not built yet.

### The shop (config.shop, config.craftedMaps.shop)

**A local-map encounter with nothing to fight** (since 2026-09-24; until then the
shop was a dialog straight off the world map). Entering a shop tile dives into the
shop's handcrafted map - every shop tile is given one of `craftedMaps.shop.maps` at
world generation (`game.js assignShopMaps`, a seeded roll on a rng of its own; a
scenario's shop tiles roll one too unless authored with a recipe) - with the same
cloud dive a fight uses. No engine is built, no turn structure exists, and neither
the battle bar nor the hack panel shows: the party stands around (placed as a
group), and the KEEPER stands on the tile the map code pinned with `@shopkeeper`
(the middle if the map pins none). The keeper is a `Shopkeeper` entity
(`battle/entity.js`) - an Entity, not a Unit, since it never moves or acts;
`createShopView` (`localview.js`) draws it (a capsule in the shop's colour, its
icon plate above, a hover glow and a hand cursor) and registers its body as a
`pickable`, so a click on the body or on its tile reaches the keeper's
`interact()` hook, which opens the shop window. `config.shop.keeper` holds its icon
and colour; `shop.keeper.name` its name.

**The window** (`ui.chooseShop`, driven by `main.js showDialog('shop')`) is one big
card per option the shop stocks, in the upgrade chooser's card language: icon
(`config.shop.icons`), name, price, what it does. A sold-out option keeps its card,
struck through and faded; one that cannot be bought right now (too poor, nothing
it could do) is dimmed with the reason as its description. An option that needs
a window of its own - Training and the Relic open the upgrade chooser, Spare Parts
a unit pick - REPLACES the shop window until that one is done (a pick or a skip),
then the shop window is back; nothing flies the party out meanwhile
(`onDialogClosed` stands down while `shop` is set). Esc closes the window without
leaving; the keeper reopens it. **Leave** - the window's button, the floating
"Leave the shop" button over the arena, or Esc with no window open - flies the
party back to the world. The shop is not consumed by a visit; it is consumed when
sold out, as before. `Game`'s side is unchanged apart from the opening: `enter()`
on a shop rolls/marks the stock and emits `shop` (`{ hex, lore }`) instead of a
dialog; with no arena on screen (a headless run) the bridge opens the window
directly, as it always did. `tools/shop-test.cjs` is the headless playtest.

## Ability upgrades - how the party grows (src/upgrades.js + src/config/abilities.js)

Party units have no power stat; every reward unlocks one node of an ability's
UPGRADE TREE, and the ability itself gets stronger.

* **Trees** live in `config/abilities.js`, `ABILITY_UPGRADES[abilityId][nodeId]`. A
  node lists `requires` (all parents must be unlocked; multiple parents merge
  branches into a capstone; none = a root) and its effects: `add` (`damage`,
  `heal`), `costAdd`, `statusEffectAdd`, `castZoneAdd` / `dmgZoneAdd` / `tagZoneAdd`
  offset lists, `pushDistAdd`, and `flags` for upgrade-specific logic the engine can
  branch on. A node also carries its own `name`, `icon` and `desc` directly in the
  definition; `upgradeInfo()` looks up a locale override first (`upgrade.<ability>.
  <node>.name/.desc`, used by the Russian locale) and falls back to the definition.
  The same locale-first, definition-second rule applies to an ability's own `desc`
  and a character's `story`.
* **A node that only adds tiles the ability already covers does nothing**, silently:
  zone-add lists are deduplicated, so the node unlocks and shows as taken but
  changes no rule. `auditUpgrades()` runs in dev builds and warns in the console
  about any node that resolves to no change from its parent state - the only check
  against this class of bug, since nothing in the data declares a node is supposed
  to matter.
* **Resolution** (`src/upgrades.js`, pure functions): a unit carries
  `upgrades: ["ability:node", ...]`. `resolveAbility(id, unlocked)` folds the
  unlocked nodes over the base definition (order-independent);
  `resolvedAbilitiesFor(unit)` feeds the combat engine; `availableUpgrades(unit)` is
  the unlockable pool (every parent unlocked, not yet taken); `treeLayout(abilityId)`
  gives the UI its node columns and edges.
* **Rewards.** After a won battle the game drafts one random available upgrade per
  living unit (`game.upgradeOffers()`); a Stasis Colony clear grants `rewardPicks`
  (2) such choices instead of one, offers redrawn before each so newly opened
  children can appear. The same chooser serves the shop's Training and Relic options
  (pay, then pick); the wandering-scholar event unlocks one random available upgrade
  for free; the black market drafts two random upgrades for one chosen unit and the
  player picks which to learn (as cards), paying a fraction of that unit's max HP.
  The unit-pick step says how many lessons each unit has open; a unit whose trees
  have only ONE node left open (Feren after one glaive upgrade: `glaive` has two
  nodes and `plasmaBolt` no tree at all) gets one card and a line saying so - a
  content gap in the trees, not a fault of the market.
* **UI.** The roster's detail window (start screen) shows portrait and backstory in
  a narrow left column and the abilities stacked in a wide one, each with its
  description and upgrade tree. The tree is one card per node - icon, name, what it
  does - laid out by depth with requires-edges drawn behind them (a lit edge means
  the node it leads from is unlocked). States: owned (green), open (gold, every
  prerequisite met), locked (dimmed). The party panel shows two ability chips per
  unit (icon, name, "+n" unlocked count) in place of a power rating.

## Scenarios - hand-authored maps (the tutorial series, src/scenarios/)

The tutorial does not use the generator: it teaches through level geometry, so its
maps are authored by hand as SCENARIOS - plain data objects that fix everything the
world normally rolls. `Game` takes the scenario as a constructor argument; everything
downstream (renderer, HUD, combat) sees an ordinary, just small, map.

* **Format** (`scenario.js`): an explicit tile table, encounters with exact enemy
  groups or fixed stock/event ids, an optional fixed party and supplies, scripted
  `ambushes` (a forced fight at an exact step count on an empty tile - nothing is
  random in scenario mode), a `goal` (`{ type: 'reach', tile }` or `{ type: 'seed' }`),
  and an optional `configPatch` (per-run CONFIG overrides, applied and undone by
  `main.js`). A scripted Stasis works the same as a generated one once its Seed and
  `stasis.colonies` (with an authored arrival turn, debuff, title and garrison) are
  declared; a scenario without one simply has none. `buildScenarioMap` returns the
  same shape `generateMap` does, so nothing downstream needs to know the difference.
* **Entry**: `?scenario=<id>` (registry in `index.js`), fixed seed, no splash or
  roster screen. Reaching the goal ends the run as a scenario victory; a scenario's
  `next` field chains to the following map.
* **Hint cards**: a scenario lists `{ id, at, ... }` triggers - `start`, `arrive`
  (a tile, optionally holding resolution until dismissed), `encounter` (by
  encounter type), `combatStart`, and any other forwarded `Game` event name
  (`forced`, `wither`, `colony` are used today). Texts live at
  `scenario.<map>.card.<id>.title` / `.text` in the locales.
  In scenario mode the HUD stays fully visible; the card header shows the map's
  name, since the level itself teaches and the cards only point.
* **Progression** is stored in `localStorage` (`hexmap-tutorial-progress`); Menu ->
  Learn -> Tutorial opens the first unfinished map of the chain; a scenario win
  offers "Next map" when one exists.
* **Current maps**: **tutorial1 "The Road"** - a single corridor, one unavoidable
  fight, a cache, a waypoint; 4 cards. **tutorial2 "The Fork"** - a Y-shaped island
  (short steep route vs. long flat route with a shop), a scripted ambush at a fixed
  step regardless of route, ending in a guard fight on an authored plateau arena
  that teaches shoving; re-enables the fatigue mechanic locally via `configPatch`
  since its cards depend on the fatigue bar; 5 cards. **tutorial3 "The Withering"** -
  a small, fully revealed island compressing the whole Stasis system into view
  (a mini Seed, one scripted Colony, fast wither spread) with a `seed`-type goal;
  4 cards, last of the chain.
* **Arena recipes are live** in scenarios exactly as in generated play: a battle
  encounter's `recipe` shapes its arena and `spawns` pins units to authored tiles.

## The Virtual Playtester

**Not currently present.** `package.json` still lists `gym`, `gym:report`,
`campaign`, `campaign:report` and `test:engine` scripts, but none of the headless
harness, bots, gym, report generator, world runner, personas or campaign runner
work today (`tools/engine-test.mjs` is stale and fails). What does run headlessly:
`test:worldmap` (`tools/worldmap-test.mjs`, the world-map rules of 2026-09-22) and
`test:encounters` (`tools/encounter-distribution.mjs`, see "Encounter placement");
the browser playtests are `tools/smoke-test.cjs`, `tools/hack-test.cjs` and
`tools/shop-test.cjs`.

The one engine hook this kind of tooling depended on is still live and intact:
`createBattle({ instant: true })` (`local/battle/engine.js`) collapses every pacing
`setTimeout` into a synchronous call, so a whole phase resolves before control
returns; the interactive game itself never passes the flag. Rebuilding a headless
playtester needs, at minimum, a harness that builds a fight from `makeArena` /
the recipe format, an instant-mode engine loop, and a bot driving the public player
API - none of which exist right now.

One issue this kind of tooling used to catch is still true in code today:
`local/localview.js`'s `placeUnits` excludes only non-ground terrain and already-used
tiles when scattering a party or enemies - it has no reachability check - so a unit
can still be placed on a plateau the height graph makes unreachable, which can
soft-lock a fight.

## Open questions

1. Should fog ever re-cover tiles (line of sight), or stay permanent as it is today?
2. Supplies are both the movement-cost resource and the run's clock (running out
   ends it). Is that the pacing wanted, or should ending the run be decoupled from
   the camp-cost resource?
3. The old fatigue mechanic (a rising chance of ambush) is disabled in favor of
   forceable encounters always firing; the code for it is intact behind
   `config.fatigue.enabled` if the risk-based version is preferred instead. Whichever
   is kept, tutorial2 currently depends on fatigue being on and would need
   re-authoring if the flag stays off by default.
4. Should a cache the party is standing on be able to save a run that just ran out
   of supplies? Today it cannot - only a forced encounter's resolution holds the
   verdict - so it is possible to run out of supplies standing on an unclaimed cache.
5. Party HP never grows, only abilities do (through the upgrade trees). Is that the
   pacing wanted, or should HP/healing scale too?
6. Map variants: branching lanes, bigger fields, multiple Seeds?
7. There is currently no automated way to measure combat balance (see "The Virtual
   Playtester" above) - rebuilding that tooling, or finding another way to gather
   win-rate data, is open.

## Roadmap (suggested order)

1. Combat content: more abilities and unit kits, more handcrafted map codes (the
   format, walls/ether/tags/pinned enemies and the preview tool are all live - see
   "Handcrafted local maps"); more shop maps (one ships); still open: set dressing
   and lighting.
2. Rebuild some form of automated playtesting to re-balance the difficulty ladder
   against interactive combat, now that the old tooling is gone.
3. Path preview on hover (total cost to reach a tile).
4. Save/load a run in the browser (localStorage), so a refresh does not reset it.
5. Polish: tile textures, fog clouds, more sound (the audio system currently does
   almost nothing - see "Languages and audio").

## Conventions for working on this project

* One feature per request, with acceptance criteria in plain words.
* Numbers go into the config files, never hard-coded elsewhere.
* No em or en dashes in any text, plain hyphens only.
* The headless playtests that exist are `tools/hack-test.cjs` (the Hack terminal)
  and `tools/shop-test.cjs` (the shop and the menu's Win / Restart encounter
  buttons); both need Playwright and a `vite preview` on port 4173 (see each
  file's header). `tools/dbno-test.mjs` (`npm run test:dbno`, plain node) checks
  the engine's DBNO rules, Reset party, lock-keeps-selection and the walk path.
  (`tools/engine-test.mjs` currently stops early on a stale fixture, and
  `tools/smoke-test.cjs` is out of date - both predate this note.) There is no smoke test of the whole game (see "The Virtual
  Playtester") - verify a change by actually running the build and exercising the
  affected flow before delivery.
* Parallel work sessions happen: re-read this file (and re-sync the sources) at the
  start of every task, and update it when a rule or decision changes.
