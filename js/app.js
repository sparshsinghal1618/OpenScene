/* OpenScene — app.js
   Application shell: layout wiring, menus, toolbar, transport, status bar,
   command dispatch (undo/redo), selection editing actions and bootstrapping.
   This is the only module that knows about the whole UI; every other module
   receives the app instance and talks to it through the documented surface. */
(() => {
  'use strict';
  const OS = (window.OS = window.OS || {});
  const U = OS.util;
  const { el, on, clamp, deepClone, uid, fmtDur, fmtBytes } = U;
  const M = () => OS.model;

  /* Format tables live in js/media.js so the pickers, the native Windows dialog
     filter and this file can never drift apart. */
  const mimeForName = (name) => (OS.media && OS.media.MIME_BY_EXT[OS.media.extOf(name)]) || '';

  class App {
    constructor() {
      /* Kept in step with the git tag and the GitHub release. Shown in the
         About dialog and written into every saved project file, so it must not
         disagree with what was actually shipped. */
      this.VERSION = '1.2.0';
      this.events = new U.Emitter();
      this.previewScale = 1;
      this.clipboard = null;
      this.statsOn = false;
      this.recentPath = null;
      this._statusTimer = 0;
      this._statsAt = 0;
      this._mounted = false;
    }

    /* ================= boot ================= */

    async init() {
      OS.app = this;

      // ---- DOM cache ----
      const $ = (id) => document.getElementById(id);
      this.dom = {
        app: $('app'),
        binPanel: $('binPanel'),
        propsPanel: $('propsPanel'),
        timelinePanel: $('timelinePanel'),
        preview: $('preview'),
        previewStage: $('previewStage'),
        previewWrap: $('previewWrap'),
        center: $('center'),
        docTitle: $('docTitle'),
        statusMsg: $('statusMsg'),
        statusRight: $('statusRight'),
        statsBox: $('statsBox'),
        menubar: $('menubar'),
        tcInput: $('tcInput'),
        tcDur: $('tcDur'),
        volRange: $('volRange'),
        volLabel: $('volLabel'),
        meterL: $('meterL'),
        meterR: $('meterR'),
        prQuality: $('prQuality'),
        btnPlay: $('btnPlay'),
        dockLeft: $('dockLeft'),
        transitionsPanel: $('transitionsPanel'),
        effectsPanel: $('effectsPanel'),
      };
      this.titleEl = this.dom.docTitle;

      // ---- dialogs first (menus need them) ----
      this.dialogs = new OS.dialogs.Dialogs(this);

      // ---- model + stores ----
      this.project = OS.model.createProject({ name: 'Untitled Project' });
      this.media = new OS.media.MediaStore();
      OS.media.instance = this.media;
      this.commands = new OS.commands.CommandStack(300);

      // ---- player ----
      this.player = new OS.player.Player(this.dom.preview);
      this.player.attach(this.project, this.media);
      this.player.setMasterVolume(1);

      // ---- panels ----
      this.timeline = new OS.timeline.Timeline(this.dom.timelinePanel, this);
      this.bin = new OS.bin.Bin(this.dom.binPanel, this);
      this.transitionsLibrary = new OS.library.TransitionsPanel(this.dom.transitionsPanel, this);
      this.effectsLibrary = new OS.library.EffectsPanel(this.dom.effectsPanel, this);
      this.dock = new OS.library.Dock(this.dom.dockLeft, this);
      this.properties = new OS.properties.Properties(this.dom.propsPanel, this);
      this.scopes = new OS.scopes.Scopes(this);
      this.mobile = new OS.mobile.MobileShell(this);

      // ---- persistence + shortcuts ----
      this.persist = new OS.persist.Persist(this);
      this.shortcuts = new OS.shortcuts.ShortcutManager(this);

      // ---- UI wiring ----
      this._buildMenus();
      this._wireTransport();
      this._wireSplitters();
      this._wireGlobalDrop();
      this._wireEvents();
      this._uiLoop();

      this._mounted = true;
      this.timeline.zoomToFit();
      this.updateTitle();
      this.setStatus('Ready — import media (Ctrl+I) or add a title from the Add menu');

      // ---- async niceties ----
      this.persist.getRecents().then((r) => { this._recentsCache = r || []; }).catch(() => { this._recentsCache = []; });
      this.events.on('recents-changed', (list) => { this._recentsCache = list || []; });

      /* Restore what the user saved last time. Both are best-effort: a broken
         store must never stop the editor from starting, so each is isolated and
         the layout is only applied if a preset actually came back. Runs after
         the panels and the dock exist, because applying a workspace drives them. */
      this._restoreSavedState();

      setTimeout(() => this.persist.recoveryPrompt(), 600);
      const hash = (location.hash || '') + (location.search || '');
      if (/selftest/i.test(hash)) setTimeout(() => this.runSelfTest(), 900);
    }

    /* ================= layout helpers ================= */

    /* Bring back the custom transitions and the active workspace from the last
       session. Deliberately fire-and-forget: the editor is already usable, and a
       storage failure should degrade to "no custom transitions" rather than
       break startup. */
    async _restoreSavedState() {
      const CT = OS.customTrans;
      if (CT) {
        try {
          const n = await CT.load();
          if (n > 0) {
            CT.refreshPanels();
            this.setStatus(n + (n === 1 ? ' custom transition' : ' custom transitions') + ' restored');
          }
        } catch (e) { console.warn('[OpenScene] could not restore custom transitions', e); }
      }

      const W = OS.workspaces;
      if (W) {
        try {
          await W.loadState();
          /* Only re-apply if the user actually had a workspace selected, so a
             fresh profile keeps the default layout rather than jumping. */
          if (W.activeId && W.byId(W.activeId)) W.apply(W.byId(W.activeId).layout, this);
        } catch (e) { console.warn('[OpenScene] could not restore the workspace', e); }
      }
    }

    _wireSplitters() {
      const bind = (handleId, panelId, side, cssVar) => {
        const handle = document.getElementById(handleId);
        const panel = document.getElementById(panelId);
        if (!handle || !panel) return;
        let start = 0, size = 0, dragging = false;
        const down = (e) => {
          dragging = true;
          start = e.clientX;
          size = panel.getBoundingClientRect().width;
          handle.classList.add('dragging');
          document.body.classList.add('col-resizing');
          e.preventDefault();
        };
        const move = (e) => {
          if (!dragging) return;
          const delta = side === 'left' ? (e.clientX - start) : (start - e.clientX);
          const next = clamp(size + delta, 190, Math.min(680, window.innerWidth - 420));
          // the panels are grid items, so drive the track width via its CSS variable
          document.getElementById('main').style.setProperty(cssVar, Math.round(next) + 'px');
          this._panelWidths = this._panelWidths || {};
          this._panelWidths[cssVar] = Math.round(next);
        };
        const up = () => {
          if (!dragging) return;
          dragging = false;
          handle.classList.remove('dragging');
          document.body.classList.remove('col-resizing');
          this.player.requestRender();
          this.timeline.resize();
        };
        on(handle, 'mousedown', down);
        on(window, 'mousemove', move);
        on(window, 'mouseup', up);
      };
      bind('splitLeft', 'binPanel', 'left', '--bin-w');
      bind('splitRight', 'propsPanel', 'right', '--props-w');

      // horizontal splitter between the workspace and the timeline
      const h = document.getElementById('splitTimeline');
      if (h) {
        let dragging = false, startY = 0, startH = 0;
        on(h, 'mousedown', (e) => {
          dragging = true; startY = e.clientY;
          startH = document.getElementById('timelinePanel').getBoundingClientRect().height;
          h.classList.add('dragging'); document.body.classList.add('row-resizing'); e.preventDefault();
        });
        on(window, 'mousemove', (e) => {
          if (!dragging) return;
          const next = clamp(startH - (e.clientY - startY), 140, Math.min(760, window.innerHeight - 240));
          document.documentElement.style.setProperty('--tl-h', next + 'px');
          if (this.timeline) this.timeline.resize();
        });
        on(window, 'mouseup', () => {
          if (!dragging) return;
          dragging = false;
          h.classList.remove('dragging'); document.body.classList.remove('row-resizing');
          if (this.timeline) this.timeline.resize();
        });
      }
    }

    _wireGlobalDrop() {
      const stop = (e) => { e.preventDefault(); e.stopPropagation(); };
      ['dragenter', 'dragover'].forEach((ev) => on(document.body, ev, (e) => { stop(e); document.body.classList.add('drop-active'); }));
      ['dragleave', 'drop'].forEach((ev) => on(document.body, ev, (e) => {
        stop(e);
        if (ev === 'dragleave' && e.relatedTarget) return;
        document.body.classList.remove('drop-active');
      }));
      on(document.body, 'drop', (e) => {
        const dt = e.dataTransfer;
        if (dt && dt.files && dt.files.length) this.importFiles(dt.files);
      });
    }

    /* ================= menus ================= */

    _buildMenus() {
      const menus = {
        menuFile: () => this._fileMenu(),
        menuEdit: () => this._editMenu(),
        menuAdd: () => this._addMenu(),
        menuClip: () => this._clipMenu(),
        menuTrack: () => this._trackMenu(),
        menuTools: () => this._toolsMenu(),
        menuView: () => this._viewMenu(),
        menuHelp: () => this._helpMenu(),
      };
      for (const [id, build] of Object.entries(menus)) {
        const btn = document.getElementById(id);
        if (!btn) continue;
        on(btn, 'click', (e) => {
          e.stopPropagation();
          const r = btn.getBoundingClientRect();
          this.dialogs.contextMenu(r.left, r.bottom + 2, build());
        });
      }
      // quick toolbar buttons
      const wire = (id, fn) => { const b = document.getElementById(id); if (b) on(b, 'click', fn); };
      wire('tbImport', () => this.importMedia());
      wire('tbSave', () => this.persist.saveProject());
      wire('tbExport', () => this.dialogs.exportDialog());
      wire('tbSettings', () => this.dialogs.projectSettings());
      wire('tbShortcuts', () => this.dialogs.shortcuts());
      wire('tbCut', () => this.splitAtPlayhead());
      wire('tbMarker', () => this.addMarkerAtPlayhead());
      wire('tbSpeed', () => this.changeClipSpeed());
      this._syncToolbar();
    }

    /* Keep the toolbar's state showing what is actually selected, so the speed
       badge never claims 2x while a 1x clip is selected. */
    _syncToolbar() {
      const badge = document.getElementById('tbSpeedBadge');
      const btn = document.getElementById('tbSpeed');
      if (!badge || !btn) return;

      const sel = this._sel().filter((c) => !c.generator);
      if (!sel.length) {
        badge.textContent = '1x';
        btn.classList.remove('on', 'mixed');
        btn.title = 'Clip speed - select a clip first';
        return;
      }
      const speeds = sel.map((c) => c.speed || 1);
      const same = speeds.every((s) => Math.abs(s - speeds[0]) < 1e-6);
      badge.textContent = same ? (Math.round(speeds[0] * 100) / 100) + 'x' : 'mix';
      btn.classList.toggle('mixed', !same);
      btn.classList.toggle('on', same && Math.abs(speeds[0] - 1) > 1e-6);
      btn.title = same
        ? 'Clip speed - ' + (Math.round(speeds[0] * 100) / 100) + 'x'
        : 'Clip speed - mixed across ' + sel.length + ' clips';
    }

    _acc(label, hint) { return { label, hint, action: null }; }
    _fileMenu() {
      const items = [
        { label: 'New project', hint: 'Ctrl+N', action: () => this.newProject() },
        { label: 'Open project…', hint: 'Ctrl+O', action: () => this.persist.openProject() },
        { label: 'Save project', hint: 'Ctrl+S', action: () => this.persist.saveProject() },
        { label: 'Save as…', hint: 'Ctrl+Shift+S', action: () => this.persist.saveProject({ forceDialog: true }) },
      ];
      const recents = this.persist.getRecents ? this._recentsCache || [] : [];
      if (recents.length) {
        items.push({ sep: true }, {
          label: 'Open recent', icon: 'T', submenu: recents.map((p) => ({ label: p.split(/[\\/]/).pop(), action: () => this._openRecent(p) })),
        });
      }
      items.push(
        { sep: true },
        { label: 'Import media…', hint: 'Ctrl+I', action: () => this.importMedia() },
        { sep: true },
        { label: 'Export…', hint: 'Ctrl+E', action: () => this.dialogs.exportDialog() },
        { label: 'Export still frame…', hint: 'Ctrl+Shift+E', action: () => this.exportStill() },
        { sep: true },
        { label: 'Project settings…', action: () => this.dialogs.projectSettings() },
        { sep: true },
        { label: 'Quit', action: () => this.quit() },
      );
      return items;
    }

    _editMenu() {
      const c = this.commands;
      const undoName = c.peekUndo() ? c.peekUndo().label : null;
      const redoName = c.peekRedo() ? c.peekRedo().label : null;
      const sel = this.timeline.getSelectedClips();
      return [
        { label: undoName ? `Undo ${undoName}` : 'Undo', hint: 'Ctrl+Z', disabled: !c.canUndo, action: () => this.undo() },
        { label: redoName ? `Redo ${redoName}` : 'Redo', hint: 'Ctrl+Y', disabled: !c.canRedo, action: () => this.redo() },
        { sep: true },
        { label: 'Cut', hint: 'Ctrl+X', disabled: !sel.length, action: () => this.cutSelection() },
        { label: 'Copy', hint: 'Ctrl+C', disabled: !sel.length, action: () => this.copySelection() },
        { label: 'Paste at playhead', hint: 'Ctrl+V', disabled: !this.clipboard, action: () => this.pasteAtPlayhead() },
        { label: 'Duplicate', hint: 'Ctrl+D', disabled: !sel.length, action: () => this.duplicateSelection() },
        { sep: true },
        { label: 'Lift (delete)', hint: 'Delete', disabled: !sel.length, action: () => this.liftSelection() },
        { label: 'Ripple delete', hint: 'Shift+Delete', danger: true, disabled: !sel.length, action: () => this.rippleDeleteSelection() },
        { sep: true },
        { label: 'Select all clips', hint: 'Ctrl+A', action: () => this.timeline.selectAll() },
        { label: 'Deselect', action: () => this.timeline.clearSelection() },
        { sep: true },
        { label: 'Group clips', hint: 'Ctrl+G', disabled: sel.length < 2, action: () => this.groupSelection() },
        { label: 'Ungroup clips', hint: 'Ctrl+Shift+G', action: () => this.ungroupSelection() },
        { sep: true },
        { label: 'Split at playhead', hint: 'S', action: () => this.splitAtPlayhead() },
        { label: 'Split everything at playhead', hint: 'Shift+S', action: () => this.splitAllAtPlayhead() },
        { label: 'Add marker at playhead', hint: 'M', action: () => this.addMarkerAtPlayhead() },
      ];
    }

    _addMenu() {
      return [
        { label: 'Title', action: () => this.addTitleClip('main-title') },
        { label: 'Subtitle', action: () => this.addTitleClip('subtitle') },
        { label: 'Lower third', action: () => this.addTitleClip('lower-third') },
        { label: 'Caption', action: () => this.addTitleClip('caption') },
        { label: 'End credits', action: () => this.addTitleClip('end-credits') },
        { label: 'Callout', action: () => this.addTitleClip('callout') },
        { sep: true },
        { label: 'Colour clip', action: () => this.addGeneratorClip('color') },
        { label: 'Gradient clip', action: () => this.addGeneratorClip('gradient') },
        { label: 'Adjustment layer', action: () => this.addAdjustmentClip() },
        { sep: true },
        { label: 'Effect to selected clip', submenu: this._effectSubmenu() },
        { label: 'Transition from previous clip', submenu: this._transitionSubmenu() },
        { sep: true },
        { label: 'Video track', hint: 'Ctrl+Shift+V', action: () => this.addTrack('video') },
        { label: 'Audio track', hint: 'Ctrl+Shift+A', action: () => this.addTrack('audio') },
        { sep: true },
        { label: 'Marker at playhead', action: () => this.addMarkerAtPlayhead() },
      ];
    }

    _effectSubmenu() {
      const sel = this._sel();
      const disabled = !sel.length;
      const items = Object.values(OS.effects.registry).map((reg) => ({ label: reg.label, disabled, action: () => this.applyEffectToSelection(reg.type) }));
      items.unshift({ label: disabled ? 'Select a clip first' : 'Apply to selected clip', disabled: true, action: null }, { sep: true });
      return items;
    }

    _transitionSubmenu() {
      const sel = this._sel();
      const one = sel.length === 1 ? sel[0] : null;
      const track = one ? M().findTrack(this.project, one.trackId) : null;
      const prev = track ? M().prevClip(track, one) : null;
      const items = OS.transitions.TYPES.map(([type, label]) => ({ label, disabled: !prev, action: () => this.addTransitionToClip(one, type) }));
      items.unshift({ label: prev ? 'Transition into the selected clip' : 'Select a clip that has a previous clip', disabled: true, action: null }, { sep: true });
      return items;
    }

    _clipMenu() {
      const sel = this.timeline.getSelectedClips();
      const one = sel.length === 1 ? sel[0] : null;
      const hasAudio = one && !one.generator && (M().findAsset(this.project, one.assetId) || {}).hasAudio;
      return [
        { label: 'Split at playhead', hint: 'S', disabled: !sel.length, action: () => this.splitAtPlayhead() },
        { label: 'Duplicate', hint: 'Ctrl+D', disabled: !sel.length, action: () => this.duplicateSelection() },
        { sep: true },
        { label: 'Add transition with previous clip', disabled: !one, action: () => one && this.addTransitionToClip(one) },
        { label: 'Transition type', disabled: !one, submenu: OS.transitions.TYPES.map(([type, label]) => ({ label, disabled: !one, action: () => one && this.addTransitionToClip(one, type) })) },
        { label: 'Add effect', disabled: !sel.length, submenu: this._effectSubmenu() },
        { label: 'Blend mode', disabled: !sel.length, submenu: M().BLEND_MODES.map(([id, label]) => ({ label, action: () => this.setBlendMode(id) })) },
        { label: 'Detach audio', disabled: !hasAudio, action: () => one && this.detachAudio(one) },
        { label: 'Freeze frame', disabled: !one, action: () => one && this.freezeFrame(one) },
        { label: 'Reverse', disabled: !one, action: () => one && this.toggleReverse(one) },
        { sep: true },
        { label: 'Roll edit (previous edge)', hint: 'N', disabled: !one, action: () => this.rollEdit(one, 1) },
        { label: 'Slip clip', disabled: !one, submenu: [
          { label: 'Slip one frame left', hint: 'Y', action: () => this.slipClip(one, -1) },
          { label: 'Slip one frame right', hint: 'Shift+Y', action: () => this.slipClip(one, 1) },
          { label: 'Slip 1 second left', action: () => this.slipClip(one, -Math.round(this.project.fps.rate)) },
          { label: 'Slip 1 second right', action: () => this.slipClip(one, Math.round(this.project.fps.rate)) },
        ] },
        { label: 'Slide clip', disabled: !one, submenu: [
          { label: 'Slide one frame left', action: () => this.slideClip(one, -1) },
          { label: 'Slide one frame right', action: () => this.slideClip(one, 1) },
        ] },
        { sep: true },
        { label: 'Group clips', hint: 'Ctrl+G', disabled: sel.length < 2, action: () => this.groupSelection() },
        { label: 'Ungroup clips', hint: 'Ctrl+Shift+G', action: () => this.ungroupSelection() },
        { sep: true },
        { label: 'Align start to playhead', disabled: !sel.length, action: () => this.alignSelected('start') },
        { label: 'Align end to playhead', disabled: !sel.length, action: () => this.alignSelected('end') },
        { label: 'Distribute evenly', disabled: sel.length < 3, action: () => this.distributeSelected() },
        { sep: true },
        { label: 'Reset transform', disabled: !sel.length, action: () => this.resetTransform(sel) },
        { label: 'Clear all effects', disabled: !sel.length, action: () => this.clearEffects(sel) },
        { sep: true },
        { label: 'Lift (delete)', hint: 'Delete', danger: true, disabled: !sel.length, action: () => this.liftSelection() },
        { label: 'Ripple delete', hint: 'Shift+Delete', danger: true, disabled: !sel.length, action: () => this.rippleDeleteSelection() },
      ];
    }

    _trackMenu() {
      const sel = this._sel();
      const one = sel.length === 1 ? sel[0] : null;
      const track = one ? M().findTrack(this.project, one.trackId) : null;
      return [
        { label: 'Add video track', hint: 'Ctrl+Shift+V', action: () => this.addTrack('video') },
        { label: 'Add audio track', hint: 'Ctrl+Shift+A', action: () => this.addTrack('audio') },
        { sep: true },
        { label: 'Add track above', disabled: !track, action: () => track && this.addTrackAt(track.kind, this.project.tracks.indexOf(track)) },
        { label: 'Add track below', disabled: !track, action: () => track && this.addTrackAt(track.kind, this.project.tracks.indexOf(track) + 1) },
        { sep: true },
        { label: 'Move track up', disabled: !track, action: () => track && this.moveTrack(track, -1) },
        { label: 'Move track down', disabled: !track, action: () => track && this.moveTrack(track, 1) },
        { label: 'Duplicate track', disabled: !track, action: () => track && this.duplicateTrack(track) },
        { sep: true },
        { label: 'Rename track', disabled: !track, action: () => track && this.renameTrack(track) },
        { label: 'Delete track', danger: true, disabled: !track, action: () => track && this.deleteTrack(track) },
      ];
    }

    _toolsMenu() {
      const hasAudio = this._sel().some((c) => {
        const a = M().findAsset(this.project, c.assetId);
        return !!a && a.kind !== 'image' && (a.kind !== 'video' || !!a.hasAudio);
      });
      return [
        { label: this.scopes.open ? 'Hide video scopes' : 'Show video scopes', hint: 'Ctrl+Shift+C', action: () => this.scopes.toggle() },
        { sep: true },
        { label: 'Audio mastering…', action: () => this.dialogs.mastering() },
        { label: 'Normalise selected audio to -1 dBFS', disabled: !hasAudio, action: () => this.normalizeAudio() },
        { sep: true },
        { label: 'Project settings…', action: () => this.dialogs.projectSettings() },
        { label: 'Run self-test…', action: () => this.runSelfTest() },
      ];
    }

    _viewMenu() {
      return [
        { label: 'Zoom in', hint: '+', action: () => this.timeline.zoomBy(1.3) },
        { label: 'Zoom out', hint: '−', action: () => this.timeline.zoomBy(1 / 1.3) },
        { label: 'Zoom to fit', hint: 'Ctrl+0', action: () => this.timeline.zoomToFit() },
        { sep: true },
        { label: 'Snapping', hint: 'N', checked: this.timeline.snapEnabled, action: () => this.timeline.snapBtn.click() },
        { label: 'Ripple editing', hint: 'R', checked: this.timeline.rippleMode, action: () => this.timeline.rippleBtn.click() },
        { sep: true },
        { label: 'Performance stats', hint: 'F3', checked: this.statsOn, action: () => this.toggleStats() },
        { label: 'Fullscreen preview', hint: 'F11', action: () => this.toggleFullscreenPreview() },
        { sep: true },
        { label: 'Project Files panel', action: () => this.showDock('binPanel') },
        { label: 'Transitions panel', action: () => this.showDock('transitionsPanel') },
        { label: 'Effects panel', action: () => this.showDock('effectsPanel') },
        { label: 'Custom transitions\u2026', action: () => this.customTransitionsDialog() },
        { sep: true },
        { label: 'Toggle library dock', action: () => this._togglePanel('dockLeft') },
        { label: 'Toggle properties', action: () => this._togglePanel('propsPanel') },
        { sep: true },
        { label: 'Workspaces', submenu: this._workspaceMenu() },
      ];
    }

    /* Workspace presets. Built-ins plus anything the user saved, with the
       actions that manage them at the bottom. */
    _workspaceMenu() {
      const W = OS.workspaces;
      if (!W) return [];
      const items = W.menuItems(this);
      items.push({ sep: true });
      items.push({ label: 'Save current layout as\u2026', action: () => this.saveWorkspaceDialog() });
      const active = W.activeId ? W.byId(W.activeId) : null;
      if (active && !active.builtin) {
        items.push({ label: 'Update "' + active.name + '"', action: () => {
          const r = W.updateActive(this);
          if (r.error) this.dialogs.toast(r.error, 'error'); else this.dialogs.toast('Workspace updated');
        } });
        items.push({ label: 'Delete "' + active.name + '"', action: () => {
          if (W.remove(active.id)) this.dialogs.toast('Workspace deleted');
        } });
      }
      items.push({ sep: true });
      items.push({ label: 'Reset layout', action: () => W.reset(this) });
      return items;
    }

    /* Promotion for a prompt, so the workspace name can be typed. */
    async saveWorkspaceDialog() {
      const W = OS.workspaces;
      if (!W) return;
      const name = await this.dialogs.prompt('Save workspace', 'Name this layout', 'My workspace', { okLabel: 'Save' });
      if (name === null) return;
      const r = W.saveAs(name, this);
      if (r.error) { this.dialogs.toast(r.error, 'error'); return; }
      this.dialogs.toast(r.replaced ? 'Workspace replaced' : 'Workspace saved');
    }

    _helpMenu() {
      return [
        { label: 'Keyboard shortcuts', hint: '?', action: () => this.dialogs.shortcuts() },
        { label: 'Run self-test…', action: () => this.runSelfTest() },
        { sep: true },
        { label: 'Open-source licences', action: () => this.showLicenses() },
        { label: 'About OpenScene', action: () => this.dialogs.about() },
      ];
    }

    _togglePanel(id) {
      const p = document.getElementById(id);
      if (!p) return;
      const hidden = p.style.display === 'none';
      p.style.display = hidden ? '' : 'none';
      p.style.flexBasis = '';
      this.player.requestRender();
      this.timeline.resize();
    }

    showDock(tabId) {
      if (!this.dock) return;
      if (this.dom.dockLeft && this.dom.dockLeft.style.display === 'none') {
        this.dom.dockLeft.style.display = '';
      }
      this.dock.show(tabId);
      const names = { binPanel: 'Project Files', transitionsPanel: 'Transitions', effectsPanel: 'Effects' };
      this.setStatus((names[tabId] || 'Library') + ' panel');
    }

    _openRecent(path) {
      const native = this.persist.native;
      if (native && native.openProjectPath) {
        native.openProjectPath(path).then((res) => {
          if (res && res.json) return this.persist.openProject(res.json, res.name);
        }).catch(() => this.persist.openProject());
        return;
      }
      this.persist.openProject();
    }

    /* ================= transport / preview ================= */

    _wireTransport() {
      const t = (id, fn, ev = 'click') => { const b = document.getElementById(id); if (b) on(b, ev, fn); };
      t('btnStart', () => this.player.gotoStart());
      t('btnPrevEdit', () => this.player.nextEditPoint(-1));
      t('btnStepBack', () => this.player.step(-1));
      t('btnStepFwd', () => this.player.step(1));
      t('btnNextEdit', () => this.player.nextEditPoint(1));
      t('btnEnd', () => this.player.gotoEnd());
      t('btnPlay', () => this.player.togglePlay());
      t('btnLoop', () => { this.player.loop = !this.player.loop; this._syncTransport(); this.setStatus('Loop ' + (this.player.loop ? 'on' : 'off')); });
      t('btnIn', () => this.setInPoint());
      t('btnOut', () => this.setOutPoint());
      t('btnSnapshot', () => this.exportStill());
      t('btnFullscreen', () => this.toggleFullscreenPreview());

      const tc = this.dom.tcInput;
      if (tc) {
        on(tc, 'focus', () => { this._tcEditing = true; });
        on(tc, 'blur', () => { this._tcEditing = false; this._updateTc(); });
        on(tc, 'change', () => {
          const f = OS.timebase.parseTC(tc.value, this.project.fps);
          if (f != null) this.player.seekTo(clamp(f, 0, this.player.duration), { resume: false });
          else { this.setStatus('Could not read that timecode'); this._updateTc(); }
        });
        on(tc, 'keydown', (e) => { if (e.key === 'Enter') { tc.blur(); } e.stopPropagation(); });
      }

      const vol = this.dom.volRange;
      if (vol) {
        on(vol, 'input', () => {
          const v = parseInt(vol.value, 10) / 100;
          this.player.setMasterVolume(v);
          if (this.dom.volLabel) this.dom.volLabel.textContent = parseInt(vol.value, 10) + '%';
        });
      }

      const q = this.dom.prQuality;
      if (q) {
        on(q, 'change', () => {
          const v = q.value;
          if (v === 'auto') { this.player.autoQuality = true; this.player.setPreviewScale(1); }
          else { this.player.autoQuality = false; this.player.setPreviewScale(parseFloat(v)); }
          this.previewScale = this.player.previewScale;
          this.setStatus('Preview quality: ' + v);
        });
      }

      // double-click the preview to toggle playback, and to fit
      if (this.dom.previewStage) {
        on(this.dom.previewStage, 'dblclick', (e) => { if (e.target === this.dom.preview || e.target === this.dom.previewStage) this.player.togglePlay(); });
      }
    }

    _syncTransport() {
      const play = document.getElementById('btnPlay');
      if (play) {
        play.classList.toggle('playing', this.player.playing);
        play.classList.toggle('on', this.player.playing);
        play.title = this.player.playing ? 'Pause (Space)' : 'Play (Space)';
        play.setAttribute('aria-label', this.player.playing ? 'Pause' : 'Play');
      }
      const loop = document.getElementById('btnLoop');
      if (loop) loop.classList.toggle('on', this.player.loop);
    }

    _updateTc() {
      const tc = this.dom.tcInput;
      if (tc && !this._tcEditing) tc.value = OS.timebase.tc(this.player.frame, this.project.fps);
      const dur = this.dom.tcDur;
      if (dur) dur.textContent = OS.timebase.tc(this.player.duration, this.project.fps);
      const btnIn = document.getElementById('btnIn');
      const btnOut = document.getElementById('btnOut');
      if (btnIn) btnIn.classList.toggle('on', this.project.inPoint != null);
      if (btnOut) btnOut.classList.toggle('on', this.project.outPoint != null);
    }

    _wireEvents() {
      this.player.events.on('time', () => {
        this._updateTc();
        if (this.player.playing) this.timeline.ensureVisible(this.player.frame);
      });
      this.player.events.on('state', () => this._syncTransport());
      this.player.events.on('quality', (q) => {
        const sel = this.dom.prQuality;
        if (sel && q === 0.5) sel.value = '0.5';
        else if (sel && q === 0.25) sel.value = '0.25';
      });
      this.events.on('selection-changed', () => { this._updateStatusRight(); this.refreshInspector(); this._syncToolbar(); });
      this.events.on('project-loaded', () => { this._syncTransport(); this._updateTc(); this.timeline.zoomToFit(); this._syncToolbar(); });
      this.commands.onchange.on('change', () => { this._updateStatusRight(); this._syncToolbar(); });
    }

    /* ================= ui loop (meters + stats) ================= */

    _uiLoop() {
      const step = () => {
        requestAnimationFrame(step);
        if (!this._mounted) return;
        this._updateMeters();
        const now = performance.now();
        if (this.statsOn && now - this._statsAt > 220) { this._statsAt = now; this._updateStats(); }
      };
      requestAnimationFrame(step);
    }

    _updateMeters() {
      if (!this.dom.meterL && !this.dom.meterR) return;
      const lv = this.player.playing || this.player._audio ? this.player.getLevels() : { l: 0, r: 0 };
      const pct = (v) => {
        const db = 20 * Math.log10((v || 0) + 1e-6);
        return clamp(((db + 54) / 54) * 100, 0, 100);
      };
      if (this.dom.meterL) this.dom.meterL.style.height = pct(lv.l) + '%';
      if (this.dom.meterR) this.dom.meterR.style.height = pct(lv.r) + '%';
    }

    _updateStatusRight() {
      const sel = this.timeline.getSelectedClips();
      const el2 = this.dom.statusRight;
      if (!el2) return;
      const bits = [];
      /* The status bar names what you are actually working on: the selected
         clip(s) first, since that is the question it answers while editing. */
      if (sel.length === 1) bits.push(sel[0].name || 'Clip');
      else if (sel.length > 1) bits.push(`${sel.length} clips selected`);
      bits.push(`${this.project.tracks.length} tracks`);
      bits.push(`${this.project.assets.length} media`);
      el2.textContent = bits.join(' · ');
    }

    _updateStats() {
      const box = this.dom.statsBox;
      if (!box) return;
      const p = this.project;
      const pw = this.player.canvas.width, ph = this.player.canvas.height;
      const rows = [
        ['FPS', this.player._meter.fps],
        ['Render', (this.player.lastRenderMs || 0).toFixed(1) + ' ms'],
        ['Preview', `${pw}×${ph}`],
        ['Project', `${p.width}×${p.height} @ ${p.fps.rate.toFixed(3).replace(/\.?0+$/, '')} fps`],
        ['Playhead', OS.timebase.tc(this.player.frame, p.fps) + ` (f${this.player.frame})`],
        ['Zoom', (this.timeline.view.pxPerFrame * p.fps).toFixed(1) + ' px/s'],
        ['Engine', ('VideoEncoder' in window) ? 'WebCodecs H.264+AAC' : 'MediaRecorder only'],
        ['Undo', this.commands.done.length + ' / redo ' + this.commands.undone.length],
      ];
      box.innerHTML = rows.map(([k, v]) => `<div class="stat-row"><span>${U.esc(k)}</span><b>${U.esc(String(v))}</b></div>`).join('');
    }

    toggleStats() {
      this.statsOn = !this.statsOn;
      if (this.dom.statsBox) this.dom.statsBox.style.display = this.statsOn ? 'block' : 'none';
      this.setStatus('Stats ' + (this.statsOn ? 'on' : 'off'));
    }

    toggleFullscreenPreview() {
      const node = this.dom.previewWrap || this.dom.preview;
      if (!document.fullscreenElement) {
        (node.requestFullscreen ? node.requestFullscreen() : Promise.reject()).catch(() => this.setStatus('Fullscreen was blocked by the browser'));
      } else document.exitFullscreen();
    }

    /* ================= status / title ================= */

    setStatus(msg) {
      if (!this.dom.statusMsg) return;
      this.dom.statusMsg.textContent = msg || '';
      this.dom.statusMsg.classList.remove('flash');
      void this.dom.statusMsg.offsetWidth;
      this.dom.statusMsg.classList.add('flash');
      clearTimeout(this._statusTimer);
      this._statusTimer = setTimeout(() => { if (this.dom.statusMsg) this.dom.statusMsg.textContent = ''; }, 8000);
    }

    updateTitle() {
      const dirty = this.persist && this.persist.dirty ? ' •' : '';
      const title = `${this.project.name || 'Untitled Project'}${dirty} — OpenScene`;
      document.title = title;
      if (this.dom.docTitle) this.dom.docTitle.textContent = (this.project.name || 'Untitled Project') + dirty;
    }

    setProjectName(name) {
      this.exec(OS.commands.SetProjectProps(this.project, { name }));
      this.updateTitle();
    }

    /* ================= command dispatch ================= */

    exec(cmd, opts = {}) {
      this.commands.exec(cmd);
      this.afterEdit(cmd, opts);
      return cmd;
    }

    /* Run several commands as one undo step. */
    group(label, fn) {
      this.commands.beginGroup(label);
      try { fn(); } finally { this.commands.endGroup(); }
      this.afterEdit({ label });
    }

    afterEdit(cmd, opts = {}) {
      OS.model.normalizeTransitions(this.project);
      this.persist.markDirty();
      this.timeline.requestRedraw();
      this.player.requestRender();
      try { this.player._bindActive(this.player.frame); } catch (e) {}
      if (opts.refreshInspector) this.refreshInspector();
      if (cmd && cmd.label) this.setStatus(cmd.label);
      this.updateTitle();
    }

    touch() { if (this.persist) this.persist.markDirty(); }

    undo() {
      const cmd = this.commands.undo();
      if (!cmd) return;
      this.afterEdit({ label: 'Undo ' + (cmd.label || '') });
      this.refreshInspector();
    }

    redo() {
      const cmd = this.commands.redo();
      if (!cmd) return;
      this.afterEdit({ label: 'Redo ' + (cmd.label || '') });
      this.refreshInspector();
    }

    refreshInspector() {
      const sel = this.timeline.getSelectedClips();
      this.properties.showClip(sel.length === 1 ? sel[0] : null, sel);
    }

    focusProperties() {
      if (this.mobile) this.mobile.focusPane('props');
      this.properties.root.classList.add('focus-flash');
      setTimeout(() => this.properties.root.classList.remove('focus-flash'), 700);
    }

    revealClip(clip) {
      if (!clip) return;
      this.timeline.select(clip);
      this.timeline.ensureVisible(clip.start);
      this.timeline.requestRedraw();
      this.setStatus('Revealed clip ' + (clip.name || ''));
    }

    /* ================= project lifecycle ================= */

    async newProject() {
      if (this.persist.dirty) {
        const ok = await this.dialogs.confirm('New project', 'Discard unsaved changes and start a new project?', { okLabel: 'Discard', danger: true });
        if (!ok) return;
      }
      this.media.disposeAll();
      this.project = M().createProject({ name: 'Untitled Project' });
      this.commands.clear();
      this.player.attach(this.project, this.media);
      this.timeline.selection.clear();
      this.timeline.refreshHeaders();
      this.timeline.zoomToFit();
      this.bin.refresh();
      this.properties.showClip(null, []);
      this.persist.dirty = false;
      this.updateTitle();
      this.setStatus('New project');
    }

    async quit() {
      if (this.persist.dirty) {
        const ok = await this.dialogs.confirm('Quit', 'You have unsaved changes. Quit anyway?', { okLabel: 'Quit', danger: true });
        if (!ok) return;
      }
      try { await this.persist.autosave(); } catch (e) {}
      if (window.openscene && window.openscene.quit) window.openscene.quit();
      else window.close();
    }

    showLicenses() {
      const content = el('div.licenses');
      content.innerHTML = `
        <h4>OpenScene</h4>
        <p>Released under the GNU Affero General Public License v3.0. Copyright © ${new Date().getFullYear()} Sparsh Singhal.
        A commercial licence is available for organisations that cannot accept the AGPL's terms.</p>
        <h4>Third-party components</h4>
        <p>None. OpenScene is written from scratch with no runtime dependencies.
        The timeline, compositor, transitions, titling, audio mixer, the ISO-BMFF (MP4)
        muxer and this entire interface run directly on the browser engine.</p>
        <h4>Local storage</h4>
        <p>Imported media and autosaves are stored in your browser profile using IndexedDB.
        Nothing is uploaded anywhere; every render happens on this machine.</p>`;
      const api = this.dialogs.open('Open-source licences', content, { small: true });
      api.foot.append(el('span.spacer'), this.dialogs.button('Close', () => api.close(), 'primary'));
    }

    async runSelfTest() {
      if (!OS.selftest) { this.dialogs.toast('Self-test module not loaded', 'error'); return; }
      const api = this.dialogs.open('Self-test', el('div.selftest', {}, [el('div.spinner'), el('p', { text: 'Synthesising media and exercising the engine…' })]), { small: true, dismissable: false });
      api.foot.append(el('span.spacer'));
      let res;
      try { res = await OS.selftest.run(this); }
      catch (e) { res = { passed: 0, failed: 1, durationMs: 0, results: [{ name: 'self-test crashed', ok: false, detail: e.message }] }; }
      const body = el('div.selftest');
      body.append(el('div.selftest-head', {}, [
        el('span.badge.' + (res.failed ? 'warn' : 'ok'), { text: `${res.passed} passed · ${res.failed} failed` }),
        el('span.selftest-time', { text: `${(res.durationMs / 1000).toFixed(1)} s` }),
      ]));
      for (const r of res.results) {
        const row = el('div.selftest-row' + (r.ok ? '' : '.fail'));
        const icon = el('span.selftest-icon');
        icon.innerHTML = r.ok ? '<svg viewBox="0 0 10 10" width="9" height="9"><path d="M1.5 5.5l2.2 2.2 4.8-5" stroke="currentColor" stroke-width="1.8" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>' : '<svg viewBox="0 0 10 10" width="9" height="9"><path d="M2 2l6 6M8 2l-6 6" stroke="currentColor" stroke-width="1.8" fill="none" stroke-linecap="round"/></svg>';
        row.append(icon, el('span.selftest-name', { text: r.name }));
        if (r.detail) row.appendChild(el('span.selftest-detail', { text: r.detail }));
        body.appendChild(row);
      }
      api.body.innerHTML = '';
      api.body.appendChild(body);
      api.foot.append(this.dialogs.button('Copy report', () => {
        const txt = res.results.map((r) => `${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.detail ? '  —  ' + r.detail : ''}`).join('\n');
        navigator.clipboard && navigator.clipboard.writeText(txt);
        this.dialogs.toast('Report copied', 'info');
      }), el('span.spacer'), this.dialogs.button('Close', () => api.close(), 'primary'));
      this.setStatus(`Self-test: ${res.passed} passed, ${res.failed} failed`);
      this.dialogs.toast(res.failed ? `Self-test: ${res.failed} check(s) failed` : 'Self-test: all checks passed', res.failed ? 'warn' : 'info', 8000);
      return res;
    }

    /* ================= media ================= */

    async _toFiles(list) {
      const out = [];
      for (const it of list || []) {
        if (typeof File !== 'undefined' && it instanceof File) { out.push(it); continue; }
        if (typeof Blob !== 'undefined' && it instanceof Blob && it.name) { out.push(it); continue; }
        if (it && it.path && this.persist.native) {
          try {
            /* Prefer streaming via object URL so the browser fetches only the
               header bytes for metadata probes. Fall back to readFile if
               streaming isn't available. */
            if (this.persist.native.streamUrl) {
              const url = this.persist.native.streamUrl(it.path);
              if (url) {
                const name = it.name || String(it.path).split(/[\\/]/).pop();
                const type = it.type || (typeof mimeForName === 'function' ? mimeForName(name) : 'application/octet-stream');
                const resp = await fetch(url);
                const blob = await resp.blob();
                const file = new File([blob], name, { type: blob.type || type });
                file._nativePath = it.path;
                out.push(file);
                continue;
              }
            }
            const file = await this.persist.native.readFile(it.path);
            if (file instanceof File) {
              file._nativePath = file._nativePath || it.path;
            } else if (file instanceof Blob) {
              const name = it.name || String(it.path).split(/[\\/]/).pop();
              const f = new File([file], name, { type: it.type || (typeof mimeForName === 'function' ? mimeForName(name) : 'application/octet-stream') });
              f._nativePath = it.path;
              out.push(f);
              continue;
            }
            const name = it.name || String(it.path).split(/[\\/]/).pop();
            out.push(new File([file], name, { type: it.type || (typeof mimeForName === 'function' ? mimeForName(name) : 'application/octet-stream') }));
            out[out.length - 1]._nativePath = it.path;
          } catch (e) { console.warn('[OpenScene] readFile failed', it.path, e); }
        }
      }
      return out;
    }

    async importMedia() {
      try {
        const picked = await this.persist.pickImportFiles();
        const files = await this._toFiles(picked);
        if (!files.length) return;
        await this.importFiles(files);
      } catch (e) {
        console.error(e);
        this.dialogs.toast('Import failed: ' + e.message, 'error');
      }
    }

    async importFiles(files) {
      const list = await this._toFiles(files);
      if (!list.length) return;
      this.setStatus(`Importing ${list.length} file(s)…`);
      const prog = this.dialogs.toast(`Importing ${list.length} item(s)…`, 'info', 60000);
      try {
        const imported = (await this.media.importFiles(list, { tolerant: true })).filter(Boolean);
        if (prog) prog.remove();
        if (!imported.length) { this.dialogs.toast('Nothing could be imported from those files', 'warn', 7000); return; }
        this.group(imported.length > 1 ? `Import ${imported.length} items` : `Import ${imported[0].name}`, () => {
          for (const a of imported) this.commands.execInGroup('Import', OS.commands.AddAsset(this.project, a));
        });
        this.bin.refresh();
        this.setStatus(`Imported ${imported.length} item(s)`);
        this.dialogs.toast(`Imported ${imported.length} item(s)`, 'info', 3500);
        const noDecoder = imported.filter((a) => a.undecodable);
        if (noDecoder.length) {
          this.dialogs.toast(`${noDecoder.length} of them use a codec this build cannot decode; they are kept in the bin so nothing is lost.`, 'warn', 9000);
        }
      } catch (e) {
        if (prog) prog.remove();
        console.error(e);
        this.dialogs.toast('Import failed: ' + e.message, 'error', 8000);
      }
    }

    async importFilesAt(files, track, frame) {
      const list = Array.prototype.slice.call(files || []);
      if (!list.length) return;
      const startFrame = Math.max(0, Math.round(frame || 0));
      const prog = this.dialogs.toast('Importing dropped file(s)…', 'info', 60000);
      try {
        const imported = (await this.media.importFiles(list, { tolerant: true })).filter(Boolean);
        if (prog) prog.remove();
        if (!imported.length) { this.dialogs.toast('Nothing could be imported from those files', 'warn', 7000); return; }

        /* A batch dropped together lands as ONE run of clips on ONE track.
           Choosing a track per file used to scatter the batch across spare
           tracks whenever the drop point touched existing media; instead the
           run starts where there is room and every subsequent clip follows the
           previous one on the same track. Audio-only batches do the same on
           their own audio track, so a mixed drop never interleaves video and
           audio rows. */
        const runs = new Map();     // track.id -> next free frame for that track
        const pickRun = (kind) => {
          if (track && track.kind === kind) return track;
          const free = this._freeTrack(kind);
          if (!free.length) return null;
          /* Join the video/audio row that is already in use at the drop point,
             so a second drop extends the existing edit instead of opening a new
             track. Only when nothing sits there do we take a spare row. */
          const occupied = free.find((t) =>
            M().clipsBetween(this.project, t, startFrame, startFrame + 1).length);
          if (occupied) return occupied;
          const bottomFirst = free.slice().reverse();
          return bottomFirst[0];
        };
        /* First free frame on a track at or after `from`, appending after any
           clip that overlaps the drop point so a batch never buries existing
           media under itself. */
        const roomAfter = (t, from) => {
          const clips = M().clipsOf(this.project, t).slice().sort((a, b) => a.start - b.start);
          let cursor = from;
          for (const c of clips) {
            if (c.start < cursor && M().clipEnd(c) > cursor) cursor = M().clipEnd(c);
          }
          return cursor;
        };

        let last = null;
        this.group(imported.length > 1 ? `Import ${imported.length} items` : `Import ${imported[0].name}`, () => {
          for (const a of imported) {
            this.commands.execInGroup('Import', OS.commands.AddAsset(this.project, a));
            if (a.undecodable) continue;   // no timeline length to honour yet
            const kind = a.kind === 'audio' ? 'audio' : 'video';
            const target = pickRun(kind);
            if (!target) continue;
            const cursor = runs.has(target.id) ? runs.get(target.id) : roomAfter(target, startFrame);
            const len = this.defaultClipLength(a);
            const clip = M().createClip(a, target.id, cursor, len);
            this.commands.execInGroup('Place', OS.commands.AddClips(this.project, [clip]));
            runs.set(target.id, cursor + len);
            last = clip;
          }
        });
        this.bin.refresh();
        if (last) { this.timeline.select(last); this.timeline.ensureVisible(last.start); }
        this.setStatus(`Imported and placed ${imported.length} item(s)`);
      } catch (e) {
        if (prog) prog.remove();
        console.error(e);
        this.dialogs.toast('Import failed: ' + e.message, 'error', 8000);
      }
    }

    defaultClipLength(asset) {
      const fps = this.project.fps.rate;
      if (!asset) return Math.round(fps * 5);
      if (asset.kind === 'image') return Math.round(fps * 5);
      const d = asset.durationFrames || 0;
      if (d > 0) return d;
      return Math.round(fps * 5);
    }

    _freeTrack(kind) {
      const list = this.project.tracks.filter((t) => t.kind === kind && !t.locked && !t.hidden);
      return list;
    }

    _pickTrack(kind, start, len, preferNew = false) {
      const list = this._freeTrack(kind).slice().reverse();   // bottom-most first
      if (!list.length) return null;
      if (preferNew) return list[list.length - 1];
      const free = list.find((t) => !M().clipsBetween(this.project, t, start, start + len).length);
      return free || list[list.length - 1];   // else stack on the top-most video / last audio
    }

    insertAssetAtPlayhead(asset) {
      if (!asset) return;
      const kind = asset.kind === 'audio' ? 'audio' : 'video';
      const start = Math.max(0, this.player.frame);
      const len = this.defaultClipLength(asset);
      let track = this._pickTrack(kind, start, len);
      if (!track) { this.addTrack(kind, true); track = this._pickTrack(kind, start, len); }
      if (!track) { this.dialogs.toast('No ' + kind + ' track available', 'warn'); return; }
      const clip = M().createClip(asset, track.id, start, len);
      this.exec(OS.commands.AddClips(this.project, [clip]));
      this.timeline.select(clip);
      this.timeline.ensureVisible(start);
      this.player.requestRender();
    }

    insertAssetNewTrack(asset) {
      if (!asset) return;
      const kind = asset.kind === 'audio' ? 'audio' : 'video';
      const track = this.addTrack(kind, false, true);
      if (!track) return;
      const start = Math.max(0, this.player.frame);
      const len = this.defaultClipLength(asset);
      const clip = M().createClip(asset, track.id, start, len);
      this.exec(OS.commands.AddClips(this.project, [clip], { name: 'Insert on new track' }));
      this.timeline.select(clip);
      this.player.requestRender();
    }

    relinkAsset(asset) {
      if (asset) this.persist.relinkAsset(asset);
    }

    showAssetInfo(asset) {
      this.properties.showAsset(asset);
      this.focusProperties();
    }

    removeAssets(assets) {
      const used = this.project.tracks.some((t) => M().clipsOf(this.project, t).some((c) => assets.includes(c.assetId)));
      const run = () => this.exec(OS.commands.RemoveAssets(this.project, assets), { refreshInspector: true });
      if (used) {
        this.dialogs.confirm('Remove media', 'This media is used on the timeline. Removing it will also delete those clips. Continue?', { okLabel: 'Remove', danger: true })
          .then((ok) => { if (ok) run(); });
      } else run();
    }

    /* ================= add generators / tracks ================= */

    addTrack(kind, silent = false, selectNew = false) {
      const n = this.project.tracks.filter((t) => t.kind === kind).length + 1;
      const track = M().createTrack(kind, (kind === 'video' ? 'V' : 'A') + n);
      let at;
      if (kind === 'video') at = 0;                                   // new video tracks go on top
      else {
        const lastVideo = this.project.tracks.reduce((acc, t, i) => (t.kind === 'video' ? i : acc), -1);
        at = lastVideo + 1;                                           // audio tracks sit under the video stack
      }
      this.exec(OS.commands.AddTrack(this.project, track, clamp(at, 0, this.project.tracks.length)));
      this.timeline.refreshHeaders();
      if (!silent) {
        this.setStatus(kind === 'audio'
          ? 'Added ' + track.name + ' — drop audio files onto it to place a soundtrack'
          : 'Added ' + track.name + ' — drop video, images or titles onto it');
      }
      if (selectNew) { /* nothing to select yet */ }
      return track;
    }

    addTrackAt(kind, index) {
      const n = this.project.tracks.filter((t) => t.kind === kind).length + 1;
      const track = M().createTrack(kind, (kind === 'video' ? 'V' : 'A') + n);
      this.exec(OS.commands.AddTrack(this.project, track, clamp(index, 0, this.project.tracks.length)));
      this.timeline.refreshHeaders();
      this.setStatus('Added ' + track.name);
      return track;
    }

    moveTrack(track, dir) {
      const i = this.project.tracks.indexOf(track);
      const j = clamp(i + dir, 0, this.project.tracks.length - 1);
      if (i === j) return;
      this.exec(OS.commands.MoveTrack(this.project, track, j));
      this.timeline.refreshHeaders();
      this.timeline.requestRedraw();
      this.setStatus('Moved ' + track.name);
    }

    duplicateTrack(track) {
      if (!track) return;
      const project = this.project;
      const srcClips = M().clipsOf(this.project, track).map((c) => deepClone(c));
      const nt = M().createTrack(track.kind, track.name + ' copy');
      const clones = srcClips.map((c) => { c.id = uid('clp'); c.trackId = nt.id; return c; });
      const index = project.tracks.indexOf(track) + 1;
      this.exec({
        label: 'Duplicate track ' + track.name,
        do() {
          const at = clamp(index, 0, project.tracks.length);
          if (project.tracks.indexOf(nt) < 0) project.tracks.splice(at, 0, nt);
          for (const c of clones) M().insertClip(project, c);
        },
        undo() {
          for (const c of clones) M().removeClip(project, c);
          const i = project.tracks.indexOf(nt);
          if (i >= 0) project.tracks.splice(i, 1);
        },
      });
      this.timeline.refreshHeaders();
      this.setStatus('Duplicated ' + track.name);
    }

    menuAddTrack(e) {
      const rect = e && e.target ? e.target.getBoundingClientRect() : { left: 20, bottom: 100 };
      this.dialogs.contextMenu(rect.left, rect.bottom + 2, [
        { label: 'Add video track', hint: 'Ctrl+Shift+V', action: () => this.addTrack('video') },
        { label: 'Add audio track', hint: 'Ctrl+Shift+A', action: () => this.addTrack('audio') },
      ]);
    }

    renameTrack(track) {
      if (!track) return;
      const v = prompt('Track name', track.name);
      if (v == null || !v.trim()) return;
      this.exec(OS.commands.SetTrackProps(this.project, track, { name: v.trim().slice(0, 24) }, { name: 'Rename track' }));
      this.timeline.refreshHeaders();
    }

    deleteTrack(track) {
      if (!track) return;
      const count = M().clipsOf(this.project, track).length;
      const go = () => { this.exec(OS.commands.RemoveTrack(this.project, track)); this.timeline.selection.clear(); this.timeline.refreshHeaders(); this.setStatus('Deleted ' + track.name); };
      if (count) this.dialogs.confirm('Delete track', `${track.name} holds ${count} clip(s). Delete the track and its clips?`, { okLabel: 'Delete', danger: true }).then((ok) => ok && go());
      else go();
    }

    addTitleClip(presetId) {
      const preset = OS.titles.PRESETS.find((p) => p.id === presetId) || OS.titles.PRESETS[0];
      const params = { ...OS.titles.defaultParams(), ...(preset ? preset.params : {}) };
      this._addGenerator('title', params, Math.round(this.project.fps.rate * 5), preset ? preset.name : 'Title');
    }

    addGeneratorClip(kind) {
      const params = kind === 'gradient'
        ? { color: '#1460ff', color2: '#0a0f1a', angle: 45 }
        : { color: '#1460ff' };
      this._addGenerator(kind, params, Math.round(this.project.fps.rate * 5), kind === 'gradient' ? 'Gradient' : 'Colour');
    }

    /* An adjustment layer grades every track beneath it. It lives on its own
       video track above the stack so it never collides with real footage. */
    addAdjustmentClip() {
      const start = Math.max(0, this.player.frame);
      const len = Math.max(1, this.project.outPoint != null && this.project.inPoint != null
        ? this.project.outPoint - this.project.inPoint
        : Math.round(this.project.fps.rate * 5));
      let track = this._pickTrack('video', start, len);
      if (!track) { this.addTrack('video', true); track = this._pickTrack('video', start, len); }
      if (!track) { this.dialogs.toast('No video track available', 'warn'); return; }
      const clip = M().createAdjustmentClip(track.id, start, len);
      this.exec(OS.commands.AddClips(this.project, [clip], { name: 'Add adjustment layer' }));
      this.timeline.select(clip);
      this.timeline.ensureVisible(start);
      this.player.requestRender();
      this.setStatus('Adjustment layer added — add effects to grade the tracks below');
      this.dialogs.toast('Add effects to the adjustment layer to grade everything beneath it', 'info', 4200);
    }

    setBlendMode(mode, clips) {
      const targets = (clips || this._sel()).filter((c) => !this._locked(c));
      if (!targets.length) return;
      this._setClipPath(targets, 'blend', mode, 'Blend: ' + M().blendLabel(mode));
      this.player.requestRender();
      this.setStatus('Blend mode: ' + M().blendLabel(mode));
    }

    _setClipPath(clips, path, value, name) {
      const edits = clips.map((c) => ({ clip: c, values: { [path]: value } }));
      this.exec(OS.commands.SetClipProps(this.project, edits, { name }));
    }

    /* ================= grouping ================= */

    groupSelection() {
      const sel = this._sel().filter((c) => !this._locked(c));
      if (sel.length < 2) { this.dialogs.toast('Select two or more clips to group', 'warn'); return; }
      this._setClipPath(sel, 'groupId', uid('grp'), 'Group ' + sel.length + ' clips');
      this.timeline.requestRedraw();
      this.setStatus(sel.length + ' clips grouped');
    }

    ungroupSelection() {
      const sel = this._sel();
      const grouped = sel.filter((c) => c.groupId);
      if (!grouped.length) {
        // fall back to the whole project so "Ungroup all" works from anywhere
        const all = this.project.tracks.flatMap((t) => M().clipsOf(this.project, t)).filter((c) => c.groupId);
        if (!all.length) { this.dialogs.toast('Nothing is grouped', 'warn'); return; }
        this._setClipPath(all, 'groupId', null, 'Ungroup all');
        this.timeline.requestRedraw();
        this.setStatus('All groups removed');
        return;
      }
      this._setClipPath(grouped, 'groupId', null, 'Ungroup ' + grouped.length + ' clips');
      this.timeline.requestRedraw();
      this.setStatus('Ungrouped');
    }

    _addGenerator(kind, params, len, label) {
      const start = Math.max(0, this.player.frame);
      let track = this._pickTrack('video', start, len);
      if (!track) { this.addTrack('video', true); track = this._pickTrack('video', start, len); }
      if (!track) { this.dialogs.toast('No video track available', 'warn'); return; }
      const clip = M().createGeneratorClip(kind, track.id, start, len, params);
      this.exec(OS.commands.AddClips(this.project, [clip], { name: 'Add ' + label }));
      this.timeline.select(clip);
      this.timeline.ensureVisible(start);
      this.player.requestRender();
    }

    /* ================= markers ================= */

    addMarkerAtPlayhead() {
      const frame = Math.max(0, this.player.frame);
      const marker = { id: uid('mk'), frame, name: '', color: '#ffd23f' };
      this.exec(OS.commands.AddMarker(this.project, marker));
      this.timeline.requestRedraw();
      this.setStatus('Marker added at ' + OS.timebase.tc(frame, this.project.fps));
    }

    /* ================= clip speed ================= */

    /* Ask for a speed and a retime mode, then apply both as one undoable edit.
       Speed and length have to change together atomically: setting one without
       the other would momentarily leave the clip claiming more source than it
       has, and normalizeTransitions() would then trim it unpredictably. */
    async changeClipSpeed(clips) {
      const targets = (clips || this._sel()).filter((c) => !this._locked(c));
      if (!targets.length) { this.dialogs.toast('Select a clip to change its speed', 'warn'); return; }

      /* Generators have no source media, so length is not derived from speed. */
      const timed = targets.filter((c) => !c.generator);
      if (!timed.length) { this.dialogs.toast('That clip has no source media to retime', 'warn'); return; }

      const answer = await this.dialogs.changeSpeed(
        timed.map((c) => ({ clip: c, length: c.length })),
        { fps: this.project.fps },
      );
      if (!answer) return;

      const { speed, mode } = answer;
      const edits = [];
      for (const c of timed) {
        const values = { speed };
        if (mode === 'retime') {
          /* Length follows speed so the same slice of source keeps playing.
             The source frames in use are length * oldSpeed; new length is that
             divided by the new speed. */
          const srcLen = c.length * (c.speed || 1);
          let len = Math.max(M().MIN_CLIP_FRAMES, Math.round(srcLen / speed));
          /* Never claim more source than the asset actually has. */
          if (c.assetId) {
            const asset = M().findAsset(this.project, c.assetId);
            if (asset && asset.durationFrames) {
              const maxLen = Math.max(M().MIN_CLIP_FRAMES,
                Math.round((asset.durationFrames - c.inPoint) / speed));
              len = Math.min(len, maxLen);
            }
          }
          values.length = len;
        }
        edits.push({ clip: c, values });
      }

      this.exec(OS.commands.SetClipProps(this.project, edits, {
        name: speed === 1 ? 'Reset clip speed' : 'Clip speed ' + speed + 'x',
      }), { refreshInspector: true });
      this.timeline.requestRedraw();
      this.player.requestRender();
      this.setStatus(speed === 1
        ? 'Clip speed reset to 1x'
        : timed.length + (timed.length === 1 ? ' clip' : ' clips') + ' at ' + speed + 'x' +
          (mode === 'retime' ? ', retimed' : ', length kept'));
    }

    /* ================= selection editing ================= */

    _sel() { return this.timeline.getSelectedClips(); }

    splitAtPlayhead() {
      const f = this.player.frame;
      let targets = this._sel().filter((c) => f > c.start && f < M().clipEnd(c) && !this._locked(c));
      if (!targets.length) targets = this._allClipsAt(f);
      this._splitClips(targets, f);
    }

    splitAllAtPlayhead() {
      this._splitClips(this._allClipsAt(this.player.frame), this.player.frame);
    }

    _allClipsAt(f) {
      const out = [];
      for (const t of this.project.tracks) {
        if (t.locked) continue;
        const c = M().clipsOf(this.project, t).find((cl) => f > cl.start && f < M().clipEnd(cl));
        if (c) out.push(c);
      }
      return out;
    }

    _splitClips(clips, f) {
      if (!clips.length) { this.setStatus('Nothing to split at the playhead'); return; }
      const created = [];
      this.commands.beginGroup('Split');
      for (const c of clips) {
        const cmd = OS.commands.SplitClip(this.project, c, f);
        this.commands.execInGroup('Split', cmd);
        created.push(cmd._right);
      }
      this.commands.endGroup();
      this.afterEdit({ label: clips.length === 1 ? 'Split clip' : `Split ${clips.length} clips` });
      this.timeline.selection = new Set(created.filter(Boolean).map((c) => c.id));
      this.timeline._emitSel();
      this.refreshInspector();
    }

    _locked(clip) { const t = M().findTrack(this.project, clip.trackId); return !!(t && t.locked); }

    liftSelection() {
      const sel = this._sel().filter((c) => !this._locked(c));
      if (!sel.length) return;
      this.exec(OS.commands.RemoveClips(this.project, sel));
      this.timeline.clearSelection();
    }

    rippleDeleteSelection() {
      const sel = this._sel().filter((c) => !this._locked(c));
      if (!sel.length) return;
      this.exec(OS.commands.RippleRemoveClips(this.project, sel));
      this.timeline.clearSelection();
    }

    copySelection() {
      const sel = this._sel();
      if (!sel.length) return;
      this.clipboard = sel.map((c) => {
        const copy = deepClone(c);
        delete copy.id;
        return copy;
      });
      this.setStatus(`Copied ${sel.length} clip(s)`);
    }

    cutSelection() {
      this.copySelection();
      this.liftSelection();
      this.setStatus('Cut to clipboard');
    }

    pasteAtPlayhead() {
      if (!this.clipboard || !this.clipboard.length) return;
      const f = Math.max(0, this.player.frame);
      const minStart = Math.min(...this.clipboard.map((c) => c.start));
      const created = [];
      for (const src of this.clipboard) {
        const c = deepClone(src);
        c.id = uid('clp');
        const offset = src.start - minStart;
        const track = this._trackForPaste(src, c);
        if (!track) continue;
        c.trackId = track.id;
        c.start = f + offset;
        created.push(c);
      }
      if (!created.length) return;
      this.exec(OS.commands.AddClips(this.project, created, { name: 'Paste' }));
      this.timeline.selection = new Set(created.map((c) => c.id));
      this.timeline._emitSel();
      this.player.requestRender();
    }

    _trackForPaste(src, c) {
      const wantKind = this._kindOfClip(src);
      const list = this._freeTrack(wantKind).slice().reverse();
      if (!list.length) {
        const t = this.addTrack(wantKind, true, true);
        return t;
      }
      const same = list.find((t) => t.id === src.trackId);
      if (same && !t_overlap(this.project, same, c.start, c.length)) return same;
      const free = list.find((t) => !M().clipsBetween(this.project, t, c.start, c.start + c.length).length);
      return free || list[list.length - 1];
    }

    _kindOfClip(clip) {
      if (clip.generator) return 'video';
      const a = M().findAsset(this.project, clip.assetId);
      return a && a.kind === 'audio' ? 'audio' : 'video';
    }

    duplicateSelection() {
      const sel = this._sel();
      if (!sel.length) return;
      const created = sel.map((c) => {
        const copy = deepClone(c);
        copy.id = uid('clp');
        copy.start = M().clipEnd(c);
        return copy;
      });
      this.exec(OS.commands.AddClips(this.project, created, { name: 'Duplicate clips' }));
      this.timeline.selection = new Set(created.map((c) => c.id));
      this.timeline._emitSel();
    }

    moveSelectionTrack(dir) {
      const sel = this._sel();
      if (!sel.length) return;
      const positions = [];
      for (const c of sel) {
        const idx = this.project.tracks.indexOf(M().findTrack(this.project, c.trackId));
        let j = idx + dir;
        while (j >= 0 && j < this.project.tracks.length) {
          const t = this.project.tracks[j];
          if (t.kind === this._kindOfClip(c) && !t.locked) { positions.push({ clip: c, start: c.start, trackId: t.id }); break; }
          j += dir;
        }
      }
      if (!positions.length) { this.setStatus('No ' + (dir < 0 ? 'higher' : 'lower') + ' track of the same type'); return; }
      this.exec(OS.commands.MoveClips(this.project, positions));
    }

    adjustVolume(delta) {
      const sel = this._sel();
      if (!sel.length) return;
      const edits = sel.map((c) => ({ clip: c, values: { volume: clamp((c.volume || 1) + delta, 0, 3) } }));
      this.exec(OS.commands.SetClipProps(this.project, edits, { name: 'Adjust volume' }), { refreshInspector: true });
    }

    trimSelectedToPlayhead(side) {
      const f = this.player.frame;
      const sel = this._sel();
      if (!sel.length) return;
      const edits = [];
      for (const c of sel) {
        if (side === 'in') {
          if (f <= c.start || f >= M().clipEnd(c)) continue;
          const delta = f - c.start;
          edits.push({ clip: c, values: { start: f, inPoint: c.inPoint + Math.round(delta * (c.speed || 1)), length: c.length - delta }, prev: { start: c.start, inPoint: c.inPoint, length: c.length } });
        } else {
          if (f <= c.start || f > M().clipEnd(c)) continue;
          edits.push({ clip: c, values: { length: f - c.start }, prev: { length: c.length } });
        }
      }
      if (!edits.length) { this.setStatus('Move the playhead inside a selected clip'); return; }
      this.exec(OS.commands.SetClipProps(this.project, edits, { name: 'Trim to playhead' }), { refreshInspector: true });
    }

    alignSelected(where) {
      const sel = this._sel();
      if (!sel.length) return;
      const f = this.player.frame;
      const positions = sel.map((c) => ({ clip: c, start: where === 'end' ? Math.max(0, f - c.length) : f, trackId: c.trackId }));
      this.exec(OS.commands.MoveClips(this.project, positions, { name: 'Align clips' }));
    }

    /* ---------- professional trims ---------- */

    /* Roll the boundary between a clip and the one before it. Snaps to the
       playhead when it is parked on the join, otherwise nudges by one frame. */
    rollEdit(clip, dir = 1) {
      const track = M().findTrack(this.project, clip.trackId);
      const prev = track ? M().prevClip(track, clip) : null;
      if (!prev) { this.dialogs.toast('No previous clip on this track to roll against', 'warn'); return; }
      const f = this.player.frame;
      const lo = Math.min(prev.start, clip.start) + 1;
      const hi = Math.max(M().clipEnd(prev), M().clipEnd(clip)) - 1;
      const target = f > lo && f < hi ? f : M().clipEnd(prev) + dir;
      this.exec(OS.commands.RollEdit(this.project, prev, clip, target, { name: 'Roll edit' }));
      this.timeline.requestRedraw();
      this.player.requestRender();
      this.setStatus('Roll edit — join now at ' + OS.timebase.tc(M().clipEnd(prev), this.project.fps));
    }

    /* Slide the source window inside a clip (the clip keeps its place). */
    slipClip(clip, delta) {
      if (!clip) return;
      const cmd = OS.commands.SlipClip(this.project, clip, delta, { name: 'Slip clip' });
      if (!cmd) return;
      this.exec(cmd);
      this.timeline.requestRedraw();
      this.player.requestRender();
      this.setStatus('Slipped source by ' + (delta > 0 ? '+' : '') + delta + ' frames');
    }

    /* Slide a clip between its neighbours, keeping the sequence length fixed. */
    slideClip(clip, delta) {
      if (!clip) return;
      const cmd = OS.commands.SlideClip(this.project, clip, delta, { name: 'Slide clip' });
      if (!cmd) { this.dialogs.toast('The clip cannot slide any further', 'warn'); return; }
      this.exec(cmd);
      this.timeline.requestRedraw();
      this.player.requestRender();
      this.setStatus('Slid clip ' + (delta > 0 ? 'right' : 'left'));
    }

    /* ---------- audio finishing ---------- */

    /* Peak-normalise clips to just under full scale, measured from the waveform
       peaks the media store already computes for the timeline. */
    async normalizeAudio(clips, opts = {}) {
      const targets = (clips || this._sel()).filter((c) => {
        if (c.generator || c.adjustment) return false;
        const a = M().findAsset(this.project, c.assetId);
        return !!a && a.kind !== 'image' && (a.kind !== 'video' || !!a.hasAudio);
      });
      if (!targets.length) { this.dialogs.toast('No audio clips in the selection', 'warn'); return; }
      const target = opts.target == null ? 0.891 : clamp(opts.target, 0.05, 1);   // -1 dBFS
      const fps = this.project.fps.rate;

      await Promise.all(targets.map(async (c) => {
        if (!this.media.peaks(c.assetId)) await this.media.ensurePeaks(c.assetId).catch(() => null);
      }));

      const edits = [];
      let done = 0;
      for (const c of targets) {
        const res = this.media.peaks(c.assetId);
        if (!res || !res.peaks || !res.buckets || !res.duration) continue;
        const speed = c.speed || 1;
        const srcStart = c.inPoint / fps;
        const srcLen = (Math.max(1, c.length) - 1) * speed / fps;
        const b0 = clamp(Math.floor((srcStart / res.duration) * res.buckets), 0, res.buckets - 1);
        const b1 = clamp(Math.ceil(((srcStart + srcLen) / res.duration) * res.buckets), b0 + 1, res.buckets);
        let peak = 0;
        for (let b = b0; b < b1; b++) {
          peak = Math.max(peak, Math.abs(res.peaks[b * 2]), Math.abs(res.peaks[b * 2 + 1]));
        }
        if (peak <= 0.0005) continue;                    // silent or unreadable
        const gain = clamp(target / peak, 0.05, 4);
        const next = Math.round(gain * 1000) / 1000;
        if (Math.abs(next - c.volume) < 0.002) continue;
        edits.push({ clip: c, values: { volume: next } });
        done++;
      }
      if (!edits.length) { this.setStatus('Those clips are already at the target level'); return; }
      this.exec(OS.commands.SetClipProps(this.project, edits, { name: 'Normalise audio' }));
      this.player.requestRender();
      this.setStatus('Normalised ' + done + ' clip' + (done === 1 ? '' : 's') + ' to ' + (20 * Math.log10(target)).toFixed(1) + ' dBFS');
    }

    distributeSelected() {
      const sel = this._sel().slice().sort((a, b) => a.start - b.start);
      if (sel.length < 3) return;
      const first = sel[0], last = sel[sel.length - 1];
      const gap = (M().clipEnd(last) - first.start - sel.reduce((s, c) => s + c.length, 0)) / (sel.length - 1);
      let x = first.start;
      const positions = [];
      for (let i = 0; i < sel.length; i++) {
        positions.push({ clip: sel[i], start: Math.round(x), trackId: sel[i].trackId });
        x += sel[i].length + gap;
      }
      this.exec(OS.commands.MoveClips(this.project, positions, { name: 'Distribute clips' }));
    }

    resetTransform(clips) {
      const edits = clips.map((c) => ({
        clip: c,
        values: { transform: { x: 0, y: 0, scale: 1, rotation: 0 }, crop: { l: 0, t: 0, r: 0, b: 0 } },
      }));
      this.exec(OS.commands.SetClipProps(this.project, edits, { name: 'Reset transform' }), { refreshInspector: true });
    }

    clearEffects(clips) {
      this.group('Clear effects', () => {
        for (const c of clips) for (const fx of [...c.effects]) this.commands.execInGroup('Clear effects', OS.commands.RemoveEffect(this.project, c, fx));
      });
      this.refreshInspector();
    }

    toggleReverse(clip) {
      this.exec(OS.commands.SetClipProps(this.project, [{ clip, values: { reverse: !clip.reverse } }], { name: 'Reverse clip' }), { refreshInspector: true });
    }

    /* ================= transitions ================= */

    addTransitionToClip(clip, type) {
      if (!clip) return;
      const project = this.project;                       // captured: `this` differs inside do()/undo()
      const track = M().findTrack(project, clip.trackId);
      const prev = track ? M().prevClip(track, clip) : null;
      if (!prev) { this.dialogs.toast('No previous clip on this track to transition from', 'warn'); return; }
      const desired = clamp(Math.round(clip.length * 0.15), 1, Math.max(1, Math.min(prev.length - 1, clip.length - 1)));
      const prevEnd = M().clipEnd(prev);
      const newStart = prevEnd - desired;      // create the overlap by sliding this clip left
      const overlap = prevEnd - newStart;
      const before = { start: clip.start, transitionIn: clip.transitionIn };
      const prevLen = prev.length;
      const kind = type || (clip.transitionIn && clip.transitionIn.type) || 'dissolve';
      this.exec({
        label: 'Add transition',
        do() {
          clip.start = Math.max(0, newStart);
          if (prev.length < overlap) prev.length = overlap;
          clip.transitionIn = { type: kind, length: overlap };
          M().sortClips(track); M().normalizeTransitions(project);
        },
        undo() {
          clip.start = before.start;
          clip.transitionIn = before.transitionIn;
          prev.length = prevLen;
          M().sortClips(track); M().normalizeTransitions(project);
        },
      });
      this.timeline.select(clip);
      this.setStatus('Transition: ' + OS.transitions.labelOf(kind));
      this.refreshInspector();
    }

    applyTransitionToSelection(type) {
      const sel = this._sel();
      if (!sel.length) { this.dialogs.toast('Select a clip first, then double-click a transition', 'warn'); return; }
      let ok = 0;
      for (const clip of sel) {
        const track = M().findTrack(this.project, clip.trackId);
        const prev = track ? M().prevClip(track, clip) : null;
        if (prev) ok++;
      }
      if (!ok) { this.dialogs.toast('The selected clip(s) have no previous clip on their track', 'warn'); return; }
      this.group('Apply transition', () => {
        for (const clip of sel) this.addTransitionToClip(clip, type);
      });
      this.refreshInspector();
    }

    applyTransitionAtPlayhead(type) {
      const f = Math.max(0, this.player.frame);
      let clip = this._sel()[0] || null;
      if (!clip) {
        const tol = Math.round(this.project.fps.rate * 0.75);
        for (const t of this.project.tracks) {
          if (t.kind !== 'video') continue;
          const cand = M().clipsOf(this.project, t).find((c) => Math.abs(c.start - f) <= tol);
          if (cand) { clip = cand; break; }
        }
      }
      if (!clip) { this.dialogs.toast('No clip near the playhead to transition', 'warn'); return; }
      this.addTransitionToClip(clip, type);
    }

    /* ================= effects ================= */

    applyEffectToClip(clip, type) {
      if (!clip) return;
      const reg = OS.effects.registry[type];
      if (!reg) return;
      const fx = M().createEffect(type);
      this.exec(OS.commands.AddEffect(this.project, clip, fx), { refreshInspector: true });
      this.setStatus('Applied ' + reg.label);
    }

    applyEffectToSelection(type) {
      const sel = this._sel();
      if (!sel.length) { this.dialogs.toast('Select a clip first, then double-click an effect', 'warn'); return; }
      this.group('Add effect', () => {
        for (const clip of sel) this.commands.execInGroup('Add effect', OS.commands.AddEffect(this.project, clip, M().createEffect(type)));
      });
      this.refreshInspector();
      const reg = OS.effects.registry[type] || { label: type };
      this.setStatus('Applied ' + reg.label + ' to ' + sel.length + ' clip' + (sel.length === 1 ? '' : 's'));
    }

    applyEffectAtPlayhead(type) {
      const f = Math.max(0, this.player.frame);
      let clip = this._sel()[0] || null;
      if (!clip) {
        for (const t of this.project.tracks) {
          const cand = M().clipsOf(this.project, t).find((c) => f >= c.start && f < M().clipEnd(c));
          if (cand) { clip = cand; break; }
        }
      }
      if (!clip) { this.dialogs.toast('No clip under the playhead', 'warn'); return; }
      this.timeline.select(clip);
      this.applyEffectToSelection(type);
    }

    /* ================= drops from the library panels ================= */

    /* Assets dropped from Project Files land at the exact frame + track. */
    placeAssetAt(asset, track, frame) {
      if (!asset) return;
      const kind = asset.kind === 'audio' ? 'audio' : 'video';
      const start = Math.max(0, Math.round(frame || 0));
      const len = this.defaultClipLength(asset);
      let target = track && track.kind === kind ? track : null;
      if (!target) target = this._pickTrack(kind, start, len);
      if (!target) { this.addTrack(kind, true); target = this._pickTrack(kind, start, len); }
      if (!target) { this.dialogs.toast('No ' + kind + ' track available', 'warn'); return; }
      const clip = M().createClip(asset, target.id, start, len);
      this.exec(OS.commands.AddClips(this.project, [clip], { name: 'Place ' + asset.name }), { refreshInspector: true });
      this.timeline.select(clip);
      this.timeline.ensureVisible(start);
      this.player.requestRender();
    }

    /* Effects / transitions dropped onto a timeline clip. */
    placeEffectOnClip(clip, type) {
      if (!clip) { this.dialogs.toast('Drop an effect onto a clip', 'warn'); return; }
      this.timeline.select(clip);
      this.applyEffectToSelection(type);
    }

    placeTransitionOnClip(clip, type) {
      if (!clip) { this.dialogs.toast('Drop a transition onto a clip', 'warn'); return; }
      this.timeline.select(clip);
      this.addTransitionToClip(clip, type);
    }


    /* ================= clip generators ================= */

    async freezeFrame(clip) {
      const frame = this.player.frame;
      const inRange = frame >= clip.start && frame <= M().clipEnd(clip);
      const f = inRange ? frame : clip.start;
      try {
        const still = await OS.export.exportStill(this.project, this.media, f, { type: 'image/png' });
        const name = `Freeze ${OS.timebase.tc(f, this.project.fps).replace(/:/g, '-')}.png`;
        const file = new File([still], name, { type: 'image/png' });
        const [asset] = await this.media.importFiles([file], { tolerant: true });
        if (!asset) throw new Error('could not create the still');
        const len = Math.round(this.project.fps.rate * 3);
        const track = this._pickTrack('video', clip.start, len) || M().findTrack(this.project, clip.trackId);
        const stillClip = M().createClip(asset, track.id, clip.start, len);
        this.group('Freeze frame', () => {
          this.commands.execInGroup('Freeze frame', OS.commands.AddAsset(this.project, asset));
          this.commands.execInGroup('Freeze frame', OS.commands.AddClips(this.project, [stillClip]));
        });
        this.timeline.select(stillClip);
        this.setStatus('Freeze frame added');
      } catch (e) {
        console.error(e);
        this.dialogs.toast('Freeze frame failed: ' + e.message, 'error');
      }
    }

    detachAudio(clip) {
      if (clip.generator) return;
      const asset = M().findAsset(this.project, clip.assetId);
      if (!asset || !asset.hasAudio) { this.dialogs.toast('This clip has no audio to detach', 'warn'); return; }
      let audioTrack = this.project.tracks.filter((t) => t.kind === 'audio' && !t.locked)[0];
      if (!audioTrack) audioTrack = this.addTrack('audio', true, true);
      const audioClip = deepClone(clip);
      audioClip.id = uid('clp');
      audioClip.trackId = audioTrack.id;
      audioClip.effects = clip.effects.filter((fx) => (OS.effects.registry[fx.type] || {}).category === 'audio').map((fx) => deepClone(fx));
      const videoTrack = M().findTrack(this.project, clip.trackId);
      const beforeVolume = clip.volume;
      const project = this.project;                        // captured: `this` differs inside do()/undo()
      this.exec({
        label: 'Detach audio',
        do() {
          clip.volume = 0;
          if (videoTrack) { /* keep video-only */ }
          M().insertClip(project, audioClip);
          M().normalizeTransitions(project);
        },
        undo() {
          clip.volume = beforeVolume;
          M().removeClip(project, audioClip);
          M().normalizeTransitions(project);
        },
      });
      this.timeline.select(audioClip);
      this.setStatus('Audio detached to ' + audioTrack.name);
    }

    /* ================= in / out ================= */

    setInPoint() {
      const f = this.player.frame;
      this.exec(OS.commands.SetProjectProps(this.project, { inPoint: f, outPoint: (this.project.outPoint != null && this.project.outPoint <= f) ? null : this.project.outPoint }, { name: 'Set in point' }));
      this._updateTc();
      this.timeline.requestRedraw();
    }

    setOutPoint() {
      const f = this.player.frame;
      this.exec(OS.commands.SetProjectProps(this.project, { outPoint: f, inPoint: (this.project.inPoint != null && this.project.inPoint >= f) ? null : this.project.inPoint }, { name: 'Set out point' }));
      this._updateTc();
      this.timeline.requestRedraw();
    }

    clearInOut(inOnly, outOnly) {
      const values = {};
      if (!outOnly) values.inPoint = null;
      if (!inOnly) values.outPoint = null;
      this.exec(OS.commands.SetProjectProps(this.project, values, { name: 'Clear in/out' }));
      this._updateTc();
      this.timeline.requestRedraw();
    }

    /* ================= context menus (called by Timeline) ================= */

    clipContextMenu(x, y, clip) {
      const sel = this._sel();
      const multi = sel.length > 1;
      const asset = clip.assetId ? M().findAsset(this.project, clip.assetId) : null;
      const track = M().findTrack(this.project, clip.trackId);
      const prev = track ? M().prevClip(track, clip) : null;
      const items = [
        { label: multi ? `Split ${sel.length} clips here` : 'Split here', hint: 'S', action: () => this.splitAtPlayhead() },
        { label: 'Duplicate', hint: 'Ctrl+D', action: () => this.duplicateSelection() },
        { label: 'Copy', hint: 'Ctrl+C', action: () => this.copySelection() },
        { sep: true },
        { label: 'Add transition with previous clip', disabled: !prev, action: () => this.addTransitionToClip(clip) },
        { label: clip.transitionIn ? 'Remove transition' : 'Transition options…', action: () => {
          if (clip.transitionIn) {
            const before = deepClone(clip.transitionIn);
            this.exec({ label: 'Remove transition', do() { clip.transitionIn = null; }, undo() { clip.transitionIn = before; } });
          }
          this.timeline.select(clip); this.properties.showClip(clip); this.focusProperties();
        } },
        { sep: true },
        { label: 'Properties', action: () => { this.timeline.select(clip); this.properties.showClip(clip); this.focusProperties(); } },
      ];
      if (clip.generator) items.push({ label: 'Title / generator', action: () => { this.timeline.select(clip); this.properties.showClip(clip); this.focusProperties(); } });
      if (asset) items.push({ label: 'Media info', action: () => this.showAssetInfo(asset) });
      items.push(
        { sep: true },
        { label: 'Detach audio', disabled: !asset || !asset.hasAudio, action: () => this.detachAudio(clip) },
        { label: 'Freeze frame', action: () => this.freezeFrame(clip) },
        { label: clip.reverse ? 'Play forward' : 'Reverse', action: () => this.toggleReverse(clip) },
        { label: 'Reset transform', action: () => this.resetTransform([clip]) },
      );
      items.push(
        { sep: true },
        { label: 'Move up a track', hint: 'Alt+↑', action: () => this.moveSelectionTrack(-1) },
        { label: 'Move down a track', hint: 'Alt+↓', action: () => this.moveSelectionTrack(1) },
        { sep: true },
        { label: 'Lift (delete)', hint: 'Delete', danger: true, action: () => this.liftSelection() },
        { label: 'Ripple delete', hint: 'Shift+Delete', danger: true, action: () => this.rippleDeleteSelection() },
      );
      this.dialogs.contextMenu(x, y, items);
    }

    transitionContextMenu(x, y, clip) {
      const tin = clip.transitionIn;
      if (!tin) return;
      const items = [{ label: 'Transition: ' + OS.transitions.labelOf(tin.type), disabled: true, action: null }, { sep: true }];
      items.push({ label: 'Change type', submenu: OS.transitions.TYPES.map(([k, label]) => ({ label, checked: k === tin.type, action: () => { const before = tin.type; this.exec({ label: 'Transition type', do() { tin.type = k; }, undo() { tin.type = before; } }); this.refreshInspector(); } })) });
      items.push(
        { label: 'Length — shortest', action: () => this._setTransitionLength(clip, Math.max(1, Math.round(clip.length * 0.05))) },
        { label: 'Length — 10%', action: () => this._setTransitionLength(clip, Math.max(1, Math.round(clip.length * 0.1))) },
        { label: 'Length — 25%', action: () => this._setTransitionLength(clip, Math.max(1, Math.round(clip.length * 0.25))) },
        { sep: true },
        { label: 'Remove transition', danger: true, action: () => { const before = deepClone(tin); this.exec({ label: 'Remove transition', do() { clip.transitionIn = null; }, undo() { clip.transitionIn = before; } }); } },
      );
      this.dialogs.contextMenu(x, y, items);
    }

    _setTransitionLength(clip, len) {
      const track = M().findTrack(this.project, clip.trackId);
      const prev = track ? M().prevClip(track, clip) : null;
      const ov = prev ? M().overlapOf(prev, clip) : clip.transitionIn.length;
      const n = clamp(len, 1, Math.max(1, ov));
      const before = clip.transitionIn.length;
      this.exec(OS.commands.SetClipProps(this.project, [{ clip, values: { 'transitionIn.length': n }, prev: { 'transitionIn.length': before } }], { name: 'Transition length' }), { refreshInspector: true });
    }

    markerContextMenu(x, y, marker) {
      this.dialogs.contextMenu(x, y, [
        { label: 'Go to marker', action: () => this.player.seekTo(marker.frame, { resume: false }) },
        { label: 'Rename marker…', action: () => { const v = prompt('Marker name', marker.name || ''); if (v != null) this.exec(OS.commands.SetMarker(this.project, marker, { name: v })); } },
        { sep: true },
        { label: 'Set in point', action: () => { this.player.seekTo(marker.frame, { resume: false }); this.setInPoint(); } },
        { label: 'Set out point', action: () => { this.player.seekTo(marker.frame, { resume: false }); this.setOutPoint(); } },
        { sep: true },
        { label: 'Remove marker', danger: true, action: () => this.exec(OS.commands.RemoveMarker(this.project, marker)) },
      ]);
    }

    rulerContextMenu(x, y, frame) {
      this.dialogs.contextMenu(x, y, [
        { label: 'Go here', action: () => this.player.seekTo(Math.round(frame), { resume: false }) },
        { label: 'Add marker here', action: () => { this.player.seekTo(Math.round(frame), { resume: false }); this.addMarkerAtPlayhead(); } },
        { sep: true },
        { label: 'Set in point', action: () => { this.player.seekTo(Math.round(frame), { resume: false }); this.setInPoint(); } },
        { label: 'Set out point', action: () => { this.player.seekTo(Math.round(frame), { resume: false }); this.setOutPoint(); } },
        { label: 'Clear in/out', action: () => this.clearInOut() },
      ]);
    }

    trackContextMenu(x, y, track) {
      if (!track) return;
      const i = this.project.tracks.indexOf(track);
      const isVideo = track.kind === 'video';
      this.dialogs.contextMenu(x, y, [
        { label: track.name + (isVideo ? ' (video)' : ' (audio)'), disabled: true, action: null },
        { sep: true },
        { label: 'Add video track above', action: () => this.addTrackAt('video', i) },
        { label: 'Add video track below', action: () => this.addTrackAt('video', i + 1) },
        { label: 'Add audio track above', action: () => this.addTrackAt('audio', i) },
        { label: 'Add audio track below', action: () => this.addTrackAt('audio', i + 1) },
        { sep: true },
        { label: 'Move track up', disabled: i <= 0, action: () => this.moveTrack(track, -1) },
        { label: 'Move track down', disabled: i >= this.project.tracks.length - 1, action: () => this.moveTrack(track, 1) },
        { label: 'Duplicate track', action: () => this.duplicateTrack(track) },
        { sep: true },
        { label: (isVideo ? (track.hidden ? 'Show' : 'Hide') + ' track' : (track.muted ? 'Unmute' : 'Mute') + ' track'), action: () => this.exec(OS.commands.SetTrackProps(this.project, track, isVideo ? { hidden: !track.hidden } : { muted: !track.muted })) },
        { label: (track.solo ? 'Un-solo' : 'Solo') + ' track', action: () => this.exec(OS.commands.SetTrackProps(this.project, track, { solo: !track.solo })) },
        { label: (track.locked ? 'Unlock' : 'Lock') + ' track', action: () => this.exec(OS.commands.SetTrackProps(this.project, track, { locked: !track.locked })) },
        { sep: true },
        { label: 'Rename track…', action: () => this.renameTrack(track) },
        { label: 'Delete track', danger: true, action: () => this.deleteTrack(track) },
      ]);
    }

    timelineContextMenu(x, y, frame) {
      const canPaste = !!this.clipboard;
      this.dialogs.contextMenu(x, y, [
        { label: 'Move playhead here', action: () => this.player.seekTo(Math.round(frame), { resume: false }) },
        { label: 'Paste here', hint: 'Ctrl+V', disabled: !canPaste, action: () => { this.player.seekTo(Math.round(frame), { resume: false }); this.pasteAtPlayhead(); } },
        { label: 'Add marker here', action: () => { this.player.seekTo(Math.round(frame), { resume: false }); this.addMarkerAtPlayhead(); } },
        { sep: true },
        { label: 'Add title', submenu: OS.titles.PRESETS.map((p) => ({ label: p.name, action: () => { this.player.seekTo(Math.round(frame), { resume: false }); this.addTitleClip(p.id); } })) },
        { label: 'Add colour clip', action: () => { this.player.seekTo(Math.round(frame), { resume: false }); this.addGeneratorClip('color'); } },
        { label: 'Add gradient clip', action: () => { this.player.seekTo(Math.round(frame), { resume: false }); this.addGeneratorClip('gradient'); } },
        { sep: true },
        { label: 'Add video track', action: () => this.addTrack('video') },
        { label: 'Add audio track', action: () => this.addTrack('audio') },
        { sep: true },
        { label: 'Select all clips', hint: 'Ctrl+A', action: () => this.timeline.selectAll() },
        { label: 'Zoom to fit', hint: 'Ctrl+0', action: () => this.timeline.zoomToFit() },
      ]);
    }

    /* ================= export ================= */

    async exportStill() {
      const f = this.player.frame;
      try {
        const blob = await OS.export.exportStill(this.project, this.media, f, { type: 'image/png' });
        const stamp = OS.timebase.tc(f, this.project.fps).replace(/:/g, '-');
        const name = (this.project.name || 'OpenScene').replace(/[\\/:*?"<>|]+/g, '_') + '-' + stamp + '.png';
        await this.saveBlob(blob, name, 'png');
        this.setStatus('Still frame exported');
      } catch (e) {
        console.error(e);
        this.dialogs.toast('Still export failed: ' + e.message, 'error');
      }
    }

    saveBlob(blob, filename, container) { return this.persist.saveBlob(blob, filename, container); }
  }

  /* helpers used above */
  function t_overlap(project, track, start, len) {
    return M().clipsBetween(project, track, start, start + len).length > 0;
  }

  /* ================= bootstrap ================= */

  async function boot() {
    const app = new App();
    window.opensceneApp = app;
    try {
      await app.init();
    } catch (e) {
      console.error('[OpenScene] fatal init error', e);
      const node = document.getElementById('bootError') || document.createElement('div');
      node.id = 'bootError';
      node.className = 'boot-error';
      node.innerHTML = '<b>OpenScene could not start.</b><pre>' + U.esc(e.stack || e.message) + '</pre>';
      document.body.appendChild(node);
    }
    return app;
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => boot());
  else boot();

  OS.App = App;

  /* expose a tiny API for the dev rig / automation */
  OS.boot = boot;
})();
