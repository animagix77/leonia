#!/usr/bin/env node
/* Convert raw OSM + USGS elevation into a compact world file the game loads at runtime.
   Everything is projected to local metres: X = east, Z = south, Y = up. */

const fs = require('fs');
const path = require('path');

const RAW = path.join(__dirname, 'raw');
const OUT = path.join(__dirname, '..', 'public', 'world');

const osm = JSON.parse(fs.readFileSync(path.join(RAW, 'leonia_osm.json'), 'utf8'));
const elevRaw = fs.existsSync(path.join(RAW, 'elevation.json'))
  ? JSON.parse(fs.readFileSync(path.join(RAW, 'elevation.json'), 'utf8'))
  : null;

const BBOX = { south: 40.8480, north: 40.8800, west: -74.0100, east: -73.9720 };
const CLAT = (BBOX.south + BBOX.north) / 2;
const CLON = (BBOX.west + BBOX.east) / 2;
const M_PER_DEG_LAT = 111320;
const M_PER_DEG_LON = 111320 * Math.cos((CLAT * Math.PI) / 180);

const project = (lat, lon) => [
  (lon - CLON) * M_PER_DEG_LON,      // X: east
  -(lat - CLAT) * M_PER_DEG_LAT,     // Z: south
];

const WORLD_W = (BBOX.east - BBOX.west) * M_PER_DEG_LON;
const WORLD_H = (BBOX.north - BBOX.south) * M_PER_DEG_LAT;

// ---------------------------------------------------------------- index OSM
const nodes = new Map();
const ways = [];
const rels = [];
for (const e of osm.elements) {
  if (e.type === 'node') nodes.set(e.id, e);
  else if (e.type === 'way') ways.push(e);
  else if (e.type === 'relation') rels.push(e);
}
console.log(`osm: ${nodes.size} nodes, ${ways.length} ways, ${rels.length} rels`);

// ---------------------------------------------------------- borough boundary
// Stitch the boundary relation's outer ways into one ring so we can tell
// "inside Leonia" from the surrounding towns.
function buildBoundary() {
  const rel = rels.find((r) => r.tags && r.tags.name === 'Leonia' && r.tags.boundary === 'administrative');
  if (!rel) return null;
  const segs = [];
  for (const m of rel.members) {
    if (m.type !== 'way') continue;
    const w = ways.find((x) => x.id === m.ref);
    if (w && w.nodes) segs.push(w.nodes.slice());
  }
  if (!segs.length) return null;

  const ring = segs.shift();
  let guard = 0;
  while (segs.length && guard++ < 500) {
    const tail = ring[ring.length - 1];
    const head = ring[0];
    let used = -1;
    for (let i = 0; i < segs.length; i++) {
      const s = segs[i];
      if (s[0] === tail) { ring.push(...s.slice(1)); used = i; break; }
      if (s[s.length - 1] === tail) { ring.push(...s.slice(0, -1).reverse()); used = i; break; }
      if (s[s.length - 1] === head) { ring.unshift(...s.slice(0, -1)); used = i; break; }
      if (s[0] === head) { ring.unshift(...s.slice(1).reverse()); used = i; break; }
    }
    if (used < 0) break;
    segs.splice(used, 1);
  }
  const pts = [];
  for (const id of ring) {
    const n = nodes.get(id);
    if (n) pts.push(project(n.lat, n.lon).map((v) => Math.round(v * 10) / 10));
  }
  return pts.length > 3 ? pts : null;
}
const boundary = buildBoundary();
console.log(`boundary ring: ${boundary ? boundary.length + ' pts' : 'MISSING'}`);

function pointInPoly(x, z, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, zi] = poly[i], [xj, zj] = poly[j];
    if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

// -------------------------------------------------------------------- roads
// Road class -> game properties. Speed limits reflect NJ posting for a
// residential borough: 25 default, arterials 30-35, the interstate 55.
/* Real cross-sections, in metres, measured curb to curb.

   A US suburban street is travel lanes PLUS parking. Leonia's residential
   grid is ~32-36 ft curb to curb (two 10 ft lanes and a parking lane), and
   Broad Ave is a ~50 ft section. Sizing off travel lanes alone made every
   street look like a rural two-track, so parking and shoulders are explicit.

   laneW  metres per travel lane
   park   metres per parking lane (0 = none)
   sides  how many parking lanes the section carries
   shoul  shoulder width per side, for limited-access roads with no parking */
