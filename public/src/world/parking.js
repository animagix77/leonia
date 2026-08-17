import * as THREE from 'three';
import { makeRng, SpatialHash } from '../core/util.js';
import { buildParkedVariant } from './carbuilder.js';
import { obbVsObb } from '../game/physics.js';
import { CAR_SPECS } from '../game/vehicle.js';

/* Parked cars along every street that carries a parking lane.

   Two purposes. Visually they're what makes a 34 ft residential street read as
   34 ft — an empty carriageway always looks like a runway. Mechanically they
   narrow the effective travel way, so threading Christie Heights at 40 takes
   actual commitment, and they're registered as solid colliders.

   They use the same lofted bodies as the cars you drive, instanced per
   variant, so a parked car and a moving car are the same object at the same
   fidelity rather than a good model next to eight crude props. */

/* Weighted to the real US fleet: roughly a quarter white, a fifth black,
   then silver and grey, and only then actual colours. */
const COLORS = [
  0xe8e9e6, 0xe8e9e6, 0xeceded, 0xdfe0dd,
  0x1d2124, 0x24272a, 0x1a1d20,
  0xb9bdc0, 0xc4c7c9, 0xaeb2b5,
  0x8d9196, 0x7c8085, 0x9aa0a4,
  0x2a4a7a, 0x27404f, 0x35526b,
  0x8f2b26, 0x6d2f2c,
  0x3d5445, 0x4a5c3e,
  0x9a8f7e, 0x7d7b6f,
];

// What actually sits at a Bergen County kerb overnight.
/* Deliberately SIX body types, not fifteen. Parked cars are chunked by cell,
   so every extra variant multiplies the mesh count across the whole borough —
   fifteen produced ~29,000 meshes and a draw-call wall far worse than the
   triangle cost it was meant to solve. Six still reads as a varied kerb. */
const PARKED_POOL = [
  CAR_SPECS.sedan, CAR_SPECS.sedan,
  CAR_SPECS.crossover, CAR_SPECS.crossover,
  CAR_SPECS.suv,
  CAR_SPECS.hatch,
  CAR_SPECS.pickup,
  CAR_SPECS.minivan,
];

const SPACING = 6.6;

