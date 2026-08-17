import * as THREE from 'three';

/* ---------------------------------------------------------------------------
   Firewatch-derived art direction.

   The look is not "realistic lighting turned orange". Three things carry it,
   and all three are here rather than scattered through the renderer:

   1. AERIAL PERSPECTIVE IN SATURATED COLOUR. Distance does not fade to grey —
      it ramps through a warm mid band into a cool far band, so a street reads
      as a stack of flat silhouettes at different hues. This is the signature,
      and it is why a low-detail world reads as deliberate rather than unfinished.

   2. A NARROW, HARMONISED PALETTE. Every surface colour is drawn from the same
      warm/cool ramp. Nothing is allowed its own "realistic" hue.

   3. FLAT SURFACES. No specular, no metal, no fine texture. Shape is read from
      silhouette and from the light/shadow split, never from material detail.

   Colours are authored in linear space via setHex on a Color with
   SRGBColorSpace conversion, so they behave under ACES tone mapping.
--------------------------------------------------------------------------- */

const C = (hex) => new THREE.Color().setHex(hex, THREE.SRGBColorSpace);

/* Keyframes across the day. `t` is the hour. The shift runs 08:00-20:00, so
   the interesting frames are weighted toward afternoon and dusk — that is
   where the palette earns its keep. */
const KEYS = [
  {
    t: 4.5, name: 'night',
    sun:      C(0x2d3f6b), sunI: 0.15,
    hemiSky:  C(0x1b2440), hemiGnd: C(0x151519), hemiI: 0.55,
    skyTop:   C(0x0b1024), skyHorizon: C(0x2a2340), skyGlow: C(0x4a3358),
    fogNear:  C(0x1a1f36), fogFar: C(0x2b2545),
    ambient:  C(0x232a44), ambientI: 0.30,
  },
  {
    t: 6.4, name: 'dawn',
    sun:      C(0xff7a4d), sunI: 1.5,
    hemiSky:  C(0x6d6ea8), hemiGnd: C(0x3b2f33), hemiI: 1.65,
    skyTop:   C(0x2a3a72), skyHorizon: C(0xd9705f), skyGlow: C(0xffa15c),
    fogNear:  C(0x8a6a78), fogFar: C(0xc06a72),
    ambient:  C(0x4a4468), ambientI: 0.42,
  },
  {
    t: 9.0, name: 'morning',
    sun:      C(0xffd39a), sunI: 2.9,
    hemiSky:  C(0x9fc4e8), hemiGnd: C(0x6b6350), hemiI: 1.95,
    skyTop:   C(0x2f74b5), skyHorizon: C(0xbfd9e8), skyGlow: C(0xffe3b8),
    fogNear:  C(0xc2ccc9), fogFar: C(0x7f96c2),
    ambient:  C(0x7d90a8), ambientI: 0.40,
  },
  {
    t: 13.0, name: 'midday',
    sun:      C(0xfff0d4), sunI: 3.1,
    hemiSky:  C(0x9ccdf0), hemiGnd: C(0x7a7358), hemiI: 2.05,
    skyTop:   C(0x2c86c8), skyHorizon: C(0xd6e9f2), skyGlow: C(0xfff4d8),
    fogNear:  C(0xd2dcd8), fogFar: C(0x88a6cf),
    ambient:  C(0x8fa4b5), ambientI: 0.38,
  },
  {
    /* The frame the whole palette is built around. Sun is low and hard amber,
       shade goes distinctly blue-violet, and the far band is dusty rose. */
    t: 17.2, name: 'golden',
    sun:      C(0xff9d43), sunI: 3.0,
    hemiSky:  C(0x7d9fd6), hemiGnd: C(0x7a4f38), hemiI: 1.90,
    skyTop:   C(0x2e5f9e), skyHorizon: C(0xf0a05a), skyGlow: C(0xffc266),
    fogNear:  C(0xe0925c), fogFar: C(0x7d5f9e),
    ambient:  C(0x6e6a93), ambientI: 0.46,
  },
  {
    t: 19.1, name: 'dusk',
    sun:      C(0xff5f3c), sunI: 1.7,
    hemiSky:  C(0x5b5f9e), hemiGnd: C(0x4a2f34), hemiI: 1.60,
    skyTop:   C(0x1d2c5e), skyHorizon: C(0xe0603f), skyGlow: C(0xff8a4a),
    fogNear:  C(0xc26050), fogFar: C(0x5d4278),
    ambient:  C(0x4f4470), ambientI: 0.46,
  },
  {
    t: 20.6, name: 'twilight',
    sun:      C(0x8a4a72), sunI: 0.45,
    hemiSky:  C(0x36406e), hemiGnd: C(0x2a2230), hemiI: 0.70,
    skyTop:   C(0x121a3c), skyHorizon: C(0x6b3a63), skyGlow: C(0xa84f6a),
    fogNear:  C(0x4e3b57), fogFar: C(0x3d3159),
    ambient:  C(0x33304f), ambientI: 0.38,
  },
];

const FIELDS_COL = ['sun', 'hemiSky', 'hemiGnd', 'skyTop', 'skyHorizon', 'skyGlow',
                    'fogNear', 'fogFar', 'ambient'];
const FIELDS_NUM = ['sunI', 'hemiI', 'ambientI'];

