/* OpenScene — library.js
   The left dock, in the style of OpenShot: a tabbed panel that switches between
   Project Files, Transitions and Effects. The Transitions and Effects panes are
   searchable, grouped browsers whose items can be dragged straight onto a clip in
   the timeline, or double-clicked to apply to the current selection. */
(() => {
  'use strict';
  const OS = (window.OS = window.OS || {});
  const U = OS.util;
  const { el, on, debounce } = U;
  const onActivate = U.onActivate;

  const MIME_EFFECT = 'application/x-openscene-effect';
  const MIME_TRANSITION = 'application/x-openscene-transition';

  /* ===================== dock (tabs) ===================== */

  class Dock {
    constructor(root, app) {
      this.root = root;
      this.app = app;
      this.tabs = Array.from(root.querySelectorAll('.dock-tab'));
      this.panes = new Map();
      for (const tab of this.tabs) {
        const id = tab.dataset.dock;
        const pane = document.getElementById(id);
        if (pane) this.panes.set(tab, pane);
        on(tab, 'click', () => this.show(id));
        on(tab, 'contextmenu', (e) => { e.preventDefault(); this.show(id); });
      }
      const activeTab = this.tabs.find((t) => t.classList.contains('on')) || this.tabs[0];
      this.active = activeTab ? activeTab.dataset.dock : null;
    }

    show(id) {
      let found = false;
      for (const [tab, pane] of this.panes) {
        const on = tab.dataset.dock === id;
        tab.classList.toggle('on', on);
        tab.setAttribute('aria-selected', on ? 'true' : 'false');
        pane.classList.toggle('on', on);
        if (on) found = true;
      }
      if (!found) return;
      this.active = id;
      if (this.app.timeline) this.app.timeline.resize();
      if (this.app.player) this.app.player.requestRender();
    }

    get activeName() {
      const tab = this.tabs.find((t) => t.dataset.dock === this.activeId);
      return tab ? tab.textContent : '';
    }
  }

  /* ===================== shared list helpers ===================== */

  function listShell(root, title, placeholder, hint) {
    root.classList.add('lib');
    const head = el('div.lib-head');
    const count = el('span.panel-sub');
    head.append(el('span.panel-title', { text: title }), count);
    const search = el('input.search', { type: 'search', placeholder });
    const cats = el('div.lib-cats');
    const scroll = el('div.lib-scroll');
    const tools = el('div.lib-tools', {}, [search]);
    root.append(head, tools, scroll, el('div.lib-hint', { text: hint }));
    return { head, count, search, cats, scroll, tools };
  }

  function emptyNote(node, text) { node.appendChild(el('div.lib-empty', { text })); }

  /* ===================== effects browser ===================== */

  class EffectsPanel {
    constructor(root, app) {
      this.root = root;
      this.app = app;
      this.category = 'video';
      this.query = '';
      this.build();
      app.events.on('project-loaded', () => this.refresh());
    }

    build() {
      const s = listShell(this.root, 'Effects', 'Search effects\u2026',
        'Drag an effect onto a clip in the timeline, or double-click it to add it to the selected clip.');
      this.countLabel = s.count;
      this.search = s.search;
      this.cats = s.cats;
      this.scroll = s.scroll;
      s.tools.appendChild(this.cats);

      for (const [id, label] of [['video', 'Video'], ['audio', 'Audio'], ['all', 'All']]) {
        const b = el('button.lib-cat', { text: label, dataset: { cat: id } });
        on(b, 'click', () => { this.category = id; this._syncCats(); this.refresh(); });
        this.cats.appendChild(b);
      }
      on(this.search, 'input', debounce(() => { this.query = this.search.value.trim().toLowerCase(); this.refresh(); }, 80));
      this._syncCats();
      this.refresh();
    }

    _syncCats() { for (const b of this.cats.children) b.classList.toggle('on', b.dataset.cat === this.category); }

    items() {
      const cat = this.category === 'all' ? null : this.category;
      const q = this.query;
      return OS.effects.list(cat).filter((r) => !q
        || r.label.toLowerCase().includes(q)
        || (r.description || '').toLowerCase().includes(q)
        || (r.group || '').toLowerCase().includes(q));
    }

    refresh() {
      this.scroll.innerHTML = '';
      const items = this.items();
      this.countLabel.textContent = items.length + (items.length === 1 ? ' effect' : ' effects');
      if (!items.length) { emptyNote(this.scroll, 'No effects match your search.'); return; }
      let last = null;
      for (const reg of items) {
        if (reg.group !== last) { last = reg.group; this.scroll.appendChild(el('div.lib-group-title', { text: reg.group })); }
        this.scroll.appendChild(this._item(reg));
      }
    }

    _item(reg) {
      const it = el('div.lib-item', { draggable: 'true', title: `${reg.label}\n${reg.description || ''}`, dataset: { fxType: reg.type } });
      const thumb = el('div.lib-thumb');
      thumb.appendChild(el('span.lib-glyph', { text: reg.category === 'audio' ? 'AUD' : 'FX' }));
      it.append(thumb, el('div.lib-meta', {}, [
        el('div.lib-name', { text: reg.label }),
        el('div.lib-desc', { text: reg.description || '' }),
      ]));
      on(it, 'dragstart', (e) => {
        e.dataTransfer.effectAllowed = 'copy';
        e.dataTransfer.setData(MIME_EFFECT, JSON.stringify({ type: reg.type }));
        e.dataTransfer.setData('text/plain', reg.label);
        it.classList.add('dragging');
      });
      on(it, 'dragend', () => it.classList.remove('dragging'));
      onActivate(it, () => this.app.applyEffectToSelection(reg.type));
      on(it, 'contextmenu', (e) => { e.preventDefault(); this._menu(e, reg); });
      return it;
    }

    _menu(e, reg) {
      const sel = this.app.timeline.getSelectedClips();
      this.app.dialogs.contextMenu(e.clientX, e.clientY, [
        { label: 'Add to selected clip' + (sel.length === 1 ? '' : 's'), disabled: !sel.length, action: () => this.app.applyEffectToSelection(reg.type) },
        { label: 'Add to clip under the playhead', action: () => this.app.applyEffectAtPlayhead(reg.type) },
        { sep: true },
        { label: 'Open the effects list in a clip\u2019s properties', action: () => this.app.focusProperties() },
      ]);
    }
  }

  /* ===================== transitions browser ===================== */

  class TransitionsPanel {
    constructor(root, app) {
      this.root = root;
      this.app = app;
      this.query = '';
      this._thumbs = new Map();
      this.build();
      app.events.on('project-loaded', () => this.refresh());
    }

    build() {
      const s = listShell(this.root, 'Transitions', 'Search transitions\u2026',
        'Drag a transition between two clips, or double-click it to transition the selected clip from its neighbour. Transitions are created by overlapping clips on a track.');
      this.countLabel = s.count;
      this.search = s.search;
      this.scroll = s.scroll;
      on(this.search, 'input', debounce(() => { this.query = this.search.value.toLowerCase(); this.refresh(); }, 120));
      this.refresh();
    }

    items() {
      return OS.transitions.TYPES.filter(([, label, , desc]) =>
        !this.query || label.toLowerCase().includes(this.query) || (desc || '').toLowerCase().includes(this.query));
    }

    refresh() {
      this.scroll.innerHTML = '';
      const items = this.items();
      this.countLabel.textContent = items.length + (items.length === 1 ? ' transition' : ' transitions');
      if (!items.length) { emptyNote(this.scroll, 'No transitions match your search.'); return; }
      let last = null;
      for (const [type, label, group, desc] of items) {
        if (group !== last) { last = group; this.scroll.appendChild(el('div.lib-group-title', { text: group })); }
        this.scroll.appendChild(this._item(type, label, desc));
      }
    }

    _item(type, label, desc) {
      const it = el('div.lib-item', { draggable: 'true', title: `${label}\n${desc}`, dataset: { transType: type } });
      const thumb = el('div.lib-thumb');
      const canvas = this._thumb(type);
      if (canvas) thumb.appendChild(canvas);
      else thumb.appendChild(el('span.lib-glyph', { text: 'TR' }));
      it.append(thumb, el('div.lib-meta', {}, [
        el('div.lib-name', { text: label }),
        el('div.lib-desc', { text: desc }),
      ]));
      on(it, 'dragstart', (e) => {
        e.dataTransfer.effectAllowed = 'copy';
        e.dataTransfer.setData(MIME_TRANSITION, JSON.stringify({ type }));
        e.dataTransfer.setData('text/plain', label);
        it.classList.add('dragging');
      });
      on(it, 'dragend', () => it.classList.remove('dragging'));
      onActivate(it, () => this.app.applyTransitionToSelection(type));
      on(it, 'contextmenu', (e) => { e.preventDefault(); this._menu(e, type, label); });
      return it;
    }

    _menu(e, type, label) {
      const sel = this.app.timeline.getSelectedClips();
      this.app.dialogs.contextMenu(e.clientX, e.clientY, [
        { label: 'Apply to selected clip', disabled: !sel.length, action: () => this.app.applyTransitionToSelection(type) },
        { label: 'Apply to the clip at the playhead', action: () => this.app.applyTransitionAtPlayhead(type) },
        { sep: true },
        { label: 'Transition type: ' + label, disabled: true, action: null },
      ]);
    }

    /* Small rendered preview of the transition at its mid point. */
    _thumb(type) {
      if (this._thumbs.has(type)) return this._thumbs.get(type);
      try {
        const w = 92, h = 52;
        const A = document.createElement('canvas'); A.width = w; A.height = h;
        const B = document.createElement('canvas'); B.width = w; B.height = h;
        const actx = A.getContext('2d'), bctx = B.getContext('2d');
        const ga = actx.createLinearGradient(0, 0, 0, h);
        ga.addColorStop(0, '#2f6fd0'); ga.addColorStop(1, '#1b3f78');
        actx.fillStyle = ga; actx.fillRect(0, 0, w, h);
        actx.fillStyle = 'rgba(255,255,255,0.16)';
        for (let i = 0; i < 4; i++) actx.fillRect(6 + i * 22, 8, 12, h - 16);
        const bg = bctx.createLinearGradient(0, 0, 0, h);
        bg.addColorStop(0, '#e0913a');
        bg.addColorStop(1, '#a8541f');
        bctx.fillStyle = bg; bctx.fillRect(0, 0, w, h);
        bctx.fillStyle = 'rgba(255,255,255,0.35)';
        bctx.beginPath(); bctx.arc(w / 2, h / 2, 7, 0, Math.PI * 2); bctx.fill();

        const out = document.createElement('canvas');
        out.width = w; out.height = h;
        const ctx = out.getContext('2d');
        const scratch = OS.transitions.makeScratch();
        OS.transitions.draw(ctx, w, h, type, 0.5,
          (c) => c.drawImage(A, 0, 0),
          (c) => c.drawImage(B, 0, 0),
          scratch);
        this._thumbs.set(type, out);
        return out;
      } catch (err) {
        this._thumbs.set(type, null);
        return null;
      }
    }
  }

  OS.library = { Dock, EffectsPanel, TransitionsPanel, MIME_EFFECT, MIME_TRANSITION };
})();
