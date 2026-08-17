import * as THREE from 'three';

/* Procedural surface detail.

   The project ships no image files, so every surface was a flat colour with a
   PBR roughness value — which is exactly why asphalt, concrete and grass all
   read as the same moulded plastic at different hues. These generate tileable
   canvas textures at load time: an albedo with real value variation, and a
   matching normal map derived from the same height field so the lighting
   actually breaks up across a surface.

   All noise here is periodic, so tiles seam correctly. */

/** Deterministic hash-based lattice value in [0,1), wrapping at `period`. */
function hash2(x, y, period, seed) {
  const xi = ((x % period) + period) % period;
  const yi = ((y % period) + period) % period;
  let h = xi * 374761393 + yi * 668265263 + seed * 2147483647;
  h = (h ^ (h >> 13)) >>> 0;
  h = Math.imul(h, 1274126177) >>> 0;
  return ((h ^ (h >> 16)) >>> 0) / 4294967296;
}

const fade = (t) => t * t * (3 - 2 * t);

/** Tileable value noise sampled in [0,1) UV space. */
function valueNoise(u, v, freq, seed) {
  const x = u * freq, y = v * freq;
  const x0 = Math.floor(x), y0 = Math.floor(y);
  const fx = fade(x - x0), fy = fade(y - y0);
  const a = hash2(x0, y0, freq, seed);
  const b = hash2(x0 + 1, y0, freq, seed);
  const c = hash2(x0, y0 + 1, freq, seed);
  const d = hash2(x0 + 1, y0 + 1, freq, seed);
  return (a + (b - a) * fx) + ((c + (d - c) * fx) - (a + (b - a) * fx)) * fy;
}

/** Sum of octaves, still tileable because every octave frequency divides the tile. */
function fbm(u, v, baseFreq, octaves, seed, gain = 0.5) {
  let sum = 0, amp = 1, norm = 0, f = baseFreq;
  for (let o = 0; o < octaves; o++) {
    sum += valueNoise(u, v, f, seed + o * 17) * amp;
    norm += amp;
    amp *= gain;
    f *= 2;
  }
  return sum / norm;
}

/**
 * Build an albedo + normal pair from a per-pixel height/shade function.
 * `fn(u, v)` returns { h, r, g, b } — h drives the normal map.
 */
export function makeSurface(size, fn, normalStrength = 1.6) {
  const col = document.createElement('canvas');
  col.width = col.height = size;
  const cctx = col.getContext('2d');
  const cimg = cctx.createImageData(size, size);

  const heights = new Float32Array(size * size);

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size, v = y / size;
      const s = fn(u, v);
      const i = (y * size + x) * 4;
      cimg.data[i] = Math.max(0, Math.min(255, s.r * 255));
      cimg.data[i + 1] = Math.max(0, Math.min(255, s.g * 255));
      cimg.data[i + 2] = Math.max(0, Math.min(255, s.b * 255));
      cimg.data[i + 3] = 255;
      heights[y * size + x] = s.h;
    }
  }
  cctx.putImageData(cimg, 0, 0);

  // Sobel-ish gradient of the height field -> tangent-space normal.
  const nrm = document.createElement('canvas');
  nrm.width = nrm.height = size;
  const nctx = nrm.getContext('2d');
  const nimg = nctx.createImageData(size, size);
  const at = (x, y) => heights[(((y % size) + size) % size) * size + (((x % size) + size) % size)];

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (at(x + 1, y) - at(x - 1, y)) * normalStrength;
      const dy = (at(x, y + 1) - at(x, y - 1)) * normalStrength;
      let nx = -dx, ny = -dy, nz = 1;
      const l = Math.hypot(nx, ny, nz) || 1;
      nx /= l; ny /= l; nz /= l;
      const i = (y * size + x) * 4;
      nimg.data[i] = (nx * 0.5 + 0.5) * 255;
      nimg.data[i + 1] = (ny * 0.5 + 0.5) * 255;
      nimg.data[i + 2] = (nz * 0.5 + 0.5) * 255;
      nimg.data[i + 3] = 255;
    }
  }
  nctx.putImageData(nimg, 0, 0);

  const mkTex = (canvas, srgb) => {
    const t = new THREE.CanvasTexture(canvas);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.anisotropy = 8;
    if (srgb) t.colorSpace = THREE.SRGBColorSpace;
    t.needsUpdate = true;
    return t;
  };

  return { map: mkTex(col, true), normalMap: mkTex(nrm, false) };
}

/* ---------------------------------------------------------------- presets */

let cache = null;

/* These are LUMINANCE detail maps centred near 1.0, not baked colour. Three
   multiplies map x material.color x vertexColor, so keeping the mean near
   white lets the existing colour scheme survive while the texture supplies
   variation. Baking the hue in here would double-darken everything. */
export function buildSurfaces() {
  if (cache) return cache;

  // ---- asphalt: fine aggregate over broad patchy wear
  const asphalt = makeSurface(256, (u, v) => {
    const grain = fbm(u, v, 64, 3, 11);
    const patch = fbm(u, v, 6, 3, 71);
    const t = 0.80 + grain * 0.34 + (patch - 0.5) * 0.26;
    // Very slightly blue-grey, the way weathered asphalt actually reads.
    return { h: grain * 0.55 + patch * 0.45, r: t * 0.985, g: t * 0.995, b: t * 1.02 };
  }, 2.4);

  // ---- concrete: aggregate speckle plus a control joint at the tile edge
  const concrete = makeSurface(256, (u, v) => {
    const grain = fbm(u, v, 48, 3, 23);
    const stain = fbm(u, v, 5, 2, 91);
    let t = 0.86 + grain * 0.22 + (stain - 0.5) * 0.16;
    let h = grain * 0.7;
    const joint = Math.min(v, 1 - v);
    if (joint < 0.012) { t *= 0.66; h -= 0.9; }     // saw-cut control joint
    return { h, r: t, g: t * 0.995, b: t * 0.97 };
  }, 2.0);

  // ---- turf: mottled and clumpy, hue supplied by the terrain vertex colours
  const grass = makeSurface(256, (u, v) => {
    const blade = fbm(u, v, 96, 2, 5);
    const clump = fbm(u, v, 8, 3, 41);
    const t = 0.74 + blade * 0.30 + (clump - 0.5) * 0.40;
    return { h: blade * 0.6 + clump * 0.4, r: t * 0.97, g: t, b: t * 0.92 };
  }, 1.5);

  cache = { asphalt, concrete, grass };
  return cache;
}
