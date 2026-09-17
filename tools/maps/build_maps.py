#!/usr/bin/env python3
"""Authoring helper for the 45 handcrafted Everlands arenas (2026-09-16).

Usage: python3 tools/maps/build_maps.py out.json, then node tools/maps/validate.mjs out.json.
The codes in config/encounters.js were emitted from here; edit a map here,
regenerate, validate, and paste the code back.

Each map is a function that paints tiles onto a dict and returns metadata.
The output is a JSON list of map codes (id, title, band, code) that a node
validator then parses with the game's own src/local/mapcode.js.

Coordinates are axial (q, r); a tile is inside radius R when
max(|q|, |r|, |q+r|) <= R. Elevation: 2 = neutral ground, 3/4 up, 1/0 down;
walls default to 4; ether has no height. Ground units cannot step across a
height gap of more than 1 level, so plateaus at 4 need a ramp of 3s.
"""
import json, sys, os

DIRS = [(1, 0), (-1, 0), (0, 1), (0, -1), (1, -1), (-1, 1)]
# Directions by "clock": E, NE, NW, W, SW, SE (axial, pointy-top reading).
E, NE, NW, W, SW, SE = (1, 0), (1, -1), (0, -1), (-1, 0), (-1, 1), (0, 1)


def dist(a, b):
    (q1, r1), (q2, r2) = a, b
    return max(abs(q1 - q2), abs(r1 - r2), abs(q1 + r1 - q2 - r2))


def inside(k, R):
    return dist(k, (0, 0)) <= R


def disk(R, center=(0, 0)):
    cq, cr = center
    out = []
    for q in range(-R, R + 1):
        for r in range(-R, R + 1):
            if max(abs(q), abs(r), abs(q + r)) <= R:
                out.append((q + cq, r + cr))
    return out


def ring(n, center=(0, 0)):
    return [k for k in disk(n, center) if dist(k, center) == n]


def line(start, d, n):
    q, r = start
    return [(q + d[0] * i, r + d[1] * i) for i in range(n)]


def add(a, b):
    return (a[0] + b[0], a[1] + b[1])


class Arena:
    def __init__(self, id, title, radius, band, note):
        self.id, self.title, self.radius, self.band, self.note = id, title, radius, band, note
        self.tiles = {}   # (q,r) -> dict(type, elev, tags, enemy)

    def _t(self, k):
        if not inside(k, self.radius):
            raise ValueError(f"{self.id}: tile {k} outside radius {self.radius}")
        return self.tiles.setdefault(k, {'type': 'ground', 'elev': None, 'tags': [], 'enemy': None})

    def ground(self, keys, elev=None, tags=()):
        for k in (keys if isinstance(keys, list) else [keys]):
            t = self._t(k)
            t['type'] = 'ground'
            if elev is not None:
                t['elev'] = elev
            for tag in tags:
                if tag not in t['tags']:
                    t['tags'].append(tag)
        return self

    def wall(self, keys):
        for k in (keys if isinstance(keys, list) else [keys]):
            t = self._t(k)
            t['type'] = 'wall'; t['elev'] = None; t['tags'] = []; t['enemy'] = None
        return self

    def ether(self, keys):
        for k in (keys if isinstance(keys, list) else [keys]):
            t = self._t(k)
            t['type'] = 'ether'; t['elev'] = None; t['tags'] = []; t['enemy'] = None
        return self

    def fire(self, keys):
        return self.ground(keys, tags=('fire',))

    def enemy(self, k, name, elev=None):
        t = self._t(k)
        if t['type'] != 'ground':
            raise ValueError(f"{self.id}: enemy {name} on {t['type']} tile {k}")
        if t['enemy']:
            raise ValueError(f"{self.id}: two enemies on {k}")
        t['enemy'] = name
        if elev is not None:
            t['elev'] = elev
        return self

    def code(self):
        lines = [f"# {l}" for l in self.note.split('\n')]
        lines += [f"id: {self.id}", f"title: {self.title}", f"radius: {self.radius}"]
        for k in sorted(self.tiles, key=lambda k: (k[1], k[0])):
            t = self.tiles[k]
            if t['type'] == 'ground' and t['elev'] in (None, 2) and not t['tags'] and not t['enemy']:
                continue   # plain neutral ground: not listed
            parts = [f"{k[0]},{k[1]}:", t['type']]
            if t['type'] == 'wall':
                parts.append('4')
            elif t['type'] == 'ground':
                parts.append(str(2 if t['elev'] is None else t['elev']))
                parts += t['tags']
            if t['enemy']:
                parts.append(f"!{t['enemy']}")
            lines.append(' '.join(parts))
        return '\n'.join(lines)


MAPS = []


def arena(id, title, radius, band, note):
    a = Arena(id, title, radius, band, note)
    MAPS.append(a)
    return a


# ======================================================================
#  INNER RINGS - 1..5 weak creatures, radius 4..5
# ======================================================================

a = arena('dry-creek', 'Dry Creek', 4, 'inner',
          'A sunken creek bed winds across the arena; the raiders wait on the far bank\nwhere the ground rises again. Cross in the open or go the long way round.')