const ROAD_CLASS = {
  motorway:      { laneW: 3.65, lanes: 3, park: 0,   sides: 0, shoul: 2.9, mph: 55, rank: 6, name: 'highway' },
  motorway_link: { laneW: 4.00, lanes: 1, park: 0,   sides: 0, shoul: 1.5, mph: 35, rank: 5, name: 'ramp' },
  trunk:         { laneW: 3.55, lanes: 2, park: 0,   sides: 0, shoul: 2.2, mph: 45, rank: 5, name: 'trunk' },
  trunk_link:    { laneW: 3.90, lanes: 1, park: 0,   sides: 0, shoul: 1.4, mph: 30, rank: 4, name: 'ramp' },
  primary:       { laneW: 3.45, lanes: 2, park: 2.4, sides: 2, shoul: 0,   mph: 35, rank: 4, name: 'primary' },
  primary_link:  { laneW: 3.80, lanes: 1, park: 0,   sides: 0, shoul: 1.2, mph: 25, rank: 3, name: 'ramp' },
  secondary:     { laneW: 3.35, lanes: 2, park: 2.4, sides: 2, shoul: 0,   mph: 30, rank: 3, name: 'secondary' },
  secondary_link:{ laneW: 3.70, lanes: 1, park: 0,   sides: 0, shoul: 1.2, mph: 25, rank: 3, name: 'ramp' },
  tertiary:      { laneW: 3.30, lanes: 2, park: 2.3, sides: 2, shoul: 0,   mph: 30, rank: 3, name: 'tertiary' },
  tertiary_link: { laneW: 3.60, lanes: 1, park: 0,   sides: 0, shoul: 1.0, mph: 25, rank: 2, name: 'ramp' },
  residential:   { laneW: 3.05, lanes: 2, park: 2.2, sides: 2, shoul: 0,   mph: 25, rank: 2, name: 'residential' },
  unclassified:  { laneW: 3.05, lanes: 2, park: 2.2, sides: 1, shoul: 0,   mph: 25, rank: 2, name: 'street' },
  living_street: { laneW: 3.00, lanes: 1, park: 2.1, sides: 1, shoul: 0,   mph: 15, rank: 1, name: 'living street' },
  service:       { laneW: 2.90, lanes: 1, park: 0,   sides: 0, shoul: 0.5, mph: 15, rank: 1, name: 'service road' },
};

/** Curb-to-curb width from the tagged lane count plus the section's parking. */
function roadWidth(cls, t, lanes, oneway) {
  if (t.width) {
    const m = /([\d.]+)/.exec(t.width);
    if (m) {
      const v = parseFloat(m[1]);
      if (v > 2 && v < 60) return v;               // trust an explicit survey
    }
  }
  let travel = lanes * cls.laneW;

  // Parking: honour explicit tags, else assume the local norm for the class.
  let sides = cls.sides;
  const pTags = ['parking:both', 'parking:lane:both', 'parking:left', 'parking:lane:left',
    'parking:right', 'parking:lane:right'];
  let sawTag = false, allowed = 0;
  for (const k of pTags) {
    if (!t[k]) continue;
    sawTag = true;
    const both = k.includes('both');
    const no = /^(no|none|no_parking|no_stopping|separate)$/.test(t[k]);
    if (!no) allowed += both ? 2 : 1;
  }
  if (sawTag) sides = Math.min(2, allowed);
  // A one-way residential street usually keeps parking on both sides anyway.

  let w = travel + sides * cls.park + cls.shoul * 2;

  // Cycle lanes where OSM says they exist.
  for (const k of ['cycleway', 'cycleway:both', 'cycleway:left', 'cycleway:right']) {
    const v = t[k];
    if (!v) continue;
    if (/^(lane|track|buffered_lane)$/.test(v)) w += k.includes('both') ? 3.0 : 1.6;
  }
  return Math.max(3.4, Math.min(w, 46));
}