export function buildParkedCars(world, scene) {
  const rng = makeRng(775511);
  const spots = [];

  /* No parking in an intersection. The per-road end clearance only guards a
     way's own endpoints, but most junctions tee into the MIDDLE of a long
     way — which parked cars straight through every corner. Keep every spot
     clear of the real junction set. */
  const jHash = new SpatialHash(40);
  for (const [jx, jz] of world.network.junctions) jHash.insert(jx, jz, { x: jx, z: jz });
  const _jq = [];
  const nearJunction = (x, z, r = 10) => {
    jHash.query(x, z, r + 4, _jq);
    for (const p of _jq) {
      if ((p.x - x) * (p.x - x) + (p.z - z) * (p.z - z) < r * r) return true;
    }
    return false;
  };

  for (const road of world.roads) {
    if (!road.ps || !road.pk) continue;
    if (road.rk < 2 || road.rk > 4) continue;

    const offset = road.w / 2 - road.pk * 0.5;

    // Cumulative arc length over the WHOLE polyline. OSM splits streets into
    // many short vertex pairs, so stepping per-segment leaves almost every
    // residential block empty.
    const pts = road.p;
    const cum = [0];
    for (let i = 1; i < pts.length; i++) {
      cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
    }
    const total = cum[cum.length - 1];
    const from = 10, to = total - 10;
    if (to - from < SPACING) continue;

    /* Each side of the street is walked independently, advancing by the
       ACTUAL length of the car just placed plus a varied bumper gap. The old
       fixed 6.6 m pitch let two same-colour cars sit nose-to-tail with a
       sliver of daylight between them, which read as one stretched limo.
       Runs of cars alternate with driveway-sized holes. */
    for (const side of road.ps >= 2 ? [-1, 1] : [1]) {
      let seg = 1;
      let run = rng() < 0.6;
      let runLeft = run ? 2 + Math.floor(rng() * 5) : 1;
      let lastColor = -1;
      let d = from + rng() * 5;

      while (d <= to) {
        if (runLeft-- <= 0) {
          run = !run;
          runLeft = run ? 2 + Math.floor(rng() * 5) : 1;
          if (!run) { d += 5 + rng() * 9; continue; }   // driveway-sized hole
        }
        const spec = PARKED_POOL[Math.floor(rng() * PARKED_POOL.length)];
        const mid = d + spec.len / 2;
        if (mid > to) break;

        while (seg < cum.length - 1 && cum[seg] < mid) seg++;
        const a = pts[seg - 1], b = pts[seg];
        const segLen = cum[seg] - cum[seg - 1];
        if (segLen < 1e-6) { d += spec.len + 1.2; continue; }
        const t = (mid - cum[seg - 1]) / segLen;
        const px = a[0] + (b[0] - a[0]) * t;
        const pz = a[1] + (b[1] - a[1]) * t;

        let dx = b[0] - a[0], dz = b[1] - a[1];
        const l = Math.hypot(dx, dz) || 1;
        dx /= l; dz /= l;
        const nx = -dz, nz = dx;
        const heading = Math.atan2(dx, dz);

        const cx = px + nx * offset * side;
        const cz = pz + nz * offset * side;
        // Advance by this car's real length either way, so a rejected spot
        // leaves a gap rather than compressing the run.
        d += spec.len + 0.9 + rng() * 1.5;
        if (nearJunction(px, pz)) continue;
        if (world.collideBuildings(cx, cz, 1.5)) continue;

        // Never the same colour twice in a row on the same kerb.
        let ci = Math.floor(rng() * COLORS.length);
        if (COLORS[ci] === lastColor) ci = (ci + 3) % COLORS.length;
        lastColor = COLORS[ci];

        spots.push({
          x: cx, z: cz,
          h: side > 0 ? heading : heading + Math.PI,
          c: COLORS[ci],
          jitter: (rng() - 0.5) * 0.16,
          spec,
        });
      }
    }
  }

  if (!spots.length) return { count: 0 };

  /* ---- chunk BEFORE grouping by variant.
     One town-wide InstancedMesh per body type meant every one of the ~24,000
     cars was vertex-processed and rasterised every frame, in the shadow pass
     and again in the colour pass, no matter where the camera pointed. Bucketing
     by a spatial cell first gives each mesh a tight bounding sphere, so normal
     frustum culling throws away everything off-screen and the 190 m shadow
     camera only sees what is near. */
  const CELL = 320;
  const buckets = new Map();
  for (const s of spots) {
    const key = `${Math.floor(s.x / CELL)},${Math.floor(s.z / CELL)}|${s.spec.key}`;
    let b = buckets.get(key);
    if (!b) { b = { spec: s.spec, list: [] }; buckets.set(key, b); }
    b.list.push(s);
  }

  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const e = new THREE.Euler();
  const one = new THREE.Vector3(1, 1, 1);
  const col = new THREE.Color();
  const variants = [];
  const cars = [];
  const hash = new SpatialHash(24);

  for (const { spec, list } of buckets.values()) {
    const v = buildParkedVariant(spec, list.length);

    list.forEach((s, i) => {
      // Sit on the asphalt surface, not the bare terrain underneath it.
      const y = world.heightAt(s.x, s.z) + 0.14;
      const h = s.h + s.jitter;
      e.set(0, h, 0);
      q.setFromEuler(e);
      m.compose(new THREE.Vector3(s.x, y, s.z), q, one);

      for (const key of ['body', 'glass', 'trim']) {
        if (v[key]) v[key].setMatrixAt(i, m);
      }
      if (v.body && v.body.instanceColor) v.body.setColorAt(i, col.setHex(s.c));

      const ch = Math.cos(h), sh = Math.sin(h);
      v.wheelPos.forEach(([wx, wy, wz], k) => {
        const worldX = s.x + wx * ch + wz * sh;
        const worldZ = s.z - wx * sh + wz * ch;
        m.compose(new THREE.Vector3(worldX, y + wy, worldZ), q, one);
        v.wheels.setMatrixAt(i * v.wheelPos.length + k, m);
      });

      /* The oriented rectangle used for contact. Deliberately NOT registered in
         world.buildingBounds: doing so made every parked car an immovable
         building, which (a) welded the "dynamic" parked cars back to the world,
         (b) pushed the player away on a 2.4 m circle so the real OBB test could
         never fire on a sideswipe, (c) blocked radar line-of-sight up every
         kerb, and (d) added 24,000 rects to the full-map draw. They live in
         `hash` and are resolved by resolveParkedContacts instead. */
      const hl = spec.len * 0.5, hw = spec.w * 0.5;
      const ring = [];
      for (const [ox, oz] of [[-hw, -hl], [hw, -hl], [hw, hl], [-hw, hl]]) {
        ring.push([s.x + ox * ch + oz * sh, s.z - ox * sh + oz * ch]);
      }
      let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
      for (const pt of ring) {
        minX = Math.min(minX, pt[0]); maxX = Math.max(maxX, pt[0]);
        minZ = Math.min(minZ, pt[1]); maxZ = Math.max(maxZ, pt[1]);
      }

      const car = {
        x: s.x, y, z: s.z, h,
        spec, variant: v, idx: i,
        vx: 0, vz: 0, vyaw: 0,
        moving: false, disturbed: false,
        bounds: { minX, minZ, maxX, maxZ, ring, h: spec.h, parked: true },
        cell: null,
      };
      cars.push(car);
      car.cell = hash.insert(s.x, s.z, car);
    });

    let ccx = 0, ccz = 0;
    for (const s2 of list) { ccx += s2.x; ccz += s2.z; }
    v.cx = ccx / list.length; v.cz = ccz / list.length;
    // Real extent of the chunk, so the cull can account for its size.
    let rr = 0;
    for (const s2 of list) {
      const d = Math.hypot(s2.x - v.cx, s2.z - v.cz);
      if (d > rr) rr = d;
    }
    v.radius = rr + 4;
    for (const mesh of v.meshes) {
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      mesh.computeBoundingSphere();
      scene.add(mesh);
    }
    variants.push(v);
  }

  console.log(`parked cars: ${spots.length} in ${buckets.size} culled chunks`);
  return { count: spots.length, variants, cars, hash, active: [] };
}

