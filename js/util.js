/* OpenScene — util.js
   Small shared helpers. Everything hangs off window.OS (no build step, classic scripts). */
(() => {
  'use strict';
  const OS = (window.OS = window.OS || {});

  let _uid = 0;
  const uid = (p = 'id') => `${p}_${Date.now().toString(36)}_${(_uid++).toString(36)}${Math.random().toString(36).slice(2, 6)}`;

  const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
  const round = (v) => (v < 0 ? -Math.round(-v) : Math.round(v));
  const lerp = (a, b, t) => a + (b - a) * t;
  const deepClone = (o) => (typeof structuredClone === 'function' ? structuredClone(o) : JSON.parse(JSON.stringify(o)));

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

  /* DOM helper: el('div.cls#id', {attrs}, [children|string]) */
  function el(spec, attrs, children) {
    const m = /^([a-zA-Z0-9-]+)?((?:[.#][\w-]+)*)$/.exec(spec) || [];
    const tag = m[1] || 'div';
    const node = document.createElement(tag);
    const rest = m[2] || '';
    rest.replace(/([.#])([\w-]+)/g, (_, k, v) => (k === '#' ? (node.id = v) : node.classList.add(v)));
    if (attrs) {
      for (const [k, v] of Object.entries(attrs)) {
        if (v == null) continue;
        if (k === 'style' && typeof v === 'object') Object.assign(node.style, v);
        else if (k === 'dataset') Object.assign(node.dataset, v);
        else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2).toLowerCase(), v);
        else if (k === 'html') node.innerHTML = v;
        else if (k === 'text') node.textContent = v;
        else if (k === 'value') node.value = v;
        else if (k === 'checked' || k === 'disabled' || k === 'selected' || k === 'multiple') { if (v) node.setAttribute(k, ''); node[k] = !!v; }
        else node.setAttribute(k, v);
      }
    }
    if (children != null) {
      for (const c of Array.isArray(children) ? children : [children]) {
        if (c == null) continue;
        node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
      }
    }
    return node;
  }

  const on = (target, type, fn, opts) => { target.addEventListener(type, fn, opts); return () => target.removeEventListener(type, fn, opts); };

  /* Touch / pen tap detection. Fires only for non-mouse pointers and stays
     quiet when the finger scrolls or drags, so lists can offer "tap to apply"
     on phones while the desktop keeps its double-click behaviour. */
  function onTap(target, fn) {
    let id = null, sx = 0, sy = 0, moved = false;
    on(target, 'pointerdown', (e) => {
      if (e.pointerType === 'mouse') return;
      id = e.pointerId; sx = e.clientX; sy = e.clientY; moved = false;
    });
    on(target, 'pointermove', (e) => {
      if (id == null || e.pointerId !== id) return;
      if (Math.abs(e.clientX - sx) > 12 || Math.abs(e.clientY - sy) > 12) moved = true;
    });
    on(target, 'pointerup', (e) => {
      if (id == null || e.pointerId !== id) return;
      id = null;
      if (!moved) fn(e);
    });
    on(target, 'pointercancel', (e) => { if (id != null && e.pointerId === id) id = null; });
  }

  /* The "open / apply" gesture for list items: double-click on a mouse, single
     tap on touch, coalesced so a quick double-tap on a phone still counts once.
     Both paths are mutually suppressed, so nothing ever fires twice. */
  function onActivate(target, fn) {
    let lastTouch = 0, timer = 0;
    on(target, 'pointerdown', (e) => { if (e.pointerType !== 'mouse') lastTouch = Date.now(); });
    on(target, 'dblclick', (e) => { if (Date.now() - lastTouch < 900) return; fn(e); });
    onTap(target, () => {
      clearTimeout(timer);
      timer = setTimeout(fn, 250);
    });
  }

  /* Platform sniffing used to pick touch-sized layout and file delivery. */
  const ua = () => (typeof navigator !== 'undefined' ? navigator.userAgent || '' : '');
  const isIOS = () => /iPad|iPhone|iPod/.test(ua()) || (/Macintosh/.test(ua()) && (navigator.maxTouchPoints || 0) > 1);
  const isAndroid = () => /Android/i.test(ua());
  const hasTouch = () => (typeof navigator !== 'undefined' && (navigator.maxTouchPoints || 0) > 0);
  const coarse = () => (typeof window !== 'undefined' && window.matchMedia ? window.matchMedia('(pointer: coarse)').matches : false);
  const isTouch = () => hasTouch() && coarse();

  function debounce(fn, ms) {
    let t = 0;
    const d = (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
    d.cancel = () => clearTimeout(t);
    return d;
  }
  function throttle(fn, ms) {
    let last = 0, t = 0, lastArgs = null;
    return (...a) => {
      lastArgs = a;
      const now = performance.now();
      if (now - last >= ms) { last = now; fn(...a); }
      else if (!t) {
        t = setTimeout(() => { t = 0; last = performance.now(); fn(...lastArgs); }, ms - (now - last));
      }
    };
  }

  class Emitter {
    constructor() { this._m = new Map(); }
    on(ev, fn) { (this._m.get(ev) || this._m.set(ev, new Set()).get(ev)).add(fn); return () => this.off(ev, fn); }
    off(ev, fn) { this._m.get(ev)?.delete(fn); }
    emit(ev, ...a) { const s = this._m.get(ev); if (s) for (const fn of [...s]) { try { fn(...a); } catch (e) { console.error(`[OS:${ev}]`, e); } } }
  }

  function fmtBytes(n) {
    if (!Number.isFinite(n)) return '-';
    const u = ['B', 'KB', 'MB', 'GB', 'TB']; let i = 0;
    while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
    return `${n.toFixed(n >= 100 || i === 0 ? 0 : 1)} ${u[i]}`;
  }

  function fmtDur(sec) {
    if (!Number.isFinite(sec)) return '-:--';
    const s = Math.max(0, Math.floor(sec)), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = s % 60;
    return h ? `${h}:${String(m).padStart(2, '0')}:${String(ss).padStart(2, '0')}` : `${m}:${String(ss).padStart(2, '0')}`;
  }

  /* Median-ish FPS tracker for the stats overlay. */
  class FrameMeter {
    constructor() { this.fps = 0; this.ms = 0; this._hist = []; }
    tick(ms) {
      this.ms = this.ms ? this.ms * 0.9 + ms * 0.1 : ms;
      this._hist.push(performance.now());
      while (this._hist.length && this._hist[0] < performance.now() - 1000) this._hist.shift();
      this.fps = this._hist.length;
    }
  }

  /* A tiny promise gate used by seek/play synchronisation. */
  function deferred() {
    let resolve, reject;
    const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
    return { promise, resolve, reject };
  }

  function withTimeout(promise, ms, what = 'operation') {
    let t;
    const timeout = new Promise((_, rej) => { t = setTimeout(() => rej(new Error(`timeout: ${what}`)), ms); });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(t));
  }

  OS.util = { uid, clamp, round, lerp, deepClone, esc, el, on, onTap, onActivate, isIOS, isAndroid, hasTouch, coarse, isTouch, debounce, throttle, Emitter, fmtBytes, fmtDur, FrameMeter, deferred, withTimeout };
})();