const roads = [];
for (const w of ways) {
  const t = w.tags || {};
  const cls = ROAD_CLASS[t.highway];
  if (!cls || !w.nodes || w.nodes.length < 2) continue;
  // Skip parking aisles and driveways — they'd flood the graph with noise.
  if (t.highway === 'service' && t.service && t.service !== 'alley') continue;

  const pts = [];
  for (const id of w.nodes) {
    const n = nodes.get(id);
    if (!n) continue;
    const [x, z] = project(n.lat, n.lon);
    pts.push([Math.round(x * 10) / 10, Math.round(z * 10) / 10, id]);
  }
  if (pts.length < 2) continue;

  // Posted limit if OSM has one, else the class default.
  let mph = cls.mph;
  if (t.maxspeed) {
    const m = /(\d+)/.exec(t.maxspeed);
    if (m) mph = parseInt(m[1], 10);
  }
  const oneway = t.oneway === 'yes' || t.junction === 'roundabout' || t.highway === 'motorway_link';
  const lanes = t.lanes ? Math.max(1, parseInt(t.lanes, 10) || cls.lanes) : cls.lanes;
  const width = roadWidth(cls, t, lanes, oneway);

  roads.push({
    id: w.id,
    name: t.name || null,
    kind: t.highway,
    label: cls.name,
    w: width,
    // How much of that width is parking, so the renderer can stripe it and
    // the traffic sim knows where the travel lanes actually start.
    park: cls.park > 0 ? cls.park : 0,
    parkSides: cls.park > 0 ? cls.sides : 0,
    lanes,
    mph,
    rank: cls.rank,
    oneway,
    bridge: !!t.bridge,
    tunnel: !!t.tunnel,
    pts,
  });
}
console.log(`roads: ${roads.length} ways (${new Set(roads.map((r) => r.name).filter(Boolean)).size} named)`);

// ------------------------------------------------------------- road network
// Intersections = nodes shared by 2+ drivable ways, plus every way endpoint.
const nodeUse = new Map();
for (const r of roads) {
  for (const p of r.pts) nodeUse.set(p[2], (nodeUse.get(p[2]) || 0) + 1);
}

const junctionIds = new Set();
for (const r of roads) {
  junctionIds.add(r.pts[0][2]);
  junctionIds.add(r.pts[r.pts.length - 1][2]);
  for (const p of r.pts) if ((nodeUse.get(p[2]) || 0) > 1) junctionIds.add(p[2]);
}

const junctions = [];      // [x, z]
const junctionIndex = new Map();
for (const id of junctionIds) {
  const n = nodes.get(id);
  if (!n) continue;
  const [x, z] = project(n.lat, n.lon);
  junctionIndex.set(id, junctions.length);
  junctions.push([Math.round(x * 10) / 10, Math.round(z * 10) / 10]);
}

// Edges: split each road at its junctions; keep the intermediate geometry.
const edges = [];
for (let ri = 0; ri < roads.length; ri++) {
  const r = roads[ri];
  let start = 0;
  for (let i = 1; i < r.pts.length; i++) {
    const isEnd = i === r.pts.length - 1;
    if (!junctionIndex.has(r.pts[i][2]) && !isEnd) continue;
    const a = junctionIndex.get(r.pts[start][2]);
    const b = junctionIndex.get(r.pts[i][2]);
    if (a !== undefined && b !== undefined && a !== b) {
      const geom = r.pts.slice(start, i + 1).map((p) => [p[0], p[1]]);
      let len = 0;
      for (let k = 1; k < geom.length; k++) {
        len += Math.hypot(geom[k][0] - geom[k - 1][0], geom[k][1] - geom[k - 1][1]);
      }
      if (len > 1) edges.push({ a, b, road: ri, len: Math.round(len * 10) / 10, geom });
    }
    start = i;
  }
}
console.log(`network: ${junctions.length} junctions, ${edges.length} edges`);

// ---------------------------------------------------------------- buildings
// Height from OSM tags where present, else a per-type estimate.
/* Eave-to-grade heights in metres, for footprints with no height/levels tag.
   Leonia's housing stock is overwhelmingly two-storey colonials and capes on
   ~50x100 ft lots, so a detached house is ~8 m to the eave and ~26 ft to the
   ridge once the pitched roof goes on. The old 6.5 m default made the whole
   borough read as single-storey bungalows. */
const BLD_H = {
  house: 8.2, detached: 8.2, semidetached_house: 8.2, residential: 9.0,
  terrace: 8.6, apartments: 15.0, commercial: 9.0, retail: 6.6, office: 14.0,
  industrial: 9.0, warehouse: 9.5, garage: 3.0, garages: 3.0, shed: 2.8,
  roof: 3.2, church: 12.0, school: 10.0, public: 10.0, civic: 10.0,
  hotel: 18.0, yes: 8.0,
};

