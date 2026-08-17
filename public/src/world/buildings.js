import * as THREE from 'three';
import { triangulate, ringArea, makeRng, clamp } from '../core/util.js';

/* 6,300 real footprints, built up with proper massing:

   - hipped roofs on houses (inset-ring method, works on any convex-ish plan)
   - parapets and rooftop plant on flat-roofed commercial and apartment stock
   - window bays laid out per floor, as real glass that reflects the sky, with
     a warm lit subset that only shows after dark
   - chimneys, sills, and a ground-floor band so the street frontage reads

   Everything is merged into ~380 m chunks so the GPU sees a few hundred draw
   calls instead of tens of thousands, and frustum culling still discards most
   of the borough. */

const CHUNK = 380;

/* Painted trim and concrete sills, shared across every building. Kept below
   pure white — at exposure 1.5 a true white trim blows out and the frames
   read as glowing rectangles rather than painted wood. */
const TRIM = new THREE.Color(0xcbc6ba);
const SILL = new THREE.Color(0xb0aca2);

/* Construction material from the NJ MOD-IV assessment record, which we hold
   for ~93% of Leonia's footprints. A brick colonial and a painted frame cape
   are different buildings and shouldn't share a palette — this is most of
   what makes a street read as individual houses rather than recoloured copies. */
/* One harmony, not per-material realism. Values are held to a mid band —
   nothing reaches near-white — so facades stay as flat shapes carrying the
   sky's colour rather than blowing out and reading as untextured boxes. */
const MATERIAL_PALETTE = {
  brick:    [0x8a4a3a, 0x96543f, 0x7a4034, 0xa35f42, 0x6f3b32, 0x8b503c],
  stone:    [0x8a7f7c, 0x7d7370, 0x968a84, 0x6f6663],
  block:    [0x93887f, 0x877d76, 0x7c736d],
  stucco:   [0xc9a882, 0xd2b28c, 0xb99a78, 0xc2a179, 0xab8e70],
  aluminum: [0xa8a8a2, 0x9a9c9a, 0xb4b2aa, 0x8e918f, 0xbdbab1],
  // Painted clapboard gets the widest range, because it's paint.
  frame:    [0xd6c3a4, 0xc4b79e, 0x9fb0ae, 0x93a58f, 0xcbaa79,
             0xa8b2bd, 0x8a9c88, 0xd0b58e, 0xa89a8e, 0xb6bcbd],
};

/* Roof pitch tracks the era it was built in: pre-war housing here is steep,
   the post-war cape and colonial boom sits around 35-40 degrees, and anything
   built after the seventies is noticeably shallower. */
function pitchForYear(yr) {
  if (!yr) return 0.75;
  if (yr < 1930) return 0.95;
  if (yr < 1950) return 0.86;
  if (yr < 1970) return 0.78;
  if (yr < 1990) return 0.66;
  return 0.58;
}

const PALETTE = {
  house:              [0xb9a58c, 0xc7b49a, 0xa89881, 0xd0c3ab, 0x9c8f7c, 0xb0a08e, 0xc4b39c],
  detached:           [0xb9a58c, 0xc7b49a, 0xa89881, 0xd0c3ab],
  semidetached_house: [0xb5a189, 0xc2ae94, 0xa4947e],
  terrace:            [0xac9a86, 0xbba792, 0x9f9080],
  residential:        [0xa89a88, 0xb6a894, 0x9b8d7d],
  apartments:         [0x9a938c, 0x8e8781, 0xa89f96, 0x847d78],
  commercial:         [0x8f9296, 0x9aa0a4, 0x83878b],
  retail:             [0x97918a, 0xa39c94, 0x8b857f],
  office:             [0x7f878f, 0x8b939b, 0x767d85],
  industrial:         [0x8a8781, 0x7d7a75, 0x96938c],
  warehouse:          [0x86847e, 0x777570],
  church:             [0xc4bba8, 0xb5ab99],
  school:             [0xb4a893, 0xa89d8a],
  public:             [0xada494, 0xa09889],
  civic:              [0xada494],
  garage:             [0x9b968e, 0x8d8880, 0xa9a49b],
  garages:            [0x9b968e, 0x8d8880],
  shed:               [0x8f8a82, 0x807b74],
  roof:               [0x8a8680],
  hotel:              [0x8d949b],
  yes:                [0xb0a692, 0xa2988a, 0xbdb3a0, 0x968d81, 0xc0b6a4],
};
const ROOF = {
  house: 0x5c4438, detached: 0x5c4438, semidetached_house: 0x584235, terrace: 0x53412f,
  residential: 0x4f463c, apartments: 0x44413e, commercial: 0x3e4042, retail: 0x434140,
  office: 0x3a3e43, industrial: 0x403e3b, warehouse: 0x3c3a36, church: 0x4a3c37,
  school: 0x4c443c, public: 0x48433a, garage: 0x474540, garages: 0x474540,
  shed: 0x413e38, roof: 0x413e38, hotel: 0x3e4247, yes: 0x4d453c,
};

// Which building types get a pitched roof rather than a flat one.
const PITCHED = new Set([
  'house', 'detached', 'semidetached_house', 'terrace', 'residential',
  'church', 'shed', 'garage', 'garages', 'roof',
]);
// Flat roofs belong on commercial and apartment stock, never on housing.
const ALWAYS_FLAT = new Set([
  'apartments', 'commercial', 'retail', 'office', 'industrial',
  'warehouse', 'hotel', 'public', 'civic', 'school',
]);

/* Half of Leonia is tagged the generic `building=yes`. At a house-sized
   footprint that is, in fact, a house — giving it a flat commercial roof made
   whole blocks read as low-rise offices. Decide on size, not just the tag. */
function isPitched(b) {
  if (ALWAYS_FLAT.has(b.t)) return false;
  if (PITCHED.has(b.t)) return b.a < 1400;
  return b.a < 400;
}

/* ------------------------------------------------------------- geometry -- */

/** Inward angle-bisector inset. Returns null if the ring would self-destruct. */
function insetRing(ring, d) {
  const n = ring.length;
  const out = [];
  for (let i = 0; i < n; i++) {
    const p = ring[(i + n - 1) % n], c = ring[i], q = ring[(i + 1) % n];
    let e1x = c[0] - p[0], e1z = c[1] - p[1];
    let e2x = q[0] - c[0], e2z = q[1] - c[1];
    const l1 = Math.hypot(e1x, e1z), l2 = Math.hypot(e2x, e2z);
    if (l1 < 1e-6 || l2 < 1e-6) return null;
    e1x /= l1; e1z /= l1; e2x /= l2; e2z /= l2;
    // Ring is clockwise in our frame, so the inward normal is (-dz, dx) rotated.
    const n1x = e1z, n1z = -e1x;
    const n2x = e2z, n2z = -e2x;
    const denom = 1 + (n1x * n2x + n1z * n2z);
    if (Math.abs(denom) < 0.25) return null;         // near-reflex spike
    out.push([c[0] + (d * (n1x + n2x)) / denom, c[1] + (d * (n1z + n2z)) / denom]);
  }
  // Sanity: same orientation, still has meaningful area.
  const a0 = ringArea(ring), a1 = ringArea(out);
  if (Math.sign(a0) !== Math.sign(a1)) return null;
  if (Math.abs(a1) < Math.abs(a0) * 0.10) return null;
  return out;
}

