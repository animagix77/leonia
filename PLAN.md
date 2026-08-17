# LEONIA — Development Plan

Single-file plan for a GTA-style open world built on the real geometry of
Leonia, New Jersey. Written against the existing codebase (23 modules, ~7,200
lines, 1.9 MB of baked real-world data), not from scratch.

---

## 1. Concept

You are a politically unaffiliated resident who has run out of patience. The
borough posts 25 mph on nearly every street and nobody drives it. You are not
a police officer — no badge, no authority to detain, no immunity. You have a
radar gun, a dashcam, a toolbox, and standing in a town that will revoke it.

Every offence is a **behaviour observable from the street**. Nothing keys off
who anyone is. That is a hard design rule and also the load-bearing mechanic:
the AI needs an act to commit, the player needs a fact to be right about.

---

## 2. Core game loop

```
        ┌──────────────────────────────────────────────┐
        │                                              │
   OBSERVE ──► ACQUIRE EVIDENCE ──► SIGNAL STOP ──► ADJUDICATE
        │            │                    │              │
        │       radar lock           they comply     cite / warn
        │       plate scan           or they flee     / release
        │       dashcam view              │              │
        │                                 ▼              ▼
        │                            PURSUIT        STANDING Δ
        │                                              │
        └──────────────── EARN IT BACK ◄───────────────┘
                          (handyman jobs)
```

Two economies feed each other. **Enforcement** spends standing and earns money.
**Odd jobs** earn standing and money. Standing is the gate: drivers only stop
for someone the town respects, so being useful is what buys the right to be a
nuisance.

---

## 3. Mechanics

| System | Rule |
|---|---|
| **Evidence** | Three states: HUNCH (inadmissible) → WATCHED (seen in view cone, LOS-checked) → SCANNED (radar reading / plate record). Stored as a *record of a past act*, never a query against live state. |
| **Radar** | Hold RMB to aim, LMB to capture. A capture yields exactly two facts: instantaneous speed, and the registration record. It cannot retroactively make an unseen stop-sign run admissible. |
| **The stop** | Hold H. Targets the driver you last clocked, not the nearest body. Compliance scales with Civic Trust and inversely with Overreach. |
| **Adjudication** | Cite / warn / release. Citing with no evidence is the designed failure state: -16 trust, +22 overreach, +18 heat. |
| **Escalation** | Warned plates enter a watchlist and genuinely reappear. A second stop on a warned driver is a *documented pattern*: fine ×1.6, bonus trust. This is what makes restraint an investment rather than a donation. |
| **Jobs** | The town has outsourced all practical competence. Calls arrive on a timer; drive there, hold Q. Pays cash and buys back Overreach — the only thing that does. |
| **Player conduct** | You cannot enforce 25 at 70. Speeding bleeds trust and builds heat. Collisions cost money. At 100 heat, Leonia PD cites *you*. |

### Missions / objectives (NEW — §7)
Shift-based objective structure with explicit win and loss states.

### Health (NEW — §7)
Player condition, damaged by collisions at speed and by being struck on foot.

---

## 4. Physics

All 2D in the X/Z plane, Y from the DEM. Arcade, not simulation — tuned for
weight and readable slip.

- **Vehicle** — bicycle model. Speed-sensitive steering lock, understeer that
  bleeds turn authority with speed, lateral slip that builds under cornering
  load and scrubs off with grip. Handbrake cuts grip and *raises* turn
  authority so a yank-and-steer rotates the car. Gravity resolves along the
  terrain normal, so the Palisades grade is felt.
- **Collision** — separating-axis tests between oriented boxes. Mass-
  proportional separation plus a restitution impulse. Struck NPCs leave the
  lane graph for free physics, decelerate on friction, are stopped by
  buildings, chain into other traffic and into parked cars, then re-acquire
  the nearest lane and rejoin.
- **Parked cars** — real bodies, not scenery. Shoved, spun, and re-collidered
  wherever they end up.
