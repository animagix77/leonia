import * as THREE from 'three';
import { clamp, rand, pick, makeRng, angleDelta, approach, SpatialHash, MPH_TO_MPS } from '../core/util.js';
import { CAR_SPECS, TRAFFIC_SPECS, buildCarMesh, randomCarColor } from './vehicle.js';
import { setLights } from '../world/carbuilder.js';
import { stepKnocked, stepDownedPed } from './physics.js';
import { disturbParked } from '../world/parking.js';
import { evaluateDriving, flagEvent, decayEvents, EVIDENCE } from './violations.js';

/* Kinematic traffic on the real OSM graph. NPCs follow lane-offset polylines,
   yield to each other, obey (or deliberately blow) stop signs and signals, and
   carry a personality that decides which offences they commit. */

const SPAWN_RADIUS = 300;
const DESPAWN_RADIUS = 420;
const MAX_CARS = 32;
const MAX_EBIKES = 8;
const MAX_PEDS = 24;

// Right-hand side of travel direction, in our X(east)/Z(south) frame.
const rightOf = (dx, dz) => [-dz, dx];

const FIRST = ['Dana', 'Marco', 'Priya', 'Kevin', 'Tasha', 'Yusuf', 'Ellen', 'Rob', 'Wen', 'Alexis',
  'Hyun', 'Gabe', 'Nina', 'Omar', 'Claire', 'Desmond', 'Ivy', 'Paolo', 'Renee', 'Sam',
  'Tara', 'Vic', 'Lena', 'Nate', 'Mira', 'Colin', 'Aisha', 'Drew', 'Joon', 'Bea'];
const LAST = ['Whitaker', 'Alvarez', 'Nakamura', 'Boyle', 'Okonkwo', 'Petrov', 'Lindqvist', 'Barros',
  'Feldman', 'Marsh', 'Quintero', 'Doyle', 'Haddad', 'Reyes', 'Kowalski', 'Chandra',
  'Bellamy', 'Novak', 'Ferris', 'Ozturk', 'Vance', 'Mbeki', 'Sorrentino', 'Dunn'];

/* The premise is that nobody drives 25. So the MODAL driver sits at 30-34 in
   a 25 — visibly speeding and legally untouchable, because the citable
   threshold is +10. That band is the moral tension expressed as a number: you
   can see them doing it and you cannot do anything about it. A meaningful
   minority then sits above +10 so there is real work, and a few are genuinely
   dangerous. Tuned against the old values, where only 18% of drivers could
   clear the threshold at all and curve/car-following scrubbed most of those. */
const PERSONALITIES = [
  { id: 'lawful',     w: 26, speedF: [0.94, 1.10], runStop: 0.02, runRed: 0.00, weave: 0.00, phone: 0.02, yield: 0.98 },
  { id: 'hurried',    w: 30, speedF: [1.26, 1.46], runStop: 0.22, runRed: 0.04, weave: 0.10, phone: 0.10, yield: 0.92 },
  { id: 'distracted', w: 18, speedF: [0.98, 1.32], runStop: 0.30, runRed: 0.10, weave: 0.55, phone: 0.85, yield: 0.70 },
  { id: 'aggressive', w: 16, speedF: [1.44, 1.72], runStop: 0.62, runRed: 0.26, weave: 0.45, phone: 0.18, yield: 0.55 },
  { id: 'reckless',   w:  6, speedF: [1.74, 2.15], runStop: 0.88, runRed: 0.55, weave: 0.85, phone: 0.25, yield: 0.25 },
];
const PERSONALITY_TOTAL = PERSONALITIES.reduce((s, p) => s + p.w, 0);

function rollPersonality() {
  let r = Math.random() * PERSONALITY_TOTAL;
  for (const p of PERSONALITIES) { r -= p.w; if (r <= 0) return p; }
  return PERSONALITIES[0];
}

function plateString(rng) {
  const L = 'ABCDEFGHJKLMNPRSTUVWXYZ';
  const d = () => Math.floor(rng() * 10);
  return `${L[Math.floor(rng() * L.length)]}${d()}${d()}${L[Math.floor(rng() * L.length)]}${L[Math.floor(rng() * L.length)]}`;
}

/* -------------------------------------------------------------------- NPC */

class NPC {
  constructor(sim, kind) {
    this.sim = sim;
    this.kind = kind;                  // 'car' | 'ebike'
    this.active = false;
    this.activeViolations = new Set();
    this.eventExpiry = new Map();
    this.evidence = new Map();         // code -> EVIDENCE level the player has
    this.scanned = false;
    this.tailgateTime = 0;
    this.weaveEnergy = 0;
    this.gapAhead = null;
    this.onCrossing = false;
    this.nearSchool = false;
    this.pullState = null;             // null | 'yielding' | 'stopped' | 'fleeing' | 'cited'
    this.pullTimer = 0;
    this.cited = false;
    this.mesh = null;
  }

