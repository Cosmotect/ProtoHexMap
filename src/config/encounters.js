// =====================================================================
//  ENCOUNTER CONFIG - what sits on the tiles and what engaging it does,
//  plus fatigue (the rule that forced encounters on a tired party -
//  DISABLED as an experiment on 2026-09-22, see the "Fatigue" section).
//  (Part of the config split: world.js / encounters.js / entities.js / config.js)
// =====================================================================

export const ENCOUNTERS = {
  // ----- Placement ----------------------------------------------------
  // WHERE the encounters go is decided LAST in world generation (map.js
  // placeEncounters, after every retry, corridor and start-ring fix), on the
  // final list of walkable, supply-free tiles (no water, ether, hills or
  // mountains; not the start, the Seed or a Colony site; not within
  // minDistanceFromStart of the start). Those tiles are split into the RING
  // BANDS of config.battle.enemies.bands (inner / middle / outer, by ring),
  // and every band is seeded on its own:
  //   * the band holds about `density` x its tiles worth of encounters;
  //   * each type's share of those is its `weight` over the sum of weights
  //     (a plain number, or one number per band in band order), rounded
  //     seeded-randomly so a rare type (the gate) still turns up now and
  //     then rather than never;
  //   * `guaranteed` is the band's MINIMUM of that type, one number per band
  //     in band order (a plain number means every band): the share is lifted
  //     to it before placing, and a VALIDATOR runs after everything is down
  //     and places more of a type in any band still short of it (on a free
  //     tile, or over the band's most plentiful type when none is free);
  //   * within a band each type is spread EVENLY over the tiles it may
  //     take (src/spread.js evenSpread, the Hack board's placer): rarest
  //     type first, so no seed ends up with every cache in one corner or
  //     the first three rings holding two fights.
  // `unique` types appear at most once per map, whatever their weights.
  // The result is deterministic per seed; map.encounterReport says what
  // each band got (the test tools read it).
  encounters: {
    density: 0.5,
    minDistanceFromStart: 0,  // tiles this close to the start (centre) stay empty (0 = only the start tile itself)
    // (rest sites are no longer generated: the player builds them, see "rest" below)
    types: {
      battle: { weight: 5, guaranteed: [4, 8, 16] },
      event: { weight: 2, guaranteed: [1, 2, 2] },
      shop: { weight: 0.75, guaranteed: [1, 3, 5] },
      treasure: { weight: 0.8, guaranteed: [1, 3, 6] },
      // Very rare as a random roll, but a run needs one within reach: at least one in the middle band.
      acolyte: { weight: 0.25, guaranteed: [0, 1, 0] },
      // The layer gate: EXTREMELY rare - most maps have none, and "unique"
      // below caps it at one. Entering it unlocks the next layer of the
      // worldflake (config.layers.unlockOrder; the chain is meta-progression,
      // remembered by the browser across runs).
      gate: { weight: 0.02, guaranteed: 0 },
      // The Hack terminal (see `hack` below and DESIGN.md): a few per map; 0
      // keeps it off generated maps.
      hack: { weight: 0.6, guaranteed: [0, 1, 2] },
    },
    unique: ['gate'],             // types that appear at most ONCE per map
    // Visual placeholders. "shape" is one of: octahedron, icosahedron, box, cone,
    // dodecahedron, pyramid. Labels and descriptions live in the locale tables
    // (visual.<type>.label / .info).
    visuals: {
      battle: { color: 0xe2474b, shape: 'octahedron' },
      event: { color: 0xa56cf5, shape: 'icosahedron' },
      rest: { color: 0xff9f43, shape: 'cone' },
      // neverForced: the legend spells out that this tile can never drag the
      // party in (text.js encounterInfo). Only for the types where that is a
      // real reassurance - everything simply absent from fatigue.forceable is
      // safe too, and says nothing.
      shop: { color: 0x45c7d1, shape: 'box', neverForced: true },
      treasure: { color: 0xf5c542, shape: 'dodecahedron' },
      stasisSeed: { color: 0x9b1c31, shape: 'cone' },
      stasisColony: { color: 0x6e2c8f, shape: 'cone' },
      acolyte: { color: 0xfff3b0, shape: 'icosahedron' },
      gate: { color: 0x35d17a, shape: 'pyramid', neverForced: true },   // the green pyramid
      hack: { color: 0x7dff5f, shape: 'box' },       // the hack terminal
      // The waypoint that completes a scenario (tutorial) map. Never generated on
      // normal maps, so it is hidden from the legend.
      goal: { color: 0x9fd9ff, shape: 'cone', hidden: true },
    },
  },

  // ----- Handcrafted local maps (map codes) ----------------------------
  // EVERY fight plays on one of these (since 2026-09-16 - the random arena
  // generator and the enemy-group table are gone). A combat map is the whole
  // fight: its terrain AND its enemies, pinned tile by tile with '!' lines.
  // Which map a battle tile gets is rolled at world generation out of
  // `battleMaps` below (a cell per ring band x layer); the map's enemies are
  // the tile's enemies, so the hover, the chevrons' band and the fight all
  // read the same code. The chevrons themselves still come only from the ring
  // band (config.battle.danger.ringBands, see game.js dangerRank) - a map has
  // no say over them. Parsed by src/local/mapcode.js; paste any of these codes
  // into Menu -> Preview map code to walk around it.
  //
  // MAP CODE FORMAT - one line per statement, '#' starts a comment:
  //   id: <name>            required, the map's id (what battleMaps lists)
  //   title: <text>         optional, the fight's display name (default: the
  //                         id with dashes as spaces, capitalised)
  //   radius: <n>           optional, rings of local hexes (default config.local.radius)
  //   q,r: <type> [elevation] [tags...] [!Enemy Name]
  // Tile lines list only the tiles that differ from plain ground at the
  // neutral elevation (2); everything unlisted stays that. Types: ground,
  // wall (blocks walking, pushes crash on it), ether (a hole: pushes into it
  // kill). Elevation is a level 0..4 (walls default to 4, ether needs none).
  // Tags are tile tag ids from src/config/entities.js (e.g. fire). '!' pins
  // an enemy from the bestiary (config/entities.js battle.enemyTypes, by id or
  // display name) to the tile; the rest of the line is its name.
  //
  // AUTHORING RULES (the engine's, not conventions): a ground unit cannot
  // step across a height gap of more than ONE level, so a plateau at 4 needs
  // a ramp of 3s and a pit at 0 needs a rim of 1s, or nothing walks in or
  // out; every pinned ground enemy must be able to walk to where the party
  // can stand, and every free ground tile should be walkable to, because a
  // forced fight drops the party on random tiles (a sealed tile is a
  // stuck unit). Flying creatures (Leviathan, Ether Spawn, Stasis Mote) are
  // exempt. Keep radius 4..7: the arena camera does not zoom.
  craftedMaps: {
    combat: {
      maps: [
        `# A sunken ether trench splits the arena; the only way across is a walled
# causeway held by raiders, with braziers of fire guarding the mouth.
id: the-causeway
radius: 4
1,-4: ether
1,-3: ether
1,-2: ether
1,1: ether
1,2: ether
1,3: ether
1,-1: ground 2
1,0: ground 2
0,-1: wall 4
0,1: wall 4
2,-2: wall 4
2,0: wall 4
0,0: ground 2 fire
2,-1: ground 2 fire
2,1: ground 3
3,-1: ground 3 !Raider
3,-3: ground 3 !Raider
2,2: ground 3 !Husk
3,0: ground 4 !Drifter`,
        `# A ring of high ground around a burning hollow: whoever holds the rim
# rains shots down; whoever falls in fights out of a firepit.
id: ember-hollow
radius: 6
0,0: ground 0 fire
1,0: ground 0
0,1: ground 0 fire
-1,1: ground 0
-1,0: ground 1
0,-1: ground 1 fire
1,-1: ground 1
2,-1: ground 3
2,0: ground 3
1,1: ground 3
0,2: ground 3
-1,2: ground 3
-2,2: ground 3
-2,1: ground 3
-2,0: ground 3
-1,-1: ground 3
0,-2: ground 3
1,-2: ground 3
2,-2: ground 3
3,0: wall 4
0,3: wall 4
-3,3: wall 4
-3,0: wall 4
0,-3: wall 4
3,-3: wall 4
4,-2: ground 2 !Brute
-2,4: ground 2 !Stalker
-2,-2: ground 2 !Husk
4,0: ground 2 !Husk`,
        // ----- INNER RINGS (config.battle.enemies.bands.inner) - one to five weak creatures -----
        `# A sunken creek bed winds across the arena; the raiders wait on the far bank
# where the ground rises again. Cross in the open or go the long way round.
id: dry-creek
title: Dry Creek
radius: 4
1,-4: ground 3
3,-4: ground 3
4,-4: ground 1
0,-3: ground 3
1,-3: ground 3
2,-3: ground 3 !drifter
4,-3: ground 1
0,-2: ground 3 !raider
3,-2: ground 1
-1,-1: ground 3
1,-1: ground 1
2,-1: ground 1
3,-1: ground 1
-1,0: ground 1
0,0: ground 1
1,0: ground 1
2,0: ground 1
-4,1: ground 1
-3,1: ground 1
-2,1: ground 1
-1,1: ground 1
0,1: ground 1`,
        `# A bowl of soft earth with a nest of ticks at the bottom. A drifter on the
# knoll above keeps watch; the ticks come up fast once disturbed.
id: tick-nest
title: Tick Nest
radius: 5
3,-5: ground 3
4,-5: ground 4 !drifter
3,-4: ground 3
4,-4: ground 3
0,-2: ground 1
1,-2: ground 1
2,-2: ground 1
-1,-1: ground 1
0,-1: ground 0
1,-1: ground 0 !weakTick
2,-1: ground 1
-2,0: ground 1
-1,0: ground 0
0,0: ground 0 !rageTick
1,0: ground 0
2,0: ground 1
-2,1: ground 1
-1,1: ground 0 !frailTick
0,1: ground 0 !rushTick
1,1: ground 1
-2,2: ground 1
-1,2: ground 1
0,2: ground 1
-5,3: wall 4
-3,5: wall 4`,
        `# The toppled stones of an old cairn stand about the middle of the field;
# three husks shamble between them. The stones break lines of fire both ways.
id: broken-cairn
title: Broken Cairn
radius: 4
0,-2: wall 4
1,-2: ground 2 !husk
1,-1: ground 3
2,-1: wall 4
-2,0: wall 4
-1,0: ground 3
0,0: wall 4
1,0: ground 3
3,0: ground 2 !husk
-1,1: ground 3
1,1: wall 4
-2,2: ground 2 !husk
-1,2: wall 4`,
        `# A single hill with a flat top and one honest ramp up. A lone raider holds
# the summit and has the height advantage on anyone climbing the ramp.
id: lone-watch
title: Lone Watch
radius: 4
1,-2: ground 3
2,-2: ground 3
0,-1: ground 3
1,-1: ground 4 !raider
2,-1: ground 3
0,0: ground 3
1,0: ground 3
2,0: ground 3
3,0: ground 3
-2,2: ground 1
-3,3: ground 1`,
        `# A road lined with still-burning braziers runs straight through the field.
# A husk and a drifter loiter at the far end; the fires punish a careless shove.
id: ash-road
title: Ash Road
radius: 4
-2,-2: ground 3
0,-2: ground 3
2,-2: ground 3
-3,-1: ground 2 fire
-1,-1: ground 2 fire
1,-1: ground 2 fire
3,-1: ground 2 fire
4,-1: ground 2 !drifter
3,0: ground 2 !husk
-3,1: ground 2 fire
-1,1: ground 2 fire
1,1: ground 2 fire
3,1: ground 2 fire
-2,2: ground 3
0,2: ground 3
2,2: ground 3`,
        `# Flat ground pocked with two sinkholes into the ether. The beasts here charge:
# a stag and a hammerhead - stand next to a hole and one of you goes in.
id: sinkhole-flats
title: Sinkhole Flats
radius: 5
2,-4: ether
1,-3: ether
2,-3: ether
3,-2: ground 2 !stag
4,-2: ground 3
3,-1: ground 3
4,-1: ground 3
-4,1: ground 1
-3,1: ground 2 !hammerhead
-4,2: ground 1
-2,2: ether
-3,3: ether
-2,3: ether`,
        `# Old farming terraces climb the north side step by step. A scouting pair sits
# on the top step and shoots down at whoever comes up.
id: terraces
title: The Terraces
radius: 4
0,-4: ground 4
1,-4: ground 4 !raider
2,-4: ground 4
3,-4: ground 4 !drifter
4,-4: ground 4
-1,-3: ground 3
0,-3: ground 3
1,-3: ground 3
2,-3: ground 3
3,-3: ground 3
4,-3: ground 3
-2,-2: ground 3
-1,-2: ground 3
0,-2: ground 3
1,-2: ground 3
2,-2: ground 3
3,-2: ground 3
4,-2: ground 3
-4,3: ground 1
-4,4: ground 1
-3,4: ground 1`,
        `# A hollow ringed with thorn-choked rock. Strays hide in the low ground;
# the way in is over the lip, and the lip is the high ground.
id: bramble-hollow
title: Bramble Hollow
radius: 4
0,-3: wall 4
3,-3: wall 4
0,-2: ground 1
1,-2: ground 1
2,-2: ground 1
-1,-1: ground 1
0,-1: ground 0
1,-1: ground 0 !drifter
2,-1: ground 1
3,-1: wall 4
-2,0: ground 3
-1,0: ground 0
0,0: ground 0 !husk
1,0: ground 0
2,0: ground 3
-3,1: wall 4
-2,1: ground 1
-1,1: ground 0 !husk
0,1: ground 0
1,1: ground 1
-2,2: ground 1
-1,2: ground 1
0,2: ground 1
-3,3: wall 4
0,3: wall 4`,
        `# A tall rock in the middle of the field is a bombardier's favourite perch.
# Its lobbed bursts reach far; the drifter and the husk guard the ramp up.
id: bombardier-perch
title: Bombardier Perch
radius: 5
0,-2: wall 4
2,-2: wall 4
0,-1: ground 3
1,-1: ground 3
-2,0: wall 4
-1,0: ground 3
0,0: ground 4 !bombardier
1,0: ground 3
2,0: ground 3
-1,1: ground 3
0,1: ground 3
2,1: ground 2 !drifter
0,2: ground 3
1,2: ground 2 !husk
-4,3: ground 1
-4,4: ground 1
-3,4: ground 1`,
        `# Two lines of standing stones make a run down the middle of the field. Stags
# charge along it; a rusher tick skitters in behind them.
id: stag-run
title: Stag Run
radius: 5
4,-2: ground 2 !stag
-3,-1: wall 4
-1,-1: wall 4
1,-1: wall 4
3,-1: wall 4
5,-1: ground 2 !rushTick
4,0: ground 2 !stag
-3,2: wall 4
-1,2: wall 4
1,2: wall 4
3,2: wall 4
-5,3: ground 3
-5,4: ground 3
-4,4: ground 3`,
        // ----- MIDDLE RINGS - three to six creatures, the soldiery -----
        `# A raiding party camps behind a broken palisade. The gaps in the wall are the
# only way in, and the campfires inside burn anyone shoved into them.
id: raiders-camp
title: Raiders' Camp
radius: 5
1,-3: wall 4
2,-3: wall 4
-1,-2: wall 4
0,-2: ground 2 !raider
3,-2: wall 4
-2,-1: wall 4
1,-1: ground 2 fire
2,-1: ground 2 !raider
3,-1: wall 4
0,0: ground 2 fire
1,0: ground 2 !warden
-4,1: ground 3
-3,1: wall 4
-1,1: ground 2 !raider
0,1: ground 2 !stalker
2,1: wall 4
-4,2: ground 3
-3,2: wall 4
1,2: wall 4
-2,3: wall 4
-1,3: wall 4`,
        `# Dead trunks stand thick across the arena and a stalker pack uses every one
# of them. Nothing has a clear line for long; the drifter shoots over it all.
id: stalker-woods
title: Stalker Woods
radius: 6
4,-5: ground 2 !drifter
2,-4: ground 2 !stalker
5,-4: wall 4
-1,-3: wall 4
3,-3: wall 4
4,-3: ground 2 !stalker
5,-2: ground 2 !stalker
-3,-1: wall 4
0,-1: ground 3
1,-1: wall 4
4,-1: wall 4
-1,0: ground 3
1,0: ground 3
3,0: wall 4
-4,1: wall 4
0,1: wall 4
3,1: ground 2 !stalker
2,2: wall 4
-2,3: wall 4
-5,4: wall 4
1,4: wall 4
-1,5: wall 4`,
        `# A wall runs clean across the field with one gate in it. Two wardens hold the
# gate from a raised step; a brute waits behind them where the gate opens.
id: warden-gate
title: Warden Gate
radius: 5
3,-3: ground 2 !raider
-2,-2: ground 2 !husk
1,-2: ground 2 !brute
0,-1: ground 3
1,-1: ground 3
2,-1: ground 3
-5,0: wall 4
-4,0: wall 4
-3,0: wall 4
-2,0: wall 4
-1,0: wall 4
0,0: ground 3 !warden
1,0: ground 3 !warden
2,0: wall 4
3,0: wall 4
4,0: wall 4
5,0: wall 4
-2,4: ground 1
-1,4: ground 1
-3,5: ground 1`,
        `# Boggy low ground where the striped bombardiers gather. The pools between
# the tussocks are sunken; the bombardiers lob their nerve agent from the tussocks.
id: mating-grounds
title: Mating Grounds
radius: 5
4,-4: ground 2 !stag
1,-2: ground 1
2,-2: ground 3 !stripedBombardier
-1,-1: ground 1
0,-1: ground 1
3,-1: ground 3
-3,0: ground 1
-2,0: ground 3 !stripedBombardier
0,0: ground 3 !stripedBombardier
2,0: ground 1
2,1: ground 1
-2,2: ground 1
-1,2: ground 1
1,2: ground 3
0,3: ground 1
-1,4: ground 3`,
        `# A ridge of rock runs the length of the field with a sheer drop into the ether
# on its eastern flank. Whoever holds the spine shoots down; whoever is shoved east falls.
id: the-spine
title: The Spine
radius: 6
1,-6: ground 3
3,-6: ether
4,-6: ether
5,-6: ether
6,-6: ether
-1,-5: ground 3
0,-5: ground 4
1,-5: ground 3
4,-5: ether
5,-5: ether
6,-5: ether
-1,-4: ground 3
0,-4: ground 4
1,-4: ground 3 !stalker
5,-4: ether
6,-4: ether
-1,-3: ground 3
0,-3: ground 4
1,-3: ground 3
6,-3: ether
-1,-2: ground 3
0,-2: ground 4 !raider
1,-2: ground 3
6,-2: ether
-1,-1: ground 3
0,-1: ground 4
1,-1: ground 3
2,-1: ground 2 !hammerhead
6,-1: ether
-1,0: ground 3
0,0: ground 4
1,0: ground 3
6,0: ether
-1,1: ground 3
0,1: ground 4
1,1: ground 3
5,1: ether
-1,2: ground 3
0,2: ground 4 !raider
1,2: ground 3
4,2: ether
-1,3: ground 3 !stalker
0,3: ground 4
1,3: ground 3
3,3: ether
-1,4: ground 3
0,4: ground 4
1,4: ground 3
-1,5: ground 3
0,5: ground 4
1,5: ground 3`,
        `# A ring of ether cuts an island out of the middle of the field. Two land
# bridges cross it - north and south - and the wardens hold the island.
id: sunken-ring
title: Sunken Ring
radius: 5
0,-3: ground 3
1,-3: ether
2,-3: ether
-1,-2: ether
3,-2: ether
-2,-1: ether
0,-1: ground 3 !drifter
1,-1: ground 3 !warden
3,-1: ether
-3,0: ether
-1,0: ground 3
0,0: ground 3 !warden
1,0: ground 3 !raider
3,0: ether
-3,1: ether
-1,1: ground 3 !raider
0,1: ground 3
2,1: ether
-3,2: ether
1,2: ether
-2,3: ether
-1,3: ether
0,3: ground 3`,
        `# A long shelf of high ground along the north side is a drifter firing line;
# a brute stands at the foot of the only ramp to keep the party off it.
id: firing-line
title: Firing Line
radius: 6
0,-6: ground 4
1,-6: ground 4 !drifter
2,-6: ground 4
3,-6: ground 4 !drifter
4,-6: ground 4
5,-6: ground 4 !drifter
6,-6: ground 4
-1,-5: ground 4
0,-5: ground 4
1,-5: ground 4
2,-5: ground 4
3,-5: ground 4
4,-5: ground 4
5,-5: ground 4
6,-5: ground 4
-2,-4: ground 3
-1,-4: ground 3
0,-4: ground 3
1,-4: ground 3
2,-4: ground 3
3,-4: ground 3
4,-4: ground 3
5,-4: ground 3
6,-4: ground 3
-3,-3: wall 4
3,-3: ground 2 !brute
-4,-2: wall 4
-6,6: ground 1
-5,6: ground 1
-4,6: ground 1`,
        `# Paired stone posts turn the field into lanes, and charging beasts live for
# lanes: two hammerheads and two stags, with a raider to close the trap.
id: hammer-yard
title: Hammer Yard
radius: 5
0,-5: ground 2 !raider
4,-4: ground 2 !hammerhead
0,-3: wall 4
1,-3: wall 4
3,-2: wall 4
3,-1: wall 4
-4,0: ground 2 !stag
-3,0: wall 4
0,0: ground 3
4,0: ground 2 !stag
-3,1: wall 4
-1,3: wall 4
0,3: wall 4
-4,4: ground 2 !hammerhead`,
        `# Smouldering pits open in the ground and cinders still burn beside them.
# Bombardiers lob from the rim while ticks and a raider come through the smoke.
id: cinder-pits
title: Cinder Pits
radius: 5
3,-4: ground 3 !bombardier
4,-4: ground 3
4,-3: ground 3
-1,-2: ground 2 fire
-2,-1: ground 1
3,-1: ground 2 fire
4,-1: ground 2 !raider
-3,0: ground 1
-2,0: ground 1
0,0: ground 2 !rageTick
2,0: ground 1
-3,1: ground 2 fire
-1,1: ground 2 !rageTick
1,1: ground 1
0,2: ground 2 fire
1,2: ground 1
-4,4: ground 2 !bombardier`,
        `# A quarry cut into the south-west corner: benches drop step by step to the
# floor. The stalkers work the benches; the warden holds the floor with a drifter.
id: old-quarry
title: Old Quarry
radius: 6
4,-4: ground 3
3,-3: ground 3
4,-3: ground 3
1,1: ground 1
-2,2: ground 2 !husk
-1,2: ground 1
0,2: ground 1 !stalker
2,2: ground 1
-2,3: ground 1
-1,3: ground 1
0,3: ground 1
1,3: ground 1
-6,4: wall 4
-3,4: ground 1
-2,4: ground 0 !warden
-1,4: ground 0
0,4: ground 0
1,4: ground 1 !stalker
2,4: wall 4
-5,5: ground 1
-4,5: ground 0
-3,5: ground 0 !drifter
-2,5: ground 0
-6,6: ground 1
-5,6: ground 1
-4,6: ground 0 !stalker
-3,6: ground 0`,
        // ----- OUTER RINGS - eight to twelve creatures, the warbands -----
        `# A warband's camp: a stone ring with two gates and a fire in the middle.
# Ravagers and brutes hold the gates, wardens the fire, stalkers hunt outside.
id: war-camp
title: War Camp
radius: 6
0,-3: ground 2 !ravager
1,-3: wall 4
2,-3: wall 4
3,-3: ground 2 !brute
-1,-2: wall 4
3,-2: wall 4
-2,-1: wall 4
0,-1: ground 3
1,-1: ground 3 !warden
3,-1: wall 4
5,-1: ground 2 !stalker
-3,0: wall 4
-1,0: ground 3
0,0: ground 2 fire
1,0: ground 3
3,0: wall 4
-5,1: ground 2 !stalker
-3,1: wall 4
-1,1: ground 3 !warden
0,1: ground 3
2,1: wall 4
-3,2: wall 4
1,2: wall 4
-3,3: ground 2 !brute
-2,3: wall 4
-1,3: wall 4
0,3: ground 2 !ravager`,
        `# The field ends in ether along the whole eastern edge. A tide of husks
# washes in from the north with stalkers on its flanks and a brute and a ravager driving it.
id: husk-tide-shore
title: Husk Tide Shore
radius: 7
0,-7: ground 2 !ravager
1,-7: ground 2 !husk
2,-7: ground 2 !husk
3,-7: ground 2 !husk
5,-7: ether
7,-7: ether
-1,-6: ground 2 !husk
2,-6: ground 2 !husk
4,-6: ground 2 !stalker
6,-6: ether
7,-6: ether
0,-5: ground 2 !husk
1,-5: ground 3 !brute
6,-5: ether
7,-5: ether
-3,-4: ground 2 !stalker
-1,-4: ground 3
0,-4: ground 3
6,-4: ether
7,-4: ether
-4,-3: ground 2 !stalker
-2,-3: ground 3
6,-3: ether
7,-3: ether
6,-2: ether
7,-2: ether
6,-1: ether
7,-1: ether
6,0: ether
7,0: ether
6,1: ether
5,2: ether
4,3: ether
3,4: ether
2,5: ether
1,6: ether
0,7: ether`,
        `# The shell of a fallen hall: wall stubs in rows, a raised floor where the
# roof used to be. Ravagers hunt through the ruins with stalkers and a warden.
id: ruin-hunt
title: Ruin Hunt
radius: 6
1,-6: ground 2 !stalker
5,-5: ground 2 !stalker
0,-4: wall 4
2,-4: wall 4
4,-4: wall 4
3,-3: ground 2 !ravager
-2,-2: wall 4
0,-2: ground 2 !warden
4,-2: wall 4
-4,-1: ground 2 !raider
-3,-1: wall 4
0,-1: ground 3
1,-1: ground 3
3,-1: wall 4
-4,0: wall 4
-1,0: ground 3
0,0: ground 3 !ravager
1,0: ground 3
2,0: ground 3
-1,1: ground 3
0,1: ground 3
4,1: ground 2 !raider
-4,2: wall 4
-2,2: ground 3
2,2: wall 4
-3,3: ground 2 !ravager
-2,4: wall 4
0,4: wall 4
-5,5: ground 2 !stalker`,
        `# A square-cut bastion rises two full steps above the field, with ramps on
# its north and south faces. Wardens and brutes hold the top; ravagers prowl below.
id: the-bastion
title: The Bastion
radius: 6
4,-5: ground 2 !ravager
0,-3: ground 3
1,-3: ground 3
3,-3: wall 4
0,-2: ground 3
1,-2: ground 3
2,-2: ground 3
5,-2: ground 2 !raider
-1,-1: ground 3
0,-1: ground 4
1,-1: ground 4 !warden
2,-1: ground 3
-3,0: wall 4
-2,0: ground 3
-1,0: ground 4 !brute
0,0: ground 4 !warden
1,0: ground 4 !brute
2,0: ground 3
3,0: wall 4
-2,1: ground 3
-1,1: ground 4 !warden
0,1: ground 4
1,1: ground 3
-5,2: ground 2 !raider
-2,2: ground 3
-1,2: ground 3
0,2: ground 3
-3,3: wall 4
-1,3: ground 3
0,3: ground 3
-4,5: ground 2 !ravager`,
        `# Two lines of burning ground cross the field, leaving a dark gap at the
# middle. Stalkers wait in every quarter; the ravagers hold the crossing itself.
id: crossing-of-fires
title: Crossing of Fires
radius: 6
0,-6: ground 2 fire
3,-5: ground 2 !stalker
0,-4: ground 2 fire
-2,-3: ground 2 !drifter
5,-3: ground 2 !drifter
0,-2: ground 2 fire
-4,-1: ground 2 !stalker
0,-1: ground 3
1,-1: ground 3 !ravager
-6,0: ground 2 fire
-4,0: ground 2 fire
-2,0: ground 2 fire
-1,0: ground 3
0,0: ground 3 !ravager
1,0: ground 3
2,0: ground 2 fire
4,0: ground 2 fire
6,0: ground 2 fire
-1,1: ground 3
0,1: ground 3
4,1: ground 2 !stalker
0,2: ground 2 fire
-5,3: ground 2 !drifter
0,4: ground 2 fire
-3,5: ground 2 !stalker
0,6: ground 2 fire`,
        `# A chasm splits the field in two; a single stone bridge crosses it. Chargers
# hold the far side - the bridge is the only way over, and a shove off it is fatal.
id: chasm-bridge
title: Chasm Bridge
radius: 7
1,-7: ether
2,-7: ether
1,-6: ether
2,-6: ether
1,-5: ether
2,-5: ether
6,-5: ground 2 !hammerhead
1,-4: ether
2,-4: ether
5,-4: ground 3 !ravager
1,-3: ether
2,-3: ether
4,-3: ground 3 !ravager
5,-3: ground 3
1,-2: ether
4,-2: ground 3
6,-2: ground 2 !stag
4,-1: ground 2 !hammerhead
5,-1: ground 2 !raider
2,0: ether
1,1: ether
2,1: ether
3,1: ground 2 !stag
1,2: ether
2,2: ether
4,2: ground 2 !raider
-5,3: ground 1
1,3: ether
2,3: ether
-6,4: ground 1
-5,4: ground 1
1,4: ether
2,4: ether
1,5: ether
2,5: ether
1,6: ether`,
        `# One great hill fills the field, terraced all the way up. Drifters shoot
# from the crown while brutes and wardens fight down the slopes.
id: terraced-hill
title: Terraced Hill
radius: 6
0,-4: ground 2 !brute
4,-4: ground 2 !warden
0,-3: ground 3
1,-3: ground 3
2,-3: ground 3
3,-3: ground 3
-1,-2: ground 3
0,-2: ground 3
1,-2: ground 3 !drifter
2,-2: ground 3
3,-2: ground 3
-2,-1: ground 3
-1,-1: ground 3
0,-1: ground 4
1,-1: ground 4
2,-1: ground 3
3,-1: ground 3
-4,0: ground 2 !warden
-3,0: ground 3
-2,0: ground 3
-1,0: ground 4
0,0: ground 4 !drifter
1,0: ground 4
2,0: ground 3
3,0: ground 3
-3,1: ground 3
-2,1: ground 3 !drifter
-1,1: ground 4
0,1: ground 4
1,1: ground 3 !drifter
2,1: ground 3
-3,2: ground 3
-2,2: ground 3
-1,2: ground 3
0,2: ground 3
1,2: ground 3
-3,3: ground 3
-2,3: ground 3
-1,3: ground 3
0,3: ground 3
0,4: ground 2 !brute`,
        `# A plateau one step up, cracked through with ether fissures. Ravagers and
# stalkers know every crack; the husks do not, and fall in when pushed.
id: broken-plateau
title: Broken Plateau
radius: 6
0,-4: ground 3
1,-4: ground 3
2,-4: ground 3
3,-4: ground 3 !husk
4,-4: ground 3 !stalker
-1,-3: ground 3 !husk
0,-3: ground 3
1,-3: ether
2,-3: ether
3,-3: ground 3
4,-3: ground 3
-2,-2: ground 3
-1,-2: ether
0,-2: ground 3
1,-2: ground 3
2,-2: ground 3
3,-2: ground 3
4,-2: ground 3
-3,-1: ground 3
-2,-1: ground 3
-1,-1: ground 3
0,-1: ground 3
1,-1: ground 3
2,-1: ground 3 !ravager
3,-1: ether
4,-1: ground 3
-4,0: ground 3
-3,0: ground 3
-2,0: ground 3
-1,0: ground 3
0,0: ground 3 !ravager
1,0: ground 3
2,0: ground 3
3,0: ground 3
4,0: ground 3
-4,1: ground 3 !husk
-3,1: ground 3
-2,1: ether
-1,1: ground 3
0,1: ground 3
1,1: ground 3
2,1: ground 3
3,1: ground 3
-4,2: ground 3
-3,2: ether
-2,2: ground 3
-1,2: ground 3
0,2: ether
1,2: ether
2,2: ground 3
-4,3: ground 3
-3,3: ground 3
-2,3: ground 3 !ravager
-1,3: ground 3
0,3: ground 3
1,3: ground 3 !husk
-4,4: ground 3 !stalker
-3,4: ground 3
-2,4: ground 3
-1,4: ground 3
0,4: ground 3`,
        `# A long walled corridor with pockets off either side. Raiders fill the
# pockets, brutes plug the far end and the wardens and stalkers hold the middle.
id: the-gauntlet
title: The Gauntlet
radius: 7
4,-4: ground 2 !stalker
7,-4: ground 3
-3,-3: ground 2 !raider
3,-3: ground 2 !raider
6,-3: ground 3
7,-3: ground 3
-5,-2: wall 4
-4,-2: wall 4
-2,-2: wall 4
-1,-2: wall 4
1,-2: wall 4
2,-2: wall 4
4,-2: wall 4
5,-2: wall 4
7,-2: wall 4
2,-1: ground 2 !warden
6,-1: ground 2 !brute
2,0: ground 2 !warden
6,0: ground 2 !brute
-7,2: wall 4
-5,2: wall 4
-4,2: wall 4
-2,2: wall 4
-1,2: wall 4
1,2: wall 4
2,2: wall 4
4,2: wall 4
5,2: wall 4
-3,3: ground 2 !raider
3,3: ground 2 !raider
-4,5: ground 2 !stalker`,
        `# Pits and mounds where the bombardiers nest. They lob from the mounds
# while hammerheads and raiders guard the pits between them.
id: bombardier-hive
title: Bombardier Hive
radius: 6
4,-5: ground 2 !raider
0,-4: ground 3
1,-4: ground 3
3,-4: ground 3
4,-4: ground 3
-1,-3: ground 3
0,-3: ground 4
1,-3: ground 3
2,-3: ground 3
3,-3: ground 4 !bombardier
4,-3: ground 3
-1,-2: ground 3
0,-2: ground 3
2,-2: ground 3
3,-2: ground 3
-3,-1: ground 3
-2,-1: ground 3
0,-1: ground 1
1,-1: ground 1 !hammerhead
3,-1: ground 3
4,-1: ground 3
-4,0: ground 3
-3,0: ground 4 !stripedBombardier
-2,0: ground 3
-1,0: ground 1
0,0: ground 0
1,0: ground 1
2,0: ground 3
3,0: ground 4 !bombardier
4,0: ground 3
-4,1: ground 3
-3,1: ground 3
-1,1: ground 1 !hammerhead
0,1: ground 1
2,1: ground 3
3,1: ground 3
-3,2: ground 3
-2,2: ground 3
0,2: ground 3
1,2: ground 3
-4,3: ground 3
-3,3: ground 4 !bombardier
-2,3: ground 3
-1,3: ground 3
0,3: ground 4 !stripedBombardier
1,3: ground 3
-4,4: ground 3
-3,4: ground 3
-1,4: ground 3
0,4: ground 3
-4,5: ground 2 !raider`,
        // ----- STASIS COLONIES - the garrisons (50-70 on the difficulty scale) -----
        `# A raised dais in a ring of standing stones: the Colony Warden holds the
# centre with its servitors around it. The stones make every approach a lane.
id: warden-sanctum
title: Warden Sanctum
radius: 5
2,-4: wall 4
-2,-2: wall 4
0,-2: ground 3
1,-2: ground 3
2,-2: ground 3 !wardenServitor
4,-2: wall 4
-1,-1: ground 3
0,-1: ground 4
1,-1: ground 4
2,-1: ground 3
-2,0: ground 3
-1,0: ground 4
0,0: ground 4 !colonyWarden
1,0: ground 4
2,0: ground 3
-2,1: ground 3
-1,1: ground 4
0,1: ground 4
1,1: ground 3
-4,2: wall 4
-2,2: ground 3 !wardenServitor
-1,2: ground 3
0,2: ground 3 !wardenServitor
2,2: wall 4
-2,4: wall 4`,
        `# The brood swarms in a pit two steps down. Its walls step up in rings, so
# the husks have to climb out and the party has the height - until it does not.
id: brood-pit
title: Brood Pit
radius: 5
0,-5: ground 4
5,-5: ground 4
0,-4: ground 3
1,-4: ground 3
2,-4: ground 3
3,-4: ground 3
4,-4: ground 3
-1,-3: ground 3
4,-3: ground 3
-2,-2: ground 3
0,-2: ground 1
1,-2: ground 1
2,-2: ground 1
4,-2: ground 3
-3,-1: ground 3
-1,-1: ground 1
0,-1: ground 0
1,-1: ground 0 !broodHusk
2,-1: ground 1
4,-1: ground 3
-5,0: ground 4
-4,0: ground 3
-2,0: ground 1
-1,0: ground 0 !broodHusk
0,0: ground 0 !broodHusk
1,0: ground 0 !broodHusk
2,0: ground 1
4,0: ground 3
5,0: ground 4
-4,1: ground 3
-2,1: ground 1
-1,1: ground 0 !broodHusk
0,1: ground 0 !broodHusk
1,1: ground 1
3,1: ground 3
-4,2: ground 3
-2,2: ground 1
-1,2: ground 1
0,2: ground 1
2,2: ground 3
-4,3: ground 3
1,3: ground 3
-4,4: ground 3
-3,4: ground 3
-2,4: ground 3
-1,4: ground 3
0,4: ground 3
-5,5: ground 4
0,5: ground 4`,
        `# Two rock spires rise from the field and the pale and dark sentinels stand
# high on their shoulders, one each side. Stasis motes drift between them.
id: sentinel-spires
title: Sentinel Spires
radius: 6
3,-4: ground 3
4,-4: ground 4 !paleSentinel
2,-3: ground 3
3,-3: wall 4
4,-3: ground 3
2,-2: ground 3
3,-2: ground 3
1,-1: ground 2 !stasisMote
0,0: ground 2 !stasisMote
-3,2: ground 3
-2,2: ground 3
-4,3: ground 3
-3,3: wall 4
-2,3: ground 3
-4,4: ground 4 !darkSentinel
-3,4: ground 3`,
        `# A roofless hall of walls with the Colony Anchor on a platform at its far
# end and its tethers in the aisle. The Anchor barely moves; it does not need to.
id: anchor-hall
title: Anchor Hall
radius: 5
-1,-3: wall 4
0,-3: wall 4
1,-3: wall 4
2,-3: wall 4
3,-3: wall 4
-2,-2: wall 4
1,-2: ground 3
2,-2: ground 4 !colonyAnchor
3,-2: wall 4
-3,-1: wall 4
1,-1: ground 3
2,-1: ground 3
3,-1: wall 4
-3,0: wall 4
0,0: ground 2 !anchorTether
-3,1: wall 4
-1,1: ground 2 !anchorTether
3,1: wall 4
-3,2: wall 4
3,2: wall 4
-2,3: wall 4
-1,3: wall 4
0,3: wall 4
1,3: wall 4
2,3: wall 4`,
        `# The choristers stand in a ring around a rotten pyre and sing the land to
# sleep. Break the ring or fight it from outside; the pyre burns either way.
id: rot-choir
title: Rot Choir
radius: 6
1,-4: wall 4
3,-4: wall 4
0,-3: ground 3
1,-3: ground 3
2,-3: ground 3
3,-3: ground 3
-1,-2: ground 3
0,-2: ground 2 !rotChorister
1,-2: ground 2 !rotChorister
2,-2: ground 2 !rotChorister
3,-2: ground 3
-2,-1: ground 3
0,-1: ground 1
1,-1: ground 1
3,-1: ground 3
4,-1: wall 4
-3,0: ground 3
-2,0: ground 2 !rotChorister
-1,0: ground 1
0,0: ground 2 fire
1,0: ground 1
2,0: ground 2 !rotChorister
3,0: ground 3
-3,1: wall 4
-1,1: ground 1
0,1: ground 1
2,1: ground 3
-3,2: ground 3
-2,2: ground 2 !rotChorister
0,2: ground 2 !rotChorister
1,2: ground 3
-4,3: wall 4
-3,3: ground 3
-2,3: ground 3
-1,3: ground 3
0,3: ground 3
-1,4: wall 4`,
        `# The ground is a lattice of holes into the ether. The motes fly over it
# freely; the servitors do not, and neither does the party.
id: mote-lattice
title: Mote Lattice
radius: 5
1,-5: ether
3,-4: ether
1,-3: ether
2,-3: ground 2 !stasisMote
-2,-1: ether
0,-1: ground 3
2,-1: ether
3,-1: ground 2 !stasisMote
-3,0: ground 2 !wardenServitor
-1,0: ground 3
0,0: ground 3 !stasisMote
4,0: ether
-4,1: ether
1,1: ether
3,1: ether
-3,2: ether
-1,2: ether
2,2: ground 2 !wardenServitor
-2,3: ground 2 !stasisMote
-4,4: ether
-2,4: ether
0,4: ether`,
        `# The Colony Warden sits in a sunken court while its brood shambles up the
# steps. High ground all round the court - shoot down, or go down and fight it.
id: sunken-sanctum
title: Sunken Sanctum
radius: 5
0,-4: wall 4
4,-4: wall 4
0,-3: ground 3
1,-3: ground 3
2,-3: ground 3
3,-3: ground 3
-1,-2: ground 3
2,-2: ground 2 !wardenServitor
3,-2: ground 3
-2,-1: ground 3
0,-1: ground 1
1,-1: ground 1 !broodHusk
3,-1: ground 3
-4,0: wall 4
-3,0: ground 3
-1,0: ground 1
0,0: ground 0 !colonyWarden
1,0: ground 1
3,0: ground 3
4,0: wall 4
-3,1: ground 3
-1,1: ground 1 !broodHusk
0,1: ground 1 !broodHusk
2,1: ground 3
-3,2: ground 3
1,2: ground 3
-3,3: ground 3
-2,3: ground 3
-1,3: ground 3
0,3: ground 3
-4,4: wall 4
0,4: wall 4`,
        `# An open yard where the Anchor has been dragged out onto a cinder floor. Its
# tethers guard the burning ground around it, and the burning ground guards them.
id: tether-yard
title: Tether Yard
radius: 6
4,-5: ground 3
5,-5: ground 3
5,-4: ground 3
0,-2: ground 2 fire
2,-2: ground 2 fire
0,-1: ground 1
1,-1: ground 1 !anchorTether
-2,0: ground 2 fire
-1,0: ground 1 !anchorTether
0,0: ground 0 !colonyAnchor
1,0: ground 1
2,0: ground 2 fire
-1,1: ground 1 !anchorTether
0,1: ground 1
-2,2: ground 2 fire
0,2: ground 2 fire
-5,4: ground 3
-5,5: ground 3
-4,5: ground 3`,
        `# Two pale sentinels stand on a broad terrace above the field and rain
# volleys down; the brood husks in the low ground below soak up the return fire.
id: pale-terrace
title: Pale Terrace
radius: 6
0,-6: ground 4
1,-6: ground 4
2,-6: ground 4 !paleSentinel
3,-6: ground 4
4,-6: ground 4
5,-6: ground 4 !paleSentinel
6,-6: ground 4
-1,-5: ground 4
0,-5: ground 4
1,-5: ground 4
2,-5: ground 4
3,-5: ground 4
4,-5: ground 4
5,-5: ground 4
6,-5: ground 4
-2,-4: ground 3
-1,-4: ground 3
0,-4: ground 3
1,-4: ground 3
2,-4: ground 3
3,-4: ground 3
4,-4: ground 3
5,-4: ground 3
6,-4: ground 3
-3,-3: ground 3
-4,-2: ground 3
-3,0: ground 1
-2,0: ground 1
-1,0: ground 1 !broodHusk
0,0: ground 1
1,0: ground 1 !broodHusk
2,0: ground 1
3,0: ground 1
-3,1: ground 1
-2,1: ground 1 !broodHusk
-1,1: ground 1
0,1: ground 1 !broodHusk
1,1: ground 1
2,1: ground 1`,
        `# An orchard of dead trunks where the dark sentinels shelter and the
# choristers sing among the rows. A mote hovers at the heart of it.
id: dark-orchard
title: Dark Orchard
radius: 6
3,-6: ground 2 !rotChorister
2,-5: wall 4
4,-5: wall 4
0,-4: wall 4
6,-4: wall 4
3,-3: ground 2 !darkSentinel
-2,-2: wall 4
-1,-2: ground 2 !rotChorister
2,-2: wall 4
4,-2: wall 4
0,-1: wall 4
-4,0: wall 4
-1,0: ground 3
0,0: ground 2 !stasisMote
1,0: ground 3
-2,1: wall 4
2,1: wall 4
4,1: wall 4
-3,2: ground 2 !darkSentinel
0,2: wall 4
1,2: ground 2 !rotChorister
-4,3: wall 4
-6,4: wall 4
-2,4: wall 4
-3,5: ground 2 !rotChorister`,
        // ----- THE STASIS SEED - the boss fights (80-100) -----
        `# The Forge Tyrant's own furnace: a ring of fire around the anvil-stone at
# the centre, hounds at the edges of the light, the Shadow lurking behind the stone.
id: forge-heart
title: Forge Heart
radius: 6
6,-6: wall 4
0,-5: ground 3
1,-5: ground 3
2,-5: ground 3
3,-5: ground 3
4,-5: ground 3
5,-5: ground 3
-1,-4: ground 3
4,-4: ground 2 !forgeHound
5,-4: ground 3
-3,-3: wall 4
-2,-3: ground 3
0,-3: ground 1
1,-3: ground 1
2,-3: ground 1
3,-3: ground 1
5,-3: ground 3
6,-3: wall 4
-3,-2: ground 3
-1,-2: ground 1
0,-2: ground 2 fire
1,-2: ground 2 fire
2,-2: ground 2 fire
3,-2: ground 1
5,-2: ground 3
-4,-1: ground 3
-2,-1: ground 1
-1,-1: ground 2 fire
0,-1: ground 3
1,-1: ground 3 !forgeTyrant
2,-1: ground 2 fire
3,-1: ground 1
5,-1: ground 3
-5,0: ground 3
-3,0: ground 1
-2,0: ground 2 fire
-1,0: ground 3
0,0: wall 4
1,0: ground 3
2,0: ground 2 fire
3,0: ground 1
5,0: ground 3
-5,1: ground 3
-3,1: ground 1
-2,1: ground 2 fire
-1,1: ground 3 !tyrantsShadow
0,1: ground 3
1,1: ground 2 fire
2,1: ground 1
4,1: ground 3
-5,2: ground 3
-3,2: ground 1
-2,2: ground 2 fire
-1,2: ground 2 fire
0,2: ground 2 fire
1,2: ground 1
3,2: ground 3
-6,3: wall 4
-5,3: ground 3
-3,3: ground 1
-2,3: ground 1
-1,3: ground 1
0,3: ground 1
2,3: ground 3
3,3: wall 4
-5,4: ground 3
-4,4: ground 2 !forgeHound
0,4: ground 2 !forgeHound
1,4: ground 3
-5,5: ground 3
-4,5: ground 3
-3,5: ground 3
-2,5: ground 3
-1,5: ground 3
0,5: ground 3
-6,6: wall 4`,
        `# The Warden of the Rim stands on its rampart: a wall two steps high across
# the whole field, ether beyond it, and one ramp at either end for the sentries to hold.
id: rim-wall
title: The Rim Wall
radius: 7
0,-7: ether
1,-7: ether
2,-7: ether
3,-7: ether
4,-7: ether
5,-7: ether
6,-7: ether
7,-7: ether
-1,-6: ether
0,-6: ether
1,-6: ether
2,-6: ether
3,-6: ether
4,-6: ether
5,-6: ether
6,-6: ether
7,-6: ether
-2,-5: ether
-1,-5: ether
0,-5: ether
1,-5: ether
2,-5: ether
3,-5: ether
4,-5: ether
5,-5: ether
6,-5: ether
7,-5: ether
-3,-4: ether
-2,-4: ether
-1,-4: ether
0,-4: ether
1,-4: ether
2,-4: ether
3,-4: ether
4,-4: ether
5,-4: ether
6,-4: ether
7,-4: ether
-4,-3: ether
-3,-3: ether
-2,-3: ether
-1,-3: ether
0,-3: ether
1,-3: ether
2,-3: ether
3,-3: ether
4,-3: ether
5,-3: ether
6,-3: ether
7,-3: ether
-6,-1: ground 3
-5,-1: ground 3
-4,-1: ground 3
-3,-1: ground 3
-2,-1: ground 3
-1,-1: ground 3
0,-1: ground 3
1,-1: ground 3
2,-1: ground 3
3,-1: ground 3
4,-1: ground 3
5,-1: ground 3
6,-1: ground 3
7,-1: ground 3
-7,0: ground 3
-6,0: ground 4 !rimSentry
-5,0: ground 4
-4,0: ground 4
-3,0: ground 4
-2,0: ground 4
-1,0: ground 4
0,0: ground 4 !wardenOfTheRim
1,0: ground 4
2,0: ground 4
3,0: ground 4
4,0: ground 4
5,0: ground 4
6,0: ground 4 !rimSentry
7,0: ground 3
-7,1: ground 3
-3,1: ground 2 !rimSentry
3,1: ground 2 !rimSentry
6,1: ground 3`,
        `# A nave of stone columns and the Husk Choir singing between them, nine
# strong. They are slow and witless and there are a great many of them.
id: choir-nave
title: Choir Nave
radius: 6
0,-3: wall 4
2,-3: wall 4
4,-3: wall 4
1,-2: ground 3
3,-2: ground 3
-2,-1: wall 4
-1,-1: ground 2 !choirHusk
0,-1: wall 4
1,-1: ground 2 !choirHusk
2,-1: wall 4
3,-1: ground 2 !choirHusk
4,-1: wall 4
-3,0: ground 2 !choirHusk
-1,0: ground 3
1,0: ground 3
3,0: ground 3
-4,1: wall 4
-2,1: wall 4
0,1: wall 4
2,1: wall 4
4,1: wall 4
-3,2: ground 3
-1,2: ground 2 !choirHusk
1,2: ground 2 !choirHusk
3,2: ground 2 !choirHusk
-4,3: wall 4
-3,3: ground 2 !choirHusk
-2,3: wall 4
0,3: wall 4
-1,4: ground 2 !choirHusk`,
        `# A great lake of ether with the Leviathan coiled over the island at its
# heart. The land is a ring around the deep; the Leviathan and its spawn need no land.
id: leviathan-deep
title: Leviathan Deep
radius: 7
0,-7: wall 4
7,-7: wall 4
0,-5: ground 3
1,-5: ground 3
2,-5: ground 3
3,-5: ground 3
4,-5: ground 3
5,-5: ground 3
-1,-4: ground 3
5,-4: ground 3
7,-4: wall 4
-4,-3: wall 4
-2,-3: ground 3
0,-3: ground 1 !etherSpawn
1,-3: ether
2,-3: ether
3,-3: ground 1 !etherSpawn
5,-3: ground 3
-3,-2: ground 3
-1,-2: ether
0,-2: ether
1,-2: ether
2,-2: ether
3,-2: ether
5,-2: ground 3
-4,-1: ground 3
-2,-1: ether
-1,-1: ether
0,-1: ether
1,-1: ether
2,-1: ether
3,-1: ether
5,-1: ground 3
-5,0: ground 3
-3,0: ether
-2,0: ether
-1,0: ether
0,0: ground 3 !etherLeviathan
1,0: ether
2,0: ether
3,0: ether
5,0: ground 3
-5,1: ground 3
-3,1: ether
-2,1: ether
-1,1: ether
0,1: ether
1,1: ether
2,1: ether
4,1: ground 3
-5,2: ground 3
-3,2: ether
-2,2: ether
-1,2: ether
0,2: ether
1,2: ether
3,2: ground 3
-5,3: ground 3
-3,3: ground 1 !etherSpawn
-2,3: ether
-1,3: ether
0,3: ground 1
2,3: ground 3
4,3: wall 4
-7,4: wall 4
-5,4: ground 3
1,4: ground 3
-5,5: ground 3
-4,5: ground 3
-3,5: ground 3
-2,5: ground 3
-1,5: ground 3
0,5: ground 3
-7,7: wall 4
0,7: wall 4`,
        `# One half of the field stands high and pale, the other lies low and dark,
# split by a broken ridge. The Pale Stalker hunts one half, the Dark the other, the shades both.
id: twin-shadows
title: Twin Shadows
radius: 6
0,-6: ground 4
1,-6: ground 4
2,-6: ground 4
3,-6: ground 4
4,-6: ground 4
5,-6: ground 4
6,-6: ground 3
-1,-5: ground 4
0,-5: ground 4
1,-5: ground 4
2,-5: ground 4
3,-5: ground 4
4,-5: ground 3 !stalkerShade
5,-5: ground 3
6,-5: ground 3
-2,-4: ground 4
-1,-4: ground 4
0,-4: ground 4
1,-4: ground 4
2,-4: ground 3
3,-4: ground 3
4,-4: ground 3
5,-4: ground 3
6,-4: ground 3
-3,-3: ground 4
-2,-3: ground 4
-1,-3: ground 4
0,-3: ground 3
1,-3: ground 3 !paleStalker
2,-3: ground 3
3,-3: ground 3
4,-3: ground 3
6,-3: wall 4
-4,-2: ground 4
-3,-2: ground 4
-2,-2: ground 3
-1,-2: ground 3
0,-2: ground 3
1,-2: ground 3
2,-2: ground 3
4,-2: wall 4
6,-2: ground 1
-5,-1: ground 4
-4,-1: ground 3
-3,-1: ground 3
-2,-1: ground 3
-1,-1: ground 3
0,-1: ground 3
2,-1: wall 4
4,-1: ground 1
5,-1: ground 1 !stalkerShade
6,-1: ground 1
-6,0: ground 3
-5,0: ground 3
-4,0: ground 3
-3,0: ground 3
-2,0: ground 3
2,0: ground 1
3,0: ground 1
4,0: ground 1
5,0: ground 1
6,0: ground 1
-6,1: ground 3
-5,1: ground 3 !stalkerShade
-4,1: ground 3
-2,1: wall 4
0,1: ground 1
1,1: ground 1
2,1: ground 1
3,1: ground 1
4,1: ground 1
5,1: ground 0
-6,2: ground 3
-4,2: wall 4
-2,2: ground 1
-1,2: ground 1
0,2: ground 1
1,2: ground 1
2,2: ground 1
3,2: ground 0
4,2: ground 0
-6,3: wall 4
-4,3: ground 1
-3,3: ground 1
-2,3: ground 1
-1,3: ground 1 !darkStalker
0,3: ground 1
1,3: ground 0
2,3: ground 0
3,3: ground 0
-6,4: ground 1
-5,4: ground 1
-4,4: ground 1
-3,4: ground 1
-2,4: ground 1
-1,4: ground 0
0,4: ground 0
1,4: ground 0
2,4: ground 0
-6,5: ground 1
-5,5: ground 1
-4,5: ground 1 !stalkerShade
-3,5: ground 0
-2,5: ground 0
-1,5: ground 0
0,5: ground 0
1,5: ground 0
-6,6: ground 1
-5,6: ground 0
-4,6: ground 0
-3,6: ground 0
-2,6: ground 0
-1,6: ground 0
0,6: ground 0`,
      ],
    },
    // SHOP MAPS: entering a shop opens the local map on one of these (every
    // shop tile rolls one at world generation, by seed). No enemies, no
    // turns: the party stands around, and the KEEPER stands on the tile
    // pinned with `@shopkeeper` - click the keeper to open the shop window
    // (the keeper is a Shopkeeper entity, src/local/battle/entity.js; the
    // flow is main.js's shop bridge). A map without an `@shopkeeper` line
    // seats the keeper in the middle.
    shop: {
      maps: [
        `# A calm terraced hollow for a wayside trader: no enemies, just a bowl of
# steps sheltered by two standing stones, the keeper's stall at the bottom.
id: wayside-hollow
radius: 3
0,0: ground 1 @shopkeeper
1,0: ground 1
0,1: ground 1
1,-1: ground 2
-1,1: ground 2
-1,0: ground 2
0,-1: ground 2
2,0: ground 3
0,2: ground 3
-2,2: ground 3
-2,0: ground 3
0,-2: ground 3
2,-2: ground 3
3,-1: wall 4
-3,2: wall 4`,
      ],
    },
  },

  // =================================================================
  //  BATTLE MAPS - which handcrafted MAPS (craftedMaps.combat.maps above, by
  //  the id in each code) a fight may roll, one row per kind of fight and one
  //  column per LAYER of the worldflake (0 = the core, 6 = the highest;
  //  config/world.js `layers`). A fight rolls one map out of its own cell,
  //  and the map brings its own enemies - so this table is the whole answer
  //  to "what fight is this". Listing a map twice doubles its odds. An EMPTY
  //  cell is not an error: that fight plays the nearest FILLED layer of the
  //  same row instead, so a half-finished table still runs.
  //  Until 2026-09-16 this was `battleSpawns`, a table of enemy GROUP ids
  //  (config/entities.js battle.enemyGroups); the groups went with the random
  //  arena generator, and the table was repurposed to name maps. Wired onto
  //  CONFIG.battle.maps by config.js; edit it here or in Settings >
  //  Encounters > Battles. Only layer 3 has maps so far - the other layers
  //  play layer 3's until they are given their own.
  // =================================================================
  battleMaps: {
    inner: {
      0: [],
      1: [],
      2: [],
      3: ['the-causeway', 'dry-creek', 'tick-nest', 'broken-cairn', 'lone-watch', 'ash-road', 'sinkhole-flats', 'terraces', 'bramble-hollow', 'bombardier-perch', 'stag-run'],
      4: [],
      5: [],
      6: [],
    },
    middle: {
      0: [],
      1: [],
      2: [],
      3: ['ember-hollow', 'raiders-camp', 'stalker-woods', 'warden-gate', 'mating-grounds', 'the-spine', 'sunken-ring', 'firing-line', 'hammer-yard', 'cinder-pits', 'old-quarry'],
      4: [],
      5: [],
      6: [],
    },
    outer: {
      0: [],
      1: [],
      2: [],
      3: ['war-camp', 'husk-tide-shore', 'ruin-hunt', 'the-bastion', 'crossing-of-fires', 'chasm-bridge', 'terraced-hill', 'broken-plateau', 'the-gauntlet', 'bombardier-hive'],
      4: [],
      5: [],
      6: [],
    },
    colonies: {
      0: [],
      1: [],
      2: [],
      3: ['warden-sanctum', 'brood-pit', 'sentinel-spires', 'anchor-hall', 'rot-choir', 'mote-lattice', 'sunken-sanctum', 'tether-yard', 'pale-terrace', 'dark-orchard'],
      4: [],
      5: [],
      6: [],
    },
    seed: {
      0: [],
      1: [],
      2: [],
      3: ['forge-heart', 'rim-wall', 'choir-nave', 'leviathan-deep', 'twin-shadows'],
      4: [],
      5: [],
      6: [],
    },
  },

  // ----- The Stasis ----------------------------------------------------
  // A single Stasis Seed spawns with the map; destroying it wins the run.
  // Four future Colony sites are picked at generation. After every player turn a line
  // grows from the Seed towards each site by "lineSpeed" tiles; when it arrives, the
  // Stasis Colony encounter spawns there (never in the same instant the player steps
  // onto the tile - spawning happens after the arrival is fully resolved).
  // Both the Seed and every active Colony wither the land around them: each gains
  // 1 / witherEvery "charge" per turn and spends 1 charge to turn one nearby
  // non-wither tile into wither terrain. There is no range limit: the rot creeps
  // outward until the whole map is withered - confront the Stasis or lose the land.
  // Each Colony carries one random debuff from "debuffs"; while the Colony is active
  // its debuff also applies to the Seed fight (duplicates stack). Clearing a Colony
  // removes its debuff and grants "rewardPicks" ability upgrade picks.
  stasis: {
    seedMinRing: 'half',      // the Seed sits on the outer rings: 'half' = floor(radius / 2)
    colonyCount: 4,
    minSpacing: 5,            // min distance between Colony sites and from the Seed (their only placement rule)
    lineSpeed: 0.5,           // tiles per player turn each line grows
    witherEvery: 2,           // turns per withered tile, per active source
    rewardPicks: 2,           // ability upgrade picks granted for clearing a Colony
    // The debuff pool. Each Colony rolls one id; values are read by the battle code.
    debuffs: {
      maxHp: { fraction: 0.25 },     // party max HP reduced by this fraction (per stack)
      damage: { amount: 2 },         // party ability damage reduced by this much (per stack)
      extraEnemies: { count: 2 },    // extra regular enemies join the fight (per stack)
    },
  },

  // ----- Rest site (built by the player) -----------------------------
  rest: {
    cost: 20,                 // supplies spent to make camp on an empty tile
    healFraction: 0.5,        // each living unit heals this fraction of its max HP
  },

  // ----- Acolyte of the Great Forge -----------------------------------
  acolyte: {
    reviveFraction: 0.5,      // a restored unit comes back with this fraction of max HP
  },

  // ----- Shop ---------------------------------------------------------
  // Every shop stocks the "guaranteed" options plus "randomCount" options drawn (seeded,
  // at map creation) from "pool". Each option can be bought ONCE per shop; sold-out
  // options stay in the window greyed out. Once a shop has been entered, hovering its
  // tile (from anywhere on the map) lists what it still sells.
  // Option ids and what they do:
  //   upgrade    one ability upgrade pick (the same chooser as a battle reward)
  //   map        reveals events.blobSize tiles nearby ("Information")
  //   rest       exactly a player-built camp: heals rest.healFraction and resets fatigue
  //   relic      for now identical to "upgrade": one ability upgrade pick
  //   rumors     reveals events.rumorsCount hidden battles within events.rumorsRadius
  //   spareParts the Acolyte's service: one disabled unit returns at acolyte.reviveFraction HP
  // The shop is a LOCAL-MAP encounter (since 2026-09-24): entering it dives
  // into its handcrafted map (craftedMaps.shop above) where the KEEPER
  // stands; clicking the keeper opens the window, with one big card per
  // option (icon, name, price, what it does - `icons` below are the cards'
  // icons). An option that opens a window of its own (Training's upgrade
  // chooser, Spare Parts' unit pick) replaces the shop window until that
  // one is done, then the shop window is back.
  shop: {
    guaranteed: ['upgrade', 'map'],
    pool: ['rest', 'relic', 'rumors', 'spareParts'],
    randomCount: 2,
    upgradeCost: 25,
    mapCost: 15,
    restCost: 15,             // a shop bed is a little cheaper than pitching your own camp (rest.cost)
    relicCost: 25,
    rumorsCost: 15,
    sparePartsCost: 30,
    icons: { upgrade: '📘', map: '🗺️', rest: '🛏️', relic: '🔮', rumors: '🗣️', spareParts: '🔧' },
    // The keeper standing in the shop's arena: its icon plate and body colour
    // (the name is the locale row shop.keeper.name).
    keeper: { icon: '🧔', color: 0x45c7d1 },
  },

  // ----- Treasure -----------------------------------------------------
  treasure: { supplies: 40 },

  // ----- The Hack terminal --------------------------------------------
  // A flat board strewn with NODES (objects of 1-3 discs; every attack that
  // lands on one takes exactly one disc) and MINES (a blow on one hurts the
  // caster). The party aims and fires the ordinary way (aim locks, the
  // volley) for `turns` volleys; nodes brought down are graded into BADGES,
  // and the badge count is how many upgrade OPTIONS the reward window
  // offers (one badge = take what was rolled, two = choose between two,
  // three = between three; none = no reward, the terminal is consumed).
  // The board is GENERATED, not handcrafted: buildHackRecipe in
  // src/local/localmap.js seats the party and spreads the pieces evenly
  // over the rest of the board (a blue-noise spread; the numbers below are
  // its knobs). There are no handcrafted hack boards today - if any are
  // written, they are map codes and go in `craftedMaps` above, next to the
  // combat and shop maps. The pieces are HackNode / HackMine in
  // src/local/battle/entity.js, the rules createHackRules in
  // src/local/battle/engine.js, the panel and the disc stacks
  // createHackView in src/local/localview.js, and the flow lives in main.js
  // (the Hack section) and game.js (startHack / finishHack). The texts are
  // locale rows (hack.*).
  hack: {
    // ----- the board -------------------------------------------------
    radius: 7,          // rings of local hexes (the arena is completely flat)
    nodes: 16,          // nodes on the board
    mines: 8,           // mines on the board
    nodeHp: [1, 3],     // every node's hp (its discs) is a seeded roll in this range, both ends included
    // The spread: the pieces are scattered at random but at the WIDEST
    // spacing the board can fit that many at, so they come out evenly spaced
    // over the whole board. These are the floors under that spacing - two
    // nodes are never nearer than nodeSpacing (2 = never adjacent), two
    // mines never nearer than mineSpacing; a mine may sit next to a node.
    nodeSpacing: 2,
    mineSpacing: 1,
    // Where the party is seated: 'centre' (within partyRingMax of the
    // middle) or 'edge' (a cluster on one random side of the rim). The first
    // ring around the party is always free of pieces.
    partyStart: 'centre',
    partyRingMax: 1,

    // ----- the rules -------------------------------------------------
    turns: 5,           // End-turn volleys the player gets; the encounter ends after the last
    // The BADGES: nodes that must be down to earn each one, lowest first. The
    // count earned is the number of upgrade OPTIONS the reward window offers.
    // (Later: better upgrades should also turn up more often with more badges.)
    badges: [10, 12, 15],
    mineDamage: 3,      // hp the aiming unit loses per blow that lands on a mine
    mineLethal: false,  // false = mine damage never takes a unit below 1 hp

    // ----- presentation ----------------------------------------------
    // A node's body is a STACK of bevelled discs, one per hp, in the node's
    // colour; damage takes discs off the BOTTOM and the rest settle down onto
    // the tile. The node's icon rides on top; a mine is its icon on the
    // tile. Discs the planned volley would take are drawn darker.
    discs: {
      radius: 0.7,        // of the tile radius (1 = the whole tile)
      height: 0.5,        // world units per disc
      gap: 0.012,         // air between two discs
      bevel: 0.018,       // the rounded edge, world units
      settleMs: 1000,     // how long the survivors take to drop
    },
  },



  // ----- Event effects (see events.js for the texts) ------------------
  events: {
    blobSize: 8,              // tiles revealed by "Friendly pilgrim" and the shop's map purchase
    blobMaxDistance: 4,       // the blob starts within this distance of the party
    rumorsRadius: 3,
    rumorsCount: 3,
    vantageRadius: 2,
    vantageMountainRadius: 5,
    suppliesMin: 10,
    suppliesMax: 20,
    // "Wandering scholar": ONE random living unit unlocks one random available
    // ability upgrade. "Black market": a chosen unit sacrifices max HP for one.
    blackMarketHpFraction: 1 / 3,  // max HP sacrificed for the black market upgrade
    // "Merchant caravan" acts as a rest site: same healing as a camp (rest.healFraction).
  },



  // ----- Fatigue -----------------------------------------------------
  // *** DISABLED AS AN EXPERIMENT, 2026-09-22 ***
  // Fatigue is switched off (enabled: false below) to see how the world map plays
  // without a probability gate on encounters. While it is off:
  //   * stepping onto a tile holding a forceable encounter ALWAYS drags the party
  //     into it - `forceable` below still says WHICH encounters do that, but the
  //     roll is gone and the chance is flat 100%;
  //   * `byStep` is not consulted, state.fatigue stays 0, the fatigue bar at the
  //     top of the screen is hidden and the hover tip drops its fatigue lines;
  //   * `resetOn` still fires (it also resets state.fatigueSteps, which the
  //     tutorial scenarios time their scripted ambushes off), but resets nothing
  //     the player can see.
  // NOTHING has been deleted: flip `enabled` back to true and the old rolled
  // behaviour, the bar and the tips all come back exactly as they were. The
  // pacing job fatigue used to do is now carried by supplies (config.js `run`:
  // stepSupplyCost drains the pack every step, and 0 supplies ends the run).
  //
  // (For when it is switched back on: fatigue = chance (in %) that arriving on a
  // tile WITH a forceable encounter forces the party into it. It rises with the
  // number of steps taken since the last reset. The chance rolled on arrival is
  // the fatigue shown in the HUD at the moment you click (the value BEFORE the
  // step); the step then raises it. "byStep" maps a step number -> fatigue %.
  // Steps missing from the table are interpolated linearly between their
  // neighbours; steps outside the table are clamped to the first / last entry.)
  fatigue: {
    // The experiment switch. false = no rolls, forceable encounters always fire.
    enabled: false,
    // What engaging each encounter does to fatigue:
    //   'always'   resets it to 0
    //   'optional' may reset it (see the note), e.g. the shop only if you buy a rest
    //   'never'    leaves it alone
    // "camp" = making camp on an empty tile. Unlisted types count as 'never'.
    resetOn: {
      battle: 'always',
      stasisSeed: 'always',
      stasisColony: 'always',
      acolyte: 'always',
      camp: 'always',
      shop: 'optional',
      event: 'optional',
      treasure: 'never',
      gate: 'never',
      hack: 'always',     // a hack, won or lost, is a rest of sorts
    },
    // Notes for the 'optional' ones are in the locale tables (reset.note.<type>).
    // Which encounters the party can be FORCED into on arrival. With fatigue
    // enabled this is the set the roll applies to; with fatigue disabled (the
    // current experiment) every one of them fires on arrival, always.
    forceable: ['battle', 'stasisSeed', 'stasisColony', 'event'],
    byStep: {
      4: 0,
      5: 5,
      6: 15,
      7: 30,
      8: 50,
      9: 75
    },
  },
};