function pushTri(I, a, b, c) { I.push(a, b, c); }

/** One quad with an explicit normal and per-corner shade. */
function quad(V, N, C, I, p0, p1, p2, p3, nx, ny, nz, col, shades) {
  const q = V.length / 3;
  V.push(p0[0], p0[1], p0[2], p1[0], p1[1], p1[2], p2[0], p2[1], p2[2], p3[0], p3[1], p3[2]);
  for (let k = 0; k < 4; k++) N.push(nx, ny, nz);
  for (let k = 0; k < 4; k++) {
    const f = shades ? shades[k] : 1;
    C.push(col.r * f, col.g * f, col.b * f);
  }
  pushTri(I, q, q + 2, q + 1);
  pushTri(I, q, q + 3, q + 2);
}

/* --------------------------------------------------------------- extrude -- */

function extrude(world, b, buf, rng) {
  const { V, N, C, I, WV, WN, WI, WC, LV, LI } = buf;

  let ring = b.r.slice();
  if (ringArea(ring) > 0) ring.reverse();          // make it clockwise, consistently
  const nPts = ring.length;
  if (nPts < 3) return;

  let base = Infinity;
  for (const p of ring) base = Math.min(base, world.heightAt(p[0], p[1]));
  base -= 0.35;

  // Assessed construction material wins over the generic type palette.
  const pal = (b.mat && MATERIAL_PALETTE[b.mat]) || PALETTE[b.t] || PALETTE.yes;
  const wall = new THREE.Color(pal[Math.floor(rng() * pal.length)]).multiplyScalar(0.88 + rng() * 0.24);
  // Masonry is rougher and flatter than painted siding.
  const masonry = b.mat === 'brick' || b.mat === 'stone' || b.mat === 'block' || b.mat === 'stucco';
  const roofCol = new THREE.Color(ROOF[b.t] ?? ROOF.yes).multiplyScalar(0.9 + rng() * 0.2);

  const pitched = isPitched(b);
  // Reserve headroom for the roof so total height still matches the OSM tag.
  const eaveH = pitched ? Math.max(2.6, b.h - 2.2) : b.h;
  const top = base + eaveH;

  // ---------------------------------------------------------------- walls
  // Window rows follow the ASSESSED storey count where we have it, so a
  // 1.5-storey cape gets a cape's fenestration, not a colonial's.
  const floors = b.st && b.st >= 1
    ? Math.max(1, Math.round(b.st))
    : Math.max(1, Math.round(eaveH / 3.15));
  const floorH = eaveH / floors;

  /* Retail frontage: any wall of a shop building that faces an arterial gets
     a storefront — continuous glazing at street level under a coloured
     signage fascia — instead of house windows. This is what turns Broad Ave
     from apartment slabs into a main street. */
  let shopEdges = null;
  if ((b.t === 'retail' || b.t === 'commercial') && eaveH >= 3.4) {
    for (let i = 0; i < nPts; i++) {
      const a = ring[i], c = ring[(i + 1) % nPts];
      const mx = (a[0] + c[0]) / 2, mz = (a[1] + c[1]) / 2;
      const nr = world.nearestRoad(mx, mz, 25);
      if (nr && nr.seg.rank >= 3 && nr.dist < 22) {
        if (!shopEdges) shopEdges = new Set();
        shopEdges.add(i);
      }
    }
  }
  const FASCIA_COLORS = [0x7a3b2e, 0x2e4a3d, 0x2f3d5c, 0x6b5430, 0x4a2e40, 0x384038];
  const fascia = new THREE.Color(FASCIA_COLORS[Math.floor(rng() * FASCIA_COLORS.length)]);

  for (let i = 0; i < nPts; i++) {
    const a = ring[i], c = ring[(i + 1) % nPts];
    let dx = c[0] - a[0], dz = c[1] - a[1];
    const len = Math.hypot(dx, dz);
    if (len < 0.05) continue;
    dx /= len; dz /= len;
    const nx = dz, nz = -dx;                       // outward for a clockwise ring

    quad(V, N, C, I,
      [a[0], base, a[1]], [c[0], base, c[1]], [c[0], top, c[1]], [a[0], top, a[1]],
      nx, 0, nz, wall, [0.70, 0.70, 1.04, 1.04]);

    // ---- window bays on this wall
    if (len < 2.2 || eaveH < 3.0) continue;
    const bayW = b.t === 'apartments' || b.t === 'office' || b.t === 'commercial' ? 2.5 : 3.1;
    const bays = Math.max(1, Math.floor(len / bayW));
    const winW = Math.min(1.35, (len / bays) * 0.46);
    const winH = Math.min(1.45, floorH * 0.46);
    /* The wall is a solid quad with no opening cut in it, so the glass has to
       sit just PROUD of it or it is buried inside the solid and invisible.
       Depth order outward: wall 0 · glass 0.025 · trim 0.05 · sill 0.11. */
    const off = 0.025;

    for (let f = 0; f < floors; f++) {
      // Storefront edges replace their ground-floor windows with the glazing band.
      if (f === 0 && shopEdges && shopEdges.has(i)) continue;
      const yMid = base + floorH * (f + 0.55);
      if (yMid + winH / 2 > top - 0.25) continue;
      for (let k = 0; k < bays; k++) {
        if (rng() < 0.07) continue;                // the odd blank bay
        const t = (k + 0.5) / bays;
        const cxp = a[0] + dx * len * t, czp = a[1] + dz * len * t;
        const hx = dx * winW * 0.5, hz = dz * winW * 0.5;
        const y0 = yMid - winH / 2, y1 = yMid + winH / 2;

        /* White trim around every opening. With no texture maps anywhere,
           this is the single highest-value bit of geometry in the project:
           painted trim against coloured siding is THE signature of American
           residential architecture, and without it the windows read as
           punched voids in cardboard. Four quads per window. */
        const tw = 0.10;                            // trim width
        const to = 0.05;                            // stands proud of the glass
        const ex = dx * (winW * 0.5 + tw), ez = dz * (winW * 0.5 + tw);
        const ty0 = y0 - tw, ty1 = y1 + tw;
        const P = (sx, sy) => [cxp + sx[0] + nx * to, sy, czp + sx[1] + nz * to];
        const L = [-ex, -ez], R = [ex, ez], li = [-hx, -hz], ri = [hx, hz];
        // top band, bottom band, left jamb, right jamb
        quad(V, N, C, I, P(L, y1), P(R, y1), P(R, ty1), P(L, ty1), nx, 0, nz, TRIM, null);
        quad(V, N, C, I, P(L, ty0), P(R, ty0), P(R, y0), P(L, y0), nx, 0, nz, TRIM, null);
        quad(V, N, C, I, P(L, ty0), P(li, ty0), P(li, ty1), P(L, ty1), nx, 0, nz, TRIM, null);
        quad(V, N, C, I, P(ri, ty0), P(R, ty0), P(R, ty1), P(ri, ty1), nx, 0, nz, TRIM, null);
        // sill, protruding a little further so it catches a shadow
        const so = to + 0.07;
        quad(V, N, C, I,
          [cxp - ex + nx * so, ty0, czp - ez + nz * so],
          [cxp + ex + nx * so, ty0, czp + ez + nz * so],
          [cxp + ex + nx * to, ty0 - 0.07, czp + ez + nz * to],
          [cxp - ex + nx * to, ty0 - 0.07, czp - ez + nz * to],
          nx, 0.45, nz, SILL, null);

        const p0 = [cxp - hx + nx * off, y0, czp - hz + nz * off];
        const p1 = [cxp + hx + nx * off, y0, czp + hz + nz * off];
        const p2 = [cxp + hx + nx * off, y1, czp + hz + nz * off];
        const p3 = [cxp - hx + nx * off, y1, czp - hz + nz * off];

        const q = WV.length / 3;
        WV.push(...p0, ...p1, ...p2, ...p3);
        for (let m = 0; m < 4; m++) WN.push(nx, 0, nz);
        for (let m = 0; m < 4; m++) WC.push(1, 1, 1);
        WI.push(q, q + 2, q + 1, q, q + 3, q + 2);

        // A subset of windows are lit after dark.
        if (rng() < 0.34) {
          const lq = LV.length / 3;
          const o2 = off + 0.012;
          LV.push(
            cxp - hx + nx * o2, y0, czp - hz + nz * o2,
            cxp + hx + nx * o2, y0, czp + hz + nz * o2,
            cxp + hx + nx * o2, y1, czp + hz + nz * o2,
            cxp - hx + nx * o2, y1, czp - hz + nz * o2
          );
          LI.push(lq, lq + 2, lq + 1, lq, lq + 3, lq + 2);
        }
      }
    }

    // ---- storefront: glazing band + signage fascia on street-facing walls
    if (shopEdges && shopEdges.has(i) && len > 3.5) {
      const gy = world.heightAt((a[0] + c[0]) / 2, (a[1] + c[1]) / 2);
      const g0 = gy + 0.35, g1 = Math.min(gy + 2.9, base + eaveH - 0.8);
      const inset = len * 0.06;
      const ax0 = a[0] + dx * inset, az0 = a[1] + dz * inset;
      const cx0 = c[0] - dx * inset, cz0 = c[1] - dz * inset;
      const so = 0.03;
      // glass
      const q = WV.length / 3;
      WV.push(
        ax0 + nx * so, g0, az0 + nz * so, cx0 + nx * so, g0, cz0 + nz * so,
        cx0 + nx * so, g1, cz0 + nz * so, ax0 + nx * so, g1, az0 + nz * so
      );
      for (let m2 = 0; m2 < 4; m2++) { WN.push(nx, 0, nz); WC.push(1, 1, 1); }
      WI.push(q, q + 2, q + 1, q, q + 3, q + 2);
      // signage fascia above the glass, proud of the wall
      quad(V, N, C, I,
        [ax0 + nx * 0.08, g1, az0 + nz * 0.08], [cx0 + nx * 0.08, g1, cz0 + nz * 0.08],
        [cx0 + nx * 0.08, g1 + 0.7, cz0 + nz * 0.08], [ax0 + nx * 0.08, g1 + 0.7, az0 + nz * 0.08],
        nx, 0, nz, fascia, null);
      // slim base bulkhead under the glass
      quad(V, N, C, I,
        [ax0 + nx * so, gy + 0.02, az0 + nz * so], [cx0 + nx * so, gy + 0.02, cz0 + nz * so],
        [cx0 + nx * so, g0, cz0 + nz * so], [ax0 + nx * so, g0, az0 + nz * so],
        nx, 0, nz, SILL, null);
    }
  }

  /* ---- front door + stoop.
     Every house previously presented four sealed walls — no way in. The door
     goes on the wall facing the nearest street, with a concrete stoop, which
     is exactly where a NJ front door lives. */
  if (pitched && b.a > 40 && b.a < 450) {
    let doorEdge = -1, doorDist = 34;
    for (let i = 0; i < nPts; i++) {
      const a = ring[i], c = ring[(i + 1) % nPts];
      const len = Math.hypot(c[0] - a[0], c[1] - a[1]);
      if (len < 2.6) continue;
      const nr = world.nearestRoad((a[0] + c[0]) / 2, (a[1] + c[1]) / 2, 34);
      if (nr && nr.dist < doorDist) { doorDist = nr.dist; doorEdge = i; }
    }
    if (doorEdge >= 0) {
      const a = ring[doorEdge], c = ring[(doorEdge + 1) % nPts];
      let dx = c[0] - a[0], dz = c[1] - a[1];
      const len = Math.hypot(dx, dz);
      dx /= len; dz /= len;
      const nx = dz, nz = -dx;
      const t = 0.5 + (rng() - 0.5) * 0.36;
      const mx = a[0] + dx * len * t, mz = a[1] + dz * len * t;
      const gy = world.heightAt(mx, mz);
      const dw = 0.48, dh = 2.05;
      const doorCol = new THREE.Color([0x3a2b22, 0x4a2325, 0x22303c, 0x2c3a2e][Math.floor(rng() * 4)]);
      // surround first, then the door leaf proud of it
      quad(V, N, C, I,
        [mx - dx * (dw + 0.09) + nx * 0.04, gy, mz - dz * (dw + 0.09) + nz * 0.04],
        [mx + dx * (dw + 0.09) + nx * 0.04, gy, mz + dz * (dw + 0.09) + nz * 0.04],
        [mx + dx * (dw + 0.09) + nx * 0.04, gy + dh + 0.12, mz + dz * (dw + 0.09) + nz * 0.04],
        [mx - dx * (dw + 0.09) + nx * 0.04, gy + dh + 0.12, mz - dz * (dw + 0.09) + nz * 0.04],
        nx, 0, nz, TRIM, null);
      quad(V, N, C, I,
        [mx - dx * dw + nx * 0.06, gy, mz - dz * dw + nz * 0.06],
        [mx + dx * dw + nx * 0.06, gy, mz + dz * dw + nz * 0.06],
        [mx + dx * dw + nx * 0.06, gy + dh, mz + dz * dw + nz * 0.06],
        [mx - dx * dw + nx * 0.06, gy + dh, mz - dz * dw + nz * 0.06],
        nx, 0, nz, doorCol, null);
      // stoop: two concrete steps out toward the walk
      for (const [depth, h] of [[0.95, 0.32], [0.55, 0.16]]) {
        const sy = gy + h;
        const swd = dw + 0.35;
        quad(V, N, C, I,      // tread
          [mx - dx * swd + nx * 0.06, sy, mz - dz * swd + nz * 0.06],
          [mx + dx * swd + nx * 0.06, sy, mz + dz * swd + nz * 0.06],
          [mx + dx * swd + nx * depth, sy, mz + dz * swd + nz * depth],
          [mx - dx * swd + nx * depth, sy, mz - dz * swd + nz * depth],
          0, 1, 0, SILL, null);
        quad(V, N, C, I,      // riser
          [mx - dx * swd + nx * depth, gy - 0.15, mz - dz * swd + nz * depth],
          [mx + dx * swd + nx * depth, gy - 0.15, mz + dz * swd + nz * depth],
          [mx + dx * swd + nx * depth, sy, mz + dz * swd + nz * depth],
          [mx - dx * swd + nx * depth, sy, mz - dz * swd + nz * depth],
          nx, 0, nz, SILL, null);
      }
    }
  }

  // ----------------------------------------------------------------- roof
  if (pitched) {
    const shortest = Math.sqrt(Math.max(b.a, 20)) * 0.5;
    const d = clamp(shortest * 0.55, 0.9, 2.6);

    /* ---- gable path for simple rectangular plans.
       Every pitched roof used to be a hip. Real NJ blocks are a MIX, and the
       gable — two slopes meeting at a ridge, triangular siding at each end —
       is the majority shape for this housing stock. Any 4-corner footprint
       with a sane aspect gets one; L-shaped and odd plans keep the hip. */
    if (nPts === 4) {
      const e01 = Math.hypot(ring[1][0] - ring[0][0], ring[1][1] - ring[0][1]);
      const e12 = Math.hypot(ring[2][0] - ring[1][0], ring[2][1] - ring[1][1]);
      const shortSpan = Math.min(e01, e12);
      const aspect = Math.max(e01, e12) / Math.max(0.01, shortSpan);
      if (aspect < 3.4 && shortSpan > 3.0 && rng() < 0.72) {
        const OVER = 0.42, DROP = 0.14;
        const outer = insetRing(ring, -OVER) || ring;
        const eaveY = top - DROP;
        const ridgeY = eaveY + clamp(shortSpan * 0.5 * pitchForYear(b.yr) * 0.95, 1.0, 3.8);
        const s = e01 >= e12 ? 0 : 1;             // long edges: s->s+1 and s+2->s+3
        const P = (k) => ring[(s + k) % 4];
        const PO = (k) => outer[(s + k) % 4];
        let m1 = [(P(1)[0] + P(2)[0]) / 2, (P(1)[1] + P(2)[1]) / 2];
        let m2 = [(P(3)[0] + P(0)[0]) / 2, (P(3)[1] + P(0)[1]) / 2];
        // rake overhang: extend the ridge past the gable ends
        let rdx = m1[0] - m2[0], rdz = m1[1] - m2[1];
        const rl = Math.hypot(rdx, rdz) || 1;
        rdx /= rl; rdz /= rl;
        const m1e = [m1[0] + rdx * OVER, m1[1] + rdz * OVER];
        const m2e = [m2[0] - rdx * OVER, m2[1] - rdz * OVER];

        for (const [eA, eB, mNear, mFar] of [[0, 1, m1e, m2e], [2, 3, m2e, m1e]]) {
          const pa = PO(eA), pc = PO(eB);
          let dx = pc[0] - pa[0], dz = pc[1] - pa[1];
          const l = Math.hypot(dx, dz) || 1;
          dx /= l; dz /= l;
          const hx = dz, hz = -dx;
          const rise = ridgeY - eaveY;
          const run = shortSpan / 2 + OVER;
          const nl = Math.hypot(run, rise) || 1;
          quad(V, N, C, I,
            [pa[0], eaveY, pa[1]], [pc[0], eaveY, pc[1]],
            [mNear[0], ridgeY, mNear[1]], [mFar[0], ridgeY, mFar[1]],
            (hx * rise) / nl, run / nl, (hz * rise) / nl, roofCol, [0.86, 0.86, 1.06, 1.06]);
          // eave fascia + soffit, as on the hips
          quad(V, N, C, I,
            [pa[0], eaveY - 0.17, pa[1]], [pc[0], eaveY - 0.17, pc[1]],
            [pc[0], eaveY, pc[1]], [pa[0], eaveY, pa[1]],
            hx, 0, hz, TRIM, [0.85, 0.85, 1.0, 1.0]);
          quad(V, N, C, I,
            [pc[0], eaveY - 0.17, pc[1]], [P((eA + 1) % 4)[0], top, P((eA + 1) % 4)[1]],
            [P(eA)[0], top, P(eA)[1]], [pa[0], eaveY - 0.17, pa[1]],
            0, -1, 0, TRIM, [0.55, 0.55, 0.55, 0.55]);
        }

        // gable ends: siding-coloured triangles closing the attic, both faces
        const endWall = new THREE.Color(wall).multiplyScalar(0.97);
        for (const [i1, i2, mm] of [[1, 2, m1], [3, 0, m2]]) {
          const q = V.length / 3;
          const p1 = P(i1), p2 = P(i2);
          let ex = p2[0] - p1[0], ez = p2[1] - p1[1];
          const el = Math.hypot(ex, ez) || 1;
          const gnx = ez / el, gnz = -ex / el;
          V.push(p1[0], top, p1[1], p2[0], top, p2[1], mm[0], ridgeY, mm[1]);
          for (let k2 = 0; k2 < 3; k2++) N.push(gnx, 0, gnz);
          for (let k2 = 0; k2 < 3; k2++) C.push(endWall.r, endWall.g, endWall.b);
          I.push(q, q + 1, q + 2, q, q + 2, q + 1);   // both windings — always visible
        }

        // chimney on the ridge for some
        if (rng() < 0.4) {
          const ct = 0.3 + rng() * 0.4;
          const cp = [m2[0] + (m1[0] - m2[0]) * ct, m2[1] + (m1[1] - m2[1]) * ct];
          const w2 = 0.38, ch = ridgeY + 0.55 + rng() * 0.45;
          const brick = new THREE.Color(0x6d4f42).multiplyScalar(0.85 + rng() * 0.3);
          quad(V, N, C, I, [cp[0] - w2, top, cp[1] - w2], [cp[0] + w2, top, cp[1] - w2], [cp[0] + w2, ch, cp[1] - w2], [cp[0] - w2, ch, cp[1] - w2], 0, 0, -1, brick, null);
          quad(V, N, C, I, [cp[0] + w2, top, cp[1] + w2], [cp[0] - w2, top, cp[1] + w2], [cp[0] - w2, ch, cp[1] + w2], [cp[0] + w2, ch, cp[1] + w2], 0, 0, 1, brick, null);
          quad(V, N, C, I, [cp[0] + w2, top, cp[1] - w2], [cp[0] + w2, top, cp[1] + w2], [cp[0] + w2, ch, cp[1] + w2], [cp[0] + w2, ch, cp[1] - w2], 1, 0, 0, brick, null);
          quad(V, N, C, I, [cp[0] - w2, top, cp[1] + w2], [cp[0] - w2, top, cp[1] - w2], [cp[0] - w2, ch, cp[1] - w2], [cp[0] - w2, ch, cp[1] + w2], -1, 0, 0, brick, null);
          quad(V, N, C, I, [cp[0] - w2, ch, cp[1] - w2], [cp[0] + w2, ch, cp[1] - w2], [cp[0] + w2, ch, cp[1] + w2], [cp[0] - w2, ch, cp[1] + w2], 0, 1, 0, new THREE.Color(0x2a2724), null);
        }
        return;
      }
    }

    const inner = insetRing(ring, d);
    if (inner) {
      // Roofs overhang the wall. Without this the roof plane starts exactly
      // at the wall plane and the house reads as one extruded solid rather
      // than a roof sitting on a box — the eave shadow is doing the work.
      const OVER = 0.42, DROP = 0.14;
      const outer = insetRing(ring, -OVER) || ring;
      const eaveY = top - DROP;
      // Pitch from the year it was actually built.
      const ridgeY = top + clamp(d * pitchForYear(b.yr), 0.85, 3.4);

      for (let i = 0; i < nPts; i++) {
        const a = ring[i], c = ring[(i + 1) % nPts];
        const ao = outer[i], co = outer[(i + 1) % nPts];
        const ai = inner[i], ci = inner[(i + 1) % nPts];
        let dx = c[0] - a[0], dz = c[1] - a[1];
        const l = Math.hypot(dx, dz);
        if (l < 0.05) continue;
        dx /= l; dz /= l;
        const hx = dz, hz = -dx;
        const rise = ridgeY - eaveY;
        const run = Math.hypot(ai[0] - ao[0], ai[1] - ao[1]) || 1;
        const nl = Math.hypot(run, rise) || 1;

        // roof plane, starting from the overhanging eave
        quad(V, N, C, I,
          [ao[0], eaveY, ao[1]], [co[0], eaveY, co[1]],
          [ci[0], ridgeY, ci[1]], [ai[0], ridgeY, ai[1]],
          (hx * rise) / nl, run / nl, (hz * rise) / nl, roofCol, [0.86, 0.86, 1.06, 1.06]);

        // fascia board at the eave edge
        quad(V, N, C, I,
          [ao[0], eaveY - 0.17, ao[1]], [co[0], eaveY - 0.17, co[1]],
          [co[0], eaveY, co[1]], [ao[0], eaveY, ao[1]],
          hx, 0, hz, TRIM, [0.85, 0.85, 1.0, 1.0]);

        // soffit underneath, facing down — this is the shadow catcher
        quad(V, N, C, I,
          [co[0], eaveY - 0.17, co[1]], [c[0], top, c[1]],
          [a[0], top, a[1]], [ao[0], eaveY - 0.17, ao[1]],
          0, -1, 0, TRIM, [0.55, 0.55, 0.55, 0.55]);
      }
      // ridge cap
      const tris = triangulate(inner);
      if (tris.length) {
        const q = V.length / 3;
        for (const p of inner) {
          V.push(p[0], ridgeY, p[1]);
          N.push(0, 1, 0);
          C.push(roofCol.r * 1.08, roofCol.g * 1.08, roofCol.b * 1.08);
        }
        for (let i = 0; i < tris.length; i += 3) pushTri(I, q + tris[i], q + tris[i + 1], q + tris[i + 2]);
      }

      // chimney on some houses
      if (rng() < 0.45 && b.a > 45) {
        const ci = Math.floor(rng() * inner.length);
        const cp = inner[ci];
        const w = 0.42, ch = ridgeY + 0.6 + rng() * 0.5;
        const brick = new THREE.Color(0x6d4f42).multiplyScalar(0.85 + rng() * 0.3);
        for (let s = 0; s < 4; s++) {
          const ax = cp[0] + (s === 0 || s === 3 ? -w : w);
          const az = cp[1] + (s < 2 ? -w : w);
          const bx = cp[0] + (s === 1 || s === 2 ? w : -w);
          const bz = cp[1] + (s === 0 ? -w : s === 2 ? w : s === 1 ? -w : w);
          quad(V, N, C, I,
            [ax, top, az], [bx, top, bz], [bx, ch, bz], [ax, ch, az],
            s === 0 ? 0 : s === 2 ? 0 : s === 1 ? 1 : -1, 0,
            s === 0 ? -1 : s === 2 ? 1 : 0, brick, [0.8, 0.8, 1, 1]);
        }
        quad(V, N, C, I,
          [cp[0] - w, ch, cp[1] - w], [cp[0] + w, ch, cp[1] - w],
          [cp[0] + w, ch, cp[1] + w], [cp[0] - w, ch, cp[1] + w],
          0, 1, 0, new THREE.Color(0x2a2724), null);
      }
      return;
    }
  }

  // ---- flat roof: deck, parapet, and a little rooftop plant
  const tris = triangulate(ring);
  if (tris.length) {
    const q = V.length / 3;
    for (const p of ring) {
      V.push(p[0], top, p[1]);
      N.push(0, 1, 0);
      C.push(roofCol.r, roofCol.g, roofCol.b);
    }
    for (let i = 0; i < tris.length; i += 3) pushTri(I, q + tris[i], q + tris[i + 1], q + tris[i + 2]);
  }

  if (b.a > 90 && eaveH > 4) {
    const par = 0.55 + rng() * 0.35;
    const capCol = new THREE.Color(roofCol).multiplyScalar(1.15);
    for (let i = 0; i < nPts; i++) {
      const a = ring[i], c = ring[(i + 1) % nPts];
      let dx = c[0] - a[0], dz = c[1] - a[1];
      const l = Math.hypot(dx, dz);
      if (l < 0.05) continue;
      dx /= l; dz /= l;
      const nx = dz, nz = -dx;
      quad(V, N, C, I,
        [a[0], top, a[1]], [c[0], top, c[1]], [c[0], top + par, c[1]], [a[0], top + par, a[1]],
        nx, 0, nz, capCol, [0.85, 0.85, 1.05, 1.05]);
    }
    // HVAC boxes
    const units = 1 + Math.floor(rng() * 3);
    const inner = insetRing(ring, 1.6);
    if (inner && inner.length > 2) {
      for (let u = 0; u < units; u++) {
        const p = inner[Math.floor(rng() * inner.length)];
        const w = 0.7 + rng() * 0.9, hgt = 0.6 + rng() * 0.8;
        const mech = new THREE.Color(0x6f7276).multiplyScalar(0.85 + rng() * 0.3);
        for (const [sx, sz, nnx, nnz] of [[0, -1, 0, -1], [1, 0, 1, 0], [0, 1, 0, 1], [-1, 0, -1, 0]]) {
          const cx0 = p[0] + (nnz !== 0 ? -w : w * sx), cz0 = p[1] + (nnx !== 0 ? -w : w * sz);
          const cx1 = p[0] + (nnz !== 0 ? w : w * sx), cz1 = p[1] + (nnx !== 0 ? w : w * sz);
          quad(V, N, C, I,
            [cx0 + nnx * w, top, cz0 + nnz * w], [cx1 + nnx * w, top, cz1 + nnz * w],
            [cx1 + nnx * w, top + hgt, cz1 + nnz * w], [cx0 + nnx * w, top + hgt, cz0 + nnz * w],
            nnx, 0, nnz, mech, [0.8, 0.8, 1, 1]);
        }
        quad(V, N, C, I,
          [p[0] - w, top + hgt, p[1] - w], [p[0] + w, top + hgt, p[1] - w],
          [p[0] + w, top + hgt, p[1] + w], [p[0] - w, top + hgt, p[1] + w],
          0, 1, 0, new THREE.Color(mech).multiplyScalar(1.2), null);
      }
    }
  }
}