/* Reused so sampling the palette every frame allocates nothing. */
const OUT = { name: '' };
for (const f of FIELDS_COL) OUT[f] = new THREE.Color();
for (const f of FIELDS_NUM) OUT[f] = 0;

/** Sample the palette at hour `t`, wrapping across midnight. */
export function paletteAt(t) {
  t = ((t % 24) + 24) % 24;
  let a = KEYS[KEYS.length - 1], b = KEYS[0];
  for (let i = 0; i < KEYS.length; i++) {
    const cur = KEYS[i], nxt = KEYS[(i + 1) % KEYS.length];
    const lo = cur.t, hi = nxt.t > cur.t ? nxt.t : nxt.t + 24;
    const tt = t >= lo ? t : t + 24;
    if (tt >= lo && tt < hi) { a = cur; b = nxt; break; }
  }
  const lo = a.t, hi = b.t > a.t ? b.t : b.t + 24;
  const tt = t >= lo ? t : t + 24;
  const raw = hi > lo ? (tt - lo) / (hi - lo) : 0;
  // Smoothstep so keyframes ease rather than corner.
  const k = raw * raw * (3 - 2 * raw);

  for (const f of FIELDS_COL) OUT[f].copy(a[f]).lerp(b[f], k);
  for (const f of FIELDS_NUM) OUT[f] = a[f] + (b[f] - a[f]) * k;
  OUT.name = k < 0.5 ? a.name : b.name;
  return OUT;
}

/* ---------------------------------------------------------------------------
   Surface colours. Everything the world builds picks from these, so the whole
   frame stays inside one harmony instead of each module inventing its own
   "realistic" grey.
--------------------------------------------------------------------------- */

export const SURFACE = {
  asphalt:    0x2f2b3a,   // violet-leaning, so warm light reads on it
  asphaltOld: 0x363042,
  concrete:   0x8d8496,
  kerb:       0x9b93a1,
  sidewalk:   0x847b8c,
  lineWhite:  0xe8dcc8,
  lineYellow: 0xe0a848,

  grass:      0x5c7048,
  grassDry:   0x7d8449,
  park:       0x4e6642,
  dirt:       0x7a5c46,
  water:      0x3d5a7a,

  // Buildings: a narrow set of warm neutrals and muted colours, no pure white.
  wall: [
    0xd9c3a5, 0xc9a98c, 0xb08d76, 0xa8b0a6, 0x8f9aa8,
    0xd6d0c0, 0xbfa896, 0x9c8b84, 0xc4b8a4, 0xa89c92,
  ],
  roof: [
    0x4a3f45, 0x574650, 0x3f3a48, 0x6b5450, 0x4d4a58,
  ],
  trim:       0xe4dccc,
  window:     0x2b3348,
  windowLit:  0xffca7a,
  door:       0x7a4a3c,

  treeCanopy: [0x3f5a3a, 0x4a6440, 0x35503c, 0x566b3e, 0x2f4a38],
  treeTrunk:  0x4a3a33,

  // Vehicles: saturated but value-dark, poster-like rather than showroom.
  car: [
    0xb5443c, 0x3f5f80, 0xd0a04e, 0x6a7f52, 0xc9c2b4,
    0x8a5a72, 0x4a5560, 0xa8663c, 0x5f7a78, 0x93382f,
  ],
};

/* ---------------------------------------------------------------------------
   Flatten the whole scene into the poster response.

   Applied as a sweep after the world is built rather than at each material's
   construction site, because there are dozens of those across nine modules and
   a missed one shows up as a single glossy object that breaks the frame. A
   sweep is also self-maintaining: anything added later is caught too.

   What it does, and why each part matters to this look:
   - metalness to zero. Metal implies environment reflection, which implies a
     real environment. Every surface here is dry pigment.
   - roughness floored high. Specular lobes read as photography; a broad matte
     response reads as printed ink.
   - envMapIntensity cut right down. The IBL probe is left doing gentle
     ambient tinting instead of mirroring a sky back at the viewer.
   - albedo value ceiling. Nothing is allowed to approach white, so surfaces
     hold their hue and stay separable from the bright sky behind them.
--------------------------------------------------------------------------- */
export function flattenScene(root, { valueCeiling = 0.82 } = {}) {
  const seen = new Set();
  const hsl = { h: 0, s: 0, l: 0 };
  let touched = 0;

  root.traverse((obj) => {
    const mats = Array.isArray(obj.material) ? obj.material : (obj.material ? [obj.material] : []);
    for (const m of mats) {
      if (!m || seen.has(m.uuid)) continue;
      seen.add(m.uuid);

      if ('metalness' in m) m.metalness = 0.0;
      if ('roughness' in m) m.roughness = Math.max(m.roughness ?? 1, 0.88);
      if ('envMapIntensity' in m) m.envMapIntensity = Math.min(m.envMapIntensity ?? 1, 0.18);
      // Clear-coat and sheen are photoreal cues with no place in a flat look.
      if ('clearcoat' in m) m.clearcoat = 0;
      if ('sheen' in m) m.sheen = 0;

      if (m.color && !m.userData?.keepValue) {
        m.color.getHSL(hsl);
        if (hsl.l > valueCeiling) m.color.setHSL(hsl.h, hsl.s, valueCeiling);
      }
      m.needsUpdate = true;
      touched++;
    }
  });
  return touched;
}