creek = [(-4, 1), (-3, 1), (-2, 1), (-1, 1), (0, 0), (1, 0), (2, -1), (3, -2), (4, -3), (4, -4)]
a.ground(creek, 1)
a.ground([(0, 1), (1, -1), (-1, 0), (2, 0), (3, -1)], 1)
a.ground([(-1, -1), (0, -2), (1, -3), (2, -3), (3, -4)], 3)   # the far bank
a.ground([(0, -3), (1, -4)], 3)
a.enemy((0, -2), 'raider').enemy((2, -3), 'drifter')

a = arena('tick-nest', 'Tick Nest', 5, 'inner',
          'A bowl of soft earth with a nest of ticks at the bottom. A drifter on the\nknoll above keeps watch; the ticks come up fast once disturbed.')
a.ground(disk(1), 0)
a.ground(ring(2), 1)
a.ground([(3, -5), (4, -5), (4, -4), (3, -4)], 3)
a.ground((4, -5), 4)
a.wall([(-3, 5), (-5, 3)])
a.enemy((0, 0), 'rageTick').enemy((1, -1), 'weakTick').enemy((-1, 1), 'frailTick').enemy((0, 1), 'rushTick')
a.enemy((4, -5), 'drifter')

a = arena('broken-cairn', 'Broken Cairn', 4, 'inner',
          'The toppled stones of an old cairn stand about the middle of the field;\nthree husks shamble between them. The stones break lines of fire both ways.')
a.wall([(0, 0), (2, -1), (-1, 2), (-2, 0), (1, 1), (0, -2)])
a.ground([(1, -1), (-1, 1), (1, 0), (-1, 0)], 3)
a.enemy((1, -2), 'husk').enemy((-2, 2), 'husk').enemy((3, 0), 'husk')

a = arena('lone-watch', 'Lone Watch', 4, 'inner',
          'A single hill with a flat top and one honest ramp up. A lone raider holds\nthe summit and has the height advantage on anyone climbing the ramp.')
a.ground(ring(1, (1, -1)), 3)
a.ground((1, -1), 4)
a.ground([(2, 0), (3, 0)], 3)     # the ramp down the south-east side
a.ground([(-2, 2), (-3, 3)], 1)
a.enemy((1, -1), 'raider')

a = arena('ash-road', 'Ash Road', 4, 'inner',
          'A road lined with still-burning braziers runs straight through the field.\nA husk and a drifter loiter at the far end; the fires punish a careless shove.')
road = line((-4, 0), E, 9)
a.fire([(-3, -1), (-1, -1), (1, -1), (3, -1), (-3, 1), (-1, 1), (1, 1), (3, 1)])
a.ground([(-2, -2), (0, -2), (2, -2), (-2, 2), (0, 2), (2, 2)], 3)
a.enemy((3, 0), 'husk').enemy((4, -1), 'drifter')

a = arena('sinkhole-flats', 'Sinkhole Flats', 5, 'inner',
          'Flat ground pocked with two sinkholes into the ether. The beasts here charge:\na stag and a hammerhead - stand next to a hole and one of you goes in.')
a.ether([(1, -3), (2, -3), (2, -4), (-2, 2), (-3, 3), (-2, 3)])
a.ground([(4, -2), (4, -1), (3, -1)], 3)
a.ground([(-4, 1), (-4, 2)], 1)
a.enemy((3, -2), 'stag').enemy((-3, 1), 'hammerhead')

a = arena('terraces', 'The Terraces', 4, 'inner',
          'Old farming terraces climb the north side step by step. A scouting pair sits\non the top step and shoots down at whoever comes up.')
a.ground([(q, -2) for q in range(-2, 5)], 3)
a.ground([(q, -3) for q in range(-1, 5)], 3)
a.ground([(q, -4) for q in range(0, 5)], 4)
a.ground([(-3, 4), (-4, 4), (-4, 3)], 1)
a.enemy((1, -4), 'raider').enemy((3, -4), 'drifter')

a = arena('bramble-hollow', 'Bramble Hollow', 4, 'inner',
          'A hollow ringed with thorn-choked rock. Strays hide in the low ground;\nthe way in is over the lip, and the lip is the high ground.')
a.ground(disk(2), 1)
a.ground(disk(1), 0)
a.wall([(3, -1), (3, -3), (-3, 3), (-3, 1), (0, 3), (0, -3)])
a.ground([(2, 0), (-2, 0)], 3)
a.enemy((0, 0), 'husk').enemy((1, -1), 'drifter').enemy((-1, 1), 'husk')

a = arena('bombardier-perch', 'Bombardier Perch', 5, 'inner',
          'A tall rock in the middle of the field is a bombardier\'s favourite perch.\nIts lobbed bursts reach far; the drifter and the husk guard the ramp up.')