/* ----------------------------------------------------------------- build -- */

export function buildBuildings(world, scene) {
  const chunks = new Map();
  for (const b of world.buildings) {
    let cx = 0, cz = 0;
    for (const p of b.r) { cx += p[0]; cz += p[1]; }
    cx /= b.r.length; cz /= b.r.length;
    const key = `${Math.floor(cx / CHUNK)},${Math.floor(cz / CHUNK)}`;
    let list = chunks.get(key);
    if (!list) { list = []; chunks.set(key, list); }
    list.push(b);
  }

  const wallMat = new THREE.MeshStandardMaterial({
    vertexColors: true, roughness: 0.82, metalness: 0.03, envMapIntensity: 1.2,
  });
  const glassMat = new THREE.MeshStandardMaterial({
    color: 0x161d26, roughness: 0.07, metalness: 0.92,
    envMapIntensity: 1.5, vertexColors: true,
  });
  const litMat = new THREE.MeshBasicMaterial({
    color: 0xffd9a0, transparent: true, opacity: 0,
  });

  const meshes = [];
  const litMeshes = [];
  let seed = 4211;
  let tris = 0;

  for (const [key, list] of chunks) {
    const buf = { V: [], N: [], C: [], I: [], WV: [], WN: [], WI: [], WC: [], LV: [], LI: [] };
    const rng = makeRng(seed++);
    for (const b of list) extrude(world, b, buf, rng);

    if (buf.I.length) {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(buf.V, 3));
      g.setAttribute('normal', new THREE.Float32BufferAttribute(buf.N, 3));
      g.setAttribute('color', new THREE.Float32BufferAttribute(buf.C, 3));
      g.setIndex(buf.I);
      g.computeBoundingSphere();
      const m = new THREE.Mesh(g, wallMat);
      m.castShadow = true;
      m.receiveShadow = true;
      m.name = `bld_${key}`;
      scene.add(m);
      meshes.push(m);
      tris += buf.I.length / 3;
    }

    if (buf.WI.length) {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(buf.WV, 3));
      g.setAttribute('normal', new THREE.Float32BufferAttribute(buf.WN, 3));
      g.setAttribute('color', new THREE.Float32BufferAttribute(buf.WC, 3));
      g.setIndex(buf.WI);
      g.computeBoundingSphere();
      const m = new THREE.Mesh(g, glassMat);
      m.name = `win_${key}`;
      scene.add(m);
      meshes.push(m);
      tris += buf.WI.length / 3;
    }

    if (buf.LI.length) {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(buf.LV, 3));
      g.setIndex(buf.LI);
      g.computeBoundingSphere();
      const m = new THREE.Mesh(g, litMat);
      m.name = `lit_${key}`;
      m.renderOrder = 6;
      scene.add(m);
      litMeshes.push(m);
    }
  }

  console.log(`buildings: ${world.buildings.length} footprints, ${meshes.length} meshes, ${Math.round(tris / 1000)}k tris`);
  return { meshes, litMat, litMeshes };
}

