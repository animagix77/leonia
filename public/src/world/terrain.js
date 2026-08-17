import * as THREE from 'three';
import { triangulate, makeRng, clamp } from '../core/util.js';
import { buildSurfaces } from './textures.js';

const AREA_STYLE = {
  water:      { color: 0x2c4f63, y: 0.10, rough: 0.15, metal: 0.35 },
  park:       { color: 0x4a6b34, y: 0.06, rough: 0.95, metal: 0 },
  pitch:      { color: 0x53773a, y: 0.09, rough: 0.9,  metal: 0 },
  grass:      { color: 0x51683a, y: 0.05, rough: 0.95, metal: 0 },
  retail:     { color: 0x50504e, y: 0.04, rough: 0.9,  metal: 0 },
  industrial: { color: 0x4b4a47, y: 0.04, rough: 0.9,  metal: 0 },
};

/** Terrain mesh from the USGS grid, plus flat landuse decals. */
export function buildTerrain(world, scene) {
  const n = world.tN;
  /* The DEM is 10 m; at 191 segments the mesh quad was ~16.7 m, so we were
     throwing away resolution already paid for. 320 puts a vertex roughly
     every 10 m and sharpens every ridge line and shadow silhouette. */
  const segs = 192;
  const geo = new THREE.PlaneGeometry(world.tW, world.tH, segs, segs);
  geo.rotateX(-Math.PI / 2);

  const pos = geo.attributes.position;
  const colors = new Float32Array(pos.count * 3);
  const rng = makeRng(1907);

  const cGrass = new THREE.Color(0x4d6437);
  const cDry = new THREE.Color(0x6a6a44);
  const cRock = new THREE.Color(0x5d5952);
  const cLow = new THREE.Color(0x445a38);
  const tmp = new THREE.Color();

  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const z = pos.getZ(i);
    const h = world.heightAt(x, z);
    pos.setY(i, h);

    // Slope drives rock vs grass; elevation drives the meadow-to-ridge shift.
    const nrm = world.normalAt(x, z, 12);
    const slope = 1 - nrm[1];
    const alt = clamp((h - world.terrain.min) / Math.max(1, world.terrain.max - world.terrain.min), 0, 1);

    tmp.copy(cLow).lerp(cGrass, alt);
    if (alt > 0.55) tmp.lerp(cDry, (alt - 0.55) / 0.45 * 0.35);
    tmp.lerp(cRock, clamp(slope * 5.5, 0, 0.8));
    const jitter = 0.92 + rng() * 0.16;
    colors[i * 3] = tmp.r * jitter;
    colors[i * 3 + 1] = tmp.g * jitter;
    colors[i * 3 + 2] = tmp.b * jitter;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geo.computeVertexNormals();

  // Turf detail. PlaneGeometry UVs are 0..1, so repeat by world size / tile.
  const S = buildSurfaces();
  const gmap = S.grass.map.clone();
  const gnrm = S.grass.normalMap.clone();
  const TILE = 7;                                   // metres per tile
  for (const t of [gmap, gnrm]) {
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.repeat.set(world.tW / TILE, world.tH / TILE);
    t.needsUpdate = true;
  }
  const mat = new THREE.MeshStandardMaterial({
    vertexColors: true, roughness: 0.96, metalness: 0.0, envMapIntensity: 1.15,
    map: gmap, normalMap: gnrm, normalScale: new THREE.Vector2(0.55, 0.55),
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.receiveShadow = true;
  mesh.name = 'terrain';
  scene.add(mesh);

  // ------------------------------------------------------- landuse decals
  const byKind = new Map();
  for (const a of world.areas) {
    if (!AREA_STYLE[a.k]) continue;
    if (!byKind.has(a.k)) byKind.set(a.k, []);
    byKind.get(a.k).push(a);
  }

  const decals = [];
  for (const [kind, list] of byKind) {
    const style = AREA_STYLE[kind];
    const verts = [];
    const idx = [];
    let base = 0;
    for (const a of list) {
      const ring = a.r;
      const tris = triangulate(ring);
      if (!tris.length) continue;
      for (const p of ring) {
        verts.push(p[0], world.heightAt(p[0], p[1]) + style.y, p[1]);
      }
      for (const t of tris) idx.push(base + t);
      base += ring.length;
    }
    if (!idx.length) continue;

    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
    g.setIndex(idx);
    g.computeVertexNormals();

    const m = new THREE.MeshStandardMaterial({
      color: style.color, roughness: style.rough, metalness: style.metal,
      polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
    });
    const dm = new THREE.Mesh(g, m);
    dm.receiveShadow = true;
    dm.renderOrder = 1;
    dm.name = `area_${kind}`;
    scene.add(dm);
    decals.push(dm);
  }

  return { mesh, decals };
}

/* ------------------------------------------------------- beyond the edge */

/** Silhouette card: the GWB and the Manhattan skyline, drawn once to canvas. */
function skylineTexture() {
  const W = 2048, H = 512;
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const ctx = c.getContext('2d');
  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = '#ffffff';          // tinted by the material colour + fog

  const base = H - 8;

  // Low ridge line across the whole card — the far bank of the Hudson.
  ctx.beginPath();
  ctx.moveTo(0, base);
  for (let x = 0; x <= W; x += 32) {
    const h = 26 + 14 * Math.sin(x * 0.004) + 8 * Math.sin(x * 0.013 + 2);
    ctx.lineTo(x, base - h);
  }
  ctx.lineTo(W, base);
  ctx.closePath();
  ctx.fill();

  // Midtown cluster, left of centre: rectangles of varied height, one spire.
  let x = W * 0.16;
  let seed = 7;
  const rand = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  while (x < W * 0.44) {
    const w = 18 + rand() * 34;
    const h = 70 + rand() * 150;
    ctx.fillRect(x, base - h, w, h);
    if (rand() < 0.16) ctx.fillRect(x + w / 2 - 2, base - h - 26, 4, 26);   // mast
    x += w + 4 + rand() * 14;
  }
  // The one very tall one.
  ctx.fillRect(W * 0.30, base - 268, 26, 268);
  ctx.fillRect(W * 0.30 + 10, base - 296, 6, 28);

  // George Washington Bridge, right of centre: two towers, deck, catenaries.
  const bx = W * 0.62, span = W * 0.20;
  const towerH = 150, deckY = base - 58;
  for (const tx of [bx, bx + span]) {
    // twin-leg tower with two cross braces
    ctx.fillRect(tx - 9, base - towerH, 7, towerH);
    ctx.fillRect(tx + 2, base - towerH, 7, towerH);
    ctx.fillRect(tx - 9, base - towerH + 18, 18, 8);
    ctx.fillRect(tx - 9, deckY - 26, 18, 8);
  }
  ctx.fillRect(bx - 110, deckY, span + 220, 7);      // deck, running past both towers
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = 4;
  for (const [x0, x1, sag] of [[bx, bx + span, 66], [bx - 110, bx, -40], [bx + span, bx + span + 110, -40]]) {
    ctx.beginPath();
    ctx.moveTo(x0, base - towerH + 4);
    if (sag > 0) ctx.quadraticCurveTo((x0 + x1) / 2, deckY + 8 - sag + 66, x1, base - towerH + 4);
    else ctx.quadraticCurveTo((x0 + x1) / 2, base - towerH + 30, x1, deckY + 2);
    ctx.stroke();
  }

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

/**
 * The world used to simply end: past the bbox the camera saw void, and from
 * the ridge there was no river, no bridge, no city — the town's defining view.
 * A fog-tinted silhouette card at 3.2 km supplies the skyline, and a skirt
 * plus ground ring closes the edge (the eastern drop IS the Palisades).
 */
export function buildBackdrop(world, scene) {
  const R = 3200;
  // East-through-southeast arc. Our frame: +X = east, +Z = south.
  const geo = new THREE.CylinderGeometry(R, R, 420, 48, 1, true, Math.PI * 0.12, Math.PI * 0.85);
  const mat = new THREE.MeshBasicMaterial({
    map: skylineTexture(),
    transparent: true,
    depthWrite: false,
    side: THREE.BackSide,          // viewed from inside the ring
    // Dark slate: the exp2 fog mixes ~60% haze over this at 3.2 km, so the
    // base must start well below the sky tone or the silhouette vanishes.
    color: 0x323c48,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.set(0, 140, 0);
  // AFTER the sky dome. Neither writes depth, so draw order decides — at -1
  // the dome simply painted over the card and the skyline never appeared.
  // Depth-testing against the already-drawn terrain still hides it behind hills.
  mesh.renderOrder = 1;
  mesh.name = 'backdrop_skyline';
  scene.add(mesh);

  // Skirt: close the terrain edge down to a ground plane so the rim never
  // shows void. The 100 m eastern face this creates is, in fact, the cliffs.
  const skirtV = [];
  const skirtI = [];
  const hw = world.halfW, hh = world.halfH;
  const border = [];
  const STEPS = 64;
  for (let i = 0; i <= STEPS; i++) border.push([-hw + (2 * hw * i) / STEPS, -hh]);   // north
  for (let i = 1; i <= STEPS; i++) border.push([hw, -hh + (2 * hh * i) / STEPS]);    // east
  for (let i = 1; i <= STEPS; i++) border.push([hw - (2 * hw * i) / STEPS, hh]);     // south
  for (let i = 1; i <= STEPS; i++) border.push([-hw, hh - (2 * hh * i) / STEPS]);    // west
  const LOW = -3;
  for (let i = 0; i < border.length; i++) {
    const [x, z] = border[i];
    skirtV.push(x, world.heightAt(x, z) + 0.05, z, x, LOW, z);
  }
  for (let i = 0; i < border.length - 1; i++) {
    const a = i * 2;
    skirtI.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    skirtI.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);   // both windings — always solid
  }
  const sg = new THREE.BufferGeometry();
  sg.setAttribute('position', new THREE.Float32BufferAttribute(skirtV, 3));
  sg.setIndex(skirtI);
  sg.computeVertexNormals();
  const skirt = new THREE.Mesh(sg, new THREE.MeshStandardMaterial({ color: 0x565248, roughness: 1 }));
  skirt.name = 'terrain_skirt';
  scene.add(skirt);

  // Ground ring out to the backdrop, sitting under the true terrain.
  const ring = new THREE.Mesh(
    new THREE.PlaneGeometry(R * 2.6, R * 2.6, 1, 1),
    new THREE.MeshStandardMaterial({ color: 0x4b5544, roughness: 1 })
  );
  ring.rotation.x = -Math.PI / 2;
  ring.position.y = LOW - 0.2;
  ring.name = 'ground_ring';
  scene.add(ring);

  return { mesh, mat, skirt, ring };
}

/** Borough boundary as a subtle glowing line, so you can see where Leonia ends. */
export function buildBoundary(world, scene) {
  if (!world.meta.boundary) return null;
  const pts = [];
  for (const p of world.meta.boundary) {
    pts.push(new THREE.Vector3(p[0], world.heightAt(p[0], p[1]) + 0.6, p[1]));
  }
  pts.push(pts[0].clone());
  const geo = new THREE.BufferGeometry().setFromPoints(pts);
  const mat = new THREE.LineBasicMaterial({ color: 0x4fd0ff, transparent: true, opacity: 0.22 });
  const line = new THREE.Line(geo, mat);
  line.name = 'boundary';
  scene.add(line);
  return line;
}
