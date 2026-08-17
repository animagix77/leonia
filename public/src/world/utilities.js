import * as THREE from 'three';
import { makeRng, clamp } from '../core/util.js';

/* The stuff that actually makes a New Jersey street look like a New Jersey
   street, none of which is in OpenStreetMap:

   - wooden utility poles with crossarms, transformer cans and guy wires
   - overhead lines strung between them, with real catenary sag
   - asphalt driveways running from the curb to each house
   - fire hydrants, mailboxes, and bins at the kerb

   Bergen County never buried its distribution lines. A suburban street here
   without a pole line down one side reads as a movie backlot. */

const POLE_SPACING = 44;
const WIRE_SPANS = 7;          // segments per catenary, per wire

export function buildUtilities(world, scene) {
  const rng = makeRng(613613);
  const out = {};

  /* ------------------------------------------------------------- poles */
  const poles = [];
  for (const road of world.roads) {
    if (road.rk < 2 || road.rk > 4) continue;
    const pts = road.p;
    const cum = [0];
    for (let i = 1; i < pts.length; i++) {
      cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
    }
    const total = cum[cum.length - 1];
    if (total < POLE_SPACING) continue;

    // One side of the street only, chosen per road — that's how it's built.
    const side = rng() < 0.5 ? -1 : 1;
    const offset = road.w / 2 + 1.9;
    const line = [];
    let seg = 1;
    for (let d = 4; d <= total - 4; d += POLE_SPACING) {
      while (seg < cum.length - 1 && cum[seg] < d) seg++;
      const a = pts[seg - 1], b = pts[seg];
      const segLen = cum[seg] - cum[seg - 1];
      if (segLen < 1e-6) continue;
      const t = (d - cum[seg - 1]) / segLen;
      const px = a[0] + (b[0] - a[0]) * t;
      const pz = a[1] + (b[1] - a[1]) * t;
      let dx = b[0] - a[0], dz = b[1] - a[1];
      const l = Math.hypot(dx, dz) || 1;
      dx /= l; dz /= l;
      const nx = -dz, nz = dx;
      const cx = px + nx * offset * side;
      const cz = pz + nz * offset * side;
      if (world.collideBuildings(cx, cz, 0.8)) continue;
      const p = {
        x: cx, z: cz,
        y: world.heightAt(cx, cz),
        h: 9.4 + rng() * 1.3,
        rot: Math.atan2(dx, dz),
        xf: rng() < 0.22,          // carries a transformer
      };
      poles.push(p);
      line.push(p);
    }
    // Remember the run so we can string wire along it in order.
    if (line.length > 1) (out.runs = out.runs || []).push(line);
  }

  if (poles.length) {
    const woodMat = new THREE.MeshStandardMaterial({ color: 0x5a4a3b, roughness: 0.95, metalness: 0.0 });
    const metalMat = new THREE.MeshStandardMaterial({ color: 0x6b6f72, roughness: 0.6, metalness: 0.7 });

    const shaft = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.14, 0.19, 1, 7), woodMat, poles.length);
    const arm = new THREE.InstancedMesh(new THREE.BoxGeometry(2.4, 0.13, 0.13), woodMat, poles.length);
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const e = new THREE.Euler();

    poles.forEach((p, i) => {
      e.set(0, 0, 0); q.setFromEuler(e);
      m.compose(new THREE.Vector3(p.x, p.y + p.h / 2, p.z), q, new THREE.Vector3(1, p.h, 1));
      shaft.setMatrixAt(i, m);
      e.set(0, p.rot, 0); q.setFromEuler(e);
      m.compose(new THREE.Vector3(p.x, p.y + p.h - 0.85, p.z), q, new THREE.Vector3(1, 1, 1));
      arm.setMatrixAt(i, m);
    });
    shaft.instanceMatrix.needsUpdate = true;
    arm.instanceMatrix.needsUpdate = true;
    shaft.castShadow = true;
    arm.castShadow = true;
    scene.add(shaft, arm);

    // transformer cans
    const xf = poles.filter((p) => p.xf);
    if (xf.length) {
      const cans = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.38, 0.38, 0.95, 9), metalMat, xf.length);
      xf.forEach((p, i) => {
        m.compose(new THREE.Vector3(p.x + 0.42, p.y + p.h - 2.5, p.z), new THREE.Quaternion(), new THREE.Vector3(1, 1, 1));
        cans.setMatrixAt(i, m);
      });
      cans.instanceMatrix.needsUpdate = true;
      cans.castShadow = true;
      scene.add(cans);
    }

    /* ------------------------------------------------------- overhead wire */
    // Three conductors per span, each sagging in a parabola.
    const wireV = [];
    const heights = [0.15, 0.85, 1.55];      // below the pole top
    const lateral = [-0.95, 0.0, 0.95];      // across the crossarm
    for (const run of out.runs || []) {
      for (let i = 1; i < run.length; i++) {
        const a = run[i - 1], b = run[i];
        const span = Math.hypot(b.x - a.x, b.z - a.z);
        if (span > POLE_SPACING * 2.2) continue;      // gap in the run
        const sag = clamp(span * 0.035, 0.25, 1.5);
        const ax = Math.sin(a.rot + Math.PI / 2), az = Math.cos(a.rot + Math.PI / 2);
        for (let w = 0; w < 3; w++) {
          const y0 = a.y + a.h - heights[w];
          const y1 = b.y + b.h - heights[w];
          const ox = ax * lateral[w], oz = az * lateral[w];
          let px = a.x + ox, pz = a.z + oz, py = y0;
          for (let s = 1; s <= WIRE_SPANS; s++) {
            const t = s / WIRE_SPANS;
            const nx2 = a.x + (b.x - a.x) * t + ox;
            const nz2 = a.z + (b.z - a.z) * t + oz;
            // parabolic sag, zero at both poles, max at midspan
            const ny = y0 + (y1 - y0) * t - sag * 4 * t * (1 - t);
            wireV.push(px, py, pz, nx2, ny, nz2);
            px = nx2; py = ny; pz = nz2;
          }
        }
      }
    }
    if (wireV.length) {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(wireV, 3));
      const wires = new THREE.LineSegments(
        g, new THREE.LineBasicMaterial({ color: 0x1b1f22, transparent: true, opacity: 0.78 })
      );
      wires.name = 'overhead_wires';
      scene.add(wires);
      out.wires = wires;
    }
    console.log(`utilities: ${poles.length} poles, ${(wireV.length / 6) | 0} wire segments`);
  }

  /* ---------------------------------------------------------- driveways */
  // A strip of asphalt from the kerb to the front of each house.
  const dv = [], di = [];
  let dbase = 0;
  let driveways = 0;
  for (const b of world.buildings) {
    if (b.a < 55 || b.a > 700) continue;            // houses only
    let cx = 0, cz = 0;
    for (const p of b.r) { cx += p[0]; cz += p[1]; }
    cx /= b.r.length; cz /= b.r.length;

    const road = world.nearestRoad(cx, cz, 42);
    if (!road || road.seg.rank < 2) continue;
    const dist = road.dist;
    if (dist < 4 || dist > 34) continue;

    let dx = cx - road.x, dz = cz - road.z;
    const l = Math.hypot(dx, dz) || 1;
    dx /= l; dz /= l;

    // Start at the kerb, stop just short of the house wall.
    const start = road.seg.w / 2 + 0.1;
    const end = Math.max(start + 1.5, dist - 1.2);
    const halfW = 1.55;
    const px = -dz, pz = dx;
    const x0 = road.x + dx * start, z0 = road.z + dz * start;
    const x1 = road.x + dx * end, z1 = road.z + dz * end;

    const corners = [
      [x0 - px * halfW, z0 - pz * halfW], [x0 + px * halfW, z0 + pz * halfW],
      [x1 + px * halfW, z1 + pz * halfW], [x1 - px * halfW, z1 - pz * halfW],
    ];
    for (const c of corners) dv.push(c[0], world.heightAt(c[0], c[1]) + 0.13, c[1]);
    di.push(dbase, dbase + 1, dbase + 2, dbase, dbase + 2, dbase + 3);
    dbase += 4;
    driveways++;
  }
  if (di.length) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(dv, 3));
    g.setIndex(di);
    g.computeVertexNormals();
    const mesh = new THREE.Mesh(g, new THREE.MeshStandardMaterial({
      color: 0x2c2d2f, roughness: 0.9, metalness: 0.02,
      polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3,
    }));
    mesh.receiveShadow = true;
    mesh.renderOrder = 2;
    mesh.name = 'driveways';
    scene.add(mesh);
    out.driveways = mesh;
    console.log(`utilities: ${driveways} driveways`);
  }

  /* ------------------------------------------------- hydrants and bins */
  const hyd = [], bins = [];
  for (const road of world.roads) {
    if (road.rk < 2 || road.rk > 4) continue;
    const pts = road.p;
    let acc = 0;
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1], b = pts[i];
      let dx = b[0] - a[0], dz = b[1] - a[1];
      const len = Math.hypot(dx, dz);
      if (len < 1e-6) continue;
      dx /= len; dz /= len;
      acc += len;
      if (acc < 88) continue;
      acc = 0;
      const nx = -dz, nz = dx;
      const side = rng() < 0.5 ? -1 : 1;
      const off = (road.w / 2 + 1.5) * side;
      const hx = a[0] + dx * len * 0.5 + nx * off;
      const hz = a[1] + dz * len * 0.5 + nz * off;
      if (world.collideBuildings(hx, hz, 0.6)) continue;
      hyd.push([hx, hz, world.heightAt(hx, hz)]);
    }
  }
  if (hyd.length) {
    const hm = new THREE.MeshStandardMaterial({ color: 0xb8352c, roughness: 0.6, metalness: 0.25 });
    const body = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.14, 0.17, 0.72, 8), hm, hyd.length);
    const cap = new THREE.InstancedMesh(new THREE.SphereGeometry(0.15, 8, 6), hm, hyd.length);
    const m = new THREE.Matrix4();
    const one = new THREE.Vector3(1, 1, 1);
    hyd.forEach(([x, z, y], i) => {
      m.compose(new THREE.Vector3(x, y + 0.5, z), new THREE.Quaternion(), one);
      body.setMatrixAt(i, m);
      m.compose(new THREE.Vector3(x, y + 0.88, z), new THREE.Quaternion(), one);
      cap.setMatrixAt(i, m);
    });
    body.instanceMatrix.needsUpdate = true;
    cap.instanceMatrix.needsUpdate = true;
    body.castShadow = true;
    scene.add(body, cap);
    console.log(`utilities: ${hyd.length} hydrants`);
  }

  return out;
}
