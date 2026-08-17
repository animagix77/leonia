import * as THREE from 'three';
import { clamp } from '../core/util.js';
import { hasAsset, instantiateAsset } from './vehicleassets.js';
import * as BufferGeometryUtils from '../../vendor/jsm/utils/BufferGeometryUtils.js';

/* Procedural vehicle bodies.

   The old cars were a box for the body, a box for the cabin and four
   cylinders. Every vehicle in town had the same silhouette at every distance,
   which is the single biggest reason the fleet read as placeholder art.

   These are LOFTED instead: a body is a series of cross-sections along the
   length, each an eight-sided chamfered ring whose half-width, floor and roof
   heights vary. Skinning between consecutive sections gives a real tapering
   hood, a shouldered beltline, tumblehome on the greenhouse and a distinct
   profile per archetype. A pickup gets a cab and a separate bed, a van gets a
   slab side and a high roof, a coupe gets a fastback — all from the same
   generator, so they stay cheap and consistent. */

/* ------------------------------------------------------------- geometry -- */

/** Eight-sided chamfered cross-section at a given station. */
function section(z, hw, y0, y1, cham) {
  const c = Math.min(cham, hw * 0.45, (y1 - y0) * 0.45);
  return [
    [-hw + c, y0], [hw - c, y0],
    [hw, y0 + c], [hw, y1 - c],
    [hw - c, y1], [-hw + c, y1],
    [-hw, y1 - c], [-hw, y0 + c],
  ].map(([x, y]) => [x, y, z]);
}

/** Skin consecutive sections into a closed hull. */
function loft(sections, out, col, shadeTop = 1.0) {
  const { V, N, C, I } = out;
  const N_RING = 8;
  const base = V.length / 3;

  for (const s of sections) {
    for (const [x, y, z] of s) {
      V.push(x, y, z);
      N.push(0, 0, 0);                       // filled by computeVertexNormals
      // Slight vertical gradient so flat colours still read as volume.
      const f = shadeTop;
      C.push(col.r * f, col.g * f, col.b * f);
    }
  }

  for (let s = 0; s < sections.length - 1; s++) {
    const a = base + s * N_RING;
    const b = base + (s + 1) * N_RING;
    for (let i = 0; i < N_RING; i++) {
      const j = (i + 1) % N_RING;
      // Wound so the hull faces outward. The reverse order put every normal
      // inward, so the bodies rendered as flattened see-through shells.
      I.push(a + i, a + j, b + i);
      I.push(a + j, b + j, b + i);
    }
  }

  // Caps, as fans around the ring centroid.
  for (const [idx, flip] of [[0, true], [sections.length - 1, false]]) {
    const ring = base + idx * N_RING;
    let cx = 0, cy = 0, cz = 0;
    for (const [x, y, z] of sections[idx]) { cx += x; cy += y; cz += z; }
    const ci = V.length / 3;
    V.push(cx / N_RING, cy / N_RING, cz / N_RING);
    N.push(0, 0, 0);
    C.push(col.r * shadeTop, col.g * shadeTop, col.b * shadeTop);
    for (let i = 0; i < N_RING; i++) {
      const j = (i + 1) % N_RING;
      if (flip) I.push(ci, ring + j, ring + i);
      else I.push(ci, ring + i, ring + j);
    }
  }
}

function box(out, col, cx, cy, cz, hx, hy, hz) {
  const { V, N, C, I } = out;
  const b = V.length / 3;
  const pts = [
    [-1, -1, -1], [1, -1, -1], [1, 1, -1], [-1, 1, -1],
    [-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1],
  ];
  for (const [sx, sy, sz] of pts) {
    V.push(cx + sx * hx, cy + sy * hy, cz + sz * hz);
    N.push(0, 0, 0);
    C.push(col.r, col.g, col.b);
  }
  const f = [
    [0, 1, 2, 3], [5, 4, 7, 6], [4, 0, 3, 7],
    [1, 5, 6, 2], [3, 2, 6, 7], [4, 5, 1, 0],
  ];
  for (const [a, bb, c, d] of f) I.push(b + a, b + bb, b + c, b + a, b + c, b + d);
}

function finish(out) {
  if (!out.I.length) return null;
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(out.V, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(out.C, 3));
  g.setIndex(out.I);
  g.computeVertexNormals();
  g.computeBoundingSphere();
  return g;
}

