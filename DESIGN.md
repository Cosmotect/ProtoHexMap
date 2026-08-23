# DESIGN.md - the shared memory of this prototype

Read this first in every new work session (human or Claude). It records what the prototype
does, why, and what is still open. Keep it short and current; update it when a decision changes.

## Purpose

Simulate the **world map** of a larger game (Slay the Spire / Into the Breach spirit): the
layer where the player picks where to go next between battles. Battles themselves are
prototyped separately (HEX-BOX, https://hex-box.pages.dev). This prototype only needs to
**simulate the outcomes** of encounters, never the encounters themselves.

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
  * `colonyCount` (4) future **Stasis Colony** sites, each at least `minSpacing` (5) tiles
    from each other and from the Seed, and at least `minDistanceFromStart` (3) from the
    start. After every player turn a line grows from the Seed towards each site by
    `lineSpeed` (0.5) tiles; when it reaches the site's centre the Colony encounter spawns
    there (half-size cone, `colors.colonyTile` tint). Spawning happens AFTER the player's
    arrival is fully resolved, so a Colony can never trap the player in the same instant
    they step on the tile. Lines are drawn only over revealed tiles (fog hides the rest).
  * Each Colony rolls one random **debuff** at generation (duplicates allowed, they stack):
    `maxHp` (party max HP -25% for the fight), `power` (party power -2), `extraEnemies`
    (+2 regular enemies). While a Colony is active its debuff also applies to the Seed
    fight - with all four Colonies up, the Seed is fought under 4 stacked debuffs. Debuffs
    are temporary per fight; damage taken stays.
  * **Withering**: the Seed and every active Colony gain 1/`witherEvery` (1.5) charge per
    turn; each whole charge turns one random non-wither tile within `witherRadius` (2)
    into **wither** terrain (dark blue-purple, costs 1 HP per living unit to step onto,
    never rolled at generation; start/Seed/Colony tiles are spared). Withering water makes
    it walkable - the Stasis dries it out.
  * Clearing a Colony lifts its debuff from the Seed and grants `rewardPicks` (2) power
    raises (chosen unit each, +`battle.victoryPower` per pick).
* Terrain per tile, rolled from weights: grass, forest, hills (free), water (blocked),
  mountain (walkable: costs `supplyCost` 10 supplies and `hpCost` 5 HP per living unit,
  grants `revealBonus` +2 reveal radius while standing there). Each terrain also has a
  `terrainHeight`: a tile is revealed when its distance <= revealRadius + terrainHeight,
  so mountains (2) are seen from 2 tiles further than flat ground. You cannot step onto a
  tile you cannot afford. The guaranteed start-to-Seed route never uses mountains.
* Generation retries until the Seed and every Colony site are reachable from the start; if
  one never is, a corridor is carved. The first ring around the start is always walkable.
* **Fog of war**: tiles start hidden. Moving reveals every tile within `revealRadius` (0)
  plus each tile's `terrainHeight`, permanently. The Seed hides under the fog like every
  other tile (`run.seedAlwaysVisible: false`).
* **Movement**: one step per turn to a neighbouring walkable tile. Ordinary steps cost
  nothing; mountains cost supplies and HP.
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
    enemy; damage = a bell shaped roll in [`damageMin`, `damageMax`] (average of `bellDice`
    uniform rolls) times `powerBase` ^ (attacker power - defender power). Enemy groups:
    `countMin..countMax` units, HP `hpMin..hpMax`, power from `powerByRing` (interpolated
    by ring). Seed and Colony groups roll one of the `battle.bosses` variants (power 4-7).
    Enemy groups are rolled when the map is generated / when the Colony spawns
    (`hex.enemies`), so a revealed fight shows its danger up front:
    floor((enemy power - living party power) / 2) red chevrons above the marker. Player units deal extra damage the lower their HP
    (`battle.desperation`). A report dialog shows every blow (plus the Stasis debuffs that
    applied); after a win the player picks a unit that gains `battle.victoryPower` (1) -
    twice (`stasis.rewardPicks`) after a Colony. Destroying the Seed wins the run.
  * *Treasure*: +`treasure.supplies` (40). Does not reset fatigue. Supplies found in the
    field (Treasure, Fortunate find) open a dialog; if they would overflow the maximum and
    the tile is empty, it offers "make camp first, then collect" so more of the find fits.
  * *Event*: one of the entries in `events.js` (text + effect), numbers in `config.events`:
    Signpost (reveals nearest hidden shop), Friendly pilgrim (reveals an irregular patch of
    `blobSize` hidden tiles), Rumours (reveals up to 3 hidden battles within 3, or the nearest
    hidden ones anywhere when none are in range), Vantage point
    (reveals radius 2 plus all mountains within 5), Fortunate find (+10..20 supplies),
    Wandering scholar (+1 power to one random living unit), Forge procession (reveals nearest
    hidden Acolyte), Black market (choose a unit: -1/3 max HP, +1 power, or decline),
    Nomads (a battle, same rules as a battle encounter), The merchant's caravan (acts as
    a rest site: heals and resets fatigue), Learned about the world (lore text only, weight 2). Does not reset fatigue (except Nomads, which is a battle).
  * *Shop*: opens a dialog. Rest = `shop.restCost` (35) resets fatigue; Upgrade =
    `shop.upgradeCost` (25), +1 power on a chosen unit; Local map = `shop.mapCost` (15)
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
* **HUD**: bottom-centre status bar (fatigue and turn, the Enter button, gold and
  supplies), party panel on the left middle, log bottom left, legend bottom right
  (collapsed; expands on hover, each entry expands on click with its `info` text from the
  config), and a top-right **Menu** (seed, load, copy link, new map, restart, reveal map,
  settings, new player experience; key M). The world blurs while the menu or the settings
  window is open.
