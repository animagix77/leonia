import * as THREE from 'three';
import { GLTFLoader } from '../../vendor/jsm/loaders/GLTFLoader.js';

/* Optional authored vehicle models.

   The procedural bodies in carbuilder.js are what ship by default — they cost
   nothing, they load instantly and every archetype is guaranteed to exist. But
   a hand-authored model will always beat generated geometry, so this module
   lets real glTF/GLB files take over per vehicle class with no code changes:
   drop files into public/assets/vehicles/ alongside a manifest and they are
   used automatically. Anything missing falls back to procedural.

   Normalisation is the whole job here. Downloaded models arrive at arbitrary
   scale, arbitrary origin and arbitrary facing, and a car that is 40 units
   long pointing down -X will look broken no matter how good the mesh is. We
   measure the bounding box, rescale to the spec's real metre dimensions, sit
   it on y = 0 and orient it to +Z forward. */

const REGISTRY = new Map();          // spec key -> { scene, wheels }
let loaded = false;

export function hasAsset(key) { return REGISTRY.has(key); }
export function getAsset(key) { return REGISTRY.get(key); }
export function assetCount() { return REGISTRY.size; }

/** Wheel nodes are matched by name, which is the usual convention in packs. */
const WHEEL_RE = /wheel|tyre|tire|rim/i;

function normalise(root, spec, opts) {
  const g = new THREE.Group();

  // Face +Z. Most packs author down -Z or +X; the manifest can say which.
  const yaw = (opts.yawDeg ?? 0) * Math.PI / 180;
  root.rotation.y = yaw;

  const holder = new THREE.Group();
  holder.add(root);
  holder.updateMatrixWorld(true);

  const box = new THREE.Box3().setFromObject(holder);
  const size = box.getSize(new THREE.Vector3());
  if (size.x < 1e-6 || size.z < 1e-6) return null;

  // Scale so the model's long axis matches the spec's real length.
  const modelLen = Math.max(size.z, size.x);
  const scale = (opts.scale ?? 1) * (spec.len / modelLen);
  holder.scale.setScalar(scale);
  holder.updateMatrixWorld(true);

  // Re-measure and seat it: centred in X/Z, resting on y = 0.
  const box2 = new THREE.Box3().setFromObject(holder);
  const c = box2.getCenter(new THREE.Vector3());
  holder.position.x -= c.x;
  holder.position.z -= c.z;
  holder.position.y -= box2.min.y;

  g.add(holder);

  // Collect wheel nodes so they can still spin and steer.
  const wheels = [];
  holder.traverse((o) => {
    if (!o.isMesh && !o.isGroup) return;
    if (!WHEEL_RE.test(o.name || '')) return;
    // Only take top-most matches, not every sub-mesh of a wheel.
    let p = o.parent, nested = false;
    while (p) { if (WHEEL_RE.test(p.name || '')) { nested = true; break; } p = p.parent; }
    if (!nested) wheels.push(o);
  });

  g.traverse((o) => {
    if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; }
  });

  return { group: g, wheels };
}

/**
 * Look for public/assets/vehicles/manifest.json and load whatever it lists.
 * Silently does nothing if the directory isn't there, which is the normal case.
 *
 * manifest.json format:
 *   { "sedan": { "file": "sedan.glb", "yawDeg": 180 }, "suv": "suv.glb" }
 */
export async function loadVehicleAssets(base = 'assets/vehicles', specs = {}) {
  if (loaded) return REGISTRY;
  loaded = true;

  let manifest;
  try {
    const res = await fetch(`${base}/manifest.json`, { cache: 'no-cache' });
    if (!res.ok) return REGISTRY;                 // no pack installed — fine
    manifest = await res.json();
  } catch {
    return REGISTRY;
  }

  const loader = new GLTFLoader();
  const jobs = [];

  for (const [key, entry] of Object.entries(manifest)) {
    const spec = specs[key];
    if (!spec) {
      console.warn(`vehicle asset "${key}" has no matching spec — skipped`);
      continue;
    }
    const opts = typeof entry === 'string' ? { file: entry } : entry;
    if (!opts.file) continue;

    jobs.push(
      loader.loadAsync(`${base}/${opts.file}`)
        .then((gltf) => {
          const norm = normalise(gltf.scene, spec, opts);
          if (norm) {
            REGISTRY.set(key, norm);
            console.log(`vehicle asset: ${key} <- ${opts.file} (${norm.wheels.length} wheel nodes)`);
          }
        })
        .catch((err) => console.warn(`vehicle asset "${key}" failed: ${err.message}`))
    );
  }

  await Promise.all(jobs);
  if (REGISTRY.size) console.log(`vehicle assets: ${REGISTRY.size} authored models in use`);
  return REGISTRY;
}

/** Clone an authored model for one vehicle instance. */
export function instantiateAsset(key, colorHex) {
  const entry = REGISTRY.get(key);
  if (!entry) return null;

  const g = entry.group.clone(true);

  // Re-find the wheels on the clone by name, and nest them for steer/spin.
  const wheels = [];
  g.traverse((o) => {
    if (!WHEEL_RE.test(o.name || '')) return;
    let p = o.parent, nested = false;
    while (p) { if (WHEEL_RE.test(p.name || '')) { nested = true; break; } p = p.parent; }
    if (nested) return;
    o.userData.front = o.position.z > 0;
    o.userData.spin = o;                  // authored wheels spin in place
    wheels.push(o);
  });

  // Tint any material flagged as the body colour.
  if (colorHex !== undefined) {
    g.traverse((o) => {
      if (!o.isMesh || !o.material) return;
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      for (const m of mats) {
        if (/body|paint|carpaint/i.test(m.name || '')) {
          const c = m.clone();
          c.color.setHex(colorHex);
          o.material = c;
        }
      }
    });
  }

  g.userData = { wheels, spec: null, wheelR: 0.34, authored: true };
  return g;
}
