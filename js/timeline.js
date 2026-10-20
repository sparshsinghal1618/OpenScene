/* OpenScene — timeline.js
   Canvas timeline: virtualised drawing (only the visible window is painted),
   zoom/pan, clip drag with snapping, trim, marquee select, overlap transitions,
   markers, waveforms, thumbnails and in/out work area. Pro-NLE interaction model:
   every gesture is previewed live and committed as ONE undoable command. */
(() => {
  'use strict';
  const OS = (window.OS = window.OS || {});
  const U = OS.util;
  const { clamp, el, on } = U;
  const M = () => OS.model;

  const RULER_H = 28;
  const HEAD_W = 178;
  const H_SCROLLBAR_H = 12;
  const EDGE_PX = 7;
  const TRANS_H = 13;
  const SNAP_PX = 9;
  const TRACK_GAP = 3;

  const COLORS = {
    bg: '#14161b', trackBg: '#191c22', trackBgAlt: '#1d2129', grid: '#262b34',
    ruler: '#1b1f26', rulerText: '#8b93a3', rulerTick: '#333a45',
    clip: '#2c4a6e', clipSel: '#3d6ea8', clipBorder: '#5b8ec9', clipText: '#e8eef7',
    clipAudio: '#1f5546', clipAudioBorder: '#3f9e7c',
    clipTitle: '#4a3a6e', clipTitleBorder: '#8a6ec9',
    clipColor: '#4a4a4a', transition: '#c9a227', playhead: '#ff5f56',
    clipAdjust: '#3b2f57', clipAdjustBorder: '#8a6ec9',
    marker: '#ffd23f', snapLine: '#ffd23f', inout: 'rgba(255,210,63,0.10)', marquee: 'rgba(90,160,255,0.18)',
    marqueeBorder: '#5aa0ff', scrollbar: '#3a4150', scrollbarHover: '#4c5568',
  };

  class Timeline {
    constructor(root, app) {
      this.app = app;
      this.root = root;
      this.view = { pxPerFrame: 0.9, scrollFrames: 0, trackScrollTop: 0 };
      this.selection = new Set();
      this.snapEnabled = true;
      this.rippleMode = false;
      this.dirty = true;
      this.thumbs = new Map();      // assetId -> Image
      this.drag = null;             // active gesture
      this.hover = null;
      this.snapLine = null;
      this._build();
      this._bind();
      this.refreshHeaders();
      this.requestRedraw();
      this._loop = () => { requestAnimationFrame(this._loop); this._frame(); };
      requestAnimationFrame(this._loop);
    }

    /* ---------------- DOM ---------------- */

    _build() {
      this.root.classList.add('timeline');
      this.toolbar = el('div.tl-toolbar');
      this.body = el('div.tl-body');
      this.headers = el('div.tl-headers');
      this.rulerSpacer = el('div.tl-ruler-spacer');
      this.headList = el('div.tl-head-list');
      this.headers.append(this.rulerSpacer, this.headList);
      this.canvasWrap = el('div.tl-canvas-wrap');
      this.canvas = el('canvas.tl-canvas');
      this.ctx = this.canvas.getContext('2d');
      this.canvasWrap.appendChild(this.canvas);
      this.body.append(this.headers, this.canvasWrap);
      this.root.append(this.toolbar, this.body);

      this.zoomLabel = el('span.tl-zoom-label');
      this.snapBtn = el('button.tl-btn', { title: 'Snapping (magnetic) toggle', text: 'Snap' });
      this.rippleBtn = el('button.tl-btn', { title: 'Ripple edits: trims and deletes shift later clips', text: 'Ripple' });
      this.addVideoBtn = el('button.tl-btn', { title: 'Add a video track (Ctrl+Shift+V)', text: '+ Video' });
      this.addAudioBtn = el('button.tl-btn', { title: 'Add an audio track (Ctrl+Shift+A) — drop audio files onto it', text: '+ Audio' });
      this.addTrackBtn = el('button.tl-btn', { title: 'More track options', text: 'Tracks' });
      this.zoomOutBtn = el('button.tl-btn', { title: 'Zoom out (-)', text: '−' });
      this.zoomInBtn = el('button.tl-btn', { title: 'Zoom in (+)', text: '+' });
      this.fitBtn = el('button.tl-btn', { title: 'Zoom to fit (Ctrl+0)', text: 'Fit' });
      this.infoLabel = el('span.tl-info');
      this.toolbar.append(
        this.zoomOutBtn, this.zoomInBtn, this.fitBtn, this.zoomLabel,
        el('span.tl-sep'), this.snapBtn, this.rippleBtn,
        el('span.tl-sep'), this.addVideoBtn, this.addAudioBtn, this.addTrackBtn,
        el('span.tl-spacer'), this.infoLabel,
      );
      this.snapBtn.classList.add('on');
    }

    _bind() {
      on(this.zoomInBtn, 'click', () => this.zoomBy(1.4));
      on(this.zoomOutBtn, 'click', () => this.zoomBy(1 / 1.4));
      on(this.fitBtn, 'click', () => this.zoomToFit());
      on(this.snapBtn, 'click', () => { this.snapEnabled = !this.snapEnabled; this.snapBtn.classList.toggle('on', this.snapEnabled); this.app.setStatus(this.snapEnabled ? 'Snapping on' : 'Snapping off'); });
      on(this.rippleBtn, 'click', () => { this.rippleMode = !this.rippleMode; this.rippleBtn.classList.toggle('on', this.rippleMode); this.app.setStatus(this.rippleMode ? 'Ripple mode on' : 'Ripple mode off'); });
      on(this.addTrackBtn, 'click', (e) => this.app.menuAddTrack(e));
      on(this.addVideoBtn, 'click', () => this.app.addTrack('video'));
      on(this.addAudioBtn, 'click', () => this.app.addTrack('audio'));
      on(this.headers, 'scroll', () => { this.view.trackScrollTop = this.headers.scrollTop; this.requestRedraw(); });

      // One input path for mouse, touch and pen. Pointer capture keeps drags
      // alive when the finger leaves the canvas, so no window-level listeners
      // are needed. Touch adds long-press menus, double-tap and pinch gestures.
      on(this.canvas, 'pointerdown', (e) => this._onPointerDown(e));
      on(this.canvas, 'pointermove', (e) => this._onPointerMove(e));
      on(this.canvas, 'pointerup', (e) => this._onPointerUp(e));
      on(this.canvas, 'pointercancel', (e) => this._onPointerUp(e));
      on(this.canvas, 'pointerleave', () => { if (!this.drag && !this._gesture) this.hover = null; });
      on(this.canvas, 'dblclick', (e) => { if (!this._lastInputTouch) this._onDbl(e); });
      on(this.canvas, 'contextmenu', (e) => { e.preventDefault(); this._openContext(e); });
      on(this.canvas, 'dragenter', (e) => this._onDragOver(e));
      on(this.canvas, 'dragover', (e) => this._onDragOver(e));
      on(this.canvas, 'dragleave', (e) => { if (e.relatedTarget && this.canvasWrap.contains(e.relatedTarget)) return; this.dropHint = null; this.requestRedraw(); });
      on(this.canvas, 'drop', (e) => this._onDrop(e));
      on(this.canvas, 'wheel', (e) => this._onWheel(e), { passive: false });
      const ro = new ResizeObserver(() => this.resize());
      ro.observe(this.canvasWrap);
    }

    /* ---------------- pointer input: mouse + touch ---------------- */

    get isTouchUi() { return U.isTouch(); }

    _pointerList() { return this._ptr ? [...this._ptr.values()] : []; }

    _onPointerDown(e) {
      if (!this.app.project) return;
      this._lastInputTouch = e.pointerType !== 'mouse';
      if (!this._ptr) this._ptr = new Map();
      this._ptr.set(e.pointerId, { x: e.clientX, y: e.clientY });

      if (this._ptr.size === 1) {
        try { this.canvas.setPointerCapture(e.pointerId); } catch (err) { /* not fatal */ }
        this._tapMoved = false;
        this._tapStart = { x: e.clientX, y: e.clientY };
        if (this._lastInputTouch) this._armLongPress(e);
        this._onDown(e);
        return;
      }
      if (this._ptr.size === 2) {
        // a second finger turns the gesture into pinch-zoom / two-finger pan
        this._clearLongPress();
        if (this.drag) this._onUp(e);
        this._startGesture();
      }
    }

    _onPointerMove(e) {
      if (this._ptr && this._ptr.has(e.pointerId)) this._ptr.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (this._gesture) { this._updateGesture(); return; }
      if (this._tapStart && e.pointerType !== 'mouse') {
        if (Math.abs(e.clientX - this._tapStart.x) > 8 || Math.abs(e.clientY - this._tapStart.y) > 8) {
          this._tapMoved = true;
          this._clearLongPress();
        }
      }
      this._onMove(e);
    }

    _onPointerUp(e) {
      if (this._ptr) this._ptr.delete(e.pointerId);
      this._clearLongPress();
      if (this._gesture) {
        if (!this._ptr || this._ptr.size < 2) this._gesture = null;
        return;
      }
      const wasDrag = !!this.drag;
      this._onUp(e);
      if (e.pointerType !== 'mouse' && !wasDrag && !this._tapMoved && !this._longPressFired) {
        const now = Date.now();
        const last = this._lastTap;
        if (last && now - last.t < 340 && Math.abs(last.x - e.clientX) < 30 && Math.abs(last.y - e.clientY) < 30) {
          this._lastTap = null;
          this._onDbl(e);                       // double-tap mirrors double-click
        } else {
          this._lastTap = { x: e.clientX, y: e.clientY, t: now };
        }
      }
      this._longPressFired = false;
      if (this._ptr && this._ptr.size === 0) this._ptr = null;
    }

    _armLongPress(e) {
      this._clearLongPress();
      const cx = e.clientX, cy = e.clientY, pointerId = e.pointerId;
      this._longPress = setTimeout(() => {
        this._longPress = null;
        if (!this._ptr || !this._ptr.has(pointerId)) return;
        this._tapMoved = true;
        this._longPressFired = true;
        this._abortDrag();                       // no half-finished edits under the menu
        if (navigator.vibrate) { try { navigator.vibrate(12); } catch (err) {} }
        this._openContext({ clientX: cx, clientY: cy, preventDefault() {} });
      }, 460);
    }

    _clearLongPress() { if (this._longPress) { clearTimeout(this._longPress); this._longPress = null; } }

    /* Roll back an in-progress gesture without committing a command. */
    _abortDrag() {
      const d = this.drag;
      this.drag = null;
      this.snapLine = null;
      if (!d) { this.requestRedraw(); return; }
      const p = this.app.project;
      if (d.mode === 'move') {
        for (const o of d.originals) { o.clip.start = o.start; o.clip.trackId = o.trackId; }
        for (const t of p.tracks) M().sortClips(t);
      } else if (d.mode === 'trimIn' || d.mode === 'trimOut') {
        if (d.clip && d.orig) { d.clip.start = d.orig.start; d.clip.length = d.orig.length; d.clip.inPoint = d.orig.inPoint; }
        if (d.rippleShifts) for (const s of d.rippleShifts) s.clip.start = s.before;
      } else if (d.mode === 'transition' && d.clip && d.clip.transitionIn) {
        d.clip.transitionIn.length = d.origLen;
        d.clip.transitionIn.type = d.origType;
      } else if (d.mode === 'marker' && d.marker) {
        d.marker.frame = d.orig;
        p.markers.sort((a, b) => a.frame - b.frame);
      }
      this.requestRedraw();
    }

    /* ---------------- pinch zoom + two-finger pan ---------------- */

    _startGesture() {
      const pts = this._pointerList();
      if (pts.length < 2) return;
      const a = pts[0], b = pts[1];
      const r = this.canvas.getBoundingClientRect();
      const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
      this._gesture = {
        d0: Math.hypot(b.x - a.x, b.y - a.y) || 1,
        zoom0: this.view.pxPerFrame,
        midX: mx, midY: my,
        localX: mx - r.left, localY: my - r.top,
      };
    }

    _updateGesture() {
      const g = this._gesture;
      const pts = this._pointerList();
      if (!g || pts.length < 2) return;
      const a = pts[0], b = pts[1];
      const d = Math.hypot(b.x - a.x, b.y - a.y) || 1;
      const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
      const dx = mx - g.midX, dy = my - g.midY;
      g.midX = mx; g.midY = my;

      if (Math.abs(d - g.d0) > 2) {
        g.localX += dx;                        // keep zooming about the same canvas point
        this.setZoom(g.zoom0 * (d / g.d0), g.localX);
      }
      if (Math.abs(dx) > 0.5) this.view.scrollFrames = Math.max(0, this.view.scrollFrames - dx / this.view.pxPerFrame);
      if (Math.abs(dy) > 0.5) {
        this.headers.scrollTop = clamp(this.headers.scrollTop - dy, 0, Math.max(0, this.contentHeight - this.cssH));
        this.view.trackScrollTop = this.headers.scrollTop;
      }
      this.requestRedraw();
    }

    /* Menu de-duplication: long-press and the browser's own contextmenu event
       can both arrive; only the first one wins. */
    _openContext(e) {
      const now = Date.now();
      if (this._ctxAt && now - this._ctxAt < 350) return;
      this._ctxAt = now;
      this._onContext(e);
    }

    /* ---------------- geometry ---------------- */

    get fps() { return this.app.project ? this.app.project.fps.rate : 30; }
    get cssW() { return this.canvasWrap.clientWidth || 800; }
    get cssH() { return this.canvasWrap.clientHeight || 300; }
    get tracksAreaH() { return this.cssH - RULER_H - H_SCROLLBAR_H; }
    get trackTops() {
      const tops = [];
      let y = RULER_H - this.view.trackScrollTop;
      for (const t of this.app.project.tracks) { tops.push(y); y += t.height + TRACK_GAP; }
      return tops;
    }
    get contentHeight() {
      let h = RULER_H;
      for (const t of this.app.project.tracks) h += t.height + TRACK_GAP;
      return h + H_SCROLLBAR_H;
    }
    frameToX(f) { return (f - this.view.scrollFrames) * this.view.pxPerFrame; }
    xToFrame(x) { return x / this.view.pxPerFrame + this.view.scrollFrames; }
    trackAtY(y) {
      const tops = this.trackTops;
      for (let i = 0; i < tops.length; i++) {
        const t = this.app.project.tracks[i];
        if (y >= tops[i] && y < tops[i] + t.height) return { track: t, index: i, top: tops[i] };
      }
      return null;
    }

    resize() {
      const dpr = window.devicePixelRatio || 1;
      const w = this.cssW, h = this.cssH;
      if (!w || !h) return;
      if (this.canvas.width !== Math.round(w * dpr) || this.canvas.height !== Math.round(h * dpr)) {
        this.canvas.width = Math.round(w * dpr);
        this.canvas.height = Math.round(h * dpr);
        this.canvas.style.width = w + 'px';
        this.canvas.style.height = h + 'px';
        this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      }
      this.requestRedraw();
    }

    requestRedraw() { this.dirty = true; }

    /* ---------------- zoom / scroll ---------------- */

    setZoom(pxPerFrame, anchorX = null) {
      const old = this.view.pxPerFrame;
      const next = clamp(pxPerFrame, 0.004, 12);
      if (next === old) return;
      if (anchorX != null) {
        const fAt = this.xToFrame(anchorX);
        this.view.pxPerFrame = next;
        this.view.scrollFrames = fAt - anchorX / next;
      } else this.view.pxPerFrame = next;
      this.view.scrollFrames = Math.max(0, this.view.scrollFrames);
      this.requestRedraw();
      this._updateZoomLabel();
    }
    zoomBy(k, anchorX) { this.setZoom(this.view.pxPerFrame * k, anchorX != null ? anchorX : this.cssW / 2); }
    zoomToFit() {
      // Fit the actual edits, not the open-ended tail.
      const dur = Math.max(this.fps * 5, M().projectDuration(this.app.project) + this.fps * 2);
      this.setZoom(Math.max(0.004, (this.cssW - 24) / dur));
      this.view.scrollFrames = 0;
      this.requestRedraw();
      this._updateZoomLabel();
    }
    _updateZoomLabel() {
      const px = this.view.pxPerFrame * this.fps;
      this.zoomLabel.textContent = `${px >= 10 ? Math.round(px) : px.toFixed(1)} px/s`;
    }
    ensureVisible(frame) {
      const x = this.frameToX(frame);
      const pad = 60;
      if (x < pad) { this.view.scrollFrames = Math.max(0, frame - pad / this.view.pxPerFrame); this.requestRedraw(); }
      else if (x > this.cssW - pad) { this.view.scrollFrames = Math.max(0, frame - (this.cssW - pad) / this.view.pxPerFrame); this.requestRedraw(); }
    }

    /* ---------------- headers ---------------- */

    refreshHeaders() {
      this.rulerSpacer.style.height = RULER_H + 'px';
      this.headList.innerHTML = '';
      const p = this.app.project;
      if (!p) return;
      for (const track of p.tracks) {
        const isVideo = track.kind === 'video';
        const h = el('div.tl-head', { dataset: { trackId: track.id }, title: 'Right-click for track options' });
        h.style.height = track.height + 'px';
        const kind = el('span.tl-kind', { text: isVideo ? 'V' : 'A' });
        kind.classList.add(isVideo ? 'video' : 'audio');
        const name = el('div.tl-head-name', { title: 'Double-click to rename', text: track.name });
        on(name, 'dblclick', () => this.app.renameTrack(track));
        const btns = el('div.tl-head-btns');
        const mk = (label, title, active, fn, cls) => {
          const b = el('button.tl-mini', { title, text: label });
          if (active) b.classList.add('on');
          if (cls) b.classList.add(...cls.split(/\s+/));
          on(b, 'click', (e) => { e.stopPropagation(); fn(b); });
          btns.appendChild(b);
          return b;
        };
        const p2 = () => this.app.project;
        if (isVideo) mk(track.hidden ? 'Show' : 'Hide', 'Hide or show this video track', track.hidden, () => this.app.exec(OS.commands.SetTrackProps(p2(), track, { hidden: !track.hidden })), 'tl-toggle tl-vis');
        else mk(track.muted ? 'On' : 'Mute', 'Mute or unmute this audio track', track.muted, () => this.app.exec(OS.commands.SetTrackProps(p2(), track, { muted: !track.muted })), 'tl-toggle tl-vis');
        mk('Solo', 'Solo this track', track.solo, () => this.app.exec(OS.commands.SetTrackProps(p2(), track, { solo: !track.solo })), 'tl-toggle tl-solo');
        mk('Lock', 'Lock track (blocks edits)', track.locked, () => this.app.exec(OS.commands.SetTrackProps(p2(), track, { locked: !track.locked })), 'tl-toggle tl-lock');
        mk('Up', 'Move track up', false, () => this.app.moveTrack(track, -1), 'tl-move');
        mk('Dn', 'Move track down', false, () => this.app.moveTrack(track, 1), 'tl-move');
        mk('Del', 'Delete track', false, () => this.app.deleteTrack(track), 'tl-del');
        on(h, 'contextmenu', (e) => { e.preventDefault(); e.stopPropagation(); this.app.trackContextMenu(e.clientX, e.clientY, track); });
        const size = el('input.tl-head-size', { type: 'range', min: 36, max: 190, value: track.height, title: 'Track height' });
        on(size, 'input', () => { track.height = +size.value; h.style.height = track.height + 'px'; this.requestRedraw(); });
        const headRow = el('div.tl-head-row', {}, [kind, name]);
        h.append(headRow, btns, size);
        this.headList.appendChild(h);
      }
      this.requestRedraw();
    }

    /* ---------------- selection ---------------- */

    getSelectedClips() {
      const out = [];
      for (const t of this.app.project.tracks) for (const c of M().clipsOf(this.app.project, t)) if (this.selection.has(c.id)) out.push(c);
      return out;
    }
    select(clip, additive = false) {
      if (!clip) { if (!additive) this.selection.clear(); this._emitSel(); return; }
      if (additive) { this.selection.has(clip.id) ? this.selection.delete(clip.id) : this.selection.add(clip.id); }
      else {
        this.selection.clear();
        this.selection.add(clip.id);
        // a grouped clip takes its whole group with it
        if (clip.groupId) for (const m of M().groupMembers(this.app.project, clip)) this.selection.add(m.id);
      }
      this._emitSel();
    }
    selectAll() {
      for (const t of this.app.project.tracks) for (const c of M().clipsOf(this.app.project, t)) this.selection.add(c.id);
      this._emitSel();
    }
    clearSelection() { this.selection.clear(); this._emitSel(); }
    _emitSel() { this.requestRedraw(); this.app.events.emit('selection-changed', this.getSelectedClips()); }

    /* ---------------- main frame ---------------- */

    _frame() {
      this.resizeIfNeeded();
      if (!this.dirty && !this.app.player.playing) return;
      this.dirty = false;
      this.draw();
    }
    resizeIfNeeded() {
      const dpr = window.devicePixelRatio || 1;
      const w = Math.round(this.cssW * dpr), h = Math.round(this.cssH * dpr);
      if (this.canvas.width !== w || this.canvas.height !== h) this.resize();
    }

    draw() {
      const ctx = this.ctx;
      const p = this.app.project;
      if (!p) return;
      const W = this.cssW, H = this.cssH;
      ctx.save();
      ctx.clearRect(0, 0, W, H);
      ctx.fillStyle = COLORS.bg;
      ctx.fillRect(0, 0, W, H);

      const { start, end } = this.visibleRange();
      this._drawWorkArea(ctx, W, p);
      this._drawTracks(ctx, W, p, start, end);
      this._drawClips(ctx, p, start, end);
      if (this.drag && this.drag.marquee) this._drawMarquee(ctx);
      this._drawDropHint(ctx);
      this._drawRuler(ctx, W, p, start, end);
      this._drawSnapLine(ctx);
      this._drawPlayhead(ctx, p);
      this._drawScrollbar(ctx, W, H, p);
      ctx.restore();
      this._updateInfo();
    }

    visibleRange() {
      const start = Math.max(0, Math.floor(this.view.scrollFrames));
      const end = Math.ceil(this.view.scrollFrames + this.cssW / this.view.pxPerFrame) + 1;
      return { start, end };
    }

    _drawTracks(ctx, W, p, s, e) {
      const tops = this.trackTops;
      for (let i = 0; i < p.tracks.length; i++) {
        const t = p.tracks[i];
        const y = tops[i];
        if (y > this.cssH || y + t.height < RULER_H) continue;
        ctx.fillStyle = i % 2 ? COLORS.trackBgAlt : COLORS.trackBg;
        ctx.fillRect(0, y, W, t.height);
        // vertical grid lines
        ctx.strokeStyle = COLORS.grid;
        ctx.lineWidth = 1;
        ctx.beginPath();
        for (const gx of this._gridXs(s, e)) {
          const x = Math.round(this.frameToX(gx)) + 0.5;
          if (x < 0 || x > W) continue;
          ctx.moveTo(x, y);
          ctx.lineTo(x, y + t.height);
        }
        ctx.stroke();
        if (t.locked) {
          ctx.fillStyle = 'rgba(255,255,255,0.03)';
          ctx.fillRect(0, y, W, t.height);
        }
        ctx.strokeStyle = '#0e1014';
        ctx.beginPath(); ctx.moveTo(0, y + t.height + 0.5); ctx.lineTo(W, y + t.height + 0.5); ctx.stroke();
      }
    }

    _gridXs(s, e) {
      const step = this._gridStep();
      const out = [];
      for (let f = Math.floor(s / step) * step; f <= e; f += step) out.push(f);
      return out;
    }
    _gridStep() {
      const targetPx = 90;
      const raw = targetPx / this.view.pxPerFrame;   // frames per gridline
      const fps = this.fps;
      const candidates = [1, 2, 5, 10, fps, fps * 2, fps * 5, fps * 10, fps * 30, fps * 60, fps * 300, fps * 600, fps * 1800, fps * 3600];
      for (const c of candidates) if (c >= raw) return Math.max(1, Math.round(c));
      return Math.max(1, Math.round(fps * 3600));
    }

    _drawRuler(ctx, W, p, s, e) {
      ctx.fillStyle = COLORS.ruler;
      ctx.fillRect(0, 0, W, RULER_H);
      ctx.strokeStyle = '#0d0f13';
      ctx.beginPath(); ctx.moveTo(0, RULER_H + 0.5); ctx.lineTo(W, RULER_H + 0.5); ctx.stroke();
      const step = this._gridStep();
      const fps = this.fps;
      ctx.font = '11px "Segoe UI", sans-serif';
      ctx.textBaseline = 'middle';
      ctx.strokeStyle = COLORS.rulerTick;
      ctx.fillStyle = COLORS.rulerText;
      ctx.textAlign = 'left';
      for (let f = Math.floor(s / step) * step; f <= e; f += step) {
        const x = Math.round(this.frameToX(f)) + 0.5;
        if (x < -40 || x > W + 40) continue;
        ctx.beginPath(); ctx.moveTo(x, RULER_H - 7); ctx.lineTo(x, RULER_H); ctx.stroke();
        const label = step >= fps ? OS.timebase.tc(f, p.fps).slice(0, step >= fps * 60 ? 5 : 8) : `+${OS.timebase.tc(f, p.fps)}`;
        ctx.fillText(label, x + 4, RULER_H / 2 - 3);
        // minor ticks
        ctx.strokeStyle = '#282e38';
        for (let k = 1; k < 5; k++) {
          const fx = this.frameToX(f + (step * k) / 5);
          if (fx < 0 || fx > W) continue;
          ctx.beginPath(); ctx.moveTo(Math.round(fx) + 0.5, RULER_H - 4); ctx.lineTo(Math.round(fx) + 0.5, RULER_H); ctx.stroke();
        }
        ctx.strokeStyle = COLORS.rulerTick;
      }
      // markers
      for (const m of p.markers) {
        const x = this.frameToX(m.frame);
        if (x < -12 || x > W + 12) continue;
        ctx.fillStyle = COLORS.marker;
        ctx.beginPath();
        ctx.moveTo(x, 2); ctx.lineTo(x + 5, 8); ctx.lineTo(x, 14); ctx.lineTo(x - 5, 8);
        ctx.closePath(); ctx.fill();
        if (m.name && this.view.pxPerFrame > 0.25) {
          ctx.fillStyle = 'rgba(255,210,63,0.85)';
          ctx.font = '10px "Segoe UI", sans-serif';
          ctx.fillText(m.name, x + 7, 8);
        }
      }
    }

    _drawWorkArea(ctx, W, p) {
      const tops = this.trackTops;
      const top = tops.length ? tops[0] : RULER_H;
      const bottom = tops.length ? tops[tops.length - 1] + p.tracks[p.tracks.length - 1].height : this.tracksAreaH;
      const inF = p.inPoint, outF = p.outPoint;
      if (inF == null && outF == null) return;
      ctx.fillStyle = COLORS.inout;
      if (inF != null) {
        const x = this.frameToX(inF);
        if (x > 0) ctx.fillRect(0, top, Math.min(x, W), bottom - top);
        ctx.strokeStyle = 'rgba(255,210,63,0.6)';
        ctx.beginPath(); ctx.moveTo(x + 0.5, top); ctx.lineTo(x + 0.5, bottom); ctx.stroke();
      }
      if (outF != null) {
        const x = this.frameToX(outF);
        if (x < W) ctx.fillRect(x, top, W - x, bottom - top);
        ctx.strokeStyle = 'rgba(255,210,63,0.6)';
        ctx.beginPath(); ctx.moveTo(x + 0.5, top); ctx.lineTo(x + 0.5, bottom); ctx.stroke();
      }
    }

    _clipColor(clip) {
      if (clip.colorTag) return clip.colorTag;
      if (clip.adjustment) return COLORS.clipAdjust || '#3a2f52';
      if (clip.generator) return clip.generator.type === 'title' ? COLORS.clipTitle : COLORS.clipColor;
      const asset = M().findAsset(this.app.project, clip.assetId);
      return asset && asset.kind === 'audio' ? COLORS.clipAudio : COLORS.clip;
    }
    _clipBorder(clip, sel) {
      if (sel) return '#9dd0ff';
      if (clip.adjustment) return COLORS.clipAdjustBorder || '#7a63b8';
      if (clip.generator) return COLORS.clipTitleBorder;
      const asset = M().findAsset(this.app.project, clip.assetId);
      return asset && asset.kind === 'audio' ? COLORS.clipAudioBorder : COLORS.clipBorder;
    }

    _drawClips(ctx, p, s, e) {
      const tops = this.trackTops;
      for (let ti = 0; ti < p.tracks.length; ti++) {
        const track = p.tracks[ti];
        const y0 = tops[ti];
        const h = track.height;
        if (y0 > this.cssH || y0 + h < RULER_H) continue;
        for (const clip of M().clipsOf(p, track)) {
          const end = M().clipEnd(clip);
          if (end < s) continue;
          if (clip.start > e) break;   // clips are sorted: nothing further is visible
          const x = this.frameToX(clip.start);
          const x2 = this.frameToX(end);
          this._drawClip(ctx, clip, track, x, y0, Math.max(2, x2 - x), h);
        }
      }
    }

    _drawClip(ctx, clip, track, x, y, w, trackH) {
      const sel = this.selection.has(clip.id);
      const body = { x, y: y + 1, w, h: trackH - 2 };
      const base = this._clipColor(clip);
      ctx.save();
      ctx.beginPath();
      this._roundRect(ctx, body.x, body.y, body.w, body.h, 3);
      ctx.fillStyle = base;
      ctx.fill();
      ctx.clip();

      // media thumbnails strip
      if (clip.assetId && track.kind === 'video') {
        const asset = M().findAsset(this.app.project, clip.assetId);
        if (asset && asset.thumb) {
          const img = this._thumbFor(asset);
          if (img && img.complete && img.naturalWidth) {
            const th = Math.min(body.h - 14, 54);
            const tw = img.naturalWidth && img.naturalHeight ? (th * img.naturalWidth) / img.naturalHeight : th;
            if (th > 16) {
              ctx.globalAlpha = sel ? 1 : 0.92;
              let px = body.x;
              const limit = body.x + body.w;
              while (px < limit) {
                const cw = Math.min(tw, limit - px);
                const csw = (cw / tw) * img.naturalWidth;
                ctx.drawImage(img, 0, 0, csw, img.naturalHeight, px, body.y + body.h - th - 1, cw, th);
                px += tw + 1;
              }
              ctx.globalAlpha = 1;
            }
          }
        }
      }

      // waveform
      if (clip.assetId && track.kind === 'audio') {
        const peaks = this.app.media.peaks(clip.assetId);
        if (peaks) this._drawWaveform(ctx, clip, peaks, body);
      }

      // fades
      if (clip.fadeIn > 0) {
        const fw = clip.fadeIn * this.view.pxPerFrame;
        ctx.fillStyle = 'rgba(0,0,0,0.5)';
        ctx.beginPath(); ctx.moveTo(body.x, body.y); ctx.lineTo(body.x + fw, body.y); ctx.lineTo(body.x, body.y + body.h); ctx.closePath(); ctx.fill();
      }
      if (clip.fadeOut > 0) {
        const fw = clip.fadeOut * this.view.pxPerFrame;
        ctx.fillStyle = 'rgba(0,0,0,0.5)';
        ctx.beginPath(); ctx.moveTo(body.x + body.w, body.y); ctx.lineTo(body.x + body.w - fw, body.y); ctx.lineTo(body.x + body.w, body.y + body.h); ctx.closePath(); ctx.fill();
      }

      // keyframe marks
      const kfPaths = Object.keys(clip.keyframes || {});
      if (kfPaths.length) {
        ctx.fillStyle = 'rgba(255,255,255,0.85)';
        const seen = new Set();
        for (const path of kfPaths) for (const k of clip.keyframes[path]) {
          if (seen.has(k.frame)) continue;
          seen.add(k.frame);
          const kx = this.frameToX(clip.start + k.frame);
          if (kx < body.x - 2 || kx > body.x + body.w + 2) continue;
          ctx.beginPath();
          ctx.moveTo(kx, body.y + body.h - 5); ctx.lineTo(kx + 3.5, body.y + body.h - 8.5); ctx.lineTo(kx, body.y + body.h - 12); ctx.lineTo(kx - 3.5, body.y + body.h - 8.5);
          ctx.closePath(); ctx.fill();
        }
      }

      // label bar
      const barH = Math.min(15, body.h - 2);
      ctx.fillStyle = 'rgba(0,0,0,0.42)';
      ctx.fillRect(body.x, body.y, body.w, barH);
      ctx.font = '11px "Segoe UI", sans-serif';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = COLORS.clipText;
      const badges = [];
      if (clip.adjustment) badges.push('ADJ');
      if (clip.generator && clip.generator.type === 'title') badges.push('T');
      if (clip.effects.length) badges.push(`fx${clip.effects.length}`);
      if (clip.blend && clip.blend !== 'normal') badges.push(M().blendLabel(clip.blend));
      if (clip.speed !== 1) badges.push(`${clip.speed.toFixed(2)}x`);
      if (clip.volume !== 1) badges.push('vol');
      if (clip.transform.scale !== 1 || clip.transform.x || clip.transform.y || clip.transform.rotation) badges.push('tr');
      if (kfPaths.length) badges.push('kf');
      const label = clip.name + (badges.length ? '  ' + badges.join(' ') : '');
      const maxText = Math.max(0, body.w - 12);
      if (maxText > 14) {
        ctx.save();
        ctx.beginPath(); ctx.rect(body.x + 4, body.y, maxText, barH); ctx.clip();
        ctx.fillText(label, body.x + 5, body.y + barH / 2 + 0.5);
        ctx.restore();
      }

      // grouped clips wear a chevron pair at each bottom corner
      if (clip.groupId && body.w > 24 && body.h > 20) {
        const cy = body.y + body.h - 5;
        ctx.fillStyle = 'rgba(157,208,255,0.9)';
        ctx.beginPath();
        ctx.moveTo(body.x + 2, cy - 3.5); ctx.lineTo(body.x + 6, cy); ctx.lineTo(body.x + 2, cy + 3.5);
        ctx.closePath(); ctx.fill();
        ctx.beginPath();
        ctx.moveTo(body.x + body.w - 2, cy - 3.5); ctx.lineTo(body.x + body.w - 6, cy); ctx.lineTo(body.x + body.w - 2, cy + 3.5);
        ctx.closePath(); ctx.fill();
      }
      ctx.restore();

      // transition zone
      const prev = M().prevClip(track, clip);
      const ov = prev ? M().overlapOf(prev, clip) : 0;
      if (ov > 0) {
        const tlen = clip.transitionIn ? clamp(clip.transitionIn.length, 1, ov) : 0;
        const tx = body.x;
        const tw = tlen * this.view.pxPerFrame;
        if (tlen > 0) {
          ctx.save();
          ctx.fillStyle = 'rgba(201,162,39,0.55)';
          ctx.beginPath();
          ctx.moveTo(tx, body.y);
          ctx.lineTo(tx + tw, body.y);
          ctx.lineTo(tx, body.y + TRANS_H);
          ctx.closePath();
          ctx.fill();
          ctx.strokeStyle = COLORS.transition;
          ctx.lineWidth = 1;
          ctx.beginPath(); ctx.moveTo(tx + tw, body.y); ctx.lineTo(tx + tw, body.y + body.h); ctx.stroke();
          if (tw > 26) {
            ctx.fillStyle = '#1a1400';
            ctx.font = 'bold 10px "Segoe UI", sans-serif';
            ctx.fillText((clip.transitionIn.type || 'dissolve').slice(0, 10), tx + 4, body.y + TRANS_H - 2);
          }
          ctx.restore();
        }
      } else if (prev) {
        // adjacent: show a cut marker
      }

      // border
      ctx.save();
      ctx.strokeStyle = this._clipBorder(clip, sel);
      ctx.lineWidth = sel ? 2 : 1;
      ctx.beginPath();
      this._roundRect(ctx, body.x + 0.5, body.y + 0.5, body.w - 1, body.h - 1, 3);
      ctx.stroke();
      ctx.restore();
    }

    _drawWaveform(ctx, clip, peaks, body) {
      const { peaks: arr, buckets } = peaks;
      const srcFrames = Math.max(1, clip.length);
      const pxPerFrame = this.view.pxPerFrame;
      const step = 1;
      ctx.save();
      ctx.beginPath(); ctx.rect(body.x, body.y, body.w, body.h); ctx.clip();
      ctx.strokeStyle = '#6ee7b7';
      ctx.globalAlpha = 0.9;
      ctx.lineWidth = 1;
      ctx.beginPath();
      const mid = body.y + body.h * 0.62;
      const amp = body.h * 0.34;
      for (let px = 0; px < body.w; px += step) {
        const localFrame = (px / pxPerFrame) * clip.speed + clip.inPoint;
        let b = Math.floor((localFrame / Math.max(1, clip.length * clip.speed)) * buckets);
        b = clamp(b, 0, buckets - 1);
        const mx = arr[b * 2], mn = arr[b * 2 + 1];
        const x = body.x + px + 0.5;
        ctx.moveTo(x, mid - mx * amp);
        ctx.lineTo(x, mid - mn * amp);
      }
      ctx.stroke();
      ctx.restore();
    }

    _roundRect(ctx, x, y, w, h, r) {
      r = Math.min(r, Math.abs(w) / 2, Math.abs(h) / 2);
      ctx.moveTo(x + r, y);
      ctx.arcTo(x + w, y, x + w, y + h, r);
      ctx.arcTo(x + w, y + h, x, y + h, r);
      ctx.arcTo(x, y + h, x, y, r);
      ctx.arcTo(x, y, x + w, y, r);
      ctx.closePath();
    }

    _thumbFor(asset) {
      let img = this.thumbs.get(asset.id);
      if (!img || img.__src !== asset.thumb) {
        img = new Image();
        img.__src = asset.thumb;
        img.src = asset.thumb;
        this.thumbs.set(asset.id, img);
      }
      return img;
    }

    _drawMarquee(ctx) {
      const m = this.drag.marquee;
      const x = Math.min(m.x0, m.x1), y = Math.min(m.y0, m.y1);
      const w = Math.abs(m.x1 - m.x0), h = Math.abs(m.y1 - m.y0);
      ctx.fillStyle = COLORS.marquee;
      ctx.fillRect(x, y, w, h);
      ctx.strokeStyle = COLORS.marqueeBorder;
      ctx.setLineDash([4, 3]);
      ctx.strokeRect(x + 0.5, y + 0.5, w, h);
      ctx.setLineDash([]);
    }

    _drawSnapLine(ctx) {
      if (this.snapLine == null) return;
      const x = Math.round(this.frameToX(this.snapLine)) + 0.5;
      ctx.strokeStyle = COLORS.snapLine;
      ctx.lineWidth = 1;
      ctx.setLineDash([5, 4]);
      ctx.beginPath(); ctx.moveTo(x, RULER_H); ctx.lineTo(x, this.cssH - H_SCROLLBAR_H); ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = COLORS.snapLine;
      ctx.beginPath(); ctx.moveTo(x, RULER_H); ctx.lineTo(x + 5, RULER_H - 6); ctx.lineTo(x - 5, RULER_H - 6); ctx.closePath(); ctx.fill();
    }

    _drawPlayhead(ctx, p) {
      const f = this.app.player.frame;
      const x = Math.round(this.frameToX(f)) + 0.5;
      if (x < -10 || x > this.cssW + 10) return;
      ctx.strokeStyle = COLORS.playhead;
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, this.cssH - H_SCROLLBAR_H); ctx.stroke();
      ctx.fillStyle = COLORS.playhead;
      ctx.beginPath();
      ctx.moveTo(x - 7, 0); ctx.lineTo(x + 7, 0); ctx.lineTo(x + 7, 9); ctx.lineTo(x, 15); ctx.lineTo(x - 7, 9);
      ctx.closePath(); ctx.fill();
    }

    /* The timeline is open-ended: there is no project length to run out of, so
       the scrollable span is always the content plus a generous tail. That tail
       is what lets you park the playhead past your last clip and drop new media
       there without the view refusing to scroll further. It grows with the
       content so the scrollbar thumb keeps a sane size on long edits. */
    timelineSpan() {
      const content = M().projectDuration(this.app.project);
      const tail = Math.max(this.fps * 30, content * 0.25);
      return Math.max(this.fps * 60, content + tail);
    }

    _drawScrollbar(ctx, W, H, p) {
      const y = H - H_SCROLLBAR_H;
      ctx.fillStyle = '#101318';
      ctx.fillRect(0, y, W, H_SCROLLBAR_H);
      const dur = this.timelineSpan();
      const total = dur / this.view.pxPerFrame;                 // total content px
      const frac = Math.min(1, W / Math.max(1, total));
      if (frac >= 0.999) return;
      const barW = Math.max(28, W * frac);
      const pos = (this.view.scrollFrames / dur) * W;
      ctx.fillStyle = this._scrollHover ? COLORS.scrollbarHover : COLORS.scrollbar;
      this._roundRect(ctx, clamp(pos, 0, W - barW), y + 3, barW, H_SCROLLBAR_H - 6, 4);
      ctx.fill();
      this._scrollGeom = { y, barW, dur, total };
    }

    _updateInfo() {
      const p = this.app.project;
      const sel = this.getSelectedClips();
      const dur = M().projectDuration(p);
      this.infoLabel.textContent = `${p.tracks.length} tracks · ${p.assets.length} media · duration ${OS.timebase.tc(dur, p.fps)} · selected ${sel.length}`;
    }

    /* ---------------- hit testing ---------------- */

    hitTest(x, y) {
      const p = this.app.project;
      if (y < RULER_H) {
        for (const m of p.markers) {
          const mx = this.frameToX(m.frame);
          if (Math.abs(mx - x) <= 7) return { type: 'marker', marker: m };
        }
        return { type: 'ruler', frame: Math.round(this.xToFrame(x)) };
      }
      if (y >= this.cssH - H_SCROLLBAR_H) return { type: 'scrollbar' };
      const t = this.trackAtY(y);
      if (!t) return { type: 'empty' };
      const frame = this.xToFrame(x);
      const clip = M().clipsOf(p, t.track).find((c) => frame >= c.start && frame < M().clipEnd(c));
      if (!clip) return { type: 'trackempty', track: t.track, frame: Math.round(frame) };
      const x0 = this.frameToX(clip.start), x1 = this.frameToX(M().clipEnd(clip));
      const prev = M().prevClip(t.track, clip);
      const ov = prev ? M().overlapOf(prev, clip) : 0;
      const tlen = clip.transitionIn ? clamp(clip.transitionIn.length, 1, ov) : 0;
      if (tlen > 0 && y - t.top < TRANS_H + 2 && x < x0 + tlen * this.view.pxPerFrame) {
        return { type: 'transition', clip, prev, track: t.track, frame: Math.round(frame) };
      }
      if (Math.abs(x - x0) <= EDGE_PX) return { type: 'trimIn', clip, track: t.track };
      if (Math.abs(x - x1) <= EDGE_PX) return { type: 'trimOut', clip, track: t.track };
      return { type: 'clip', clip, track: t.track, frame: Math.round(frame), trackTop: t.top };
    }

    /* ---------------- input ---------------- */

    _localPos(e) {
      const r = this.canvas.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    }

    _onDown(e) {
      if (!this.app.project) return;
      const { x, y } = this._localPos(e);
      const hit = this.hitTest(x, y);
      const additive = e.shiftKey || e.ctrlKey;

      if (e.button === 1 || (e.button === 0 && this._spaceDown)) {
        this.drag = { mode: 'pan', startX: x, startScroll: this.view.scrollFrames };
        return;
      }
      if (this.drag && this.drag.mode === 'scrollbar') return;

      switch (hit.type) {
        case 'scrollbar': {
          this.drag = { mode: 'scrollbar', startX: x, startScroll: this.view.scrollFrames, geom: this._scrollGeom };
          return;
        }
        case 'ruler': {
          this.drag = { mode: 'scrub' };
          this.app.player.scrub(hit.frame);
          return;
        }
        case 'marker': {
          this.drag = { mode: 'marker', marker: hit.marker, orig: hit.marker.frame };
          return;
        }
        case 'transition': {
          this._selectOnly(hit.clip, additive);
          this.drag = {
            mode: 'transition', clip: hit.clip, prev: hit.prev, startX: x,
            origLen: hit.clip.transitionIn.length, origType: hit.clip.transitionIn.type,
          };
          return;
        }
        case 'trimIn':
        case 'trimOut': {
          if (hit.track.locked) { this.app.setStatus('Track is locked'); return; }
          this._selectOnly(hit.clip, additive);
          this.drag = {
            mode: hit.type, clip: hit.clip, startX: x, orig: { start: hit.clip.start, length: hit.clip.length, inPoint: hit.clip.inPoint },
            rippleShifts: this.rippleMode || e.shiftKey ? this._captureRipple(hit.clip, hit.type === 'trimIn' ? 'in' : 'out') : null,
          };
          return;
        }
        case 'clip': {
          this._selectOnly(hit.clip, additive);
          // moving a grouped clip moves the whole group
          const pool = [];
          const seen = new Set();
          for (const c of this.getSelectedClips()) {
            for (const m of M().groupMembers(this.app.project, c)) {
              if (seen.has(m.id)) continue;
              const tr = M().trackOf(this.app.project, m);
              if (tr && !tr.locked) { seen.add(m.id); pool.push(m); }
            }
          }
          const clips = pool.length ? pool : this.getSelectedClips().filter((c) => !M().trackOf(this.app.project, c).locked);
          const positions = clips.map((c) => ({ clip: c, start: c.start, trackId: c.trackId }));
          this.drag = {
            mode: 'move', startX: x, startY: y, positions,
            originals: positions.map((p2) => ({ ...p2 })),
            alt: e.altKey, moved: false, insert: e.ctrlKey,
          };
          return;
        }
        case 'trackempty':
        case 'empty': {
          if (!additive) this.clearSelection();
          this.drag = { mode: 'marquee', marquee: { x0: x, y0: y, x1: x, y1: y }, additive };
          return;
        }
      }
    }

    _selectOnly(clip, additive) {
      if (additive) { if (!this.selection.has(clip.id)) this.selection.add(clip.id); this._emitSel(); }
      else if (!this.selection.has(clip.id)) this.select(clip);
    }

    _captureRipple(clip, mode) {
      const track = M().trackOf(this.app.project, clip);
      const edge = mode === 'in' ? clip.start : M().clipEnd(clip);
      return M().clipsOf(this.app.project, track)
        .filter((c) => c !== clip && c.start >= edge)
        .map((c) => ({ clip: c, before: c.start }));
    }

    _onMove(e) {
      const { x, y } = this._localPos(e);
      if (!this.drag) {
        const hit = this.hitTest(x, y);
        this._setCursor(hit);
        return;
      }
      const d = this.drag;
      switch (d.mode) {
        case 'pan': {
          this.view.scrollFrames = Math.max(0, d.startScroll - (x - d.startX) / this.view.pxPerFrame);
          this.requestRedraw();
          break;
        }
        case 'scrollbar': {
          const geom = d.geom && d.geom.dur ? d.geom : null;
          if (!geom) break;
          const deltaFrac = (x - d.startX) / this.cssW;
          this.view.scrollFrames = Math.max(0, d.startScroll + deltaFrac * geom.dur);
          this.requestRedraw();
          break;
        }
        case 'scrub': {
          this.app.player.scrub(clamp(Math.round(this.xToFrame(x)), 0, M().projectDuration(this.app.project)));
          break;
        }
        case 'marker': {
          d.marker.frame = Math.max(0, Math.round(this.xToFrame(x)));
          this.app.project.markers.sort((a, b) => a.frame - b.frame);
          this.requestRedraw();
          break;
        }
        case 'marquee': {
          d.marquee.x1 = x; d.marquee.y1 = y;
          this._applyMarquee();
          break;
        }
        case 'transition': {
          const deltaFrames = (x - d.startX) / this.view.pxPerFrame;
          const prev = d.prev;
          const ov = M().overlapOf(prev, d.clip);
          const len = clamp(Math.round(d.origLen + deltaFrames), 1, ov);
          d.clip.transitionIn.length = len;
          this.app.setStatus(`Transition: ${d.clip.transitionIn.type} — ${len} frames (${(len / this.fps).toFixed(2)} s)`);
          this.requestRedraw();
          break;
        }
        case 'trimIn':
        case 'trimOut': {
          if (!d.moved) { d.moved = true; this.app.player.pause(); }
          this._liveTrim(d, x);
          break;
        }
        case 'move': {
          if (!d.moved && Math.abs(x - d.startX) < 3 && Math.abs(y - d.startY) < 3) break;
          d.moved = true;
          this._liveMove(d, x, y);
          break;
        }
      }
    }

    _setCursor(hit) {
      let c = 'default';
      if (hit.type === 'clip') c = 'grab';
      else if (hit.type === 'trimIn' || hit.type === 'trimOut') c = 'ew-resize';
      else if (hit.type === 'transition') c = 'col-resize';
      else if (hit.type === 'ruler') c = 'text';
      else if (hit.type === 'marker') c = 'move';
      this.canvas.style.cursor = c;
    }

    _applyMarquee() {
      const m = this.drag.marquee;
      const x0 = Math.min(m.x0, m.x1), x1 = Math.max(m.x0, m.x1);
      const y0 = Math.min(m.y0, m.y1), y1 = Math.max(m.y0, m.y1);
      const f0 = this.xToFrame(x0), f1 = this.xToFrame(x1);
      if (!m.additive) this.selection.clear();
      const tops = this.trackTops;
      this.app.project.tracks.forEach((t, i) => {
        const ty0 = tops[i], ty1 = ty0 + t.height;
        if (ty1 < y0 || ty0 > y1) return;
        for (const c of M().clipsOf(this.app.project, t)) {
          if (M().clipEnd(c) > f0 && c.start < f1) this.selection.add(c.id);
        }
      });
      this._emitSel();
    }

    _liveMove(d, x, y) {
      const p = this.app.project;
      const rawDelta = (x - d.startX) / this.view.pxPerFrame;
      const movedClips = new Set(d.positions.map((pos) => pos.clip));
      const targets = this._snapTargets(movedClips);
      const refOrig = d.originals[0];
      let delta = Math.round(rawDelta);
      let bestSnap = null;
      if (this.snapEnabled) {
        // snap either edge of the reference clip (and every other moved clip's edges)
        for (let i = 0; i < d.positions.length; i++) {
          const orig = d.originals[i];
          for (const edge of [orig.start + delta, orig.start + delta + orig.clip.length]) {
            for (const t of targets) {
              const px = Math.abs(t - edge) * this.view.pxPerFrame;
              if (px <= SNAP_PX && (!bestSnap || px < bestSnap.px)) bestSnap = { px, delta: delta + (t - edge), frame: t };
            }
          }
        }
      }
      if (bestSnap) delta = Math.round(bestSnap.delta);

      // vertical movement: everyone shifts by the same track delta, if legal
      const hitTrack = this.trackAtY(y);
      let trackDelta = 0;
      if (hitTrack) {
        const srcIndex = p.tracks.findIndex((t) => t.id === refOrig.trackId);
        trackDelta = hitTrack.index - srcIndex;
      }
      const legal = d.originals.every((orig) => {
        const targetIndex = p.tracks.findIndex((t) => t.id === orig.trackId) + trackDelta;
        const target = p.tracks[targetIndex];
        if (!target) return false;
        if (orig.clip.generator) return target.kind === 'video';
        const asset = M().findAsset(p, orig.clip.assetId);
        const kind = asset ? asset.kind : 'video';
        if (kind === 'audio') return target.kind === 'audio';
        return target.kind === 'video';
      });
      if (!legal) trackDelta = 0;

      for (let i = 0; i < d.positions.length; i++) {
        const pos = d.positions[i], orig = d.originals[i];
        const targetIndex = p.tracks.findIndex((t) => t.id === orig.trackId) + trackDelta;
        const target = p.tracks[targetIndex] || M().findTrack(p, orig.trackId);
        pos.start = Math.max(0, orig.start + delta);
        pos.trackId = target.id;
        pos.clip.start = pos.start;
        pos.clip.trackId = pos.trackId;
      }
      for (const t of p.tracks) M().sortClips(t);
      this.snapLine = bestSnap ? bestSnap.frame : null;
      const dt = Math.round(bestSnap ? bestSnap.delta : rawDelta);
      this.app.setStatus(`Move Δ ${dt >= 0 ? '+' : ''}${dt}f (${(dt / this.fps).toFixed(2)}s)${bestSnap ? ' — snapped' : ''}`);
      this.requestRedraw();
    }

    _liveTrim(d, x) {
      const clip = d.clip;
      const target = this.xToFrame(x);
      const snapped = this.snapEnabled ? this._snapFrame(target, clip) : Math.round(target);
      const fps = this.fps;
      if (d.mode === 'trimIn') {
        const maxStart = M().clipEnd(clip) - M().MIN_CLIP_FRAMES;
        const minStart = clip.start - Math.round(clip.inPoint / (clip.speed || 1));
        const ns = clamp(Math.round(snapped), Math.max(0, minStart), maxStart);
        const delta = ns - d.orig.start;
        clip.start = d.orig.start + delta;
        clip.inPoint = Math.max(0, d.orig.inPoint + Math.round(delta * (clip.speed || 1)));
        clip.length = d.orig.length - delta;
        if (d.rippleShifts) for (const s of d.rippleShifts) s.clip.start = Math.max(0, s.before - delta);
      } else {
        const asset = M().findAsset(this.app.project, clip.assetId);
        const maxLen = asset && !clip.generator ? Math.round((asset.durationFrames - clip.inPoint) / (clip.speed || 1)) : Infinity;
        const nl = clamp(Math.round(snapped) - clip.start, M().MIN_CLIP_FRAMES, maxLen);
        const delta = nl - d.orig.length;
        clip.length = nl;
        if (d.rippleShifts) for (const s of d.rippleShifts) s.clip.start = Math.max(0, s.before + delta);
      }
      M().normalizeTransitions(this.app.project);
      for (const t of this.app.project.tracks) M().sortClips(t);
      this.snapLine = snapped !== Math.round(target) ? snapped : null;
      this.app.setStatus(`${d.mode === 'trimIn' ? 'In' : 'Out'}: ${OS.timebase.tc(clip.start, this.app.project.fps)} → ${OS.timebase.tc(M().clipEnd(clip), this.app.project.fps)}`);
      this.requestRedraw();
    }

    _snapFrame(frame, excludeClip = null) {
      const targets = this._snapTargets(excludeClip ? new Set([excludeClip]) : new Set());
      let best = Math.round(frame), set = false;
      for (const t of targets) {
        const px = Math.abs(t - frame) * this.view.pxPerFrame;
        if (px <= SNAP_PX && (!set || Math.abs(t - frame) < Math.abs(best - frame))) { best = t; set = true; }
      }
      return best;
    }

    _snapTargets(excludeClips) {
      const p = this.app.project;
      const out = [0, this.app.player.frame];
      for (const m of p.markers) out.push(m.frame);
      if (p.inPoint != null) out.push(p.inPoint);
      if (p.outPoint != null) out.push(p.outPoint);
      for (const t of p.tracks) for (const c of M().clipsOf(p, t)) {
        if (excludeClips && excludeClips.has(c)) continue;
        out.push(c.start); out.push(M().clipEnd(c));
      }
      return out;
    }

    _onUp(e) {
      const d = this.drag;
      this.drag = null;
      this.snapLine = null;
      if (!d) return;
      const p = this.app.project;
      const cmds = OS.commands;
      switch (d.mode) {
        case 'move': {
          if (!d.moved) { this.requestRedraw(); return; }
          // revert live edits, then commit as one command
          for (const o of d.originals) { o.clip.start = o.start; o.clip.trackId = o.trackId; }
          for (const t of p.tracks) M().sortClips(t);
          const positions = d.positions.map((pos, i) => ({ clip: pos.clip, start: pos.start, trackId: pos.trackId }));
          const targetTrack = M().findTrack(p, positions[0].trackId);
          if (d.insert) {
            // insert (ripple) drag: push the target track's later clips
            const refStart = positions[0].start;
            const pushBy = positions[0].clip.length;
            const shifts = new Map();
            for (const c of M().clipsOf(p, targetTrack)) {
              if (d.originals.some((o) => o.clip === c)) continue;
              if (c.start >= refStart) shifts.set(c, c.start + pushBy);
            }
            const applyPositions = () => { for (const pos of positions) { pos.clip.start = pos.start; pos.clip.trackId = pos.trackId; } M().sortClips(targetTrack); };
            const revertAll = () => { for (const o of d.originals) { o.clip.start = o.start; o.clip.trackId = o.trackId; } for (const [c, s] of shifts) c.start = s - pushBy; for (const t of p.tracks) M().sortClips(t); };
            this.app.exec({
              label: 'Insert (ripple) drag',
              do() { for (const [c, s] of shifts) c.start = s; applyPositions(); },
              undo() { revertAll(); },
            });
          } else if (d.alt) {
            const copies = positions.map((pos) => {
              const c = U.deepClone(pos.clip);
              c.id = U.uid('clp');
              c.start = pos.start; c.trackId = pos.trackId;
              return c;
            });
            this.app.exec(cmds.AddClips(p, copies, { name: 'Duplicate clips' }));
            this.selection = new Set(copies.map((c) => c.id));
            this._emitSel();
          } else {
            this.app.exec(cmds.MoveClips(p, positions));
          }
          this.app.touch();
          break;
        }
        case 'trimIn':
        case 'trimOut': {
          if (!d.moved) { this.requestRedraw(); return; }
          const clip = d.clip;
          const final = { start: clip.start, length: clip.length, inPoint: clip.inPoint };
          const shifts = d.rippleShifts ? d.rippleShifts.map((s) => ({ clip: s.clip, now: s.clip.start, before: s.before })) : null;
          clip.start = d.orig.start; clip.length = d.orig.length; clip.inPoint = d.orig.inPoint;
          if (shifts) for (const s of shifts) s.clip.start = s.before;
          for (const t of p.tracks) M().sortClips(t);
          const mode = d.mode === 'trimIn' ? 'in' : 'out';
          this.app.exec({
            label: mode === 'in' ? 'Trim in' : 'Trim out',
            do() {
              clip.start = final.start; clip.length = final.length; clip.inPoint = final.inPoint;
              if (shifts) for (const s of shifts) s.clip.start = s.now;
              M().normalizeTransitions(p);
              for (const t of p.tracks) M().sortClips(t);
            },
            undo() {
              clip.start = d.orig.start; clip.length = d.orig.length; clip.inPoint = d.orig.inPoint;
              if (shifts) for (const s of shifts) s.clip.start = s.before;
              M().normalizeTransitions(p);
              for (const t of p.tracks) M().sortClips(t);
            },
          });
          this.app.touch();
          break;
        }
        case 'transition': {
          const clip = d.clip;
          const now = clip.transitionIn.length;
          clip.transitionIn.length = d.origLen;
          this.app.exec(cmds.SetClipProps(p, [{ clip, values: { 'transitionIn.length': now }, prev: { 'transitionIn.length': d.origLen } }], { name: 'Transition length' }));
          this.app.touch();
          break;
        }
        case 'marker': {
          const m = d.marker;
          const now = m.frame;
          m.frame = d.orig;
          this.app.exec(cmds.SetMarker(p, m, { frame: now }));
          this.app.touch();
          break;
        }
        case 'scrub': {
          break;
        }
      }
      this.requestRedraw();
    }

    _onDbl(e) {
      const { x, y } = this._localPos(e);
      const hit = this.hitTest(x, y);
      if (hit.type === 'clip') {
        this.select(hit.clip);
        this.app.focusProperties();
      } else if (hit.type === 'trackempty' || hit.type === 'empty') {
        this.app.addMarkerAtPlayhead();
      } else if (hit.type === 'marker') {
        const name = prompt('Marker name', hit.marker.name || '');
        if (name != null) this.app.exec(OS.commands.SetMarker(this.app.project, hit.marker, { name }));
      }
    }

    _onContext(e) {
      const { x, y } = this._localPos(e);
      const hit = this.hitTest(x, y);
      const app = this.app;
      if (hit.type === 'clip') {
        if (!this.selection.has(hit.clip.id)) this.select(hit.clip);
        app.clipContextMenu(e.clientX, e.clientY, hit.clip);
      } else if (hit.type === 'transition') {
        this.select(hit.clip);
        app.transitionContextMenu(e.clientX, e.clientY, hit.clip);
      } else if (hit.type === 'marker') {
        app.markerContextMenu(e.clientX, e.clientY, hit.marker);
      } else if (hit.type === 'ruler') {
        app.rulerContextMenu(e.clientX, e.clientY, hit.frame);
      } else if (hit.track || hit.type === 'trackempty') {
        app.trackContextMenu(e.clientX, e.clientY, hit.track);
      } else {
        app.timelineContextMenu(e.clientX, e.clientY, this.xToFrame(x));
      }
    }

    /* ---------------- drag & drop from the library panels / Explorer ---------------- */

    _payloads(dt) {
      const out = { asset: null, effect: null, transition: null, files: null };
      if (!dt) return out;
      try { const s = dt.getData('application/x-openscene-asset'); if (s) out.asset = JSON.parse(s); } catch (e) {}
      try { const s = dt.getData('application/x-openscene-effect'); if (s) out.effect = JSON.parse(s); } catch (e) {}
      try { const s = dt.getData('application/x-openscene-transition'); if (s) out.transition = JSON.parse(s); } catch (e) {}
      if (dt.files && dt.files.length) out.files = dt.files;
      return out;
    }

    _onDragOver(e) {
      const dt = e.dataTransfer;
      if (!dt) return;
      const types = Array.from(dt.types || []);
      const relevant = types.some((t) => t.indexOf('openscene') >= 0) || types.indexOf('Files') >= 0;
      if (!relevant) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
      const { x, y } = this._localPos(e);
      const frame = Math.max(0, Math.round(this.xToFrame(x)));
      const t = this.trackAtY(y);
      this.dropHint = { frame, track: t ? t.track : null, index: t ? t.index : -1 };
      this.requestRedraw();
    }

    _onDrop(e) {
      e.preventDefault();
      e.stopPropagation();
      this.dropHint = null;
      const { x, y } = this._localPos(e);
      const frame = Math.max(0, Math.round(this.xToFrame(x)));
      const t = this.trackAtY(y);
      const track = t ? t.track : null;
      const hit = this.hitTest(x, y);
      const clip = (hit.type === 'clip' || hit.type === 'trimIn' || hit.type === 'trimOut' || hit.type === 'transition' || hit.type === 'trackempty') ? (hit.clip || null) : null;
      const pay = this._payloads(e.dataTransfer);
      this.requestRedraw();
      if (pay.files) { this.app.importFilesAt(pay.files, track, frame); return; }
      if (pay.asset) {
        const asset = M().findAsset(this.app.project, pay.asset.assetId);
        if (asset) this.app.placeAssetAt(asset, track, frame);
        return;
      }
      if (pay.effect) {
        this.app.placeEffectOnClip(clip, pay.effect.type);
        return;
      }
      if (pay.transition) {
        this.app.placeTransitionOnClip(clip, pay.transition.type);
      }
    }

    _drawDropHint(ctx) {
      const hint = this.dropHint;
      if (!hint) return;
      const x = Math.round(this.frameToX(hint.frame)) + 0.5;
      let top = RULER_H, bottom = this.cssH - H_SCROLLBAR_H;
      if (hint.track) {
        const i = this.app.project.tracks.indexOf(hint.track);
        const tops = this.trackTops;
        if (i >= 0) { top = tops[i]; bottom = tops[i] + hint.track.height; }
      }
      ctx.save();
      ctx.strokeStyle = '#5aa0ff';
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(x, top); ctx.lineTo(x, bottom); ctx.stroke();
      ctx.fillStyle = 'rgba(90,160,255,0.09)';
      ctx.fillRect(x, top, this.cssW - x, bottom - top);
      ctx.restore();
    }

    _onWheel(e) {
      e.preventDefault();
      const { x } = this._localPos(e);
      if (e.ctrlKey || (!e.shiftKey && e.deltaMode === 0 && !e.altKey)) {
        const k = Math.pow(1.0016, -e.deltaY);
        this.setZoom(this.view.pxPerFrame * k, x);
      }
      if (e.shiftKey) {
        this.view.scrollFrames = Math.max(0, this.view.scrollFrames + (e.deltaY / this.view.pxPerFrame));
        this.requestRedraw();
      }
      if (e.altKey) {
        this.headers.scrollTop = clamp(this.headers.scrollTop + e.deltaY, 0, Math.max(0, this.contentHeight - this.cssH));
        this.view.trackScrollTop = this.headers.scrollTop;
        this.requestRedraw();
      }
    }

    setSpaceDown(v) { this._spaceDown = v; }
  }

  OS.timeline = { Timeline, COLORS, RULER_H, HEAD_W };
})();
