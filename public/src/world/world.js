import { clamp, SpatialHash } from '../core/util.js';

/** Loads the baked world files and exposes terrain sampling + road queries. */
export class World {
  constructor(data) {
    Object.assign(this, data);   // meta, roads, network, buildings, areas, rails, props, terrain

    const t = this.terrain;
    this.tN = t.n;
    this.tW = t.w;
    this.tH = t.h;
    this.tE = t.e;
    this.halfW = t.w / 2;
    this.halfH = t.h / 2;

    this.roadHash = new SpatialHash(60);
    this.buildingHash = new SpatialHash(50);
    /* Reused query buffers. These three run hundreds of times a frame — five
       collideBuildings per line-of-sight ray alone — and the default `out = []`
       meant an array allocation on every one. */
    this._qRoad = [];
    this._qBuild = [];
    this._qName = [];
    this._buildIndices();
  }

  static async load(base = 'world') {
    const files = ['meta', 'roads', 'network', 'buildings', 'areas', 'rails', 'props', 'terrain'];
    const parts = await Promise.all(
      files.map((f) => fetch(`${base}/${f}.json`).then((r) => {
        if (!r.ok) throw new Error(`failed to load ${f}.json (${r.status})`);
        return r.json();
      }))
    );
    const data = {};
    files.forEach((f, i) => { data[f] = parts[i]; });
    return new World(data);
  }

  // ------------------------------------------------------------- terrain
  /** Bilinear elevation in metres at world (x, z). */
  heightAt(x, z) {
    const n = this.tN;
    const fx = clamp(((x + this.halfW) / this.tW) * (n - 1), 0, n - 1.0001);
    const fz = clamp(((z + this.halfH) / this.tH) * (n - 1), 0, n - 1.0001);
    const c0 = Math.floor(fx), r0 = Math.floor(fz);
    const c1 = Math.min(c0 + 1, n - 1), r1 = Math.min(r0 + 1, n - 1);
    const tx = fx - c0, tz = fz - r0;
    const e = this.tE;
    const h00 = e[r0 * n + c0], h10 = e[r0 * n + c1];
    const h01 = e[r1 * n + c0], h11 = e[r1 * n + c1];
    const a = h00 + (h10 - h00) * tx;
    const b = h01 + (h11 - h01) * tx;
    return a + (b - a) * tz;
  }

  /** Terrain normal, for tilting vehicles to the slope. */
  normalAt(x, z, eps = 4) {
    const hL = this.heightAt(x - eps, z), hR = this.heightAt(x + eps, z);
    const hD = this.heightAt(x, z - eps), hU = this.heightAt(x, z + eps);
    const nx = (hL - hR) / (2 * eps);
    const nz = (hD - hU) / (2 * eps);
    const len = Math.hypot(nx, 1, nz);
    return [nx / len, 1 / len, nz / len];
  }

  inBounds(x, z) {
    return x > -this.halfW && x < this.halfW && z > -this.halfH && z < this.halfH;
  }

  clampToWorld(x, z, margin = 8) {
    return [
      clamp(x, -this.halfW + margin, this.halfW - margin),
      clamp(z, -this.halfH + margin, this.halfH - margin),
    ];
  }

  // ------------------------------------------------------ spatial indices
  _buildIndices() {
    // Road segments, for "am I on the road / what's the speed limit here".
    this.segments = [];
    const edges = this.network.edges;
    for (let ei = 0; ei < edges.length; ei++) {
      const e = edges[ei];
      const road = this.roads[e.road];
      for (let i = 1; i < e.geom.length; i++) {
        const a = e.geom[i - 1], b = e.geom[i];
        const seg = {
          ax: a[0], az: a[1], bx: b[0], bz: b[1],
          road, edge: ei,
          w: road.w, mph: road.mph, name: road.n, rank: road.rk,
        };
        const si = this.segments.length;
        this.segments.push(seg);
        this.roadHash.insertAABB(
          Math.min(a[0], b[0]) - 6, Math.min(a[1], b[1]) - 6,
          Math.max(a[0], b[0]) + 6, Math.max(a[1], b[1]) + 6, si
        );
      }
    }

    // Building footprints for collision.
    this.buildingBounds = [];
    for (let bi = 0; bi < this.buildings.length; bi++) {
      const b = this.buildings[bi];
      let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
      for (const p of b.r) {
        if (p[0] < minX) minX = p[0];
        if (p[0] > maxX) maxX = p[0];
        if (p[1] < minZ) minZ = p[1];
        if (p[1] > maxZ) maxZ = p[1];
      }
      this.buildingBounds.push({ minX, minZ, maxX, maxZ, ring: b.r, h: b.h, i: bi });
      this.buildingHash.insertAABB(minX, minZ, maxX, maxZ, bi);
    }

    // Adjacency for NPC routing.
    this.adj = new Map();
    edges.forEach((e, i) => {
      if (!this.adj.has(e.a)) this.adj.set(e.a, []);
      if (!this.adj.has(e.b)) this.adj.set(e.b, []);
      this.adj.get(e.a).push({ edge: i, to: e.b, fwd: true });
      this.adj.get(e.b).push({ edge: i, to: e.a, fwd: false });
    });

    // Drivable edges (exclude footways — they were filtered at build time,
    // but service alleys still make poor NPC routes).
    this.driveEdges = [];
    edges.forEach((e, i) => {
      const r = this.roads[e.road];
      if (r.rk >= 2 && e.len > 12) this.driveEdges.push(i);
    });
  }

