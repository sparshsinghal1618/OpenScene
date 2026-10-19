/* OpenScene — player.js
   Playback engine: transport (play/pause/seek/step/JKL shuttle), a master-frame clock,
   drift-corrected native media element sync, WebAudio mixing with per-clip gain,
   fades and meters, plus the preview render loop. */
(() => {
  'use strict';
  const OS = (window.OS = window.OS || {});
  const { clamp, withTimeout, Emitter } = OS.util;
  const M = () => OS.model;

  const SHUTTLE_FWD = [1, 2, 4, 8];
  const SHUTTLE_REV = [-1, -2, -4, -8];

  class Player {
    constructor(canvas) {
      this.canvas = canvas;
      this.ctx = canvas.getContext('2d', { alpha: false, desynchronized: true });
      this.project = null;
      this.media = null;
      this.frameF = 0;          // fractional master frame
      this.playing = false;
      this.rate = 0;            // signed playback rate (frames per second multiplier)
      this.loop = false;
      this.events = new Emitter();
      this.scratch = OS.renderer.makeScratch();
      this.bindings = new Map(); // clipId -> {el, assetId, kind, clip}
      this.previewScale = 1;     // 1 = full
      this.autoQuality = true;
      this._needRender = true;
      this._seekToken = 0;
      this._pendingSeek = null;
      this._audio = null;
      this._levels = { l: 0, r: 0 };
      // Mastering bus defaults. Kept on the player so the Mastering dialog and
      // the graph share one source of truth.
      this.mastering = {
        low: 0, mid: 0, high: 0,        // dB shelving / peaking EQ
        comp: false, compThreshold: -18, compRatio: 2.5,
        limiter: true,
      };
      this._meter = new OS.util.FrameMeter();
      this._lastNow = 0;
      this._reverse = false;
      this._lastRenderFrame = -1;
      this._exportMode = false;
      this._onResize = OS.util.debounce(() => this.resize(), 80);
      window.addEventListener('resize', this._onResize);
      this._loop = (now) => this._tick(now);
      requestAnimationFrame(this._loop);
    }

    attach(project, media) {
      this.project = project;
      this.media = media;
      this.frameF = 0;
      this.stop();
      this.resize();
      this.requestRender();
    }

    get fps() { return this.project ? this.project.fps.rate : 30; }
    get frame() { return Math.round(this.frameF); }
    get duration() { return this.project ? M().projectDuration(this.project) : 0; }

    setPreviewScale(s) { this.previewScale = s; this.resize(); this.requestRender(); }

    resize() {
      if (!this.project) return;
      const w = this.project.width, h = this.project.height;
      const bw = Math.max(2, Math.round(w * this.previewScale));
      const bh = Math.max(2, Math.round(h * this.previewScale));
      if (this.canvas.width !== bw || this.canvas.height !== bh) { this.canvas.width = bw; this.canvas.height = bh; }
      this.requestRender();
    }

    requestRender() { this._needRender = true; }

    /* ---------------- audio graph ---------------- */

    ensureAudio() {
      if (this._audio) { if (this._audio.ctx.state === 'suspended') this._audio.ctx.resume().catch(() => {}); return this._audio; }
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      const ctx = new AC();
      const master = ctx.createGain();
      master.gain.value = this.masterVolume == null ? 1 : this.masterVolume;

      // ---- mastering bus: 3-band EQ -> compressor -> limiter -> output ----
      const eqLow = ctx.createBiquadFilter();
      eqLow.type = 'lowshelf'; eqLow.frequency.value = 180;
      const eqMid = ctx.createBiquadFilter();
      eqMid.type = 'peaking'; eqMid.frequency.value = 1200; eqMid.Q.value = 0.9;
      const eqHigh = ctx.createBiquadFilter();
      eqHigh.type = 'highshelf'; eqHigh.frequency.value = 6500;
      const comp = ctx.createDynamicsCompressor();
      comp.threshold.value = -18; comp.knee.value = 22; comp.ratio.value = 2.5;
      comp.attack.value = 0.008; comp.release.value = 0.25;
      const limiter = ctx.createDynamicsCompressor();
      limiter.threshold.value = -0.8; limiter.knee.value = 0; limiter.ratio.value = 20;
      limiter.attack.value = 0.001; limiter.release.value = 0.08;

      master.connect(eqLow); eqLow.connect(eqMid); eqMid.connect(eqHigh);
      eqHigh.connect(comp); comp.connect(limiter);

      // meters tap the post-chain signal so they show what actually leaves the app
      const splitter = ctx.createChannelSplitter(2);
      const anL = ctx.createAnalyser(), anR = ctx.createAnalyser();
      anL.fftSize = 1024; anR.fftSize = 1024;
      limiter.connect(splitter);
      splitter.connect(anL, 0);
      splitter.connect(anR, 1);
      limiter.connect(ctx.destination);

      this._audio = {
        ctx, master, eqLow, eqMid, eqHigh, comp, limiter, splitter, anL, anR,
        bufL: new Float32Array(anL.fftSize), bufR: new Float32Array(anR.fftSize),
      };
      this.applyMastering();
      return this._audio;
    }

    /* Push the mastering settings (EQ gain, compressor, limiter) onto the live
       graph. Safe to call before audio exists — it is applied on first use. */
    applyMastering() {
      const a = this._audio;
      if (!a) return;
      const m = this.mastering;
      const t = a.ctx.currentTime;
      a.eqLow.gain.setTargetAtTime(m.low, t, 0.05);
      a.eqMid.gain.setTargetAtTime(m.mid, t, 0.05);
      a.eqHigh.gain.setTargetAtTime(m.high, t, 0.05);
      a.comp.threshold.setTargetAtTime(m.comp ? m.compThreshold : 0, t, 0.05);
      a.comp.ratio.setTargetAtTime(m.comp ? m.compRatio : 1, t, 0.05);
      a.limiter.threshold.setTargetAtTime(m.limiter ? -0.8 : 0, t, 0.05);
      a.limiter.ratio.setTargetAtTime(m.limiter ? 20 : 1, t, 0.05);
    }

    setMasterVolume(v) {
      this.masterVolume = clamp(v, 0, 2);
      if (this._audio) this._audio.master.gain.setTargetAtTime(this.masterVolume, this._audio.ctx.currentTime, 0.02);
    }

    getLevels() {
      const a = this._audio;
      if (!a) return this._levels;
      a.anL.getFloatTimeDomainData(a.bufL);
      a.anR.getFloatTimeDomainData(a.bufR);
      const rms = (b) => { let s = 0; for (let i = 0; i < b.length; i++) s += b[i] * b[i]; return Math.sqrt(s / b.length); };
      this._levels = { l: rms(a.bufL), r: rms(a.bufR) };
      return this._levels;
    }

    /* Element -> source node (once per element), with its own gain stage and a
       3-band EQ so clip-level tone shaping is possible. */
    _elementAudio(el) {
      const a = this.ensureAudio();
      if (!a) return null;
      if (!el.__okAudio) {
        try {
          const src = a.ctx.createMediaElementSource(el);
          const eqLow = a.ctx.createBiquadFilter();
          eqLow.type = 'lowshelf'; eqLow.frequency.value = 200;
          const eqMid = a.ctx.createBiquadFilter();
          eqMid.type = 'peaking'; eqMid.frequency.value = 1200; eqMid.Q.value = 0.9;
          const eqHigh = a.ctx.createBiquadFilter();
          eqHigh.type = 'highshelf'; eqHigh.frequency.value = 6000;
          const gain = a.ctx.createGain();
          gain.gain.value = 1;
          let panner = null;
          src.connect(eqLow); eqLow.connect(eqMid); eqMid.connect(eqHigh); eqHigh.connect(gain);
          if (a.ctx.createStereoPanner) { panner = a.ctx.createStereoPanner(); panner.pan.value = 0; gain.connect(panner); panner.connect(a.master); }
          else { gain.connect(a.master); }
          el.__okAudio = { src, eqLow, eqMid, eqHigh, gain, panner };
        } catch (e) { el.__okAudio = { src: null, gain: null, panner: null }; }
      }
      return el.__okAudio;
    }

    /* ---------------- clip binding ---------------- */

    _resolver() {
      const self = this;
      return {
        get(assetId, clipId) {
          const b = self.bindings.get(clipId);
          if (b && b.assetId === assetId) return { video: b.el, image: self.media.records.get(assetId)?.image };
          return self.media.get(assetId, clipId);
        },
      };
    }

    _bindActive(frame) {
      if (!this.project || !this.media) return;
      const wanted = new Map(); // clipId -> {clip, kind}
      for (const track of this.project.tracks) {
        const solo = M().anySolo(this.project);
        for (const clip of M().clipsOf(this.project, track)) {
          if (frame < clip.start - 1 || frame > M().clipEnd(clip)) continue;
          if (!clip.assetId) continue;
          const asset = M().findAsset(this.project, clip.assetId);
          if (!asset) continue;
          if (asset.kind === 'image') continue;
          if (track.kind === 'video') wanted.set(clip.id, { clip, kind: 'video' });
          else if (!track.muted && (!solo || track.solo)) wanted.set(clip.id, { clip, kind: 'audio' });
        }
      }
      // release stale
      for (const [clipId, b] of [...this.bindings]) {
        if (!wanted.has(clipId)) {
          this.media.release(b.assetId, clipId, b.kind);
          this.bindings.delete(clipId);
        }
      }
      // acquire + sync state
      for (const [clipId, info] of wanted) {
        let b = this.bindings.get(clipId);
        if (!b) {
          const el = this.media.acquire(info.clip.assetId, clipId, info.kind);
          if (!el) continue;
          el.muted = false;
          el.preservesPitch = false;
          b = { el, assetId: info.clip.assetId, kind: info.kind, clip: info.clip };
          this.bindings.set(clipId, b);
        }
        b.clip = info.clip;
      }
    }

    _syncElements(frame, { seek = false } = {}) {
      const fps = this.fps;
      for (const [clipId, b] of this.bindings) {
        const clip = b.clip;
        const active = frame >= clip.start && frame <= M().clipEnd(clip);
        const track = M().findTrack(this.project, clip.trackId);
        const audible = !!(track && track.kind === 'audio' ? !track.muted && (!M().anySolo(this.project) || track.solo) : !track.muted);
        const audio = this._elementAudio(b.el);
        const p = M().clipParamsAt(clip, frame);
        const fade = OS.renderer.fadeAlpha(clip, frame, fps);
        const fxA = OS.effects.audioGain(p.effects || [], frame - clip.start, clip.length, fps);
        const gain = audible ? clamp(p.volume * fade * fxA, 0, 4) : 0;
        if (audio && audio.gain) audio.gain.gain.setTargetAtTime(gain, this._audio.ctx.currentTime, 0.015);
        if (audio && audio.panner) {
          const pan = audible ? OS.effects.audioPan(p.effects || []) : 0;
          audio.panner.pan.setTargetAtTime(pan, this._audio.ctx.currentTime, 0.02);
        }
        if (audio && audio.eqLow) {
          const eq = clip.audioEq || { low: 0, mid: 0, high: 0 };
          const t = this._audio.ctx.currentTime;
          audio.eqLow.gain.setTargetAtTime(eq.low || 0, t, 0.05);
          audio.eqMid.gain.setTargetAtTime(eq.mid || 0, t, 0.05);
          audio.eqHigh.gain.setTargetAtTime(eq.high || 0, t, 0.05);
        }

        if (!active) {
          if (!b.el.paused) b.el.pause();
          continue;
        }
        const speed = clamp(clip.speed || 1, 0.0625, 16);
        const target = (M().mediaFrameAt(clip, frame) + 0.5) / fps;

        if (this.playing && this.rate > 0) {
          const rate = clamp(speed * this.rate, 0.0625, 16);
          if (Math.abs(b.el.playbackRate - rate) > 0.001) b.el.playbackRate = rate;
          const drift = Math.abs(b.el.currentTime - target);
          if (seek || drift > Math.max(0.09, 2.5 / fps)) {
            try { b.el.currentTime = Math.max(0, target); } catch (e) {}
          }
          if (b.el.paused && !this._reverse) b.el.play().catch(() => {});
          if (!this._reverse && !b.el.paused && this.rate === 1 && speed === 1 && b.el.paused) b.el.pause();
        } else if (this.playing && this.rate < 0) {
          b.el.pause();
          if (seek || this._reverseStep) {
            try { b.el.currentTime = Math.max(0, target); } catch (e) {}
          }
        } else {
          b.el.pause();
          if (seek || Math.abs(b.el.currentTime - target) > 0.5 / fps) {
            try { b.el.currentTime = Math.max(0, target); } catch (e) {}
          }
        }
      }
    }

    /* Seek the master clock to a frame; media elements follow (async, latest wins). */
    async seekTo(frame, opts = {}) {
      const dur = this.duration;
      frame = clamp(Math.round(frame), 0, Math.max(0, dur));
      const wasPlaying = this.playing;
      const rate = this.rate;
      this.pauseInternal();
      this.frameF = frame;
      const token = ++this._seekToken;
      this._bindActive(frame);
      // Seek every bound element in parallel; video seeks gate the rendered frame.
      const fps = this.fps;
      const jobs = [];
      for (const [clipId, b] of this.bindings) {
        const clip = b.clip;
        const target = Math.max(0, (M().mediaFrameAt(clip, frame) + 0.5) / fps);
        if (Math.abs(b.el.currentTime - target) > 0.0005 || b.el.readyState < 1) {
          jobs.push(withTimeout(new Promise((res) => {
            const done = () => { b.el.removeEventListener('seeked', done); b.el.removeEventListener('error', done); res(); };
            b.el.addEventListener('seeked', done);
            b.el.addEventListener('error', done);
            try { b.el.currentTime = target; } catch (e) { res(); }
            if (b.el.readyState >= 2 && Math.abs(b.el.currentTime - target) < 0.001) setTimeout(done, 50);
          }), 4000, 'seek').catch(() => {}));
        }
      }
      await Promise.all(jobs);
      if (token !== this._seekToken) return false; // superseded
      this._needRender = true;
      this.events.emit('time', this.frame);
      if (wasPlaying && opts.resume !== false) this.playInternal(rate || 1);
      return true;
    }

    /* Seek several frames quickly (scrubbing): throttled to the latest request. */
    scrub(frame, opts = {}) {
      this.frameF = clamp(frame, 0, Math.max(0, this.duration));
      if (this._pendingSeek) return this._pendingSeek;
      const run = async () => {
        while (this._pendingSeek === run) {
          const target = Math.round(this.frameF);
          this._bindActive(target);
          await this._seekElementsOnly(target);
          this.events.emit('time', this.frame);
          this._needRender = true;
        }
        this._pendingSeek = null;
      };
      this._pendingSeek = run;
      run();
      return Promise.resolve();
    }

    async _seekElementsOnly(frame) {
      const fps = this.fps;
      const jobs = [];
      for (const [clipId, b] of this.bindings) {
        const clip = b.clip;
        if (frame < clip.start - 1 || frame > M().clipEnd(clip)) { if (!b.el.paused) b.el.pause(); continue; }
        const target = Math.max(0, (M().mediaFrameAt(clip, frame) + 0.5) / fps);
        b.el.pause();
        if (Math.abs(b.el.currentTime - target) > 0.0005) {
          jobs.push(withTimeout(new Promise((res) => {
            const done = () => { b.el.removeEventListener('seeked', done); res(); };
            b.el.addEventListener('seeked', done);
            try { b.el.currentTime = target; } catch (e) { res(); }
          }), 4000, 'seek').catch(() => {}));
        }
      }
      await Promise.all(jobs);
    }

    /* ---------------- transport ---------------- */

    playInternal(rate = 1) {
      const a = this.ensureAudio();
      if (a && a.ctx.state === 'suspended') a.ctx.resume().catch(() => {});
      this.rate = rate;
      this._reverse = rate < 0;
      this.playing = true;
      this._lastNow = performance.now();
      this._bindActive(this.frame);
      this._syncElements(this.frame, { seek: true });
      this.events.emit('state', 'playing');
    }

    pauseInternal() {
      this.playing = false;
      this.rate = 0;
      this._reverse = false;
      for (const [, b] of this.bindings) { if (!b.el.paused) b.el.pause(); }
    }

    pause() { if (!this.playing) return; this.pauseInternal(); this.scrub(this.frame); this.events.emit('state', 'paused'); }
    togglePlay() { this.playing ? this.pause() : this.play(); }

    play(rate = 1) {
      if (!this.project) return;
      const dur = this.duration;
      if (!dur) return;
      if (this.frame >= dur - 1 && rate > 0) this.frameF = this.project.inPoint || 0;
      this.playInternal(rate);
    }

    /* JKL shuttle */
    shuttle(dir) {
      if (dir > 0) {
        if (this.playing && this.rate > 0) {
          const i = SHUTTLE_FWD.indexOf(this.rate);
          const next = SHUTTLE_FWD[Math.min(SHUTTLE_FWD.length - 1, i < 0 ? 0 : i + 1)];
          this.playInternal(next);
        } else if (this.playing && this.rate < 0) this.playInternal(1);
        else this.playInternal(1);
      } else if (dir < 0) {
        if (this.playing && this.rate < 0) {
          const i = SHUTTLE_REV.indexOf(this.rate);
          const next = SHUTTLE_REV[Math.min(SHUTTLE_REV.length - 1, i < 0 ? 0 : i + 1)];
          this.playInternal(next);
        } else this.playInternal(-1);
      } else this.pause();
    }

    stop() { this.pauseInternal(); this.events.emit('state', 'paused'); }

    step(n) {
      this.pause();
      this.seekTo(this.frame + n, { resume: false });
    }

    gotoStart() { this.seekTo(0, { resume: false }); }
    gotoEnd() { this.seekTo(this.duration, { resume: false }); }

    nextEditPoint(dir) {
      const pts = this.project ? M().editPoints(this.project) : [];
      const cur = this.frame;
      if (dir > 0) { const n = pts.find((p) => p > cur + 1); if (n != null) this.seekTo(n, { resume: false }); }
      else { const rev = [...pts].reverse(); const n = rev.find((p) => p < cur - 1); if (n != null) this.seekTo(n, { resume: false }); }
    }

    /* ---------------- main loop ---------------- */

    _tick(now) {
      requestAnimationFrame(this._loop);
      const dt = this._lastNow ? Math.min(250, now - this._lastNow) : 16.7;
      this._lastNow = now;
      this._meter.tick(dt);

      if (this.playing) {
        const fps = this.fps;
        if (this.rate < 0) {
          this._reverseStep = (this._reverseStep || 0) + 1;
          this.frameF = Math.max(0, this.frameF + (dt / 1000) * fps * this.rate);
        } else {
          this.frameF += (dt / 1000) * fps * this.rate;
        }
        const dur = this.duration;
        const inP = this.project && this.project.inPoint ? this.project.inPoint : 0;
        const outP = this.project && this.project.outPoint != null ? this.project.outPoint : dur;
        if (this.frameF >= outP) {
          if (this.loop && outP > inP) {
            this.frameF = inP;
            this._syncElements(this.frame, { seek: true });
          } else {
            this.frameF = Math.max(0, dur);
            this.pauseInternal();
            this.events.emit('state', 'paused');
            this.events.emit('ended');
            this.scrub(this.frame);
          }
        }
        this._bindActive(this.frame);
        this._syncElements(this.frame, { seek: this._reverse ? this._reverseStep % 2 === 0 : false });
        this._reverseStep = 0;
        this._needRender = true;
        this.events.emit('time', this.frame);
      }

      if (this._needRender && this.project) {
        this._needRender = false;
        this.renderNow();
      }
    }

    renderNow() {
      if (!this.project) return;
      const t0 = performance.now();
      try {
        OS.renderer.renderFrame(this.project, this.frame, this.ctx, { scratch: this.scratch, media: this._resolver() });
      } catch (e) {
        console.error('[OpenScene] render error', e);
      }
      this.lastRenderMs = performance.now() - t0;
      // adaptive preview quality (only while playing, and only downgrade)
      if (this.autoQuality && this.playing && this.lastRenderMs > 26 && this.previewScale > 0.26 && this._meter.fps > 0 && this._meter.fps < 24) {
        const steps = [1, 0.5, 0.25];
        const i = steps.indexOf(this.previewScale);
        if (i >= 0 && i < steps.length - 1) { this.setPreviewScale(steps[i + 1]); this.events.emit('quality', this.previewScale); }
      }
    }

    /* Render an arbitrary frame without moving the playhead (used by export still / thumbs). */
    renderStill(frame, ctx, w, h) {
      const scratch = OS.renderer.makeScratch();
      OS.renderer.renderFrame(this.project, frame, ctx, { scratch, media: this._resolver() });
    }

    dispose() {
      this.stop();
      for (const [clipId, b] of this.bindings) this.media.release(b.assetId, clipId, b.kind);
      this.bindings.clear();
      window.removeEventListener('resize', this._onResize);
      if (this._audio) this._audio.ctx.close().catch(() => {});
    }
  }

  OS.player = { Player };
})();
