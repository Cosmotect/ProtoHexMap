# DESIGN.md - the shared memory of this prototype

Read this first in every new work session (human or Claude). It records what the prototype
does, why, and what is still open. Keep it short and current; update it when a decision changes.

## Purpose

Simulate the **world map** of a larger game (Slay the Spire / Into the Breach spirit): the
layer where the player picks where to go next between battles. Battles themselves are
prototyped separately (HEX-BOX, https://hex-box.pages.dev). This prototype only needs to
**simulate the outcomes** of encounters, never the encounters themselves.

### Design guideline: the difficulty scale (2026-08-27)

> If we consider the entire range of combat difficulties in the game as a 0-100 rating,
> the regular combat encounters should occupy the space from 0 to 60, Stasis Colonies
> would rate between 50 and 70, and bosses would rate between 80 and 100.

Three separate pools implement it (`src/config/units.js`): `battle.enemies.bands`
(regular groups, scaled by ring), `battle.colonies` (Stasis Colonies) and
`battle.bosses` (the Stasis Seed only).

## Links

* Hosted playable build (Claude artifact, updatable in place by republishing with this URL):
  https://claude.ai/code/artifact/8ee75dfd-c11a-46fb-80f1-59686726facf
  (Publishing is paused until the owner asks for it. The older link c335531d-... is frozen.)
* Battle prototype by a colleague (separate project): https://hex-box.pages.dev
* Planned hosting for this project: Cloudflare Pages (see README section 5).

## Current rules

* Hexagon shaped field: a centre tile plus `radius` rings (`config/world.js`; 11 = 397 tiles).
  Start tile in the exact centre.
* **The Stasis** (`config/encounters.js`, section `stasis`): the win condition and the clock.
  * One **Stasis Seed** on a random tile with ring >= `seedMinRing` ('half' =
    floor(radius/2)). Destroying it wins the run. Its marker is a big cone; its tile is
    tinted `colors.seedTile`.
  * `colonyCount` (4) future **Stasis Colony** sites. Their ONLY placement rule is
    `minSpacing` (5) tiles from each other and from the Seed - they may sit right next
    to the start. After every player turn a line grows from the Seed towards each site by
    `lineSpeed` (0.5) tiles; when it reaches the site's centre the Colony encounter spawns
    there (half-size cone, `colors.colonyTile` tint). Spawning happens AFTER the player's
    arrival is fully resolved, so a Colony can never trap the player in the same instant
    they step on the tile. Each line is one straight 3D segment from the halfway point of
    the Seed cone's height to the site (it does not follow the terrain), and is drawn
    only over revealed tiles (fog hides the rest).
  * Each Colony rolls one random **debuff** at generation (duplicates allowed, they stack):
    `maxHp` (party max HP -25% for the fight), `power` (party power -6), `extraEnemies`
    (+2 regular enemies). While a Colony is active its debuff also applies to the Seed
    fight - with all four Colonies up, the Seed is fought under 4 stacked debuffs. Debuffs
    are temporary per fight; damage taken stays.
  * **Withering**: the Seed and every active Colony gain 1/`witherEvery` charge per
    turn; each whole charge repaints one unwithered tile on the rot's current front
    (the closest untouched land, one ring of slack for a ragged edge) with the
    **wither** BIOME (dark blue-purple, +1 HP per living unit to step onto, seen from
    1 further; never rolled at generation). The tile keeps its TYPE - shape and
    movement rules. There is NO range limit: left alone, the rot swallows all the
    land - it exists to force the player to confront the Stasis. Seed/Colony tiles
    are spared (they are the sources), and **ether is never withered** - the rot has
    nothing to grip in the void. A tile that withers loses its encounter (marker and
    all); withering water dries it into walkable ground.
  * Clearing a Colony lifts its debuff from the Seed and grants `rewardPicks` (2) power
    raises (chosen unit each, +`battle.victoryPower` per pick).
* **Terrain = tile TYPE + tile BIOME** (since 2026-08-24):
  * Types (`config.tileTypes`) carry all the gameplay numbers (passable, supplyCost,
    hpCost, revealBonus, terrainHeight, visual height): **ether** (a HOLE in the
    world - impassable for now, and the renderer draws NO mesh there: the camera
    looks straight down into the void, so ether holes are visible even under the
    fog; the hexes stay in the map data so later mechanics can navigate them),
    **water** (impassable), **ground**, **hill** (seen from 1 tile further) and
    **mountain** (walkable at 10 supplies + 5 HP, +2 reveal, seen from 2 further).
    A tile is revealed when its distance <= revealRadius + terrainHeight. You cannot
    step onto a tile you cannot afford. The guaranteed start-to-Seed route never
    uses mountains.
  * Biomes (`config.biomes`) are mostly colour: grasslands, forest, mesa, desert,
    dunes, tundra - plus **wither**, which worldgen never places (`generated:
    false`); the Stasis applies it during play. The final tile colour = the type
    colour LERPED towards the biome colour by `colors.biomeTintAmount` (never
    multiplied, so tints do not darken); types with `biomeTint: false` (ether,
    water) ignore the biome. A biome may override the lerp amount (`tintAmount`),
    reach even `biomeTint: false` types (`tintAllTypes`) and ADD `hpCost` /
    `terrainHeight` on top of the type's numbers - the wither uses all of these.
* **Generation** (`map.js` + `noise.js`, seeded): three independent multi-octave
  Perlin fields, each rank-normalised across the map so the level knobs read as
  shares of the map. Elevation places water (bottom `noise.waterLevel`), ground,
  hill (above `hillLevel`) and mountain (above `mountainLevel`); a second field
  pokes ether holes (top slice above `etherLevel`); a third cuts its range into
  equal bands, one per biome. `frequency` per field is the main dial (exposed in
  Settings > World): higher = smaller, busier features.
* Generation retries until the Seed and every Colony site are reachable from the start; if
  one never is, a corridor is carved. The first ring around the start is always walkable.
* **Fog of war**: tiles start hidden. Moving reveals every tile within `revealRadius` (0)
  plus each tile's `terrainHeight`, permanently. The Seed hides under the fog like every
  other tile (`run.seedAlwaysVisible: false`).
* **Movement**: one step per turn to a neighbouring walkable tile. Ordinary steps cost
  nothing; mountains cost supplies and HP; withered land costs HP. A step whose HP cost would
  disable at least one living unit opens an "are you sure" confirm box first.
* **Party**: three units (`config.party.units`), each with HP and **power**, shown in the
  left panel (segmented HP bars, one segment per `hpSegment` HP). On the map they move as
  one token. A unit at 0 HP is *disabled*: greyed out, skipped in battles, until an Acolyte
  restores it. All three disabled = run lost.
* **Supplies are the currency** (`startSupplies` 60, also the maximum: gains are capped).
* **Encounters are opt-in**: standing on an encounter tile enables the **Enter** button in
  the bottom bar (key E). On an *empty* tile the same button reads "Make camp": spends
  `rest.cost` (20) supplies, heals each living unit by `rest.healFraction` (50%) of max HP,
  resets fatigue. The marker on the party's tile floats up so the token does not cut it.
* **Encounter windows** have no close button: the player always picks one of the options.
  Clicking the world while a window is open flashes it. Unit choosers have a Skip button.
  A choice that leaves a reward behind (skipping a chooser, collecting a partial find when
  a camp would save more, declining the black market) asks for confirmation first.
* **Run over / complete** can be dismissed with "Inspect the map" to look at the final
  board; restart or a new map are in the menu.
* **Encounter logic** (`game.js enter()`):
  * *Battle / Stasis Seed / Stasis Colony*: automatic simulation (`battle.js`). Player
    strikes first unless the battle was forced by fatigue. Each unit hits a random living
    enemy; damage = a roll in [`damageMin`, `damageMax`] (2-8, triangular: the average of
    `bellDice` (2) uniform rolls) times
    `powerBase` ^ ((attacker power - defender power) / `powerStep`) - i.e. 1.15x per 3 points
    of power difference, continuous (only the final damage is rounded).
    **All power numbers live on a x3 scale** (party units start at 3, a victory or a shop
    upgrade grants 3, the black market 6, a Colony debuff removes 6).
    Regular enemy groups are described by RING BANDS (`battle.enemies.bands`): each band
    gives a count range and a range for the group's TOTAL power, which is rolled and then
    split as evenly as possible between its units. Current bands: rings 1-3 = 1-3 enemies
    worth 3-6 power total, rings 4-7 = 2-5 enemies worth 24-30, rings 8-11 = 4-8 enemies
    worth 50-60. HP stays `hpMin..hpMax` per enemy. The Stasis Seed rolls one of the
    `battle.bosses` variants (power 12-21); a Stasis Colony rolls its own separate pool,
    `battle.colonies` - added 2026-08-27 because the bosses were too strong for Colony
    fights. Both Stasis pools mix a few heavy hitters with a screen of chaff, or field one
    large equal-power choir; a unit's own `power` overrides the variant's `power`, which
    the chaff uses. Measured on 600 simulated fights per data point, the party power per
    unit at which a full-HP party wins half the time is 16 for an outer-ring regular
    group, 18 for a Colony and 31 for the Seed - the ladder the 0-100 guideline asks for.
    Enemy groups are rolled when the map is generated / when the Colony spawns
    (`hex.enemies`), so a revealed fight shows its danger up front, as red chevrons above
    the marker (`config.battle.danger`, since 2026-08-28):
    `base` (1.2) ^ ((total enemy power - total living party power) / `powerStep` (3))
    * (enemy count / living party count), rounded. Equal power on both sides and equal
    numbers = 1 chevron; being outnumbered pushes it up even at equal power, which is what
    the fight simulation actually punishes. `maxChevrons` (8) caps the DRAWING only, not
    the maths. On Stasis tiles the active debuffs are counted in where they move power or
    numbers. Player units deal extra damage the lower their HP
    (`battle.desperation`). Enemies pick their targets weighted towards the healthiest
    party units (`battle.healthyTargetBias`, HP-fraction exponent; it simulates the
    player shielding the wounded and is deliberately not surfaced in the UI). A report
    dialog shows every blow (plus the Stasis debuffs that applied) as structured lines
    rendered through the locale tables; after a win the player picks a unit that gains
    `battle.victoryPower` (3) - twice (`stasis.rewardPicks`) after a Colony. Destroying
    the Seed wins the run.
  * *Treasure*: +`treasure.supplies` (40). Does not reset fatigue. Supplies found in the
    field (Treasure, Fortunate find) open a dialog; if they would overflow the maximum and
    the tile is empty, it offers "make camp first, then collect" so more of the find fits.
  * *Event*: one of the entries in `events.js` (text + effect), numbers in `config.events`:
    Signpost (reveals nearest hidden shop), Friendly pilgrim (reveals an irregular patch of
    `blobSize` hidden tiles), Rumours (reveals up to 3 hidden battles within 3, or the nearest
    hidden ones anywhere when none are in range), Vantage point
    (reveals radius 2 plus all mountains within 5), Fortunate find (+10..20 supplies),
    Wandering scholar (+`events.scholarPower` (3) power to one random living unit), Forge procession
    (reveals nearest hidden Acolyte), Black market (choose a unit: -1/3 max HP, +6 power, or decline),
    Nomads (a battle, same rules as a battle encounter), The merchant's caravan (acts as
    a rest site: heals and resets fatigue), Learned about the world (lore text only, weight 2). Does not reset fatigue (except Nomads, which is a battle).
    Black market trades 1/3 max HP for +`events.blackMarketPower` (6) power.
  * **Flavour lines**: battle victories, treasure, the shop, the Acolyte and camps each
    draw one lore line from their pool (`flavour.<kind>.<n>` in the locale table,
    pool sizes in `game.js FLAVOUR_POOL`), shown in the window (camps: in the log).
  * *Shop*: opens a dialog. Rest = `shop.restCost` (15) resets fatigue; Upgrade =
    `shop.upgradeCost` (25), +`shop.upgradeAmount` (3) power on a chosen unit; Local map = `shop.mapCost` (15)
    reveals a patch of `events.blobSize` tiles. The shop stays on the tile and entering it
    does not reset fatigue.
  * *Acolyte of the Great Forge*: restores one chosen fallen unit to `acolyte.reviveFraction`
    (50%) HP. At least `encounters.guaranteed.acolyte` (1) per map, plus a rare random roll.
    If nobody has fallen the Acolyte is not consumed.
  * A generic "choose a unit" dialog (`ui.chooseUnit`) is shared by the shop and the Acolyte.