a.ground([(0, 0)], 4)
a.ground(ring(1), 3)
a.ground([(2, 0), (0, 2)], 3)
a.wall([(-2, 0), (0, -2), (2, -2)])
a.ground([(-4, 4), (-3, 4), (-4, 3)], 1)
a.enemy((0, 0), 'bombardier').enemy((2, 1), 'drifter').enemy((1, 2), 'husk')

a = arena('stag-run', 'Stag Run', 5, 'inner',
          'Two lines of standing stones make a run down the middle of the field. Stags\ncharge along it; a rusher tick skitters in behind them.')
a.wall([(-3, -1), (-1, -1), (1, -1), (3, -1)])
a.wall([(-3, 2), (-1, 2), (1, 2), (3, 2)])
a.ground([(-5, 3), (-5, 4), (-4, 4)], 3)
a.enemy((4, 0), 'stag').enemy((4, -2), 'stag').enemy((5, -1), 'rushTick')

# ======================================================================
#  MIDDLE RINGS - 3..6 creatures, radius 5..6
# ======================================================================

a = arena('raiders-camp', "Raiders' Camp", 5, 'middle',
          'A raiding party camps behind a broken palisade. The gaps in the wall are the\nonly way in, and the campfires inside burn anyone shoved into them.')
pal = [(-2, -1), (-1, -2), (1, -3), (2, -3), (3, -2), (3, -1), (2, 1), (1, 2), (-1, 3), (-2, 3), (-3, 2), (-3, 1)]
a.wall(pal)
a.fire([(0, 0), (1, -1)])
a.ground([(-4, 1), (-4, 2)], 3)
a.enemy((0, -2), 'raider').enemy((2, -1), 'raider').enemy((-1, 1), 'raider').enemy((0, 1), 'stalker').enemy((1, 0), 'warden')

a = arena('stalker-woods', 'Stalker Woods', 6, 'middle',
          'Dead trunks stand thick across the arena and a stalker pack uses every one\nof them. Nothing has a clear line for long; the drifter shoots over it all.')
trunks = [(-4, 1), (-3, -1), (-2, 3), (-1, -3), (0, 1), (1, -1), (2, 2), (3, -3), (3, 0), (4, -1), (-5, 4), (1, 4), (-1, 5), (5, -4)]
a.wall(trunks)
a.ground([(0, -1), (-1, 0), (1, 0)], 3)
a.enemy((2, -4), 'stalker').enemy((4, -3), 'stalker').enemy((3, 1), 'stalker').enemy((5, -2), 'stalker').enemy((4, -5), 'drifter')

a = arena('warden-gate', 'Warden Gate', 5, 'middle',
          'A wall runs clean across the field with one gate in it. Two wardens hold the\ngate from a raised step; a brute waits behind them where the gate opens.')
wallline = [(q, 0) for q in range(-5, 6) if q not in (0, 1)]
a.wall(wallline)
a.ground([(0, 0), (1, 0)], 3)
a.ground([(0, -1), (1, -1), (2, -1)], 3)
a.ground([(-2, 4), (-1, 4), (-3, 5)], 1)
a.enemy((0, 0), 'warden').enemy((1, 0), 'warden').enemy((1, -2), 'brute').enemy((3, -3), 'raider').enemy((-2, -2), 'husk')

a = arena('mating-grounds', 'Mating Grounds', 5, 'middle',
          'Boggy low ground where the striped bombardiers gather. The pools between\nthe tussocks are sunken; the bombardiers lob their nerve agent from the tussocks.')
a.ground([(-1, -1), (0, -1), (1, -2), (-2, 2), (-1, 2), (2, 0), (2, 1), (0, 3), (-3, 0)], 1)
a.ground([(0, 0), (-2, 0), (2, -2), (1, 2), (-1, 4), (3, -1)], 3)
a.enemy((0, 0), 'stripedBombardier').enemy((2, -2), 'stripedBombardier').enemy((-2, 0), 'stripedBombardier').enemy((4, -4), 'stag')

a = arena('the-spine', 'The Spine', 6, 'middle',
          'A ridge of rock runs the length of the field with a sheer drop into the ether\non its eastern flank. Whoever holds the spine shoots down; whoever is shoved east falls.')
spine = [(0, r) for r in range(-5, 6)]
a.ground(spine, 4)
a.ground([(-1, r) for r in range(-5, 6)], 3)
a.ground([(1, r) for r in range(-6, 6)], 3)
a.ether([(3, -6), (4, -6), (4, -5), (5, -5), (5, -4), (6, -4), (6, -3), (6, -2), (6, -1), (6, -0), (5, 1), (4, 2), (3, 3), (5, -6), (6, -6), (6, -5)])
a.enemy((0, -2), 'raider').enemy((0, 2), 'raider').enemy((1, -4), 'stalker').enemy((-1, 3), 'stalker').enemy((2, -1), 'hammerhead')

a = arena('sunken-ring', 'Sunken Ring', 5, 'middle',
          'A ring of ether cuts an island out of the middle of the field. Two land\nbridges cross it - north and south - and the wardens hold the island.')