/* ------------------------------------------------------------------ props */

/* OSM puts traffic-control nodes ON the way, i.e. on the road centreline.
   Planting the sign there leaves it standing in the middle of the carriageway.
   Shift it to the kerb on the right-hand approach side and give back the road
   bearing so the sign can face oncoming traffic. */
function toKerb(world, node, extra, junctions) {
  const near = world.nearestRoad(node.x, node.z, 30);
  if (!near) return { x: node.x, z: node.z, rot: 0, ok: false };
  const s = near.seg;
  let dx = s.bx - s.ax, dz = s.bz - s.az;
  const l = Math.hypot(dx, dz) || 1;
  dx /= l; dz /= l;

  /* A control node sits AT the junction, and at a junction every sideways
     offset lands in the cross road — which is why simply pushing sideways
     left signs standing in live traffic. A real sign is set BACK along its
     approach, past the cross road's kerb line, and then over to the verge.
     So: find the junction, walk back down the approach, then step aside. */
  let jx = near.x, jz = near.z, haveJ = false;
  if (junctions) {
    const j = junctions.nearest(node.x, node.z, 34);
    if (j) { jx = j.x; jz = j.z; haveJ = true; }
  }

  // Which way along the road leads AWAY from the junction?
  let ax = dx, az = dz;
  if (haveJ) {
    const along = (near.x - jx) * dx + (near.z - jz) * dz;
    const sgn = Math.abs(along) < 0.5 ? -1 : Math.sign(along);
    ax = dx * sgn; az = dz * sgn;
  }
  // Traffic approaches heading toward the junction; the sign is on its right.
  const apx = -ax, apz = -az;
  const rx = -apz, rz = apx;

  for (const setback of [7, 9.5, 12, 15]) {
    for (const lat of [s.w / 2 + extra, s.w / 2 + extra + 1.3, s.w / 2 + extra + 2.8]) {
      const x = jx + ax * setback + rx * lat;
      const z = jz + az * setback + rz * lat;
      const other = world.nearestRoad(x, z, 26);
      if (other && other.dist < other.seg.w / 2 + 0.4) continue;   // still on pavement
      if (world.collideBuildings(x, z, 0.5)) continue;
      // Face back down the approach, at the drivers it's addressing.
      return { x, z, rot: Math.atan2(ax, az), ok: true };
    }
  }
  // Nothing clear: set it well back rather than leave it in the roadway.
  const lat = s.w / 2 + extra + 3.2;
  return { x: jx + ax * 16 + rx * lat, z: jz + az * 16 + rz * lat, rot: Math.atan2(ax, az), ok: false };
}