const buildings = [];
for (const w of ways) {
  const t = w.tags || {};
  if (!t.building || !w.nodes || w.nodes.length < 4) continue;

  const ring = [];
  for (const id of w.nodes) {
    const n = nodes.get(id);
    if (!n) continue;
    const [x, z] = project(n.lat, n.lon);
    ring.push([Math.round(x * 10) / 10, Math.round(z * 10) / 10]);
  }
  if (ring.length < 4) continue;
  if (ring[0][0] === ring[ring.length - 1][0] && ring[0][1] === ring[ring.length - 1][1]) ring.pop();
  if (ring.length < 3) continue;

  // Shoelace area — drop slivers and mapping noise.
  let area = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    area += (ring[j][0] + ring[i][0]) * (ring[j][1] - ring[i][1]);
  }
  area = Math.abs(area / 2);
  if (area < 12) continue;

  let h = null;
  if (t.height) { const m = /([\d.]+)/.exec(t.height); if (m) h = parseFloat(m[1]); }
  if (h === null && t['building:levels']) {
    const lv = parseFloat(t['building:levels']);
    if (!isNaN(lv)) h = lv * 3.2 + 1.0;
  }
  if (h === null) h = BLD_H[t.building] ?? 8.0;
  // Nudge by footprint so big-box stores and hotel blocks don't read as cottages.
  if ((t.building === 'yes' || t.building === 'commercial') && area > 600) {
    h = Math.max(h, 10.5 + Math.min(14, Math.log2(area / 600) * 4.2));
  }
  // A tiny footprint is a shed or a detached garage, whatever it's tagged.
  if (area < 32) h = Math.min(h, 3.4);
  h = Math.max(2.5, Math.min(h, 60));

  buildings.push({
    r: ring,
    h: Math.round(h * 10) / 10,
    t: t.building,
    n: t.name || null,
    a: Math.round(area),
    // Address, used to join the assessment record for this exact house.
    num: t['addr:housenumber'] || null,
    street: t['addr:street'] || null,
    lvl: t['building:levels'] ? parseFloat(t['building:levels']) : null,
    // OSM roof tags where a mapper has surveyed them.
    rs: t['roof:shape'] || null,
  });
}
console.log(`buildings: ${buildings.length}`);

/* ------------------------------------------------- per-home assessment data
   NJ MOD-IV records, joined to footprints so each house is built as itself:
   real storey count, real construction material, real year, real garage.
   BLDG_DESC is the assessor's shorthand — "1&2S-B&F-BG" is a one-and-two
   storey brick-and-frame house with a basement garage. */

const parcelPath = path.join(RAW, 'parcels.json');
const parcels = fs.existsSync(parcelPath) ? JSON.parse(fs.readFileSync(parcelPath, 'utf8')) : [];

const MATERIALS = [
  [/(^|[-&])CB([-&]|$)/, 'block'],
  [/(^|[-&])AL([-&]|$)/, 'aluminum'],
  [/(^|[-&])ST([-&]|$)/, 'stone'],
  [/(^|[-&])VS?([-&]|$)/, 'vinyl'],
  [/(^|[-&])B([-&]|$)|B\dS/, 'brick'],
  [/(^|[-&])S([-&]|$)|S\dS/, 'stucco'],
  [/(^|[-&])W([-&]|$)/, 'wood'],
  [/(^|[-&])F([-&]|$)|F\dS|\dSF/, 'frame'],
];

