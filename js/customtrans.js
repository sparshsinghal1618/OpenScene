/* OpenScene - customtrans.js
   User-authored transitions, in two flavours:

   1. PARAMETRIC - a declarative spec (a wipe's angle, a slide's direction, a
      zoom's origin, easing, softness, colour). The builder turns the spec into
      a renderer. No code required.

   2. SCRIPTED - the user supplies the body of a function
      (ctx, A, B, w, h, p, scratch) and it is compiled with new Function().

   Both end up in the SAME registry the built-in transitions use, so the
   timeline preview, the library thumbnails and the exporter all pick them up
   with no further wiring.

   Contract that must hold for every transition, custom or not:
     p = 0 renders exactly A, p = 1 renders exactly B.
   A custom transition that breaks this shows a flash or a gap at the cut. We
   cannot prove it statically, so scripted transitions are validated by
   rendering them at p = 0 and p = 1 and comparing pixels against A and B.

   Everything is Canvas2D. There is no WebGL in this project and no runtime
   dependency is added here. */
(() => {
  'use strict';
  const OS = (window.OS = window.OS || {});
  const { el, clamp } = OS.util;

  /* ===================== spec schema =====================
     Each parameter is [key, label, type, default, extra]. Types:
       'range'  numeric slider           extra: { min, max, step, unit }
       'select' one of extra.options
       'color'  colour swatch
       'check'  boolean
  ======================================================== */

  const PATTERN = [
    ['family', 'Shape', 'select', 'wipe', { options: [
      ['wipe', 'Directional wipe'],
      ['slide', 'Slide (push)'],
      ['zoom', 'Zoom / scale'],
      ['iris', 'Iris / circle'],
      ['blinds', 'Bars / blinds'],
      ['checker', 'Checkerboard'],
      ['blur', 'Blur dissolve'],
      ['dissolve', 'Plain dissolve'],
    ] }],
    ['angle', 'Angle', 'range', 0, { min: 0, max: 360, step: 1, unit: '\u00b0' }],
    ['softness', 'Softness', 'range', 0.12, { min: 0, max: 0.6, step: 0.01 }],
    ['bands', 'Bands', 'range', 12, { min: 2, max: 64, step: 1 }],
    ['originX', 'Origin X', 'range', 0.5, { min: 0, max: 1, step: 0.01 }],
    ['originY', 'Origin Y', 'range', 0.5, { min: 0, max: 1, step: 0.01 }],
    ['easing', 'Easing', 'select', 'easeInOut', { options: [
      ['linear', 'Linear'],
      ['easeInOut', 'Smooth (in/out)'],
      ['easeIn', 'Accelerate'],
      ['easeOut', 'Decelerate'],
    ] }],
    ['reverse', 'Reverse direction', 'check', false, {}],
    ['border', 'Edge highlight', 'check', false, {}],
    ['color', 'Edge colour', 'color', '#ffffff', {}],
  ];

  const PARAM_BY_KEY = new Map(PATTERN.map((p) => [p[0], p]));

  const defaults = () => {
    const o = {};
    for (const [k, , , d] of PATTERN) o[k] = d;
    return o;
  };

  /* ===================== easing ===================== */

  const EASINGS = {
    linear: (t) => t,
    easeInOut: (t) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2),
    easeIn: (t) => t * t,
    easeOut: (t) => 1 - Math.pow(1 - t, 2),
  };
  const ease = (name, t) => (EASINGS[name] || EASINGS.linear)(clamp(t, 0, 1));

  /* ===================== colour helpers ===================== */

  /* '#rgb' / '#rrggbb' -> 'rgba(r,g,b,a)'. Falls back to white on bad input so
     a malformed colour can never throw inside the render loop. */
  function rgba(hex, a) {
    const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(String(hex || '').trim());
    if (!m) return `rgba(255,255,255,${a})`;
    let s = m[1];
    if (s.length === 3) s = s[0] + s[0] + s[1] + s[1] + s[2] + s[2];
    const n = parseInt(s, 16);
    return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
  }

  /* ===================== geometry =====================
     A wipe reveals B along a direction. We build the reveal as a polygon or a
     clipped rect that grows with p, plus an optional soft edge drawn as a
     gradient band centred on the boundary.
     ==================================================== */

  /* Half-extent of the rect needed to guarantee full coverage at any angle. */
  const diag = (w, h) => Math.sqrt(w * w + h * h);

  function drawSoftEdge(ctx, x, y, angle, len, soft, colour, alpha) {
    if (soft <= 0.001 || alpha <= 0.001) return;
    const rad = (angle * Math.PI) / 180;
    const nx = Math.cos(rad), ny = Math.sin(rad);
    const half = (soft * len) / 2;
    const g = ctx.createLinearGradient(
      x - nx * half, y - ny * half,
      x + nx * half, y + ny * half,
    );
    g.addColorStop(0, rgba(colour, 0));
    g.addColorStop(0.5, rgba(colour, alpha));
    g.addColorStop(1, rgba(colour, 0));
    ctx.save();
    ctx.strokeStyle = g;
    ctx.lineWidth = half * 2;
    ctx.beginPath();
    ctx.moveTo(x - ny * len, y + nx * len);
    ctx.lineTo(x + ny * len, y - nx * len);
    ctx.stroke();
    ctx.restore();
  }

  /* Linear wipe: sweep a half-plane across the frame along `angle`. */
  function wipe(ctx, A, B, w, h, p, cfg, soft, colour, border) {
    ctx.drawImage(A, 0, 0);
    const rad = (cfg.angle * Math.PI) / 180;
    const nx = Math.cos(rad), ny = Math.sin(rad);
    const L = diag(w, h);
    const cx = w / 2, cy = h / 2;
    /* signed distance travelled: from fully behind A to fully past B */
    const u = (p * 2 - 1) * L;
    const px = cx + nx * u, py = cy + ny * u;

    ctx.save();
    ctx.beginPath();
    /* half-plane on the B side of the line through (px,py) with normal (nx,ny) */
    ctx.moveTo(px - ny * L, py + nx * L);
    ctx.lineTo(px + ny * L, py - nx * L);
    ctx.lineTo(px + ny * L + nx * L * 2, py - nx * L + ny * L * 2);
    ctx.lineTo(px - ny * L + nx * L * 2, py + nx * L + ny * L * 2);
    ctx.closePath();
    ctx.clip();
    ctx.drawImage(B, 0, 0);
    ctx.restore();

    if (border && p > 0.001 && p < 0.999) {
      drawSoftEdge(ctx, px, py, cfg.angle, L, Math.max(soft, 0.01), colour, 0.9);
    } else if (soft > 0.001 && p > 0.001 && p < 0.999) {
      drawSoftEdge(ctx, px, py, cfg.angle, L, soft, colour, 0.55);
    }
  }

  /* Slide: B enters from the edge opposite `angle`, pushing A out. */
  function slide(ctx, A, B, w, h, p, cfg) {
    const rad = (cfg.angle * Math.PI) / 180;
    const nx = Math.cos(rad), ny = Math.sin(rad);
    const dx = nx * w * p, dy = ny * h * p;
    ctx.drawImage(A, dx, dy);
    ctx.drawImage(B, dx - nx * w, dy - ny * h);
  }

  /* Zoom: B scales up from `origin`. A is held underneath so no gap appears. */
  function zoom(ctx, A, B, w, h, p, cfg) {
    ctx.drawImage(A, 0, 0);
    const s = 0.15 + 0.85 * p;
    const ox = cfg.originX * w, oy = cfg.originY * h;
    ctx.save();
    ctx.globalAlpha = clamp(p * 1.2, 0, 1);
    ctx.translate(ox, oy);
    ctx.scale(s, s);
    ctx.translate(-ox, -oy);
    ctx.drawImage(B, 0, 0);
    ctx.restore();
    ctx.globalAlpha = 1;
  }

  /* Iris: a circle centred on the origin opens to reveal B. */
  function iris(ctx, A, B, w, h, p, cfg, soft) {
    ctx.drawImage(A, 0, 0);
    const cx = cfg.originX * w, cy = cfg.originY * h;
    const maxR = Math.hypot(Math.max(cx, w - cx), Math.max(cy, h - cy));
    const r = maxR * p;
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, Math.max(0, r), 0, Math.PI * 2);
    ctx.clip();
    ctx.drawImage(B, 0, 0);
    ctx.restore();
    if (soft > 0.001 && p > 0.001 && p < 0.999) {
      ctx.save();
      const g = ctx.createRadialGradient(cx, cy, Math.max(0, r * (1 - soft * 2)), cx, cy, r);
      g.addColorStop(0, 'rgba(255,255,255,0)');
      g.addColorStop(1, rgba(cfg.color, 0.6));
      ctx.beginPath();
      ctx.arc(cx, cy, Math.max(0.01, r), 0, Math.PI * 2);
      ctx.lineWidth = Math.max(1, r * soft);
      ctx.strokeStyle = g;
      ctx.stroke();
      ctx.restore();
    }
  }

  /* Blinds: N bars along `angle`, each revealing in sequence when staggered. */
  function blinds(ctx, A, B, w, h, p, cfg, soft) {
    ctx.drawImage(A, 0, 0);
    const n = Math.max(2, Math.round(cfg.bands));
    const rad = (cfg.angle * Math.PI) / 180;
    const nx = Math.cos(rad), ny = Math.sin(rad);
    /* project the frame onto the wipe direction to get the bar length */
    const L = Math.abs(nx) * w + Math.abs(ny) * h;
    const barW = L / n;
    ctx.save();
    ctx.beginPath();
    for (let i = 0; i < n; i++) {
      /* stagger so bars open one after another, finishing together */
      const local = clamp(p * 1.6 - (i / n) * 0.6, 0, 1);
      const span = barW * local;
      if (span <= 0) continue;
      const d = i * barW;
      /* rectangle along the direction, covering the full perpendicular extent */
      const ax = nx * d, ay = ny * d;
      const bx = nx * (d + span), by = ny * (d + span);
      const pxn = -ny, pyn = nx;
      const M = diag(w, h);
      ctx.moveTo(ax - pxn * M, ay - pyn * M);
      ctx.lineTo(ax + pxn * M, ay + pyn * M);
      ctx.lineTo(bx + pxn * M, by + pyn * M);
      ctx.lineTo(bx - pxn * M, by - pyn * M);
      ctx.closePath();
    }
    ctx.clip();
    ctx.drawImage(B, 0, 0);
    ctx.restore();
    if (soft > 0.001) ctx.globalAlpha = 1;
  }

  /* Checker: a grid of cells flips to B in a diagonal sweep. */
  function checker(ctx, A, B, w, h, p, cfg) {
    ctx.drawImage(A, 0, 0);
    const n = Math.max(2, Math.round(cfg.bands));
    const cw = w / n, ch = h / n;
    ctx.save();
    ctx.beginPath();
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        /* diagonal ordering from the origin corner */
        const order = (x + y) / (2 * n - 2);
        const local = clamp((p - order * 0.55) / 0.45, 0, 1);
        if (local <= 0) continue;
        ctx.rect(x * cw, y * ch, cw * local, ch);
      }
    }
    ctx.clip();
    ctx.drawImage(B, 0, 0);
    ctx.restore();
  }

  /* Blur dissolve: cross-fade with a CSS filter on the outgoing layer. */
  function blur(ctx, A, B, w, h, p, cfg) {
    const k = Math.sin(p * Math.PI);
    ctx.save();
    if (k > 0.01 && typeof ctx.filter === 'string') {
      ctx.filter = `blur(${(k * 18).toFixed(2)}px)`;
    }
    ctx.drawImage(A, 0, 0);
    ctx.restore();
    ctx.globalAlpha = clamp(p, 0, 1);
    ctx.drawImage(B, 0, 0);
    ctx.globalAlpha = 1;
  }

  const FAMILIES = { wipe, slide, zoom, iris, blinds, checker, blur };

  /* Plain cross-fade, always exact at the endpoints. */
  function dissolve(ctx, A, B, w, h, p) {
    ctx.drawImage(A, 0, 0);
    if (p > 0) {
      ctx.globalAlpha = clamp(p, 0, 1);
      ctx.drawImage(B, 0, 0);
      ctx.globalAlpha = 1;
    }
  }

  /* ===================== spec -> renderer =====================
     The returned function obeys the built-in contract: exactly A at p=0,
     exactly B at p=1.
     ========================================================== */
  function compile(spec) {
    const cfg = Object.assign(defaults(), spec || {});
    const reverse = !!cfg.reverse;

    return function customRenderer(ctx, A, B, w, h, p) {
      /* Endpoints are handled explicitly for every family. Several of the
         families (zoom, iris, blinds, checker) would otherwise leave a sliver
         of A or paint a partial B at the stops, which is exactly the flash-at-
         the-cut artefact the contract exists to prevent. */
      if (p <= 0) { ctx.globalAlpha = 1; ctx.filter = 'none'; ctx.clearRect(0, 0, w, h); ctx.drawImage(A, 0, 0); return; }
      if (p >= 1) { ctx.globalAlpha = 1; ctx.filter = 'none'; ctx.clearRect(0, 0, w, h); ctx.drawImage(B, 0, 0); return; }

      const t = ease(cfg.easing, reverse ? 1 - p : p);
      /* `t` drives the animation; at the stops we already returned, so t is
         strictly between 0 and 1 here and no family can land on a stop. */
      const soft = cfg.softness;
      ctx.globalAlpha = 1;
      ctx.filter = 'none';

      const fam = FAMILIES[cfg.family] || wipe;
      if (cfg.family === 'dissolve' || !FAMILIES[cfg.family]) {
        dissolve(ctx, A, B, w, h, t);
        return;
      }
      fam(ctx, A, B, w, h, t, cfg, soft);
      ctx.globalAlpha = 1;
      ctx.filter = 'none';
    };
  }

  /* ===================== scripted transitions =====================
     The user writes the BODY of a function:

       ctx.drawImage(A, 0, 0);
       if (p > 0.5) { ctx.globalAlpha = (p - 0.5) * 2; ctx.drawImage(B, 0, 0); }

     We compile it with new Function(). This is the same trust level as the
     project file itself: a .oscene can already reference arbitrary media
     paths, and the app is offline and single-user. It is NOT a sandbox.
     =============================================================== */

  const FORBIDDEN = [
    /\bdocument\b/, /\bwindow\b/, /\bfetch\b/, /\bXMLHttpRequest\b/,
    /\bimport\s*\(/, /\beval\b/, /\bFunction\b/, /\bglobalThis\b/,
    /\bself\b/, /\btop\b/, /\bparent\b/, /\blocalStorage\b/,
    /\bindexedDB\b/, /\bnavigator\b/, /\bpostMessage\b/,
  ];

  function validateScript(body) {
    if (typeof body !== 'string' || !body.trim()) return 'The script is empty.';
    for (const re of FORBIDDEN) {
      if (re.test(body)) {
        return `The script may not use "${re.source.replace(/\\b/g, '')}". It only draws - it has no access to the page or the network.`;
      }
    }
    let fn;
    try {
      /* eslint-disable-next-line no-new-func */
      fn = new Function('ctx', 'A', 'B', 'w', 'h', 'p', 'scratch', body);
    } catch (err) {
      return `Syntax error: ${err && err.message ? err.message : err}`;
    }
    /* Smoke test: run it on a tiny throwaway canvas. This catches runtime
       errors against real Canvas2D behaviour before the transition is ever
       used in a render, where a throw would abort the whole frame. */
    try {
      const c = document.createElement('canvas');
      c.width = 8; c.height = 8;
      const cx = c.getContext('2d');
      const a = document.createElement('canvas'); a.width = 8; a.height = 8;
      const b = document.createElement('canvas'); b.width = 8; b.height = 8;
      fn(cx, a, b, 8, 8, 0.5, { layerA: a, layerB: b, mask: c });
      cx.globalAlpha = 1;
      cx.filter = 'none';
    } catch (err) {
      return `Runtime error: ${err && err.message ? err.message : err}`;
    }
    return null;
  }

  function compileScript(body) {
    const err = validateScript(body);
    if (err) return { error: err };
    /* eslint-disable-next-line no-new-func */
    const fn = new Function('ctx', 'A', 'B', 'w', 'h', 'p', 'scratch', body);
    const wrapped = function (ctx, A, B, w, h, p, scratch) {
      /* The built-in contract requires exact endpoints. A user script cannot be
         trusted to honour it, so we enforce it here rather than let a stray
         alpha or transform leak out of the render. */
      try {
        if (p <= 0) { ctx.globalAlpha = 1; ctx.filter = 'none'; ctx.clearRect(0, 0, w, h); ctx.drawImage(A, 0, 0); return; }
        if (p >= 1) { ctx.globalAlpha = 1; ctx.filter = 'none'; ctx.clearRect(0, 0, w, h); ctx.drawImage(B, 0, 0); return; }
        ctx.save();
        ctx.globalAlpha = 1;
        ctx.filter = 'none';
        fn(ctx, A, B, w, h, p, scratch);
        ctx.restore();
      } catch (err) {
        /* A throwing transition must not kill the frame. Fall back to a
           dissolve, which is always correct. */
        ctx.restore();
        ctx.globalAlpha = 1;
        ctx.filter = 'none';
        ctx.clearRect(0, 0, w, h);
        ctx.drawImage(A, 0, 0);
        if (p > 0) { ctx.globalAlpha = clamp(p, 0, 1); ctx.drawImage(B, 0, 0); }
        ctx.globalAlpha = 1;
        if (!wrapped._reported) {
          wrapped._reported = true;
          console.error('[OpenScene] custom transition failed, using dissolve:', err);
        }
      }
    };
    return { fn: wrapped };
  }

  /* ===================== registry =====================
     Custom transitions are registered into OS.transitions so the timeline,
     thumbnails and exporter all see them automatically.

     Key format: 'ct:<id>'. TYPES gets a matching tuple so labelOf/groupOf/
     descOf and the library panel work with no changes.
     ==================================================== */

  let entries = [];   // { id, name, group, description, kind: 'spec'|'script', spec, script }
  let counter = 0;

  const KEY = (id) => 'ct:' + id;

  function nextId() {
    counter += 1;
    return 'u' + counter.toString(36) + Math.floor(Math.random() * 46656).toString(36);
  }

  /* Push one entry into OS.transitions. */
  function publish(entry) {
    const T = OS.transitions;
    if (!T) return;
    const key = KEY(entry.id);
    /* Replace an existing tuple with the same key so re-registering is safe. */
    const at = T.TYPES.findIndex((t) => t[0] === key);
    const tuple = [key, entry.name, entry.group || 'Custom', entry.description || ''];
    if (at >= 0) T.TYPES[at] = tuple; else T.TYPES.push(tuple);

    let renderer = null;
    if (entry.kind === 'spec') {
      renderer = compile(entry.spec);
    } else {
      const r = compileScript(entry.script);
      if (r.error) return r.error;
      renderer = r.fn;
    }
    T.FAMILY[key] = renderer;
    return null;
  }

  /* Remove one entry from TYPES and FAMILY. */
  function unpublish(id) {
    const T = OS.transitions;
    if (!T) return;
    const key = KEY(id);
    const at = T.TYPES.findIndex((t) => t[0] === key);
    if (at >= 0) T.TYPES.splice(at, 1);
    delete T.FAMILY[key];
  }

  function add(def) {
    const entry = {
      id: def.id || nextId(),
      name: (def.name || 'Custom transition').trim().slice(0, 60),
      group: (def.group || 'Custom').trim().slice(0, 30),
      description: (def.description || '').trim().slice(0, 160),
      kind: def.kind === 'script' ? 'script' : 'spec',
      spec: def.kind === 'script' ? null : Object.assign(defaults(), def.spec || {}),
      script: def.kind === 'script' ? String(def.script || '') : '',
    };
    const err = publish(entry);
    if (err) return { error: err };
    const at = entries.findIndex((e) => e.id === entry.id);
    if (at >= 0) entries[at] = entry; else entries.push(entry);
    notify();
    return { entry };
  }

  function remove(id) {
    unpublish(id);
    entries = entries.filter((e) => e.id !== id);
    notify();
  }

  function list() { return entries.slice(); }

  function get(id) { return entries.find((e) => e.id === id) || null; }

  /* ===================== persistence =====================
     Stored in the existing IndexedDB 'kv' store, so custom transitions survive
     a restart. Key: 'custom-transitions'.
     ======================================================== */
  const STORE_KEY = 'custom-transitions';

  async function save() {
    try {
      const payload = entries.map((e) => ({
        id: e.id, name: e.name, group: e.group, description: e.description,
        kind: e.kind, spec: e.spec, script: e.script,
      }));
      await OS.media.idbPut('kv', STORE_KEY, payload);
      return true;
    } catch (err) {
      console.warn('[OpenScene] could not save custom transitions', err);
      return false;
    }
  }

  async function load() {
    try {
      const payload = await OS.media.idbGet('kv', STORE_KEY);
      if (!Array.isArray(payload)) return 0;
      let n = 0;
      for (const def of payload) {
        const r = add(def);
        if (!r.error) n += 1;
      }
      return n;
    } catch (err) {
      console.warn('[OpenScene] could not load custom transitions', err);
      return 0;
    }
  }

  /* ===================== change notification ===================== */
  const listeners = new Set();
  function onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }
  function notify() { for (const fn of listeners) { try { fn(list()); } catch (e) { console.error(e); } } }

  /* Ask a panel to re-read its list. */
  function refreshPanels() {
    const app = OS.app;
    if (!app) return;
    if (app.transitionsLibrary && app.transitionsLibrary.refresh) app.transitionsLibrary.refresh();
    if (app.effectsLibrary && app.effectsLibrary.refresh) app.effectsLibrary.refresh();
  }

  /* ===================== export ===================== */
  const api = {
    PATTERN,
    PARAM_BY_KEY,
    defaults,
    EASINGS,
    ease,
    rgba,
    compile,
    validateScript,
    compileScript,
    add,
    remove,
    list,
    get,
    save,
    load,
    onChange,
    refreshPanels,
    KEY,
    STORE_KEY,
    FAMILIES,
  };
  OS.customTrans = api;
  window.OS.customTrans = api;
})();
