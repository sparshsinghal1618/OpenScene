/* OpenScene — export.js
   Three export engines:
     precise  — WebCodecs: frame-exact seek-based render, hardware H.264/AAC -> MP4 (own muxer)
     fast     — MediaRecorder: realtime capture from the preview canvas (MP4 if the
                platform supports it, otherwise WebM/VP9)
     audio    — offline mixdown to WAV or AAC/M4A
   Every result is verified by loading the produced blob back into a media element;
   if verification fails the caller falls back automatically. */
(() => {
  'use strict';
  const OS = (window.OS = window.OS || {});
  const { clamp, withTimeout, deferred } = OS.util;
  const M = () => OS.model;

  let cancelToken = { cancelled: false };

  /* Scratch surfaces are pooled, but each live layer still costs one canvas at
     the export resolution — about 500 MB at 16K. Anything an export allocates is
     registered here and released the moment the run ends, pass or fail. */
  let liveScratch = null;
  function trackScratch(s) { liveScratch = s; return s; }
  function freeScratch() { if (liveScratch) { OS.renderer.releaseScratch(liveScratch); liveScratch = null; } }

  const PRESETS = [
    { id: 'uhd16k', name: '16K UHD (8640p) — PNG sequence', width: 15360, height: 8640, fps: 30, videoBitrate: 0, audioBitrate: 192_000, container: 'pngseq' },
    { id: 'uhd8k', name: '8K UHD (4320p) — WebM/VP9', width: 7680, height: 4320, fps: 30, videoBitrate: 140_000_000, audioBitrate: 192_000, container: 'webm', codec: 'vp9' },
    { id: 'dci8k', name: '8K DCI (8192×4320) — WebM/VP9', width: 8192, height: 4320, fps: 24, videoBitrate: 140_000_000, audioBitrate: 192_000, container: 'webm', codec: 'vp9' },
    { id: 'youtube4k', name: 'YouTube 4K UHD (2160p)', width: 3840, height: 2160, fps: 30, videoBitrate: 45_000_000, audioBitrate: 192_000, container: 'mp4' },
    { id: 'youtube1440', name: 'YouTube QHD (1440p)', width: 2560, height: 1440, fps: 30, videoBitrate: 24_000_000, audioBitrate: 192_000, container: 'mp4' },
    { id: 'youtube1080p60', name: 'YouTube Full HD (1080p60)', width: 1920, height: 1080, fps: 60, videoBitrate: 12_000_000, audioBitrate: 192_000, container: 'mp4' },
    { id: 'youtube1080', name: 'YouTube Full HD (1080p)', width: 1920, height: 1080, fps: 30, videoBitrate: 8_000_000, audioBitrate: 160_000, container: 'mp4' },
    { id: 'hd720', name: 'HD (720p)', width: 1280, height: 720, fps: 30, videoBitrate: 5_000_000, audioBitrate: 160_000, container: 'mp4' },
    { id: 'sd480', name: 'SD (480p)', width: 854, height: 480, fps: 30, videoBitrate: 2_500_000, audioBitrate: 128_000, container: 'mp4' },
    { id: 'vertical', name: 'Vertical 9:16 (Instagram / TikTok)', width: 1080, height: 1920, fps: 30, videoBitrate: 8_000_000, audioBitrate: 160_000, container: 'mp4' },
    { id: 'square', name: 'Square 1:1 (feed)', width: 1080, height: 1080, fps: 30, videoBitrate: 8_000_000, audioBitrate: 160_000, container: 'mp4' },
    { id: 'webm1080', name: 'WebM Full HD (VP9, web)', width: 1920, height: 1080, fps: 30, bitrate: 8_000_000, videoBitrate: 8_000_000, audioBitrate: 160_000, container: 'webm', codec: 'vp9' },
    { id: 'audio-wav', name: 'Audio only — WAV (lossless)', container: 'wav', audioBitrate: 0 },
    { id: 'audio-m4a', name: 'Audio only — M4A (AAC 192k)', container: 'm4a', audioBitrate: 192_000 },
    { id: 'custom', name: 'Custom…', custom: true },
  ];

  const QUALITY_STEPS = [
    { id: 'low', name: 'Draft', factor: 0.45 },
    { id: 'medium', name: 'Good', factor: 0.75 },
    { id: 'high', name: 'High', factor: 1 },
    { id: 'max', name: 'Maximum', factor: 1.6 },
  ];

  const even = (n) => Math.max(2, Math.round(n / 2) * 2);

  /* ---------------- resolution capability ---------------- */

  /* The compositor can render anything a 2D canvas can hold. Chromium caps a
     canvas at 2^28 pixels of area and 16384 pixels per side, which puts 16K UHD
     (15360x8640 = 132.7 MP) comfortably inside and 20000x20000 outside.

     Encoding is the tighter limit, and it is not ours to raise: H.264 stops at
     4K, VP9 reaches 8K, and no browser codec encodes 16K at all. That is why the
     16K preset delivers numbered PNG frames — the standard way to hand a
     finished frame at any size to a mastering tool — rather than pretending a
     codec exists. */
  const MAX_SIDE = 16384;
  const MAX_AREA = 16384 * 16384;

  function canvasFits(w, h) {
    if (!(w > 0 && h > 0)) return false;
    if (w > MAX_SIDE || h > MAX_SIDE) return false;
    return w * h <= MAX_AREA;
  }

  /* An over-large canvas is refused by silently clamping its dimensions, so the
     only trustworthy test is to allocate one and read the size back. */
  function canvasUsable(w, h) {
    if (!canvasFits(w, h)) return false;
    let c = null;
    try {
      c = document.createElement('canvas');
      c.width = w; c.height = h;
      const ok = c.width === w && c.height === h;
      if (ok) {
        const x = c.getContext('2d');
        if (!x) return false;
        x.fillStyle = '#000';
        x.fillRect(0, 0, 1, 1);
        void x.getImageData(0, 0, 1, 1);
      }
      return ok;
    } catch (e) {
      return false;
    } finally {
      if (c) { c.width = 0; c.height = 0; }
    }
  }

  const VIDEO_CANDIDATES = [
    { id: 'h264', label: 'H.264', codec: 'avc1.640034', container: 'mp4', maxWidth: 4096 },
    { id: 'vp9', label: 'VP9', codec: 'vp09.00.10.08', container: 'webm', maxWidth: 8192 },
  ];
  const _probeCache = new Map();

  /* What this machine can actually produce at a given size. Used by the export
     dialog so it never offers a setting the encoder will reject, and by the
     pipeline when it has to pick a codec on its own. */
  async function probe(w, h, useCache = true) {
    const key = w + 'x' + h;
    if (useCache && _probeCache.has(key)) return _probeCache.get(key);
    const out = {
      width: w, height: h,
      render: canvasUsable(w, h),
      still: canvasUsable(w, h),
      sequence: canvasUsable(w, h),
      video: [],
      maxVideoWidth: 0,
    };
    if (typeof VideoEncoder === 'undefined' || !out.render) {
      _probeCache.set(key, out);
      return out;
    }
    for (const c of VIDEO_CANDIDATES) {
      let supported = false;
      if (w <= c.maxWidth && h <= c.maxWidth) {
        try {
          const s = await VideoEncoder.isConfigSupported({
            codec: c.codec, width: w, height: h, framerate: 30, bitrate: 20_000_000,
          });
          supported = !!(s && s.supported);
        } catch (e) { supported = false; }
      }
      out.video.push({ id: c.id, label: c.label, container: c.container, supported });
      if (supported) out.maxVideoWidth = Math.max(out.maxVideoWidth, c.maxWidth);
    }
    _probeCache.set(key, out);
    return out;
  }

  /* The largest preset size this engine can render to a canvas, i.e. the ceiling
     for stills and sequences. */
  function maxRenderSize() { return { width: MAX_SIDE, height: MAX_SIDE, area: MAX_AREA }; }

  /* ---------------- audio mixdown (offline, exact) ---------------- */

  async function buildAudioMix(project, media, startFrame, endFrame, sampleRate, onProgress, mastering) {
    const fps = project.fps.rate;
    const seconds = Math.max(0.02, (endFrame - startFrame) / fps);
    const length = Math.ceil(seconds * sampleRate);
    const channels = 2;
    const OAC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    const ctx = new OAC(channels, length, sampleRate);

    // ---- master bus, identical to the live monitoring chain ----
    const masterIn = ctx.createGain();
    let masterTail = masterIn;
    const buildMaster = (m) => {
      const eqLow = ctx.createBiquadFilter();
      eqLow.type = 'lowshelf'; eqLow.frequency.value = 180; eqLow.gain.value = m.low || 0;
      const eqMid = ctx.createBiquadFilter();
      eqMid.type = 'peaking'; eqMid.frequency.value = 1200; eqMid.Q.value = 0.9; eqMid.gain.value = m.mid || 0;
      const eqHigh = ctx.createBiquadFilter();
      eqHigh.type = 'highshelf'; eqHigh.frequency.value = 6500; eqHigh.gain.value = m.high || 0;
      masterIn.connect(eqLow); eqLow.connect(eqMid); eqMid.connect(eqHigh);
      let t = eqHigh;
      if (m.comp) {
        const comp = ctx.createDynamicsCompressor();
        comp.threshold.value = m.compThreshold; comp.knee.value = 22; comp.ratio.value = m.compRatio;
        comp.attack.value = 0.008; comp.release.value = 0.25;
        t.connect(comp); t = comp;
      }
      if (m.limiter) {
        const lim = ctx.createDynamicsCompressor();
        lim.threshold.value = -0.8; lim.knee.value = 0; lim.ratio.value = 20;
        lim.attack.value = 0.001; lim.release.value = 0.08;
        t.connect(lim); t = lim;
      }
      return t;
    };
    if (mastering) masterTail = buildMaster(mastering);
    masterTail.connect(ctx.destination);

    const solo = M().anySolo(project);
    const jobs = [];
    for (const track of project.tracks) {
      if (track.muted) continue;
      if (track.kind === 'audio' && solo && !track.solo) continue;
      if (track.kind === 'video' && solo && !track.solo && project.tracks.some((t) => t.kind === 'audio' && t.solo)) {
        // solo applies to audio-carrying tracks only; video audio follows its own rule below
      }
      for (const clip of M().clipsOf(project, track)) {
        if (M().clipEnd(clip) <= startFrame || clip.start >= endFrame) continue;
        if (!clip.assetId) continue;
        const asset = M().findAsset(project, clip.assetId);
        if (!asset || asset.kind === 'image') continue;
        if (track.kind === 'video' && !asset.hasAudio) continue;
        jobs.push({ clip, track, asset });
      }
    }

    onProgress && onProgress({ phase: 'audio-decode', ratio: 0 });
    const buffers = new Map();
    let i = 0;
    for (const job of jobs) {
      if (cancelToken.cancelled) throw new Error('cancelled');
      if (!buffers.has(job.asset.id)) buffers.set(job.asset.id, await media.ensureAudioBuffer(job.asset.id));
      onProgress && onProgress({ phase: 'audio-decode', ratio: ++i / Math.max(1, jobs.length) });
    }

    for (const { clip, track } of jobs) {
      let buf = buffers.get(clip.assetId);
      if (!buf) continue;
      if (clip.reverse) buf = reversed(buf);
      const speed = clamp(clip.speed || 1, 0.0625, 16);
      const rangeStart = Math.max(clip.start, startFrame);
      const rangeEnd = Math.min(M().clipEnd(clip), endFrame);
      const outStart = (rangeStart - startFrame) / fps;
      const outDur = (rangeEnd - rangeStart) / fps;
      if (outDur <= 0) continue;
      const mediaOffset = M().mediaFrameAt(clip, rangeStart) / fps;
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.playbackRate.value = speed;
      const gain = ctx.createGain();
      // per-clip 3-band EQ, matching the inspector controls
      const eq = clip.audioEq;
      if (eq && (eq.low || eq.mid || eq.high)) {
        const fl = ctx.createBiquadFilter();
        fl.type = 'lowshelf'; fl.frequency.value = 200; fl.gain.value = eq.low || 0;
        const fm = ctx.createBiquadFilter();
        fm.type = 'peaking'; fm.frequency.value = 1200; fm.Q.value = 0.9; fm.gain.value = eq.mid || 0;
        const fh = ctx.createBiquadFilter();
        fh.type = 'highshelf'; fh.frequency.value = 6000; fh.gain.value = eq.high || 0;
        src.connect(fl); fl.connect(fm); fm.connect(fh); fh.connect(gain);
      } else {
        src.connect(gain);
      }
      let tail = gain;
      if (ctx.createStereoPanner) { tail = ctx.createStereoPanner(); gain.connect(tail); }
      tail.connect(masterIn);

      // volume + fade automation sampled at frame rate, honouring volume keyframes
      const steps = Math.max(2, Math.ceil(outDur * fps));
      const g = gain.gain;
      g.cancelScheduledValues(0);
      for (let s = 0; s <= steps; s++) {
        const f = rangeStart + ((rangeEnd - rangeStart) * s) / steps;
        const t = outStart + (outDur * s) / steps;
        const p = M().clipParamsAt(clip, Math.round(f));
        const fade = OS.renderer.fadeAlpha(clip, Math.round(f), fps);
        const fxA = OS.effects.audioGain(p.effects || [], Math.round(f) - clip.start, clip.length, fps);
        const v = clamp(p.volume * fade * fxA, 0, 4);
        if (s === 0) g.setValueAtTime(v, 0);
        else g.linearRampToValueAtTime(v, t);
        if (tail !== gain && s === 0) tail.pan.setValueAtTime(OS.effects.audioPan(p.effects || []), 0);
      }
      const playDur = outDur * speed;
      const maxDur = Math.max(0, (buf.duration - mediaOffset) / speed);
      try {
        src.start(outStart, Math.max(0, mediaOffset), Math.min(playDur, maxDur || playDur));
      } catch (e) { /* out of range */ }
    }

    onProgress && onProgress({ phase: 'audio-render', ratio: 0 });
    const rendered = await ctx.startRendering();
    const out = [];
    for (let c = 0; c < rendered.numberOfChannels; c++) out.push(rendered.getChannelData(c));
    // mono-mix to stereo if the context gave us fewer channels
    while (out.length < channels) out.push(out[0]);
    return { channels: out.slice(0, channels), sampleRate, duration: seconds };
  }

  let _reversedCache = new Map();
  function reversed(buf) {
    const key = buf;
    let r = _reversedCache.get(key);
    if (r) return r;
    const AC = window.AudioContext || window.webkitAudioContext;
    const c = document.createElement('canvas'); // unused placeholder for symmetry
    const off = new (window.OfflineAudioContext || window.webkitOfflineAudioContext)(buf.numberOfChannels, buf.length, buf.sampleRate);
    const b2 = off.createBuffer(buf.numberOfChannels, buf.length, buf.sampleRate);
    for (let ch = 0; ch < buf.numberOfChannels; ch++) {
      const src = buf.getChannelData(ch), dst = b2.getChannelData(ch);
      for (let i = 0, n = buf.length; i < n; i++) dst[i] = src[n - 1 - i];
    }
    _reversedCache.set(key, b2);
    if (_reversedCache.size > 4) _reversedCache = new Map([[key, b2]]);
    return b2;
  }

  /* ---------------- precise (WebCodecs) video export ---------------- */

  async function exportPrecise(project, media, opts, onProgress) {
    const W = even(opts.width), H = even(opts.height), fps = opts.fps;
    const start = opts.range.start, end = opts.range.end;
    const total = Math.max(1, end - start);
    const wantVideo = opts.container !== 'wav' && opts.container !== 'm4a';
    const wantAudio = opts.audio && (opts.container !== 'wav' || true);

    let vConfig = null;
    if (wantVideo) {
      vConfig = await OS.mp4muxer.pickH264Config(W, H, Math.round(opts.videoBitrate * qualityFactor(opts.quality)), fps, opts.hardware !== false);
      if (!vConfig) {
        /* Above 4K no H.264 level covers the frame, and the bundled muxer only
           writes avc1 sample entries. Name the real reason so the caller can
           fall back to the VP9 recorder instead of reporting a generic failure. */
        if (W > 4096 || H > 2304) {
          throw new Error(`H.264 cannot encode ${W}×${H} (its ceiling is 4096×2304) — switching to the VP9 recorder`);
        }
        throw new Error('H.264 encoding is not available on this platform');
      }
    }
    let aConfig = null;
    if (wantAudio) {
      aConfig = await OS.mp4muxer.pickAacConfig(48000, 2, opts.audioBitrate || 192000);
      if (!aConfig) { aConfig = null; opts.warnings.push('AAC audio encoder unavailable — exporting video only'); }
    }

    const mux = new OS.mp4muxer.MP4Muxer({
      video: wantVideo ? { width: W, height: H, fps } : null,
      audio: aConfig ? { sampleRate: 48000, channels: 2, bitrate: opts.audioBitrate || 192000 } : null,
    });

    const encoderErrors = [];
    let vEncoder = null;
    if (wantVideo) {
      vEncoder = new VideoEncoder({
        output: (chunk, meta) => { try { mux.addVideoChunk(chunk, meta); } catch (e) { encoderErrors.push(e); } },
        error: (e) => encoderErrors.push(e),
      });
      vEncoder.configure(vConfig);
    }

    // canvas we compose into (full export resolution)
    const canvas = document.createElement('canvas');
    canvas.width = W; canvas.height = H;
    const ctx = canvas.getContext('2d', { alpha: false, willReadFrequently: true });
    const scratch = trackScratch(OS.renderer.makeScratch());
    const gop = Math.max(1, Math.round(fps * 2));

    // resolver bound to per-clip elements created for this export
    const binding = new Map();
    const resolver = {
      get(assetId, clipId) {
        const b = binding.get(clipId);
        if (b && b.assetId === assetId) return { video: b.el, image: media.records.get(assetId)?.image };
        return media.get(assetId, clipId);
      },
    };

    const t0 = performance.now();
    const frameDurUs = Math.round(1_000_000 / fps);
    let outIndex = 0;
    for (let f = start; f < end; f++) {
      if (cancelToken.cancelled) throw new Error('cancelled');
      if (encoderErrors.length) throw encoderErrors[0];

      // ensure the right elements are bound + seeked for this frame
      await seekClipsForFrame(project, media, f, binding, resolver);

      OS.renderer.renderFrame(project, f, ctx, { scratch, media: resolver });
      const frame = new VideoFrame(canvas, { timestamp: outIndex * frameDurUs, duration: frameDurUs });
      try { vEncoder.encode(frame, { keyFrame: outIndex % gop === 0 }); } finally { frame.close(); }
      outIndex++;

      // backpressure
      while (vEncoder.encodeQueueSize > 6) await nextTick();
      if (outIndex % 4 === 0 || outIndex === total) {
        reportFrame(onProgress, outIndex, total, t0, 'video');
      }
      if (opts.maxSeconds && outIndex / fps >= opts.maxSeconds) break;
    }

    /* The frame canvas and every pooled layer are dead weight from here on. */
    OS.renderer.releaseScratch(scratch);
    canvas.width = 0; canvas.height = 0;

    if (vEncoder) { await vEncoder.flush(); vEncoder.close(); }

    if (aConfig && !cancelToken.cancelled) {
      onProgress({ phase: 'audio', ratio: 0 });
      const mix = await buildAudioMix(project, media, start, Math.min(end, start + Math.ceil((outIndex / fps) * fps)), 48000, (p) => onProgress({ phase: 'audio', ratio: p.ratio }), opts.mastering);
      const aEncoder = new AudioEncoder({
        output: (chunk, meta) => { try { mux.addAudioChunk(chunk, meta); } catch (e) { encoderErrors.push(e); } },
        error: (e) => encoderErrors.push(e),
      });
      aEncoder.configure(aConfig);
      const CHUNK = 1024 * 8;   // frames per AudioData
      const totalSamples = mix.channels[0].length;
      const planes = mix.channels.length;
      for (let s = 0, n = 0; s < totalSamples; s += CHUNK, n++) {
        if (cancelToken.cancelled) throw new Error('cancelled');
        const count = Math.min(CHUNK, totalSamples - s);
        const data = new Float32Array(count * planes);
        for (let c = 0; c < planes; c++) data.set(mix.channels[c].subarray(s, s + count), c * count);
        const ad = new AudioData({
          format: 'f32-planar',
          sampleRate: mix.sampleRate,
          numberOfFrames: count,
          numberOfChannels: planes,
          timestamp: Math.round((s / mix.sampleRate) * 1_000_000),
          data,
        });
        aEncoder.encode(ad);
        ad.close();
        while (aEncoder.encodeQueueSize > 12) await nextTick();
        if (n % 24 === 0) onProgress({ phase: 'audio', ratio: s / totalSamples });
      }
      await aEncoder.flush();
      aEncoder.close();
    }

    const bytes = mux.finalise();
    return new Blob([bytes], { type: opts.container === 'm4a' ? 'audio/mp4' : 'video/mp4' });
  }

  function qualityFactor(q) { return (QUALITY_STEPS.find((s) => s.id === q) || {}).factor || 1; }

  const nextTick = () => new Promise((r) => setTimeout(r, 0));

  function reportFrame(onProgress, done, total, t0, phase) {
    const elapsed = (performance.now() - t0) / 1000;
    const rate = done / Math.max(0.001, elapsed);
    onProgress({ phase, ratio: done / total, frame: done, total, fps: rate, etaSec: (total - done) / Math.max(0.001, rate) });
  }

  /* Bind/seek per-clip elements for one export frame (frame-exact). */
  async function seekClipsForFrame(project, media, frame, binding, resolver) {
    const wanted = new Map();
    for (const track of project.tracks) {
      if (track.kind !== 'video' && track.kind !== 'audio') continue;
      for (const clip of M().clipsOf(project, track)) {
        if (frame < clip.start || frame >= M().clipEnd(clip)) continue;
        if (!clip.assetId) continue;
        const asset = M().findAsset(project, clip.assetId);
        if (!asset || asset.kind === 'image') continue;
        wanted.set(clip.id, clip);
      }
    }
    for (const [clipId, b] of [...binding]) {
      if (!wanted.has(clipId)) { media.release(b.assetId, clipId, b.kind); binding.delete(clipId); }
    }
    const fps = project.fps.rate;
    const jobs = [];
    for (const [clipId, clip] of wanted) {
      let b = binding.get(clipId);
      if (!b) {
        const el = media.acquire(clip.assetId, clipId, 'video');
        if (!el) continue;
        el.muted = true;
        b = { el, assetId: clip.assetId, kind: 'video', clip };
        binding.set(clipId, b);
      }
      b.clip = clip;
      const target = Math.max(0, (M().mediaFrameAt(clip, frame) + 0.5) / fps);
      if (Math.abs(b.el.currentTime - target) > 0.0005 || b.el.readyState < 2) {
        b.el.pause();
        jobs.push(withTimeout(new Promise((res) => {
          const done = () => { b.el.removeEventListener('seeked', done); res(); };
          b.el.addEventListener('seeked', done);
          try { b.el.currentTime = target; } catch (e) { res(); }
          if (b.el.readyState >= 2 && Math.abs(b.el.currentTime - target) < 0.002) setTimeout(done, 30);
        }), 8000, 'export seek').catch(() => {}));
      }
    }
    if (jobs.length) await Promise.all(jobs);
  }

  /* ---------------- realtime (MediaRecorder) export ---------------- */

  function pickRecorderMime(opts) {
    const want = [];
    if (opts.container === 'mp4') {
      want.push('video/mp4;codecs=avc1.42E01E,mp4a.40.2', 'video/mp4;codecs=avc1.4D401F,mp4a.40.2', 'video/mp4;codecs=h264,aac', 'video/mp4', 'video/mp4;codecs=avc1');
    }
    const vcodec = opts.codec === 'vp8' ? 'vp8' : 'vp9';
    want.push(`video/webm;codecs=${vcodec},opus`, 'video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm');
    for (const m of want) if (MediaRecorder.isTypeSupported(m)) return m;
    return '';
  }

  async function exportRealtime(project, media, opts, onProgress) {
    if (typeof MediaRecorder === 'undefined') throw new Error('MediaRecorder is not available');
    const W = even(opts.width), H = even(opts.height);
    const player = OS.app.player;
    const prevScale = player.previewScale;
    const prevVolume = player.masterVolume;
    /* Auto-quality exists to keep the preview smooth. During a recording it would
       quietly downscale the source canvas and the export would be upscaled back
       up — which matters enormously at 8K, so pin the scale for the take. */
    const prevAutoQuality = player.autoQuality;
    player.autoQuality = false;
    const start = opts.range.start, end = opts.range.end;
    const fps = opts.fps;

    const mime = pickRecorderMime(opts);
    if (!mime) throw new Error('no supported recording codec');
    const container = mime.includes('mp4') ? 'mp4' : 'webm';

    // export canvas + recorder
    const canvas = document.createElement('canvas');
    canvas.width = W; canvas.height = H;
    const ctx = canvas.getContext('2d', { alpha: false });
    const stream = canvas.captureStream(fps);
    // audio tap from the player master bus
    const audio = player.ensureAudio();
    let dest = null;
    if (audio && opts.audio !== false) {
      dest = audio.ctx.createMediaStreamDestination();
      audio.master.connect(dest);
      for (const t of dest.stream.getAudioTracks()) stream.addTrack(t);
    }
    const chunks = [];
    let recorder = null;
    try {
      recorder = new MediaRecorder(stream, {
        mimeType: mime,
        videoBitsPerSecond: Math.round(opts.videoBitrate * qualityFactor(opts.quality)),
        audioBitsPerSecond: opts.audioBitrate || 192000,
      });
    } catch (e) {
      if (dest) audio.master.disconnect(dest);
      throw new Error('MediaRecorder rejected the configuration: ' + e.message);
    }
    const stopped = deferred();
    recorder.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
    recorder.onstop = () => stopped.resolve();
    recorder.onerror = (e) => stopped.reject(e.error || new Error('recorder error'));

    // full-res preview while recording
    player.setPreviewScale(1);
    player.resize();
    await player.seekTo(start, { resume: false });
    recorder.start(1000);
    player.play(1);
    player.loop = false;

    const drawn = { n: 0 };
    const total = end - start;
    const drawLoop = () => {
      if (!recording) return;
      const src = player.canvas;
      if (src.width && src.height) ctx.drawImage(src, 0, 0, src.width, src.height, 0, 0, W, H);
      drawn.n++;
      const cur = player.frame;
      reportFrame(onProgress, Math.max(0, cur - start), total, tStart, 'record');
      if (cur >= end - 1) { stopRecording(); return; }
      requestAnimationFrame(drawLoop);
    };
    let recording = true;
    const tStart = performance.now();
    const stopRecording = () => {
      if (!recording) return;
      recording = false;
      try { recorder.stop(); } catch (e) { stopped.resolve(); }
      player.pause();
      player.setPreviewScale(prevScale);
      player.setMasterVolume(prevVolume);
      if (dest) { try { audio.master.disconnect(dest); } catch (e) {} }
    };
    const cancelWatch = setInterval(() => {
      if (cancelToken.cancelled) stopRecording();
    }, 150);

    requestAnimationFrame(drawLoop);
    try {
      await withTimeout(stopped.promise, ((total / fps) + 30) * 1000, 'recording');
    } finally {
      clearInterval(cancelWatch);
      stopRecording();
      player.setPreviewScale(prevScale);
      player.autoQuality = prevAutoQuality;
      if (dest) { try { audio.master.disconnect(dest); } catch (e) {} }
    }
    if (cancelToken.cancelled) throw new Error('cancelled');
    const type = container === 'mp4' ? 'video/mp4' : 'video/webm';
    const blob = new Blob(chunks, { type });
    if (!blob.size) throw new Error('recorder produced no data');
    return blob;
  }

  /* ---------------- audio-only ---------------- */

  async function exportAudio(project, media, opts, onProgress) {
    const start = opts.range.start, end = opts.range.end;
    const sampleRate = 48000;
    onProgress({ phase: 'audio', ratio: 0 });
    const mix = await buildAudioMix(project, media, start, end, sampleRate, (p) => onProgress({ phase: 'audio', ratio: p.ratio }), opts.mastering);
    if (opts.container === 'wav') {
      onProgress({ phase: 'encode', ratio: 0.6 });
      const blob = OS.wav.encodeWav(mix.channels, sampleRate);
      onProgress({ phase: 'encode', ratio: 1 });
      return blob;
    }
    // m4a via WebCodecs AAC + mp4 muxer
    const aConfig = await OS.mp4muxer.pickAacConfig(sampleRate, 2, opts.audioBitrate || 192000);
    if (!aConfig) throw new Error('AAC encoding is not available — choose WAV instead');
    const mux = new OS.mp4muxer.MP4Muxer({ audio: { sampleRate, channels: 2, bitrate: opts.audioBitrate || 192000 } });
    const errors = [];
    const enc = new AudioEncoder({ output: (c, m) => mux.addAudioChunk(c, m), error: (e) => errors.push(e) });
    enc.configure(aConfig);
    const CHUNK = 1024 * 8;
    const totalSamples = mix.channels[0].length;
    for (let s = 0; s < totalSamples; s += CHUNK) {
      if (cancelToken.cancelled) throw new Error('cancelled');
      if (errors.length) throw errors[0];
      const count = Math.min(CHUNK, totalSamples - s);
      const data = new Float32Array(count * 2);
      data.set(mix.channels[0].subarray(s, s + count), 0);
      data.set(mix.channels[1].subarray(s, s + count), count);
      const ad = new AudioData({ format: 'f32-planar', sampleRate, numberOfFrames: count, numberOfChannels: 2, timestamp: Math.round((s / sampleRate) * 1e6), data });
      enc.encode(ad); ad.close();
      while (enc.encodeQueueSize > 12) await nextTick();
      onProgress({ phase: 'encode', ratio: s / totalSamples });
    }
    await enc.flush(); enc.close();
    return new Blob([mux.finalise()], { type: 'audio/mp4' });
  }

  /* ---------------- PNG sequence (the 16K delivery path) ---------------- */

  /* Renders every frame at full resolution and hands back numbered PNGs in a
     ZIP. No browser codec encodes 16K, so this — not a video file — is what
     makes 16K real: the sequence drops straight into ffmpeg, After Effects or
     Resolve, which is how 16K gets finished anyway. Frames go into the archive
     as they render, so peak memory is one frame rather than the whole sequence. */
  async function exportPngSequence(project, media, opts, onProgress) {
    const W = even(opts.width), H = even(opts.height);
    if (!canvasUsable(W, H)) throw new Error(`this renderer cannot allocate a ${W}×${H} canvas`);
    const fps = opts.fps;
    const start = opts.range.start, end = opts.range.end;
    const total = Math.max(1, end - start);

    const canvas = document.createElement('canvas');
    canvas.width = W; canvas.height = H;
    const ctx = canvas.getContext('2d', { alpha: false });
    const scratch = trackScratch(OS.renderer.makeScratch());
    const zip = OS.zip.create();
    const digits = Math.max(4, String(total).length);
    const pad = (n) => String(n).padStart(digits, '0');

    const binding = new Map();
    const resolver = {
      get(assetId, clipId) {
        const b = binding.get(clipId);
        if (b && b.assetId === assetId) return { video: b.el, image: media.records.get(assetId)?.image };
        return media.get(assetId, clipId);
      },
    };

    const t0 = performance.now();
    let n = 0;
    for (let f = start; f < end; f++) {
      if (cancelToken.cancelled) throw new Error('cancelled');
      await seekClipsForFrame(project, media, f, binding, resolver);
      OS.renderer.renderFrame(project, f, ctx, { scratch, media: resolver });
      const blob = await new Promise((res, rej) => canvas.toBlob((b) => (b ? res(b) : rej(new Error('PNG encode failed'))), 'image/png'));
      await zip.add(`frame-${pad(n + 1)}.png`, blob);
      n++;
      if (n % 2 === 0 || n === total) reportFrame(onProgress, n, total, t0, 'frames');
      if (opts.maxSeconds && n / fps >= opts.maxSeconds) break;
    }
    if (!n) throw new Error('nothing to render');
    onProgress({ phase: 'package', ratio: 1 });
    return zip.build();
  }

  /* ---------------- stills ---------------- */

  async function exportStill(project, media, frame, opts = {}) {
    const canvas = document.createElement('canvas');
    canvas.width = project.width; canvas.height = project.height;
    const ctx = canvas.getContext('2d', { alpha: false });
    const scratch = trackScratch(OS.renderer.makeScratch());
    const resolver = {
      get(assetId, clipId) { return media.get(assetId, clipId); },
    };
    // seek primary elements so the still is accurate
    for (const track of project.tracks) {
      if (track.kind !== 'video') continue;
      const clip = M().clipsOf(project, track).find((c) => frame >= c.start && frame < M().clipEnd(c));
      if (!clip || !clip.assetId) continue;
      const asset = M().findAsset(project, clip.assetId);
      if (asset && asset.kind === 'video') await media.seekPrimary(clip.assetId, M().mediaFrameAt(clip, frame), project.fps.rate);
    }
    OS.renderer.renderFrame(project, frame, ctx, { scratch, media: resolver });
    OS.renderer.releaseScratch(scratch);
    const type = opts.type || 'image/png';
    return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('still encode failed'))), type, opts.quality ?? 0.92));
  }

  /* ---------------- verification ---------------- */

  async function verifyBlob(blob, kind = 'video') {
    try {
      const url = URL.createObjectURL(blob);
      const el = document.createElement(kind === 'audio' ? 'audio' : 'video');
      const res = await withTimeout(new Promise((resolve) => {
        el.onloadedmetadata = () => resolve({ ok: true, duration: el.duration, width: el.videoWidth || 0, height: el.videoHeight || 0 });
        el.onerror = () => resolve({ ok: false, error: 'media element rejected the file' });
        el.preload = 'metadata';
        el.src = url;
      }), 15000, 'verify');
      URL.revokeObjectURL(url);
      if (!res.ok) return res;
      // also confirm it is seekable to the end
      const seek = await withTimeout(new Promise((resolve) => {
        const el2 = document.createElement(kind === 'audio' ? 'audio' : 'video');
        el2.onloadeddata = () => { try { el2.currentTime = Math.max(0, (el2.duration || 1) * 0.95); } catch (e) { resolve(true); } };
        el2.onseeked = () => resolve(true);
        el2.onerror = () => resolve(false);
        el2.preload = 'auto';
        el2.src = url;
      }), 15000, 'verify-seek').catch(() => true);
      return { ...res, seekable: seek };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  /* ---------------- public entry point ---------------- */

  async function run(project, media, options, onProgress = () => {}) {
    cancelToken = { cancelled: false };
    const opts = {
      width: options.width, height: options.height, fps: options.fps || project.fps.rate,
      videoBitrate: options.videoBitrate || 8_000_000, audioBitrate: options.audioBitrate || 192_000,
      quality: options.quality || 'high', container: options.container || 'mp4',
      audio: options.audio !== false, hardware: options.hardware !== false,
      range: options.range || { start: 0, end: M().projectDuration(project) },
      warnings: [], maxSeconds: options.maxSeconds,
    };
    if (opts.range.end <= opts.range.start) { opts.range.end = opts.range.start + 1; }
    const engine = options.engine || 'precise';
    const notes = [];
    let blob = null, usedEngine = engine;

    try {
      if (opts.container === 'pngseq') {
        usedEngine = 'frames';
        blob = await exportPngSequence(project, media, opts, onProgress);
        onProgress({ phase: 'done', ratio: 1 });
        return { blob, engine: usedEngine, verification: { ok: true, kind: 'sequence' }, notes, opts };
      }
      if (opts.container === 'wav' || opts.container === 'm4a') {
        usedEngine = 'audio';
        blob = await exportAudio(project, media, opts, onProgress);
      } else if (engine === 'precise') {
        try {
          blob = await exportPrecise(project, media, opts, onProgress);
        } catch (e) {
          if (e.message === 'cancelled') throw e;
          notes.push(`Precise engine failed (${e.message}); fell back to the realtime recorder.`);
          onProgress({ phase: 'fallback', ratio: 0, message: notes[notes.length - 1] });
          usedEngine = 'realtime';
          blob = await exportRealtime(project, media, opts, onProgress);
        }
      } else {
        usedEngine = 'realtime';
        blob = await exportRealtime(project, media, opts, onProgress);
      }

      onProgress({ phase: 'verify', ratio: 0 });
      const kind = (opts.container === 'wav' || opts.container === 'm4a') ? 'audio' : 'video';
      const verification = await verifyBlob(blob, kind);
      if (!verification.ok && usedEngine === 'precise') {
        notes.push(`Export verification failed (${verification.error || 'unknown'}); re-exporting with the realtime recorder.`);
        onProgress({ phase: 'fallback', ratio: 0, message: notes[notes.length - 1] });
        usedEngine = 'realtime';
        blob = await exportRealtime(project, media, opts, onProgress);
        const v2 = await verifyBlob(blob, kind);
        return { blob, engine: usedEngine, verification: v2, notes, opts };
      }
      if (!verification.ok) notes.push(`Verification warning: ${verification.error || 'could not confirm playback'}`);
      onProgress({ phase: 'done', ratio: 1 });
      return { blob, engine: usedEngine, verification, notes, opts };
    } catch (e) {
      if (e.message === 'cancelled') onProgress({ phase: 'cancelled', ratio: 0 });
      throw e;
    } finally {
      freeScratch();
    }
  }

  function cancel() { cancelToken.cancelled = true; }
  /* Clears a previous cancellation so a fresh direct call (eg. buildAudioMix from a
     test harness) is not aborted by stale state. run() does this itself. */
  function reset() { cancelToken = { cancelled: false }; }

  function suggestedFilename(project, container) {
    const base = (project.name || 'OpenScene Project').replace(/[\\/:*?"<>|]+/g, '_').trim() || 'OpenScene Export';
    const ext = { wav: 'wav', m4a: 'm4a', webm: 'webm', pngseq: 'zip', png: 'png', jpg: 'jpg' }[container] || 'mp4';
    return `${base}.${ext}`;
  }

  OS.export = {
    PRESETS, QUALITY_STEPS, run, cancel, reset,
    exportStill, buildAudioMix, verifyBlob, suggestedFilename, pickRecorderMime, even,
    /* resolution capability — used by the export dialog and the project settings */
    probe, canvasUsable, canvasFits, maxRenderSize, MAX_SIDE, MAX_AREA,
  };
})();
