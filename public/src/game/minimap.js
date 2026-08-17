import { EVIDENCE } from './violations.js';

/* Two views over the same data: a rotating corner minimap, and a full-screen
   north-up map of the whole borough. Both draw straight from the OSM geometry. */

/* Lifted from the original near-black values — dark grey roads on a dark grey
   disc were effectively unreadable at a glance while driving. */
const ROAD_STYLE = {
  6: { c: '#8b959c', w: 5.0 },   // motorway
  5: { c: '#828c93', w: 4.0 },
  4: { c: '#78828a', w: 3.2 },
  3: { c: '#6c767e', w: 2.5 },
  2: { c: '#5a646c', w: 1.7 },
  1: { c: '#49525a', w: 1.0 },
};

export class MiniMap {
  constructor(world, canvas) {
    this.world = world;
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.scale = 0.42;          // px per metre
    this.rotate = true;
  }

  resize() {
    const c = this.canvas;
    const dpr = Math.min(devicePixelRatio || 1, 2);
    const r = c.getBoundingClientRect();
    // The HUD is display:none during boot, so the rect can be 0 — fall back to
    // the CSS box size rather than baking in a 1px canvas.
    const w = r.width || c.clientWidth || 186;
    const h = r.height || c.clientHeight || 186;
    c.width = Math.max(32, Math.round(w * dpr));
    c.height = Math.max(32, Math.round(h * dpr));
    this.dpr = dpr;
  }

  draw(player, traffic, enforcement) {
    const ctx = this.ctx;
    const W = this.canvas.width, H = this.canvas.height;
    if (W < 8 || H < 8) { this.resize(); return; }
    const cx = W / 2, cy = H / 2;
    const radius = Math.max(2, Math.min(W, H) / 2 - 2);
    const s = this.scale * (this.dpr || 1);

    ctx.clearRect(0, 0, W, H);

    // Circular clip
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, Math.PI * 2);
    ctx.clip();

    ctx.fillStyle = '#1a1f23';
    ctx.fillRect(0, 0, W, H);

    ctx.save();
    ctx.translate(cx, cy);
    if (this.rotate) ctx.rotate(player.heading);
    ctx.translate(-player.x * s, player.z * s);
    // NOTE: we flip Z when drawing so "up" on the map is the direction of travel.
    ctx.scale(1, -1);
    ctx.translate(0, 0);

    const range = Math.max(W, H) / (2 * s) + 40;
    this._drawAreas(ctx, player, s, range);
    this._drawRoads(ctx, player, s, range, false);

    ctx.restore();
    ctx.restore();

