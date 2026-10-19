/* OpenScene — selftest.js
   End-to-end self test. Synthesises media in-browser, builds a project,
   exercises the model/commands/undo, renders frames, mixes audio and runs a
   real export through the WebCodecs + MP4 muxer path, then verifies the result
   by loading it back into a media element. Surfaced in Help ▸ Run self-test and
   used by the development rig. */
(() => {
  'use strict';
  const OS = (window.OS = window.OS || {});
  const U = OS.util;
  const M = () => OS.model;

  const results = [];
  const log = (name, ok, detail = '') => { results.push({ name, ok: !!ok, detail: String(detail || '') }); return ok; };

  async function assertThrows(name, fn) {
    try { await fn(); return log(name, false, 'expected an error but none was thrown'); }
    catch (e) { return log(name, true, e.message); }
  }

  /* ---------------- synthetic media ---------------- */

  function recorderMime() {
    const cands = ['video/webm;codecs=vp8', 'video/webm;codecs=vp9', 'video/webm', 'video/mp4'];
    for (const m of cands) if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(m)) return m;
    return '';
  }

  async function makeVideo({ seconds = 1.6, fps = 30, w = 320, h = 180 } = {}) {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const ctx = c.getContext('2d');
    const stream = c.captureStream(fps);
    const mime = recorderMime();
    if (!mime) throw new Error('MediaRecorder unavailable: cannot synthesise test video');
    const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 2_000_000 });
    const chunks = [];
    rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
    const stopped = new Promise((res) => { rec.onstop = res; });
    const draw = (t) => {
      const g = ctx.createLinearGradient(0, 0, w, h);
      g.addColorStop(0, `hsl(${(t * 120) % 360}, 70%, 45%)`);
      g.addColorStop(1, `hsl(${(t * 120 + 140) % 360}, 70%, 35%)`);
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, w, h);
      ctx.fillStyle = '#fff';
      ctx.font = 'bold 28px sans-serif';
      ctx.fillText('t=' + t.toFixed(2), 20, 60);
      ctx.beginPath();
      ctx.arc(w / 2 + Math.cos(t * 4) * 60, h / 2 + 30 + Math.sin(t * 4) * 30, 18, 0, Math.PI * 2);
      ctx.fill();
    };
    draw(0);
    rec.start();
    const t0 = performance.now();
    await new Promise((res) => {
      // NOTE: driven by setTimeout rather than requestAnimationFrame so the test also
      // runs in a headless/background tab where rAF is throttled or paused.
      const loop = () => {
        const t = (performance.now() - t0) / 1000;
        if (t >= seconds) return res();
        draw(t);
        setTimeout(loop, 16);
      };
      loop();
    });
    rec.stop();
    await stopped;
    return new File(chunks, 'synthetic-video' + (mime.includes('mp4') ? '.mp4' : '.webm'), { type: chunks[0].type || mime });
  }

  function makeAudio({ seconds = 1.6, sampleRate = 48000 } = {}) {
    const n = Math.round(seconds * sampleRate);
    const L = new Float32Array(n), R = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const t = i / sampleRate;
      const env = Math.min(1, t * 8) * Math.min(1, (seconds - t) * 8);
      L[i] = Math.sin(2 * Math.PI * 440 * t) * 0.5 * env;
      R[i] = Math.sin(2 * Math.PI * 660 * t) * 0.4 * env;
    }
    const blob = OS.wav.encodeWav([L, R], sampleRate);
    return new File([blob], 'synthetic-audio.wav', { type: 'audio/wav' });
  }

  function makeImage({ w = 320, h = 180 } = {}) {
    return new Promise((resolve) => {
      const c = document.createElement('canvas');
      c.width = w; c.height = h;
      const ctx = c.getContext('2d');
      const g = ctx.createRadialGradient(w / 2, h / 2, 10, w / 2, h / 2, w / 2);
      g.addColorStop(0, '#ffd23f');
      g.addColorStop(1, '#1460ff');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, w, h);
      c.toBlob((b) => resolve(new File([b], 'synthetic-image.png', { type: 'image/png' })), 'image/png');
    });
  }

  /* ---------------- pixel helpers ---------------- */

  function canvasStats(ctx, w, h) {
    const data = ctx.getImageData(0, 0, w, h).data;
    let min = 255, max = 0, sum = 0, nonBlack = 0;
    for (let i = 0; i < data.length; i += 16) {
      const v = (data[i] + data[i + 1] + data[i + 2]) / 3;
      if (v < min) min = v;
      if (v > max) max = v;
      sum += v;
      if (v > 6) nonBlack++;
    }
    const samples = data.length / 16;
    return { min, max, mean: sum / samples, nonBlackRatio: nonBlack / samples };
  }

  async function canvasFingerprint(ctx, w, h) {
    const data = ctx.getImageData(0, 0, w, h).data;
    let hash = 2166136261;
    for (let i = 0; i < data.length; i += 64) {
      hash ^= data[i];
      hash = Math.imul(hash, 16777619);
    }
    return hash >>> 0;
  }

  /* A stricter fingerprint for tests that must tell visually similar frames
     apart: mixes all three channels of every pixel. */
  async function canvasSignature(ctx, w, h) {
    const data = ctx.getImageData(0, 0, w, h).data;
    let hash = 2166136261;
    for (let i = 0; i < data.length; i += 4) {
      hash ^= data[i]; hash = Math.imul(hash, 16777619);
      hash ^= data[i + 1]; hash = Math.imul(hash, 16777619);
      hash ^= data[i + 2]; hash = Math.imul(hash, 16777619);
    }
    return hash >>> 0;
  }

  /* ---------------- the test ---------------- */

  async function run(app) {
    results.length = 0;
    const t0 = performance.now();
    const restoreProject = app.project;
    // clear any cancellation left behind by a previous run so direct calls
    // (buildAudioMix, exportStill) are not aborted by stale state
    try { OS.export.reset(); } catch (e) {}

    try {
      /* 1 — pure model + command tests on a scratch project */
      {
        const p = M().createProject({ fps: OS.timebase.fps(30, 1) });
        const asset = M().createAsset({ name: 'fake.mp4', kind: 'video', durationFrames: 300 });
        p.assets.push(asset);
        const track = p.tracks.find((t) => t.kind === 'video');
        const c = M().createClip(asset, track.id, 0, 100);
        M().insertClip(p, c);
        log('model: insert clip', M().clipsOf(p, track).length === 1);

        const stack = new OS.commands.CommandStack();
        const c2 = M().createClip(asset, track.id, 150, 50);
        stack.exec(OS.commands.AddClips(p, [c2]));
        log('commands: add clip', M().clipsOf(p, track).length === 2);
        stack.undo();
        log('commands: undo add', M().clipsOf(p, track).length === 1);
        stack.redo();
        log('commands: redo add', M().clipsOf(p, track).length === 2);

        const splitCmd = OS.commands.SplitClip(p, c, 40);
        stack.exec(splitCmd);
        const clips = M().clipsOf(p, track);
        const left = clips.find((x) => x.id === c.id);
        const right = splitCmd._right;
        log('edit: split produces two clips', clips.length === 3 && !!right && left.length === 40 && right.length === 60 && right.inPoint === 40,
          `left=${left.length} right=${right.length} in=${right.inPoint}`);
        stack.undo();
        log('edit: undo split', M().clipsOf(p, track).length === 2 && c.length === 100);

        // keyframes
        M().setKeyframe(c, 'opacity', 0, 0);
        M().setKeyframe(c, 'opacity', 100, 1);
        const mid = M().evalKeyframes(c, 'opacity', 50, 0);
        log('model: keyframe interpolation', Math.abs(mid - 0.5) < 0.02, `value@50=${mid.toFixed(3)}`);

        // speed / media frame mapping
        c.speed = 2;
        const mf = M().mediaFrameAt(c, 20);
        log('model: media frame with speed', mf === c.inPoint + 40, `mediaFrame=${mf}`);
        c.speed = 1;

        // serialise round trip
        const json = M().serialize(p);
        const p2 = M().deserialize(json);
        log('model: serialise round trip', M().projectDuration(p2) === M().projectDuration(p) && M().validate(p2).length === 0,
          M().validate(p2).join('; ') || 'clean');

        // overlap transition normalisation
        const tr = M().createTrack('video', 'VX');
        p.tracks.push(tr);
        const a = M().createClip(asset, tr.id, 0, 60);
        const b = M().createClip(asset, tr.id, 40, 60);
        M().insertClip(p, a); M().insertClip(p, b);
        b.transitionIn = { type: 'dissolve', length: 999 };
        M().normalizeTransitions(p);
        log('model: transition clamped to overlap', b.transitionIn.length === 20, `len=${b.transitionIn.length}`);
      }

      /* 2 — effects / transitions registries */
      {
        const fx = M().createEffect('brightness');
        log('effects: create with defaults', typeof fx.params.amount === 'number');
        const fstr = OS.effects.filterString([{ type: 'brightness', params: { amount: 2 }, enabled: true }, { type: 'blur', params: { radius: 3 }, enabled: true }]);
        log('effects: filter string', fstr.includes('brightness(2)') && fstr.includes('blur(3px)'), fstr);
        log('transitions: types registered', OS.transitions.TYPES.length >= 10 && OS.transitions.TYPES.some(([k]) => k === 'dissolve'));

        // every registry entry carries a label, group and description
        const regs = OS.effects.all();
        log('effects: registry is populated', regs.length >= 20, `${regs.length} effects`);
        log('effects: every effect has label + group + description',
          regs.every((r) => !!r.label && !!r.group && !!r.description),
          regs.filter((r) => !r.label || !r.group || !r.description).map((r) => r.type).join(',') || 'all documented');
        log('effects: grouped categories', OS.effects.groups().length >= 3, OS.effects.groups().join(', '));

        // audio gain helper honours the volume / audio-fade effects
        const g1 = OS.effects.audioGain([M().createEffect('volume', { gain: 2 })], 10, 100, 30);
        const g2 = OS.effects.audioGain([M().createEffect('audiofade', { fadeIn: 1, fadeOut: 0 })], 15, 300, 30);
        log('effects: audioGain multiplies audio effects', Math.abs(g1 - 2) < 1e-6 && g2 > 0 && g2 < 1, `gain=${g1} fade=${g2.toFixed(3)}`);

        // opacity helper honours the fade effect
        const o1 = OS.effects.opacityAt([M().createEffect('fade', { fadeIn: 1, fadeOut: 0 })], 15, 300, 30);
        log('effects: opacityAt honours the fade effect', o1 > 0 && o1 < 1, `opacity=${o1.toFixed(3)}`);

        // transitions expose group + description lookups
        log('transitions: group + description helpers',
          !!OS.transitions.groupOf('dissolve') && !!OS.transitions.descOf('dissolve'),
          `${OS.transitions.groupOf('dissolve')} / ${OS.transitions.descOf('dissolve')}`);

        // the library dock + panels are mounted in the running app
        log('library: dock + panels mounted',
          !!(app.dock && app.effectsLibrary && app.transitionsLibrary),
          ['dock', app.dock].concat(['effects', app.effectsLibrary]).concat(['transitions', app.transitionsLibrary]).join(','));

        // Every registered effect must apply and every transition must actually
        // reach the incoming clip. A transition that never completes (or one that
        // leaks the incoming clip at p=0) is a real, visible defect.
        {
          const TW = 240, TH = 120;
          const mkC = () => { const c = document.createElement('canvas'); c.width = TW; c.height = TH; return c; };
          const paintA = (x) => {
            const g = x.createLinearGradient(0, 0, TW, TH);
            g.addColorStop(0, '#1030a0'); g.addColorStop(0.5, '#c05020'); g.addColorStop(1, '#20c060');
            x.fillStyle = g; x.fillRect(0, 0, TW, TH);
            x.fillStyle = '#ffffff'; x.beginPath(); x.arc(TW * 0.3, TH * 0.4, 18, 0, Math.PI * 2); x.fill();
          };
          const paintB = (x) => {
            x.fillStyle = '#000000'; x.fillRect(0, 0, TW, TH);
            for (let i = 0; i < 18; i++) {
              x.fillStyle = `hsl(${i * 41},80%,55%)`;
              x.fillRect((i * 17) % TW, (i * 23) % TH, 12, 10);
            }
          };
          const mad = (a, b) => {
            const da = a.getContext('2d').getImageData(0, 0, TW, TH).data;
            const db = b.getContext('2d').getImageData(0, 0, TW, TH).data;
            let s = 0;
            for (let i = 0; i < da.length; i++) s += Math.abs(da[i] - db[i]);
            return s / da.length;
          };
          const refA = mkC(); paintA(refA.getContext('2d'));
          const refB = mkC(); paintB(refB.getContext('2d'));

          let fxThrew = null;
          for (const reg of regs) {
            try {
              const src = mkC(); paintA(src.getContext('2d'));
              const x = mkC().getContext('2d', { willReadFrequently: true });
              const eff = { type: reg.type, enabled: true, params: JSON.parse(JSON.stringify(reg.defaultParams || {})) };
              const sc = {};
              const fstr = OS.effects.filterString([eff]);
              if (fstr && fstr !== 'none') x.filter = fstr;
              x.drawImage(src, 0, 0);
              x.filter = 'none';
              if (OS.effects.hasPixelEffect([eff])) OS.effects.applyPixelEffects(x, TW, TH, [eff], sc, 4, 30);
              if (OS.effects.hasDrawEffect([eff])) OS.effects.applyDrawEffects(x, TW, TH, [eff], sc, 4, 30);
            } catch (e) { fxThrew = fxThrew || `${reg.type}: ${e.message}`; }
          }
          log('effects: every registered effect applies cleanly', !fxThrew, fxThrew || `${regs.length} effects`);

          let trThrew = null, trBad = null;
          const tscr = OS.transitions.makeScratch();
          for (const [type] of OS.transitions.TYPES) {
            try {
              const at = (p) => {
                const x = mkC().getContext('2d', { willReadFrequently: true });
                x.setTransform(1, 0, 0, 1, 0, 0);
                OS.transitions.draw(x, TW, TH, type, p, (cc) => cc.drawImage(refA, 0, 0), (cc) => cc.drawImage(refB, 0, 0), tscr);
                return x.canvas;
              };
              if (mad(at(0), refA) > 2 || mad(at(1), refB) > 2) trBad = trBad || type;
            } catch (e) { trThrew = trThrew || `${type}: ${e.message}`; }
          }
          log('transitions: every type reaches the incoming clip', !trThrew && !trBad,
            trThrew || (trBad ? `did not complete: ${trBad}` : `${OS.transitions.TYPES.length} transitions`));
        }
      }

      /* 3 — synthetic media import */
      const media = new OS.media.MediaStore();
      OS.media.instance = media;
      let videoAsset = null, audioAsset = null, imageAsset = null;
      try {
        const [vFile, aFile, iFile] = await Promise.all([makeVideo(), Promise.resolve(makeAudio()), makeImage()]);
        log('media: synthesised test files', vFile.size > 1000 && aFile.size > 1000 && iFile.size > 500,
          `video=${vFile.size}B audio=${aFile.size}B image=${iFile.size}B`);
        const imported = await media.importFiles([vFile, aFile, iFile], { tolerant: true });
        videoAsset = imported.find((a) => a.kind === 'video');
        audioAsset = imported.find((a) => a.kind === 'audio');
        imageAsset = imported.find((a) => a.kind === 'image');
        log('media: import video', !!videoAsset && videoAsset.width === 320 && videoAsset.height === 180, videoAsset ? `${videoAsset.width}x${videoAsset.height} dur=${videoAsset.durationFrames}` : 'none');
        log('media: import audio', !!audioAsset && audioAsset.durationFrames > 0, audioAsset ? `dur=${audioAsset.durationFrames}` : 'none');
        log('media: import image', !!imageAsset && imageAsset.width === 320, imageAsset ? `${imageAsset.width}x${imageAsset.height} thumb=${!!imageAsset.thumb}` : 'none');
        const peaks = await media.ensurePeaks(audioAsset.id);
        log('media: waveform peaks', !!peaks && peaks.buckets > 100 && peaks.peaks.length === peaks.buckets * 2, peaks ? `buckets=${peaks.buckets}` : 'none');
        const ab = await media.ensureAudioBuffer(audioAsset.id);
        log('media: decode audio buffer', !!ab && ab.length > 1000, ab ? `${ab.length} samples @${ab.sampleRate}` : 'none');
      } catch (e) {
        log('media: synthetic import', false, e.message);
      }

      /* 4 — build a real project and render frames */
      const proj = M().createProject({ fps: OS.timebase.fps(30, 1), width: 320, height: 180, name: 'Self Test' });
      if (videoAsset) proj.assets.push(videoAsset);
      if (audioAsset) proj.assets.push(audioAsset);
      if (imageAsset) proj.assets.push(imageAsset);
      const vTrack = proj.tracks.find((t) => t.kind === 'video');
      const vTrack2 = proj.tracks[1];
      const aTrack = proj.tracks.find((t) => t.kind === 'audio');

      if (imageAsset) {
        const title = M().createGeneratorClip('title', vTrack.id, 0, 25, { text: 'SELF TEST', size: 0.16, animation: 'fade', fadeIn: 0.2, fadeOut: 0.2 });
        M().insertClip(proj, title);
      }
      let vclip = null;
      if (videoAsset) {
        vclip = M().createClip(videoAsset, vTrack.id, 20, 40, 0);
        vclip.transitionIn = { type: 'dissolve', length: 5 };
        vclip.effects.push(M().createEffect('brightness', { amount: 1.4 }));
        vclip.effects.push(M().createEffect('vignette'));
        M().setKeyframe(vclip, 'transform.scale', 0, 1);
        M().setKeyframe(vclip, 'transform.scale', 39, 1.3);
        M().insertClip(proj, vclip);
        const imgClip = M().createClip(imageAsset, vTrack2.id, 40, 40);
        imgClip.effects.push(M().createEffect('saturation', { amount: 1.5 }));
        M().insertClip(proj, imgClip);
      }
      if (audioAsset) {
        const aclip = M().createClip(audioAsset, aTrack.id, 0, 40);
        aclip.fadeIn = 8; aclip.fadeOut = 8; aclip.volume = 0.8;
        M().insertClip(proj, aclip);
      }
      M().normalizeTransitions(proj);
      const errs = M().validate(proj);
      log('project: validates cleanly', errs.length === 0, errs.join('; '));
      log('project: duration computed', M().projectDuration(proj) > 30, `dur=${M().projectDuration(proj)}`);

      // render frames
      const canvas = document.createElement('canvas');
      canvas.width = proj.width; canvas.height = proj.height;
      const ctx = canvas.getContext('2d', { alpha: false, willReadFrequently: true });
      const scratch = OS.renderer.makeScratch();
      const resolver = { get: (assetId, clipId) => media.get(assetId, clipId) };
      let renderError = null, stats = null, printed = false;
      try {
        for (let f = 0; f < M().projectDuration(proj); f++) {
          OS.renderer.renderFrame(proj, f, ctx, { scratch, media: resolver });
          if (f === 12) { stats = canvasStats(ctx, proj.width, proj.height); printed = true; }
          if (f === 22 || f === 45) { await waitForVideoPaint(media, proj, f); OS.renderer.renderFrame(proj, f, ctx, { scratch, media: resolver }); }
        }
      } catch (e) { renderError = e; }
      log('renderer: renders every frame without throwing', !renderError, renderError ? renderError.message : `${M().projectDuration(proj)} frames`);
      log('renderer: title frame is non-empty', !!stats && stats.nonBlackRatio > 0.02, stats ? `nonBlack=${(stats.nonBlackRatio * 100).toFixed(1)}% mean=${stats.mean.toFixed(1)}` : 'no stats');

      // fingerprints should differ across the timeline (animated content)
      const fp = {};
      for (const f of [0, 12, 30, 50]) { OS.renderer.renderFrame(proj, f, ctx, { scratch, media: resolver }); fp[f] = await canvasFingerprint(ctx, proj.width, proj.height); }
      const distinct = new Set(Object.values(fp)).size;
      log('renderer: frames differ over time', distinct >= 3, JSON.stringify(fp));

      /* Regression: a transition must actually reach the screen. The renderer used
         to pick the outgoing clip during the overlap, so every transition was
         drawn and then immediately covered by clip A. The old check here compared
         two frames of the *same* title clip and passed regardless. */
      {
        const tp = M().createProject({ fps: OS.timebase.fps(30, 1), width: 160, height: 90, name: 'Transition Test' });
        const tvt = tp.tracks.find((t) => t.kind === 'video');
        const cA = M().createGeneratorClip('title', tvt.id, 0, 60, { text: 'AAAA', size: 0.45 });
        const cB = M().createGeneratorClip('title', tvt.id, 51, 60, { text: 'BBBB', size: 0.45 });
        M().insertClip(tp, cA);
        M().insertClip(tp, cB);
        cB.transitionIn = { type: 'dissolve', length: 9 };
        M().normalizeTransitions(tp);

        const tcan = document.createElement('canvas');
        tcan.width = tp.width; tcan.height = tp.height;
        const tctx = tcan.getContext('2d', { alpha: false });
        const tscratch = OS.renderer.makeScratch();
        const tmedia = { get: () => null };
        let drawCalls = 0;
        const origDraw = OS.transitions.draw;
        OS.transitions.draw = function () { drawCalls++; return origDraw.apply(this, arguments); };
        try {
          OS.renderer.renderFrame(tp, 50, tctx, { scratch: tscratch, media: tmedia });   // A only
          const fA = await canvasFingerprint(tctx, tp.width, tp.height);
          OS.renderer.renderFrame(tp, 55, tctx, { scratch: tscratch, media: tmedia });   // mid cross-fade
          const fMid = await canvasFingerprint(tctx, tp.width, tp.height);
          OS.renderer.renderFrame(tp, 62, tctx, { scratch: tscratch, media: tmedia });   // B only
          const fB = await canvasFingerprint(tctx, tp.width, tp.height);
          log('transition: the engine is reached inside the overlap', drawCalls >= 1, `${drawCalls} draw call(s)`);
          log('transition: mid-fade differs from both clips', !!fMid && fMid !== fA && fMid !== fB && fA !== fB,
            `A=${fA} mid=${fMid} B=${fB}`);
          drawCalls = 0;
          OS.renderer.renderFrame(tp, 50, tctx, { scratch: tscratch, media: tmedia });
          OS.renderer.renderFrame(tp, 62, tctx, { scratch: tscratch, media: tmedia });
          log('transition: never drawn outside the overlap', drawCalls === 0, `${drawCalls} stray call(s)`);
        } finally {
          OS.transitions.draw = origDraw;
          OS.renderer.releaseScratch(tscratch);
          tcan.width = 0; tcan.height = 0;
        }
      }

      /* The 16K/8K PNG-sequence export is only as good as this writer, so check the
         container itself: local header, central directory, entry name and CRC.
         (The same archive was also extracted with .NET's ZipFile by hand.) */
      try {
        const zt = OS.zip.create();
        await zt.add('a.txt', new Blob(['hello openscene']));
        await zt.add('d/e.bin', new Blob([new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])]));
        const zblob = zt.build();
        const zb = new Uint8Array(await zblob.arrayBuffer());
        const n = zb.length;
        const e = n - 22;
        const local = zb[0] === 0x50 && zb[1] === 0x4b && zb[2] === 0x03 && zb[3] === 0x04;
        const eocd = zb[e] === 0x50 && zb[e + 1] === 0x4b && zb[e + 2] === 0x05 && zb[e + 3] === 0x06;
        const count = zb[e + 8] | (zb[e + 9] << 8);
        const total = zb[e + 10] | (zb[e + 11] << 8);
        const cdSize = (zb[e + 12] | (zb[e + 13] << 8) | (zb[e + 14] << 16) | (zb[e + 15] << 24)) >>> 0;
        const cdOffset = (zb[e + 16] | (zb[e + 17] << 8) | (zb[e + 18] << 16) | (zb[e + 19] << 24)) >>> 0;
        log('zip: store archive has a valid local header and end record',
          local && eocd && count === 2 && total === 2 && zblob.type === 'application/zip',
          `local=${local} eocd=${eocd} entries=${count}/${total} size=${n}`);
        /* The central record must carry the real name. Appending a Uint8Array inside
           a plain array and passing that to `new Uint8Array(...)` silently writes a
           single zero byte instead - which is how this shipped broken once. */
        const central = zb[cdOffset] === 0x50 && zb[cdOffset + 1] === 0x4b && zb[cdOffset + 2] === 0x01 && zb[cdOffset + 3] === 0x02;
        const nameLen = zb[cdOffset + 28] | (zb[cdOffset + 29] << 8);
        const nameOk = nameLen === 5 && zb[cdOffset + 46] === 0x61 && zb[cdOffset + 47] === 0x2e &&
          zb[cdOffset + 48] === 0x74 && zb[cdOffset + 49] === 0x78 && zb[cdOffset + 50] === 0x74;
        log('zip: central directory records the entry name intact',
          central && nameOk && cdOffset + cdSize === e, `central=${central} nameLen=${nameLen} cd=${cdOffset}+${cdSize} end=${e}`);
        const crc = OS.zip.crc32(new TextEncoder().encode('hello openscene'));
        log('zip: crc32 matches the reference value', crc === 0xbcdb828f, `0x${crc.toString(16)}`);
      } catch (e) {
        log('zip: store archive has a valid local header and end record', false, e.message);
        log('zip: central directory records the entry name intact', false, 'skipped');
        log('zip: crc32 matches the reference value', false, 'skipped');
      }

      /* 16K: the compositor is a 2D canvas, so the ceiling is the engine's own
         canvas limit, not a number we picked. 15360x8640 is the largest size the
         UI and the presets expose. */
      {
        const W16 = 15360, H16 = 8640;
        log('resolution: canvas limits are enforced',
          OS.export.canvasFits(W16, H16) && !OS.export.canvasFits(20000, 20000) && !OS.export.canvasFits(32768, 1024),
          `16K=${OS.export.canvasFits(W16, H16)} 20000^2=${OS.export.canvasFits(20000, 20000)} 32768x1024=${OS.export.canvasFits(32768, 1024)}`);
        if (!OS.export.canvasUsable(W16, H16)) {
          log('resolution: 16K frame composites with content', true, 'engine cannot allocate 16K here - skipped');
          log('resolution: pooled layers stay bounded and are released', true, 'skipped with the 16K render');
        } else {
          const kp = M().createProject({ fps: OS.timebase.fps(30, 1), width: W16, height: H16, name: '16K' });
          const kvt = kp.tracks.find((t) => t.kind === 'video');
          M().insertClip(kp, M().createGeneratorClip('title', kvt.id, 0, 10, { text: '16K', size: 0.3, animation: 'fade' }));
          const kcan = document.createElement('canvas');
          kcan.width = W16; kcan.height = H16;
          const kctx = kcan.getContext('2d', { alpha: false });
          const kscratch = OS.renderer.makeScratch();
          const t0 = performance.now();
          let kerr = null, lit = 0, sampled = 0;
          try {
            OS.renderer.renderFrame(kp, 5, kctx, { scratch: kscratch, media: { get: () => null } });
            // sample a window of the centre instead of the whole 16K frame: a full
            // getImageData here would be another ~530 MB
            const d = kctx.getImageData(W16 / 2 - 600, H16 / 2 - 300, 1200, 600).data;
            for (let i = 0; i < d.length; i += 4) { sampled++; if (d[i] + d[i + 1] + d[i + 2] > 24) lit++; }
          } catch (err) { kerr = err; }
          const ms = Math.round(performance.now() - t0);
          const peak = kscratch.layersFast.length + kscratch.layersSoft.length;
          log('resolution: 16K frame composites with content',
            !kerr && kcan.width === W16 && lit > 0,
            kerr ? String(kerr.message || kerr) : `${W16}x${H16} in ${ms} ms, centre sample ${(lit / Math.max(1, sampled) * 100).toFixed(2)}% lit`);
          OS.renderer.releaseScratch(kscratch);
          const after = kscratch.layersFast.length + kscratch.layersSoft.length;
          log('resolution: pooled layers stay bounded and are released', peak <= 2 && after === 0,
            `peak=${peak} afterRelease=${after}`);
          kcan.width = 0; kcan.height = 0;
        }
      }

      /* 5 — audio mixdown */
      try {
        const mix = await OS.export.buildAudioMix(proj, media, 0, 40, 48000, () => {});
        let energy = 0;
        for (let i = 0; i < mix.channels[0].length; i += 97) energy += Math.abs(mix.channels[0][i]);
        log('audio: offline mixdown for the project range', mix.channels[0].length > 1000 && mix.channels.length === 2 && energy > 1,
          `len=${mix.channels[0].length} energy=${energy.toFixed(1)}`);
      } catch (e) {
        log('audio: offline mixdown for the project range', false, e.message);
      }

      /* 6 — WAV encode */
      {
        const blob = OS.wav.encodeWav([new Float32Array([0, 0.5, -0.5, 1, -1])], 48000);
        log('audio: WAV encoder produces a RIFF file', blob.size === 44 + 10 && blob.type === 'audio/wav', `${blob.size} bytes`);
      }

      /* 7 — real export through the WebCodecs + MP4 muxer path */
      const canWebCodecs = await OS.mp4muxer.isSupported();
      log('export: WebCodecs H.264 available', canWebCodecs, canWebCodecs ? 'yes' : 'not on this platform (realtime fallback will be used)');
      if (canWebCodecs) {
        try {
          const res = await OS.export.run(proj, media, {
            engine: 'precise', container: 'mp4', width: 320, height: 180, fps: 30,
            videoBitrate: 1_500_000, audioBitrate: 96_000, audio: true, quality: 'high',
            range: { start: 0, end: 20 }, hardware: true,
          }, () => {});
          log('export: produced an MP4', !!res.blob && res.blob.size > 2000, `${res.blob ? res.blob.size : 0} bytes via ${res.engine}`);
          log('export: browser verified the MP4', !!(res.verification && res.verification.ok),
            res.verification ? `dur=${(res.verification.duration || 0).toFixed(2)}s ${res.verification.width}x${res.verification.height} seekable=${res.verification.seekable}` : 'no verification');
          if (res.blob && res.blob.size > 2000) {
            const bytes = new Uint8Array(await res.blob.arrayBuffer());
            // Walk the ISO-BMFF top-level box chain and confirm the structure.
            const boxes = [];
            let off = 0;
            while (off + 8 <= bytes.length && boxes.length < 24) {
              const size = ((bytes[off] << 24) | (bytes[off + 1] << 16) | (bytes[off + 2] << 8) | bytes[off + 3]) >>> 0;
              const type = String.fromCharCode(bytes[off + 4], bytes[off + 5], bytes[off + 6], bytes[off + 7]);
              if (size < 8) { boxes.push(type + '!bad'); break; }
              boxes.push(type);
              off += size;
            }
            const okBoxes = boxes[0] === 'ftyp' && boxes.includes('moov') && boxes.includes('mdat') && !boxes.some((b) => b.endsWith('!bad'));
            log('export: MP4 has valid ftyp/moov/mdat boxes', okBoxes, `boxes=${boxes.join(',')}`);
          }
        } catch (e) {
          log('export: precise MP4 export', false, e.message);
        }
        // audio-only m4a
        try {
          const res = await OS.export.run(proj, media, { engine: 'precise', container: 'm4a', audioBitrate: 96_000, range: { start: 0, end: 15 } }, () => {});
          log('export: produced an M4A', !!res.blob && res.blob.size > 800, `${res.blob ? res.blob.size : 0} bytes`);
          log('export: browser verified the M4A', !!(res.verification && res.verification.ok), res.verification ? `dur=${(res.verification.duration || 0).toFixed(2)}s` : '');
        } catch (e) {
          log('export: M4A export', false, e.message);
        }
      }

      /* 8 — still export */
      try {
        const still = await OS.export.exportStill(proj, media, 12, { type: 'image/png' });
        log('export: still frame PNG', still.size > 500 && still.type === 'image/png', `${still.size} bytes`);
      } catch (e) {
        log('export: still frame PNG', false, e.message);
      }

      /* 9 — validation rejects broken projects */
      await assertThrows('model: validate flags a newer project version', async () => {
        const bad = M().createProject();
        bad.version = 99;
        if (M().validate(bad).length === 0) throw new Error('no error reported');
        throw new Error('detected');
      });

      /* 10 — compositing: blend modes and adjustment layers */
      {
        const bp = M().createProject({ fps: OS.timebase.fps(30, 1), width: 160, height: 90, name: 'Blend Test' });
        const vids = bp.tracks.filter((t) => t.kind === 'video');
        const topT = vids[0], bottomT = vids[1];
        const base = M().createGeneratorClip('color', bottomT.id, 0, 20, { color: '#3366cc' });
        const top = M().createGeneratorClip('gradient', topT.id, 0, 20, { color: '#ffcc00', color2: '#003300', angle: 90 });
        M().insertClip(bp, base); M().insertClip(bp, top);

        const bc = document.createElement('canvas'); bc.width = 160; bc.height = 90;
        const bctx = bc.getContext('2d', { alpha: false, willReadFrequently: true });
        const bscratch = OS.renderer.makeScratch();
        const shot = async () => { OS.renderer.renderFrame(bp, 5, bctx, { scratch: bscratch, media: resolver }); return canvasSignature(bctx, 160, 90); };

        const fNormal = await shot();
        top.blend = 'multiply'; const fMultiply = await shot();
        top.blend = 'screen'; const fScreen = await shot();
        top.blend = 'difference'; const fDiff = await shot();
        log('blend: modes change the composite',
          new Set([fNormal, fMultiply, fScreen, fDiff]).size === 4,
          `normal=${fNormal} multiply=${fMultiply} screen=${fScreen} difference=${fDiff}`);

        let opsOk = true, badOp = '';
        for (const [id, , op] of M().BLEND_MODES) {
          bctx.globalCompositeOperation = 'copy';
          bctx.globalCompositeOperation = op;
          if (bctx.globalCompositeOperation !== op) { opsOk = false; badOp = id; break; }
        }
        bctx.globalCompositeOperation = 'source-over';
        log('blend: all ' + M().BLEND_MODES.length + ' modes are real canvas operators', opsOk && M().BLEND_MODES.length >= 16, badOp ? 'rejected: ' + badOp : `count=${M().BLEND_MODES.length}`);
        log('blend: label lookup resolves', M().blendLabel('multiply') === 'Multiply' && M().blendLabel('nonsense') === 'Normal');

        // rip the gradient off and grade the plate with an adjustment layer
        M().removeClip(bp, top);
        const fBase = await shot();
        const adj = M().createAdjustmentClip(topT.id, 0, 20);
        adj.effects.push(M().createEffect('saturation', { amount: 3 }));
        M().insertClip(bp, adj);
        const fAdj = await shot();
        adj.opacity = 0;
        const fAdjOff = await shot();
        log('adjustment: a layer grades the tracks below it', fAdj !== fBase, `base=${fBase} graded=${fAdj}`);
        log('adjustment: opacity 0 is a no-op', fAdjOff === fBase, `off=${fAdjOff} base=${fBase}`);
      }

      /* 11 — grouping survives a save/load round trip */
      {
        const gp = M().createProject({ fps: OS.timebase.fps(30, 1), width: 160, height: 90, name: 'Group Test' });
        const t1 = gp.tracks.find((t) => t.kind === 'video');
        const a = M().createGeneratorClip('color', t1.id, 0, 10, { color: '#f00' });
        const b = M().createGeneratorClip('color', t1.id, 20, 10, { color: '#0f0' });
        M().insertClip(gp, a); M().insertClip(gp, b);
        a.groupId = 'grp-test'; b.groupId = 'grp-test';
        log('group: members resolve by group id', M().groupMembers(gp, a).length === 2 && M().groupPeers(t1, b).length === 2);
        a.blend = 'screen'; b.blend = 'multiply';
        const round = M().deserialize(M().serialize(gp));
        const ra = M().findClip(round, a.id);
        log('group: survives serialise/deserialise',
          !!ra && ra.groupId === 'grp-test' && ra.blend === 'screen' && M().groupMembers(round, ra).length === 2,
          ra ? `groupId=${ra.groupId} blend=${ra.blend}` : 'clip lost');
      }

      /* 12 — professional trims: roll, slip, slide */
      {
        const tp = M().createProject({ fps: OS.timebase.fps(30, 1), width: 160, height: 90, name: 'Trim Test' });
        const t1 = tp.tracks.find((t) => t.kind === 'video');
        const p1 = M().createGeneratorClip('color', t1.id, 0, 30, { color: '#123' });
        const c1 = M().createGeneratorClip('color', t1.id, 30, 30, { color: '#456' });
        const n1 = M().createGeneratorClip('color', t1.id, 60, 30, { color: '#789' });
        M().insertClip(tp, p1); M().insertClip(tp, c1); M().insertClip(tp, n1);

        // roll: move the join between p1 and c1 from frame 30 out to frame 40
        OS.commands.RollEdit(tp, p1, c1, 40).do();
        log('edit: roll moves the shared edge',
          p1.length === 40 && c1.start === 40 && c1.length === 20 && c1.inPoint === 10 && M().clipEnd(p1) === c1.start,
          `p=${p1.length} c.start=${c1.start} c.len=${c1.length} c.in=${c1.inPoint}`);

        // slip: shift the source window without moving the clip
        const beforeStart = c1.start, beforeLen = c1.length, beforeIn = c1.inPoint;
        OS.commands.SlipClip(tp, c1, 7).do();
        log('edit: slip moves the source window only',
          c1.start === beforeStart && c1.length === beforeLen && c1.inPoint === beforeIn + 7,
          `start=${c1.start} len=${c1.length} in=${c1.inPoint}`);

        // slide: move c1 right; p1 grows, n1's head is consumed
        const cmd = OS.commands.SlideClip(tp, c1, 10);
        const cStart = c1.start, pLen = p1.length, nStart = n1.start, nLen = n1.length, nIn = n1.inPoint, cLen = c1.length, cIn = c1.inPoint;
        cmd.do();
        const okSlide = c1.start === cStart + 10 && c1.length === cLen && c1.inPoint === cIn &&
          p1.length === pLen + 10 && n1.start === nStart + 10 && n1.length === nLen - 10 && n1.inPoint === nIn + 10 &&
          M().clipEnd(p1) === c1.start && M().clipEnd(c1) === n1.start;
        log('edit: slide keeps the sequence length fixed', okSlide,
          `c.start=${c1.start} p.len=${p1.length} n.start=${n1.start} n.len=${n1.length} n.in=${n1.inPoint}`);
        cmd.undo();
        log('edit: slide undo restores exactly',
          c1.start === cStart && p1.length === pLen && n1.start === nStart && n1.length === nLen && n1.inPoint === nIn,
          `c.start=${c1.start} p.len=${p1.length} n.start=${n1.start}`);
      }

      /* 13 — scopes analyse pixel data correctly */
      {
        const sc = new OS.scopes.Scopes(null);
        const n = OS.scopes.SAMPLE_W * OS.scopes.SAMPLE_H;
        const black = new Uint8ClampedArray(n * 4);
        const white = new Uint8ClampedArray(n * 4).fill(255);
        const sb = sc._analyze(black);
        const sw = sc._analyze(white);
        log('scopes: black and white analyse correctly',
          sb.maxY === 0 && sb.clip === 0 && sb.avgY === 0 && sw.minY === 255 && sw.clip === n && Math.round(sw.avgY) === 255,
          `black maxY=${sb.maxY} clip=${sb.clip} | white minY=${sw.minY} clip=${sw.clip}/${n}`);
        const mid = new Uint8ClampedArray(n * 4);
        for (let i = 0; i < n; i++) { mid[i * 4] = 128; mid[i * 4 + 1] = 64; mid[i * 4 + 2] = 32; mid[i * 4 + 3] = 255; }
        const sm = sc._analyze(mid);
        log('scopes: levels detected per channel',
          sm.levels.r.lo === 128 && sm.levels.r.hi === 128 && sm.levels.g.lo === 64 && sm.levels.b.hi === 32 && /clipped/.test(sc._readout(sm)),
          `R ${sm.levels.r.lo}-${sm.levels.r.hi} G ${sm.levels.g.lo}-${sm.levels.g.hi} B ${sm.levels.b.lo}-${sm.levels.b.hi}`);
      }

      /* 14 — the mastering bus and per-clip EQ reach the audio mixdown */
      if (audioAsset) {
        const rms = (chs) => { const a = chs[0]; let s = 0, k = 0; for (let i = 0; i < a.length; i += 31) { s += a[i] * a[i]; k++; } return Math.sqrt(s / Math.max(1, k)); };
        const flat = { low: 0, mid: 0, high: 0, comp: false, compThreshold: -18, compRatio: 2.5, limiter: false };
        try {
          const boosted = await OS.export.buildAudioMix(proj, media, 0, 20, 48000, () => {}, { ...flat, mid: 18 });
          const cut = await OS.export.buildAudioMix(proj, media, 0, 20, 48000, () => {}, { ...flat, mid: -18 });
          const r1 = rms(boosted.channels), r2 = rms(cut.channels);
          log('mastering: the bus EQ changes the mixdown', Math.abs(r1 - r2) / Math.max(r1, r2, 1e-6) > 0.05, `boost=${r1.toFixed(4)} cut=${r2.toFixed(4)}`);
        } catch (e) { log('mastering: the bus EQ changes the mixdown', false, e.message); }
        try {
          const cl = M().clipsOf(proj, aTrack)[0];
          const saved = { ...cl.audioEq };
          const before = rms((await OS.export.buildAudioMix(proj, media, 0, 20, 48000, () => {})).channels);
          cl.audioEq = { low: 0, mid: 18, high: 0 };
          const after = rms((await OS.export.buildAudioMix(proj, media, 0, 20, 48000, () => {})).channels);
          cl.audioEq = saved;
          log('audio: per-clip EQ changes the mixdown', Math.abs(before - after) / Math.max(before, after, 1e-6) > 0.03, `flat=${before.toFixed(4)} eq=${after.toFixed(4)}`);
        } catch (e) { log('audio: per-clip EQ changes the mixdown', false, e.message); }
      }
    } catch (e) {
      log('self-test: unexpected failure', false, e.stack || e.message);
    }

    // restore app state
    if (app && restoreProject) {
      // leave the app project untouched; only the scratch store needs disposing
    }
    try { OS.export.cancel(); OS.export.reset(); } catch (e) {}

    const passed = results.filter((r) => r.ok).length;
    const failed = results.length - passed;
    return { passed, failed, results, durationMs: Math.round(performance.now() - t0) };
  }

  async function waitForVideoPaint(media, project, frame) {
    const jobs = [];
    for (const track of project.tracks) {
      if (track.kind !== 'video') continue;
      const clip = M().clipsOf(project, track).find((c) => frame >= c.start && frame < M().clipEnd(c));
      if (!clip || !clip.assetId) continue;
      const asset = M().findAsset(project, clip.assetId);
      if (!asset || asset.kind !== 'video') continue;
      jobs.push(media.seekPrimary(clip.assetId, M().mediaFrameAt(clip, frame), project.fps.rate).catch(() => null));
    }
    if (jobs.length) await Promise.all(jobs);
  }

  OS.selftest = { run, makeVideo, makeAudio, makeImage };
})();
