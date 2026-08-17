import * as THREE from 'three';
import { buildSurfaces } from './textures.js';
import { SpatialHash } from '../core/util.js';

/* Roads follow the DEM directly — the 10 m USGS grid already contains the
   cut-and-fill grading of the real roadbed, so terrain-following geometry and
   terrain-sampling vehicles stay consistent with no floating or sinking.

   Widths come from the baked cross-sections (travel lanes + parking +
   shoulders), so a residential street is a real 34 ft curb to curb and Broad
   Ave is a real 48 ft. On top of the asphalt we lay: lane markings, a parking
   lane edge line, raised curbs, sidewalks, crosswalk zebras at the mapped
   crossing nodes, and stop bars at the mapped stop signs. */

const RESAMPLE = 6;
const Y_ROAD = 0.14;      // asphalt surface
const CURB_H = 0.15;      // curb reveal
const Y_MARK = 0.155;     // paint, just proud of asphalt
const Y_WALK = Y_ROAD + CURB_H;

function resample(pts, step) {
  const out = [pts[0]];
  let carry = 0;
  for (let i = 1; i < pts.length; i++) {
    const ax = pts[i - 1][0], az = pts[i - 1][1];
    const bx = pts[i][0], bz = pts[i][1];
    const seg = Math.hypot(bx - ax, bz - az);
    if (seg < 1e-6) continue;
    let d = step - carry;
    while (d < seg) {
      const t = d / seg;
      out.push([ax + (bx - ax) * t, az + (bz - az) * t]);
      d += step;
    }
    carry = seg - (d - step);
    out.push([bx, bz]);
  }
  return out;
}

/** Per-point unit right-normals, averaged across each joint. */
function normals(pts) {
  const nrm = [];
  for (let i = 0; i < pts.length; i++) {
    const p = pts[Math.max(0, i - 1)];
    const q = pts[Math.min(pts.length - 1, i + 1)];
    let dx = q[0] - p[0], dz = q[1] - p[1];
    const l = Math.hypot(dx, dz) || 1;
    dx /= l; dz /= l;
    nrm.push([-dz, dx]);
  }
  return nrm;
}

/* UVs are stored in METRES — u across the strip, v along it — so a material
   only has to set repeat = 1/tileSize to get correctly-scaled, seam-free
   detail regardless of how long the road is. */
class Ribbon {
  constructor() { this.v = []; this.i = []; this.uv = []; this.base = 0; }

  /** Flat strip centred on the polyline, `halfW` either side, at height +y. */
  add(world, pts, nrm, halfW, y, offset = 0) {
    const start = this.base;
    let dist = 0;
    for (let i = 0; i < pts.length; i++) {
      if (i > 0) dist += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
      const [x, z] = pts[i];
      const [nx, nz] = nrm[i];
      const cx = x + nx * offset, cz = z + nz * offset;
      const lx = cx - nx * halfW, lz = cz - nz * halfW;
      const rx = cx + nx * halfW, rz = cz + nz * halfW;
      this.v.push(lx, world.heightAt(lx, lz) + y, lz);
      this.v.push(rx, world.heightAt(rx, rz) + y, rz);
      this.uv.push(offset - halfW, dist, offset + halfW, dist);
    }
    for (let i = 0; i < pts.length - 1; i++) {
      const a = start + i * 2, b = a + 1, c = a + 2, d = a + 3;
      this.i.push(a, b, c, b, d, c);      // normals point +Y
    }
    this.base += pts.length * 2;
  }

  /** Vertical face at `offset` from the centreline, from y0 up to y1. */
  addWall(world, pts, nrm, offset, y0, y1, faceOut) {
    const start = this.base;
    let dist = 0;
    for (let i = 0; i < pts.length; i++) {
      if (i > 0) dist += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
      const [x, z] = pts[i];
      const [nx, nz] = nrm[i];
      const cx = x + nx * offset, cz = z + nz * offset;
      const g = world.heightAt(cx, cz);
      this.v.push(cx, g + y0, cz);
      this.v.push(cx, g + y1, cz);
      this.uv.push(y0, dist, y1, dist);
    }
    for (let i = 0; i < pts.length - 1; i++) {
      const a = start + i * 2, b = a + 1, c = a + 2, d = a + 3;
      if (faceOut) this.i.push(a, b, c, b, d, c);
      else this.i.push(a, c, b, b, c, d);
    }
    this.base += pts.length * 2;
  }