* **Fatigue** (`config.fatigue.byStep`): a step counter since the last encounter maps to a
  chance in %. Arriving on a tile that has an encounter rolls that chance; on a fail the
  party is forced into the encounter. Which types can be forced (`fatigue.forceable`) and
  what engaging each type does to fatigue (`fatigue.resetOn`: always / optional / never,
  with `resetNotes` for the optional ones) are config. The roll on arrival uses the
  fatigue shown in the HUD at the moment you click; the step then raises it. The hover
  popup shows that chance (only for tiles that can force something), the fatigue after
  the step, and the encounter's reset rule. A forced encounter shows a centre banner
  first and opens its UI `anim.forcedBannerMs` later.
  Table entries are interpolated linearly, steps outside the table are clamped.
  Default: steps 1-4 free, step 5 = 5%, rising to 100% at step 24. When fatigue > 0,
  hovering a reachable tile shows a popup with the chance after that step.
* **Fatigue bar** (`ui.js`, `config.fatigueBar`, top centre): one box per step of
  `fatigue.byStep`, from step 1 to the last entry in the table, each labelled with the
  percentage that step brings. A box is faint until the party has taken that step and
  solid afterwards, so the row reads left to right like a fuse. 0% boxes are green; the
  rest run from yellow to red across the range of non-zero percentages present, so
  re-tuning the table re-colours the bar by itself. The box that just filled shakes once
  and then breathes in a slow sine until the next step replaces it. A reset empties the
  row right to left. Sounds come from `audio.js`.