const newBuf = () => ({ V: [], N: [], C: [], I: [] });

/* ------------------------------------------------------------ archetypes -- */

/* Each profile returns body + greenhouse station lists in metres, with z
   running from tail (negative) to nose (positive) and y from the ground. */

function sedanProfile(L, W, H) {
  const hw = W / 2;
  const sill = H * 0.26, belt = H * 0.62, roof = H;
  return {
    body: [
      section(-L * 0.50, hw * 0.80, sill * 0.75, belt * 0.90, 0.10),
      section(-L * 0.44, hw * 0.96, sill * 0.55, belt * 0.99, 0.13),
      section(-L * 0.20, hw * 1.00, sill * 0.42, belt * 1.00, 0.14),
      section(L * 0.10, hw * 1.00, sill * 0.42, belt * 0.99, 0.14),
      section(L * 0.34, hw * 0.97, sill * 0.50, belt * 0.90, 0.13),
      section(L * 0.46, hw * 0.88, sill * 0.66, belt * 0.80, 0.11),
      section(L * 0.50, hw * 0.74, sill * 0.80, belt * 0.72, 0.08),
    ],
    green: [
      section(-L * 0.30, hw * 0.86, belt * 0.96, roof * 0.90, 0.10),
      section(-L * 0.16, hw * 0.90, belt * 0.96, roof, 0.12),
      section(L * 0.08, hw * 0.90, belt * 0.96, roof, 0.12),
      section(L * 0.22, hw * 0.84, belt * 0.96, roof * 0.90, 0.10),
    ],
  };
}

function coupeProfile(L, W, H) {
  const hw = W / 2;
  const sill = H * 0.24, belt = H * 0.60, roof = H;
  return {
    body: [
      section(-L * 0.50, hw * 0.84, sill * 0.80, belt * 0.94, 0.10),
      section(-L * 0.40, hw * 0.99, sill * 0.52, belt * 1.02, 0.14),
      section(-L * 0.10, hw * 1.00, sill * 0.40, belt * 1.00, 0.15),
      section(L * 0.16, hw * 0.99, sill * 0.40, belt * 0.96, 0.15),
      section(L * 0.38, hw * 0.94, sill * 0.50, belt * 0.84, 0.13),
      section(L * 0.50, hw * 0.76, sill * 0.72, belt * 0.70, 0.08),
    ],
    // fastback: roof falls continuously into the tail
    green: [
      section(-L * 0.34, hw * 0.80, belt * 0.94, roof * 0.72, 0.08),
      section(-L * 0.20, hw * 0.86, belt * 0.94, roof * 0.94, 0.11),
      section(0, hw * 0.87, belt * 0.94, roof, 0.12),
      section(L * 0.18, hw * 0.80, belt * 0.94, roof * 0.86, 0.10),
    ],
  };
}

function hatchProfile(L, W, H) {
  const hw = W / 2;
  const sill = H * 0.26, belt = H * 0.60, roof = H;
  return {
    body: [
      section(-L * 0.50, hw * 0.92, sill * 0.62, belt * 1.02, 0.12),
      section(-L * 0.36, hw * 1.00, sill * 0.44, belt * 1.02, 0.14),
      section(L * 0.06, hw * 1.00, sill * 0.42, belt * 0.99, 0.14),
      section(L * 0.32, hw * 0.96, sill * 0.52, belt * 0.88, 0.13),
      section(L * 0.50, hw * 0.78, sill * 0.74, belt * 0.74, 0.09),
    ],
    green: [
      section(-L * 0.44, hw * 0.88, belt * 0.98, roof * 0.94, 0.10),
      section(-L * 0.30, hw * 0.90, belt * 0.98, roof, 0.12),
      section(L * 0.02, hw * 0.90, belt * 0.98, roof, 0.12),
      section(L * 0.18, hw * 0.84, belt * 0.98, roof * 0.88, 0.10),
    ],
  };
}

