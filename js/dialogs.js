/* OpenScene — dialogs.js
   Modal dialogs (export, project settings, shortcuts, about, confirm/prompt),
   plus themed context menus and toasts. */
(() => {
  'use strict';
  const OS = (window.OS = window.OS || {});
  const U = OS.util;
  const { el, on, esc, clamp, fmtBytes } = U;
  const M = () => OS.model;

  class Dialogs {
    constructor(app) {
      this.app = app;
      this.layer = el('div.modal-layer');
      this.ctxLayer = el('div.context-layer');
      this.toasts = el('div.toast-layer');
      document.body.append(this.layer, this.ctxLayer, this.toasts);
      on(window, 'mousedown', (e) => { if (!this.ctxLayer.contains(e.target)) this.closeContextMenu(); }, true);
      on(window, 'blur', () => this.closeContextMenu());
      on(document, 'keydown', (e) => { if (e.key === 'Escape') this.closeContextMenu(); });
    }

    /* ---------- generic modal ---------- */

    open(title, contentNode, opts = {}) {
      const box = el('div.modal' + (opts.wide ? '.wide' : '') + (opts.small ? '.small' : ''));
      const head = el('div.modal-head');
      head.append(el('div.modal-title', { text: title }));
      const close = el('button.modal-close', { title: 'Close' });
      close.innerHTML = '<svg viewBox="0 0 12 12" width="11" height="11" aria-hidden="true"><path d="M2.6 2.6l6.8 6.8M9.4 2.6l-6.8 6.8" stroke="currentColor" stroke-width="1.6" fill="none" stroke-linecap="round"/></svg>';
      head.appendChild(close);
      const body = el('div.modal-body');
      body.appendChild(contentNode);
      const foot = el('div.modal-foot');
      box.append(head, body, foot);
      this.layer.innerHTML = '';
      this.layer.appendChild(box);
      this.layer.classList.add('open');
      const api = {
        box, body, foot, close: () => this.close(),
        onClose: () => {},
      };
      on(close, 'click', () => this.close());
      if (opts.dismissable !== false) on(this.layer, 'mousedown', (e) => { if (e.target === this.layer) this.close(); });
      this._current = api;
      return api;
    }

    close() {
      const api = this._current;
      this._current = null;
      this.layer.classList.remove('open');
      this.layer.innerHTML = '';
      if (api) { try { api.onClose(); } catch (e) {} }
    }

    button(label, fn, cls = '') {
      const b = el('button.btn' + (cls ? '.' + cls : ''), { text: label });
      on(b, 'click', fn);
      return b;
    }

    confirm(title, message, { danger = false, okLabel = 'OK', cancelLabel = 'Cancel' } = {}) {
      return new Promise((resolve) => {
        const content = el('div.modal-message', { text: message });
        const api = this.open(title, content, { small: true });
        const cancel = this.button(cancelLabel, () => { resolve(false); api.close(); });
        const ok = this.button(okLabel, () => { resolve(true); api.close(); }, danger ? 'danger' : 'primary');
        api.foot.append(el('span.spacer'), cancel, ok);
        api.onClose = () => resolve(false);
        setTimeout(() => ok.focus(), 0);
      });
    }

    prompt(title, message, value = '', { okLabel = 'OK' } = {}) {
      return new Promise((resolve) => {
        const input = el('input.text-input', { value });
        const content = el('div', {}, [el('div.modal-message', { text: message }), input]);
        const api = this.open(title, content, { small: true });
        const cancel = this.button('Cancel', () => { resolve(null); api.close(); });
        const ok = this.button(okLabel, () => { const v = input.value; resolve(v); api.close(); }, 'primary');
        api.foot.append(el('span.spacer'), cancel, ok);
        api.onClose = () => resolve(null);
        on(input, 'keydown', (e) => { if (e.key === 'Enter') { const v = input.value; resolve(v); api.close(); } });
        setTimeout(() => { input.focus(); input.select(); }, 0);
      });
    }

    /* Change one or more clips' speed.

       Speed changes the relationship between timeline time and source time, so
       it has to answer a second question: does the clip get shorter, or does it
       keep its length and use less of the source? Both are legitimate and they
       look completely different, so this asks rather than guessing.

       `clips` is a list of {clip, length} where length is the clip's current
       timeline length. Resolves to null if cancelled, otherwise
       {speed, mode} where mode is 'retime' (length follows speed) or
       'hold' (length is kept, the source range shrinks). */
    changeSpeed(clips, { fps = 25 } = {}) {
      if (!clips || !clips.length) return Promise.resolve(null);
      return new Promise((resolve) => {
        const multi = clips.length > 1;
        const first = clips[0];

        /* The project's fps is a timebase object ({num, den, rate, label}),
           not a plain number, so dividing frames by it yields NaN. Prefer the
           canonical helper, which keeps non-integer rates like 23.976 exact. */
        const tb = OS.timebase;
        const secsOf = (typeof fps === 'number' || !fps || !fps.num)
          ? (frames) => frames / ((typeof fps === 'number' ? fps : 25) || 25)
          : (frames) => tb.framesToSeconds(frames, fps);

        const seconds = (frames) => {
          const s = secsOf(frames);
          return s.toFixed(s < 10 ? 2 : 1) + 's';
        };

        const speedInput = el('input.text-input', { value: String(first.clip.speed || 1) });
        speedInput.type = 'number';
        speedInput.min = '0.0625';
        speedInput.max = '16';
        speedInput.step = '0.0625';

        /* Presets cover the common cases so the field is not the only way in. */
        const presets = [0.25, 0.5, 1, 1.5, 2, 4, 8];
        const presetRow = el('div.sp-presets');
        for (const p of presets) {
          const b = el('button.sp-preset', { text: p + 'x', type: 'button' });
          if (Math.abs((first.clip.speed || 1) - p) < 1e-6) b.classList.add('on');
          on(b, 'click', () => {
            speedInput.value = String(p);
            presetRow.querySelectorAll('.sp-preset').forEach((x) => x.classList.remove('on'));
            b.classList.add('on');
            update();
          });
          presetRow.appendChild(b);
        }

        /* Two radio rows. The numbers are computed live so the choice is made
           with the real result in front of you, not a description of it. */
        let mode = 'retime';
        const mkMode = (value, title) => {
          const row = el('label.sp-mode');
          const radio = el('input', { type: 'radio', name: 'spm' });
          radio.value = value;
          radio.checked = value === mode;
          on(radio, 'change', () => { mode = value; update(); });
          const body = el('div.sp-mode-body');
          body.appendChild(el('div.sp-mode-title', { text: title }));
          const detail = el('div.sp-mode-detail');
          body.appendChild(detail);
          row.append(radio, body);
          row._detail = detail;
          return row;
        };
        const rowRetime = mkMode('retime', multi ? 'Keep the same source for each clip' : 'Keep the whole clip, change how fast it plays');
        const rowHold = mkMode('hold', multi ? 'Keep the current lengths' : 'Keep the current length on the timeline');

        const summary = el('div.sp-summary');

        const readSpeed = () => {
          const v = parseFloat(speedInput.value);
          return Number.isFinite(v) && v > 0 ? v : null;
        };

        const update = () => {
          const v = readSpeed();
          const srcLen = first.length * (first.clip.speed || 1); // source frames used
          if (v != null) {
            const newLen = Math.max(1, Math.round(srcLen / v));
            rowRetime._detail.textContent = seconds(first.length) + '  ->  ' + seconds(newLen) +
              '  (all ' + seconds(first.length * (first.clip.speed || 1)) + ' of source, ' +
              (v > 1 ? 'faster' : v < 1 ? 'slower' : 'unchanged') + ')';
            rowHold._detail.textContent = seconds(first.length) + '  stays, playing ' +
              seconds(Math.min(first.length * (first.clip.speed || 1), first.length * v)) + ' of source';
          } else {
            rowRetime._detail.textContent = '';
            rowHold._detail.textContent = '';
          }
          if (v == null) { summary.textContent = 'Enter a speed above zero.'; return; }
          if (v === 1) summary.textContent = 'No change.';
          else if (multi) summary.textContent = clips.length + ' clips at ' + v + 'x' + (v > 1 ? ' (faster)' : ' (slower)');
          else summary.textContent = v + 'x' + (v > 1 ? ' - faster' : ' - slower');
        };

        on(speedInput, 'input', () => {
          presetRow.querySelectorAll('.sp-preset').forEach((x) => x.classList.remove('on'));
          update();
        });
        update();

        const content = el('div.sp', {}, [
          el('div.modal-message', { text: multi
            ? 'Set the speed for ' + clips.length + ' selected clips.'
            : 'Set the speed for this clip.' }),
          el('div.sp-field', {}, [el('span.sp-label', { text: 'Speed' }), speedInput, el('span.sp-x', { text: 'x' })]),
          presetRow,
          el('div.sp-modes', {}, [rowRetime, rowHold]),
          summary,
        ]);

        const api = this.open('Clip speed', content, { small: true });
        const cancel = this.button('Cancel', () => { resolve(null); api.close(); });
        const ok = this.button('Apply', () => {
          const v = readSpeed();
          if (v == null) { speedInput.focus(); return; }
          /* Resolve before closing: close() runs onClose synchronously, and a
             later resolve would be dropped because the promise already
             settled as null. */
          resolve({ speed: v, mode });
          api.close();
        }, 'primary');
        api.foot.append(el('span.spacer'), cancel, ok);
        api.onClose = () => resolve(null);
        on(speedInput, 'keydown', (e) => {
          if (e.key === 'Enter') { e.preventDefault(); ok.click(); }
        });
        setTimeout(() => { speedInput.focus(); speedInput.select(); }, 0);
      });
    }

    /* ---------- context menus ---------- */

    /* Leading glyph for a menu row: an SVG tick for checked rows, otherwise the
       supplied text icon. Rendered as SVG so the UI stays free of emoji glyphs. */
    _decorate(row, it) {
      if (it.checked) {
        const c = el('span.context-icon.context-check');
        c.innerHTML = '<svg viewBox="0 0 10 10" width="9" height="9" aria-hidden="true">' +
          '<path d="M1.4 5.3 3.8 7.7 8.6 2.3" stroke="currentColor" stroke-width="1.8" fill="none" ' +
          'stroke-linecap="round" stroke-linejoin="round"/></svg>';
        row.appendChild(c);
      } else if (it.icon) {
        row.appendChild(el('span.context-icon', { text: it.icon }));
      }
    }

    contextMenu(x, y, items) {
      this.closeContextMenu();
      const menu = el('div.context-menu');
      for (const it of items) {
        if (!it) continue;
        if (it.sep) { menu.appendChild(el('div.context-sep')); continue; }
        const row = el('div.context-item' + (it.danger ? '.danger' : '') + (it.disabled ? '.disabled' : ''));
        this._decorate(row, it);
        row.appendChild(el('span.context-label', { text: it.label }));
        if (it.hint) row.appendChild(el('span.context-hint', { text: it.hint }));
        if (it.submenu) {
          row.appendChild(el('span.context-more', { text: '›' }));
          on(row, 'mouseenter', () => this._openSubmenu(row, it.submenu));
          on(row, 'click', (e) => { e.stopPropagation(); });
        } else if (!it.disabled) {
          on(row, 'mouseenter', () => this._closeSubmenus(menu));
          on(row, 'click', (e) => { e.stopPropagation(); this.closeContextMenu(); it.action && it.action(); });
        }
        menu.appendChild(row);
      }
      this.ctxLayer.appendChild(menu);
      const r = menu.getBoundingClientRect();
      menu.style.left = Math.min(x, window.innerWidth - r.width - 6) + 'px';
      menu.style.top = Math.min(y, window.innerHeight - r.height - 6) + 'px';
      this.ctxLayer.classList.add('open');
    }

    _openSubmenu(row, items) {
      this._closeSubmenus(row.parentElement);
      const r = row.getBoundingClientRect();
      const sub = el('div.context-menu.submenu');
      for (const it of items) {
        if (!it) continue;
        if (it.sep) { sub.appendChild(el('div.context-sep')); continue; }
        const item = el('div.context-item' + (it.danger ? '.danger' : ''));
        this._decorate(item, it);
        item.appendChild(el('span.context-label', { text: it.label }));
        on(item, 'click', (e) => { e.stopPropagation(); this.closeContextMenu(); it.action && it.action(); });
        sub.appendChild(item);
      }
      this.ctxLayer.appendChild(sub);
      const sr = sub.getBoundingClientRect();
      sub.style.left = Math.min(r.right + 2, window.innerWidth - sr.width - 6) + 'px';
      sub.style.top = Math.min(r.top, window.innerHeight - sr.height - 6) + 'px';
      sub.__parentRow = row;
    }

    _closeSubmenus(within) {
      for (const s of [...this.ctxLayer.querySelectorAll('.submenu')]) {
        if (!within || s.__parentRow === within || !within.contains(s.__parentRow)) s.remove();
      }
      // remove all submenus whose parent row isn't hovered any more
      for (const s of [...this.ctxLayer.querySelectorAll('.submenu')]) s.remove();
    }

    closeContextMenu() {
      this.ctxLayer.innerHTML = '';
      this.ctxLayer.classList.remove('open');
    }

    /* ---------- toasts ---------- */

    toast(message, kind = 'info', ms = 4200) {
      const t = el('div.toast.' + kind);
      t.appendChild(el('span.toast-msg', { text: message }));
      const close = el('button.toast-close', { title: 'Dismiss' });
      close.innerHTML = '<svg viewBox="0 0 12 12" width="10" height="10" aria-hidden="true"><path d="M2.6 2.6l6.8 6.8M9.4 2.6l-6.8 6.8" stroke="currentColor" stroke-width="1.6" fill="none" stroke-linecap="round"/></svg>';
      on(close, 'click', () => t.remove());
      t.appendChild(close);
      this.toasts.appendChild(t);
      requestAnimationFrame(() => t.classList.add('in'));
      setTimeout(() => { t.classList.remove('in'); setTimeout(() => t.remove(), 300); }, ms);
      return t;
    }

    /* ---------- export dialog ---------- */

    exportDialog() {
      const app = this.app;
      const p = app.project;
      const dur = M().projectDuration(p);
      const state = {
        preset: 'youtube1080',
        engine: 'precise',
        quality: 'high',
        container: 'mp4',
        codec: 'h264',
        width: p.width, height: p.height, fps: p.fps.rate,
        videoBitrate: 8_000_000, audioBitrate: 192_000, audio: true, hardware: true,
        rangeMode: 'all',
        running: false,
      };

      const content = el('div.export-dialog');
      const left = el('div.export-left');
      const right = el('div.export-right');
      content.append(left, right);

      // preset list
      const presetList = el('div.export-presets');
      for (const pr of OS.export.PRESETS) {
        const b = el('button.export-preset' + (pr.id === state.preset ? '.on' : ''), { text: pr.name });
        on(b, 'click', () => {
          state.preset = pr.id;
          for (const ch of presetList.children) ch.classList.remove('on');
          b.classList.add('on');
          applyPreset(pr);
          syncFields();
        });
        b.__preset = pr;
        presetList.appendChild(b);
      }
      left.appendChild(el('div.export-group-title', { text: 'Preset' }));
      left.appendChild(presetList);
      const summary = el('div.export-summary');
      left.appendChild(summary);

      // right: fields
      const fields = el('div.export-fields');
      const field = (label, node, hint) => {
        const r = el('div.export-field');
        r.append(el('label.export-label', { text: label }), node);
        if (hint) r.appendChild(el('div.export-hint', { text: hint }));
        return r;
      };

      const engineSel = el('select.prop-input');
      engineSel.append(
        el('option', { value: 'precise', text: 'Precise — frame-exact (WebCodecs, H.264 up to 4K)' }),
        el('option', { value: 'realtime', text: 'Realtime capture (MediaRecorder, VP9 up to 8K)' }),
      );
      on(engineSel, 'change', () => { state.engine = engineSel.value; updateEstimate(); });

      const qualitySel = el('select.prop-input');
      for (const q of OS.export.QUALITY_STEPS) qualitySel.appendChild(el('option', { value: q.id, text: q.name, selected: q.id === state.quality }));
      on(qualitySel, 'change', () => { state.quality = qualitySel.value; updateEstimate(); });

      const containerSel = el('select.prop-input');
      for (const [v, t] of [
        ['mp4', 'MP4 (H.264 + AAC) — up to 4K'],
        ['webm', 'WebM (VP9) — up to 8K'],
        ['pngseq', 'PNG image sequence (ZIP) — up to 16K'],
        ['wav', 'WAV (audio only)'],
        ['m4a', 'M4A (AAC, audio only)'],
      ]) {
        containerSel.appendChild(el('option', { value: v, text: t, selected: v === state.container }));
      }
      on(containerSel, 'change', () => { state.container = containerSel.value; applyContainerState(); updateEstimate(); });

      const sizeW = el('input.prop-input.num', { type: 'number', min: 2, max: OS.export.MAX_SIDE, step: 2, value: state.width });
      const sizeH = el('input.prop-input.num', { type: 'number', min: 2, max: OS.export.MAX_SIDE, step: 2, value: state.height });
      on(sizeW, 'change', () => { state.width = OS.export.even(sizeW.value); sizeW.value = state.width; updateEstimate(); });
      on(sizeH, 'change', () => { state.height = OS.export.even(sizeH.value); sizeH.value = state.height; updateEstimate(); });

      const fpsInput = el('input.prop-input.num', { type: 'number', min: 1, max: 240, step: 0.001, value: round3(state.fps) });
      on(fpsInput, 'change', () => { state.fps = clamp(parseFloat(fpsInput.value) || 30, 1, 240); updateEstimate(); });

      const vbr = el('input.prop-input.num', { type: 'number', min: 200_000, max: 200_000_000, step: 100_000, value: state.videoBitrate });
      on(vbr, 'change', () => { state.videoBitrate = parseInt(vbr.value); updateEstimate(); });

      const abr = el('select.prop-input');
      for (const r of [96_000, 128_000, 160_000, 192_000, 256_000, 320_000]) abr.appendChild(el('option', { value: r, text: `${r / 1000} kbps`, selected: r === state.audioBitrate }));
      on(abr, 'change', () => { state.audioBitrate = parseInt(abr.value); updateEstimate(); });

      const audioCb = el('input', { type: 'checkbox', checked: state.audio });
      on(audioCb, 'change', () => { state.audio = audioCb.checked; updateEstimate(); });
      const audioRow = el('label.prop-check');
      audioRow.append(audioCb, el('span', { text: 'Include audio' }));

      const hw = el('input', { type: 'checkbox', checked: state.hardware });
      on(hw, 'change', () => { state.hardware = hw.checked; });
      const hwRow = el('label.prop-check');
      hwRow.append(hw, el('span', { text: 'Prefer hardware encoder (GPU)' }));

      const sel = app.timeline.getSelectedClips ? app.timeline.getSelectedClips() : [];
      const selSpan = sel.length
        ? { start: Math.min.apply(null, sel.map((c) => c.start)), end: Math.max.apply(null, sel.map((c) => M().clipEnd(c))) }
        : null;
      const rangeSel = el('select.prop-input');
      rangeSel.append(
        el('option', { value: 'all', text: `Entire project (${OS.timebase.tc(dur, p.fps)})` }),
        el('option', { value: 'inout', text: p.inPoint != null || p.outPoint != null ? `In/out range (${OS.timebase.tc((p.inPoint || 0), p.fps)} → ${OS.timebase.tc(p.outPoint ?? dur, p.fps)})` : 'In/out range (none set)' }),
        el('option', {
          value: 'selection',
          text: selSpan
            ? `Selected clips (${sel.length}: ${OS.timebase.tc(selSpan.start, p.fps)} → ${OS.timebase.tc(selSpan.end, p.fps)})`
            : 'Selected clips (none selected)',
        }),
      );
      on(rangeSel, 'change', () => { state.rangeMode = rangeSel.value; updateEstimate(); });

      const nameInput = el('input.text-input', { value: p.name || 'OpenScene Project' });

      fields.append(
        field('Engine', engineSel, 'Precise renders frame-by-frame and can be faster or slower than realtime. Realtime records the preview at 1× speed. If the precise engine is unavailable it falls back automatically.'),
        field('Quality', qualitySel, 'Scales the target bitrate.'),
        field('Container / codec', containerSel),
        field('Resolution', el('div.prop-inputs', {}, [sizeW, el('span.export-x', { text: '×' }), sizeH])),
        field('Frame rate', fpsInput),
        field('Video bitrate (bps)', vbr),
        field('Audio bitrate', abr),
        field('Audio', el('div', {}, [audioRow, hwRow])),
        field('Range', rangeSel),
        field('File name', nameInput),
      );
      right.appendChild(el('div.export-group-title', { text: 'Output settings' }));
      right.appendChild(fields);
      /* live capability readout — what this machine can actually do at the size */
      const capNote = el('div.export-cap');
      right.appendChild(capNote);

      const progressWrap = el('div.export-progress');
      const bar = el('div.export-bar');
      const barFill = el('div.export-bar-fill');
      bar.appendChild(barFill);
      const progressText = el('div.export-progress-text');
      progressWrap.append(bar, progressText);
      progressWrap.style.display = 'none';
      right.appendChild(progressWrap);

      function round3(v) { return Math.round(v * 1000) / 1000; }

      /* The container decides the engine: the MP4 muxer only writes H.264, the
         realtime recorder is the VP9/WebM route, and the sequence has no encoder
         at all. Keep the controls honest about what each choice implies. */
      function applyContainerState() {
        const audioOnly = state.container === 'wav' || state.container === 'm4a';
        const sequence = state.container === 'pngseq';
        if (state.container === 'mp4') { state.engine = 'precise'; engineSel.value = 'precise'; }
        else if (state.container === 'webm') { state.engine = 'realtime'; engineSel.value = 'realtime'; }
        else if (state.container === 'm4a') { state.engine = 'precise'; engineSel.value = 'precise'; }
        sizeW.disabled = sizeH.disabled = fpsInput.disabled = audioOnly;
        vbr.disabled = audioOnly || sequence;
        audioCb.disabled = sequence;
        engineSel.disabled = sequence || audioOnly;
      }

      function applyPreset(pr) {
        if (pr.custom) return;
        if (pr.container) state.container = pr.container;
        if (pr.codec) state.codec = pr.codec;
        if (pr.width) state.width = pr.width;
        if (pr.height) state.height = pr.height;
        if (pr.fps) state.fps = pr.fps;
        if (pr.videoBitrate) state.videoBitrate = pr.videoBitrate;
        if (pr.audioBitrate != null) state.audioBitrate = pr.audioBitrate;
        if (pr.container === 'wav') state.audio = true;
        containerSel.value = state.container;
        applyContainerState();
        if (pr.container === 'wav') { state.engine = 'audio'; }
      }

      function syncFields() {
        sizeW.value = state.width; sizeH.value = state.height; fpsInput.value = round3(state.fps);
        vbr.value = state.videoBitrate; abr.value = String(state.audioBitrate);
        audioCb.checked = state.audio; qualitySel.value = state.quality;
        updateEstimate();
      }

      function computeRange() {
        if (state.rangeMode === 'inout') {
          const s = p.inPoint != null ? p.inPoint : 0;
          const e = p.outPoint != null ? p.outPoint : dur;
          return { start: s, end: Math.max(s + 1, e) };
        }
        if (state.rangeMode === 'selection' && selSpan) {
          return { start: selSpan.start, end: Math.max(selSpan.start + 1, selSpan.end) };
        }
        return { start: 0, end: Math.max(1, dur) };
      }

      function updateEstimate() {
        const range = computeRange();
        const frames = Math.max(1, range.end - range.start);
        const secs = frames / state.fps;
        const audioOnly = state.container === 'wav' || state.container === 'm4a';
        const sequence = state.container === 'pngseq';
        const qf = (OS.export.QUALITY_STEPS.find((q) => q.id === state.quality) || { factor: 1 }).factor;
        let bytes;
        if (state.container === 'wav') bytes = (secs * 48000 * 16 * 2) / 8;
        /* PNG is already DEFLATE-compressed; this is a rough order of magnitude,
           not a promise. Photographic frames land lower, graphics higher. */
        else if (sequence) bytes = frames * state.width * state.height * 0.35;
        else bytes = (secs * (state.videoBitrate * qf + (state.audio ? state.audioBitrate : 0))) / 8;
        const engineText = audioOnly ? 'offline audio mixdown'
          : sequence ? 'PNG frame sequence (ZIP)'
            : state.engine === 'precise' ? 'WebCodecs (precise)' : 'MediaRecorder (realtime)';
        summary.innerHTML = '';
        const rows = [
          ['Duration', `${OS.timebase.tc(frames, p.fps)} (${secs.toFixed(2)} s)`],
          ['Frames', `${frames}`],
          ['Resolution', audioOnly ? '(audio only)' : `${state.width}×${state.height} @ ${round3(state.fps)} fps`],
          ['Est. size', `≈ ${fmtBytes(bytes)}`],
          ['Engine', engineText],
        ];
        if (sequence) rows.push(['Audio', 'a frame sequence carries no audio']);
        for (const [k, v] of rows) {
          const r = el('div.export-summary-row', {}, [el('span', { text: k }), el('b', { text: v })]);
          summary.appendChild(r);
        }
        refreshCapability();
      }

      /* Probe the current size and say plainly what can come out of it, so no one
         waits ten minutes for an encode the platform was never going to allow. */
      let capSeq = 0;
      async function refreshCapability() {
        const seq = ++capSeq;
        const w = state.width, h = state.height;
        if (state.container === 'wav' || state.container === 'm4a') {
          capNote.className = 'export-cap';
          capNote.textContent = 'Offline audio mixdown — independent of frame size.';
          return;
        }
        const info = await OS.export.probe(w, h);
        if (seq !== capSeq) return;
        if (!info.render) {
          capNote.className = 'export-cap bad';
          capNote.textContent = `This renderer cannot allocate a ${w}×${h} canvas. The limit is ${OS.export.MAX_SIDE} px per side and ${(OS.export.MAX_AREA / 1e6).toFixed(0)} megapixels.`;
          return;
        }
        const labels = info.video.filter((v) => v.supported).map((v) => v.label);
        const parts = [`${(w * h / 1e6).toFixed(1)} MP renders`];
        if (state.container === 'pngseq') {
          parts.push('PNG frames have no encoder size limit');
          parts.push(`~${fmtBytes(w * h * 0.35)} per frame`);
        } else if (labels.length) {
          parts.push(`video encoder: ${labels.join(' / ')}`);
        } else {
          parts.push('no video encoder can handle this size — export a PNG sequence instead');
        }
        capNote.className = 'export-cap' + (labels.length || state.container === 'pngseq' ? '' : ' warn');
        capNote.textContent = parts.join(' · ');
      }

      updateEstimate();
      syncFields();

      const api = this.open('Export', content, { wide: true, dismissable: false });
      const cancelBtn = this.button('Close', () => { if (state.running) { OS.export.cancel(); } else api.close(); });
      const startBtn = this.button('Export', () => run(), 'primary');
      const afterRow = el('div.prop-btnrow');
      api.foot.append(afterRow, el('span.spacer'), cancelBtn, startBtn);
      api.onClose = () => { if (state.running) OS.export.cancel(); };

      async function run() {
        if (state.running) return;
        if (!dur) { dialogs.toast('Add something to the timeline first', 'warn'); return; }
        state.running = true;
        startBtn.disabled = true;
        startBtn.textContent = 'Exporting…';
        progressWrap.style.display = 'block';
        cancelBtn.textContent = 'Cancel';
        const range = computeRange();
        const opts = {
          engine: state.engine, container: state.container, codec: state.codec,
          width: state.width, height: state.height, fps: state.fps,
          videoBitrate: state.videoBitrate, audioBitrate: state.audioBitrate,
          audio: state.audio, hardware: state.hardware, quality: state.quality,
          range,
          mastering: app.player && app.player.mastering ? { ...app.player.mastering } : null,
        };
        try {
          const res = await OS.export.run(p, app.media, opts, (prog) => {
            const pct = Math.round((prog.ratio || 0) * 100);
            barFill.style.width = pct + '%';
            let msg = `${prog.phase || 'working'} — ${pct}%`;
            if (prog.fps) msg += ` · ${prog.fps.toFixed(1)} fps`;
            if (prog.etaSec != null && Number.isFinite(prog.etaSec)) msg += ` · ETA ${OS.util.fmtDur(prog.etaSec)}`;
            if (prog.frame != null && prog.total) msg += ` · frame ${prog.frame}/${prog.total}`;
            if (prog.message) msg = prog.message;
            progressText.textContent = msg;
          });
          const ext = { m4a: 'm4a', wav: 'wav', webm: 'webm', pngseq: 'zip' }[opts.container] || 'mp4';
          const filename = (nameInput.value.trim() || 'OpenScene Export') + '.' + ext;
          const isSequence = opts.container === 'pngseq';
          progressText.textContent = isSequence
            ? `Done — ${res.engine} engine · ${res.blob.size ? fmtBytes(res.blob.size) : ''} · extract the ZIP for numbered PNG frames`
            : `Done — ${res.engine} engine · verified: ${res.verification && res.verification.ok ? 'yes' : 'no'} · ${fmtBytes(res.blob.size)}`;
          for (const n of res.notes) dialogs.toast(n, 'warn', 9000);
          await app.saveBlob(res.blob, filename, opts.container);
          afterRow.innerHTML = '';
          if (!isSequence) {
            const play = dialogs.button('Play result', () => {
              const url = URL.createObjectURL(res.blob);
              const v = el(opts.container === 'wav' || opts.container === 'm4a' ? 'audio.export-preview' : 'video.export-preview', { src: url, controls: true });
              const wrap = el('div', {}, [v]);
              const api2 = dialogs.open('Export preview — ' + filename, wrap, { wide: true });
              api2.foot.append(dialogs.button('Close', () => api2.close()), el('span.spacer'));
              api2.onClose = () => URL.revokeObjectURL(url);
            }, '');
            afterRow.append(play);
          }
          if (!isSequence && (!res.verification || !res.verification.ok)) dialogs.toast('The exported file could not be verified by the browser player. Try the realtime engine or a different container.', 'error', 10000);
        } catch (e) {
          if (e.message === 'cancelled') { progressText.textContent = 'Cancelled.'; dialogs.toast('Export cancelled', 'warn'); }
          else { progressText.textContent = 'Failed: ' + e.message; dialogs.toast('Export failed: ' + e.message, 'error', 10000); console.error(e); }
        } finally {
          state.running = false;
          startBtn.disabled = false;
          startBtn.textContent = 'Export';
          cancelBtn.textContent = 'Close';
        }
      }
    }

    /* ---------- project settings ---------- */

    projectSettings() {
      const app = this.app, p = app.project;
      const content = el('div.form');
      const fpsSel = el('select.prop-input');
      for (const f of OS.timebase.PRESETS) fpsSel.appendChild(el('option', { value: `${f.num}/${f.den}`, text: f.label, selected: p.fps.num === f.num && p.fps.den === f.den }));
      const w = el('input.prop-input.num', { type: 'number', min: 2, max: OS.export.MAX_SIDE, step: 2, value: p.width });
      const h = el('input.prop-input.num', { type: 'number', min: 2, max: OS.export.MAX_SIDE, step: 2, value: p.height });
      const resSel = el('select.prop-input');
      for (const [label, rw, rh] of [
        ['15360 × 8640 (16K UHD)', 15360, 8640],
        ['8192 × 4320 (8K DCI)', 8192, 4320],
        ['7680 × 4320 (8K UHD)', 7680, 4320],
        ['5120 × 2700 (5K)', 5120, 2700],
        ['4096 × 2160 (DCI 4K)', 4096, 2160],
        ['3840 × 2160 (4K UHD)', 3840, 2160],
        ['2560 × 1440 (QHD)', 2560, 1440], ['1920 × 1080 (Full HD)', 1920, 1080], ['1280 × 720 (HD)', 1280, 720], ['854 × 480 (SD)', 854, 480], ['1080 × 1920 (vertical)', 1080, 1920], ['1080 × 1080 (square)', 1080, 1080], ['Custom', 0, 0],
      ]) {
        resSel.appendChild(el('option', { value: `${rw}x${rh}`, text: label, selected: p.width === rw && p.height === rh }));
      }
      on(resSel, 'change', () => {
        const [rw, rh] = resSel.value.split('x').map(Number);
        if (rw && rh) { w.value = rw; h.value = rh; }
      });
      const bg = el('input.prop-color', { type: 'color', value: p.backgroundColor || '#000000' });
      const name = el('input.text-input', { value: p.name || '' });
      content.append(
        row2('Project name', name),
        row2('Frame rate', fpsSel),
        row2('Preset resolution', resSel),
        row2('Resolution', el('div.prop-inputs', {}, [w, el('span.export-x', { text: '×' }), h])),
        row2('Background', bg),
        el('div.prop-note', { text: 'Changing the frame rate re-times frame numbers for display but keeps clips where they are. Changing resolution does not rescale media.' }),
      );
      const api = this.open('Project settings', content, { small: true });
      const cancel = this.button('Cancel', () => api.close());
      const ok = this.button('Apply', () => {
        const [num, den] = fpsSel.value.split('/').map(Number);
        const values = {
          name: name.value.trim() || 'Untitled Project',
          fps: OS.timebase.fps(num, den),
          width: OS.export.even(parseInt(w.value) || 1920),
          height: OS.export.even(parseInt(h.value) || 1080),
          backgroundColor: bg.value,
        };
        app.exec(OS.commands.SetProjectProps(p, values, { name: 'Project settings' }));
        api.close();
      }, 'primary');
      api.foot.append(el('span.spacer'), cancel, ok);

      function row2(label, node) {
        const r = el('div.prop-row');
        r.append(el('label.prop-label', { text: label }), node);
        return r;
      }
    }

    /* ---------- audio mastering ---------- */

    mastering() {
      const app = this.app;
      const m = app.player.mastering;
      const content = el('div.form');
      const rows = [];
      const row3 = (label, node, hint) => {
        const r = el('div.prop-row');
        const l = el('label.prop-label', { text: label })
        if (hint) l.title = hint;
        r.append(l, node);
        rows.push(r);
        return r;
      };
      const slider = (min, max, step, get, set) => {
        const wrap = el('div.prop-inputs');
        const num = el('input.prop-input.num', { type: 'number', min, max, step, value: get().toFixed(1) });
        const rng = el('input.prop-range', { type: 'range', min, max, step, value: get() });
        const push = (v, commit) => {
          const n = clamp(parseFloat(v), min, max);
          if (!Number.isFinite(n)) return;
          num.value = n.toFixed(1); rng.value = n;
          set(n);
          if (commit) app.player.applyMastering();
        };
        on(num, 'change', () => push(num.value, true));
        on(num, 'input', () => { rng.value = num.value; });
        on(rng, 'input', () => push(rng.value, false));
        on(rng, 'change', () => push(rng.value, true));
        wrap.append(num, rng);
        return wrap;
      };
      const toggle = (get, set) => {
        const cb = el('input.prop-check', { type: 'checkbox' });
        cb.checked = !!get();
        on(cb, 'change', () => { set(cb.checked); app.player.applyMastering(); });
        return el('div.prop-checkwrap', {}, [cb]);
      };

      content.append(el('div.prop-note', { text: 'The mastering bus sits on the program output: it shapes playback monitoring and is baked into every audio and video export. Set it once and it applies everywhere.' }));
      row3('Master volume', slider(0, 2, 0.01, () => app.player.masterVolume, (v) => app.player.setMasterVolume(v)), 'Overall output level, applied before the EQ');
      content.append(el('div.prop-section-head', { text: 'Three-band EQ' }));
      row3('Low shelf (dB)', slider(-18, 18, 0.5, () => m.low, (v) => { m.low = v; }));
      row3('Mid peak (dB)', slider(-18, 18, 0.5, () => m.mid, (v) => { m.mid = v; }));
      row3('High shelf (dB)', slider(-18, 18, 0.5, () => m.high, (v) => { m.high = v; }));
      content.append(el('div.prop-section-head', { text: 'Dynamics' }));
      row3('Compressor', toggle(() => m.comp, (v) => { m.comp = v; }), 'Glues quiet and loud passages together');
      row3('Comp threshold (dB)', slider(-60, 0, 1, () => m.compThreshold, (v) => { m.compThreshold = v; }));
      row3('Comp ratio', slider(1, 20, 0.5, () => m.compRatio, (v) => { m.compRatio = v; }));
      row3('Output limiter', toggle(() => m.limiter, (v) => { m.limiter = v; }), 'Brick-wall ceiling at -0.8 dBFS to stop clipping');
      for (const r of rows) content.appendChild(r);

      const api = this.open('Audio mastering', content, { small: true });
      const reset = this.button('Reset', () => {
        Object.assign(m, { low: 0, mid: 0, high: 0, comp: false, compThreshold: -18, compRatio: 2.5, limiter: true });
        app.player.applyMastering();
        api.close();
      });
      const close = this.button('Done', () => api.close(), 'primary');
      api.foot.append(el('span.spacer'), reset, close);
    }

    /* ---------- shortcuts ---------- */

    shortcuts() {
      const groups = OS.shortcuts.SHORTCUTS;
      const content = el('div.shortcuts');
      for (const [group, items] of Object.entries(groups)) {
        const box = el('div.shortcut-group');
        box.appendChild(el('div.shortcut-group-title', { text: group }));
        for (const [keys, desc] of items) {
          box.appendChild(el('div.shortcut-row', {}, [el('kbd', { text: keys }), el('span', { text: desc })]));
        }
        content.appendChild(box);
      }
      const api = this.open('Keyboard shortcuts', content, { wide: true });
      api.foot.append(el('span.spacer'), this.button('Close', () => api.close(), 'primary'));
    }

    /* ---------- custom transitions ---------- */

    /* The editor for user-authored transitions. Two tabs: a parameter builder
       that needs no code, and a script editor for anything the builder cannot
       express. A live preview renders the transition at the current progress so
       the result is visible before it is saved. */
    customTransitions() {
      const CT = OS.customTrans;
      if (!CT) { this.toast('Custom transitions are not available', 'error'); return; }

      const content = el('div.ct');
      const state = {
        mode: 'spec',
        id: null,
        spec: CT.defaults(),
        script: [
          '/* Runs once per frame. A = outgoing clip, B = incoming clip.',
          '   p goes 0 -> 1. The preview above shows the result live.',
          '   p=0 and p=1 are forced to show A and B exactly,',
          '   so this only has to make the middle look right. */',
          '',
          'ctx.drawImage(A, 0, 0);',
          'const k = Math.sin(p * Math.PI);',
          'ctx.globalAlpha = p;',
          'ctx.drawImage(B, 0, 0);',
          'ctx.globalAlpha = 1;',
        ].join('\n'),
        preview: 0.5,
      };

      /* ----- preview ----- */
      const PREVIEW_W = 240, PREVIEW_H = 135;
      const canvas = el('canvas.ct-preview', { width: PREVIEW_W, height: PREVIEW_H });
      const pctx = canvas.getContext('2d');

      const makeSwatch = (kind) => {
        const c = document.createElement('canvas');
        c.width = PREVIEW_W; c.height = PREVIEW_H;
        const x = c.getContext('2d');
        if (kind === 'A') {
          const g = x.createLinearGradient(0, 0, PREVIEW_W, PREVIEW_H);
          g.addColorStop(0, '#26405f'); g.addColorStop(1, '#0f1b2b');
          x.fillStyle = g; x.fillRect(0, 0, PREVIEW_W, PREVIEW_H);
          x.fillStyle = 'rgba(255,255,255,.85)';
          x.font = 'bold 46px sans-serif'; x.textAlign = 'center'; x.textBaseline = 'middle';
          x.fillText('A', PREVIEW_W / 2, PREVIEW_H / 2);
        } else {
          const g = x.createLinearGradient(0, 0, PREVIEW_W, PREVIEW_H);
          g.addColorStop(0, '#a34a1e'); g.addColorStop(1, '#5c2410');
          x.fillStyle = g; x.fillRect(0, 0, PREVIEW_W, PREVIEW_H);
          x.fillStyle = 'rgba(255,255,255,.9)';
          x.font = 'bold 46px sans-serif'; x.textAlign = 'center'; x.textBaseline = 'middle';
          x.fillText('B', PREVIEW_W / 2, PREVIEW_H / 2);
        }
        return c;
      };
      const SWATCH_A = makeSwatch('A');
      const SWATCH_B = makeSwatch('B');

      let scratch = CT.compile ? null : null;
      const getScratch = () => {
        if (!scratch) {
          const layerA = document.createElement('canvas');
          const layerB = document.createElement('canvas');
          const mask = document.createElement('canvas');
          scratch = { layerA, layerB, mask };
        }
        return scratch;
      };

      const renderPreview = () => {
        const s = getScratch();
        const paint = (c, src) => {
          if (c.width !== PREVIEW_W || c.height !== PREVIEW_H) { c.width = PREVIEW_W; c.height = PREVIEW_H; }
          const cx = c.getContext('2d');
          cx.clearRect(0, 0, PREVIEW_W, PREVIEW_H);
          cx.drawImage(src, 0, 0);
        };
        paint(s.layerA, SWATCH_A);
        paint(s.layerB, SWATCH_B);

        let cfg;
        if (state.mode === 'spec') {
          cfg = CT.compile(state.spec);
        } else {
          const r = CT.compileScript(state.script);
          if (r.error) {
            status.textContent = r.error;
            status.classList.add('bad');
            pctx.clearRect(0, 0, PREVIEW_W, PREVIEW_H);
            pctx.drawImage(SWATCH_A, 0, 0);
            return;
          }
          cfg = r.fn;
        }
        status.classList.remove('bad');
        status.textContent = state.mode === 'script' ? 'Runs correctly.' : 'Preview updated.';
        pctx.clearRect(0, 0, PREVIEW_W, PREVIEW_H);
        cfg(pctx, s.layerA, s.layerB, PREVIEW_W, PREVIEW_H, state.preview, s);
        pctx.globalAlpha = 1;
        pctx.filter = 'none';
      };

      const status = el('div.ct-status');

      /* progress slider + endpoint buttons */
      const prog = el('input.ct-range', { type: 'range', min: '0', max: '1', step: '0.01', value: String(state.preview) });
      on(prog, 'input', () => { state.preview = parseFloat(prog.value); renderPreview(); });

      const previewBox = el('div.ct-preview-box', {}, [
        canvas,
        el('div.ct-preview-controls', {}, [
          el('button.btn.small', { text: 'A', title: 'Show the outgoing clip (p=0)', onclick: () => { state.preview = 0; prog.value = '0'; renderPreview(); } }),
          prog,
          el('button.btn.small', { text: 'B', title: 'Show the incoming clip (p=1)', onclick: () => { state.preview = 1; prog.value = '1'; renderPreview(); } }),
        ]),
        status,
      ]);

      /* ----- parameter controls ----- */
      const paramBox = el('div.ct-params');
      const controls = new Map();

      const buildParams = () => {
        paramBox.innerHTML = '';
        controls.clear();
        for (const [key, label, type, def, extra] of CT.PATTERN) {
          /* A parameter that the chosen family ignores is hidden, so the form
             only shows what actually has an effect. */
          const fam = state.spec.family;
          const relevant = {
            angle: ['wipe', 'slide', 'blinds'],
            softness: ['wipe', 'iris', 'blinds'],
            bands: ['blinds', 'checker'],
            originX: ['zoom', 'iris'],
            originY: ['zoom', 'iris'],
            color: ['wipe', 'iris'],
            border: ['wipe'],
          }[key];
          if (relevant && !relevant.includes(fam)) continue;

          const row = el('div.ct-row');
          row.appendChild(el('label.ct-label', { text: label }));
          let input;
          if (type === 'range') {
            input = el('input.ct-range', { type: 'range', min: String(extra.min), max: String(extra.max), step: String(extra.step), value: String(state.spec[key]) });
            const out = el('span.ct-val', { text: String(state.spec[key]) + (extra.unit || '') });
            on(input, 'input', () => {
              state.spec[key] = parseFloat(input.value);
              out.textContent = String(state.spec[key]) + (extra.unit || '');
              renderPreview();
            });
            row.append(input, out);
          } else if (type === 'select') {
            input = el('select.ct-select');
            for (const [v, t] of extra.options) {
              const o = el('option', { value: v, text: t });
              if (state.spec[key] === v) o.selected = true;
              input.appendChild(o);
            }
            on(input, 'change', () => {
              state.spec[key] = input.value;
              /* family changes which parameters apply, so rebuild the form */
              if (key === 'family') { buildParams(); }
              renderPreview();
            });
            row.appendChild(input);
          } else if (type === 'color') {
            input = el('input.ct-color', { type: 'color', value: state.spec[key] });
            on(input, 'input', () => { state.spec[key] = input.value; renderPreview(); });
            row.appendChild(input);
          } else if (type === 'check') {
            input = el('input.ct-check', { type: 'checkbox' });
            input.checked = !!state.spec[key];
            on(input, 'change', () => { state.spec[key] = input.checked; renderPreview(); });
            row.appendChild(input);
          }
          controls.set(key, input);
          paramBox.appendChild(row);
        }
      };

      const syncFormToState = () => {
        for (const [key, input] of controls) {
          const v = state.spec[key];
          if (input.type === 'checkbox') input.checked = !!v;
          else input.value = String(v);
        }
      };

      /* ----- script editor ----- */
      const scriptArea = el('textarea.ct-script', { spellcheck: 'false' });
      scriptArea.value = state.script;
      on(scriptArea, 'input', () => {
        state.script = scriptArea.value;
        renderPreview();
      });

      const paneSpec = el('div.ct-pane');
      const paneScript = el('div.ct-pane');
      paneSpec.append(paramBox);
      paneScript.append(
        el('p.ct-hint', { text: 'Write the body of a function. It receives (ctx, A, B, w, h, p, scratch). Use only drawing calls - the page and the network are off limits.' }),
        scriptArea,
      );
      paneScript.style.display = 'none';

      const tabSpec = el('button.ct-tab.on', { text: 'Builder' });
      const tabScript = el('button.ct-tab', { text: 'Script' });
      const setMode = (m) => {
        state.mode = m;
        tabSpec.classList.toggle('on', m === 'spec');
        tabScript.classList.toggle('on', m === 'script');
        paneSpec.style.display = m === 'spec' ? '' : 'none';
        paneScript.style.display = m === 'script' ? '' : 'none';
        renderPreview();
      };
      on(tabSpec, 'click', () => setMode('spec'));
      on(tabScript, 'click', () => setMode('script'));

      /* ----- name + group ----- */
      const nameInput = el('input.text-input', { value: '', placeholder: 'My transition' });
      const groupInput = el('input.text-input', { value: 'Custom', placeholder: 'Custom' });
      const descInput = el('input.text-input', { value: '', placeholder: 'What this transition does' });

      /* ----- the saved list ----- */
      const listBox = el('div.ct-list');
      const refreshList = () => {
        listBox.innerHTML = '';
        const items = CT.list();
        if (!items.length) {
          listBox.appendChild(el('div.ct-empty', { text: 'No custom transitions yet.' }));
          return;
        }
        for (const e of items) {
          const row = el('div.ct-list-row');
          row.append(
            el('span.ct-list-name', { text: e.name }),
            el('span.ct-list-kind', { text: e.kind === 'script' ? 'script' : 'builder' }),
          );
          const edit = el('button.btn.small', { text: 'Edit', onclick: () => {
            state.id = e.id;
            state.mode = e.kind === 'script' ? 'script' : 'spec';
            state.spec = e.kind === 'script' ? CT.defaults() : Object.assign(CT.defaults(), e.spec || {});
            state.script = e.script || '';
            nameInput.value = e.name;
            groupInput.value = e.group || 'Custom';
            descInput.value = e.description || '';
            scriptArea.value = state.script;
            buildParams();
            syncFormToState();
            setMode(state.mode);
            tabScript.classList.toggle('on', state.mode === 'script');
          } });
          const del = el('button.btn.small.danger', { text: 'Delete', onclick: () => {
            CT.remove(e.id);
            CT.save();
            CT.refreshPanels();
            if (state.id === e.id) state.id = null;
            refreshList();
            this.toast('Custom transition deleted');
          } });
          row.append(el('span.spacer'), edit, del);
          listBox.appendChild(row);
        }
      };

      /* ----- save / update ----- */
      const saveCurrent = () => {
        const name = nameInput.value.trim();
        if (!name) { this.toast('Give the transition a name', 'error'); return false; }
        if (state.mode === 'script') {
          const err = CT.validateScript(state.script);
          if (err) { this.toast(err, 'error'); return false; }
        }
        const r = CT.add({
          id: state.id || undefined,
          name,
          group: groupInput.value.trim() || 'Custom',
          description: descInput.value.trim(),
          kind: state.mode === 'script' ? 'script' : 'spec',
          spec: state.spec,
          script: state.script,
        });
        if (r.error) { this.toast(r.error, 'error'); return false; }
        state.id = r.entry.id;
        CT.save();
        CT.refreshPanels();
        refreshList();
        this.toast('Custom transition saved');
        return true;
      };

      /* keyboard: Ctrl+S saves without touching the mouse */
      on(content, 'keydown', (e) => {
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); saveCurrent(); }
      });

      /* ----- assemble ----- */
      content.append(
        el('div.ct-head', {}, [
          el('div.ct-tabs', {}, [tabSpec, tabScript]),
          previewBox,
        ]),
        el('div.ct-body', {}, [
          el('div.ct-form', {}, [
            el('div.ct-row', {}, [el('label.ct-label', { text: 'Name' }), nameInput]),
            el('div.ct-row', {}, [el('label.ct-label', { text: 'Group' }), groupInput]),
            el('div.ct-row', {}, [el('label.ct-label', { text: 'Description' }), descInput]),
            paneSpec,
            paneScript,
          ]),
          el('div.ct-side', {}, [
            el('div.ct-side-title', { text: 'Your transitions' }),
            listBox,
          ]),
        ]),
      );

      const api = this.open('Custom transitions', content, { wide: true });
      const reset = this.button('New', () => {
        state.id = null; state.mode = 'spec';
        state.spec = CT.defaults();
        nameInput.value = ''; groupInput.value = ''; descInput.value = '';
        buildParams(); syncFormToState(); setMode('spec'); refreshList();
      });
      const save = this.button('Save', () => saveCurrent(), 'primary');
      api.foot.append(reset, el('span.spacer'), this.button('Close', () => api.close()), save);

      buildParams();
      refreshList();
      renderPreview();
      /* The preview needs real dimensions before the first paint, so run it
         again after the modal is in the document. */
      requestAnimationFrame(renderPreview);
    }

    about() {
      const app = this.app;
      const content = el('div.about');
      content.append(
        el('img.about-logo', { src: 'resources/logo-wordmark.svg', alt: 'OpenScene' }),
        el('div.about-tag', { text: 'Professional open-source video editor' }),
        el('div.about-rows', {}, [
          kv('Version', app.VERSION),
          kv('Platform', (navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || 'unknown'),
          kv('Engine', (navigator.userAgent.match(/(Chrome|Edg|Electron)\/[\d.]+/) || ['Chromium'])[0]),
          kv('WebCodecs', ('VideoEncoder' in window) ? 'available' : 'not available'),
          kv('MediaRecorder', (typeof MediaRecorder !== 'undefined') ? 'available' : 'not available'),
          kv('OfflineAudioContext', (window.OfflineAudioContext ? 'available' : 'not available')),
          kv('License', 'AGPL-3.0'),
        ]),
        el('div.about-note', { text: 'Built with zero third-party dependencies: the timeline, compositor, mixer, MP4 muxer and UI are all hand-written and run on the browser engine.' }),
      );
      const api = this.open('About OpenScene', content, { small: true });
      api.foot.append(
        this.button('Run self-test', () => { api.close(); this.app.runSelfTest(); }),
        this.button('Licenses', () => this.app.showLicenses()),
        el('span.spacer'),
        this.button('Close', () => api.close(), 'primary'),
      );
    }
  }

  function kv(k, v) {
    return el('div.prop-kv', {}, [el('span.prop-kv-k', { text: k }), el('span.prop-kv-v', { text: String(v) })]);
  }

  OS.dialogs = { Dialogs };
})();
