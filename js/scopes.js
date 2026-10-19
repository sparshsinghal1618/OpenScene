/* OpenScene — scopes.js
   Broadcast-style video scopes: RGB histogram, luma waveform, RGB parade and a
   vectorscope. Everything is computed from the live preview canvas, so the
   reading always matches exactly what the compositor is putting on screen —
   blend modes, adjustment layers, effects and all.

   No dependencies: the analysis is plain arithmetic over Uint8ClampedArray, and
   the displays are painted into offscreen canvases then scaled up. */
(() => {
  'use strict';
  const OS = (window.OS = window.OS || {});
  const { el, on, clamp } = OS.util;

  const MODES = [
    ['histogram', 'Histogram'],
    ['waveform', 'Waveform'],
    ['parade', 'RGB Parade'],
    ['vectorscope', 'Vectorscope'],
  ];

  const SAMPLE_W = 360;      // analysis grid
  const SAMPLE_H = 203;

  /* Rec. 709 luma from 0..255 bytes. */
  const luma = (r, g, b) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

  /* A local canvas we own, so getImageData never fights the preview's backing store. */
  function sampler() {
    const c = document.createElement('canvas');
    c.width = SAMPLE_W; c.height = SAMPLE_H;
    return { canvas: c, ctx: c.getContext('2d', { willReadFrequently: true }) };
  }

  class Scopes {
    constructor(app) {
      this.app = app;
      this.open = false;
      this.mode = 'histogram';
      this.root = null;
      this._timer = null;
      this._sampler = sampler();
      this._stats = { ok: false, message: 'No preview' };
    }

    /* ---------------- window ---------------- */

    toggle() { this.open ? this.hide() : this.show(); }

    show() {
      if (!this.root) this._build();
      this.root.hidden = false;
      this.open = true;
      this._layout();
      if (!this._timer) this._timer = setInterval(() => this.refresh(), 130);
      this.refresh();
    }

    hide() {
      this.open = false;
      if (this.root) this.root.hidden = true;
      if (this._timer) { clearInterval(this._timer); this._timer = null; }
    }

    _build() {
      const root = el('div.scopes-window', { hidden: 'hidden' });
      const head = el('div.scopes-head');
      const title = el('span.scopes-title', { text: 'Scopes' });
      const tabs = el('div.scopes-modes');
      this._modeButtons = new Map();
      for (const [id, label] of MODES) {
        const b = el('button.scopes-mode', { text: label, type: 'button' });
        on(b, 'click', () => { this.mode = id; this._syncModes(); this.refresh(); });
        this._modeButtons.set(id, b);
        tabs.appendChild(b);
      }
      const close = el('button.scopes-close', { text: '\u00d7', title: 'Close scopes', type: 'button' });
      on(close, 'click', () => this.hide());
      head.append(title, tabs, close);

      this.canvas = el('canvas.scopes-canvas', { width: 420, height: 264 });
      this.ctx = this.canvas.getContext('2d');
      this.readout = el('div.scopes-readout');
      const foot = el('div.scopes-foot');
      const pin = el('button.scopes-pin', { text: 'Freeze', title: 'Stop updating so you can read a frame', type: 'button' });
      on(pin, 'click', () => {
        this.frozen = !this.frozen;
        pin.textContent = this.frozen ? 'Resume' : 'Freeze';
        pin.classList.toggle('on', this.frozen);
      });
      const copy = el('button.scopes-pin', { text: 'Copy reading', title: 'Copy the numeric readout', type: 'button' });
      on(copy, 'click', () => {
        const txt = this.readout.textContent || '';
        if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(txt).catch(() => {});
        this.app.setStatus('Scope reading copied');
      });
      foot.append(pin, copy);
      root.append(head, this.canvas, this.readout, foot);
      document.body.appendChild(root);
      this.root = root;
      this._syncModes();
      this._makeDraggable(head);
    }

    _syncModes() {
      for (const [id, b] of this._modeButtons) b.classList.toggle('on', id === this.mode);
    }

    _layout() {
      // Park it over the preview's lower-right, but always inside the viewport.
      const r = this.root.getBoundingClientRect();
      if (this._placed) return;
      this._placed = true;
      const w = r.width || 440, h = r.height || 400;
      this.root.style.left = Math.max(8, Math.round(window.innerWidth - w - 30)) + 'px';
      this.root.style.top = Math.max(8, Math.round(window.innerHeight - h - 60)) + 'px';
    }

    _makeDraggable(handle) {
      let sx = 0, sy = 0, ox = 0, oy = 0, dragging = false;
      on(handle, 'pointerdown', (e) => {
        if (e.target.closest('button')) return;
        dragging = true; sx = e.clientX; sy = e.clientY;
        const r = this.root.getBoundingClientRect(); ox = r.left; oy = r.top;
        handle.setPointerCapture && handle.setPointerCapture(e.pointerId);
      });
      on(handle, 'pointermove', (e) => {
        if (!dragging) return;
        this.root.style.left = Math.max(0, ox + e.clientX - sx) + 'px';
        this.root.style.top = Math.max(0, oy + e.clientY - sy) + 'px';
      });
      on(handle, 'pointerup', () => { dragging = false; });
      on(handle, 'pointercancel', () => { dragging = false; });
    }

    /* ---------------- analysis ---------------- */

    /* Grab the current preview frame as a small RGBA grid. */
    sample() {
      const player = this.app && this.app.player;
      const src = player && player.canvas;
      if (!src || !src.width || !src.height) return null;
      const s = this._sampler;
      s.ctx.setTransform(1, 0, 0, 1, 0, 0);
      s.ctx.clearRect(0, 0, SAMPLE_W, SAMPLE_H);
      s.ctx.imageSmoothingEnabled = true;
      s.ctx.drawImage(src, 0, 0, src.width, src.height, 0, 0, SAMPLE_W, SAMPLE_H);
      try { return s.ctx.getImageData(0, 0, SAMPLE_W, SAMPLE_H); } catch (_) { return null; }
    }

    refresh() {
      if (!this.open || this.frozen) return;
      const img = this.sample();
      if (!img) {
        this._stats = { ok: false, message: 'No preview available' };
        this._drawEmpty();
        return;
      }
      const t0 = (performance && performance.now) ? performance.now() : 0;
      const stats = this._analyze(img.data);
      this._stats = stats;
      this._paint(img.data, stats);
      const ms = t0 ? (performance.now() - t0).toFixed(1) : '';
      this.readout.textContent = this._readout(stats) + (ms ? '   (' + ms + ' ms)' : '');
    }

    _analyze(data) {
      const n = SAMPLE_W * SAMPLE_H;
      const hist = { r: new Uint32Array(256), g: new Uint32Array(256), b: new Uint32Array(256), y: new Uint32Array(256) };
      let sumY = 0, minY = 255, maxY = 0, clip = 0, black = 0;
      let sr = 0, sg = 0, sb = 0;
      for (let i = 0, p = 0; i < n; i++, p += 4) {
        const r = data[p], g = data[p + 1], b = data[p + 2];
        const y = clamp(Math.round(luma(r, g, b)), 0, 255);
        hist.r[r]++; hist.g[g]++; hist.b[b]++; hist.y[y]++;
        sumY += y; if (y < minY) minY = y; if (y > maxY) maxY = y;
        if (r > 250 || g > 250 || b > 250) clip++;
        if (r < 5 && g < 5 && b < 5) black++;
        sr += r; sg += g; sb += b;
      }
      // Wavescope trails luma through the frame's *spatial* extent, so we also
      // build the per-column distributions the waveform views need.
      return {
        ok: true,
        hist,
        minY, maxY,
        avgY: sumY / n,
        avgR: sr / n, avgG: sg / n, avgB: sb / n,
        clip, black, count: n,
        levels: { r: this._range(hist.r), g: this._range(hist.g), b: this._range(hist.b) },
      };
    }

    _range(hist) {
      let lo = -1, hi = -1;
      for (let i = 0; i < 256; i++) if (hist[i]) { if (lo < 0) lo = i; hi = i; }
      return { lo: lo < 0 ? 0 : lo, hi: hi < 0 ? 0 : hi };
    }

    _readout(s) {
      const y = (v) => v.toFixed(1).padStart(5);
      const parts = [
        'luma avg ' + y(s.avgY) + '  min ' + String(s.minY).padStart(3) + '  max ' + String(s.maxY).padStart(3),
        'RGB avg ' + [s.avgR, s.avgG, s.avgB].map((v) => v.toFixed(0).padStart(3)).join('/'),
        'levels R ' + s.levels.r.lo + '-' + s.levels.r.hi + '  G ' + s.levels.g.lo + '-' + s.levels.g.hi + '  B ' + s.levels.b.lo + '-' + s.levels.b.hi,
        'clipped ' + ((s.clip / s.count) * 100).toFixed(2) + '%   crushed ' + ((s.black / s.count) * 100).toFixed(2) + '%',
      ];
      return parts.join('   |   ');
    }

    /* ---------------- drawing ---------------- */

    _drawEmpty() {
      const ctx = this.ctx, W = this.canvas.width, H = this.canvas.height;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, W, H);
      ctx.fillStyle = '#0b0d11';
      ctx.fillRect(0, 0, W, H);
      ctx.fillStyle = '#566072';
      ctx.font = '13px "Segoe UI", sans-serif';
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(this._stats.message || 'No preview', W / 2, H / 2);
      ctx.textAlign = 'start';
      this.readout.textContent = this._stats.message || '';
    }

    _paint(data, s) {
      const ctx = this.ctx, W = this.canvas.width, H = this.canvas.height;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, W, H);
      ctx.fillStyle = '#0b0d11';
      ctx.fillRect(0, 0, W, H);
      this._grid(ctx, W, H);
      switch (this.mode) {
        case 'histogram': this._histogram(ctx, W, H, s); break;
        case 'waveform': this._waveform(ctx, W, H, data, 'y'); break;
        case 'parade': this._parade(ctx, W, H, data); break;
        case 'vectorscope': this._vectorscope(ctx, W, H, data); break;
      }
    }

    _grid(ctx, W, H) {
      ctx.strokeStyle = 'rgba(255,255,255,0.055)';
      ctx.lineWidth = 1;
      for (let i = 1; i < 4; i++) {
        const y = Math.round((H / 4) * i) + 0.5;
        ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke();
      }
      for (let i = 1; i < 4; i++) {
        const x = Math.round((W / 4) * i) + 0.5;
        ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke();
      }
    }

    _histogram(ctx, W, H, s) {
      let max = 1;
      for (let i = 0; i < 256; i++) {
        max = Math.max(max, s.hist.r[i], s.hist.g[i], s.hist.b[i]);
      }
      const draw = (hist, color) => {
        ctx.beginPath();
        ctx.moveTo(0, H);
        for (let i = 0; i < 256; i++) {
          const v = Math.pow(hist[i] / max, 0.42);
          ctx.lineTo((i / 255) * W, H - v * (H - 6) - 3);
        }
        ctx.lineTo(W, H);
        ctx.closePath();
        ctx.fillStyle = color;
        ctx.fill();
      };
      ctx.globalCompositeOperation = 'lighter';
      draw(s.hist.r, 'rgba(255,64,64,0.62)');
      draw(s.hist.g, 'rgba(64,255,96,0.55)');
      draw(s.hist.b, 'rgba(72,128,255,0.66)');
      ctx.globalCompositeOperation = 'source-over';
      // luma as a hairline on top so it stays legible over the additive channels
      ctx.beginPath();
      for (let i = 0; i < 256; i++) {
        const v = Math.pow(s.hist.y[i] / max, 0.42);
        const x = (i / 255) * W, y = H - v * (H - 6) - 3;
        i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
      }
      ctx.strokeStyle = 'rgba(240,246,255,0.55)';
      ctx.lineWidth = 1;
      ctx.stroke();
    }

    /* Shared waveform renderer. channel: 'y' | 'r' | 'g' | 'b' */
    _waveGrid(data, channel) {
      const cols = SAMPLE_W, rows = 256;
      const grid = new Float32Array(cols * rows);
      for (let y = 0; y < SAMPLE_H; y++) {
        for (let x = 0; x < cols; x++) {
          const p = (y * SAMPLE_W + x) * 4;
          const v = channel === 'y' ? luma(data[p], data[p + 1], data[p + 2])
            : channel === 'r' ? data[p] : channel === 'g' ? data[p + 1] : data[p + 2];
          const row = rows - 1 - clamp(Math.round(v), 0, rows - 1);
          grid[row * cols + x] += 1;
        }
      }
      return grid;
    }

    _waveImage(grid, color) {
      const cols = SAMPLE_W, rows = 256;
      const c = document.createElement('canvas');
      c.width = cols; c.height = rows;
      const g = c.getContext('2d');
      const img = g.createImageData(cols, rows);
      let max = 1;
      for (let i = 0; i < grid.length; i++) if (grid[i] > max) max = grid[i];
      // a true trace should saturate: anything with a handful of hits is bright
      const norm = 1 / Math.max(1, max * 0.16);
      for (let i = 0; i < grid.length; i++) {
        const t = clamp(grid[i] * norm, 0, 1);
        const p = i * 4;
        if (t <= 0) { img.data[p + 3] = 0; continue; }
        const a = Math.pow(t, 0.62);
        img.data[p] = color[0];
        img.data[p + 1] = color[1];
        img.data[p + 2] = color[2];
        img.data[p + 3] = Math.round(a * 255);
      }
      g.putImageData(img, 0, 0);
      return c;
    }

    _waveform(ctx, W, H, data, channel) {
      const img = this._waveImage(this._waveGrid(data, channel), [120, 226, 168]);
      ctx.imageSmoothingEnabled = true;
      ctx.drawImage(img, 0, 0, W, H);
      this._levelLabels(ctx, W, H);
    }

    _parade(ctx, W, H, data) {
      const pad = 6;
      const pw = (W - pad * 2) / 3;
      const channels = [['r', [255, 96, 96]], ['g', [96, 255, 128]], ['b', [110, 150, 255]]];
      channels.forEach(([ch, color], i) => {
        const x = pad + i * (pw + 0) + i * 0;
        const img = this._waveImage(this._waveGrid(data, ch), color);
        ctx.save();
        ctx.beginPath(); ctx.rect(Math.round(x), 0, Math.round(pw), H); ctx.clip();
        ctx.imageSmoothingEnabled = true;
        ctx.drawImage(img, Math.round(x), 0, Math.round(pw), H);
        ctx.restore();
        ctx.strokeStyle = 'rgba(255,255,255,0.10)';
        ctx.beginPath(); ctx.moveTo(Math.round(x + pw) + 0.5, 0); ctx.lineTo(Math.round(x + pw) + 0.5, H); ctx.stroke();
      });
      this._levelLabels(ctx, W, H);
    }

    _levelLabels(ctx, W, H) {
      ctx.fillStyle = 'rgba(200,212,230,0.5)';
      ctx.font = '9px "Segoe UI", sans-serif';
      ctx.textBaseline = 'top';
      ctx.fillText('100', 3, 2);
      ctx.fillText('0', 3, H - 11);
      ctx.textBaseline = 'alphabetic';
    }

    _vectorscope(ctx, W, H, data) {
      const size = Math.min(W, H) - 8;
      const cx = W / 2, cy = H / 2;
      const r = size / 2;
      const grid = new Float32Array(size * size);
      const scale = r / 0.72;                    // 100% saturation sits near the rim

      for (let i = 0, p = 0; i < SAMPLE_W * SAMPLE_H; i++, p += 4) {
        const R = data[p] / 255, G = data[p + 1] / 255, B = data[p + 2] / 255;
        const cb = -0.168736 * R - 0.331264 * G + 0.5 * B;
        const cr = 0.5 * R - 0.418688 * G - 0.081312 * B;
        const x = Math.round(cx + cb * scale);
        const y = Math.round(cy - cr * scale);
        if (x < 0 || y < 0 || x >= size || y >= size) continue;
        grid[y * size + x] += 1;
      }

      const c = document.createElement('canvas');
      c.width = size; c.height = size;
      const g = c.getContext('2d');
      const img = g.createImageData(size, size);
      let max = 1;
      for (let i = 0; i < grid.length; i++) if (grid[i] > max) max = grid[i];
      const norm = 1 / Math.max(1, max * 0.12);
      for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
          const i = y * size + x;
          const t = clamp(grid[i] * norm, 0, 1);
          if (t <= 0) continue;
          const cb = (x - cx) / scale, cr = (cy - y) / scale;
          // reconstruct the colour that lands on this spot (Y held mid-grey)
          const Y = 0.5;
          const R = Y + 1.5748 * cr;
          const G = Y - 0.1873 * cb - 0.4681 * cr;
          const Bc = Y + 1.8556 * cb;
          const p = i * 4;
          img.data[p] = clamp(R * 255, 0, 255);
          img.data[p + 1] = clamp(G * 255, 0, 255);
          img.data[p + 2] = clamp(Bc * 255, 0, 255);
          img.data[p + 3] = Math.round(Math.pow(t, 0.6) * 255);
        }
      }
      g.putImageData(img, 0, 0);

      // graticule
      ctx.save();
      ctx.strokeStyle = 'rgba(255,255,255,0.12)';
      ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.stroke();
      ctx.beginPath(); ctx.arc(cx, cy, r * 0.5, 0, Math.PI * 2); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(cx - r, cy); ctx.lineTo(cx + r, cy); ctx.moveTo(cx, cy - r); ctx.lineTo(cx, cy + r); ctx.stroke();

      // 75% colour bar targets (Rec.709)
      const targets = [
        ['R', [0.75, 0, 0]], ['G', [0, 0.75, 0]], ['B', [0, 0, 0.75]],
        ['Cy', [0, 0.75, 0.75]], ['Mg', [0.75, 0, 0.75]], ['Yl', [0.75, 0.75, 0]],
      ];
      ctx.font = '9px "Segoe UI", sans-serif';
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      for (const [name, [R, G, B]] of targets) {
        const cb = -0.168736 * R - 0.331264 * G + 0.5 * B;
        const cr = 0.5 * R - 0.418688 * G - 0.081312 * B;
        const x = cx + cb * scale, y = cy - cr * scale;
        ctx.strokeStyle = 'rgba(255,255,255,0.30)';
        ctx.strokeRect(x - 6, y - 6, 12, 12);
        ctx.fillStyle = 'rgba(220,230,245,0.55)';
        ctx.fillText(name, x, y);
      }
      ctx.restore();

      ctx.imageSmoothingEnabled = true;
      ctx.globalCompositeOperation = 'lighter';
      ctx.drawImage(c, cx - size / 2, cy - size / 2);
      ctx.globalCompositeOperation = 'source-over';
      ctx.textAlign = 'start';
      ctx.textBaseline = 'alphabetic';
    }

    dispose() {
      this.hide();
      if (this.root && this.root.parentNode) this.root.parentNode.removeChild(this.root);
      this.root = null;
    }
  }

  OS.scopes = { Scopes, MODES, luma, SAMPLE_W, SAMPLE_H };
})();