function wagonProfile(L, W, H) {
  const hw = W / 2;
  const sill = H * 0.25, belt = H * 0.58, roof = H;
  return {
    body: [
      section(-L * 0.50, hw * 0.94, sill * 0.60, belt * 1.02, 0.12),
      section(-L * 0.40, hw * 1.00, sill * 0.44, belt * 1.02, 0.14),
      section(L * 0.10, hw * 1.00, sill * 0.42, belt * 0.99, 0.14),
      section(L * 0.34, hw * 0.97, sill * 0.50, belt * 0.90, 0.13),
      section(L * 0.50, hw * 0.78, sill * 0.72, belt * 0.74, 0.09),
    ],
    // long roof all the way to the tailgate
    green: [
      section(-L * 0.47, hw * 0.90, belt * 0.98, roof * 0.96, 0.10),
      section(-L * 0.34, hw * 0.92, belt * 0.98, roof, 0.12),
      section(L * 0.06, hw * 0.92, belt * 0.98, roof, 0.12),
      section(L * 0.22, hw * 0.85, belt * 0.98, roof * 0.90, 0.10),
    ],
  };
}

function suvProfile(L, W, H) {
  const hw = W / 2;
  const sill = H * 0.30, belt = H * 0.62, roof = H;
  return {
    body: [
      section(-L * 0.50, hw * 0.95, sill * 0.66, belt * 1.02, 0.11),
      section(-L * 0.42, hw * 1.00, sill * 0.50, belt * 1.02, 0.12),
      section(L * 0.14, hw * 1.00, sill * 0.48, belt * 1.00, 0.12),
      section(L * 0.36, hw * 0.98, sill * 0.54, belt * 0.94, 0.12),
      section(L * 0.50, hw * 0.84, sill * 0.70, belt * 0.84, 0.10),
    ],
    green: [
      section(-L * 0.47, hw * 0.93, belt * 0.99, roof * 0.97, 0.09),
      section(-L * 0.34, hw * 0.95, belt * 0.99, roof, 0.10),
      section(L * 0.14, hw * 0.95, belt * 0.99, roof, 0.10),
      section(L * 0.30, hw * 0.88, belt * 0.99, roof * 0.92, 0.09),
    ],
  };
}

function vanProfile(L, W, H) {
  const hw = W / 2;
  const sill = H * 0.22, roof = H;
  return {
    body: [
      section(-L * 0.50, hw * 0.97, sill * 0.70, roof * 0.97, 0.10),
      section(-L * 0.42, hw * 1.00, sill * 0.52, roof, 0.11),
      section(L * 0.20, hw * 1.00, sill * 0.50, roof, 0.11),
      section(L * 0.38, hw * 0.97, sill * 0.54, roof * 0.86, 0.12),
      section(L * 0.47, hw * 0.88, sill * 0.66, roof * 0.62, 0.10),
      section(L * 0.50, hw * 0.80, sill * 0.76, roof * 0.52, 0.08),
    ],
    green: [],
    windshieldAt: L * 0.30,
  };
}

function pickupProfile(L, W, H) {
  const hw = W / 2;
  const sill = H * 0.30, belt = H * 0.64, roof = H;
  return {
    body: [
      section(-L * 0.50, hw * 0.98, sill * 0.62, belt * 0.98, 0.10),
      section(-L * 0.06, hw * 1.00, sill * 0.54, belt * 0.98, 0.11),
      section(L * 0.02, hw * 1.00, sill * 0.52, belt * 1.02, 0.11),
      section(L * 0.34, hw * 0.99, sill * 0.56, belt * 0.96, 0.12),
      section(L * 0.50, hw * 0.86, sill * 0.72, belt * 0.84, 0.10),
    ],
    // cab only, over the front half
    green: [
      section(-L * 0.06, hw * 0.92, belt * 0.99, roof * 0.94, 0.09),
      section(L * 0.04, hw * 0.94, belt * 0.99, roof, 0.11),
      section(L * 0.20, hw * 0.90, belt * 0.99, roof * 0.94, 0.10),
    ],
    bed: { from: -L * 0.50, to: -L * 0.06, wallH: H * 0.20 },
  };
}

function boxTruckProfile(L, W, H) {
  const hw = W / 2;
  const sill = H * 0.28;
  return {
    body: [
      section(-L * 0.50, hw * 1.00, sill * 0.95, H * 0.98, 0.06),
      section(-L * 0.06, hw * 1.00, sill * 0.95, H * 0.98, 0.06),
      section(-L * 0.04, hw * 0.96, sill * 0.80, H * 0.70, 0.10),
      section(L * 0.30, hw * 0.96, sill * 0.72, H * 0.70, 0.10),
      section(L * 0.46, hw * 0.92, sill * 0.76, H * 0.56, 0.10),
      section(L * 0.50, hw * 0.84, sill * 0.84, H * 0.48, 0.08),
    ],
    green: [],
    windshieldAt: L * 0.24,
  };
}