moat = [k for k in ring(3) if k not in ((0, -3), (0, 3), (3, -3), (-3, 3))]
a.ether([k for k in moat if k not in ((0, -3), (0, 3))])
a.ground([(0, -3), (0, 3)], 3)
a.ground(disk(1), 3)
a.enemy((0, 0), 'warden').enemy((1, -1), 'warden').enemy((-1, 1), 'raider').enemy((1, 0), 'raider').enemy((0, -1), 'drifter')

a = arena('firing-line', 'Firing Line', 6, 'middle',
          'A long shelf of high ground along the north side is a drifter firing line;\na brute stands at the foot of the only ramp to keep the party off it.')
shelf = [(q, -5) for q in range(-1, 7)] + [(q, -6) for q in range(0, 7)]
a.ground(shelf, 4)
a.ground([(q, -4) for q in range(-2, 7)], 3)
a.wall([(-3, -3), (-4, -2)])
a.ground([(-4, 6), (-5, 6), (-6, 6)], 1)
a.enemy((1, -6), 'drifter').enemy((3, -6), 'drifter').enemy((5, -6), 'drifter').enemy((3, -3), 'brute')

a = arena('hammer-yard', 'Hammer Yard', 5, 'middle',
          'Paired stone posts turn the field into lanes, and charging beasts live for\nlanes: two hammerheads and two stags, with a raider to close the trap.')
a.wall([(-3, 0), (-3, 1), (0, -3), (1, -3), (3, -1), (3, -2), (0, 3), (-1, 3)])
a.ground([(0, 0)], 3)
a.enemy((4, -4), 'hammerhead').enemy((-4, 4), 'hammerhead').enemy((4, 0), 'stag').enemy((-4, 0), 'stag').enemy((0, -5), 'raider')

a = arena('cinder-pits', 'Cinder Pits', 5, 'middle',
          'Smouldering pits open in the ground and cinders still burn beside them.\nBombardiers lob from the rim while ticks and a raider come through the smoke.')
a.ground([(1, 1), (2, 0), (1, 2), (-2, -1), (-3, 0), (-2, 0)], 1)
a.fire([(0, 2), (3, -1), (-1, -2), (-3, 1)])
a.ground([(4, -4), (3, -4), (4, -3)], 3)
a.enemy((3, -4), 'bombardier').enemy((-4, 4), 'bombardier').enemy((0, 0), 'rageTick').enemy((-1, 1), 'rageTick').enemy((4, -1), 'raider')

a = arena('old-quarry', 'Old Quarry', 6, 'middle',
          'A quarry cut into the south-west corner: benches drop step by step to the\nfloor. The stalkers work the benches; the warden holds the floor with a drifter.')
a.ground([(-1, 2), (0, 2), (-2, 3), (-1, 3), (1, 1), (0, 3), (-3, 4)], 1)
a.ground([(-2, 4), (-1, 4), (-3, 5), (-2, 5), (0, 4), (-4, 5), (-4, 6), (-3, 6)], 0)
a.ground([(2, 2), (1, 3), (1, 4), (-5, 6), (-6, 6), (-5, 5)], 1)
a.ground([(3, -3), (4, -4), (4, -3)], 3)
a.wall([(2, 4), (-6, 4)])
a.enemy((-2, 4), 'warden').enemy((-3, 5), 'drifter').enemy((0, 2), 'stalker').enemy((-4, 6), 'stalker').enemy((1, 4), 'stalker').enemy((-2, 2), 'husk')

# ======================================================================
#  OUTER RINGS - 8..12 creatures, radius 6..7
# ======================================================================

a = arena('war-camp', 'War Camp', 6, 'outer',
          'A warband\'s camp: a stone ring with two gates and a fire in the middle.\nRavagers and brutes hold the gates, wardens the fire, stalkers hunt outside.')
ringw = [k for k in ring(3) if k not in ((3, -3), (-3, 3), (0, 3), (0, -3))]
a.wall(ringw)
a.fire([(0, 0)])
a.ground(ring(1), 3)
a.enemy((0, -3), 'ravager').enemy((0, 3), 'ravager').enemy((3, -3), 'brute').enemy((-3, 3), 'brute')
a.enemy((1, -1), 'warden').enemy((-1, 1), 'warden').enemy((5, -1), 'stalker').enemy((-5, 1), 'stalker')

a = arena('husk-tide-shore', 'Husk Tide Shore', 7, 'outer',
          'The field ends in ether along the whole eastern edge. A tide of husks\nwashes in from the north with stalkers on its flanks and a brute and a ravager driving it.')
shore = [(7, r) for r in range(-7, 1)] + [(6, r) for r in range(-6, 1)] + [(6, 1), (5, 2), (4, 3), (3, 4), (2, 5), (1, 6), (0, 7), (5, -7)]
a.ether([k for k in shore if inside(k, 7)])
a.ground([(-1, -4), (0, -4), (1, -5), (-2, -3)], 3)
husks = [(-1, -6), (1, -7), (2, -7), (0, -5), (2, -6), (3, -7)]
for i, k in enumerate(husks):
    a.enemy(k, 'husk')
