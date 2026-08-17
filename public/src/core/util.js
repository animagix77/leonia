import * as THREE from 'three';

export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
export const lerp = (a, b, t) => a + (b - a) * t;
export const smooth = (a, b, t) => lerp(a, b, 1 - Math.pow(1 - t, 3));
export const rand = (a, b) => a + Math.random() * (b - a);
export const randInt = (a, b) => Math.floor(rand(a, b + 1));
export const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

/** Shortest signed angle from a to b, in radians. */
export function angleDelta(a, b) {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
}

/** Move `cur` toward `target` by at most `maxStep`. */
export function approach(cur, target, maxStep) {
  const d = target - cur;
  if (Math.abs(d) <= maxStep) return target;
  return cur + Math.sign(d) * maxStep;
}

export const MPS_TO_MPH = 2.23694;
export const MPH_TO_MPS = 1 / MPS_TO_MPH;

/** Deterministic hash-based PRNG so a given seed always yields the same town dressing. */
export function makeRng(seed) {
  let s = seed >>> 0;
  return function () {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* Uniform grid for broad-phase lookups (buildings, NPCs, road edges).

   Keys are INTEGERS, not template strings, and dedup uses a monotonic query
   stamp written onto the item rather than a fresh Set. This runs tens of
   thousands of times a frame — nearestRoad for every NPC and pedestrian,
   collideBuildings for every mover, five times per line-of-sight ray — and the
   old string-key + Set-per-call version allocated on every one of them. */
export class SpatialHash {
  static _ids = 0;
  constructor(cell = 50) {
    this.cell = cell;
    this.map = new Map();
    this._stamp = 0;
    /* Namespaced so two hashes cannot collide on the shared `_shq` property.
       Both counting from 1 meant the second hash to query an object it also
       held would see its own stamp already written and silently drop it. */
    this._sid = ++SpatialHash._ids;
  }
  _key(x, z) {
    // Pair two cell indices into one integer. 46341² just exceeds 2^31, and
    // the +32768 bias keeps negative coordinates in range for our world size.
    const gx = Math.floor(x / this.cell) + 32768;
    const gz = Math.floor(z / this.cell) + 32768;
    return gx * 65536 + gz;
  }
  /** Returns the bucket the item landed in, so movers can be re-homed. */
  insert(x, z, item) {
    const k = this._key(x, z);
    let b = this.map.get(k);
    if (!b) { b = []; this.map.set(k, b); }
    b.push(item);
    return b;
  }

  /** Move an item that already knows its current bucket to a new cell. */
  move(item, oldBucket, x, z) {
    const k = this._key(x, z);
    const target = this.map.get(k);
    if (target === oldBucket) return oldBucket;
    if (oldBucket) {
      const i = oldBucket.indexOf(item);
      if (i >= 0) oldBucket.splice(i, 1);
    }
    return this.insert(x, z, item);
  }
  insertAABB(minX, minZ, maxX, maxZ, item) {
    const c = this.cell;
    for (let gx = Math.floor(minX / c); gx <= Math.floor(maxX / c); gx++) {
      for (let gz = Math.floor(minZ / c); gz <= Math.floor(maxZ / c); gz++) {
        const k = (gx + 32768) * 65536 + (gz + 32768);
        let b = this.map.get(k);
        if (!b) { b = []; this.map.set(k, b); }
        b.push(item);
      }
    }
  }
  /* Dedup without allocating. Object items carry the stamp on themselves;
     numeric items (roadHash and buildingHash store plain indices, and a
     property assignment on a primitive throws under module strict mode) use a
     parallel stamp buffer indexed by the value. */
  _markNum(n, stamp) {
    let buf = this._numStamp;
    if (!buf || buf.length <= n) {
      const next = new Uint32Array(Math.max(1024, (n + 1) * 2));
      if (buf) next.set(buf);
      buf = this._numStamp = next;
    }
    if (buf[n] === stamp) return false;
    buf[n] = stamp;
    return true;
  }

  query(x, z, radius, out = []) {
    out.length = 0;
    const c = this.cell;
    // Stamps start at 1 so a zero-filled buffer never reads as "seen".
    const stamp = this._sid * 0x1000000 + (++this._stamp);
    const gx0 = Math.floor((x - radius) / c), gx1 = Math.floor((x + radius) / c);
    const gz0 = Math.floor((z - radius) / c), gz1 = Math.floor((z + radius) / c);
    for (let gx = gx0; gx <= gx1; gx++) {
      for (let gz = gz0; gz <= gz1; gz++) {
        const b = this.map.get((gx + 32768) * 65536 + (gz + 32768));
        if (!b) continue;
        for (let i = 0; i < b.length; i++) {
          const it = b[i];
          // An item spanning several cells is visited once per query.
          if (typeof it === 'number') {
            if (!this._markNum(it, stamp)) continue;
          } else {
            if (it._shq === stamp) continue;
            it._shq = stamp;
          }
          out.push(it);
        }
      }
    }
    return out;
  }
}


/** Signed area of a ring; negative means clockwise in our X/Z frame. */
export function ringArea(ring) {
  let a = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    a += (ring[j][0] + ring[i][0]) * (ring[j][1] - ring[i][1]);
  }
  return a / 2;
}


/* Polygon triangulation for building roofs and landuse decals.

   The previous hand-rolled ear-clipper failed constantly on real OSM data:
   it treated collinear vertices as reflex and never clipped them, and OSM
   footprints are full of collinear points from way-splitting. On a stall it
   returned a PARTIAL triangulation, which shipped buildings with holes in the
   roof that you could see straight down into.

   three's ShapeUtils is a properly hardened earcut. We keep two guarantees on
   top of it: a cap is always emitted (centroid-free fan fallback), and every
   triangle is wound so its normal is +Y in our X/Z frame. */
function signedArea2(ring, a, b, c) {
  return (ring[b][0] - ring[a][0]) * (ring[c][1] - ring[a][1]) -
         (ring[c][0] - ring[a][0]) * (ring[b][1] - ring[a][1]);
}

export function triangulate(ring) {
  const n = ring.length;
  if (n < 3) return [];

  let tri = [];
  try {
    const pts = ring.map((p) => new THREE.Vector2(p[0], p[1]));
    const faces = THREE.ShapeUtils.triangulateShape(pts, []);
    for (const f of faces) tri.push(f[0], f[1], f[2]);
  } catch {
    tri = [];
  }

  // A cap must always exist. If earcut under-produces, fan it — imperfect on
  // concave plans, but a slightly wrong roof beats a missing one every time.
  if (tri.length < (n - 2) * 3) {
    tri = [];
    for (let i = 1; i < n - 1; i++) tri.push(0, i, i + 1);
  }

  // Force every triangle to face upward.
  for (let i = 0; i < tri.length; i += 3) {
    if (signedArea2(ring, tri[i], tri[i + 1], tri[i + 2]) > 0) {
      const t = tri[i + 1];
      tri[i + 1] = tri[i + 2];
      tri[i + 2] = t;
    }
  }
  return tri;
}
