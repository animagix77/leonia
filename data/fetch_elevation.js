#!/usr/bin/env node
/* Fetch a USGS NED 10m elevation grid for the Leonia bbox via opentopodata.
   Public API: max 100 locations/request, 1 req/sec, 1000 req/day.
   Resumable — writes partial progress so a rate-limit stall isn't fatal. */

const fs = require('fs');
const path = require('path');

const BBOX = { south: 40.8480, north: 40.8800, west: -74.0100, east: -73.9720 };
const N = 128;                       // grid resolution (N x N samples)
const OUT = path.join(__dirname, 'raw', 'elevation.json');
const BATCH = 100;

function gridPoints() {
  const pts = [];
  for (let r = 0; r < N; r++) {
    const lat = BBOX.south + (BBOX.north - BBOX.south) * (r / (N - 1));
    for (let c = 0; c < N; c++) {
      const lon = BBOX.west + (BBOX.east - BBOX.west) * (c / (N - 1));
      pts.push([lat, lon]);
    }
  }
  return pts;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchBatch(batch, attempt = 0) {
  const locs = batch.map(([a, o]) => `${a.toFixed(6)},${o.toFixed(6)}`).join('|');
  try {
    const res = await fetch('https://api.opentopodata.org/v1/ned10m', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ locations: locs }),
    });
    if (res.status === 429) throw new Error('rate limited');
    const json = await res.json();
    if (json.status !== 'OK') throw new Error(json.error || 'bad status');
    return json.results.map((r) => (r.elevation === null ? 0 : r.elevation));
  } catch (err) {
    if (attempt >= 5) {
      console.error('  batch failed permanently:', err.message);
      return batch.map(() => null);
    }
    const wait = 2000 * Math.pow(2, attempt);
    console.error(`  retry ${attempt + 1} in ${wait}ms (${err.message})`);
    await sleep(wait);
    return fetchBatch(batch, attempt + 1);
  }
}

(async () => {
  const pts = gridPoints();
  const elev = new Array(pts.length).fill(null);

  // Resume from a partial run if present.
  if (fs.existsSync(OUT)) {
    try {
      const prev = JSON.parse(fs.readFileSync(OUT, 'utf8'));
      if (prev.n === N && Array.isArray(prev.elevations) && prev.elevations.length === pts.length) {
        prev.elevations.forEach((v, i) => { if (v !== null) elev[i] = v; });
        console.log(`resuming: ${elev.filter((v) => v !== null).length}/${pts.length} already known`);
      }
    } catch { /* start fresh */ }
  }

  const total = Math.ceil(pts.length / BATCH);
  for (let b = 0; b < total; b++) {
    const lo = b * BATCH, hi = Math.min(lo + BATCH, pts.length);
    if (elev.slice(lo, hi).every((v) => v !== null)) continue;   // already have it
    const vals = await fetchBatch(pts.slice(lo, hi));
    for (let i = 0; i < vals.length; i++) elev[lo + i] = vals[i];
    if (b % 10 === 0 || b === total - 1) {
      console.log(`batch ${b + 1}/${total}`);
      fs.writeFileSync(OUT, JSON.stringify({ bbox: BBOX, n: N, elevations: elev }));
    }
    await sleep(1100);   // stay under 1 req/sec
  }

  // Fill any remaining holes from nearest known neighbour so the mesh has no gaps.
  const missing = elev.map((v, i) => (v === null ? i : -1)).filter((i) => i >= 0);
  for (const i of missing) {
    let d = 1, filled = false;
    while (d < N && !filled) {
      for (const off of [-d, d, -d * N, d * N]) {
        const j = i + off;
        if (j >= 0 && j < elev.length && elev[j] !== null) { elev[i] = elev[j]; filled = true; break; }
      }
      d++;
    }
    if (!filled) elev[i] = 0;
  }

  fs.writeFileSync(OUT, JSON.stringify({ bbox: BBOX, n: N, elevations: elev }));
  const known = elev.filter((v) => v !== null);
  console.log(`done — ${known.length} samples, min ${Math.min(...known).toFixed(1)}m max ${Math.max(...known).toFixed(1)}m`);
  console.log(`holes filled: ${missing.length}`);
})();