a.enemy((-3, -4), 'stalker').enemy((4, -6), 'stalker').enemy((-4, -3), 'stalker')
a.enemy((1, -5), 'brute').enemy((0, -7), 'ravager')

a = arena('ruin-hunt', 'Ruin Hunt', 6, 'outer',
          'The shell of a fallen hall: wall stubs in rows, a raised floor where the\nroof used to be. Ravagers hunt through the ruins with stalkers and a warden.')
a.wall([(-4, 0), (-4, 2), (-2, -2), (-2, 4), (0, -4), (0, 4), (2, -4), (2, 2), (4, -4), (4, -2), (-3, -1), (3, -1)])
a.ground(disk(1), 3)
a.ground([(2, 0), (-2, 2)], 3)
a.enemy((0, 0), 'ravager').enemy((3, -3), 'ravager').enemy((-3, 3), 'ravager')
a.enemy((5, -5), 'stalker').enemy((-5, 5), 'stalker').enemy((1, -6), 'stalker')
a.enemy((0, -2), 'warden').enemy((4, 1), 'raider').enemy((-4, -1), 'raider')

a = arena('the-bastion', 'The Bastion', 6, 'outer',
          'A square-cut bastion rises two full steps above the field, with ramps on\nits north and south faces. Wardens and brutes hold the top; ravagers prowl below.')
a.ground(disk(2), 4)
a.ground(ring(2), 3)
a.ground([(0, -3), (0, 3), (1, -3), (-1, 3)], 3)   # ramps to the crown: a 3 next to 4 next to 2
a.ground([(0, 0), (1, -1), (-1, 1), (1, 0), (-1, 0), (0, 1), (0, -1)], 4)
a.wall([(3, -3), (-3, 3), (3, 0), (-3, 0)])
a.enemy((0, 0), 'warden').enemy((1, -1), 'warden').enemy((-1, 1), 'warden').enemy((1, 0), 'brute').enemy((-1, 0), 'brute')
a.enemy((4, -5), 'ravager').enemy((-4, 5), 'ravager').enemy((5, -2), 'raider').enemy((-5, 2), 'raider')

a = arena('crossing-of-fires', 'Crossing of Fires', 6, 'outer',
          'Two lines of burning ground cross the field, leaving a dark gap at the\nmiddle. Stalkers wait in every quarter; the ravagers hold the crossing itself.')
a.fire([(q, 0) for q in range(-6, 7) if abs(q) > 1 and q % 2 == 0])
a.fire([(0, r) for r in range(-6, 7) if abs(r) > 1 and r % 2 == 0])
a.ground(disk(1), 3)
a.enemy((0, 0), 'ravager').enemy((1, -1), 'ravager')
a.enemy((3, -5), 'stalker').enemy((-3, 5), 'stalker').enemy((4, 1), 'stalker').enemy((-4, -1), 'stalker')
a.enemy((5, -3), 'drifter').enemy((-5, 3), 'drifter').enemy((-2, -3), 'drifter')

a = arena('chasm-bridge', 'Chasm Bridge', 7, 'outer',
          'A chasm splits the field in two; a single stone bridge crosses it. Chargers\nhold the far side - the bridge is the only way over, and a shove off it is fatal.')
chasm = [(q, r) for (q, r) in disk(7) if q == 1 and r != -1 and r != 0] + [(2, r) for r in range(-7, 6) if r not in (-2, -1)]
a.ether([k for k in chasm if inside(k, 7)])
a.ground([(1, -1), (1, 0), (2, -2), (2, -1)], 2)
a.ground([(4, -3), (5, -4), (5, -3), (4, -2)], 3)
a.ground([(-5, 3), (-6, 4), (-5, 4)], 1)
a.enemy((4, -3), 'ravager').enemy((5, -4), 'ravager').enemy((4, -1), 'hammerhead').enemy((6, -5), 'hammerhead')
a.enemy((3, 1), 'stag').enemy((6, -2), 'stag').enemy((5, -1), 'raider').enemy((4, 2), 'raider')

a = arena('terraced-hill', 'Terraced Hill', 6, 'outer',
          'One great hill fills the field, terraced all the way up. Drifters shoot\nfrom the crown while brutes and wardens fight down the slopes.')
a.ground(ring(3), 3)
a.ground(disk(2), 4)
a.ground(ring(2), 3)
a.ground([(0, -3), (3, 0), (-3, 3), (0, 3), (-3, 0), (3, -3)], 3)
a.ground([(2, -1), (-1, 2), (-1, -1)], 3)   # notches: a 3 in the 4-crown so the crown is a ring of ramps
a.enemy((0, 0), 'drifter').enemy((1, -2), 'drifter').enemy((-2, 1), 'drifter').enemy((1, 1), 'drifter')
a.enemy((0, -4), 'brute').enemy((0, 4), 'brute').enemy((-4, 0), 'warden').enemy((4, -4), 'warden')

