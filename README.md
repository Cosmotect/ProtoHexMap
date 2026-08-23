# Hex World Map - prototype

A browser prototype of the world map (level select) for a roguelike in the spirit of
Slay the Spire and Into the Breach: a hex grid under fog of war, a party of three moving
one step at a time, fatigue that can force encounters on you, supplies as the currency,
simulated battles, and the Stasis: a Seed hidden in the outer rings (destroy it to win)
whose lines grow towards four future Colonies, withering the land as they spread.
The rules are in DESIGN.md.

Built with **Three.js** (3D in the browser) and **Vite** (the tool that runs and packages it).
Plain JavaScript, no framework.

---

## 1. The moving parts, explained for an Unreal / Godot person

| Thing | What it is | Closest thing you know |
|---|---|---|
| **Node.js** | A program that runs JavaScript outside the browser. We only need it to run the tools below. | The engine binary itself (you never touch it directly) |
| **npm** | Package manager that comes with Node. Downloads libraries into a `node_modules` folder. | Godot Asset Library / Unreal Marketplace, but from the command line |
| **Vite** | Dev server + packager. `npm run dev` = press Play with live reload. `npm run build` = Export project. | Pressing F5 in Godot, and "Export" |
| **Three.js** | A library that talks to WebGL for us: scene, meshes, materials, lights, cameras. | Godot's scene tree with Node3D, MeshInstance3D, Camera3D |
| **`index.html`** | The one page the browser opens. Holds the HUD elements. | The main scene |
| **`src/*.js`** | The scripts. One file per responsibility (see section 4). | Your `.gd` scripts |

You will edit JavaScript in a text editor (VS Code is the usual choice) and look at the
result in a browser tab. There is no editor viewport; the browser tab IS the viewport.

---

## 2. One-time setup on your machine (about 10 minutes)

1. **Install Node.js** (LTS version) from https://nodejs.org. On Windows use the installer,
   on macOS the installer or `brew install node`. This also installs npm.
2. **Install VS Code** from https://code.visualstudio.com (any editor works, this one has
   the best JavaScript support out of the box).
3. **Install Git** from https://git-scm.com (on macOS it may already be there: run `git --version`).
4. Optional but recommended VS Code extensions: "ESLint", "Prettier", "Live Server" is NOT
   needed (Vite does that).

Check it worked: open a terminal (VS Code: `Terminal > New Terminal`) and run

```
node --version     # should print v20 or v22 something
npm --version
git --version
```

---

## 3. Running the prototype locally

```
cd hex-world-map      # go into the project folder
npm install           # downloads Three.js and Vite into node_modules (only the first time)
npm run dev           # starts the dev server
```

