import * as THREE from 'three';
import { clamp } from '../core/util.js';

/* Impact effects: crumpled sheet metal and smoke.

   Dents are real geometry. Every vehicle body is its own BufferGeometry (the
   loft is generated per car, and instancing is only used for the parked
   fleet), so a hit can push the vertices around the contact point inward
   along the crush direction, with falloff and a little noise. Normals are
   recomputed, so the dent catches light like beaten metal. Damage
   accumulates per vertex up to a cap, so a car that has been through a lot
   LOOKS like it has been through a lot. */

/**
 * Crush the body shell around a contact point.
 * `crushX/Z` is the WORLD direction the metal folds (into the vehicle).
 * `cx/cz` is the world contact point; severity is the closing speed in m/s.
 */
export function dentVehicle(mesh, heading, px, pz, crushX, crushZ, cx, cz, severity) {
  const ud = mesh.userData;
  const body = ud && ud.bodyMesh;
  if (!body) return;                        // authored asset or missing shell
  const geo = body.geometry;
  const pos = geo.attributes.position;
  if (!ud.dent) ud.dent = new Float32Array(pos.count);

  /* A scrape emits contacts every frame. Rewriting the whole vertex buffer,
     recomputing normals and re-uploading at 60 Hz for a graze is pure waste,
     so require either a cooldown or a genuinely harder hit than last time. */
  const now = (typeof performance !== 'undefined' ? performance.now() : Date.now()) * 0.001;
  const lastT = ud.dentT || -99;
  const lastSev = ud.dentSev || 0;
  if (now - lastT < 0.15 && severity < lastSev * 1.35) return;
  ud.dentT = now;
  ud.dentSev = severity;

  // World -> vehicle-local (mesh is rotated Y by heading; forward = sin/cos).
  const ch = Math.cos(heading), sh = Math.sin(heading);
  const toLocal = (wx, wz) => [wx * ch - wz * sh, wx * sh + wz * ch];
  const [lcx, lcz] = toLocal(cx - px, cz - pz);
  let [lnx, lnz] = toLocal(crushX, crushZ);
  const nl = Math.hypot(lnx, lnz) || 1;
  lnx /= nl; lnz /= nl;

  const R = clamp(0.55 + severity * 0.05, 0.6, 1.6);      // dent radius
  const D = clamp(severity * 0.016, 0.02, 0.17);          // depth this hit
  const cy = (ud.spec?.h || 1.5) * 0.45;                  // beltline height
  const CAP = 0.24;                                       // max total crush

  let touched = false;
  for (let i = 0; i < pos.count; i++) {
    const vx = pos.getX(i), vy = pos.getY(i), vz = pos.getZ(i);
    const d = Math.hypot(vx - lcx, (vy - cy) * 1.5, vz - lcz);
    if (d > R) continue;
    const fall = 1 - d / R;
    const amt = D * fall * fall * (0.7 + Math.random() * 0.6);
    const room = CAP - ud.dent[i];
    if (room <= 0) continue;
    const use = Math.min(amt, room);
    ud.dent[i] += use;
    // Fold inward along the crush line, and sag slightly — metal drops.
    pos.setXYZ(i, vx + lnx * use, vy - use * 0.22, vz + lnz * use);
    touched = true;
  }
  if (touched) {
    pos.needsUpdate = true;
    geo.computeVertexNormals();
  }
}

/* ------------------------------------------------------------------ smoke */

function puffTexture() {
  const s = 64;
  const c = document.createElement('canvas');
  c.width = c.height = s;
  const ctx = c.getContext('2d');
  const g = ctx.createRadialGradient(s / 2, s / 2, 2, s / 2, s / 2, s / 2);
  g.addColorStop(0, 'rgba(255,255,255,0.9)');
  g.addColorStop(0.55, 'rgba(255,255,255,0.35)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, s, s);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** A small pool of drifting puffs for wounded engines. */
export class SmokePool {
  constructor(scene, count = 30) {
    const tex = puffTexture();
    this.pool = [];
    this.cursor = 0;
    for (let i = 0; i < count; i++) {
      const mat = new THREE.SpriteMaterial({
        map: tex, transparent: true, opacity: 0, depthWrite: false, color: 0x7a7e82,
      });
      const s = new THREE.Sprite(mat);
      s.visible = false;
      s.renderOrder = 8;
      scene.add(s);
      this.pool.push({ s, life: 0, max: 1, vx: 0, vy: 0, vz: 0 });
    }
  }

  /** dark = burning-oil black for the truly wrecked. */
  emit(x, y, z, dark = false) {
    const p = this.pool[this.cursor++ % this.pool.length];
    p.s.visible = true;
    p.life = p.max = 1.3 + Math.random() * 0.9;
    p.s.position.set(x + (Math.random() - 0.5) * 0.5, y, z + (Math.random() - 0.5) * 0.5);
    p.vx = (Math.random() - 0.5) * 0.6;
    p.vy = 1.1 + Math.random() * 0.9;
    p.vz = (Math.random() - 0.5) * 0.6;
    const sc = 0.55 + Math.random() * 0.45;
    p.s.scale.set(sc, sc, 1);
    p.s.material.color.setHex(dark ? 0x35383b : 0x84888c);
  }

  update(dt) {
    for (const p of this.pool) {
      if (!p.s.visible) continue;
      p.life -= dt;
      if (p.life <= 0) { p.s.visible = false; p.s.material.opacity = 0; continue; }
      p.s.position.x += p.vx * dt;
      p.s.position.y += p.vy * dt;
      p.s.position.z += p.vz * dt;
      const grow = 1 + dt * 1.2;
      p.s.scale.x *= grow; p.s.scale.y *= grow;
      p.s.material.opacity = 0.52 * (p.life / p.max);
    }
  }
}