function busProfile(L, W, H) {
  const hw = W / 2;
  const sill = H * 0.26;
  return {
    body: [
      section(-L * 0.50, hw * 0.94, sill * 0.86, H * 0.94, 0.14),
      section(-L * 0.46, hw * 1.00, sill * 0.62, H * 0.98, 0.16),
      section(L * 0.44, hw * 1.00, sill * 0.60, H * 0.98, 0.16),
      section(L * 0.50, hw * 0.92, sill * 0.72, H * 0.90, 0.14),
    ],
    green: [],
    windshieldAt: L * 0.42,
  };
}

export const PROFILES = {
  sedan: sedanProfile, coupe: coupeProfile, hatch: hatchProfile,
  wagon: wagonProfile, suv: suvProfile, crossover: suvProfile,
  van: vanProfile, pickup: pickupProfile, boxtruck: boxTruckProfile,
  bus: busProfile,
};

/* ------------------------------------------------------------ assembly --- */

const C = (hex) => new THREE.Color(hex);
const GLASS = C(0x11161d);
const DARK = C(0x15181b);
const CHROME = C(0xb6bcc2);
const LAMP_F = C(0xfff4d6);
const LAMP_R = C(0x8a1f18);

/**
 * Build one vehicle's geometry set. Returns geometries in local space with
 * y = 0 at the ground plane and +Z forward.
 */