  reset(spawn) {
    const w = this.sim.world;
    /* Some of the drivers you let off with a warning come back around. That is
       what makes restraint an investment rather than a donation: the second
       time you stop them it is a documented pattern, not a judgement call. */
    const returning = this.sim.enforcement && this.sim.enforcement.takeReturningDriver();
    let p;
    if (returning) {
      p = PERSONALITIES.find((x) => x.id === returning.personality) || rollPersonality();
      this.name = returning.name;
      this.plate = returning.plate;
    } else {
      p = rollPersonality();
      this.name = `${pick(FIRST)} ${pick(LAST)}`;
      this.plate = plateString(Math.random);
    }
    this.personality = p;
    this.speedFactor = rand(p.speedF[0], p.speedF[1]);
    this.baseSpeedFactor = this.speedFactor;
    this.activeViolations.clear();
    this.eventExpiry.clear();
    this.evidence.clear();
    this.scanned = false;
    this.cited = false;
    this.pullState = null;
    this.pullTimer = 0;
    // A knocked car can despawn mid-slide (it isn't pinned), so without this
    // it respawns across town still carrying its crash velocity.
    this.knock = null;
    this.prevHeading = undefined;
    this.tailgateTime = 0;
    this.weaveEnergy = 0;
    this.gapAhead = null;
    this.damage = 0;
    this.laneJitter = 0;
    this.blinker = 0;
    this.signalledTurn = false;
    this.hazard = 0;
    this.stoppedAt = new Set();

    // Paperwork state — only discoverable by scanning the plate.
    this.paperwork = [];
    if (Math.random() < 0.11) this.paperwork.push('UNREG');
    if (Math.random() < 0.05) this.paperwork.push('SUSPENDED');
    if (Math.random() < 0.04) this.paperwork.push('NO_PLATE');
    for (const c of this.paperwork) this.activeViolations.add(c);

    this.onPhone = Math.random() < p.phone;
    if (this.onPhone) this.activeViolations.add('PHONE');

    // Route
    this.path = [];
    this.pathPos = 0;
    this.edgeChain = [];
    this.speed = 0;
    this.x = spawn.x;
    this.z = spawn.z;
    this.y = w.heightAt(spawn.x, spawn.z);
    this.heading = spawn.heading;
    this.currentLimit = 25;
    this.currentRoadName = null;
    this._seedPath(spawn);
    this.active = true;
  }

  _seedPath(spawn) {
    const w = this.sim.world;
    const e = w.network.edges[spawn.edge];
    if (!e) return;
    this.curEdge = spawn.edge;
    this.curFwd = Math.random() < 0.5;
    this._appendEdge(spawn.edge, this.curFwd);
    for (let i = 0; i < 4; i++) this._extendPath();
    // Snap onto the nearest point of the generated lane path.
    let best = 0, bestD = Infinity;
    for (let i = 0; i < this.path.length; i++) {
      const d = (this.path[i][0] - spawn.x) ** 2 + (this.path[i][1] - spawn.z) ** 2;
      if (d < bestD) { bestD = d; best = i; }
    }
    this.pathIdx = Math.min(best, Math.max(0, this.path.length - 2));
    this.pathT = 0;
  }

  /** Append an edge's geometry, offset into the right-hand lane. */
  _appendEdge(edgeIdx, fwd) {
    const w = this.sim.world;
    const e = w.network.edges[edgeIdx];
    const road = w.roads[e.road];
    const geom = fwd ? e.geom : e.geom.slice().reverse();
    // Parking eats the outer edge of the carriageway, so travel lanes sit
    // inboard of it. E-bikes hug the right edge of the travel way.
    const travelHalf = Math.max(1.6, road.w / 2 - ((road.ps || 0) > 0 ? (road.pk || 0) : 0));
    const laneOff = this.kind === 'ebike'
      ? travelHalf - 0.7
      : (road.ow ? 0 : travelHalf * 0.5);

    for (let i = 0; i < geom.length; i++) {
      const a = geom[Math.max(0, i - 1)];
      const b = geom[Math.min(geom.length - 1, i + 1)];
      let dx = b[0] - a[0], dz = b[1] - a[1];
      const l = Math.hypot(dx, dz) || 1;
      dx /= l; dz /= l;
      const [rx, rz] = rightOf(dx, dz);
      const px = geom[i][0] + rx * laneOff;
      const pz = geom[i][1] + rz * laneOff;
      // Avoid duplicate points at junctions.
      const last = this.path[this.path.length - 1];
      if (last && Math.hypot(last[0] - px, last[1] - pz) < 0.4) continue;
      this.path.push([px, pz, edgeIdx]);
    }
    this.edgeChain.push({ edge: edgeIdx, fwd, endIdx: this.path.length - 1 });
  }

  /** Pick the next edge at the junction and extend the lane path. */
  _extendPath() {
    const w = this.sim.world;
    const last = this.edgeChain[this.edgeChain.length - 1];
    if (!last) return false;
    const e = w.network.edges[last.edge];
    const atJunction = last.fwd ? e.b : e.a;
    const options = w.adj.get(atJunction) || [];

    // Heading at the end of the current path, to prefer going straight.
    const n = this.path.length;
    let hx = 0, hz = 1;
    if (n >= 2) {
      hx = this.path[n - 1][0] - this.path[n - 2][0];
      hz = this.path[n - 1][1] - this.path[n - 2][1];
      const l = Math.hypot(hx, hz) || 1; hx /= l; hz /= l;
    }

    let best = null, bestScore = -Infinity;
    for (const opt of options) {
      if (opt.edge === last.edge) continue;
      const oe = w.network.edges[opt.edge];
      const road = w.roads[oe.road];
      if (road.rk < 2) continue;
      const g = opt.fwd ? oe.geom : oe.geom.slice().reverse();
      if (g.length < 2) continue;
      let dx = g[1][0] - g[0][0], dz = g[1][1] - g[0][1];
      const l = Math.hypot(dx, dz) || 1; dx /= l; dz /= l;
      const straight = hx * dx + hz * dz;                 // 1 = dead ahead
      const score = straight * 2.2 + road.rk * 0.35 + Math.random() * 1.1;
      if (score > bestScore) { bestScore = score; best = opt; }
    }

    if (!best) {
      // Dead end — turn around.
      this._appendEdge(last.edge, !last.fwd);
      return true;
    }
    // Did they signal the turn?
    const turnSharp = bestScore < 1.4;
    this._appendEdge(best.edge, best.fwd);
    if (turnSharp) {
      this.pendingTurnAt = this.path.length - 1;
      this.signalledTurn = Math.random() > (this.personality.id === 'lawful' ? 0.05 : 0.42);
    }
    return true;
  }

