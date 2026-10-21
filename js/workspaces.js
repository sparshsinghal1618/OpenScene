/* OpenScene - workspaces.js
   Layout presets. A workspace records which panels are visible, which dock tab
   is showing, and the panel sizes, so a whole arrangement can be recalled with
   one click or a key.

   Nothing here is a copy of another product's interface. The presets are named
   after the editing task they suit, and the geometry is OpenScene's own.

   Persistence uses the existing IndexedDB 'kv' store. The project has no
   localStorage usage at all, and this keeps that true. */
(() => {
  'use strict';
  const OS = (window.OS = window.OS || {});
  const { el } = OS.util;

  const STORE_KEY = 'workspaces';
  const ACTIVE_KEY = 'workspace-active';

  /* Geometry is written through CSS custom properties, which is how the
     splitters already drive layout:
       --bin-w    left dock width      (on #main)
       --props-w  inspector width      (on #main)
       --tl-h     timeline height      (on #app)
     plus the display state of #dockLeft and #propsPanel, and the dock tab. */
  const DEFAULTS = {
    binW: 268,
    propsW: 322,
    tlH: 300,
    dockLeft: true,
    propsPanel: true,
    dockTab: 'binPanel',
  };

  const LIMITS = {
    binW: [180, 640],
    propsW: [220, 720],
    tlH: [140, 900],
  };

  const clampNum = (v, [lo, hi], fallback) => {
    const n = Number(v);
    if (!isFinite(n)) return fallback;
    return Math.min(hi, Math.max(lo, Math.round(n)));
  };

  /* Built-in presets. These are starting points, not locks - the user can
     tweak any of them and save their own. */
  const BUILTIN = [
    {
      id: 'builtin:editing',
      name: 'Editing',
      description: 'Balanced. Library on the left, inspector on the right, tall timeline.',
      builtin: true,
      layout: Object.assign({}, DEFAULTS, { tlH: 340 }),
    },
    {
      id: 'builtin:assembly',
      name: 'Assembly',
      description: 'Maximum timeline. Panels narrow, both sides trimmed.',
      builtin: true,
      layout: Object.assign({}, DEFAULTS, { binW: 200, propsW: 240, tlH: 520 }),
    },
    {
      id: 'builtin:effects',
      name: 'Effects',
      description: 'Effects library open and wide, timeline shorter for the controls.',
      builtin: true,
      layout: Object.assign({}, DEFAULTS, { binW: 340, propsW: 360, tlH: 240, dockTab: 'effectsPanel' }),
    },
    {
      id: 'builtin:transitions',
      name: 'Transitions',
      description: 'Transitions library open and wide.',
      builtin: true,
      layout: Object.assign({}, DEFAULTS, { binW: 340, propsW: 300, tlH: 260, dockTab: 'transitionsPanel' }),
    },
    {
      id: 'builtin:colour',
      name: 'Colour',
      description: 'Large preview, inspector wide for effect controls, timeline short.',
      builtin: true,
      layout: Object.assign({}, DEFAULTS, { binW: 200, propsW: 420, tlH: 220 }),
    },
    {
      id: 'builtin:audio',
      name: 'Audio',
      description: 'Tall timeline for waveform work, inspector wide for the mixer.',
      builtin: true,
      layout: Object.assign({}, DEFAULTS, { binW: 220, propsW: 400, tlH: 480 }),
    },
    {
      id: 'builtin:fullpreview',
      name: 'Preview only',
      description: 'Both side panels hidden. Just the monitor and the timeline.',
      builtin: true,
      layout: Object.assign({}, DEFAULTS, { dockLeft: false, propsPanel: false, tlH: 220 }),
    },
  ];

  let userPresets = [];
  let activeId = null;

  const all = () => BUILTIN.concat(userPresets);

  const byId = (id) => all().find((w) => w.id === id) || null;

  /* ===================== applying ===================== */

  function readLayout(app) {
    const main = document.getElementById('main');
    const appEl = document.getElementById('app');
    const dockLeft = document.getElementById('dockLeft');
    const propsPanel = document.getElementById('propsPanel');
    const csMain = main ? getComputedStyle(main) : null;
    const csApp = appEl ? getComputedStyle(appEl) : null;
    const num = (v, fallback) => {
      const n = parseFloat(v);
      return isFinite(n) ? Math.round(n) : fallback;
    };
    return {
      binW: num(csMain && csMain.getPropertyValue('--bin-w'), DEFAULTS.binW),
      propsW: num(csMain && csMain.getPropertyValue('--props-w'), DEFAULTS.propsW),
      tlH: num(csApp && csApp.getPropertyValue('--tl-h'), DEFAULTS.tlH),
      dockLeft: !dockLeft || dockLeft.style.display !== 'none',
      propsPanel: !propsPanel || propsPanel.style.display !== 'none',
      dockTab: (app && app.dock && app.dock.active) || DEFAULTS.dockTab,
    };
  }

  function apply(layout, app) {
    const L = Object.assign({}, DEFAULTS, layout || {});
    const main = document.getElementById('main');
    const appEl = document.getElementById('app');
    const dockLeft = document.getElementById('dockLeft');
    const propsPanel = document.getElementById('propsPanel');

    if (main) {
      main.style.setProperty('--bin-w', clampNum(L.binW, LIMITS.binW, DEFAULTS.binW) + 'px');
      main.style.setProperty('--props-w', clampNum(L.propsW, LIMITS.propsW, DEFAULTS.propsW) + 'px');
    }
    if (appEl) {
      appEl.style.setProperty('--tl-h', clampNum(L.tlH, LIMITS.tlH, DEFAULTS.tlH) + 'px');
    }
    if (dockLeft) dockLeft.style.display = L.dockLeft ? '' : 'none';
    if (propsPanel) propsPanel.style.display = L.propsPanel ? '' : 'none';

    if (app && app.dock && L.dockTab) {
      /* Guard: only show a tab that still exists. A preset saved before a panel
         was renamed would otherwise leave the dock with nothing visible. */
      const known = app.dock.tabs.some((t) => t.dataset.dock === L.dockTab);
      if (known) app.dock.show(L.dockTab);
    }

    /* Splitters and the timeline cache their geometry, so they must be told. */
    if (app) {
      if (app.timeline && app.timeline.resize) app.timeline.resize();
      if (app.player && app.player.requestRender) app.player.requestRender();
    }
  }

  function activate(id, app) {
    const w = byId(id);
    if (!w) return false;
    apply(w.layout, app);
    activeId = id;
    saveActive();
    notify();
    if (app && app.setStatus) app.setStatus('Workspace: ' + w.name);
    return true;
  }

  /* ===================== user presets ===================== */

  function saveAs(name, app) {
    const trimmed = String(name || '').trim();
    if (!trimmed) return { error: 'Give the workspace a name.' };
    const layout = readLayout(app);
    const existing = userPresets.find((w) => w.name.toLowerCase() === trimmed.toLowerCase());
    if (existing) {
      existing.layout = layout;
      persist();
      notify();
      return { preset: existing, replaced: true };
    }
    const preset = {
      id: 'user:' + Date.now().toString(36) + Math.floor(Math.random() * 1296).toString(36),
      name: trimmed.slice(0, 40),
      description: 'Saved from the current layout.',
      builtin: false,
      layout,
    };
    userPresets.push(preset);
    activeId = preset.id;
    persist();
    saveActive();
    notify();
    return { preset };
  }

  function updateActive(app) {
    const w = byId(activeId);
    if (!w || w.builtin) return { error: 'Built-in workspaces cannot be overwritten. Save a new one instead.' };
    w.layout = readLayout(app);
    persist();
    notify();
    return { preset: w };
  }

  function remove(id) {
    const w = byId(id);
    if (!w) return false;
    if (w.builtin) return false;
    userPresets = userPresets.filter((p) => p.id !== id);
    if (activeId === id) activeId = null;
    persist();
    saveActive();
    notify();
    return true;
  }

  function rename(id, name) {
    const w = byId(id);
    if (!w || w.builtin) return false;
    const trimmed = String(name || '').trim();
    if (!trimmed) return false;
    w.name = trimmed.slice(0, 40);
    persist();
    notify();
    return true;
  }

  function reset(app) {
    apply(DEFAULTS, app);
    activeId = null;
    saveActive();
    notify();
    if (app && app.setStatus) app.setStatus('Workspace: default layout');
    return true;
  }

  /* ===================== persistence ===================== */

  let saveTimer = null;
  function persist() {
    /* Debounced: a splitter drag would otherwise write on every mouse move. */
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      saveTimer = null;
      try {
        OS.media.idbPut('kv', STORE_KEY, userPresets.map((p) => ({
          id: p.id, name: p.name, description: p.description, layout: p.layout,
        }))).catch(() => {});
      } catch (err) { /* storage is best effort */ }
    }, 250);
  }

  function saveActive() {
    try {
      OS.media.idbPut('kv', ACTIVE_KEY, activeId).catch(() => {});
    } catch (err) { /* best effort */ }
  }

  async function loadState() {
    try {
      const payload = await OS.media.idbGet('kv', STORE_KEY);
      if (Array.isArray(payload)) {
        userPresets = payload.filter((p) => p && p.id && p.name && p.layout);
      }
      const act = await OS.media.idbGet('kv', ACTIVE_KEY);
      if (typeof act === 'string') activeId = act;
    } catch (err) {
      /* A broken store must not stop the editor from starting. */
    }
    notify();
    return userPresets.length;
  }

  /* ===================== menus ===================== */

  function menuItems(app, onPick) {
    const out = [];
    for (const w of all()) {
      out.push({
        label: (w.id === activeId ? '\u2713 ' : '') + w.name,
        hint: w.builtin ? '' : 'saved',
        action: () => { activate(w.id, app); if (onPick) onPick(w); },
      });
    }
    return out;
  }

  /* ===================== change notification ===================== */

  const listeners = new Set();
  function onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }
  function notify() { for (const fn of listeners) { try { fn(); } catch (e) { console.error(e); } } }

  /* ===================== stats ===================== */

  const stats = () => ({ total: all().length, builtin: BUILTIN.length, user: userPresets.length });

  const api = {
    DEFAULTS,
    LIMITS,
    BUILTIN,
    all,
    byId,
    get activeId() { return activeId; },
    activate,
    apply,
    readLayout,
    saveAs,
    updateActive,
    remove,
    rename,
    reset,
    loadState,
    persist,
    menuItems,
    onChange,
    stats,
    STORE_KEY,
  };
  OS.workspaces = api;
})();