/** Tiny grid index over the road-graph junctions. */
function junctionIndex(world) {
  const CELL = 50;
  const grid = new Map();
  for (const [x, z] of world.network.junctions) {
    const k = `${Math.floor(x / CELL)},${Math.floor(z / CELL)}`;
    let c = grid.get(k);
    if (!c) { c = []; grid.set(k, c); }
    c.push({ x, z });
  }
  return {
    nearest(x, z, maxD) {
      let best = null, bd = maxD * maxD;
      const gx = Math.floor(x / CELL), gz = Math.floor(z / CELL);
      for (let i = gx - 1; i <= gx + 1; i++) {
        for (let j = gz - 1; j <= gz + 1; j++) {
          const c = grid.get(`${i},${j}`);
          if (!c) continue;
          for (const p of c) {
            const d = (p.x - x) ** 2 + (p.z - z) ** 2;
            if (d < bd) { bd = d; best = p; }
          }
        }
      }
      return best;
    },
  };
}

/* A tree offset from one road's centreline can easily land on a DIFFERENT
   road — at a corner, a fork, or anywhere two ways run close together. Test
   the final position against the whole network, not just the parent way. */
function clearOfPavement(world, x, z, margin = 1.4) {
  const near = world.nearestRoad(x, z, 26);
  if (!near) return true;
  return near.dist > near.seg.w / 2 + margin;
}