  /** Rejoin the road network after being knocked out of the lane. */
  reacquire() {
    const w = this.sim.world;
    const near = w.nearestRoad(this.x, this.z, 60);
    if (!near) { this.active = false; this.mesh.visible = false; return; }

    // Snap onto the nearest drivable edge and rebuild a route from there.
    this.path = [];
    this.edgeChain = [];
    this.pathIdx = 0;
    this.pathT = 0;
    this.speed = 0;
    this.stoppedAt = new Set();
    this._seedPath({
      x: near.x, z: near.z,
      edge: near.seg.edge,
      heading: this.heading,
    });
    // Face the way the lane runs so they don't pull out backwards.
    const a = this.path[this.pathIdx], b = this.path[this.pathIdx + 1];
    if (a && b) this.heading = Math.atan2(b[0] - a[0], b[1] - a[1]);
  }

  get pathPoint() { return this.path[this.pathIdx]; }

  /* Distance along the path to a world point, for lookahead checks.
     ALWAYS returns exactly [x, z]. Path points carry a third element (the
     edge index), and callers spread this into nearestControl(list, x, z, r) —
     so returning the raw 3-element point silently replaced the search radius
     with an OSM edge index, giving NPCs phantom stop signs from across town. */
  lookahead(dist) {
    let i = this.pathIdx, t = this.pathT, acc = 0;
    while (i < this.path.length - 1) {
      const a = this.path[i], b = this.path[i + 1];
      const segLen = Math.hypot(b[0] - a[0], b[1] - a[1]);
      const remain = segLen * (1 - t);
      if (acc + remain >= dist) {
        const need = dist - acc;
        const tt = t + need / segLen;
        return [a[0] + (b[0] - a[0]) * tt, a[1] + (b[1] - a[1]) * tt];
      }
      acc += remain; i++; t = 0;
    }
    const last = this.path.length ? this.path[this.path.length - 1] : null;
    return last ? [last[0], last[1]] : [this.x, this.z];
  }

  advance(dist) {
    while (dist > 0 && this.pathIdx < this.path.length - 1) {
      const a = this.path[this.pathIdx], b = this.path[this.pathIdx + 1];
      const segLen = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (segLen < 1e-6) { this.pathIdx++; continue; }
      const remain = segLen * (1 - this.pathT);
      if (dist < remain) {
        this.pathT += dist / segLen;
        dist = 0;
      } else {
        dist -= remain;
        this.pathIdx++;
        this.pathT = 0;
      }
    }
    const a = this.path[Math.min(this.pathIdx, this.path.length - 1)];
    const b = this.path[Math.min(this.pathIdx + 1, this.path.length - 1)];
    const t = this.pathT;
    this.x = a[0] + (b[0] - a[0]) * t;
    this.z = a[1] + (b[1] - a[1]) * t;
    let dx = b[0] - a[0], dz = b[1] - a[1];
    if (Math.hypot(dx, dz) > 1e-6) this.heading = Math.atan2(dx, dz);

    // Keep the path topped up and trimmed.
    if (this.pathIdx > this.path.length - 40) this._extendPath();
    if (this.pathIdx > 120) {
      this.path.splice(0, 80);
      this.pathIdx -= 80;
      for (const c of this.edgeChain) c.endIdx -= 80;
      /* Shift the pending-turn marker with everything else. Leaving it put the
         NO_SIGNAL test 80 path-points out of phase after the first trim, so the
         charge fired where nothing visible had happened — exactly the failure
         the "observable from the street" rule exists to prevent. */
      if (this.pendingTurnAt !== undefined) {
        this.pendingTurnAt -= 80;
        if (this.pendingTurnAt < 0) this.pendingTurnAt = undefined;
      }
      while (this.edgeChain.length && this.edgeChain[0].endIdx < 0) this.edgeChain.shift();
    }
  }
}

/* ------------------------------------------------------------ pedestrians */

class Ped {
  constructor(sim) {
    this.sim = sim;
    this.active = false;
    this.mesh = null;
  }
  reset(x, z) {
    this.x = x; this.z = z;
    this.y = this.sim.world.heightAt(x, z);
    this.heading = rand(0, Math.PI * 2);
    this.speed = rand(1.0, 1.7);
    this.crossing = false;
    this.crossT = 0;
    this.phase = rand(0, 10);
    this.alarm = 0;
    this.down = false;
    this.airborne = false;
    this.bounced = 0;
    this.tumble = 0;
    this.cartwheel = 0;
    this.active = true;
  }
}

/* ------------------------------------------------------------------- SIM */

export class TrafficSim {
  constructor(world, scene) {
    this.world = world;
    this.scene = scene;
    this.npcs = [];
    this.peds = [];
    this.rng = makeRng(31337);
    this.time = 0;

    // Signal cycle: axis 0 (roughly E-W) green, then axis 1.
    this.signalCycle = 0;
    this.signalPhase = 0;

    // Index of traffic-control nodes for fast lookup.
    this.stopNodes = world.props.signals.filter((s) => s.k === 'stop');
    this.signalNodes = world.props.signals.filter((s) => s.k === 'signal');
    this.crossNodes = world.props.signals.filter((s) => s.k === 'crossing');
    this.schoolPts = world.props.pois.filter((p) => p.k === 'school');
    // Real junctions from the road graph, for don't-block-the-box.
    this.junctionPts = world.network.junctions.map(([x, z]) => ({ x, z }));

    this._buildPools();
  }