function parseDesc(desc) {
  if (!desc) return {};
  const d = desc.toUpperCase();
  const out = {};

  // Storeys: "1&2S" -> 2, "1.5S" -> 1.5, "2S"/"F2SG1S"/"2SF" -> 2
  let m = /(\d(?:\.\d)?)\s*&\s*(\d(?:\.\d)?)\s*S/.exec(d);
  if (m) out.storeys = Math.max(parseFloat(m[1]), parseFloat(m[2]));
  else {
    m = /(\d(?:\.\d)?)\s*S/.exec(d);
    if (m) out.storeys = parseFloat(m[1]);
  }

  // Construction. Order matters: two-letter codes are tested first.
  for (const [re, name] of MATERIALS) {
    if (re.test(d)) { out.material = name; break; }
  }

  // Garage: basement / under / attached / none.
  if (/(^|[-&])\d?NG([-&]|$)/.test(d)) out.garage = 'none';
  else if (/(^|[-&])\d?BG([-&]|$)/.test(d)) out.garage = 'basement';
  else if (/(^|[-&])\d?UG([-&]|$)/.test(d)) out.garage = 'under';
  else if (/(^|[-&])\d?AG([-&]|$)/.test(d)) out.garage = 'attached';
  else if (/G\d[SU]/.test(d)) out.garage = 'attached';

  if (/(^|[-&])C(ONDO)?([-&]|$)/.test(d)) out.condo = 1;
  if (/(^|[-&])PL([-&]|$)/.test(d)) out.pool = 1;
  return out;
}

// Normalise an address for joining: "301 WALTON ST" <-> "301" + "Walton Street"
const SUFFIX = {
  street: 'ST', st: 'ST', avenue: 'AVE', ave: 'AVE', road: 'RD', rd: 'RD',
  drive: 'DR', dr: 'DR', lane: 'LN', ln: 'LN', place: 'PL', pl: 'PL',
  terrace: 'TER', ter: 'TER', court: 'CT', ct: 'CT', boulevard: 'BLVD',
  circle: 'CIR', cir: 'CIR', way: 'WAY', parkway: 'PKWY', highway: 'HWY',
};
function normAddr(num, street) {
  if (!num || !street) return null;
  const parts = String(street).trim().toUpperCase().split(/\s+/);
  const last = parts[parts.length - 1].toLowerCase();
  if (SUFFIX[last]) parts[parts.length - 1] = SUFFIX[last];
  return `${String(num).trim().toUpperCase()} ${parts.join(' ')}`;
}

// Index parcels by normalised address and by a coarse spatial grid.
const byAddr = new Map();
const grid = new Map();
const GCELL = 60;
const gkey = (x, z) => `${Math.floor(x / GCELL)},${Math.floor(z / GCELL)}`;

for (const p of parcels) {
  const [x, z] = project(p.lat, p.lon);
  p._x = x; p._z = z;
  p._parsed = parseDesc(p.desc);
  if (p.loc) {
    const m = /^\s*(\d+[A-Z]?)\s+(.+?)\s*$/.exec(p.loc.toUpperCase());
    if (m) {
      const key = normAddr(m[1], m[2]);
      if (key && !byAddr.has(key)) byAddr.set(key, p);
    }
  }
  const k = gkey(x, z);
  let cell = grid.get(k);
  if (!cell) { cell = []; grid.set(k, cell); }
  cell.push(p);
}

function nearestParcel(x, z, maxD) {
  let best = null, bd = maxD * maxD;
  const gx = Math.floor(x / GCELL), gz = Math.floor(z / GCELL);
  for (let i = gx - 1; i <= gx + 1; i++) {
    for (let j = gz - 1; j <= gz + 1; j++) {
      const cell = grid.get(`${i},${j}`);
      if (!cell) continue;
      for (const p of cell) {
        const d = (p._x - x) ** 2 + (p._z - z) ** 2;
        if (d < bd) { bd = d; best = p; }
      }
    }
  }
  return best;
}

let joinAddr = 0, joinSpatial = 0;
for (const b of buildings) {
  let cx = 0, cz = 0;
  for (const p of b.r) { cx += p[0]; cz += p[1]; }
  cx /= b.r.length; cz /= b.r.length;

  let parcel = null;
  const key = normAddr(b.num, b.street);
  if (key && byAddr.has(key)) { parcel = byAddr.get(key); joinAddr++; }
  if (!parcel) {
    parcel = nearestParcel(cx, cz, 32);
    if (parcel) joinSpatial++;
  }
  if (!parcel) continue;

  const q = parcel._parsed || {};
  if (parcel.year && parcel.year > 1700) b.yr = parcel.year;
  if (q.storeys) b.st = q.storeys;
  if (q.material) b.mat = q.material;
  if (q.garage) b.gar = q.garage;
  if (q.condo) b.condo = 1;
}
console.log(`parcels: ${parcels.length} records — joined ${joinAddr} by address, ${joinSpatial} spatially`);
console.log(`  with storeys: ${buildings.filter((b) => b.st).length}, material: ${buildings.filter((b) => b.mat).length}, year: ${buildings.filter((b) => b.yr).length}`);

