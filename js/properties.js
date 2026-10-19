/* OpenScene — properties.js
   Inspector: clip timing/transform/audio, keyframed parameters, effect stack with
   parameter editing, transition settings, title/generator editing and media info.
   Every control writes through commands so everything is undoable. */
(() => {
  'use strict';
  const OS = (window.OS = window.OS || {});
  const U = OS.util;
  const { el, on, clamp } = U;
  const M = () => OS.model;

  class Properties {
    constructor(root, app) {
      this.root = root;
      this.app = app;
      this.current = null;      // clip
      this.assetInfo = null;
      this.build();
      app.events.on('selection-changed', (sel) => this.showClip(sel.length === 1 ? sel[0] : null, sel));
      app.events.on('media-updated', () => { if (this.assetInfo) this.refreshAsset(); });
      app.events.on('project-loaded', () => this.showClip(null, []));
    }

    build() {
      this.root.classList.add('props');
      this.head = el('div.panel-head');
      this.title = el('span.panel-title', { text: 'Properties' });
      this.sub = el('span.panel-sub');
      this.head.append(this.title, this.sub);
      this.body = el('div.props-body');
      this.root.append(this.head, this.body);
      this.showClip(null, []);
    }

    /* ---------- helpers ---------- */

    section(label, opts = {}) {
      const s = el('div.prop-section' + (opts.collapsed ? ' collapsed' : ''));
      const h = el('div.prop-section-head', { text: label });
      const b = el('div.prop-section-body');
      on(h, 'click', () => s.classList.toggle('collapsed'));
      s.append(h, b);
      return { section: s, body: b };
    }

    row(label, control, opts = {}) {
      const r = el('div.prop-row');
      const l = el('label.prop-label', { text: label, title: opts.title || label });
      r.append(l, control);
      return r;
    }

    numberRow(label, get, set, opts = {}) {
      const min = opts.min ?? -Infinity, max = opts.max ?? Infinity, step = opts.step ?? 1;
      const num = el('input.prop-input.num', { type: 'number', min, max, step, value: round4(get()) });
      const range = opts.range === false ? null : el('input.prop-range', { type: 'range', min, max, step, value: clamp(get(), min, max) });
      const push = (v, commit) => {
        v = clamp(parseFloat(v), min, max);
        if (!Number.isFinite(v)) return;
        if (commit) this.app.exec(this._editCmd([{ clip: this.current, values: { [opts.path]: v } }], opts.label || label));
        else { applyLive(opts.path, v); this.app.timeline.requestRedraw(); this.app.player.requestRender(); }
      };
      const applyLive = opts.applyLive || ((path, v) => { const target = resolvePath(this.current, path); if (target) target.obj[target.key] = v; });
      on(num, 'change', () => push(num.value, true));
      on(num, 'input', () => { if (range) range.value = num.value; });
      if (range) {
        on(range, 'input', () => { num.value = range.value; push(range.value, false); });
        on(range, 'change', () => push(range.value, true));
      }
      const wrap = el('div.prop-inputs');
      wrap.append(num, ...(range ? [range] : []));
      if (opts.keyframable && this.current) {
        const kf = this._keyframeButton(opts.path, opts.label || label, get());
        wrap.appendChild(kf);
      }
      const r = this.row(label, wrap, opts);
      r.__path = opts.path;
      r.__sync = () => { const v = round4(get()); num.value = v; if (range) range.value = clamp(v, min, max); };
      return r;
    }

    /* A labelled dropdown. `set` receives the raw string value; `get` supplies the
       current one so rows can be re-synced after an undo. */
    selectRow(label, options, get, set, opts = {}) {
      const sel = el('select.prop-select');
      for (const opt of options) {
        const [value, text] = Array.isArray(opt) ? opt : [opt, String(opt)];
        sel.appendChild(el('option', { value: String(value), text }));
      }
      sel.value = String(get());
      on(sel, 'change', () => set(sel.value));
      const r = this.row(label, sel, opts);
      r.__sync = () => { sel.value = String(get()); };
      return r;
    }

    _editCmd(edits, name) { return OS.commands.SetClipProps(this.app.project, edits, { name }); }

    _keyframeButton(path, label, currentValue) {
      const btn = el('button.prop-kf', { title: `Keyframe ${label} at the playhead` });
      btn.innerHTML = '<svg viewBox="0 0 12 12" width="9" height="9" aria-hidden="true"><path d="M6 0.8 11.2 6 6 11.2 0.8 6Z" fill="currentColor"/></svg>';
      btn.setAttribute('aria-label', `Keyframe ${label} at the playhead`);
      const refresh = () => {
        const c = this.current;
        if (!c) return;
        const local = this.app.player.frame - c.start;
        const at = M().keyframeAt(c, path, local);
        const any = M().hasKeyframes(c, path);
        btn.classList.toggle('on', !!at);
        btn.classList.toggle('animated', any);
      };
      btn.__refresh = refresh;
      on(btn, 'click', () => {
        const c = this.current;
        if (!c) return;
        const local = clamp(this.app.player.frame - c.start, 0, c.length - 1);
        if (this.app.player.frame < c.start || this.app.player.frame > M().clipEnd(c)) { this.app.setStatus('Move the playhead inside the clip to keyframe it'); return; }
        const existing = M().keyframeAt(c, path, local);
        const value = existing ? undefined : currentValue;
        this.app.exec(OS.commands.EditKeyframes(this.app.project, c, path, local, existing ? undefined : (value ?? getPath(c, path))));
        this.refresh();
      });
      on(btn, 'contextmenu', (e) => {
        e.preventDefault();
        this.app.dialogs.contextMenu(e.clientX, e.clientY, [
          { label: 'Remove all keyframes', danger: true, action: () => {
            const c = this.current; if (!c) return;
            const had = U.deepClone(c.keyframes[path] || []);
            this.app.exec({ label: 'Clear keyframes', do() { delete c.keyframes[path]; }, undo() { if (had.length) c.keyframes[path] = had; } });
            this.refresh();
          } },
        ]);
      });
      refresh();
      return btn;
    }

    /* ---------- main render ---------- */

    showClip(clip, sel = []) {
      this.current = clip;
      this.body.innerHTML = '';
      if (!clip) {
        if (sel && sel.length > 1) this.showMulti(sel);
        else this.showProject();
        return;
      }
      this.title.textContent = 'Clip properties';
      this.sub.textContent = `${clip.length}f · ${OS.timebase.tc(clip.length, this.app.project.fps)}`;
      this._timing(clip);
      this._generator(clip);
      this._transform(clip);
      this._audio(clip);
      this._transition(clip);
      this._effects(clip);
    }

    showMulti(sel) {
      this.title.textContent = `${sel.length} clips selected`;
      const { section, body } = this.section('Bulk edit');
      const totalLen = sel.reduce((a, c) => a + c.length, 0);
      body.append(el('div.prop-note', { text: `Total duration ${OS.timebase.tc(totalLen, this.app.project.fps)} across ${new Set(sel.map((c) => c.trackId)).size} track(s).` }));
      const mk = (label, apply) => {
        const btn = el('button.btn', { text: label });
        on(btn, 'click', apply);
        return btn;
      };
      body.append(el('div.prop-btnrow', {}, [
        mk('Align start to playhead', () => this.app.alignSelected('start')),
        mk('Align end to playhead', () => this.app.alignSelected('end')),
        mk('Distribute evenly', () => this.app.distributeSelected()),
      ]));
      const vol = this.numberRow('Volume', () => (sel[0] ? sel[0].volume : 1), () => 1, { path: 'volume', min: 0, max: 4, step: 0.01, label: 'Bulk volume', range: true });
      const volInput = vol.querySelector('input.num');
      on(volInput, 'change', () => {
        const v = clamp(parseFloat(volInput.value), 0, 4);
        this.app.exec(this._editCmd(sel.map((c) => ({ clip: c, values: { volume: v } })), 'Set volume'));
      });
      body.appendChild(vol);
      this.body.appendChild(section);
    }

    showProject() {
      const p = this.app.project;
      this.title.textContent = 'Project';
      this.sub.textContent = `${p.width}×${p.height} · ${p.fps.label}`;
      const { section, body } = this.section('Project settings');
      const rows = el('div');
      rows.append(
        kv('Resolution', `${p.width} × ${p.height}`),
        kv('Frame rate', `${p.fps.label} (${p.fps.num}/${p.fps.den})`),
        kv('Duration', OS.timebase.tc(M().projectDuration(p), p.fps)),
        kv('Tracks', `${p.tracks.length}`),
        kv('Media items', `${p.assets.length}`),
        kv('Markers', `${p.markers.length}`),
      );
      const editBtn = el('button.btn', { text: 'Project settings…' });
      on(editBtn, 'click', () => this.app.dialogs.projectSettings());
      body.append(rows, el('div.prop-btnrow', {}, [editBtn]));
      this.body.appendChild(section);

      const { section: s2, body: b2 } = this.section('Selection');
      b2.append(el('div.prop-note', { text: 'Select a clip on the timeline to edit its properties. Drag media from the bin onto a track, or double-click it to append at the playhead.' }));
      this.body.appendChild(s2);

      const { section: s3, body: b3 } = this.section('Shortcuts');
      b3.append(el('div.prop-note', { text: 'Press ? or use Help > Keyboard shortcuts for the full list.' }));
      this.body.appendChild(s3);
    }

    _timing(clip) {
      const p = this.app.project;
      const { section, body } = this.section('Timing', { collapsed: false });
      const asset = M().findAsset(p, clip.assetId);
      const rows = el('div');
      rows.append(
        this.numberRow('Start', () => clip.start, () => clip.start, {
          path: 'start', min: 0, step: 1, range: false, label: 'Move clip start',
        }),
        this.numberRow('Duration', () => clip.length, () => clip.length, { path: 'length', min: 1, step: 1, range: false, label: 'Clip duration' }),
        this.numberRow('Speed', () => clip.speed, () => clip.speed, { path: 'speed', min: 0.0625, max: 16, step: 0.0125, label: 'Clip speed' }),
      );
      // in-point only meaningful for media clips
      if (asset && !clip.generator) {
        rows.append(this.numberRow('Source in', () => clip.inPoint, () => clip.inPoint, { path: 'inPoint', min: 0, step: 1, range: false, label: 'Source in point' }));
      }
      const btnRow = el('div.prop-btnrow');
      const b1 = el('button.btn', { text: 'Split at playhead' });
      on(b1, 'click', () => this.app.splitAtPlayhead());
      const b2 = el('button.btn', { text: 'Detach audio' });
      on(b2, 'click', () => this.app.detachAudio(clip));
      const b3 = el('button.btn', { text: 'Freeze frame' });
      on(b3, 'click', () => this.app.freezeFrame(clip));
      btnRow.append(b1, b2, b3);
      // reverse toggle
      const rev = el('label.prop-check');
      const cb = el('input', { type: 'checkbox', checked: clip.reverse });
      on(cb, 'change', () => this.app.exec(this._editCmd([{ clip, values: { reverse: cb.checked } }], 'Reverse clip')));
      rev.append(cb, el('span', { text: 'Reverse' }));
      rows.appendChild(rev);
      body.append(rows, btnRow);
      this.body.appendChild(section);
    }

    _generator(clip) {
      if (!clip.generator) return;
      const p = this.app.project;
      const { section, body } = this.section(clip.generator.type === 'title' ? 'Title' : 'Colour generator');
      const g = clip.generator;
      if (g.type === 'title') {
        const ta = el('textarea.prop-textarea', { rows: 3, value: g.params.text || '' });
        on(ta, 'change', () => this.app.exec(this._genCmd(clip, { text: ta.value }, 'Title text')));
        body.append(this.row('Text', ta));
        const presetSel = el('select.prop-input');
        presetSel.appendChild(el('option', { value: '', text: '— preset —' }));
        for (const pr of OS.titles.PRESETS) presetSel.appendChild(el('option', { value: pr.id, text: pr.name }));
        on(presetSel, 'change', () => {
          const pr = OS.titles.PRESETS.find((x) => x.id === presetSel.value);
          if (!pr) return;
          const before = U.deepClone(clip.generator.params);
          this.app.exec({ label: `Title preset: ${pr.name}`, do() { clip.generator.params = { ...OS.titles.defaultParams(), ...pr.params }; }, undo() { clip.generator.params = before; } });
          this.showClip(clip);
        });
        body.append(this.row('Preset', presetSel));

        const fontSel = el('select.prop-input');
        for (const f of OS.titles.FONTS) fontSel.appendChild(el('option', { value: f, text: f, selected: g.params.font === f }));
        on(fontSel, 'change', () => this.app.exec(this._genCmd(clip, { font: fontSel.value }, 'Font')));
        body.append(this.row('Font', fontSel));

        const animSel = el('select.prop-input');
        for (const [k, name] of OS.titles.ANIMATIONS) animSel.appendChild(el('option', { value: k, text: name, selected: g.params.animation === k }));
        on(animSel, 'change', () => this.app.exec(this._genCmd(clip, { animation: animSel.value }, 'Title animation')));
        body.append(this.row('Animation', animSel));

        const addNum = (label, key, min, max, step) => {
          const inp = el('input.prop-input.num', { type: 'number', min, max, step, value: g.params[key] });
          on(inp, 'change', () => this.app.exec(this._genCmd(clip, { [key]: parseFloat(inp.value) }, `Title ${label}`)));
          return this.row(label, inp);
        };
        body.append(
          addNum('Size (fraction of height)', 'size', 0.01, 0.5, 0.005),
          addNum('Colour X', 'anchorX', 0, 1, 0.01),
          addNum('Colour Y', 'anchorY', 0, 1, 0.01),
          addNum('Fade in (s)', 'fadeIn', 0, 10, 0.05),
          addNum('Fade out (s)', 'fadeOut', 0, 10, 0.05),
          addNum('Shadow', 'shadow', 0, 1, 0.05),
          addNum('Box opacity', 'boxOpacity', 0, 1, 0.05),
        );
        body.append(this.row('Colour', colorInput(g.params.color, (v) => this.app.exec(this._genCmd(clip, { color: v }, 'Title colour')))));
        const align = el('select.prop-input');
        for (const a of ['left', 'center', 'right']) align.appendChild(el('option', { value: a, text: a, selected: g.params.align === a }));
        on(align, 'change', () => this.app.exec(this._genCmd(clip, { align: align.value }, 'Title align')));
        body.append(this.row('Align', align));
        const checks = el('div.prop-btnrow');
        for (const [key, label] of [['bold', 'Bold'], ['italic', 'Italic'], ['uppercase', 'UPPERCASE'], ['gradient', 'Gradient fill']]) {
          const cb = el('input', { type: 'checkbox', checked: !!g.params[key] });
          const wrap = el('label.prop-check');
          on(cb, 'change', () => this.app.exec(this._genCmd(clip, { [key]: cb.checked }, `Title ${label}`)));
          wrap.append(cb, el('span', { text: label }));
          checks.appendChild(wrap);
        }
        body.appendChild(checks);
      } else {
        const typeSel = el('select.prop-input');
        for (const [k, name] of [['solid', 'Solid colour'], ['gradient', 'Linear gradient']]) typeSel.appendChild(el('option', { value: k, text: name, selected: (g.params.type || 'solid') === k }));
        on(typeSel, 'change', () => this.app.exec(this._genCmd(clip, { type: typeSel.value }, 'Generator type')));
        body.append(this.row('Type', typeSel));
        body.append(this.row('Colour', colorInput(g.params.color || '#1460ff', (v) => this.app.exec(this._genCmd(clip, { color: v }, 'Generator colour')))));
        if ((g.params.type || 'solid') === 'gradient') {
          body.append(this.row('Colour 2', colorInput(g.params.color2 || '#0a0f1a', (v) => this.app.exec(this._genCmd(clip, { color2: v }, 'Generator colour 2')))));
          const ang = el('input.prop-input.num', { type: 'number', min: 0, max: 360, step: 1, value: g.params.angle ?? 90 });
          on(ang, 'change', () => this.app.exec(this._genCmd(clip, { angle: parseFloat(ang.value) }, 'Gradient angle')));
          body.append(this.row('Angle', ang));
        }
      }
      this.body.appendChild(section);
    }

    _genCmd(clip, values, name) {
      const g = clip.generator;
      const prev = {};
      for (const k of Object.keys(values)) prev[k] = g.params[k];
      return {
        label: name,
        do() { Object.assign(g.params, values); },
        undo() { for (const k of Object.keys(values)) { if (prev[k] === undefined) delete g.params[k]; else g.params[k] = prev[k]; } },
      };
    }

    _transform(clip) {
      const { section, body } = this.section('Transform');
      const t = clip.transform;
      if (clip.adjustment) {
        body.append(el('div.prop-note', { text: 'An adjustment layer carries no picture of its own — its effects grade every track beneath it. Opacity blends the graded result back over the program.' }));
      } else {
        body.append(
          this.numberRow('Position X', () => M().evalAt(clip, this.app.player.frame, 'transform.x', t.x), () => t.x, { path: 'transform.x', min: -2, max: 2, step: 0.005, keyframable: true }),
          this.numberRow('Position Y', () => M().evalAt(clip, this.app.player.frame, 'transform.y', t.y), () => t.y, { path: 'transform.y', min: -2, max: 2, step: 0.005, keyframable: true }),
          this.numberRow('Scale', () => M().evalAt(clip, this.app.player.frame, 'transform.scale', t.scale), () => t.scale, { path: 'transform.scale', min: 0.01, max: 6, step: 0.01, keyframable: true }),
          this.numberRow('Rotation', () => M().evalAt(clip, this.app.player.frame, 'transform.rotation', t.rotation), () => t.rotation, { path: 'transform.rotation', min: -360, max: 360, step: 0.5, keyframable: true }),
        );
      }
      body.append(
        this.numberRow('Opacity', () => M().evalAt(clip, this.app.player.frame, 'opacity', clip.opacity), () => clip.opacity, { path: 'opacity', min: 0, max: 1, step: 0.01, keyframable: true }),
        this.selectRow('Blend mode', M().BLEND_MODES.map((m) => [m[0], m[1]]), () => clip.blend || 'normal', (v) => {
          this.app.exec(this._editCmd([{ clip, values: { blend: v } }], 'Blend: ' + M().blendLabel(v)));
          this.app.player.requestRender();
        }, { title: 'How this layer composites onto the video tracks below it' }),
      );
      if (!clip.adjustment) {
        body.append(
          this.numberRow('Crop left', () => clip.crop.l, () => clip.crop.l, { path: 'crop.l', min: 0, max: 0.49, step: 0.005 }),
          this.numberRow('Crop top', () => clip.crop.t, () => clip.crop.t, { path: 'crop.t', min: 0, max: 0.49, step: 0.005 }),
          this.numberRow('Crop right', () => clip.crop.r, () => clip.crop.r, { path: 'crop.r', min: 0, max: 0.49, step: 0.005 }),
          this.numberRow('Crop bottom', () => clip.crop.b, () => clip.crop.b, { path: 'crop.b', min: 0, max: 0.49, step: 0.005 }),
        );
      }
      const btns = [];
      if (!clip.adjustment) {
        const reset = el('button.btn', { text: 'Reset transform' });
        on(reset, 'click', () => this.app.exec(this._editCmd([{ clip, values: { transform: { x: 0, y: 0, scale: 1, rotation: 0 }, crop: { l: 0, t: 0, r: 0, b: 0 } } }], 'Reset transform')));
        btns.push(reset);
      }
      const ng = el('button.btn', { text: 'Normalise audio' });
      ng.title = 'Set the clip gain so its loudest peak sits just under 0 dBFS';
      on(ng, 'click', () => this.app.normalizeAudio([clip]));
      btns.push(ng);
      body.appendChild(el('div.prop-btnrow', {}, btns));
      this.body.appendChild(section);
    }

    _audio(clip) {
      const p = this.app.project;
      const track = M().findTrack(p, clip.trackId);
      const asset = M().findAsset(p, clip.assetId);
      const hasAudio = clip.generator ? false : !!(asset && asset.kind !== 'image');
      if (!hasAudio && track.kind !== 'audio') return;
      const { section, body } = this.section('Audio');
      const fps = p.fps.rate;
      body.append(
        this.numberRow('Volume', () => clip.volume, () => clip.volume, { path: 'volume', min: 0, max: 4, step: 0.01, keyframable: true }),
        this.numberRow('Fade in (s)', () => clip.fadeIn / fps, () => clip.fadeIn / fps, {
          path: 'fadeIn', min: 0, max: 60, step: 0.05, range: true, label: 'Audio fade in',
          applyLive: (path, v) => { clip.fadeIn = Math.round(clamp(v, 0, clip.length) * fps); },
        }),
        this.numberRow('Fade out (s)', () => clip.fadeOut / fps, () => clip.fadeOut / fps, {
          path: 'fadeOut', min: 0, max: 60, step: 0.05, range: true, label: 'Audio fade out',
          applyLive: (path, v) => { clip.fadeOut = Math.round(clamp(v, 0, clip.length) * fps); },
        }),
      );
      // note: fade rows above use clip-relative frames; commit path must be the frame value
      const eq = clip.audioEq || (clip.audioEq = { low: 0, mid: 0, high: 0 });
      body.append(
        this.numberRow('Low EQ (dB)', () => eq.low, () => eq.low, { path: 'audioEq.low', min: -18, max: 18, step: 0.5, label: 'Audio low EQ' }),
        this.numberRow('Mid EQ (dB)', () => eq.mid, () => eq.mid, { path: 'audioEq.mid', min: -18, max: 18, step: 0.5, label: 'Audio mid EQ' }),
        this.numberRow('High EQ (dB)', () => eq.high, () => eq.high, { path: 'audioEq.high', min: -18, max: 18, step: 0.5, label: 'Audio high EQ' }),
      );
      const ng = el('button.btn', { text: 'Normalise to -1 dBFS' });
      on(ng, 'click', () => this.app.normalizeAudio([clip]));
      const rs = el('button.btn', { text: 'Reset EQ' });
      on(rs, 'click', () => this.app.exec(this._editCmd([{ clip, values: { 'audioEq.low': 0, 'audioEq.mid': 0, 'audioEq.high': 0 } }], 'Reset audio EQ')));
      body.appendChild(el('div.prop-btnrow', {}, [ng, rs]));
      this.body.appendChild(section);
    }

    _transition(clip) {
      const p = this.app.project;
      const track = M().findTrack(p, clip.trackId);
      const prev = track ? M().prevClip(track, clip) : null;
      const ov = prev ? M().overlapOf(prev, clip) : 0;
      if (ov <= 0) {
        const { section, body } = this.section('Transition');
        body.append(el('div.prop-note', { text: 'Drag this clip over the previous clip on the same track to create an overlap transition, or use the toolbar button.' }));
        const mk = el('button.btn', { text: 'Add transition (10%)' });
        on(mk, 'click', () => this.app.addTransitionToClip(clip));
        body.appendChild(el('div.prop-btnrow', {}, [mk]));
        this.body.appendChild(section);
        return;
      }
      const { section, body } = this.section('Transition (overlap)');
      const sel = el('select.prop-input');
      for (const [k, name] of OS.transitions.TYPES) sel.appendChild(el('option', { value: k, text: name, selected: (clip.transitionIn || {}).type === k }));
      on(sel, 'change', () => {
        const before = U.deepClone(clip.transitionIn);
        const type = sel.value;
        this.app.exec({ label: 'Transition type', do() { if (!clip.transitionIn) clip.transitionIn = { type, length: ov }; else clip.transitionIn.type = type; }, undo() { clip.transitionIn = before; } });
      });
      const len = el('input.prop-range', { type: 'range', min: 1, max: ov, step: 1, value: (clip.transitionIn || { length: ov }).length });
      const lenNum = el('input.prop-input.num', { type: 'number', min: 1, max: ov, step: 1, value: (clip.transitionIn || { length: ov }).length });
      on(lenNum, 'change', () => {
        const v = clamp(parseInt(lenNum.value), 1, ov);
        const before = (clip.transitionIn || {}).length;
        this.app.exec(this._editCmd([{ clip, values: { 'transitionIn.length': v }, prev: { 'transitionIn.length': before } }], 'Transition length'));
      });
      on(len, 'change', () => {
        const v = clamp(parseInt(len.value), 1, ov);
        const before = (clip.transitionIn || {}).length;
        this.app.exec(this._editCmd([{ clip, values: { 'transitionIn.length': v }, prev: { 'transitionIn.length': before } }], 'Transition length'));
      });
      if (!clip.transitionIn) clip.transitionIn = { type: OS.transitions.defaultType, length: ov };
      body.append(
        this.row('Type', sel),
        this.row('Length', el('div.prop-inputs', {}, [lenNum, len])),
        el('div.prop-note', { text: `Overlap with “${prev.name}” is ${ov} frames (${(ov / p.fps.rate).toFixed(2)} s).` }),
      );
      const rm = el('button.btn', { text: 'Remove transition' });
      on(rm, 'click', () => {
        const before = U.deepClone(clip.transitionIn);
        this.app.exec({ label: 'Remove transition', do() { clip.transitionIn = null; }, undo() { clip.transitionIn = before; } });
      });
      body.appendChild(el('div.prop-btnrow', {}, [rm]));
      this.body.appendChild(section);
    }

    _effects(clip) {
      const { section, body } = this.section('Effects');
      const addRow = el('div.prop-row');
      const sel = el('select.prop-input');
      sel.appendChild(el('option', { value: '', text: 'Add effect…' }));
      const groups = { video: 'Video effects', audio: 'Audio effects' };
      for (const [cat, label] of Object.entries(groups)) {
        const og = el('optgroup', { label });
        for (const reg of Object.values(OS.effects.registry)) {
          if ((reg.category || 'video') !== cat) continue;
          if (clip.generator && cat === 'video' && reg.type === 'chromakey') continue;
          og.appendChild(el('option', { value: reg.type, text: reg.label }));
        }
        sel.appendChild(og);
      }
      on(sel, 'change', () => {
        const type = sel.value;
        sel.value = '';
        if (!type) return;
        const fx = M().createEffect(type);
        this.app.exec(OS.commands.AddEffect(this.app.project, clip, fx));
        this.showClip(clip);
      });
      addRow.append(el('label.prop-label', { text: 'Add' }), sel);
      body.appendChild(addRow);

      if (!clip.effects.length) body.appendChild(el('div.prop-note', { text: 'No effects. Effects apply top-to-bottom in this list.' }));

      for (const fx of clip.effects) {
        const reg = OS.effects.registry[fx.type] || { label: fx.type, params: {} };
        const box = el('div.fx-box');
        const head = el('div.fx-head');
        const cb = el('input', { type: 'checkbox', checked: fx.enabled });
        on(cb, 'change', () => {
          const before = fx.enabled;
          this.app.exec({ label: 'Toggle effect', do() { fx.enabled = cb.checked; }, undo() { fx.enabled = before; } });
        });
        const name = el('span.fx-name', { text: reg.label });
        const up = el('button.btn.btn-icon', { title: 'Move up' });
        up.innerHTML = '<svg viewBox="0 0 12 12" width="11" height="11" aria-hidden="true"><path d="M6 2.2 10 8H2Z" fill="currentColor"/></svg>';
        const down = el('button.btn.btn-icon', { title: 'Move down' });
        down.innerHTML = '<svg viewBox="0 0 12 12" width="11" height="11" aria-hidden="true"><path d="M6 9.8 2 4h8Z" fill="currentColor"/></svg>';
        const del = el('button.btn.btn-icon.danger', { title: 'Remove effect' });
        del.innerHTML = '<svg viewBox="0 0 12 12" width="11" height="11" aria-hidden="true"><path d="M3 3l6 6M9 3l-6 6" stroke="currentColor" stroke-width="1.6" fill="none" stroke-linecap="round"/></svg>';
        on(up, 'click', () => { this.app.exec(OS.commands.ReorderEffects(this.app.project, clip, fx, -1)); this.showClip(clip); });
        on(down, 'click', () => { this.app.exec(OS.commands.ReorderEffects(this.app.project, clip, fx, 1)); this.showClip(clip); });
        on(del, 'click', () => { this.app.exec(OS.commands.RemoveEffect(this.app.project, clip, fx)); this.showClip(clip); });
        head.append(cb, name, el('span.spacer'), up, down, del);
        box.appendChild(head);

        for (const [key, spec] of Object.entries(reg.params || {})) {
          const path = `fx.${fx.id}.${key}`;
          if (spec.kind === 'select') {
            const s2 = el('select.prop-input');
            for (const [v, label] of spec.options) s2.appendChild(el('option', { value: v, text: label, selected: fx.params[key] === v }));
            on(s2, 'change', () => {
              const before = fx.params[key];
              this.app.exec({ label: `${reg.label}: ${spec.label}`, do() { fx.params[key] = s2.value; }, undo() { fx.params[key] = before; } });
            });
            box.appendChild(this.row(spec.label, s2));
          } else if (spec.kind === 'color') {
            const inp = el('input.prop-input.prop-color', { type: 'color', value: fx.params[key] || '#000000' });
            on(inp, 'input', () => { fx.params[key] = inp.value; this.app.player.requestRender(); });
            on(inp, 'change', () => {
              const before = fx.params[key];
              const after = inp.value;
              this.app.exec({ label: `${reg.label}: ${spec.label}`, do() { fx.params[key] = after; }, undo() { fx.params[key] = before; } });
            });
            box.appendChild(this.row(spec.label, inp));
          } else {
            const liveApply = (p, v) => { fx.params[key] = v; };
            const row = this.numberRow(spec.label, () => M().evalAt(clip, this.app.player.frame, path, fx.params[key]), () => fx.params[key], {
              path, min: spec.min, max: spec.max, step: spec.step, keyframable: true, label: `${reg.label} ${spec.label}`,
              applyLive: (p, v) => { fx.params[key] = v; },
            });
            box.appendChild(row);
          }
        }
        body.appendChild(box);
      }
      this.body.appendChild(section);
    }

    /* ---------- media info ---------- */

    showAsset(asset) {
      this.current = null;
      this.assetInfo = asset;
      this.refreshAsset();
    }
    refreshAsset() {
      const asset = this.assetInfo;
      const p = this.app.project;
      if (!asset) return;
      this.title.textContent = 'Media properties';
      this.sub.textContent = asset.kind;
      this.body.innerHTML = '';
      const { section, body } = this.section('Media');
      body.append(
        kv('Name', asset.name),
        kv('Kind', asset.kind),
        kv('Dimensions', asset.width ? `${asset.width} × ${asset.height}` : '—'),
        kv('Duration', OS.timebase.tc(asset.durationFrames, p.fps)),
        kv('Size', U.fmtBytes(asset.bytes)),
        kv('MIME', asset.type || '—'),
        kv('Status', asset.missing ? 'MISSING — relink required' : 'available'),
      );
      const relink = el('button.btn', { text: 'Relink / replace file…' });
      on(relink, 'click', () => this.app.relinkAsset(asset));
      const insert = el('button.btn.btn-primary', { text: 'Insert at playhead' });
      on(insert, 'click', () => this.app.insertAssetAtPlayhead(asset));
      body.appendChild(el('div.prop-btnrow', {}, [insert, relink]));
      this.body.appendChild(section);

      const { section: s2, body: b2 } = this.section('Used in timeline');
      const used = [];
      for (const t of p.tracks) for (const c of M().clipsOf(p, t)) if (c.assetId === asset.id) used.push({ t, c });
      if (!used.length) b2.appendChild(el('div.prop-note', { text: 'Not used yet.' }));
      for (const { t, c } of used) {
        const b = el('button.btn.link', { text: `${t.name} — ${OS.timebase.tc(c.start, p.fps)} (${OS.timebase.tc(c.length, p.fps)})` });
        on(b, 'click', () => this.app.revealClip(c));
        b2.appendChild(b);
      }
      this.body.appendChild(s2);
    }
  }

  /* ---------- helpers ---------- */

  function resolvePath(obj, path) {
    const keys = path.split('.');
    const last = keys.pop();
    let cur = obj;
    for (const k of keys) { if (cur == null) return null; cur = cur[k]; }
    return cur == null ? null : { obj: cur, key: last };
  }
  function getPath(obj, path) {
    const r = resolvePath(obj, path);
    return r ? r.obj[r.key] : undefined;
  }
  function round4(v) { return typeof v === 'number' ? Math.round(v * 10000) / 10000 : v; }
  function kv(k, v) {
    return el('div.prop-kv', {}, [el('span.prop-kv-k', { text: k }), el('span.prop-kv-v', { text: String(v) })]);
  }
  function colorInput(value, onChange) {
    const c = el('input.prop-color', { type: 'color', value: value || '#ffffff' });
    const t = el('input.prop-input.hex', { type: 'text', value: value || '#ffffff' });
    on(c, 'input', () => { t.value = c.value; onChange(c.value); });
    on(t, 'change', () => { if (/^#[0-9a-f]{6}$/i.test(t.value)) { c.value = t.value; onChange(t.value); } });
    return el('div.prop-inputs', {}, [c, t]);
  }

  OS.properties = { Properties, colorInput, kv };
})();
