export class Input {
  constructor(canvas) {
    this.keys = new Set();
    this.pressed = new Set();     // edge-triggered, cleared each frame
    this.mouseDX = 0;
    this.mouseDY = 0;
    this.wheel = 0;
    this.locked = false;
    this.rightDown = false;
    this.canvas = canvas;

    addEventListener('keydown', (e) => {
      if (e.repeat) return;
      const k = e.code;
      if (['Tab', 'Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Slash'].includes(k)) e.preventDefault();
      this.keys.add(k);
      this.pressed.add(k);
    });
    addEventListener('keyup', (e) => this.keys.delete(e.code));
    addEventListener('blur', () => this.keys.clear());

    this.leftDown = false;
    this.leftHit = false;

    canvas.addEventListener('mousedown', (e) => {
      if (e.button === 2) this.rightDown = true;
      if (e.button === 0) {
        this.leftDown = true;
        this.leftHit = true;
        if (!this.locked) {
          try {
            const r = canvas.requestPointerLock();
            if (r && typeof r.catch === 'function') r.catch(() => {});
          } catch { /* mouse look unavailable here */ }
        }
      }
    });
    addEventListener('mouseup', (e) => {
      if (e.button === 2) this.rightDown = false;
      if (e.button === 0) this.leftDown = false;
    });
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());

    document.addEventListener('pointerlockchange', () => {
      this.locked = document.pointerLockElement === canvas;
    });
    addEventListener('mousemove', (e) => {
      if (!this.locked) return;
      this.mouseDX += e.movementX;
      this.mouseDY += e.movementY;
    });
    addEventListener('wheel', (e) => { this.wheel += e.deltaY; }, { passive: true });
  }

  down(code) { return this.keys.has(code); }
  hit(code) { return this.pressed.has(code); }
  axis(neg, pos) { return (this.down(pos) ? 1 : 0) - (this.down(neg) ? 1 : 0); }

  /** Seconds a key has been held, 0 if up. Used for tap-vs-hold actions. */
  held(code) { return this._held?.get(code) || 0; }

  tick(dt) {
    if (!this._held) { this._held = new Map(); this._prevHeld = new Map(); }
    for (const k of this.keys) this._held.set(k, (this._held.get(k) || 0) + dt);
    // Delete in place. Spreading the keys allocated an array every frame.
    for (const k of this._held.keys()) if (!this.keys.has(k)) this._held.delete(k);
  }

  /** True on the frame a held key is released, if it was held under `maxHold`. */
  releasedShort(code, maxHold = 0.4) {
    const was = this._prevHeld?.get(code);
    if (was === undefined) return false;
    return !this.keys.has(code) && was > 0 && was < maxHold;
  }

  endFrame() {
    // Reuse the map rather than constructing a fresh one each frame.
    if (!this._prevHeld) this._prevHeld = new Map();
    this._prevHeld.clear();
    if (this._held) for (const [k, v] of this._held) this._prevHeld.set(k, v);
    this.pressed.clear();
    this.leftHit = false;
    this.mouseDX = 0;
    this.mouseDY = 0;
    this.wheel = 0;
  }
}