  _buildPools() {
    // Cars — drawn from the weighted traffic pool so the fleet actually varies.
    for (let i = 0; i < MAX_CARS; i++) {
      const npc = new NPC(this, 'car');
      const spec = i % 19 === 0 ? CAR_SPECS.bus
        : i % 13 === 0 ? CAR_SPECS.boxtruck
        : pick(TRAFFIC_SPECS);
      npc.spec = spec;
      npc.mesh = buildCarMesh(spec, randomCarColor(), { name: `npc_${i}` });
      npc.mesh.visible = false;
      this.scene.add(npc.mesh);
      this.npcs.push(npc);
    }
    // E-bikes
    for (let i = 0; i < MAX_EBIKES; i++) {
      const npc = new NPC(this, 'ebike');
      npc.spec = { L: 1.1, w: 0.62, len: 1.75, h: 1.1, name: 'E-bike' };
      npc.mesh = buildEbikeMesh();
      npc.mesh.visible = false;
      this.scene.add(npc.mesh);
      this.npcs.push(npc);
    }
    /* Pedestrians with limbs. The old capsule-with-a-ball-head read as chess
       pieces; a torso, two swinging legs and two arms is still cheap but
       finally reads as a person walking. */
    const torsoGeo = new THREE.CapsuleGeometry(0.21, 0.50, 3, 6);
    const legGeo = new THREE.CapsuleGeometry(0.075, 0.42, 2, 5);
    const armGeo = new THREE.CapsuleGeometry(0.055, 0.36, 2, 5);
    const headGeo = new THREE.SphereGeometry(0.145, 7, 6);
    const skinTones = [0xa98a72, 0x8a6a50, 0xc7a488, 0x6f5138, 0xb59578];
    for (let i = 0; i < MAX_PEDS; i++) {
      const p = new Ped(this);
      const shirt = new THREE.MeshStandardMaterial({
        color: new THREE.Color().setHSL(this.rng(), 0.30 + this.rng() * 0.25, 0.34 + this.rng() * 0.22),
        roughness: 0.85,
      });
      const pants = new THREE.MeshStandardMaterial({
        color: new THREE.Color().setHSL(this.rng(), 0.18, 0.16 + this.rng() * 0.14),
        roughness: 0.9,
      });
      const skin = new THREE.MeshStandardMaterial({
        color: skinTones[Math.floor(this.rng() * skinTones.length)], roughness: 0.9,
      });

      const g = new THREE.Group();
      const torso = new THREE.Mesh(torsoGeo, shirt);
      torso.position.y = 0.98;
      torso.castShadow = true;
      const head = new THREE.Mesh(headGeo, skin);
      head.position.y = 1.52;
      g.add(torso, head);

      const limbs = {};
      for (const [key, sx] of [['legL', -1], ['legR', 1]]) {
        const hip = new THREE.Group();
        hip.position.set(sx * 0.115, 0.72, 0);
        const leg = new THREE.Mesh(legGeo, pants);
        leg.position.y = -0.30;
        leg.castShadow = true;
        hip.add(leg);
        g.add(hip);
        limbs[key] = hip;
      }
      for (const [key, sx] of [['armL', -1], ['armR', 1]]) {
        const shoulder = new THREE.Group();
        shoulder.position.set(sx * 0.285, 1.24, 0);
        const arm = new THREE.Mesh(armGeo, shirt);
        arm.position.y = -0.24;
        shoulder.add(arm);
        g.add(shoulder);
        limbs[key] = shoulder;
      }
      g.userData.limbs = limbs;
      g.visible = false;
      p.mesh = g;
      this.scene.add(g);
      this.peds.push(p);
    }
  }

  /* ---------------------------------------------------------------- helpers
     Every control list gets its own spatial hash. This was a linear scan, and
     _driveNPC calls it four times per NPC per frame — against 2,021 junctions
     that is ~75,000 distance tests a frame for junctions alone. */
  _hashFor(list) {
    if (!this._hashes) this._hashes = new Map();
    let h = this._hashes.get(list);
    if (!h) {
      h = new SpatialHash(30);
      for (const n of list) h.insert(n.x, n.z, n);
      this._hashes.set(list, h);
    }
    return h;
  }

  nearestControl(list, x, z, r) {
    if (!list.length) return null;
    const near = this._hashFor(list).query(x, z, r, this._ctlQ || (this._ctlQ = []));
    let best = null, bd = r * r;
    for (let i = 0; i < near.length; i++) {
      const n = near[i];
      const d = (n.x - x) ** 2 + (n.z - z) ** 2;
      if (d < bd) { bd = d; best = n; }
    }
    return best ? { node: best, dist: Math.sqrt(bd) } : null;
  }

  /** Green light for a given heading, from the global alternating cycle. */
  isGreenFor(heading) {
    const dx = Math.abs(Math.sin(heading));
    const dz = Math.abs(Math.cos(heading));
    const axis = dx > dz ? 0 : 1;
    return this.signalCycle === axis && this.signalPhase < 0.82;
  }

  // ---------------------------------------------------------------- update
  update(dt, player) {
    this.time += dt;

    // signal cycle: 14 s per axis with a short all-red
    this.signalPhase += dt / 14;
    if (this.signalPhase >= 1) { this.signalPhase = 0; this.signalCycle ^= 1; }

    this._spawnDespawn(player);

    const px = player.x, pz = player.z;

    for (const npc of this.npcs) {
      if (!npc.active) continue;
      this._updateNPC(npc, dt, player);
      // Only a driver you have actually stopped is pinned in the pool. A car
      // that fled is long gone and must be allowed to recycle, or the pool
      // bleeds a slot per refusal until the streets go quiet.
      const d2 = (npc.x - px) ** 2 + (npc.z - pz) ** 2;
      const pinned = npc.pullState === 'yielding' || npc.pullState === 'stopped';
      if (d2 > DESPAWN_RADIUS * DESPAWN_RADIUS && !pinned) {
        npc.active = false;
        npc.pullState = null;
        npc.mesh.visible = false;
      }
    }

    for (const p of this.peds) {
      if (!p.active) continue;
      this._updatePed(p, dt, player);
      const d2 = (p.x - px) ** 2 + (p.z - pz) ** 2;
      if (d2 > DESPAWN_RADIUS * DESPAWN_RADIUS) { p.active = false; p.mesh.visible = false; }
    }
  }