/* --------------------------------------------------- dynamic parked cars -- */

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _one = new THREE.Vector3(1, 1, 1);

/** Push the car's current transform back into its instanced slots. */
function writeTransform(car) {
  const v = car.variant;
  _e.set(0, car.h, 0);
  _q.setFromEuler(_e);
  _m.compose(new THREE.Vector3(car.x, car.y, car.z), _q, _one);
  for (const key of ['body', 'glass', 'trim']) {
    if (v[key]) { v[key].setMatrixAt(car.idx, _m); v[key].instanceMatrix.needsUpdate = true; }
  }
  const ch = Math.cos(car.h), sh = Math.sin(car.h);
  v.wheelPos.forEach(([wx, wy, wz], k) => {
    const worldX = car.x + wx * ch + wz * sh;
    const worldZ = car.z - wx * sh + wz * ch;
    _m.compose(new THREE.Vector3(worldX, car.y + wy, worldZ), _q, _one);
    v.wheels.setMatrixAt(car.idx * v.wheelPos.length + k, _m);
  });
  v.wheels.instanceMatrix.needsUpdate = true;
}

/** Refresh the static collider to wherever the car has ended up. */
function writeBounds(car) {
  const ch = Math.cos(car.h), sh = Math.sin(car.h);
  const hl = car.spec.len * 0.5, hw = car.spec.w * 0.5;
  const ring = car.bounds.ring;
  const corners = [[-hw, -hl], [hw, -hl], [hw, hl], [-hw, hl]];
  let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < 4; i++) {
    const [ox, oz] = corners[i];
    const x = car.x + ox * ch + oz * sh;
    const z = car.z - ox * sh + oz * ch;
    ring[i][0] = x; ring[i][1] = z;
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
  }
  // Mutating in place keeps the existing spatial-hash entry roughly valid;
  // parked cars never travel far enough to leave their cell.
  car.bounds.minX = minX; car.bounds.maxX = maxX;
  car.bounds.minZ = minZ; car.bounds.maxZ = maxZ;
}