    // Blips are drawn unrotated relative to the centre.
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, Math.PI * 2);
    ctx.clip();
    this._drawBlips(ctx, cx, cy, s, player, traffic, enforcement);
    ctx.restore();

    // Player arrow
    ctx.save();
    ctx.translate(cx, cy);
    ctx.fillStyle = '#eef3f6';
    ctx.beginPath();
    ctx.moveTo(0, -8 * this.dpr);
    ctx.lineTo(6 * this.dpr, 7 * this.dpr);
    ctx.lineTo(0, 4 * this.dpr);
    ctx.lineTo(-6 * this.dpr, 7 * this.dpr);
    ctx.closePath();
    ctx.fill();
    ctx.restore();

    // Ring
    ctx.strokeStyle = 'rgba(200,215,225,0.35)';
    ctx.lineWidth = 2 * (this.dpr || 1);
    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, Math.PI * 2);
    ctx.stroke();
  }

  _drawAreas(ctx, player, s, range) {
    const W = this.world;
    for (const a of W.areas) {
      const p0 = a.r[0];
      if (Math.abs(p0[0] - player.x) > range || Math.abs(p0[1] - player.z) > range) continue;
      ctx.fillStyle = a.k === 'water' ? '#243b4a' : a.k === 'park' || a.k === 'grass' ? '#26361f' : '#242628';
      ctx.beginPath();
      ctx.moveTo(a.r[0][0] * s, a.r[0][1] * s);
      for (let i = 1; i < a.r.length; i++) ctx.lineTo(a.r[i][0] * s, a.r[i][1] * s);
      ctx.closePath();
      ctx.fill();
    }
  }

  _drawRoads(ctx, player, s, range, labels) {
    const W = this.world;
    // Bucket by rank once; this walked all 1,532 roads six times a frame.
    if (!this._byRank) {
      this._byRank = [[], [], [], [], [], [], []];
      for (const road of W.roads) (this._byRank[road.rk] || (this._byRank[road.rk] = [])).push(road);
    }
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    for (let rank = 1; rank <= 6; rank++) {
      const st = ROAD_STYLE[rank];
      if (!st) continue;
      ctx.strokeStyle = st.c;
      ctx.lineWidth = st.w * (this.dpr || 1) * (s / 0.42) * 0.42;
      ctx.beginPath();
      for (const road of (this._byRank[rank] || [])) {
        const p = road.p;
        /* Cull on the polyline's own extent, not its two endpoints. A road
           running clean across the borough has both ends far away in X while
           passing right under you — the endpoint test deleted the very street
           you were driving on. */
        if (road._minX === undefined) {
          let a = Infinity, b = -Infinity, c = Infinity, d = -Infinity;
          for (const q of p) {
            if (q[0] < a) a = q[0]; if (q[0] > b) b = q[0];
            if (q[1] < c) c = q[1]; if (q[1] > d) d = q[1];
          }
          road._minX = a; road._maxX = b; road._minZ = c; road._maxZ = d;
        }
        if (road._maxX < player.x - range || road._minX > player.x + range) continue;
        if (road._maxZ < player.z - range || road._minZ > player.z + range) continue;
        ctx.moveTo(p[0][0] * s, p[0][1] * s);
        for (let i = 1; i < p.length; i++) ctx.lineTo(p[i][0] * s, p[i][1] * s);
      }
      ctx.stroke();
    }
  }

  _drawBlips(ctx, cx, cy, s, player, traffic, enforcement) {
    const rot = this.rotate ? player.heading : 0;
    const cos = Math.cos(rot), sin = Math.sin(rot);
    const dpr = this.dpr || 1;

    for (const npc of traffic.npcs) {
      if (!npc.active) continue;
      const dx = (npc.x - player.x) * s;
      const dz = (npc.z - player.z) * s;
      // rotate by heading, then flip Z so forward is up
      const rx = dx * cos - dz * sin;
      const rz = dx * sin + dz * cos;
      const px = cx + rx;
      const py = cy - rz;
      if (Math.hypot(px - cx, py - cy) > Math.max(2, Math.min(ctx.canvas.width, ctx.canvas.height) / 2 - 4)) continue;

      let col = 'rgba(150,165,175,0.75)';
      let r = 2.2;
      // Iterate the Map directly; spreading it allocated ~40 arrays a frame.
      let hasEvidence = false;
      for (const rec of npc.evidence.values()) {
        if ((rec?.lvl ?? 0) >= EVIDENCE.OBSERVED) { hasEvidence = true; break; }
      }
      if (npc.pullState === 'stopped' || npc.pullState === 'yielding') { col = '#4fd0ff'; r = 3.4; }
      else if (npc.pullState === 'fleeing') { col = '#e0554a'; r = 3.4; }
      else if (hasEvidence) { col = '#e8873a'; r = 3.0; }
      else if (npc.activeViolations.size > 0 && npc.scanned) { col = '#e8c15a'; r = 2.6; }
      if (npc.kind === 'ebike') r *= 0.8;

      ctx.fillStyle = col;
      ctx.beginPath();
      ctx.arc(px, py, r * dpr, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}

/* ------------------------------------------------------------- full map */

export class BigMap {
  constructor(world, canvas) {
    this.world = world;
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
  }

  /* The static layer — areas, buildings, roads, boundary, labels — never
     changes, so it is rasterised ONCE into an offscreen canvas and blitted.
     Previously draw() reassigned canvas.width every frame (which reallocates
     and clears the backing store, defeating any cache) and then re-drew 6,303
     building rects, 1,532 roads across six rank passes, the boundary and every
     arterial label — every frame that Tab was held. */
  _buildStatic(W, H, dpr) {
    const off = document.createElement('canvas');
    off.width = W; off.height = H;
    const ctx = off.getContext('2d');
    const world = this.world;
    const s = Math.min(W / world.tW, H / world.tH) * 0.94;
    const ox = W / 2, oy = H / 2;

    ctx.fillStyle = '#14181b';
    ctx.fillRect(0, 0, W, H);
    ctx.save();
    ctx.translate(ox, oy);
    ctx.scale(s, s);

    for (const a of world.areas) {
      ctx.fillStyle = a.k === 'water' ? '#22384a'
        : (a.k === 'park' || a.k === 'grass' || a.k === 'pitch') ? '#24331d' : '#202224';
      ctx.beginPath();
      ctx.moveTo(a.r[0][0], a.r[0][1]);
      for (let i = 1; i < a.r.length; i++) ctx.lineTo(a.r[i][0], a.r[i][1]);
      ctx.closePath();
      ctx.fill();
    }

    ctx.fillStyle = 'rgba(120,128,136,0.30)';
    for (const b of world.buildingBounds) {
      if (b.parked) continue;
      ctx.fillRect(b.minX, b.minZ, b.maxX - b.minX, b.maxZ - b.minZ);
    }

    for (let rank = 1; rank <= 6; rank++) {
      const st = ROAD_STYLE[rank];
      ctx.strokeStyle = st.c;
      ctx.lineWidth = st.w / s * 1.15;
      ctx.lineCap = 'round';
      ctx.beginPath();
      for (const road of world.roads) {
        if (road.rk !== rank) continue;
        const p = road.p;
        ctx.moveTo(p[0][0], p[0][1]);
        for (let i = 1; i < p.length; i++) ctx.lineTo(p[i][0], p[i][1]);
      }
      ctx.stroke();
    }

    if (world.meta.boundary) {
      ctx.strokeStyle = 'rgba(79,208,255,0.55)';
      ctx.setLineDash([6 / s, 5 / s]);
      ctx.lineWidth = 2 / s;
      ctx.beginPath();
      const b = world.meta.boundary;
      ctx.moveTo(b[0][0], b[0][1]);
      for (let i = 1; i < b.length; i++) ctx.lineTo(b[i][0], b[i][1]);
      ctx.closePath();
      ctx.stroke();
      ctx.setLineDash([]);
    }
    ctx.restore();

    ctx.save();
    ctx.translate(ox, oy);
    ctx.fillStyle = 'rgba(215,228,236,0.72)';
    ctx.font = `${11 * dpr}px ui-monospace, monospace`;
    ctx.textAlign = 'center';
    const drawn = new Set();
    for (const road of world.roads) {
      if (road.rk < 3 || !road.n || drawn.has(road.n)) continue;
      const p = road.p[Math.floor(road.p.length / 2)];
      drawn.add(road.n);
      ctx.fillText(road.n, p[0] * s, p[1] * s);
    }
    ctx.restore();

    this._static = off;
    this._staticW = W; this._staticH = H;
    this._scale = s; this._ox = ox; this._oy = oy;
  }

  /* The static layer costs tens of milliseconds to draw. Building it lazily
     meant the very first Tab press paid for it as a visible hitch on a
     keypress. Warm it at load instead: the screen is laid out with
     visibility hidden just long enough to measure, which is the only way to
     learn its true size before it has ever been shown. No paint is committed
     inside a synchronous block, so nothing flashes. */
  prewarm() {
    const screen = this.canvas.parentElement;
    if (!screen) return false;
    const wasHidden = screen.classList.contains('hidden');
    const prevVis = screen.style.visibility;
    if (wasHidden) {
      screen.style.visibility = 'hidden';
      screen.classList.remove('hidden');
    }
    const r = this.canvas.getBoundingClientRect();   // forces layout, not paint
    if (wasHidden) {
      screen.classList.add('hidden');
      screen.style.visibility = prevVis;
    }
    const dpr = Math.min(devicePixelRatio || 1, 2);
    const W = Math.max(2, Math.round(r.width * dpr));
    const H = Math.max(2, Math.round(r.height * dpr));
    if (W <= 2 || H <= 2) return false;              // not laid out yet
    this.canvas.width = W;
    this.canvas.height = H;
    this._buildStatic(W, H, dpr);
    return true;
  }

  draw(player, traffic) {
    const c = this.canvas;
    const dpr = Math.min(devicePixelRatio || 1, 2);
    const r = c.getBoundingClientRect();
    const W = Math.max(2, Math.round(r.width * dpr));
    const H = Math.max(2, Math.round(r.height * dpr));
    // Only touch canvas.width when the size actually changed.
    if (c.width !== W || c.height !== H) { c.width = W; c.height = H; this._static = null; }
    if (!this._static || this._staticW !== W || this._staticH !== H) this._buildStatic(W, H, dpr);

    const ctx = this.ctx;
    const s = this._scale, ox = this._ox, oy = this._oy;
    ctx.drawImage(this._static, 0, 0);

    // Only the live layer is redrawn.
    ctx.save();
    ctx.translate(ox, oy);
    ctx.scale(s, s);
    for (const npc of traffic.npcs) {
      if (!npc.active) continue;
      ctx.fillStyle = npc.activeViolations.size ? '#e8873a' : 'rgba(150,165,175,0.6)';
      ctx.beginPath();
      ctx.arc(npc.x, npc.z, 5 / s, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.save();
    ctx.translate(player.x, player.z);
    /* North-up map: canvas +y is world +Z, and the arrow's apex is (0,-1).
       rotate(-h) maps the apex to (-sin h, -cos h) — the exact opposite of
       forward (sin h, cos h), so the map showed you driving the way you came. */
    ctx.rotate(Math.PI - player.heading);
    ctx.fillStyle = '#eef3f6';
    ctx.beginPath();
    ctx.moveTo(0, -14 / s);
    ctx.lineTo(9 / s, 11 / s);
    ctx.lineTo(0, 6 / s);
    ctx.lineTo(-9 / s, 11 / s);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
    ctx.restore();
  }
}