a = arena('broken-plateau', 'Broken Plateau', 6, 'outer',
          'A plateau one step up, cracked through with ether fissures. Ravagers and\nstalkers know every crack; the husks do not, and fall in when pushed.')
a.ground(disk(4), 3)
a.ground(ring(5), 2)
a.ether([(1, -3), (2, -3), (-2, 1), (-3, 2), (0, 2), (1, 2), (3, -1), (-1, -2)])
a.enemy((0, 0), 'ravager').enemy((2, -1), 'ravager').enemy((-2, 3), 'ravager')
a.enemy((4, -4), 'stalker').enemy((-4, 4), 'stalker')
a.enemy((3, -4), 'husk').enemy((-4, 1), 'husk').enemy((1, 3), 'husk').enemy((-1, -3), 'husk')

a = arena('the-gauntlet', 'The Gauntlet', 7, 'outer',
          'A long walled corridor with pockets off either side. Raiders fill the\npockets, brutes plug the far end and the wardens and stalkers hold the middle.')
a.wall([(q, -2) for q in range(-5, 8) if q % 3 != 0])
a.wall([(q, 2) for q in range(-7, 6) if q % 3 != 0])
a.ground([(6, -3), (7, -4), (7, -3)], 3)
a.enemy((-3, -3), 'raider').enemy((3, -3), 'raider').enemy((-3, 3), 'raider').enemy((3, 3), 'raider')
a.enemy((6, -1), 'brute').enemy((6, 0), 'brute')
a.enemy((2, 0), 'warden').enemy((2, -1), 'warden').enemy((4, -4), 'stalker').enemy((-4, 5), 'stalker')

a = arena('bombardier-hive', 'Bombardier Hive', 6, 'outer',
          'Pits and mounds where the bombardiers nest. They lob from the mounds\nwhile hammerheads and raiders guard the pits between them.')
mounds = [(-3, 0), (3, -3), (0, 3), (3, 0), (-3, 3), (0, -3)]
for m in mounds:
    a.ground(ring(1, m), 3)
    a.ground([m], 4)
a.ground([(0, 0), (1, -1), (-1, 1), (1, 0), (-1, 0), (0, 1), (0, -1)], 1)
a.ground([(0, 0)], 0)
a.enemy((3, -3), 'bombardier').enemy((-3, 3), 'bombardier').enemy((3, 0), 'bombardier')
a.enemy((-3, 0), 'stripedBombardier').enemy((0, 3), 'stripedBombardier')
a.enemy((1, -1), 'hammerhead').enemy((-1, 1), 'hammerhead').enemy((4, -5), 'raider').enemy((-4, 5), 'raider')

# ======================================================================
#  STASIS COLONIES - the garrisons, radius 5..6
# ======================================================================

a = arena('warden-sanctum', 'Warden Sanctum', 5, 'colonies',
          'A raised dais in a ring of standing stones: the Colony Warden holds the\ncentre with its servitors around it. The stones make every approach a lane.')
a.ground(disk(1), 4)
a.ground(ring(2), 3)
a.wall([(4, -2), (2, 2), (-2, 4), (-4, 2), (-2, -2), (2, -4)])
a.enemy((0, 0), 'colonyWarden').enemy((2, -2), 'wardenServitor').enemy((-2, 2), 'wardenServitor').enemy((0, 2), 'wardenServitor')

a = arena('brood-pit', 'Brood Pit', 5, 'colonies',
          'The brood swarms in a pit two steps down. Its walls step up in rings, so\nthe husks have to climb out and the party has the height - until it does not.')
a.ground(disk(1), 0)
a.ground(ring(2), 1)
a.ground(ring(4), 3)
a.ground([(5, -5), (-5, 5), (0, 5), (0, -5), (5, 0), (-5, 0)], 4)
for k in [(0, 0), (1, -1), (-1, 1), (1, 0), (-1, 0), (0, 1)]:
    a.enemy(k, 'broodHusk')

a = arena('sentinel-spires', 'Sentinel Spires', 6, 'colonies',
          'Two rock spires rise from the field and the pale and dark sentinels stand\nhigh on their shoulders, one each side. Stasis motes drift between them.')
a.ground(ring(1, (3, -3)), 3)
a.ground(ring(1, (-3, 3)), 3)
a.wall([(3, -3), (-3, 3)])
a.ground([(4, -4), (-4, 4)], 4)
a.ground([(3, -4), (-3, 4)], 3)
a.enemy((4, -4), 'paleSentinel').enemy((-4, 4), 'darkSentinel')
a.enemy((0, 0), 'stasisMote').enemy((1, -1), 'stasisMote')

a = arena('anchor-hall', 'Anchor Hall', 5, 'colonies',
          'A roofless hall of walls with the Colony Anchor on a platform at its far\nend and its tethers in the aisle. The Anchor barely moves; it does not need to.')