* **Event log** (bottom left): a design / debugging aid, so it is **off by default**.
  Settings > General ("Show event log", next to the UI scale) turns it on; like the UI
  scale it is a browser preference in localStorage, not a config value, and the guided
  run neither hides nor reveals it.
* **Backgrounds** (`config.worldBackground`, `config.localBackground`, both on the World
  settings tab): the colour behind the map, whether distance fog is on and where it
  starts and ends, and the colour of the void floor far below. The two maps are tuned
  separately - a wide vista and a single tile blown up to arena size want different
  numbers. World changes apply live (`renderer.applyBackground`); local ones apply the
  next time an arena is built.
* **Sound** (`audio.js`): no audio files - every blip is synthesised with the Web Audio
  API. The voice is deliberately muted: a sine oscillator, a slow 26 ms attack (a fast
  one is what makes a tone read as a "pluck"), a short hold, a long soft decay, and a
  low-pass at 1.7x the pitch that closes further as the note fades, the way a damped
  sound really behaves. Each fatigue box sounds a step higher than the one before it; a
  reset walks the ladder back down, lower and quieter. Pitch and volume get a small
  random jitter on every play, so a sound heard thousands of times never repeats
  exactly. All of that lives in one `VOICE` block at the top of the file - it is
  voicing, not tuning, so it is NOT in the settings window: `config.audio` holds only
  `volume`, on its own **Audio** tab. Browsers forbid audio before a user gesture, so
  the AudioContext is created on the first click and the game is silent until then.