  addDashed(world, pts, nrm, halfW, y, on, off, offset = 0) {
    let run = [], runN = [], drawing = true, acc = 0;
    for (let i = 0; i < pts.length; i++) {
      if (i > 0) acc += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
      if (drawing) { run.push(pts[i]); runN.push(nrm[i]); }
      if (acc >= (drawing ? on : off)) {
        if (drawing && run.length > 1) this.add(world, run, runN, halfW, y, offset);
        drawing = !drawing;
        acc = 0;
        run = drawing ? [pts[i]] : [];
        runN = drawing ? [nrm[i]] : [];
      }
    }
    if (drawing && run.length > 1) this.add(world, run, runN, halfW, y, offset);
  }

  /** Arbitrary flat quad (used for zebra bars). */
  addQuad(world, p0, p1, p2, p3, y) {
    const q = this.base;
    const corners = [p0, p1, p2, p3];
    for (const p of corners) this.v.push(p[0], world.heightAt(p[0], p[1]) + y, p[1]);
    // Paint doesn't tile; a unit quad is enough.
    this.uv.push(0, 0, 1, 0, 1, 1, 0, 1);
    this.i.push(q, q + 1, q + 2, q, q + 2, q + 3);
    this.base += 4;
  }

  toGeometry() {
    if (!this.i.length) return null;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.v, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    g.setIndex(this.i);
    g.computeVertexNormals();
    g.computeBoundingSphere();
    return g;
  }
}