/* Now that we know the real storey count, rebuild the height from it. An
   assessed 1.5-storey cape and an assessed 2-storey colonial are genuinely
   different buildings, and previously both got the same 8.2 m default. */
const STOREY_H = 3.05;      // floor-to-floor for this housing stock
let heightFromParcel = 0;
for (const b of buildings) {
  /* For house-scale buildings the assessor walked the property; OSM levels are
     often a guess from aerial imagery. So the assessment wins at <= 3.5
     storeys (fixes 1-storey homes rendered two floors tall), and the OSM tag
     wins for the tall apartment stock the assessor codes differently. */
  const levels = (b.st && b.st <= 3.5) ? b.st : (b.lvl || b.st);
  if (!levels || levels < 0.5 || levels > 40) continue;
  const eave = levels * STOREY_H + 0.9;      // + foundation reveal
  if (Math.abs(eave - b.h) > 0.4) heightFromParcel++;
  b.h = Math.round(Math.min(60, Math.max(2.6, eave)) * 10) / 10;
}
console.log(`  heights rebuilt from real storey counts: ${heightFromParcel}`);

// ------------------------------------------------------- areas: parks, water
const areas = [];
function pushArea(w, kind) {
  if (!w.nodes || w.nodes.length < 4) return;
  const ring = [];
  for (const id of w.nodes) {
    const n = nodes.get(id);
    if (!n) continue;
    const [x, z] = project(n.lat, n.lon);
    ring.push([Math.round(x * 10) / 10, Math.round(z * 10) / 10]);
  }
  if (ring.length < 4) return;
  let area = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    area += (ring[j][0] + ring[i][0]) * (ring[j][1] - ring[i][1]);
  }
  if (Math.abs(area / 2) < 60) return;
  areas.push({ r: ring, k: kind, n: (w.tags && w.tags.name) || null });
}
for (const w of ways) {
  const t = w.tags || {};
  if (t.natural === 'water' || t.waterway === 'riverbank' || t.landuse === 'reservoir') pushArea(w, 'water');
  else if (t.leisure === 'park' || t.leisure === 'garden' || t.landuse === 'recreation_ground') pushArea(w, 'park');
  else if (t.leisure === 'pitch' || t.leisure === 'playground') pushArea(w, 'pitch');
  else if (t.landuse === 'grass' || t.landuse === 'meadow' || t.natural === 'wood' || t.landuse === 'forest') pushArea(w, 'grass');
  else if (t.landuse === 'cemetery' || t.amenity === 'grave_yard') pushArea(w, 'grass');
  else if (t.landuse === 'retail' || t.landuse === 'commercial') pushArea(w, 'retail');
  else if (t.landuse === 'industrial') pushArea(w, 'industrial');
}
console.log(`areas: ${areas.length}`);

// --------------------------------------------------------------- rail lines
const rails = [];
for (const w of ways) {
  const t = w.tags || {};
  if (!t.railway || !['rail', 'light_rail', 'subway', 'disused', 'abandoned'].includes(t.railway)) continue;
  if (!w.nodes || w.nodes.length < 2) continue;
  const pts = [];
  for (const id of w.nodes) {
    const n = nodes.get(id);
    if (!n) continue;
    const [x, z] = project(n.lat, n.lon);
    pts.push([Math.round(x * 10) / 10, Math.round(z * 10) / 10]);
  }
  if (pts.length >= 2) rails.push({ pts, k: t.railway });
}

// ------------------------------------------------ traffic control + landmarks
const signals = [];
for (const [, n] of nodes) {
  const t = n.tags || {};
  if (!t.highway) continue;
  if (!['traffic_signals', 'stop', 'crossing'].includes(t.highway)) continue;
  const [x, z] = project(n.lat, n.lon);
  if (x < -WORLD_W / 2 || x > WORLD_W / 2 || z < -WORLD_H / 2 || z > WORLD_H / 2) continue;
  signals.push({
    x: Math.round(x * 10) / 10,
    z: Math.round(z * 10) / 10,
    k: t.highway === 'traffic_signals' ? 'signal' : t.highway === 'stop' ? 'stop' : 'crossing',
  });
}
console.log(`traffic control: ${signals.length}`);