* **HUD**: one top-centre bar holding supplies, the **fatigue scale** (see below) and the
  turn, separated by hairlines; a bottom-centre status bar that is now just the Enter
  button; the party panel on the left middle, the legend bottom right
  (collapsed; expands on hover, each entry expands on click with its `info` text from the
  config), and a top-right **Menu** (seed, load, copy link, new map, restart, reveal map,
  settings, new player experience; key M). The world blurs while the menu or the settings
  window is open.
* **Languages** (`i18n.js`, `locales/en.js`): every user-facing string is a key in a flat
  per-language table. English is the only language for now (the Russian table was removed
  on 2026-08-23); the scaffolding stays, so adding a language = one new locale file plus
  a LANGUAGES/TABLES/plural-rule entry in i18n.js. Placeholders `{x}`, plural forms `{n:one|other}`.
  Code calls `t(key, params)`; unit and enemy names go through `tn(name)`; static HTML uses
  `data-i18n` attributes; the log stores language-neutral entries and is re-rendered on a
  switch. Event stories and lore live in the tables too (`event.<id>.*`, `lore.<id>.*`).
  The toggle is on the General tab of Settings and is saved in the browser. English is the
  reference table: a key missing in another language falls back to English, a key missing
  everywhere shows as the key itself.
* **Settings window** (`settings.js`): every value of the config files, on tabs named after
  them (World, Encounters, Units, General, Audio; the language, the UI scale and the event
  log switch live on General). The window spans the screen and lays groups out in up to
  five columns; a tab holding a TABLE (tile types, biomes) switches to a grid instead, so
  the table can take two or three tracks and still sit beside the ordinary groups rather
  than on its own row underneath them. The
  form is generated from the shape of the config, changes are written into CONFIG at once,
  saved in the browser (localStorage `hexmap-settings-v1`) and re-applied on load, so they
  take precedence over the files. Every row has a reset button (file value), every tab a
  "Reset tab". Map, terrain and starting-party values apply on the next map / run. The hover popup appears on every
  tile: step count since the last fatigue reset, forced chance (when the tile can force),
  fatigue after the step, and the tile's encounter reset rule.
* **New player experience** (`tutorial.js`, seed `NPE_SEED` = 6, also `?npe=1`): a guided
  run on a fixed map. The HUD starts empty; cards explain movement (step 1), the party
  (step 2, panel appears), fatigue (step 3, the fatigue bar and the status bar appear), the first encounter tile,
  each encounter type on first entry (log appears), battle reports (legend appears), forced
  encounters, camps, and the first step onto costly terrain (a mountain): that card asks
  "Climb / Stay here" before the move happens, pointing at the tile's top; the first cleared
  Stasis Colony ends the guide and reveals everything, and the run continues normally. Cards sit at 25% of the screen width and height with a green
  dashed line to what they talk about: a HUD element (green outline), the top of a tile
  (green hex ring), or an encounter's 3D shape (a flat green copy of the shape drawn
  slightly larger behind it). Targets flash together with the card. A final card appears
  when the whole party is disabled. While a card is open, or a HUD piece is still gliding
  from the screen centre to its place (1.5 s: eased movement, linear shrink from 2x), all
  input is blocked except the menu, which is never hidden; clicking elsewhere flashes the
  card. Arriving on an encounter tile for the first time holds everything the tile would
  do (the fatigue roll, a forced fight) until the encounter card is acknowledged
  (`game.moveTo` emits `arrive`, the guide sets `hold`, then calls `resumeArrival`). Every number in the cards and in the legend is generated from the config at
  runtime (`text.js`: placeholders in the `info` strings, terrain sentences built from the
  terrain numbers). "Skip guide" reveals everything at once.
  NOTE: the fixed map depends on the world/encounter config; changing those may change
  what the NPE map looks like near the start.
* **Win**: destroy the Stasis Seed. **Lose**: whole party fallen, or boxed in
  (rare; the first ring is always open and withering never makes land impassable).