a.wall([(-3, 0), (-3, -1), (-2, -2), (-1, -3), (0, -3), (1, -3), (2, -3), (3, -3), (3, -2), (3, -1)])
a.wall([(-3, 1), (-3, 2), (-2, 3), (-1, 3), (0, 3), (1, 3), (2, 3), (3, 1), (3, 2)])
a.ground([(1, -2), (2, -2), (1, -1), (2, -1)], 3)
a.ground([(2, -2)], 4)
a.ground([(1, -2), (2, -1)], 3)
a.enemy((2, -2), 'colonyAnchor').enemy((0, 0), 'anchorTether').enemy((-1, 1), 'anchorTether')

a = arena('rot-choir', 'Rot Choir', 6, 'colonies',
          'The choristers stand in a ring around a rotten pyre and sing the land to\nsleep. Break the ring or fight it from outside; the pyre burns either way.')
a.fire([(0, 0)])
a.ground(ring(1), 1)
a.ground(ring(3), 3)
a.wall([(4, -1), (-4, 3), (1, -4), (-1, 4), (3, -4), (-3, 1)])
for k in ring(2):
    if k in ((2, -2), (2, 0), (0, 2), (-2, 2), (-2, 0), (0, -2), (1, -2)):
        a.enemy(k, 'rotChorister')

a = arena('mote-lattice', 'Mote Lattice', 5, 'colonies',
          'The ground is a lattice of holes into the ether. The motes fly over it\nfreely; the servitors do not, and neither does the party.')
holes = [(1, -3), (-2, -1), (2, -1), (-1, 2), (1, 1), (-3, 2), (3, -4), (-4, 4), (4, 0), (0, 4), (-2, 4), (3, 1), (-4, 1), (1, -5)]
a.ether(holes)
a.ground([(0, 0), (0, -1), (-1, 0)], 3)
a.enemy((0, 0), 'stasisMote').enemy((2, -3), 'stasisMote').enemy((-2, 3), 'stasisMote').enemy((3, -1), 'stasisMote')
a.enemy((-3, 0), 'wardenServitor').enemy((2, 2), 'wardenServitor')

a = arena('sunken-sanctum', 'Sunken Sanctum', 5, 'colonies',
          'The Colony Warden sits in a sunken court while its brood shambles up the\nsteps. High ground all round the court - shoot down, or go down and fight it.')
a.ground(ring(1), 1)
a.ground([(0, 0)], 0)
a.ground(ring(3), 3)
a.wall([(4, -4), (-4, 4), (4, 0), (-4, 0), (0, 4), (0, -4)])
a.enemy((0, 0), 'colonyWarden').enemy((1, -1), 'broodHusk').enemy((-1, 1), 'broodHusk').enemy((0, 1), 'broodHusk').enemy((2, -2), 'wardenServitor')

a = arena('tether-yard', 'Tether Yard', 6, 'colonies',
          'An open yard where the Anchor has been dragged out onto a cinder floor. Its\ntethers guard the burning ground around it, and the burning ground guards them.')
a.fire([(2, -2), (-2, 2), (2, 0), (-2, 0), (0, 2), (0, -2)])
a.ground(disk(1), 1)
a.ground([(0, 0)], 0)
a.ground([(5, -5), (5, -4), (4, -5), (-5, 5), (-5, 4), (-4, 5)], 3)
a.enemy((0, 0), 'colonyAnchor').enemy((1, -1), 'anchorTether').enemy((-1, 1), 'anchorTether').enemy((-1, 0), 'anchorTether')

a = arena('pale-terrace', 'Pale Terrace', 6, 'colonies',
          'Two pale sentinels stand on a broad terrace above the field and rain\nvolleys down; the brood husks in the low ground below soak up the return fire.')
a.ground([(q, -4) for q in range(-2, 7)], 3)
a.ground([(q, -5) for q in range(-1, 7)], 4)
a.ground([(q, -6) for q in range(0, 7)], 4)
a.ground([(-3, -3), (-4, -2)], 3)
a.ground([(q, 0) for q in range(-3, 4)], 1)
a.ground([(q, 1) for q in range(-3, 3)], 1)
a.enemy((2, -6), 'paleSentinel').enemy((5, -6), 'paleSentinel')
a.enemy((-1, 0), 'broodHusk').enemy((1, 0), 'broodHusk').enemy((0, 1), 'broodHusk').enemy((-2, 1), 'broodHusk')

a = arena('dark-orchard', 'Dark Orchard', 6, 'colonies',
          'An orchard of dead trunks where the dark sentinels shelter and the\nchoristers sing among the rows. A mote hovers at the heart of it.')
a.wall([(-4, 0), (-4, 3), (-2, -2), (-2, 1), (-2, 4), (0, -4), (0, -1), (0, 2), (2, -5), (2, -2), (2, 1), (4, -5), (4, -2), (4, 1), (-6, 4), (6, -4)])
a.ground([(1, 0), (-1, 0)], 3)
a.enemy((-3, 2), 'darkSentinel').enemy((3, -3), 'darkSentinel')
a.enemy((-1, -2), 'rotChorister').enemy((1, 2), 'rotChorister').enemy((-3, 5), 'rotChorister').enemy((3, -6), 'rotChorister')
a.enemy((0, 0), 'stasisMote')