  _spawnDespawn(player) {
    // Counting with filter() allocated three arrays every frame.
    let activeCars = 0, activeBikes = 0;
    for (const n of this.npcs) {
      if (!n.active) continue;
      if (n.kind === 'car') activeCars++; else activeBikes++;
    }
    const wantCars = MAX_CARS;
    const wantBikes = MAX_EBIKES;

    for (const npc of this.npcs) {
      if (npc.active) continue;
      const isCar = npc.kind === 'car';
      if (isCar && activeCars >= wantCars) continue;
      if (!isCar && activeBikes >= wantBikes) continue;

      // Find a road point in the spawn annulus, out of immediate view.
      let spawn = null;
      for (let t = 0; t < 26; t++) {
        const c = this.world.randomRoadPoint(isCar ? 2 : 2);
        const d = Math.hypot(c.x - player.x, c.z - player.z);
        if (d > SPAWN_RADIUS * 0.42 && d < SPAWN_RADIUS) { spawn = c; break; }
      }
      if (!spawn) continue;
      npc.reset(spawn);
      npc.mesh.visible = true;
      break;   // one spawn per frame, whichever kind
    }

    // Pedestrians spawn on sidewalks near the player.
    let activePeds = 0;
    for (const p of this.peds) if (p.active) activePeds++;
    for (const p of this.peds) {
      if (p.active || activePeds >= MAX_PEDS) continue;
      const c = this.world.randomRoadPoint(2);
      const d = Math.hypot(c.x - player.x, c.z - player.z);
      if (d > 200 || d < 25) continue;
      const road = this.world.nearestRoad(c.x, c.z, 30);
      if (!road) continue;
      const off = (road.seg.w / 2 + 1.6) * (Math.random() < 0.5 ? -1 : 1);
      let dx = road.seg.bx - road.seg.ax, dz = road.seg.bz - road.seg.az;
      const l = Math.hypot(dx, dz) || 1; dx /= l; dz /= l;
      const [rx, rz] = rightOf(dx, dz);
      p.reset(c.x + rx * off, c.z + rz * off);
      p.dirX = dx; p.dirZ = dz;
      if (Math.random() < 0.5) { p.dirX = -dx; p.dirZ = -dz; }
      p.mesh.visible = true;
      activePeds++;
      break;
    }
  }

  _updateNPC(npc, dt, player) {
    const w = this.world;

    // ---- current road context
    const near = w.nearestRoad(npc.x, npc.z, 26);
    if (near) {
      npc.currentLimit = near.seg.mph;
      npc.currentRoadName = near.seg.name;
    }
    npc.nearSchool = this.schoolPts.some((s) => (s.x - npc.x) ** 2 + (s.z - npc.z) ** 2 < 120 * 120);

    /* ---- knocked out of the lane by an impact.
       Free physics until it settles, then hand the car back to the AI by
       re-acquiring the nearest lane rather than leaving wrecks everywhere. */
    if (npc.knock) {
      const settled = stepKnocked(npc, w, dt, this.parking, disturbParked);
      npc.hazard = 1;
      if (settled) {
        npc.knock = null;
        npc.hazard = 0;
        npc.reacquire();
      }
      this._drawNPC(npc, dt);
      return;
    }

    // ---- pull-over behaviour overrides normal driving
    if (npc.pullState === 'yielding') {
      npc.speed = approach(npc.speed, 0, 7 * dt);
      npc.hazard = 1;
      if (npc.speed < 0.15) { npc.pullState = 'stopped'; npc.speed = 0; }
    } else if (npc.pullState === 'stopped' || npc.pullState === 'cited') {
      npc.speed = 0;
      npc.hazard = 1;
      npc.pullTimer += dt;
      // After a citation they drive off again.
      if (npc.pullState === 'cited' && npc.pullTimer > 6) {
        npc.pullState = null; npc.hazard = 0; npc.pullTimer = 0;
      }
      // Abandoned at the kerb. They are not going to wait all day, and
      // leaving someone sitting there should cost you something.
      if (npc.pullState === 'stopped' && npc.pullTimer > 45) {
        npc.pullState = null; npc.hazard = 0; npc.pullTimer = 0;
        if (this.enforcement && this.enforcement.target === npc) {
          this.enforcement.target = null;
          this.enforcement.adjust('trust', -2, 'left a driver waiting at the kerb');
          this.enforcement.say(`${npc.plate} gave up waiting and drove off.`, 'warn', 3.2);
        }
      }
    } else {
      if (npc.pullState === 'fleeing') {
        npc.fleeTimer = (npc.fleeTimer || 0) + dt;
        if (npc.fleeTimer > 22) {
          npc.pullState = null; npc.fleeTimer = 0;
          // Give the boost back, or repeated signalling ratchets one driver
          // to an unbounded speed.
          npc.speedFactor = npc.baseSpeedFactor ?? npc.speedFactor;
        }
      }
      this._driveNPC(npc, dt, player);
    }

    // ---- integrate
    if (npc.speed > 0) npc.advance(npc.speed * dt);
    npc.y = w.heightAt(npc.x, npc.z);

    /* ---- violations
       Skipped while they are pulled over: a stationary car at the kerb is not
       committing a moving violation, and running the detector here used to
       manufacture a CROSSWALK charge out of the act of complying with you. */
    if (!npc.pullState) evaluateDriving(npc, w, { dt });
    decayEvents(npc, dt);

    this._drawNPC(npc, dt);
  }

  /** Pose the mesh and drive its lamps. Shared by the normal and knocked paths. */
  _drawNPC(npc, dt) {
    const w = this.world;
    const m = npc.mesh;
    // Actual yaw rate this frame, used to point the front wheels.
    if (npc.prevHeading === undefined) npc.prevHeading = npc.heading;
    npc.turnRate = angleDelta(npc.prevHeading, npc.heading) / Math.max(dt, 1e-3);
    npc.prevHeading = npc.heading;
    m.position.set(npc.x, npc.y, npc.z);
    const nrm = w.normalAt(npc.x, npc.z, 5);
    m.rotation.set(0, 0, 0);
    m.rotateY(npc.heading + npc.laneJitter * 0.12);
    const fx = Math.sin(npc.heading), fz = Math.cos(npc.heading);
    m.rotateX(Math.asin(clamp(-(nrm[0] * fx + nrm[2] * fz), -1, 1)));
    // A knocked car leans on its springs.
    if (npc.knock) m.rotateZ(clamp(npc.knock.vyaw * 0.10, -0.22, 0.22));

    const ud = m.userData;
    if (ud && ud.wheels) {
      const r = ud.wheelR || 0.34;
      const roll = npc.knock ? Math.hypot(npc.knock.vx, npc.knock.vz) : npc.speed;
      // Spin lives on the inner node; the outer one is reserved for steering.
      npc.wheelSpin = (npc.wheelSpin || 0) + (roll / r) * dt;
      // Point the fronts into the corner they're actually taking.
      const turn = clamp(-(npc.laneJitter * 0.10 + (npc.turnRate || 0) * 2.2), -0.5, 0.5);
      for (const wl of ud.wheels) {
        if (wl.userData.front) wl.rotation.y = turn;
        if (wl.userData.spin) wl.userData.spin.rotation.x = -npc.wheelSpin;
      }
    }
    setLights(m, {
      head: !!this.headlightsOn,
      brake: npc.decel > 1.5,
      hazard: npc.hazard > 0,
      blink: Math.sin(this.time * 8) > 0,
    });
  }