export function buildVehicleGeometry(spec, rng = Math.random) {
  const L = spec.len, W = spec.w, H = spec.h;
  const prof = (PROFILES[spec.shape] || sedanProfile)(L, W, H);

  const body = newBuf();
  const glass = newBuf();
  const dark = newBuf();
  const chrome = newBuf();
  const lightsF = newBuf();
  const lightsR = newBuf();

  const white = C(0xffffff);
  loft(prof.body, body, white, 1.0);

  // Greenhouse: glass shell plus slim pillars in body colour.
  if (prof.green && prof.green.length > 1) {
    loft(prof.green, glass, GLASS, 1.0);
    // roof panel in body colour so the cabin isn't a floating glass box
    const first = prof.green[0], last = prof.green[prof.green.length - 1];
    const z0 = first[0][2], z1 = last[0][2];
    const topY = Math.max(...prof.green.map((s) => Math.max(...s.map((p) => p[1]))));
    const hwTop = Math.max(...prof.green.map((s) => Math.max(...s.map((p) => Math.abs(p[0])))));
    box(body, white, 0, topY - 0.012, (z0 + z1) / 2, hwTop * 0.90, 0.028, (z1 - z0) / 2 * 0.86);
  }

  // Flat windshield for vans, trucks and buses (no lofted greenhouse).
  if (prof.windshieldAt !== undefined) {
    const zz = prof.windshieldAt;
    box(glass, GLASS, 0, H * 0.68, zz, W * 0.44, H * 0.19, 0.05);
    for (const s of [-1, 1]) {
      box(glass, GLASS, s * W * 0.47, H * 0.62, zz - L * 0.10, 0.04, H * 0.13, L * 0.07);
    }
  }

  // ---- wheels
  const wr = spec.wheelR ?? clamp(H * 0.26, 0.28, 0.55);
  const track = W * 0.5 - wr * 0.28;
  const wheelZ = spec.wheelbase ? spec.wheelbase / 2 : L * 0.31;
  const wheelPos = [];
  for (const sz of [wheelZ, -wheelZ]) {
    for (const sx of [-1, 1]) wheelPos.push([sx * track, wr, sz, sx]);
  }
  // Dual rear wheels on the heavy stuff.
  if (spec.shape === 'boxtruck' || spec.shape === 'bus') {
    for (const sx of [-1, 1]) wheelPos.push([sx * (track - wr * 0.52), wr, -wheelZ - wr * 0.05, sx]);
  }

  // ---- wheel arches: a dark recess so the wheels sit in something
  for (const [wx, wy, wz] of wheelPos) {
    box(dark, DARK, wx * 0.92, wy + wr * 0.28, wz, W * 0.5 * 0.13, wr * 0.78, wr * 1.12);
  }

  // ---- rocker panel / underbody shadow catcher
  box(dark, DARK, 0, H * 0.12, 0, W * 0.47, H * 0.10, L * 0.44);

  // ---- bumpers
  const bumperY = H * (spec.shape === 'suv' || spec.shape === 'pickup' ? 0.30 : 0.26);
  box(dark, DARK, 0, bumperY, L * 0.5 - 0.04, W * 0.48, H * 0.09, 0.09);
  box(dark, DARK, 0, bumperY, -L * 0.5 + 0.04, W * 0.48, H * 0.09, 0.09);

  // ---- grille + front intake
  box(dark, DARK, 0, H * 0.42, L * 0.5 - 0.015, W * 0.30, H * 0.075, 0.035);
  box(chrome, CHROME, 0, H * 0.42, L * 0.5 - 0.005, W * 0.31, H * 0.018, 0.03);

  // ---- lamps
  const headY = H * 0.47, tailY = H * 0.50;
  for (const s of [-1, 1]) {
    box(lightsF, LAMP_F, s * W * 0.34, headY, L * 0.5 - 0.02, W * 0.10, H * 0.045, 0.04);
    box(lightsR, LAMP_R, s * W * 0.35, tailY, -L * 0.5 + 0.02, W * 0.09, H * 0.042, 0.035);
  }

  // ---- mirrors
  if (spec.shape !== 'bus') {
    for (const s of [-1, 1]) {
      box(dark, DARK, s * (W * 0.5 + 0.07), H * 0.60, L * 0.14, 0.075, 0.055, 0.10);
    }
  }

  // ---- door seams: thin dark inset lines, cheap but they break up the slab
  const doors = spec.shape === 'coupe' ? [L * 0.02] : [L * 0.10, -L * 0.14];
  for (const dz of doors) {
    for (const s of [-1, 1]) {
      box(dark, DARK, s * (W * 0.5 - 0.005), H * 0.44, dz, 0.006, H * 0.13, 0.012);
    }
  }

  // ---- plate
  box(chrome, C(0xdedcd2), 0, H * 0.30, -L * 0.5 - 0.015, 0.20, 0.10, 0.012);

  // ---- exhaust
  if (spec.shape !== 'bus' && spec.shape !== 'boxtruck') {
    box(dark, CHROME, W * 0.28, H * 0.17, -L * 0.5 + 0.03, 0.035, 0.035, 0.05);
  }

  // ---- pickup bed walls
  if (prof.bed) {
    const b = prof.bed;
    const cz = (b.from + b.to) / 2, hz = (b.to - b.from) / 2;
    const wallY = H * 0.64;
    for (const s of [-1, 1]) {
      box(body, white, s * (W * 0.5 - 0.045), wallY, cz, 0.045, b.wallH, hz);
    }
    box(body, white, 0, wallY, b.from + 0.05, W * 0.5, b.wallH, 0.05);
    box(dark, DARK, 0, H * 0.50, cz, W * 0.45, 0.03, hz * 0.95);   // bed floor
  }

  // ---- roof rails on wagons and SUVs
  if (spec.shape === 'wagon' || spec.shape === 'suv' || spec.shape === 'crossover') {
    for (const s of [-1, 1]) {
      box(dark, DARK, s * W * 0.36, H * 1.01, -L * 0.08, 0.035, 0.028, L * 0.18);
    }
  }

  return {
    body: finish(body),
    glass: finish(glass),
    dark: finish(dark),
    chrome: finish(chrome),
    lightsF: finish(lightsF),
    lightsR: finish(lightsR),
    wheelPos,
    wheelR: wr,
    wheelW: clamp(W * 0.115, 0.16, 0.30),
  };
}

/** A wheel: tyre, rim face and spokes. Oriented across X. */
export function buildWheelGeometry(r, w) {
  const tyre = new THREE.CylinderGeometry(r, r, w, 14, 1);
  tyre.rotateZ(Math.PI / 2);
  const rim = new THREE.CylinderGeometry(r * 0.62, r * 0.62, w * 1.02, 12, 1);
  rim.rotateZ(Math.PI / 2);
  return { tyre, rim };
}