- **Pedestrians** — circle vs OBB. Struck at speed they launch with hang-time,
  cartwheel, bounce (max 2), slide, and recover. Deliberately slapstick; the
  moral ledger is unchanged and it remains the most expensive act in the game.
- **Damage** — per-vertex mesh crush. Vertices around the contact point fold
  inward along the impact direction with falloff and sag, capped at 0.24 m,
  normals recomputed. Wounded cars limp, wobble, and smoke.

---

## 5. World data (all real)

| Source | Yield |
|---|---|
| OpenStreetMap (ODbL) | 6,303 building footprints, 283 named streets, 2,021 junctions, 2,480 edges, 207 stop signs, 32 signals |
| USGS 3DEP 10 m | 128×128 elevation grid, −0.3 m (Overpeck marsh) to 102 m (Palisades ridge) |
| NJ MOD-IV assessment (public record) | 9,193 parcels → 5,726 buildings with real year built (median 1949), storey count, construction material, garage type |

Road widths are real cross-sections including parking lanes: residential 34 ft,
Broad Ave 37–48 ft, Fort Lee Rd to 71 ft.

**No external art assets.** Every mesh, texture and effect is generated in
code: lofted vehicle bodies, extruded buildings with era-correct roof pitch,
procedural tileable surface textures with derived normal maps, a GLSL sky with
an fbm cloud deck, and a canvas-drawn skyline backdrop.

---

## 6. State management

```
state (main.js)
├── world        immutable baked geometry + spatial indices
├── sky          time of day → sun, IBL probe, fog, lamp/window state
├── traffic      NPC pool (32 cars, 8 e-bikes, 24 peds) — kinematic + knocked
├── parking      23.8k bodies in 855 culled chunks; hash + active-motion list
├── enforce      evidence ledger, plate history, trust/overreach/heat, funds
├── jobs         current call, progress
├── player       vehicle | on-foot, camera rig, headlights, health (NEW)
├── mission      shift clock, objectives, win/loss (NEW)
└── audio        Web Audio graph (NEW)
```

Single authoritative `state`; systems read it and mutate their own slice. All
stat changes route through `enforce.adjust(field, delta, reason)` so every
change surfaces to the player with its cause attached.

---

## 7. Gap closure — this iteration

Audited against the brief. Everything below is **absent** and is the work:

1. **Audio** — zero `AudioContext` in the codebase. Needs a full synthesis
   layer: engine tone tracking RPM, tyre squeal, impacts, radar lock, UI,
   siren, door, footsteps. No samples; oscillators, noise buffers and filters.
2. **Win / loss states** — none. A shift must be winnable and losable.
3. **Objective tracker** — none. Shift goals with live progress.
4. **Health** — none. Player condition with damage and recovery.
5. **Score** — funds and citations exist but no unified score.
6. **Game-over screen** — start screen exists; no end screen.
7. **Single-file build** — a bundler producing one self-contained `.html`.

### Win / loss design

A **shift** is one working day, 08:00 → 20:00 game time.

- **WIN** — end the shift with Civic Trust ≥ 70 and the shift quota met
  (evidenced citations + completed jobs). You keep your standing; the town
  tolerates you another day.
- **LOSS — RUN OUT OF TOWN** — Civic Trust hits 0. Nobody stops for you,
  nobody calls you, the loop is dead.
- **LOSS — MENACE** — Overreach hits 100. You became the thing you object to.
- **LOSS — HOSPITALISED** — health hits 0.

Losses are reachable but never sudden: all three are meters the player has
been watching, with every change already annotated with its cause.

---

## 8. Build / run

```bash
node data/fetch_elevation.js && node data/fetch_parcels.js && node data/build_world.js
node server.js            # http://localhost:8099
node build/bundle.js      # → dist/leonia.html  (single self-contained file)
```

---

## 9. Attribution

Map data © OpenStreetMap contributors (ODbL) · Elevation USGS 3DEP (public
domain) · Assessment data NJ MOD-IV (public record) · three.js (MIT).

Leonia is a real town. The streets are accurate; every resident, vehicle,
name and plate in the game is invented.