  _driveNPC(npc, dt, player) {
    const w = this.world;
    const p = npc.personality;

    // ---- base target speed
    let target = npc.currentLimit * MPH_TO_MPS * npc.speedFactor;
    if (npc.kind === 'ebike') target = Math.min(target, (p.id === 'reckless' ? 34 : 24) * MPH_TO_MPS);
    // A beaten-up car limps home with its hazards on.
    if ((npc.damage || 0) > 40) { target *= 0.55; npc.hazard = 1; }

    // ---- slow for curvature ahead
    const a1 = npc.lookahead(8), a2 = npc.lookahead(22);
    const h1 = Math.atan2(a1[0] - npc.x, a1[1] - npc.z);
    const h2 = Math.atan2(a2[0] - a1[0], a2[1] - a1[1]);
    const curve = Math.abs(angleDelta(h1, h2));
    if (curve > 0.18) target *= clamp(1 - (curve - 0.18) * 1.5, 0.35, 1);

    // ---- car ahead
    npc.gapAhead = null;
    let blockDist = Infinity;
    for (const other of this.npcs) {
      if (other === npc || !other.active) continue;
      const dx = other.x - npc.x, dz = other.z - npc.z;
      const d = Math.hypot(dx, dz);
      if (d > 42) continue;
      const fx = Math.sin(npc.heading), fz = Math.cos(npc.heading);
      const along = dx * fx + dz * fz;
      if (along < 0.5) continue;
      const lat = Math.abs(dx * -fz + dz * fx);
      if (lat > 2.6) continue;
      const gap = along - (npc.spec.len + other.spec.len) * 0.5;
      if (gap < blockDist) { blockDist = gap; npc.gapAhead = Math.max(0, gap); }
    }
    // Player counts as an obstacle too.
    {
      const dx = player.x - npc.x, dz = player.z - npc.z;
      const d = Math.hypot(dx, dz);
      if (d < 42) {
        const fx = Math.sin(npc.heading), fz = Math.cos(npc.heading);
        const along = dx * fx + dz * fz;
        const lat = Math.abs(dx * -fz + dz * fx);
        if (along > 0.5 && lat < 2.6) blockDist = Math.min(blockDist, along - 3.4);
      }
    }
    if (blockDist < Infinity) {
      const desiredGap = 4.5 + npc.speed * (p.id === 'aggressive' || p.id === 'reckless' ? 0.55 : 1.25);
      if (blockDist < desiredGap) {
        target = Math.min(target, Math.max(0, npc.speed * (blockDist / Math.max(0.6, desiredGap))));
      }
    }

    /* ---- don't block the box.
       Queueing traffic used to roll into a junction and stop dead in it,
       leaving cars sitting across the intersection. Before entering, check
       there is room to CLEAR it: if the car ahead is closer than the junction
       plus our own length, hold at the stop line instead. */
    const [jlx, jlz] = npc.lookahead(Math.max(6, npc.speed * 1.1));
    const jAhead = this.nearestControl(this.junctionPts, jlx, jlz, 11);
    if (jAhead && !npc.pullState) {
      const dToJ = Math.hypot(jAhead.node.x - npc.x, jAhead.node.z - npc.z);
      const needed = 7.5 + npc.spec.len;          // junction box plus our body
      const exitBlocked = blockDist < Infinity && blockDist < needed;
      // Only applies on approach, not once we're already committed inside it.
      if (exitBlocked && dToJ > 2.5 && dToJ < 16) {
        target = Math.min(target, clamp((dToJ - 4.0) * 0.7, 0, target));
      }
    }

    // ---- stop signs
    const [slx, slz] = npc.lookahead(Math.max(8, npc.speed * 1.6));
    const stopAhead = this.nearestControl(this.stopNodes, slx, slz, 7);
    if (stopAhead) {
      const key = `s${stopAhead.node.x.toFixed(0)},${stopAhead.node.z.toFixed(0)}`;
      const dToStop = Math.hypot(stopAhead.node.x - npc.x, stopAhead.node.z - npc.z);
      if (!npc.stoppedAt.has(key)) {
        const willRun = npc._runThisStop ?? (npc._runThisStop = Math.random() < p.runStop);
        if (!willRun) {
          target = Math.min(target, clamp((dToStop - 3.5) * 0.9, 0, target));
          if (dToStop < 5 && npc.speed < 1.0) { npc.stoppedAt.add(key); npc._runThisStop = undefined; }
        } else if (dToStop < 4.5 && npc.speed > 4.2) {
          flagEvent(npc, 'RAN_STOP', 40);
          npc.stoppedAt.add(key);
          npc._runThisStop = undefined;
        }
      }
    } else {
      npc._runThisStop = undefined;
    }

    // ---- signals
    const [glx, glz] = npc.lookahead(Math.max(10, npc.speed * 1.8));
    const sigAhead = this.nearestControl(this.signalNodes, glx, glz, 9);
    npc.heldAtRed = false;
    if (sigAhead) {
      const green = this.isGreenFor(npc.heading);
      const d = Math.hypot(sigAhead.node.x - npc.x, sigAhead.node.z - npc.z);
      const key = `g${sigAhead.node.x.toFixed(0)},${sigAhead.node.z.toFixed(0)}`;
      // Waiting at a red is not an offence, and the crosswalk test needs to know.
      if (!green && d < 14) npc.heldAtRed = true;
      if (!green) {
        const willRun = npc._runThisRed ?? (npc._runThisRed = Math.random() < p.runRed);
        if (!willRun) {
          target = Math.min(target, clamp((d - 4.5) * 0.85, 0, target));
        } else if (d < 5 && npc.speed > 3.5 && !npc.stoppedAt.has(key)) {
          flagEvent(npc, 'RAN_RED', 45);
          npc.stoppedAt.add(key);
        }
      } else {
        npc._runThisRed = undefined;
      }
    }

    // ---- crosswalk occupancy + yielding to pedestrians
    const cross = this.nearestControl(this.crossNodes, npc.x, npc.z, 4.5);
    npc.onCrossing = !!cross;
    for (const ped of this.peds) {
      if (!ped.active || !ped.crossing) continue;
      const dx = ped.x - npc.x, dz = ped.z - npc.z;
      const d = Math.hypot(dx, dz);
      if (d > 22) continue;
      const fx = Math.sin(npc.heading), fz = Math.cos(npc.heading);
      const along = dx * fx + dz * fz;
      const lat = Math.abs(dx * -fz + dz * fx);
      if (along > 0 && along < 18 && lat < 3.2) {
        if (Math.random() < p.yield) {
          target = Math.min(target, clamp((along - 5) * 0.6, 0, target));
        } else if (along < 5 && npc.speed > 7) {
          flagEvent(npc, 'FTY_PED', 50);
          ped.alarm = 1.6;
        }
      }
    }

    // ---- e-bike specific mischief
    if (npc.kind === 'ebike') {
      if (p.id === 'aggressive' || p.id === 'reckless' || p.id === 'distracted') {
        npc.sidewalkTimer = (npc.sidewalkTimer || 0) + dt;
        if (npc.sidewalkTimer > 6 && Math.random() < 0.004) {
          flagEvent(npc, 'EBIKE_SIDEWALK', 30);
        }
        if (cross && npc.speed > 5 && Math.random() < 0.02) {
          flagEvent(npc, 'EBIKE_CROSSWALK', 30);
        }
      }
    }

    /* ---- failure to signal.
       `signalledTurn` and `pendingTurnAt` were already computed when the route
       picked a sharp turn, but nothing ever raised the violation, so the code
       and its statute were dead. Flag it as the car reaches the turn. */
    if (npc.pendingTurnAt !== undefined && npc.pathIdx >= npc.pendingTurnAt - 2) {
      if (!npc.signalledTurn) flagEvent(npc, 'NO_SIGNAL', 25);
      npc.pendingTurnAt = undefined;
    }

    // ---- weaving (visual + feeds the reckless test)
    npc.weaveEnergy = p.weave * (0.6 + 0.4 * Math.sin(this.time * 1.7 + npc.plate.charCodeAt(0)));
    npc.laneJitter = Math.sin(this.time * 2.3 + npc.plate.charCodeAt(1)) * p.weave * 1.15;

    // ---- apply acceleration limits
    const accelCap = npc.kind === 'ebike' ? 3.2 : (p.id === 'aggressive' || p.id === 'reckless' ? 6.2 : 3.6);
    const decelCap = npc.kind === 'ebike' ? 5.0 : 8.5;
    const prev = npc.speed;
    npc.speed = target > npc.speed
      ? approach(npc.speed, target, accelCap * dt)
      : approach(npc.speed, target, decelCap * dt);
    npc.decel = (prev - npc.speed) / Math.max(dt, 1e-3);
    npc.speed = Math.max(0, npc.speed);
  }