# ======================================================================
#  THE STASIS SEED - boss fights, radius 6..7
# ======================================================================

a = arena('forge-heart', 'Forge Heart', 6, 'seed',
          'The Forge Tyrant\'s own furnace: a ring of fire around the anvil-stone at\nthe centre, hounds at the edges of the light, the Shadow lurking behind the stone.')
a.wall([(0, 0)])
a.fire(ring(2))
a.ground(ring(1), 3)
a.ground(ring(3), 1)
a.ground(ring(5), 3)
a.wall([(6, -6), (-6, 6), (6, -3), (-6, 3), (3, 3), (-3, -3)])
a.enemy((1, -1), 'forgeTyrant').enemy((-1, 1), 'tyrantsShadow')
a.enemy((4, -4), 'forgeHound').enemy((-4, 4), 'forgeHound').enemy((0, 4), 'forgeHound')

a = arena('rim-wall', 'The Rim Wall', 7, 'seed',
          'The Warden of the Rim stands on its rampart: a wall two steps high across\nthe whole field, ether beyond it, and one ramp at either end for the sentries to hold.')
rampart = [(q, 0) for q in range(-6, 7)]
a.ground(rampart, 4)
a.ground([(-7, 0), (7, 0), (-7, 1), (6, 1), (7, -1), (-6, -1)], 3)   # the ramps at either end
a.ground([(q, -1) for q in range(-5, 7)], 3)                        # the sentries' walk behind the wall
a.ether([(q, r) for (q, r) in disk(7) if r <= -3])
a.ground([(q, -2) for q in range(-5, 8)], 2)
a.enemy((0, 0), 'wardenOfTheRim')
a.enemy((-6, 0), 'rimSentry').enemy((6, 0), 'rimSentry').enemy((-3, 1), 'rimSentry').enemy((3, 1), 'rimSentry')

a = arena('choir-nave', 'Choir Nave', 6, 'seed',
          'A nave of stone columns and the Husk Choir singing between them, nine\nstrong. They are slow and witless and there are a great many of them.')
cols = [(-4, 1), (-4, 3), (-2, -1), (-2, 1), (-2, 3), (0, -3), (0, -1), (0, 1), (0, 3), (2, -3), (2, -1), (2, 1), (4, -3), (4, -1), (4, 1)]
a.wall(cols)
a.ground([(-1, 0), (1, 0), (3, 0), (-3, 2), (1, -2), (3, -2)], 3)
for k in [(-3, 0), (-1, -1), (1, -1), (3, -1), (-3, 3), (-1, 2), (1, 2), (3, 2), (-1, 4)]:
    a.enemy(k, 'choirHusk')

a = arena('leviathan-deep', 'Leviathan Deep', 7, 'seed',
          'A great lake of ether with the Leviathan coiled over the island at its\nheart. The land is a ring around the deep; the Leviathan and its spawn need no land.')
lake = [k for k in disk(3) if k != (0, 0)]
a.ether([k for k in lake if k not in ((3, -3), (-3, 3), (0, -3), (0, 3))])
a.ground([(0, 0)], 3)
a.ground([(3, -3), (-3, 3), (0, -3), (0, 3)], 1)   # four shallow fords into the lake ring
a.ground(ring(5), 3)
a.wall([(7, -7), (-7, 7), (7, -4), (-7, 4), (4, 3), (-4, -3), (0, 7), (0, -7)])
a.enemy((0, 0), 'etherLeviathan')
a.enemy((0, -3), 'etherSpawn').enemy((3, -3), 'etherSpawn').enemy((-3, 3), 'etherSpawn')

a = arena('twin-shadows', 'Twin Shadows', 6, 'seed',
          'One half of the field stands high and pale, the other lies low and dark,\nsplit by a broken ridge. The Pale Stalker hunts one half, the Dark the other, the shades both.')
a.ground([(q, r) for (q, r) in disk(6) if q + 2 * r < -1], 3)
a.ground([(q, r) for (q, r) in disk(6) if q + 2 * r < -6], 4)
a.ground([(q, r) for (q, r) in disk(6) if q + 2 * r > 1], 1)
a.ground([(q, r) for (q, r) in disk(6) if q + 2 * r > 6], 0)
a.wall([(4, -2), (-4, 2), (2, -1), (-2, 1), (6, -3), (-6, 3)])
a.enemy((1, -3), 'paleStalker').enemy((-1, 3), 'darkStalker')
a.enemy((4, -5), 'stalkerShade').enemy((-4, 5), 'stalkerShade').enemy((-5, 1), 'stalkerShade').enemy((5, -1), 'stalkerShade')


def main():
    out = [{'id': m.id, 'title': m.title, 'band': m.band, 'radius': m.radius, 'code': m.code()} for m in MAPS]
    ids = [m['id'] for m in out]
    assert len(ids) == len(set(ids)), 'duplicate ids'
    json.dump(out, open(sys.argv[1], 'w'), indent=1)
    from collections import Counter
    print(Counter(m['band'] for m in out))


if __name__ == '__main__':
    main()