export function buildRoads(world, scene) {
  const asphalt = new Ribbon();
  const asphaltHwy = new Ribbon();
  const white = new Ribbon();
  const yellow = new Ribbon();
  const walk = new Ribbon();
  const curb = new Ribbon();

  /* Real intersections drop ALL markings inside the box — centre lines, lane
     dashes, edge lines — and the sidewalk stops at the kerb return instead of
     flying across the side street. Previously every ribbon ran straight
     through, double-striping every junction in town. Each junction gets a
     radius sized to the widest road that meets it. */
  const jRad = new Map();
  for (const e of world.network.edges) {
    const r = world.roads[e.road];
    const rad = r.w / 2 + 2.0;
    for (const j of [e.a, e.b]) jRad.set(j, Math.max(jRad.get(j) || 0, rad));
  }
  const jHash = new SpatialHash(40);
  world.network.junctions.forEach(([x, z], i) => {
    // Dead-end "junctions" (degree 1) shouldn't eat markings; keep them tiny.
    jHash.insert(x, z, { x, z, r: jRad.get(i) || 4 });
  });
  const _jq = [];
  const nearJunction = (x, z, scale) => {
    jHash.query(x, z, 24, _jq);
    for (const p of _jq) {
      const rr = p.r * scale;
      if ((p.x - x) * (p.x - x) + (p.z - z) * (p.z - z) < rr * rr) return true;
    }
    return false;
  };
  /** Split a polyline (+ its normals) into runs that stay clear of junctions. */
  const maskedRuns = (pts, nrm, scale = 1) => {
    const out = [];
    let curP = [], curN = [];
    for (let i = 0; i < pts.length; i++) {
      if (nearJunction(pts[i][0], pts[i][1], scale)) {
        if (curP.length > 1) out.push([curP, curN]);
        curP = []; curN = [];
      } else { curP.push(pts[i]); curN.push(nrm[i]); }
    }
    if (curP.length > 1) out.push([curP, curN]);
    return out;
  };

  for (const road of world.roads) {
    if (road.p.length < 2) continue;
    const pts = resample(road.p, RESAMPLE);
    if (pts.length < 2) continue;
    const nrm = normals(pts);
    const half = road.w / 2;
    const park = road.pk || 0;
    const sides = road.ps || 0;
    const travelHalf = Math.max(1.6, half - (sides > 0 ? park : 0));

    const isHwy = road.k === 'motorway' || road.k === 'trunk' || road.k.endsWith('_link');
    (isHwy ? asphaltHwy : asphalt).add(world, pts, nrm, half, Y_ROAD);

    // Markings and walkways get chopped at every junction; asphalt runs on.
    const markRuns = maskedRuns(pts, nrm, 1.0);
    const walkRuns = maskedRuns(pts, nrm, 1.25);

    // ---- curbs + sidewalks on in-town streets
    if (road.rk >= 2 && !isHwy) {
      for (const [rp, rn] of walkRuns) {
        for (const s of [-1, 1]) {
          curb.addWall(world, rp, rn, half * s, Y_ROAD - 0.02, Y_WALK, s > 0);
          walk.add(world, rp, rn, 1.15, Y_WALK, (half + 1.18) * s);
        }
      }
    }

    for (const [rp, rn] of markRuns) {
      // ---- edge lines at the outer limit of the travel way
      if (road.rk >= 2) {
        const inset = travelHalf - 0.30;
        white.add(world, rp, rn, 0.075, Y_MARK, -inset);
        white.add(world, rp, rn, 0.075, Y_MARK, inset);
      }

      // ---- centre line
      if (!road.ow && road.rk >= 3) {
        // double yellow on arterials
        yellow.add(world, rp, rn, 0.075, Y_MARK, -0.16);
        yellow.add(world, rp, rn, 0.075, Y_MARK, 0.16);
      } else if (!road.ow && travelHalf > 2.6) {
        yellow.addDashed(world, rp, rn, 0.075, Y_MARK, 3, 6, 0);
      }

      // ---- lane dividers between travel lanes
      const perDir = road.ow ? road.ln : road.ln / 2;
      if (perDir >= 2) {
        const laneW = travelHalf * (road.ow ? 2 : 1) / (road.ow ? road.ln : perDir);
        for (let k = 1; k < perDir; k++) {
          const o = road.ow ? -travelHalf + laneW * k : laneW * k;
          if (road.ow) white.addDashed(world, rp, rn, 0.07, Y_MARK, 3, 6, o);
          else {
            white.addDashed(world, rp, rn, 0.07, Y_MARK, 3, 6, o);
            white.addDashed(world, rp, rn, 0.07, Y_MARK, 3, 6, -o);
          }
        }
      }
    }
  }

  // ---- crosswalks and stop bars, placed on the real OSM nodes
  const crossings = world.props.signals.filter((s) => s.k === 'crossing' || s.k === 'signal');
  for (const c of crossings) {
    const near = world.nearestRoad(c.x, c.z, 22);
    if (!near || near.seg.rank < 2) continue;
    const s = near.seg;
    let dx = s.bx - s.ax, dz = s.bz - s.az;
    const l = Math.hypot(dx, dz) || 1;
    dx /= l; dz /= l;
    const nx = -dz, nz = dx;                       // across the road
    const hw = s.w / 2 - 0.15;
    // Zebra: bars running with traffic, spaced across the carriageway.
    const barW = 0.55, gap = 0.62, depth = 2.6;
    const count = Math.max(3, Math.floor((hw * 2) / (barW + gap)));
    for (let i = 0; i < count; i++) {
      const t = -hw + (i + 0.5) * ((hw * 2) / count);
      const cx = c.x + nx * t, cz = c.z + nz * t;
      const ax = dx * depth * 0.5, az = dz * depth * 0.5;
      const bx = nx * barW * 0.5, bz = nz * barW * 0.5;
      white.addQuad(world,
        [cx - ax - bx, cz - az - bz], [cx - ax + bx, cz - az + bz],
        [cx + ax + bx, cz + az + bz], [cx + ax - bx, cz + az - bz], Y_MARK);
    }
  }

  for (const st of world.props.signals.filter((s) => s.k === 'stop')) {
    const near = world.nearestRoad(st.x, st.z, 20);
    if (!near) continue;
    const s = near.seg;
    let dx = s.bx - s.ax, dz = s.bz - s.az;
    const l = Math.hypot(dx, dz) || 1;
    dx /= l; dz /= l;
    const nx = -dz, nz = dx;
    const hw = s.w / 2 - 0.2;
    // Bar spans the near half of the carriageway only.
    const cx = near.x, cz = near.z;
    const t0 = 0.15, t1 = hw;
    const ax = dx * 0.30, az = dz * 0.30;
    white.addQuad(world,
      [cx + nx * t0 - ax, cz + nz * t0 - az], [cx + nx * t1 - ax, cz + nz * t1 - az],
      [cx + nx * t1 + ax, cz + nz * t1 + az], [cx + nx * t0 + ax, cz + nz * t0 + az], Y_MARK);
  }

  const mk = (ribbon, matOpts, order, name) => {
    const g = ribbon.toGeometry();
    if (!g) return null;
    const m = new THREE.MeshStandardMaterial({
      polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4, ...matOpts,
    });
    const mesh = new THREE.Mesh(g, m);
    mesh.receiveShadow = true;
    mesh.renderOrder = order;
    mesh.name = name;
    scene.add(mesh);
    return mesh;
  };

  /* Detail maps. UVs are in metres, so repeat = 1/tileMetres. The sidewalk
     tile is 1.5 m so its baked control joint lands at real slab spacing. */
  const S = buildSurfaces();
  const tiled = (surf, metres) => {
    const map = surf.map.clone();
    const nrm = surf.normalMap.clone();
    for (const t of [map, nrm]) {
      t.wrapS = t.wrapT = THREE.RepeatWrapping;
      t.repeat.set(1 / metres, 1 / metres);
      t.needsUpdate = true;
    }
    return { map, normalMap: nrm };
  };

  const out = {};
  // Colours are the real surface hue; the maps only add variation on top.
  out.walk = mk(walk, {
    color: 0x7d7480, roughness: 1.0, metalness: 0.0,
    ...tiled(S.concrete, 1.5), normalScale: new THREE.Vector2(0.8, 0.8),
  }, 2, 'sidewalks');
  out.curb = mk(curb, {
    color: 0x847a86, roughness: 1.0,
    ...tiled(S.concrete, 1.5), normalScale: new THREE.Vector2(0.5, 0.5),
  }, 2, 'curbs');
  out.asphalt = mk(asphalt, {
    color: 0x2f2b3a, roughness: 1.0, metalness: 0.0, envMapIntensity: 0.12,
    ...tiled(S.asphalt, 4.0), normalScale: new THREE.Vector2(1.1, 1.1),
  }, 3, 'asphalt');
  out.highway = mk(asphaltHwy, {
    color: 0x363042, roughness: 1.0, metalness: 0.0, envMapIntensity: 0.12,
    ...tiled(S.asphalt, 4.5), normalScale: new THREE.Vector2(1.0, 1.0),
  }, 3, 'asphalt_hwy');
  out.yellow = mk(yellow, { color: 0xd9a848, roughness: 1.0, polygonOffsetFactor: -9, polygonOffsetUnits: -9 }, 4, 'lines_yellow');
  out.white = mk(white, { color: 0xd8ccb8, roughness: 1.0, polygonOffsetFactor: -9, polygonOffsetUnits: -9 }, 4, 'lines_white');

  if (world.rails.length) {
    const rail = new Ribbon();
    const tie = new Ribbon();
    for (const r of world.rails) {
      if (r.pts.length < 2) continue;
      const pts = resample(r.pts, 8);
      const nrm = normals(pts);
      tie.add(world, pts, nrm, 2.2, 0.16);
      rail.add(world, pts, nrm, 0.07, 0.36, -0.72);
      rail.add(world, pts, nrm, 0.07, 0.36, 0.72);
    }
    out.ties = mk(tie, { color: 0x453a30, roughness: 1.0 }, 2, 'rail_bed');
    out.rails = mk(rail, { color: 0x6e6660, roughness: 0.55, metalness: 0.0 }, 5, 'rails');
  }

  return out;
}