export function buildProps(world, scene) {
  const rng = makeRng(90210);
  const out = {};

  // Move every control node off the centreline before anything is built.
  const jidx = junctionIndex(world);
  const signals = world.props.signals.filter((s) => s.k === 'signal')
    .map((s) => ({ ...s, ...toKerb(world, s, 0.9, jidx) }));
  const stops = world.props.signals.filter((s) => s.k === 'stop')
    .map((s) => ({ ...s, ...toKerb(world, s, 0.6, jidx) }));

  // ---- traffic signal masts: pole, arm, head, three lenses
  if (signals.length) {
    const poleMat = new THREE.MeshStandardMaterial({ color: 0x33383a, roughness: 0.6, metalness: 0.55 });
    const headMat = new THREE.MeshStandardMaterial({ color: 0x1d2224, roughness: 0.65, metalness: 0.3 });

    const poles = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.10, 0.13, 6.0, 8), poleMat, signals.length);
    const arms = new THREE.InstancedMesh(new THREE.BoxGeometry(0.11, 0.11, 2.4), poleMat, signals.length);
    const heads = new THREE.InstancedMesh(new THREE.BoxGeometry(0.36, 1.02, 0.30), headMat, signals.length);

    const m = new THREE.Matrix4();
    const one = new THREE.Vector3(1, 1, 1);
    signals.forEach((sig, i) => {
      const y = world.heightAt(sig.x, sig.z);
      const rot = sig.rot || 0;
      // The mast stands at the kerb; the arm reaches back out over the road.
      const ix = Math.cos(rot), iz = -Math.sin(rot);      // inward, toward centreline
      const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, rot, 0));
      m.compose(new THREE.Vector3(sig.x, y + 3.0, sig.z), new THREE.Quaternion(), one);
      poles.setMatrixAt(i, m);
      m.compose(new THREE.Vector3(sig.x + ix * 1.2, y + 5.9, sig.z + iz * 1.2), q, one);
      arms.setMatrixAt(i, m);
      m.compose(new THREE.Vector3(sig.x + ix * 2.3, y + 5.3, sig.z + iz * 2.3), q, one);
      heads.setMatrixAt(i, m);
      sig._ix = ix; sig._iz = iz;
    });
    [poles, arms, heads].forEach((x) => { x.castShadow = true; x.instanceMatrix.needsUpdate = true; scene.add(x); });

    // three lenses per head; the sim recolours the active one
    const lensGeo = new THREE.CircleGeometry(0.115, 10);
    const lensMat = new THREE.MeshBasicMaterial({ vertexColors: false, color: 0xffffff, toneMapped: false });
    const lamps = new THREE.InstancedMesh(lensGeo, lensMat, signals.length * 3);
    lamps.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(signals.length * 3 * 3), 3);
    const dark = new THREE.Color(0x14100c);
    signals.forEach((sig, i) => {
      const y = world.heightAt(sig.x, sig.z);
      const ix = sig._ix ?? 0, iz = sig._iz ?? 1;
      for (let k = 0; k < 3; k++) {
        // Lenses on the face of the head, aimed back at oncoming traffic.
        m.makeTranslation(sig.x + ix * 2.46, y + 5.3 + (1 - k) * 0.31, sig.z + iz * 2.46);
        lamps.setMatrixAt(i * 3 + k, m);
        lamps.setColorAt(i * 3 + k, dark);
      }
    });
    lamps.instanceMatrix.needsUpdate = true;
    lamps.instanceColor.needsUpdate = true;
    scene.add(lamps);
    out.signalLamps = lamps;
    out.signalList = signals;
  }

  // ---- stop signs: octagonal face on a post
  if (stops.length) {
    const pm = new THREE.MeshStandardMaterial({ color: 0x9a9a95, roughness: 0.55, metalness: 0.6 });
    const fm = new THREE.MeshStandardMaterial({
      color: 0xa8231d, roughness: 0.5, metalness: 0.05, emissive: 0x260403, side: THREE.DoubleSide,
    });
    const p = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.05, 0.05, 2.5, 6), pm, stops.length);
    const f = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.40, 0.40, 0.04, 8), fm, stops.length);
    const m = new THREE.Matrix4();
    const one = new THREE.Vector3(1, 1, 1);
    stops.forEach((st, i) => {
      const y = world.heightAt(st.x, st.z);
      m.compose(new THREE.Vector3(st.x, y + 1.25, st.z), new THREE.Quaternion(), one);
      p.setMatrixAt(i, m);
      // The octagon stands upright and faces back down the road at drivers.
      const faceRot = new THREE.Quaternion().setFromEuler(
        new THREE.Euler(Math.PI / 2, 0, (st.rot || 0) + Math.PI / 8, 'YXZ')
      );
      m.compose(new THREE.Vector3(st.x, y + 2.35, st.z), faceRot, one);
      f.setMatrixAt(i, m);
    });
    p.instanceMatrix.needsUpdate = true;
    f.instanceMatrix.needsUpdate = true;
    p.castShadow = true;
    f.castShadow = true;
    scene.add(p, f);
  }

  // ---- street trees: trunk + two crown lobes, so they aren't lollipops
  const treePts = [];
  for (const road of world.roads) {
    if (road.rk < 2 || road.rk > 4) continue;
    for (let i = 1; i < road.p.length; i++) {
      const a = road.p[i - 1], b = road.p[i];
      const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
      const steps = Math.floor(len / 17);
      for (let s = 0; s < steps; s++) {
        if (rng() > 0.66) continue;
        const t = (s + 0.5) / steps;
        const x = a[0] + (b[0] - a[0]) * t;
        const z = a[1] + (b[1] - a[1]) * t;
        let dx = b[0] - a[0], dz = b[1] - a[1];
        const l = Math.hypot(dx, dz) || 1;
        const off = (road.w / 2 + 3.3) * (rng() < 0.5 ? -1 : 1);
        const tx = x + (-dz / l) * off, tz = z + (dx / l) * off;
        if (!clearOfPavement(world, tx, tz)) continue;
        treePts.push([tx, tz, 0.85 + rng() * 0.75]);
      }
    }
  }
  for (const a of world.areas) {
    if (a.k !== 'park' && a.k !== 'grass') continue;
    let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
    for (const p of a.r) {
      minX = Math.min(minX, p[0]); maxX = Math.max(maxX, p[0]);
      minZ = Math.min(minZ, p[1]); maxZ = Math.max(maxZ, p[1]);
    }
    const n = Math.min(46, Math.floor(((maxX - minX) * (maxZ - minZ)) / 380));
    for (let i = 0; i < n; i++) {
      const tx = minX + rng() * (maxX - minX), tz = minZ + rng() * (maxZ - minZ);
      // Parks are often bounded by roads; keep the canopy off the pavement.
      if (!clearOfPavement(world, tx, tz)) continue;
      if (world.collideBuildings(tx, tz, 1.2)) continue;
      treePts.push([tx, tz, 0.95 + rng() * 0.9]);
    }
  }

  if (treePts.length) {
    const trunkMat = new THREE.MeshStandardMaterial({ color: 0x40302a, roughness: 1, metalness: 0 });
    const crownMat = new THREE.MeshStandardMaterial({ color: 0x35502f, roughness: 1, metalness: 0, flatShading: true });
    const trunks = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.15, 0.26, 3.2, 6), trunkMat, treePts.length);
    const crownA = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(1.9, 1), crownMat, treePts.length);
    const crownB = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(1.35, 0), crownMat, treePts.length);
    crownA.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(treePts.length * 3), 3);
    crownB.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(treePts.length * 3), 3);

    const m = new THREE.Matrix4();
    const col = new THREE.Color();
    treePts.forEach(([x, z, sc], i) => {
      const y = world.heightAt(x, z);
      const rot = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, rng() * Math.PI * 2, 0));
      m.compose(new THREE.Vector3(x, y + 1.6 * sc, z), rot, new THREE.Vector3(sc, sc, sc));
      trunks.setMatrixAt(i, m);

      // Narrow hue spread and a low value ceiling: canopies read as one
      // massed shape, which is what makes them silhouette against the sky.
      col.setHSL(0.255 + rng() * 0.045, 0.30 + rng() * 0.14, 0.14 + rng() * 0.075);
      const s1 = sc * (0.9 + rng() * 0.35);
      m.compose(new THREE.Vector3(x, y + 3.9 * sc, z), rot, new THREE.Vector3(s1, s1 * 1.1, s1));
      crownA.setMatrixAt(i, m);
      crownA.setColorAt(i, col);

      const s2 = sc * (0.6 + rng() * 0.3);
      m.compose(
        new THREE.Vector3(x + (rng() - 0.5) * 1.4 * sc, y + 5.0 * sc, z + (rng() - 0.5) * 1.4 * sc),
        rot, new THREE.Vector3(s2, s2, s2)
      );
      crownB.setMatrixAt(i, m);
      crownB.setColorAt(i, col.clone().multiplyScalar(1.15));
    });
    [trunks, crownA, crownB].forEach((x) => {
      x.instanceMatrix.needsUpdate = true;
      x.castShadow = true;
      x.receiveShadow = true;
      scene.add(x);
    });
    if (crownA.instanceColor) crownA.instanceColor.needsUpdate = true;
    if (crownB.instanceColor) crownB.instanceColor.needsUpdate = true;
    console.log(`props: ${treePts.length} trees, ${signals.length} signals, ${stops.length} stop signs`);
  }

  // ---- street lamps: post, arm, luminaire
  const lampPts = [];
  for (const road of world.roads) {
    if (road.rk < 3) continue;
    for (let i = 1; i < road.p.length; i++) {
      const a = road.p[i - 1], b = road.p[i];
      const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
      const steps = Math.floor(len / 30);
      for (let s = 0; s < steps; s++) {
        const t = (s + 0.5) / steps;
        let dx = b[0] - a[0], dz = b[1] - a[1];
        const l = Math.hypot(dx, dz) || 1;
        const off = road.w / 2 + 1.0;
        lampPts.push([
          a[0] + dx * t + (-dz / l) * off,
          a[1] + dz * t + (dx / l) * off,
          Math.atan2(dx, dz),
        ]);
      }
    }
  }
  if (lampPts.length) {
    const lm = new THREE.MeshStandardMaterial({ color: 0x474c4a, roughness: 0.62, metalness: 0.55 });
    const poles = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.09, 0.14, 8.0, 7), lm, lampPts.length);
    const arms = new THREE.InstancedMesh(new THREE.BoxGeometry(0.09, 0.09, 1.5), lm, lampPts.length);
    const bulbMat = new THREE.MeshBasicMaterial({ color: 0x22221c, toneMapped: false });
    const bulbs = new THREE.InstancedMesh(new THREE.SphereGeometry(0.30, 8, 6), bulbMat, lampPts.length);

    const m = new THREE.Matrix4();
    const one = new THREE.Vector3(1, 1, 1);
    lampPts.forEach(([x, z, h], i) => {
      const y = world.heightAt(x, z);
      const rot = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, h + Math.PI / 2, 0));
      m.compose(new THREE.Vector3(x, y + 4.0, z), new THREE.Quaternion(), one);
      poles.setMatrixAt(i, m);
      m.compose(new THREE.Vector3(x, y + 7.9, z), rot, one);
      arms.setMatrixAt(i, m);
      const ox = Math.sin(h + Math.PI / 2) * 0.75, oz = Math.cos(h + Math.PI / 2) * 0.75;
      m.compose(new THREE.Vector3(x + ox, y + 7.75, z + oz), new THREE.Quaternion(), one);
      bulbs.setMatrixAt(i, m);
    });
    [poles, arms, bulbs].forEach((x) => { x.instanceMatrix.needsUpdate = true; scene.add(x); });
    poles.castShadow = true;
    out.lampBulbMat = bulbMat;
    out.lampPts = lampPts;

    /* Light pools. Real point lights at this count would be unshippable, so
       each lamp gets an additive radial decal on the road surface. It buys
       most of the read of a lit street for one draw call, and without it the
       roadway at night is simply black and undriveable. */
    const pool = new THREE.CanvasTexture(radialGradient());
    pool.colorSpace = THREE.SRGBColorSpace;
    const poolMat = new THREE.MeshBasicMaterial({
      map: pool, transparent: true, opacity: 0, depthWrite: false,
      blending: THREE.AdditiveBlending, toneMapped: false, color: 0xffd9a2,
    });
    const quad = new THREE.PlaneGeometry(1, 1);
    quad.rotateX(-Math.PI / 2);
    const pools = new THREE.InstancedMesh(quad, poolMat, lampPts.length);
    const pm2 = new THREE.Matrix4();
    lampPts.forEach(([x, z, h], i) => {
      const ox = Math.sin(h + Math.PI / 2) * 0.75, oz = Math.cos(h + Math.PI / 2) * 0.75;
      const y = world.heightAt(x + ox, z + oz);
      const r = 15;
      pm2.compose(
        new THREE.Vector3(x + ox, y + 0.20, z + oz),
        new THREE.Quaternion(),
        new THREE.Vector3(r, 1, r)
      );
      pools.setMatrixAt(i, pm2);
    });
    pools.instanceMatrix.needsUpdate = true;
    pools.renderOrder = 7;
    scene.add(pools);
    out.lampPoolMat = poolMat;
    out.lampPools = pools;
  }

  return out;
}

/** Soft radial falloff used for lamp pools and window glow. */
function radialGradient(size = 128) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d');
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0.00, 'rgba(255,255,255,1)');
  g.addColorStop(0.35, 'rgba(255,255,255,0.55)');
  g.addColorStop(0.70, 'rgba(255,255,255,0.14)');
  g.addColorStop(1.00, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  return c;
}
