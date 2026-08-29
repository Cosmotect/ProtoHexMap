# Hex World Map - prototype

A browser prototype of the world map (level select) for a roguelike: a hex grid under
fog of war, a party of three moving one step at a time, fatigue that can force
encounters on you, supplies as the currency, battles played out on a local arena map
(move, aim, cast, high ground, pushes), and the Stasis - a Seed hidden in the outer
rings (destroy it to win) whose lines grow towards four future Colonies, withering the
land as they spread. Game rules and design decisions are in DESIGN.md.

Built with **Three.js** (3D in the browser) and **Vite** (dev server + bundler).
Plain JavaScript, no framework.

---

## 1. Requirements

* **Node.js** (LTS) from https://nodejs.org - installing it also installs npm.

Check in a terminal:

```
node --version
npm --version
```

---

## 2. Running locally

```
npm install           # downloads Three.js and Vite into node_modules (first time only)
npm run dev           # starts the dev server
```

Open the address it prints (normally http://localhost:5173). Edit any file in `src/`,
save, and the page reloads by itself.

Handy URL switches (add them to the address):

| URL | Effect |
|---|---|
| `?seed=1234` | Same map every time. The seed is also shown in the HUD and saved in the address bar. |
| `?orient=pointy` | Pointy-top world hexes instead of the default flat-top. |
| `?scenario=tutorial1` | Boot straight into a tutorial map (tutorial1 / tutorial2 / tutorial3). |
| `?nostart=1` | Skip the Everlands splash and the campfire start screen (used by the automated test). |

Keyboard: **E** enter the encounter / make camp (in a fight: end the whole turn),
**M** menu, **N** new map, **R** restart, arrow keys pan.

Mouse on the world map: left-drag pan, right-drag rotate/tilt, wheel zoom, left-click
a glowing tile to move. In a fight: click a lit tile to move, an ability button to
aim, a lit tile again to cast.

---

## 3. Project tour

```
hex-world-map/
  index.html                 the page + HUD markup
  package.json               project name, scripts, dependencies
  vite.config.js             build settings
  vite.singlefile.config.js  alternative build that packs everything into one .html
  src/
    config.js    design knobs: run rules, camera, backgrounds, colours + glue for config/*
    config/world.js       map size, tile types, biomes, generation noise
    config/encounters.js  encounter placement, the Stasis, rest / shop / treasure / events, fatigue
    config/units.js       the party roster and the enemy groups
    config/abilities.js   combat rules, abilities, tile tags, per-unit combat stats
    main.js      entry point, wires the parts together (incl. the combat bridge)
    game.js      rules and state: movement, fog, fatigue, party, encounters, win / lose (no graphics)
    battle.js    enemy group generation + the legacy auto-resolve (fallback when no arena)
    events.js    flavour texts for Event encounters
    tutorial.js  the new player experience (guided first run)
    text.js      texts generated from config numbers (legend entries, guide cards)
    i18n.js      language switching and the t() / tn() translation helpers
    locales/     every user-facing string, one flat table per language (en.js is the
                 reference; only languages registered in i18n.js are selectable)
    settings.js  the in-app settings window (config values editable at runtime, saved in the browser)
    map.js       map generation from a seed, guaranteed path to the Seed and Colony sites
    noise.js     seeded multi-octave Perlin noise (elevation, ether holes, biomes)
    hex.js       hex grid maths (axial coordinates, neighbours, distance)
    rng.js       seeded random numbers (same seed = same map)
    render.js    the world-map Three.js scene: tiles, fog, markers, player token, camera, picking
    local/localmap.js     LOCAL map data (the encounter arena grid), elevation wave, recipe hook
    local/localview.js    the arena's own Three.js scene, tokens, highlights, rotate-only camera
    local/transition.js   the cloud-dive cinematic between the world and the arena
    local/battle/bhex.js     combat hex math (string keys, zone rotation)
    local/battle/engine.js   the interactive combat rules: turns, abilities, pushes, enemy AI
    ui.js        the HUD: top bar, party panel, log, legend, menu, encounter windows, roster, battle bar
    audio.js     the sounds, synthesised in the browser (no audio files)
    tween.js     tiny animation helper
    style.css    HUD styling
  tools/
    smoke-test.cjs      automated headless-browser test (needs Playwright; see the file header)
    make-artifact.mjs   converts the single-file build into a self-contained shareable page
  DESIGN.md    rules, decisions, open questions, roadmap. Read this first.
```

Rule of thumb: to change a **number**, open Menu > Settings in the running game (saved
in your browser, overrides the files) or edit `config.js` / `config/*.js` for everyone.
To change a **rule**, look in `game.js`, `battle.js`, `map.js` or
`local/battle/engine.js`. To change how something **looks**, it is `render.js` /
`local/localview.js` (3D) or `style.css` (HUD). Texts: `events.js` (stories),
`locales/*.js` (every sentence the player reads).

---

## 4. Troubleshooting

* **`npm` is not recognised** - Node.js is not installed or the terminal was opened
  before the installation finished. Close and reopen the terminal.
* **The dev server says "ready" but the browser says "unable to connect"** - Vite may
  be listening on the IPv6 loopback (`[::1]`) and on nothing else. Confirm it in a
  second terminal:

  ```
  netstat -ano | findstr :5173
  ```

  If the only line reads `TCP [::1]:5173 ... LISTENING`, that is the problem: nothing
  is home at `127.0.0.1`. Harmless on most machines, fatal on one where IPv6 is
  blocked - VPN clients commonly install a blanket IPv6 block as leak protection, and
  that rule catches `::1` too. This is why `vite.config.js` sets
  `server.host: '127.0.0.1'`; do not remove that line. One-off override:
  `npm run dev -- --host 127.0.0.1`.
* **Double-clicking `index.html` shows naked text and every panel at once** - the
  `index.html` in the project root is only a skeleton that points at `src/`; it comes
  alive solely under `npm run dev`.
* **Blank dark page, no hexes** - open the browser console (F12 > Console); the red
  error text names the broken file. Usually a typo in a `.js` file.
* **The page does not reload after saving** - check the terminal running
  `npm run dev`; it prints errors there when a file cannot be parsed.
* **Everything is very slow** - the browser may be using software rendering. Check
  `chrome://gpu`, and try another browser.