  _updatePed(ped, dt, player) {
    const w = this.world;
    ped.phase += dt;
    ped.alarm = Math.max(0, ped.alarm - dt);

    // Knocked down by a vehicle: fly, cartwheel, bounce, slide, get up.
    if (ped.down) {
      const recovered = stepDownedPed(ped, w, dt);
      const m = ped.mesh;
      m.position.set(ped.x, ped.y, ped.z);
      m.rotation.set(0, ped.heading, 0);
      const limbs = m.userData.limbs;
      if (ped.airborne) {
        // Mid-flight: full cartwheel around the pitch axis, limbs flailing.
        ped.cartwheel = (ped.cartwheel || 0) + dt * (3 + Math.abs(ped.spin || 0));
        m.rotateX(ped.cartwheel);
        m.rotateZ((ped.tumble || 0) * 0.2);
        m.children[0].position.y = 0.98;
        if (limbs) {
          const fl = Math.sin(ped.phase * 26);
          limbs.legL.rotation.x = 1.1 + fl * 0.5;
          limbs.legR.rotation.x = -0.9 - fl * 0.5;
          limbs.armL.rotation.x = -1.5 + fl * 0.6;
          limbs.armR.rotation.x = 1.3 - fl * 0.6;
        }
      } else {
        // Grounded: folded flat, sliding.
        m.rotateX(Math.PI / 2);
        m.rotateZ((ped.tumble || 0) * 0.35);
        m.children[0].position.y = 0.32;
        if (limbs) {
          limbs.legL.rotation.x = 0.25; limbs.legR.rotation.x = -0.2;
          limbs.armL.rotation.x = -0.4; limbs.armR.rotation.x = 0.35;
        }
      }
      if (recovered) {
        ped.down = false;
        ped.tumble = 0;
        ped.mesh.children[0].position.y = 0.88;
        ped.alarm = 3;
        // Walk away from the road, briskly.
        const near = w.nearestRoad(ped.x, ped.z, 30);
        if (near) {
          const dx = ped.x - near.x, dz = ped.z - near.z;
          const l = Math.hypot(dx, dz) || 1;
          ped.dirX = dx / l; ped.dirZ = dz / l;
        }
      }
      return;
    }

    if (ped.crossing) {
      ped.crossT += dt;
      ped.x += ped.dirX * ped.speed * dt * 1.15;
      ped.z += ped.dirZ * ped.speed * dt * 1.15;
      if (ped.crossT > 5) ped.crossing = false;
    } else {
      ped.x += ped.dirX * ped.speed * dt;
      ped.z += ped.dirZ * ped.speed * dt;
      // Occasionally step into a crossing.
      if (Math.random() < 0.0016) {
        const c = this.nearestControl(this.crossNodes, ped.x, ped.z, 25);
        if (c) {
          const dx = c.node.x - ped.x, dz = c.node.z - ped.z;
          const l = Math.hypot(dx, dz) || 1;
          ped.dirX = dx / l; ped.dirZ = dz / l;
          ped.crossing = true; ped.crossT = 0;
        }
      }
      // Stay near a road; turn around if we wander off.
      const near = w.nearestRoad(ped.x, ped.z, 30);
      if (!near || near.dist > near.seg.w / 2 + 4.5) {
        ped.dirX = -ped.dirX; ped.dirZ = -ped.dirZ;
        ped.x += ped.dirX * 0.7; ped.z += ped.dirZ * 0.7;
      }
    }

    const [cx, cz] = w.clampToWorld(ped.x, ped.z, 20);
    if (cx !== ped.x || cz !== ped.z) { ped.dirX = -ped.dirX; ped.dirZ = -ped.dirZ; }
    ped.x = cx; ped.z = cz;
    ped.y = w.heightAt(ped.x, ped.z);
    ped.heading = Math.atan2(ped.dirX, ped.dirZ);

    const m = ped.mesh;
    m.position.set(ped.x, ped.y + (ped.alarm > 0 ? Math.abs(Math.sin(ped.phase * 22)) * 0.12 : 0), ped.z);
    m.rotation.set(0, ped.heading, 0);
    // walk cycle: opposing leg/arm swing scaled by actual pace
    m.children[0].position.y = 0.98 + Math.sin(ped.phase * 7) * 0.03;
    const limbs = m.userData.limbs;
    if (limbs) {
      const swing = Math.sin(ped.phase * 7) * clamp(ped.speed * 0.42, 0, 0.62)
        * (ped.crossing ? 1.2 : 1);
      limbs.legL.rotation.x = swing;
      limbs.legR.rotation.x = -swing;
      limbs.armL.rotation.x = -swing * 0.7;
      limbs.armR.rotation.x = swing * 0.7;
    }
  }