* **Languages** (`i18n.js`, `locales/en.js`, `locales/ru.js`): every user-facing string is a
  key in a flat per-language table (same key order in every file, so they can be audited
  side by side). Placeholders `{x}`, plural forms `{n:one|other}` / `{n:один|два|пять}`.
  Code calls `t(key, params)`; unit and enemy names go through `tn(name)`; static HTML uses
  `data-i18n` attributes; the log stores language-neutral entries and is re-rendered on a
  switch. Event stories and lore live in the tables too (`event.<id>.*`, `lore.<id>.*`).
  The toggle is on the General tab of Settings and is saved in the browser. English is the
  reference table: a key missing in another language falls back to English, a key missing
  everywhere shows as the key itself.
* **Settings window** (`settings.js`): every value of the config files, on tabs named after
  them (World, Encounters, Units, General; the language and camera mode live on General).
  The window spans the screen and lays groups out in up to five columns. The
  form is generated from the shape of the config, changes are written into CONFIG at once,
  saved in the browser (localStorage `hexmap-settings-v1`) and re-applied on load, so they
  take precedence over the files. Every row has a reset button (file value), every tab a
  "Reset tab". Map, terrain and starting-party values apply on the next map / run. The hover popup appears on every
  tile: step count since the last fatigue reset, forced chance (when the tile can force),
  fatigue after the step, and the tile's encounter reset rule.
* **New player experience** (`tutorial.js`, seed `NPE_SEED` = 6, also `?npe=1`): a guided
  run on a fixed map. The HUD starts empty; cards explain movement (step 1), the party
  (step 2, panel appears), fatigue (step 3, status bar appears), the first encounter tile,
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
  (rare; the first ring is always open and wither stays walkable).
* **Encounters**: ~33% of walkable tiles (not adjacent to the start) get a type by weight:
  battle 5, event 2, shop 1, treasure 0.8, acolyte 0.15. Stepping on one only writes a log line.
* **Seeds**: `?seed=1234` in the URL, the HUD, and the "Copy link" button. Same seed, same map.
* **Camera**: perspective by default (tilt 52 degrees, fov 42), follows the player with a
  glide; orthographic / isometric alternative on C. Map-style controls: left-drag pan,
  right-drag orbit, wheel zoom, arrow keys pan.

## How the code is split (so changes land in the right file)

`game.js` owns truth (state, rules) and emits events: `reveal`, `move`, `encounter`,
`change`, `log`, `end`, plus the Stasis events `colony` (a Colony spawned), `wither`
(tiles turned to wither) and `stasis` (lines advanced; the renderer rebuilds them).
`render.js` and `ui.js` only listen and draw. Nothing in the renderer
may change game state. This separation is what will let us simulate encounter outcomes
with plain data later, and even run the rules without a screen for balancing.

Data shapes:

```
unit   = { name, icon, hp, maxHp, power, alive }
hex    = { q, r, ring, key, terrain, passable, supplyCost, encounter, isStart, isSeed,
           isColony, revealed, visited, x, y }
state  = { status, party, gold, supplies, maxSupplies, turn, position, shortestPathLength,
           fatigue, coloniesCleared, endReason }
stasis = { seed, colonies: [{ hex, distance, progress, active, cleared, debuff }], witherCharge }
```

## Where encounter outcomes will plug in

`Game.onEnter(hex)` is the single hook. Plan: each encounter type gets a small "outcome
table" in config (e.g. battle: win 70% -> gold +15, HP -10; loss 30% -> HP -30), a panel in
the UI that shows the possible outcomes, and a way to **pick** or **roll** the result.
Outcome choice per type is an open question (see below); the hook does not care.

## Decisions log

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

## Open questions

1. Which encounter types exist for real, and for each: pick-by-hand, roll, or both?
2. Should terrain cost different supplies (hills 2, forest 1)? The field already exists.
3. Should fog re-cover tiles (line of sight) or stay permanent? Currently permanent.
4. Map shape: rectangle now. Branching "lanes" like Slay the Spire, or an open field?
5. Is "supplies" the resource we want, or days / food / something tied to the battle prototype?
6. Do we want elevation on the world map (the battle prototype has it)?

## Roadmap (suggested order)

1. Encounter panel + outcome tables (manual pick and weighted roll).
2. HP / gold consequences, rest sites healing, shops spending gold.
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