/* ------------------------------------------------------------- meshes ---- */

const MAT_CACHE = new Map();
function mats() {
  if (MAT_CACHE.size) return MAT_CACHE;
  MAT_CACHE.set('body', new THREE.MeshStandardMaterial({
    vertexColors: true, roughness: 0.30, metalness: 0.55, envMapIntensity: 1.35,
  }));
  MAT_CACHE.set('glass', new THREE.MeshStandardMaterial({
    vertexColors: true, roughness: 0.06, metalness: 0.92, envMapIntensity: 1.9,
    transparent: true, opacity: 0.88,
  }));
  MAT_CACHE.set('dark', new THREE.MeshStandardMaterial({
    vertexColors: true, roughness: 0.72, metalness: 0.25, envMapIntensity: 0.8,
  }));
  MAT_CACHE.set('chrome', new THREE.MeshStandardMaterial({
    vertexColors: true, roughness: 0.16, metalness: 0.95, envMapIntensity: 1.8,
  }));
  // Shared across every parked chunk; instanceColor carries the per-car hue.
  MAT_CACHE.set('parkedBody', new THREE.MeshStandardMaterial({
    vertexColors: true, roughness: 0.30, metalness: 0.55, envMapIntensity: 1.35,
  }));
  // One batch for all the small non-glass parts of a parked car.
  MAT_CACHE.set('trimBatch', new THREE.MeshStandardMaterial({
    vertexColors: true, roughness: 0.55, metalness: 0.55, envMapIntensity: 1.2,
  }));
  MAT_CACHE.set('tyre', new THREE.MeshStandardMaterial({
    color: 0x121316, roughness: 0.95, metalness: 0.0,
  }));
  MAT_CACHE.set('rim', new THREE.MeshStandardMaterial({
    color: 0xa8aeb4, roughness: 0.28, metalness: 0.9, envMapIntensity: 1.6,
  }));
  return MAT_CACHE;
}

/** A full, individually-controllable vehicle (player and NPC traffic). */
export function buildVehicleMesh(spec, colorHex) {
  // An authored glTF for this class wins over the procedural body.
  if (spec.key && hasAsset(spec.key)) {
    const authored = instantiateAsset(spec.key, colorHex);
    if (authored) {
      authored.userData.spec = spec;
      return authored;
    }
  }

  const g = new THREE.Group();
  const geo = buildVehicleGeometry(spec);
  const M = mats();
  const col = new THREE.Color(colorHex);

  // Body colour rides on the material instance so each car can differ.
  const bodyMat = M.get('body').clone();
  bodyMat.color.copy(col);
  const chromeMat = M.get('chrome');
  const darkMat = M.get('dark');
  const glassMat = M.get('glass');

  let bodyMesh = null;
  if (geo.body) {
    bodyMesh = new THREE.Mesh(geo.body, bodyMat);
    bodyMesh.castShadow = true; bodyMesh.receiveShadow = true;
    g.add(bodyMesh);
  }
  if (geo.glass) g.add(new THREE.Mesh(geo.glass, glassMat));
  if (geo.dark) { const m = new THREE.Mesh(geo.dark, darkMat); m.castShadow = true; g.add(m); }
  if (geo.chrome) g.add(new THREE.Mesh(geo.chrome, chromeMat));

  // Front and rear lamps get their own materials so headlights, brake lights
  // and hazards can be driven independently.
  const headMat = new THREE.MeshStandardMaterial({
    vertexColors: true, emissive: 0x000000, roughness: 0.25,
  });
  const tailMat = new THREE.MeshStandardMaterial({
    vertexColors: true, emissive: 0x000000, roughness: 0.30,
  });
  if (geo.lightsF) g.add(new THREE.Mesh(geo.lightsF, headMat));
  if (geo.lightsR) g.add(new THREE.Mesh(geo.lightsR, tailMat));

  /* Wheels are two nested groups. The outer one steers about Y, the inner one
     spins about X. Putting both rotations on a single node meant the spin
     axis was being dragged around by the steer angle (and vice versa), so the
     fronts appeared to wobble rather than steer and roll independently. */
  const wg = buildWheelGeometry(geo.wheelR, geo.wheelW);
  const wheels = [];
  for (const [wx, wy, wz] of geo.wheelPos) {
    const steerNode = new THREE.Group();
    steerNode.position.set(wx, wy, wz);
    steerNode.userData.front = wz > 0;

    const spinNode = new THREE.Group();
    const t = new THREE.Mesh(wg.tyre, M.get('tyre'));
    t.castShadow = true;
    spinNode.add(t, new THREE.Mesh(wg.rim, M.get('rim')));
    steerNode.add(spinNode);
    steerNode.userData.spin = spinNode;

    g.add(steerNode);
    wheels.push(steerNode);
  }

  g.userData = { wheels, headMat, tailMat, bodyMat, bodyMesh, spec, wheelR: geo.wheelR };
  return g;
}

