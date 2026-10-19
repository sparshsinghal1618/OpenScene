/* OpenScene — bin.js
   Project Files: import (picker + drag & drop), thumbnail grid/list, search,
   rename, remove, and drag-to-timeline. Lives in the first tab of the left dock. */
(() => {
  'use strict';
  const OS = (window.OS = window.OS || {});
  const U = OS.util;
  const { el, on, fmtBytes, fmtDur } = U;
  const onActivate = U.onActivate;
  const M = () => OS.model;

  class Bin {
    constructor(root, app) {
      this.root = root;
      this.app = app;
      this.mode = 'grid';
      this.filter = '';
      this.build();
      this.refresh();
      app.events.on('media-added', () => this.refresh());
      app.events.on('media-updated', () => this.refresh());
      app.events.on('project-loaded', () => this.refresh());
    }

    build() {
      this.root.classList.add('bin');
      const head = el('div.panel-head');
      this.title = el('span.panel-title', { text: 'Media' });
      this.countLabel = el('span.panel-sub');
      this.importBtn = el('button.btn.btn-primary', { title: 'Import media (Ctrl+I)', text: 'Import' });
      this.viewBtn = el('button.btn.btn-icon', { title: 'Toggle grid / list view', text: 'Grid' });
      head.append(this.title, this.countLabel, el('span.spacer'), this.importBtn, this.viewBtn);

      this.search = el('input.search', { type: 'search', placeholder: 'Search media\u2026' });
      this.drop = el('div.bin-drop', { text: 'Drop video, audio or image files here, or press Import. Assets can also be dragged onto the timeline.' });
      this.grid = el('div.bin-grid');

      const wrap = el('div.bin-scroll', {}, [this.drop, this.grid]);
      this.root.append(head, el('div.bin-tools', {}, [this.search]), wrap);

      on(this.importBtn, 'click', () => this.app.importMedia());
      on(this.viewBtn, 'click', () => {
        this.mode = this.mode === 'grid' ? 'list' : 'grid';
        this.viewBtn.textContent = this.mode === 'grid' ? 'Grid' : 'List';
        this.refresh();
      });
      on(this.search, 'input', () => { this.filter = this.search.value.toLowerCase(); this.refresh(); });

      const stop = (e) => { e.preventDefault(); e.stopPropagation(); };
      ['dragenter', 'dragover'].forEach((ev) => on(wrap, ev, (e) => { stop(e); this.drop.classList.add('over'); }));
      ['dragleave', 'drop'].forEach((ev) => on(wrap, ev, (e) => { stop(e); if (ev === 'dragleave' && wrap.contains(e.relatedTarget)) return; this.drop.classList.remove('over'); }));
      on(wrap, 'drop', (e) => {
        const dt = e.dataTransfer;
        if (dt && dt.files && dt.files.length) { this.app.importFiles(dt.files); return; }
        const payload = dt && dt.getData('application/x-openscene-asset');
        if (payload) {
          try {
            const data = JSON.parse(payload);
            const asset = M().findAsset(this.app.project, data.assetId);
            if (asset) this.app.insertAssetAtPlayhead(asset);
          } catch (err) { /* ignore malformed drops */ }
        }
      });
    }

    refresh() {
      const p = this.app.project;
      if (!p) return;
      const items = p.assets.filter((a) => !this.filter || a.name.toLowerCase().includes(this.filter));
      this.countLabel.textContent = `${p.assets.length} item${p.assets.length === 1 ? '' : 's'}`;
      this.drop.style.display = p.assets.length ? 'none' : 'flex';
      this.grid.className = 'bin-grid ' + this.mode;
      this.grid.innerHTML = '';
      for (const asset of items) this.grid.appendChild(this._item(asset));
    }

    _item(asset) {
      const p = this.app.project;
      const card = el('div.bin-item', { draggable: 'true', title: `${asset.name}\n${asset.width ? asset.width + '\u00d7' + asset.height + ' \u00b7 ' : ''}${fmtDur(OS.timebase.framesToSeconds(asset.durationFrames, p.fps))} \u00b7 ${fmtBytes(asset.bytes)}` });
      card.__assetId = asset.id;
      const thumb = el('div.bin-thumb');
      if (asset.thumb) thumb.style.backgroundImage = `url("${asset.thumb}")`;
      else thumb.appendChild(el('div.bin-thumb-fallback', { text: asset.kind === 'audio' ? 'AUD' : asset.kind === 'image' ? 'IMG' : 'VID' }));
      const kindBadge = el('span.bin-badge', { text: asset.kind === 'video' ? 'VID' : asset.kind === 'audio' ? 'AUD' : 'IMG' });
      const missing = asset.missing ? el('span.bin-badge.warn', { text: 'MISSING' }) : null;
      const noCodec = (asset.undecodable && !asset.missing) ? el('span.bin-badge.warn', { text: 'NO CODEC' }) : null;
      const meta = el('div.bin-meta', {}, [
        el('div.bin-name', { text: asset.name }),
        el('div.bin-sub', { text: `${asset.kind}${asset.width ? ` \u00b7 ${asset.width}\u00d7${asset.height}` : ''} \u00b7 ${asset.undecodable ? 'no decoder in this build' : OS.timebase.tc(asset.durationFrames, p.fps)}` }),
      ]);
      thumb.append(kindBadge, ...(missing ? [missing] : []), ...(noCodec ? [noCodec] : []));
      card.append(thumb, meta);

      onActivate(card, () => {
        if (asset.undecodable) { this.app.dialogs.toast('This build has no decoder for that codec.', 'warn', 6000); return; }
        this.app.insertAssetAtPlayhead(asset);
      });
      on(card, 'dragstart', (e) => {
        e.dataTransfer.effectAllowed = 'copy';
        e.dataTransfer.setData('application/x-openscene-asset', JSON.stringify({ assetId: asset.id }));
        e.dataTransfer.setData('text/plain', asset.name);
        card.classList.add('dragging');
      });
      on(card, 'dragend', () => card.classList.remove('dragging'));
      on(card, 'contextmenu', (e) => { e.preventDefault(); this._context(e, asset); });
      return card;
    }

    _context(e, asset) {
      this.app.dialogs.contextMenu(e.clientX, e.clientY, [
        { label: 'Insert at playhead', action: () => this.app.insertAssetAtPlayhead(asset) },
        { label: 'Insert on a new track', action: () => this.app.insertAssetNewTrack(asset) },
        { sep: true },
        { label: 'Rename', action: () => this._rename(asset) },
        { label: asset.missing ? 'Relink missing file' : 'Replace file', action: () => this.app.relinkAsset(asset) },
        { label: 'Media properties', action: () => this.app.showAssetInfo(asset) },
        { sep: true },
        { label: 'Remove from project', danger: true, action: () => this.app.removeAssets([asset]) },
      ]);
    }

    _rename(asset) {
      const v = prompt('Media name', asset.name);
      if (v == null || !v.trim()) return;
      const oldName = asset.name;
      const newName = v.trim();
      const clips = [];
      for (const t of this.app.project.tracks) for (const c of M().clipsOf(this.app.project, t)) {
        if (c.assetId === asset.id && c.name === oldName) clips.push(c);
      }
      this.app.exec({
        label: 'Rename media',
        do() { asset.name = newName; for (const c of clips) c.name = newName; },
        undo() { asset.name = oldName; for (const c of clips) c.name = oldName; },
      });
      this.refresh();
    }
  }

  OS.bin = { Bin };
})();