  /** Nearest road segment within `maxDist`, or null. */
  nearestRoad(x, z, maxDist = 30) {
    const cand = this.roadHash.query(x, z, maxDist, this._qRoad);
    let best = null, bestD = maxDist * maxDist;
    for (const si of cand) {
      const s = this.segments[si];
      const dx = s.bx - s.ax, dz = s.bz - s.az;
      const len2 = dx * dx + dz * dz;
      let t = len2 < 1e-9 ? 0 : ((x - s.ax) * dx + (z - s.az) * dz) / len2;
      t = clamp(t, 0, 1);
      const cx = s.ax + dx * t, cz = s.az + dz * t;
      const d2 = (x - cx) * (x - cx) + (z - cz) * (z - cz);
      if (d2 < bestD) { bestD = d2; best = { seg: s, x: cx, z: cz, dist: Math.sqrt(d2), t }; }
    }
    return best;
  }

  /** Posted limit (mph) at a position, and whether we're actually on pavement. */
  speedLimitAt(x, z) {
    const r = this.nearestRoad(x, z, 25);
    if (!r) return { mph: 25, onRoad: false, name: null, dist: Infinity };
    return {
      mph: r.seg.mph,
      onRoad: r.dist < r.seg.w * 0.5 + 1.5,
      name: r.seg.name,
      dist: r.dist,
      seg: r.seg,
    };
  }

  /** Solid-building test with push-out vector, used for vehicle collision. */
  collideBuildings(x, z, radius) {
    const cand = this.buildingHash.query(x, z, radius + 12, this._qBuild);
    let push = null;
    for (const bi of cand) {
      const bb = this.buildingBounds[bi];
      if (x < bb.minX - radius || x > bb.maxX + radius || z < bb.minZ - radius || z > bb.maxZ + radius) continue;
      const ring = bb.ring;
      // Distance to the footprint edges; treat the polygon as solid.
      let inside = false;
      let nearD = Infinity, nx = 0, nz = 0;
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const ax = ring[i][0], az = ring[i][1], bx2 = ring[j][0], bz2 = ring[j][1];
        if ((az > z) !== (bz2 > z) && x < ((bx2 - ax) * (z - az)) / (bz2 - az) + ax) inside = !inside;
        const ex = bx2 - ax, ez = bz2 - az;
        const l2 = ex * ex + ez * ez;
        let t = l2 < 1e-9 ? 0 : ((x - ax) * ex + (z - az) * ez) / l2;
        t = clamp(t, 0, 1);
        const px = ax + ex * t, pz = az + ez * t;
        const d = Math.hypot(x - px, z - pz);
        if (d < nearD) { nearD = d; nx = x - px; nz = z - pz; }
      }
      if (inside || nearD < radius) {
        const len = Math.hypot(nx, nz) || 1;
        const dir = inside ? -1 : 1;
        const depth = inside ? nearD + radius : radius - nearD;
        push = push || { x: 0, z: 0, depth: 0, bi: -1 };
        if (depth > push.depth) {
          push.x = (nx / len) * dir;
          push.z = (nz / len) * dir;
          push.depth = depth;
          push.bi = bi;      // which collider — lets impacts chain into parked cars
        }
      }
    }
    return push;
  }

  /** A random point on a drivable road, for spawning. */
  randomRoadPoint(minRank = 2) {
    const edges = this.network.edges;
    for (let tries = 0; tries < 60; tries++) {
      const ei = this.driveEdges[Math.floor(Math.random() * this.driveEdges.length)];
      const e = edges[ei];
      if (this.roads[e.road].rk < minRank) continue;
      const i = Math.floor(Math.random() * (e.geom.length - 1));
      const a = e.geom[i], b = e.geom[i + 1];
      const t = Math.random();
      return {
        x: a[0] + (b[0] - a[0]) * t,
        z: a[1] + (b[1] - a[1]) * t,
        edge: ei,
        heading: Math.atan2(b[0] - a[0], b[1] - a[1]),
      };
    }
    return { x: 0, z: 0, edge: this.driveEdges[0], heading: 0 };
  }

  /** Find the named street closest to a point (for HUD readout). */
  streetNameAt(x, z) {
    const cand = this.roadHash.query(x, z, 45, this._qName);
    let best = null, bestD = Infinity;
    for (const si of cand) {
      const s = this.segments[si];
      if (!s.name) continue;
      const dx = s.bx - s.ax, dz = s.bz - s.az;
      const len2 = dx * dx + dz * dz;
      let t = len2 < 1e-9 ? 0 : ((x - s.ax) * dx + (z - s.az) * dz) / len2;
      t = clamp(t, 0, 1);
      const cx = s.ax + dx * t, cz = s.az + dz * t;
      const d = Math.hypot(x - cx, z - cz);
      if (d < bestD) { bestD = d; best = s.name; }
    }
    return best;
  }
}
