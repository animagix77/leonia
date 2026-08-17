#!/usr/bin/env node
/* Pull NJ MOD-IV assessment records for the Leonia bbox.

   MOD-IV is the state's property tax assessment file — public record,
   published by the NJ Division of Taxation and served here joined to parcel
   geometry by NJGIN. For each lot it gives the year built, a building class,
   and a coded description of the structure. That is what lets us build each
   house as itself rather than as another instance of a generic box.

   BLDG_DESC is a compact assessor's code, e.g.
     1&2S-B&F-BG   1-and-2-storey, brick and frame, basement garage
     2S-C-1BR-1BA  2-storey condo unit
     1S-B&AL-BG    1-storey, brick and aluminium siding, basement garage
*/

const fs = require('fs');
const path = require('path');

const URL = 'https://services2.arcgis.com/XVOqAjTOJ5P6ngMu/ArcGIS/rest/services/Parcels_MODIV_NJ_WM/FeatureServer/0/query';
const BBOX = { south: 40.8480, north: 40.8800, west: -74.0100, east: -73.9720 };
const OUT = path.join(__dirname, 'raw', 'parcels.json');
const PAGE = 1000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function page(offset, attempt = 0) {
  const params = new URLSearchParams({
    where: '1=1',
    geometry: `${BBOX.west},${BBOX.south},${BBOX.east},${BBOX.north}`,
    geometryType: 'esriGeometryEnvelope',
    inSR: '4326',
    outSR: '4326',
    spatialRel: 'esriSpatialRelIntersects',
    outFields: 'PROP_LOC,PROP_CLASS,BLDG_DESC,BLDG_CLASS,YR_CONSTR,CALC_ACRE,PROP_USE,LAND_DESC',
    returnCentroid: 'true',
    returnGeometry: 'false',
    resultOffset: String(offset),
    resultRecordCount: String(PAGE),
    f: 'json',
  });
  try {
    const res = await fetch(`${URL}?${params}`);
    const json = await res.json();
    if (json.error) throw new Error(JSON.stringify(json.error).slice(0, 160));
    return json;
  } catch (err) {
    if (attempt >= 4) throw err;
    await sleep(1500 * (attempt + 1));
    return page(offset, attempt + 1);
  }
}

(async () => {
  const all = [];
  let offset = 0;
  for (let i = 0; i < 30; i++) {
    const json = await page(offset);
    const feats = json.features || [];
    for (const f of feats) {
      if (!f.centroid) continue;
      all.push({
        lon: Math.round(f.centroid.x * 1e6) / 1e6,
        lat: Math.round(f.centroid.y * 1e6) / 1e6,
        loc: f.attributes.PROP_LOC || null,
        cls: f.attributes.PROP_CLASS || null,
        desc: f.attributes.BLDG_DESC || null,
        bcls: f.attributes.BLDG_CLASS || null,
        year: f.attributes.YR_CONSTR || null,
        acre: f.attributes.CALC_ACRE || null,
      });
    }
    console.log(`page ${i + 1}: +${feats.length} (total ${all.length})`);
    if (!json.exceededTransferLimit || feats.length === 0) break;
    offset += feats.length;
    await sleep(350);
  }

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(all));

  const withYear = all.filter((p) => p.year && p.year > 1700).length;
  const withDesc = all.filter((p) => p.desc).length;
  const res = all.filter((p) => p.cls === '2').length;
  console.log(`\nsaved ${all.length} parcels -> ${OUT}`);
  console.log(`  residential (class 2): ${res}`);
  console.log(`  with year built:       ${withYear}`);
  console.log(`  with building desc:    ${withDesc}`);
  const years = all.map((p) => p.year).filter((y) => y > 1700).sort((a, b) => a - b);
  if (years.length) {
    console.log(`  year range: ${years[0]} - ${years[years.length - 1]}, median ${years[Math.floor(years.length / 2)]}`);
  }
})();
