# LEONIA — Civic Duty

An open-world game built on the real geometry of Leonia, New Jersey (Bergen County) —
1.5 square miles between the Palisades ridge and the Overpeck marsh, reconstructed from
OpenStreetMap and USGS elevation data. Every street, building footprint, stop sign and
traffic signal is where it actually is.

**[▶ Play it in the browser](https://animagix77.github.io/leonia/)** — no install, no
build step. Works in Safari, Chrome and Firefox on desktop. Give it ~30 seconds on first
load while the world is generated; it wants a keyboard and a mouse.

## Running it

```bash
node server.js
```

Then open <http://localhost:8099>. No build step, no dependencies — vanilla ES modules
and a local copy of three.js.

`dist/leonia.html` is the whole game as one self-contained 3.9 MB file — world data,
three.js, shaders and all. Open it straight off disk; it needs no server at all.

## The premise

The borough posts 25 mph on nearly every street and nobody drives it. You are not a
police officer: no badge, no authority to detain, no immunity. What you have is a radar
gun, a dashcam and an unreasonable amount of patience.

The character is deliberately unaffiliated — equally tired of posturing from both
directions — because the design needs the player's judgement to be about *evidence*,
not allegiance. Every offence in the game is a **behaviour observable from the street**:
speeding, running a stop sign or a red, tailgating, phone in hand, blocking a crosswalk,
failing to yield to a pedestrian, an e-bike on the sidewalk, an expired registration
turned up by a plate scan. Nothing keys off who a person is. That is a hard design rule,
and it is also just better game design — the AI needs an act to commit and the player
needs a fact to be right or wrong about.

The economy that results:

| Meter | Rises when | Falls when |
|---|---|---|
| **Civic Trust** | clean evidenced stops, finished odd jobs | citing people you have nothing on, speeding yourself, property damage |
| **Overreach** | stopping or citing without evidence | time, and restraint |
| **PD Attention** | your own speeding, collisions | driving like a person |

Trust is the only currency that matters: drivers are likelier to actually stop for
someone the town respects. Being useful is what earns you the standing to be a nuisance.

## Controls

| | |
|---|---|
| `W` `S` | throttle · brake and reverse |
| `A` `D` | steer |
| `SPACE` | handbrake |
| `SHIFT` | run, on foot |
| `F` | get out / get in |
| `L` | headlights |
| mouse | look · wheel zooms |
| `R` *(hold)* | radar gun — aim to lock, scans the plate |
| left click | capture the reading while aiming |
| `H` | signal a driver to pull over |
| `E` | approach a stopped driver on foot |
| `1` `2` `3` | cite · warn · release |
| `Q` *(hold)* | work an odd job once you're on the call |
| `TAB` | borough map |
| `N` `M` | change station · radio off |
| `K` | mute all audio |
| `T` | skip three hours |
| `?` | help |

## How the world is built

```
data/fetch_elevation.js   USGS 3DEP 10 m grid, 128×128 over the bbox (resumable)
data/build_world.js       OSM + elevation  →  public/world/*.json
public/src/world/         terrain, roads, buildings, parking, utilities, sky
public/src/game/          vehicle physics, traffic AI, violations, enforcement, jobs
```

To regenerate the world data from source:

```bash
node data/fetch_elevation.js && node data/build_world.js
```

What comes out of the real data:

- **6,303** building footprints, median 130 m² (1,399 ft²) — correctly house-sized
- **283** named streets, **2,021** junctions, **2,480** road edges
- **207** stop signs and **32** signals on their real nodes
- Elevation from **−0.3 m** in the Overpeck marsh to **102 m** on the Palisades ridge

Road widths are real cross-sections, not guesses: travel lanes at 3.05–3.65 m plus
parking lanes, which puts a residential street at 34 ft curb to curb and Broad Avenue at
37–48 ft. The parked cars that line those streets are what make the width read
correctly, and they are solid — you can hit them.

## Attribution

- Map data © OpenStreetMap contributors, [ODbL](https://opendatacommons.org/licenses/odbl/)
- Elevation: USGS 3DEP / NED 10 m (public domain), served via opentopodata.org
- [three.js](https://threejs.org) — MIT

Leonia is a real town and real people live there. The streets are accurate; every
resident, vehicle, name and plate in the game is invented.