/* -------------------------------------------------- instanced (parked) --- */

/* Geometry is memoised per spec. Parked cars are chunked spatially, so this is
   called once per (cell x body type) — ~850 times for six distinct specs. Every
   one of those was rebuilding a byte-identical loft and uploading its own
   buffers: ~34 MB of redundant VRAM and 850 redundant lofts during load.
   buildVehicleGeometry is deterministic per spec, so sharing is safe, and
   three.js is happy to point many InstancedMeshes at one BufferGeometry. */
const PARKED_GEO = new Map();
function parkedGeometryFor(spec) {
  let g = PARKED_GEO.get(spec.key || spec.name);
  if (g) return g;

  const geo = buildVehicleGeometry(spec);
  const trimParts = [geo.dark, geo.chrome, geo.lightsF, geo.lightsR].filter(Boolean);
  const trimGeo = trimParts.length
    ? (trimParts.length === 1 ? trimParts[0] : BufferGeometryUtils.mergeGeometries(trimParts, false))
    : null;
  const wg = buildWheelGeometry(geo.wheelR, geo.wheelW);
  const wheelGeo = BufferGeometryUtils.mergeGeometries([wg.tyre, wg.rim], true);

  g = {
    body: geo.body, glass: geo.glass, trim: trimGeo, wheel: wheelGeo,
    wheelPos: geo.wheelPos, wheelR: geo.wheelR,
  };
  PARKED_GEO.set(spec.key || spec.name, g);
  return g;
}

/** Instance a memoised variant across one spatial chunk. */
export function buildParkedVariant(spec, count) {
  const geo = parkedGeometryFor(spec);
  const M = mats();
  const out = { meshes: [], wheelR: geo.wheelR, wheelPos: geo.wheelPos };

  // Shared too: instanceColor already carries the per-car variation, so a
  // per-chunk material clone bought nothing and cost 850 programs' worth of
  // uniform state.
  const bodyMat = M.get('parkedBody');
  /* Only the body silhouette needs to cast — glass, chrome, lamps and rims sit
     inside it and cost a second full shadow pass for no visible gain. And
     frustumCulled stays at its default true: the caller chunks these
     spatially, so each mesh has a tight bounding sphere worth culling. */
  const add = (g, mat, colored, shadow) => {
    if (!g) return null;
    const im = new THREE.InstancedMesh(g, mat, count);
    if (colored) {
      im.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(count * 3), 3);
    }
    // Only the body silhouette casts; glass, trim and rims sit inside it.
    im.castShadow = !!shadow;
    im.receiveShadow = true;
    out.meshes.push(im);
    return im;
  };

  out.body = add(geo.body, bodyMat, true, true);
  out.glass = add(geo.glass, M.get('glass'), false, false);
  out.trim = add(geo.trim, M.get('trimBatch'), false, false);

  const nW = geo.wheelPos.length;
  out.wheels = new THREE.InstancedMesh(geo.wheel, [M.get('tyre'), M.get('rim')], count * nW);
  out.wheels.castShadow = true;     // the contact shadow under the car
  out.wheels.receiveShadow = true;
  out.meshes.push(out.wheels);

  return out;
}

/** Headlights, brake lights and hazards, driven independently. */
export function setLights(mesh, { head = false, brake = false, hazard = false, blink = false }) {
  const ud = mesh.userData;
  if (!ud) return;
  if (ud.headMat) ud.headMat.emissive.setHex(head ? 0xfff0cc : 0x000000);
  if (ud.tailMat) {
    ud.tailMat.emissive.setHex(
      hazard && blink ? 0xff6a00 : brake ? 0xff1e0c : head ? 0x5e0f08 : 0x000000
    );
  }
}