  /** All active NPCs within a radius, nearest first. */
  near(x, z, r) {
    const out = [];
    for (const n of this.npcs) {
      if (!n.active) continue;
      const d = Math.hypot(n.x - x, n.z - z);
      if (d <= r) out.push({ npc: n, dist: d });
    }
    out.sort((a, b) => a.dist - b.dist);
    return out;
  }
}

/* ------------------------------------------------------------- ebike mesh */

function buildEbikeMesh() {
  const g = new THREE.Group();
  const frameMat = new THREE.MeshStandardMaterial({ color: 0x2b2f33, roughness: 0.5, metalness: 0.5 });
  const tireMat = new THREE.MeshStandardMaterial({ color: 0x131415, roughness: 0.95 });

  /* Wheels get the same steer-outer / spin-inner rig as the cars and are
     REGISTERED in userData — they were built and added but never recorded, so
     the draw loop's wheel animation silently did nothing on every bike. */
  const wheelGeo = new THREE.TorusGeometry(0.33, 0.075, 6, 12);
  const ebWheels = [];
  for (const z of [0.6, -0.6]) {
    const steerNode = new THREE.Group();
    steerNode.position.set(0, 0.33, z);
    steerNode.userData.front = z > 0;
    const spinNode = new THREE.Group();
    const wl = new THREE.Mesh(wheelGeo, tireMat);
    wl.rotation.y = Math.PI / 2;
    wl.castShadow = true;
    spinNode.add(wl);
    steerNode.add(spinNode);
    steerNode.userData.spin = spinNode;
    g.add(steerNode);
    ebWheels.push(steerNode);
  }
  const frame = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.20, 1.15), frameMat);
  frame.position.set(0, 0.56, 0);
  g.add(frame);
  const battery = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.26, 0.42), frameMat);
  battery.position.set(0, 0.48, 0.05);
  g.add(battery);
  const bars = new THREE.Mesh(new THREE.BoxGeometry(0.56, 0.05, 0.05), frameMat);
  bars.position.set(0, 0.98, 0.52);
  g.add(bars);

  // rider
  const riderMat = new THREE.MeshStandardMaterial({
    color: new THREE.Color().setHSL(Math.random(), 0.4, 0.42), roughness: 0.85,
  });
  const torso = new THREE.Mesh(new THREE.CapsuleGeometry(0.20, 0.5, 3, 6), riderMat);
  torso.position.set(0, 1.12, 0.02);
  torso.rotation.x = 0.28;
  torso.castShadow = true;
  const head = new THREE.Mesh(
    new THREE.SphereGeometry(0.15, 6, 5),
    new THREE.MeshStandardMaterial({ color: 0x2a2f36, roughness: 0.6 })
  );
  head.position.set(0, 1.56, 0.12);
  g.add(torso, head);

  // A rear lamp and a headlight, so a bike isn't invisible after dark.
  const headMat = new THREE.MeshStandardMaterial({ color: 0xfff2cc, emissive: 0x000000, roughness: 0.3 });
  const tailMat = new THREE.MeshStandardMaterial({ color: 0x8a1f18, emissive: 0x000000, roughness: 0.35 });
  const lampF = new THREE.Mesh(new THREE.BoxGeometry(0.10, 0.07, 0.05), headMat);
  lampF.position.set(0, 0.92, 0.72);
  const lampR = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.06, 0.04), tailMat);
  lampR.position.set(0, 0.80, -0.68);
  g.add(lampF, lampR);

  g.userData = { wheels: ebWheels, headMat, tailMat, wheelR: 0.33 };
  return g;
}