/** Kick a parked car into motion. */
export function disturbParked(car, vx, vz, vyaw, parking) {
  car.vx += vx;
  car.vz += vz;
  car.vyaw += vyaw;
  if (!car.moving) {
    car.moving = true;
    car.disturbed = true;
    parking.active.push(car);
  }
}

/** Integrate the handful of parked cars currently in motion. */
export function stepParkedCars(parking, world, dt) {
  const act = parking.active;
  for (let i = act.length - 1; i >= 0; i--) {
    const car = act[i];
    const sp = Math.hypot(car.vx, car.vz);

    // Heavy rolling friction — a shunted car travels a couple of metres.
    const decel = 7.5 * dt;
    if (sp > decel) { car.vx -= (car.vx / sp) * decel; car.vz -= (car.vz / sp) * decel; }
    else { car.vx = 0; car.vz = 0; }
    car.vyaw *= Math.exp(-dt * 3.0);

    let nx = car.x + car.vx * dt;
    let nz = car.z + car.vz * dt;

    // Parked bounds are no longer in the world hash, so no exclusion needed.
    const push = world.collideBuildings(nx, nz, Math.max(car.spec.w, car.spec.len) * 0.42);
    if (push && push.depth > 0) {
      nx += push.x * push.depth;
      nz += push.z * push.depth;
      car.vx *= 0.25; car.vz *= 0.25; car.vyaw *= 0.4;
    }

    /* Chain into the cars ahead. player->parked and knocked-NPC->parked both
       resolve, but a shunted parked car passed clean through its neighbours,
       which is exactly where a kerb-side chain reaction should come from. */
    const near = parking.hash.query(nx, nz, 11, _pq);
    for (const other of near) {
      if (other === car) continue;
      const a = { x: nx, z: nz, hw: car.spec.w * 0.5, hl: car.spec.len * 0.5,
                  c: Math.cos(car.h), s: Math.sin(car.h) };
      const b = { x: other.x, z: other.z, hw: other.spec.w * 0.5, hl: other.spec.len * 0.5,
                  c: Math.cos(other.h), s: Math.sin(other.h) };
      const hit = obbVsObb(a, b);
      if (!hit) continue;
      nx -= hit.nx * hit.depth * 0.5;
      nz -= hit.nz * hit.depth * 0.5;
      disturbParked(other, car.vx * 0.5, car.vz * 0.5, (Math.random() - 0.5) * 0.6, parking);
      car.vx *= 0.5; car.vz *= 0.5;
      break;
    }

    car.x = nx; car.z = nz;
    car.h += car.vyaw * dt;
    car.y = world.heightAt(car.x, car.z) + 0.14;

    writeTransform(car);
    writeBounds(car);
    // A shunted car can leave its build-time cell; keep the hash honest so a
    // long chain doesn't slide a body out of every future query.
    car.cell = parking.hash.move(car, car.cell, car.x, car.z);

    if (Math.hypot(car.vx, car.vz) < 0.05 && Math.abs(car.vyaw) < 0.05) {
      car.vx = 0; car.vz = 0; car.vyaw = 0;
      car.moving = false;
      act.splice(i, 1);
    }
  }
}


/* Chunks beyond this are invisible in fog regardless, and skipping them keeps
   the parked fleet off both the colour and the shadow pass entirely. */
const PARKED_VIEW = 340;
const _pq = [];

export function cullParkedChunks(parking, camX, camZ) {
  if (!parking || !parking.variants) return 0;
  let shown = 0;
  for (const v of parking.variants) {
    const dx = v.cx - camX, dz = v.cz - camZ;
    /* Against the chunk's EXTENT, not its centroid. A 320 m cell has a 226 m
       half-diagonal, so a centroid test switched off whole blocks whose
       nearest car was only ~115 m away — well inside clear visibility. */
    const reach = PARKED_VIEW + (v.radius || 0);
    const on = dx * dx + dz * dz < reach * reach;
    if (on) shown++;
    for (const mesh of v.meshes) mesh.visible = on;
  }
  return shown;
}