Open the address it prints (normally http://localhost:5173). Edit any file in `src/`,
save, and the page reloads by itself.

Handy URL switches (add them to the address):

| URL | Effect |
|---|---|
| `?seed=1234` | Same map every time. The seed is also shown in the HUD and saved in the address bar. |
| `?orient=flat` | Flat-top hexes instead of pointy-top. |
| `?camera=ortho` | Start in the top-down (orthographic) camera. |
| `?npe=1` | Start the guided new player experience (fixed map, interface revealed piece by piece). |

Keyboard: **E** enter the encounter / make camp, **M** menu, **C** camera toggle, **N** new map,
**R** restart, arrow keys pan.
Mouse: left-drag pan, right-drag rotate/tilt, wheel zoom, left-click a glowing tile to move.

---

## 4. Project tour

```
hex-world-map/
  index.html                 the page + HUD markup
  package.json               project name, scripts, dependencies
  vite.config.js             normal build settings (for Cloudflare Pages)
  vite.singlefile.config.js  alternative build that packs everything into one .html
  src/
    config.js    design knobs: run rules, camera, colours + glue for the three files below
    config/world.js       map size, terrain
    config/encounters.js  encounter odds, rest / shop / treasure / events, fatigue
    config/units.js       the party and the battle simulation
    main.js      entry point, wires the three parts below together
    game.js      rules and state: movement, fog, fatigue, party, encounters, win / lose (no graphics)
    battle.js    the battle simulation (damage rolls, power multiplier, enemy groups)
    events.js    flavour texts for Event encounters
    tutorial.js  the new player experience (guided first run)
    text.js      texts generated from config numbers (legend entries, guide cards)
    i18n.js      language switching and the t() / tn() translation helpers
    locales/en.js, locales/ru.js   every user-facing string, one flat table per language
    settings.js  the in-app settings window (config values editable at runtime, saved in the browser)
    map.js       map generation from a seed, guaranteed path to the Seed and Colony sites
    hex.js       hex grid maths (axial coordinates, neighbours, distance)
    rng.js       seeded random numbers (same seed = same map)
    render.js    the Three.js scene: tiles, fog, markers, player token, camera, mouse picking
    ui.js        the HUD: status bar, party panel, log, legend, menu, encounter windows, confirm box
    tween.js     tiny animation helper (like Godot's Tween)
    style.css    HUD styling
  public/                    static files copied into the build untouched (images, sounds); empty for now
  tools/
    make-artifact.mjs   converts the single-file build into the format Claude artifacts expect
    smoke-test.cjs      automated browser test (optional, needs Playwright)
  DESIGN.md    rules, decisions, open questions, roadmap. Read this first in every new session.
```

Rule of thumb: if you want to change a **number**, open Menu > Settings in the running game
(saved in your browser, overrides the files) or edit `config.js` / `config/*.js` for everyone. If you
want to change a **rule**, it is in `game.js`, `battle.js` or `map.js`. If you want to change how
something **looks**, it is in `render.js` (3D) or `style.css` (HUD). Texts: `events.js` (stories),
`locales/*.js` (every sentence the player reads, per language).

---

## 5. Building and publishing

### Build

```
npm run build
```

creates a `dist/` folder with plain static files (an `index.html` and an `assets/` folder).
That folder is the whole game. Any static web host can serve it.

### Publish on Cloudflare Pages (same service your colleague uses for hex-box.pages.dev)

There are two ways. Both are free for this kind of project.

**Option A: connect a GitHub repository (best for iterating with a team).**
Every push to the repository becomes a new deployment automatically, and every branch gets
its own preview link.

1. Put the project on GitHub (see section 6 for the git commands).
2. In the Cloudflare dashboard go to *Workers & Pages > Create > Pages > Connect to Git*
   and pick the repository.
3. Build settings: framework preset **Vite** (or "None"), build command `npm run build`,
   build output directory `dist`.
4. Save and deploy. You get a `something.pages.dev` address; you can rename the project
   to pick the subdomain.

**Option B: upload the `dist` folder by hand (fastest first time).**
In the Cloudflare dashboard: *Workers & Pages > Create > Pages > Upload assets*, give the
project a name, drag the `dist` folder in. Or from the terminal:

```
npx wrangler login
npx wrangler pages deploy dist --project-name hex-world-map
```

(`wrangler` is Cloudflare's command line tool; `npx` downloads it on demand.)

Note: the exact names of the dashboard menus change from time to time, so treat the steps
above as a guide rather than gospel. The build command / output directory are the parts
that matter.

### Single-file build (for sharing by chat or as a Claude artifact)

```
npm run build:single
```

creates `dist-single/index.html`, one file with everything inside (about 0.6 MB). Double-click
it and it runs, no server needed. `node tools/make-artifact.mjs` additionally writes
`dist-single/artifact.html`, the variant Claude can publish as a hosted artifact.

---

## 6. Git in six commands

Git keeps every version of every file, so nothing is ever really lost.

```
git init                          # once: turn this folder into a repository
git add .                         # stage everything (node_modules is ignored via .gitignore)
git commit -m "First prototype"   # save a snapshot with a message
```

To put it on GitHub: create an empty repository on github.com, then

```
git remote add origin https://github.com/YOUR-NAME/hex-world-map.git
git branch -M main
git push -u origin main
```

After that, the everyday loop is `git add . `, `git commit -m "what changed"`, `git push`.

---

## 7. Troubleshooting

* **`npm` is not recognised** - Node.js is not installed or the terminal was opened before
  the installation finished. Close and reopen the terminal.
* **The dev server says "ready" but the browser says "unable to connect"** - Vite may be
  listening on the IPv6 loopback (`[::1]`) and on nothing else. Confirm it in a second
  terminal:

  ```
  netstat -ano | findstr :5173
  ```

  If the only line reads `TCP [::1]:5173 ... LISTENING`, that is the problem: nothing is
  home at `127.0.0.1`. Harmless on most machines, fatal on one where IPv6 is blocked -
  VPN clients commonly install a blanket IPv6 block as leak protection, and that rule
  catches `::1` too, even though it never leaves the PC. This is why `vite.config.js`
  sets `server.host: '127.0.0.1'`; do not remove that line. For a one-off override
  without editing the config: `npm run dev -- --host 127.0.0.1`.
* **Double-clicking `index.html` shows naked text and every panel at once** - you opened
  the wrong file. The `index.html` in the project root (about 4 kB) is only a skeleton
  that points at `src/`; it comes alive solely under `npm run dev`. The file you can
  double-click is `dist-single/index.html` (about 580 kB), where everything is baked in.
  It is a frozen export: editing anything in `src/` does not change it until you rebuild
  with `npm run build:single`.
* **Blank dark page, no hexes** - open the browser console (F12 > Console) and copy the red
  text into the chat with Claude. Usually a typo in a `.js` file.
* **The page does not reload after saving** - check the terminal running `npm run dev`, it
  prints errors there when a file cannot be parsed.
* **Everything is very slow** - your browser may be using software rendering. Check
  `chrome://gpu`, and try another browser.