const POI_KEEP = new Set([
  'school', 'police', 'fire_station', 'townhall', 'library', 'place_of_worship',
  'restaurant', 'cafe', 'fast_food', 'pharmacy', 'bank', 'fuel', 'post_office',
  'community_centre', 'doctors', 'bar', 'parking',
]);
const pois = [];
for (const [, n] of nodes) {
  const t = n.tags || {};
  if (!t.amenity || !POI_KEEP.has(t.amenity)) continue;
  const [x, z] = project(n.lat, n.lon);
  if (x < -WORLD_W / 2 || x > WORLD_W / 2 || z < -WORLD_H / 2 || z > WORLD_H / 2) continue;
  pois.push({ x: Math.round(x * 10) / 10, z: Math.round(z * 10) / 10, k: t.amenity, n: t.name || null });
}
console.log(`pois: ${pois.length}`);

// -------------------------------------------------------------- terrain grid
let terrain = null;
if (elevRaw && elevRaw.elevations && !elevRaw.elevations.includes(null)) {
  const n = elevRaw.n;
  // Grid rows run south -> north in the fetcher; the game samples in +Z = south,
  // so flip rows here once rather than on every lookup.
  const flipped = new Array(n * n);
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) flipped[r * n + c] = elevRaw.elevations[(n - 1 - r) * n + c];
  }
  const vals = flipped.map((v) => Math.round(v * 100) / 100);
  terrain = { n, w: WORLD_W, h: WORLD_H, min: Math.min(...vals), max: Math.max(...vals), e: vals };
  console.log(`terrain: ${n}x${n}, ${terrain.min}m - ${terrain.max}m`);
} else {
  console.log('terrain: NOT READY (elevation fetch incomplete) — writing flat placeholder');
  terrain = { n: 2, w: WORLD_W, h: WORLD_H, min: 0, max: 0, e: [0, 0, 0, 0] };
}

// ------------------------------------------------------------------- output
fs.mkdirSync(OUT, { recursive: true });

const meta = {
  name: 'Leonia, New Jersey',
  bbox: BBOX,
  center: { lat: CLAT, lon: CLON },
  size: { w: Math.round(WORLD_W), h: Math.round(WORLD_H) },
  mPerDegLat: M_PER_DEG_LAT,
  mPerDegLon: M_PER_DEG_LON,
  boundary,
  attribution: 'Map data © OpenStreetMap contributors (ODbL). Elevation: USGS 3DEP / NED 10m.',
  counts: {
    roads: roads.length, edges: edges.length, junctions: junctions.length,
    buildings: buildings.length, areas: areas.length, signals: signals.length, pois: pois.length,
  },
};

// Strip node ids from road geometry — the runtime only needs coordinates.
const roadsOut = roads.map((r) => ({
  n: r.name, k: r.kind, l: r.label, w: Math.round(r.w * 100) / 100, ln: r.lanes,
  pk: r.park, ps: r.parkSides,
  mph: r.mph, rk: r.rank, ow: r.oneway ? 1 : 0, br: r.bridge ? 1 : 0,
  p: r.pts.map((p) => [p[0], p[1]]),
}));

const write = (file, obj) => {
  const p = path.join(OUT, file);
  fs.writeFileSync(p, JSON.stringify(obj));
  console.log(`  ${file}  ${(fs.statSync(p).size / 1024).toFixed(0)} KB`);
};

console.log('writing world files:');
write('meta.json', meta);
write('roads.json', roadsOut);
write('network.json', { junctions, edges });
// Compact per-building output: geometry plus the assessment-derived identity.
write('buildings.json', buildings.map((b) => {
  const o = { r: b.r, h: b.h, t: b.t, a: b.a };
  if (b.n) o.n = b.n;
  if (b.yr) o.yr = b.yr;          // year built
  if (b.st) o.st = b.st;          // assessed storeys
  if (b.mat) o.mat = b.mat;       // construction material
  if (b.gar) o.gar = b.gar;       // garage type
  if (b.condo) o.condo = 1;
  if (b.rs) o.rs = b.rs;          // surveyed roof shape
  return o;
}));
write('areas.json', areas);
write('rails.json', rails);
write('props.json', { signals, pois });
write('terrain.json', terrain);
console.log('world build complete.');
