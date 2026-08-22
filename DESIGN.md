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
  https://claude.ai/code/artifact/c335531d-3dd1-4489-b9df-fb4b7fd45bd6
* Battle prototype by a colleague (separate project): https://hex-box.pages.dev
* Planned hosting for this project: Cloudflare Pages (see README section 5).

## Current rules (v0.1)

* Hexagon shaped field: a centre tile plus `radius` (7) rings = 169 tiles (`config.map`).
  Start tile in the exact centre. `map.bossCount` (3) bosses on random tiles with ring >=
  `bossMinRing` ('half' = floor(radius/2)), at least `bossMinSpacing` apart. `run.winCondition`
  'all' (default) = defeat every boss; 'any' = one is enough.
* Terrain per tile, rolled from weights: grass, forest, hills (free), water (blocked),
  mountain (walkable: costs `supplyCost` 10 supplies and `hpCost` 5 HP per living unit,
  grants `revealBonus` +2 reveal radius while standing there). Each terrain also has a
  `terrainHeight`: a tile is revealed when its distance <= revealRadius + terrainHeight,
  so mountains (2) are seen from 2 tiles further than flat ground. You cannot step onto a
  tile you cannot afford. The guaranteed start-to-boss route never uses mountains.
* Generation retries until the boss is reachable from the start; if it never is, a corridor
  is carved. The first ring around the start is always walkable.
* **Fog of war**: tiles start hidden. Moving reveals every tile within `revealRadius` (1)
  of the player, permanently. The boss tile is hidden under the fog like every other tile
  (`bossAlwaysVisible: false`); set it to true to show the goal from the start.
* **Movement**: one step per turn to a neighbouring walkable tile. Steps do NOT spend
  supplies any more (supplies stay in the state/HUD for a future mechanic).
* **Party**: three units (`config.party.units`), each with HP and **power**, shown in the
  left panel (segmented HP bars, one segment per `hpSegment` HP). On the map they move as
  one token. A unit at 0 HP is *fallen*: greyed out, skipped in battles, until an Acolyte
  restores it. All three fallen = run lost.
* **Supplies are the currency** (`startSupplies` 60, also the maximum: gains are capped).
  Ordinary movement does not spend them; mountains do.
* **Encounters are opt-in**: standing on an encounter tile enables the "Engage" button
  (bottom centre, key E). On an *empty* tile the same button reads "Make camp": spends
  `rest.cost` (20) supplies, heals each living unit by `rest.healFraction` (50%) of max HP,
  resets fatigue. Rest sites are no longer generated on the map.
* **Encounter logic** (`game.js engage()`):
  * *Battle / Boss*: automatic simulation (`battle.js`). Player strikes first unless the
    battle was forced by fatigue. Each unit hits a random living enemy; damage = a bell
    shaped roll in [`damageMin`, `damageMax`] (average of `bellDice` uniform rolls) times
    `powerBase` ^ (attacker power - defender power). Enemy groups: `countMin..countMax`
    units, HP `hpMin..hpMax`, power from `powerByRing` (interpolated by ring). Boss group
    from `battle.boss`. Player units deal extra damage the lower their HP
    (`battle.desperation`). A report dialog shows every blow; after a win the player
    picks a unit that gains `battle.victoryPower` (1). Bosses count toward the win condition.
  * *Treasure*: +`treasure.supplies` (40). Does not reset fatigue. Supplies found in the
    field (Treasure, Fortunate find) open a dialog; if they would overflow the maximum and
    the tile is empty, it offers "make camp first, then collect" so more of the find fits.
  * *Event*: one of the entries in `events.js` (text + effect), numbers in `config.events`:
    Signpost (reveals nearest hidden shop), Friendly pilgrim (reveals an irregular patch of
    `blobSize` tiles), Rumours (reveals up to 3 hidden battles within 3), Vantage point
    (reveals radius 2 plus all mountains within 5), Fortunate find (+10..20 supplies),
    Wandering scholar (+1 power to one random living unit), Forge procession (reveals nearest
    hidden Acolyte), Black market (choose a unit: -1/3 max HP, +1 power, or decline),
    Nomads (a battle, same rules as a battle encounter), The merchant's caravan (acts as
    a rest site: heals and resets fatigue), Learned about the world (lore text only, weight 2). Does not reset fatigue (except Nomads, which is a battle).
  * *Shop*: opens a dialog. Rest = `shop.restCost` (35) resets fatigue; Upgrade =
    `shop.upgradeCost` (25), +1 power on a chosen unit; Local map = `shop.mapCost` (15)
    reveals a patch of `events.blobSize` tiles. The shop stays on the tile and engaging it
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
* **Lose**: only by being boxed in with no walkable neighbour (rare; first ring is always open).
* **Win**: win the boss battle. **Lose**: whole party fallen, or boxed in.
* **Encounters**: ~33% of walkable tiles (not adjacent to the start) get a type by weight:
  battle 5, event 3, rest 2, shop 1, treasure 1. Stepping on one only writes a log line.
* **Seeds**: `?seed=1234` in the URL, the HUD, and the "Copy link" button. Same seed, same map.
* **Camera**: perspective by default (tilt 52 degrees, fov 42), follows the player with a
  glide; orthographic / isometric alternative on C. Map-style controls: left-drag pan,
  right-drag orbit, wheel zoom, arrow keys pan.

## How the code is split (so changes land in the right file)

`game.js` owns truth (state, rules) and emits events: `reveal`, `move`, `encounter`,
`change`, `log`, `end`. `render.js` and `ui.js` only listen and draw. Nothing in the renderer
may change game state. This separation is what will let us simulate encounter outcomes
with plain data later, and even run the rules without a screen for balancing.

Data shapes:

```
unit  = { name, icon, hp, maxHp, power, alive }
hex   = { q, r, ring, key, terrain, passable, supplyCost, encounter, isStart, isBoss,
          revealed, visited, x, y }
state = { status, hp, maxHp, gold, supplies, maxSupplies, turn, position, shortestPathLength, endReason }
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
4. Map variants: branching lanes, bigger fields, multiple bosses.
5. Save / load a run to the browser (localStorage) so a tab refresh does not reset.
6. Polish: tile textures, fog clouds, sound.

## Conventions for working with Claude on this project

* One feature per request, with the acceptance criteria in plain words ("stepping on a shop
  opens a panel with three items and a Close button").
* Numbers go into `config.js`, never hard-coded in other files.
* Every change is verified in a headless browser before delivery (`tools/smoke-test.cjs`).
* No em or en dashes in text, plain hyphens only.
* Update this file when a rule or decision changes.