* **Encounters**: ~33% of walkable tiles (not adjacent to the start) get a type by weight:
  battle 5, event 2, shop 1, treasure 0.8, acolyte 0.15. Stepping on one only writes a log line.
* **Seeds**: `?seed=1234` in the URL, the HUD, and the "Copy link" button. Same seed, same map.
* **Camera**: perspective only (tilt 52 degrees, fov 42), following the player with a glide
  (`camera.followPlayer`). Map-style controls: left-drag pan, right-drag orbit, wheel zoom,
  arrow keys pan. The top-down orthographic mode was removed on 2026-08-29 - it doubled
  every camera rule (its own projection, zoom limits, tilt range, no distance fog) for a
  view the prototype was never designed around.
* **The LOCAL map** (`src/local/`, since 2026-08-27): combat encounters (battle, Stasis
  Seed, Stasis Colony) play out on a separate arena grid instead of a bare window.
  * The local grid is a hex map of `local.radius` (6) rings using the OPPOSITE hex
    orientation to the world map (world flat-top by default -> local pointy-top), so one
    world tile visually breaks into a sub-grid of local tiles. Local tiles are shades of
    the world tile's final colour. Local tiles have NO gameplay logic yet.
  * **The dive**: pressing Enter on a combat tile (or being forced in by fatigue) flies
    the camera into that tile: FOV stretches, the screen shakes, cloud layers rush past,
    a blur + white flash peak mid-flight - and at that peak (`local.swapPoint`) the world
    scene is swapped for the local scene. The flight is wall-clock timed
    (`local.flyInMs` 1500 / `flyOutMs` 1300). When the camera lands, the INTERACTIVE
    combat takes over (below); the results window opens over the arena when it ends.
    Closing it flies the camera back out and restores the world camera exactly.
  * **Arena camera**: rotation only - no panning, no zooming (`local.camera`).
* **INTERACTIVE COMBAT** (`src/local/battle/`, since 2026-08-28): fights are PLAYED on
  the local map, ported from the hex-box combat prototype (its battle core only - no
  editors, no storage, no 2D renderer, no auto-simulation UI).
  * **Files**: `bhex.js` (combat hex math: "q,r" string keys, 60-degree zone rotation),
    `engine.js` (the whole rules core: effect resolver, statuses, pushes/falls/crushes,
    terrain tags, turn flow, outcome-scoring enemy AI - pure state, no DOM/Three.js;
    all output goes through callbacks: onChange / onFloater / onLog / onAnim / onEnd),
    and the config slice `src/config/abilities.js` (COMBAT_CONFIG.combat rules, the
    ABILITIES / COMBAT_TAGS tables, UNIT_COMBAT per-name stats with a `default`
    fallback; deliberately NOT in the settings window).
  * **Rules kept from hex-box**: players activate their units in any order; moving is
    once per activation, casting ends the activation; enemies act by initiative;
    uphill steps cost 2 movement, flyers glide; high ground +1 damage, low ground -1
    (2+ levels); shield blocks one hit or push; stun skips the turn; pushes crash into
    walls (2 dmg), fall 2+ levels (2 dmg + stun), crush whoever they land on.
  * **Everlands additions**: a unit's world-map POWER adds ability damage
    (`round(power / powerPerDamage)`, powerPerDamage 3), and a fatigue-FORCED fight
    opens with an AMBUSH: one extra enemy phase before round 1 (no tag ticks, no round
    counter - the world-map "enemies strike first" rule made playable).
  * **Arena heights**: `applyElevationWave` in localmap.js rolls three seeded sine
    waves into whole levels 0..`elevationLevels` (3); `local.elevationStep` (0.35) is
    the visual height per level. The camp layout stays flat.
  * **Wiring** (the only three touch points): `game.startCombat` calls
    `prepareCombat` (enemies + Stasis debuffs applied to the party, context out),
    then hands the context to `game.combatDelegate` (installed by main.js) - or, with
    no delegate, falls back to the old `simulateBattle` auto-resolve (resolveBattle
    still exists for headless tests). main.js builds the engine over the arena
    (localview `beginBattle` places both sides and reports tiles + heights,
    `bindBattle` maps engine uids to tokens and routes tile clicks), the battle bar
    (`#battle-bar`, src/ui.js `setBattleMode`/`updateBattle`: active unit, ability
    buttons, End turn, E key) replaces the status bar for the duration, and when the
    engine reports the end, main writes the survivors' HP back into the party and
    calls `game.finishCombat` (debuffs lifted, deaths, rewards, dialogs, end states -
    the same tail the simulation used). `window.__battle` exposes the engine to tests;
    `debugResolve(won)` decides a fight instantly.
  * **Balance is RAW**: ability numbers in abilities.js are first guesses; the P50
    difficulty scale was tuned for the simulation and needs re-measuring against
    interactive play (a bot that plays like a human is a separate future project).
  * **Recipes (planned)**: encounters will get handcrafted arena recipes assigned at
    spawn (tile types, elevations, set dressing, lighting). The hook exists now:
    `applyRecipe` in `src/local/localmap.js` runs during the fly-in, right before the
    scene swap; `startCombatDive` in main.js already forwards `hex.recipe`.
  * **Sandboxing**: the local system lives in `src/local/` (localmap.js data,
    localview.js scene, transition.js flight) and touches the world only through one
    hook, `MapRenderer.overrideFrame`, plus `Game.combatIntro` (installed by main.js so
    forced fights take the same dive). Nothing in `src/local/` reads or writes game
    rules or world meshes.
* **The START FLOW** (since 2026-08-28): the game boots into a fullscreen black splash
  with "Everlands" across it (`config.start.splashMs` 2000, then a fade) that masks the
  load; behind it the game loads STRAIGHT into the local map of the starting tile - the
  "start screen": the party sits on tiles around a flickering campfire. Clicking a party
  unit (its 3D token, or its row in the party panel) opens the **roster**: a
  fighting-game style grid of portraits (icon, name, HP, power), five to a row, built
  from `config.party.roster` (10 characters; current members are greyed out with an "in
  party" tag). The roster is the ONLY place a character's numbers are written: the run
  opens with its first `party.size` (3) entries, so there is no second list to keep in
  sync and the Units settings tab has no per-unit rows.
  The start shot is composed, not explored (`config.local.startCamera`): the camera sits
  close to the fire, spun 30 degrees so a tile - not the seam between two - is dead
  centre behind the flame, which is what lets the party sit as one row of three across
  the far side. Its controls are locked, and that exact pose is what the fly-out to the
  world map starts from, so "Begin journey" lifts off from the shot the player was
  looking at. Clicking an entry swaps that party slot (`game.setPartyUnit`, only at
  turn 0) and reseats the tokens. "Begin journey" sits exactly where the Enter button
  lives on the world map; pressing it plays the same zoom-out-through-the-clouds
  flight, and the run officially begins. `?nostart=1` (tests) and `?npe=1` skip the
  ceremony.

## How the code is split (so changes land in the right file)

`game.js` owns truth (state, rules) and emits events: `reveal`, `move`, `encounter`,
`change`, `log`, `end`, plus the Stasis events `colony` (a Colony spawned), `wither`
(tiles the Stasis withered) and `stasis` (lines advanced; the renderer rebuilds them).
`render.js` and `ui.js` only listen and draw. Nothing in the renderer
may change game state. This separation is what will let us simulate encounter outcomes
with plain data later, and even run the rules without a screen for balancing.

Data shapes:

```
unit   = { name, icon, hp, maxHp, power, alive }
hex    = { q, r, ring, key, type, biome, passable, supplyCost, encounter, isStart, isSeed,
           isColony, revealed, visited, x, y }
state  = { status, party, supplies, maxSupplies, turn, position, shortestPathLength,
           fatigueSteps, fatigue, coloniesCleared, endReason }
stasis = { seed, colonies: [{ hex, distance, progress, active, cleared, debuff }], witherCharge }
```

## Where encounter outcomes will plug in

`Game.onEnter(hex)` is the single hook. Plan: each encounter type gets a small "outcome
table" in config (e.g. battle: win 70% -> supplies +15, HP -10; loss 30% -> HP -30), a panel in
the UI that shows the possible outcomes, and a way to **pick** or **roll** the result.
Outcome choice per type is an open question (see below); the hook does not care.

## Decisions log

* 2026-08-29 The orthographic / top-down camera was deleted (config keys, the projection
  branch in setupCamera, the C shortcut, the Settings toggle, the ?camera=ortho switch and
  the cinematic's save-and-restore special case). It was a second set of every camera rule
  serving a view nobody designs against.
  The climb out of a local map now starts from the pose the player ACTUALLY left the camera
  in, not from `finalCameraPose()`: rotating the arena and then leaving used to snap the
  shot back before lifting off.
  Tile types and biomes went back to being tables. The earlier fix for "they hog the full
  width" had turned them into ordinary groups, which put an attribute name on every row of
  every entry. The real problem was the layout engine: CSS multi-column can only span an
  item across ALL columns or none, so tabs with a table now use a grid, where one section
  can be three tracks wide and the rest stay one.
* 2026-08-28 (c) **Interactive combat**: the hex-box combat core moved in
  (`src/local/battle/bhex.js` + `engine.js`, config in `src/config/abilities.js`) and
  fights are now PLAYED on the local map instead of simulated - free player activation
  order, move + cast per activation, enemy phases by initiative, heights/pushes/tags,
  the outcome-scoring enemy AI. Only the battle core came over: no editors, no
  saves/undo, no 2D renderer, and the auto-simulation stayed behind as agreed (a
  human-like bot is a separate future project; `battle.js` remains for enemy
  generation and as the no-delegate fallback via `resolveBattle`). Everlands grafts:
  world-map power adds ability damage (power/3), forced fights open with an ambush
  enemy phase, arenas get a seeded elevation wave (flat for the campfire). The split
  is `game.prepareCombat` -> `combatDelegate` (main.js runs the engine on the arena)
  -> `game.finishCombat`; the world map never learns how the fight went, only the
  outcome. Ability/unit combat stats are hand-authored config, deliberately outside
  the settings window for now. BALANCE IS RAW - numbers are first guesses and the
  P50 scale needs re-measuring against real play.
* 2026-08-28 Second UI pass. Supplies and the turn moved INTO the top bar on either side
  of the fatigue scale (hairline separators between them), leaving the bottom bar as one
  button - one place to read the run's state instead of two. The event log went off by
  default with a switch in Settings > General: it is a design tool, not something a
  player needs on screen. Audio settings collapsed to a single volume on their own tab
  and the blip was revoiced to something muted (slow attack, heavy low-pass) - the rest
  of the synth is a voicing decision and belongs in the code, not in a tuning window.
  Party units carry a billboard portrait above their heads on the local map, because
  three identical capsules told the player nothing. The start-screen camera became its
  own locked, composed shot (and the pose the fly-out departs from). Backgrounds split
  into worldBackground / localBackground. Tile types and biomes stopped being
  full-width tables so they flow in the same columns as every other settings section.
  `party.units` deleted: the roster is now the single source of a character's numbers.
* 2026-08-28 (b) **The start flow**: black Everlands splash masking the load, boot
  straight into the campfire start screen on the local map of the start tile, a
  fighting-game roster grid (7 new selectable characters: Warden, Stonestep,
  Emberwright, Lampbearer, Skywatcher, Tinker, Duskblade) and "Begin journey" in the
  Enter button's slot, leaving through the usual zoom-out. Roster swaps only exist at
  turn 0.
* 2026-08-27 (c) **The local map**: combat now dives into an arena grid (`src/local/`,
  radius 6, opposite hex orientation) through a cloud cinematic with a mid-flight scene
  swap; results window over the arena; camera flies back out on Continue. World map
  orientation default flipped to FLAT-top so its tiles visually split into pointy-top
  local grids (`?orient=pointy` compares). Arena camera: rotation only. Recipe hook
  prepared for future handcrafted arenas. (This entry was restored on 2026-08-28: a
  parallel session had based its DESIGN.md edit on an older copy and dropped it.)
* 2026-08-28 Fatigue moved out of the status bar into its own **fatigue bar** at the top
  centre: a row of boxes, one per step, that fills as the party walks and empties on a
  reset. Reason: a single "18%" number told the player nothing about how close the next
  step was to the cliff; a row of boxes shows the whole ramp at a glance and turns the
  decision "one more step or camp now" into something you read without hovering.
  Gold was removed from the game entirely (state, config, HUD, texts) - supplies had
  become the only currency long ago and the second counter was dead weight.
  Sound arrived with it (`audio.js`): synthesised rather than sampled, so pitch and
  volume can be jittered per play and the blip survives thousands of repetitions.
  Floating windows moved from `top: 72px` to `--window-top` (44%) so nothing sits under
  the new bar.
* 2026-08-21 Three.js + plain JavaScript + Vite chosen over Godot web export: instant load,
  small build, simple hosting on Cloudflare Pages, and Claude can build/test/screenshot it
  fully inside its own session.
* 2026-08-21 Pointy-top hexes by default; flat-top available behind `?orient=flat` for comparison.
* 2026-08-21 Goal tile always visible, fog radius 1, permanent reveal (roguelike run feel).
* 2026-08-21 Encounter outcome simulation postponed until the encounter list is firmer.
* 2026-08-23 Bosses replaced by **the Stasis**: one Seed (the win condition) plus 4
  Colonies that spawn when the growing lines reach their sites; Colonies carry stackable
  debuffs that also afflict the Seed fight; both wither the land around them (new wither
  terrain, 1 HP per step, never generated). "Every 1.5 turns" is implemented as a charge
  accumulator (1/1.5 per turn, spend whole charges); debuff duplicates stack; lines are
  drawn only over revealed tiles.
* 2026-08-23 Russian localization removed (English only for now); the i18n scaffolding
  stays so adding a language is one locale file + one entry in i18n.js.
* 2026-08-23 Wither spread uncapped (front-based growth until the whole map rots) and it
  now consumes encounters; Colony placement freed (only the 5-tile spacing rule); stasis
  lines straightened (3D segment from the Seed cone's mid-height); deadly climbs ask for
  confirmation; enemies weight attacks towards healthier units (hidden from the UI);
  black market pays +2 power; flavour lore lines added to encounter windows.
* 2026-08-24 Terrain split into tile types (gameplay) + biomes (colour), generated by
  rank-normalised multi-octave Perlin noise (elevation, ether holes, biome bands) with
  the frequencies exposed in Settings > World. Also: UI scale option (Settings >
  General, browser preference), danger chevrons count active Stasis debuffs that move
  either side's power, every won battle salvages `battle.victorySupplies` (5) supplies,
  wither pace 1 tile per 2 turns. Owner's config calls: encounter density 0.5, shop
  rest 15, wither terrainHeight 1.
* 2026-08-24 Wither moved from a tile TYPE to a tile BIOME: a withered tile keeps its
  type (shape, passability) and gets repainted; the biome adds +1 HP per step and
  +1 terrainHeight on top of the type. Withered water still dries into walkable
  ground (type -> ground). Ether reworked into true holes: the wither never spreads
  into it, and the renderer spawns no mesh for ether tiles - the camera looks down
  into the void (the floor plane sits 30 units below, fading into the fog). Ether
  hexes stay in the map data, impassable for now, so future mechanics can navigate
  them.
* 2026-08-27 **Power rescaled x3** across the whole game (party, victory reward, shop
  upgrade / relic, scholar, black market, Colony debuff, boss pool) and the damage
  formula changed to `roll(2..8, bell of 3) * 1.1 ^ (powerDiff / 3)` - the exponent is
  continuous (only the final damage is rounded), so every point of power counts a little.
  The flat progression this gives is deliberate: the owner wants to feel it in play first. Regular encounter difficulty is now a
  RING BAND table (count range + total-power range per band) instead of a single
  `powerByRing` value. Stasis Colonies got their own enemy pool (`battle.colonies`),
  separate from the bosses, which were judged too strong for them. The 0-100 difficulty
  guideline above was written down as the yardstick for all of it. Owner's config calls:
  forest #135b32, wither tintAmount 0.5, camera followPlayer off, shop rest 15,
  ground #4d4f46, hill #8f8d74, mountain #b0bbc8.
  The first pass left outer-ring regular groups harder than Colonies and bosses; fixed
  the same day by rebuilding both Stasis pools around counts and HP (see below).
* 2026-08-27 (b) **Stasis pools rebuilt** so the ladder matches the guideline: Colonies
  are 3-7 units, the Seed 4-9 units, against 4-8 units for an outer-ring regular group. "P50" = the power per party unit at which a full-HP party wins
  half the time, measured with a binary search over 600 simulated fights per point
  (`node bench.mjs`, kept out of the repo). Shapes are deliberately varied: equal-power
  swarms (Husk Choir 9, Rot Chorus 7, Stasis Brood 6) and hierarchies (a 26-32 power
  leader plus chaff). Also: `bellDice` back to 3 (bell shaped damage) and the damage
  exponent is no longer rounded.
* 2026-08-28 Damage roll softened to a triangle (`bellDice` 2) and the power coefficient
  raised to `powerBase` 1.15. The **danger chevrons got their own formula**
  (`config.battle.danger`): `1.2 ^ (powerGap / 3) * (enemy count / living party count)`,
  rounded, capped at 8 drawn. The preview now reacts to being OUTNUMBERED, which is what
  the simulation punishes hardest, instead of only to the power gap. Measured P50 (party
  power per unit for a coin-flip win, 600 fights per point) after these two changes:
  outer-ring regular group 14, Stasis Colony 16, Stasis Seed 28 - the same ladder as
  before, one to three points softer across the board.

## Open questions

1. Which encounter types exist for real, and for each: pick-by-hand, roll, or both?
2. Should terrain cost different supplies (hills 2, forest 1)? The field already exists.
3. Should fog re-cover tiles (line of sight) or stay permanent? Currently permanent.
4. Map shape: rectangle now. Branching "lanes" like Slay the Spire, or an open field?
5. Is "supplies" the resource we want, or days / food / something tied to the battle prototype?
6. Do we want elevation on the world map (the battle prototype has it)?
7. (2026-08-27) Party HP never grows, only power does, and power is a weak multiplier
   by design. So the late game is gated on how many upgrades a run can collect: reaching
   ~18 power on all three units takes about 15 wins or shop upgrades. Is that the pacing
   we want, or should HP or healing scale too?

## Roadmap (suggested order)

1. Encounter panel + outcome tables (manual pick and weighted roll).
2. HP / supply consequences, rest sites healing, shops spending supplies.
3. Terrain supply costs and a "path preview" on hover (cost to reach a tile).
4. Map variants: branching lanes, bigger fields, more Stasis Seeds.
5. Save / load a run to the browser (localStorage) so a tab refresh does not reset.
6. Polish: tile textures, fog clouds, sound.

## Conventions for working with Claude on this project

* One feature per request, with the acceptance criteria in plain words ("stepping on a shop
  opens a panel with three items and a Close button").
* Numbers go into `config.js`, never hard-coded in other files.
* Every change is verified in a headless browser before delivery (`tools/smoke-test.cjs`).
* No em or en dashes in text, plain hyphens only.
* Update this file when a rule or decision changes.
