/* OpenScene — renderer.js
   The compositor. Renders any project frame to a 2D context at project resolution.
   Used by the preview player, transitions, still export and the export pipeline.
   Layers are cached per track to avoid allocations (hot path). */
(() => {
  'use strict';
  const OS = (window.OS = window.OS || {});
  const { clamp } = OS.util;
  const M = () => OS.model;

  function makeScratch() {
    return { layersFast: [], layersSoft: [], trans: OS.transitions.makeScratch(), effectScratch: {} };
  }

  /* Offscreen layer canvases are pooled and reused across tracks.

     Tracks are composited strictly one at a time, so at most two layer surfaces
     are ever live at once: the A and B sides of a transition. The old code kept
     one canvas per track (plus one per transition), which at 16K means roughly
     500 MB for every video track in the project. Reuse keeps the peak at two.

     Two pools rather than one: a canvas's willReadFrequently flag is fixed when
     it first gets a 2D context, and CPU pixel effects need the software pool
     while everything else is faster GPU-backed. */
  function layerAt(scratch, soft, slot, w, h) {
    const pool = soft ? (scratch.layersSoft || (scratch.layersSoft = [])) : (scratch.layersFast || (scratch.layersFast = []));
    let e = pool[slot];
    if (!e) {
      const c = document.createElement('canvas');
      e = pool[slot] = { c, ctx: c.getContext('2d', soft ? { willReadFrequently: true } : {}) };
    }
    if (e.c.width !== w || e.c.height !== h) { e.c.width = w; e.c.height = h; }
    return e;
  }

  function zeroCanvas(c) {
    if (!c || typeof c !== 'object') return;
    if (typeof c.getContext === 'function') { try { c.width = 0; c.height = 0; } catch (e) { /* ignore */ } return; }
    for (const k of Object.keys(c)) zeroCanvas(c[k]);
  }

  /* Release every pooled surface. At 16K one of these is ~500 MB, so the export
     pipeline calls this the moment it is finished with the scratch object. */
  function releaseScratch(scratch) {
    if (!scratch) return;
    for (const pool of [scratch.layersSoft, scratch.layersFast]) {
      if (!pool) continue;
      for (const e of pool) { if (e && e.c) { e.c.width = 0; e.c.height = 0; e.ctx = null; } }
      pool.length = 0;
    }
    zeroCanvas(scratch.adj);
    scratch.adj = null;
    for (const k of Object.keys(scratch.effectScratch || {})) zeroCanvas(scratch.effectScratch[k]);
    scratch.effectScratch = {};
    scratch.tracks = null;
  }

  /* A scratch canvas for the adjustment-layer copy-back, sized in device pixels. */
  function adjScratch(scratch, w, h) {
    let c = scratch.adj;
    if (!c) { c = scratch.adj = document.createElement('canvas'); }
    if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
    return c;
  }

  /* Contain-fit a source of size sw×sh into dw×dh, returning destination rect. */
  function fitRect(sw, sh, dw, dh) {
    if (!sw || !sh) return { x: 0, y: 0, w: dw, h: dh };
    const s = Math.min(dw / sw, dh / sh);
    const w = sw * s, h = sh * s;
    return { x: (dw - w) / 2, y: (dh - h) / 2, w, h };
  }

  /* Draw a clip's media (source or generator) centred, into ctx sized W×H,
     honouring fit + crop. Coordinates are pre-transformed by caller. */
  function drawMedia(lctx, project, clip, mediaFrame, W, H, media) {
    if (clip.generator) {
      if (clip.generator.type === 'title') {
        OS.titles.draw(lctx, W, H, clip.generator.params, mediaFrame, Math.max(1, clip.length), project.fps.rate);
      } else {
        OS.titles.drawColor(lctx, W, H, clip.generator.params);
      }
      return true;
    }
    const asset = media && M().findAsset(project, clip.assetId);
    if (!asset) { drawPlaceholder(lctx, W, H, clip.name || 'Missing media', true); return false; }
    const src = media.get(clip.assetId, clip.id);
    let el = null, sw = 0, sh = 0;
    if (asset.kind === 'image' && src && src.image && src.image.complete && src.image.naturalWidth) {
      el = src.image; sw = el.naturalWidth; sh = el.naturalHeight;
    } else if (asset.kind === 'video' && src && src.video && src.video.readyState >= 2) {
      el = src.video; sw = el.videoWidth; sh = el.videoHeight;
    }
    if (!el) {
      if (asset.missing || (src && src.failed)) drawPlaceholder(lctx, W, H, asset.name, true);
      else drawPlaceholder(lctx, W, H, asset.name, false);
      return false;
    }
    const fit = fitRect(sw, sh, W, H);
    const cr = clip.crop || { l: 0, t: 0, r: 0, b: 0 };
    const sx = sw * cr.l, sy = sh * cr.t;
    const sw2 = Math.max(1, sw * (1 - cr.l - cr.r)), sh2 = Math.max(1, sh * (1 - cr.t - cr.b));
    try {
      lctx.drawImage(el, sx, sy, sw2, sh2, fit.x, fit.y, fit.w, fit.h);
    } catch (e) { drawPlaceholder(lctx, W, H, asset.name, true); return false; }
    return true;
  }

  function drawPlaceholder(ctx, w, h, name, error) {
    ctx.save();
    ctx.fillStyle = error ? '#2a1516' : '#1b1e24';
    ctx.fillRect(0, 0, w, h);
    ctx.strokeStyle = error ? '#7a2c2f' : '#333a45';
    ctx.lineWidth = Math.max(2, w / 480);
    const step = Math.max(24, w / 24);
    ctx.beginPath();
    for (let x = -h; x < w; x += step) { ctx.moveTo(x, 0); ctx.lineTo(x + h, h); }
    ctx.stroke();
    ctx.fillStyle = error ? '#ff8a8a' : '#8b93a3';
    ctx.font = `600 ${Math.max(12, h * 0.07)}px "Segoe UI", sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(name || '', w / 2, h / 2);
    ctx.restore();
  }

  /* Fade in/out envelope (0..1) for a clip at project frame f. */
  function fadeAlpha(clip, frame, fps) {
    const local = frame - clip.start;
    let a = 1;
    if (clip.fadeIn > 0) a = Math.min(a, clamp(local / clip.fadeIn, 0, 1));
    if (clip.fadeOut > 0) a = Math.min(a, clamp((clip.length - local) / clip.fadeOut, 0, 1));
    return a;
  }

  /* Compose one clip into a layer context (project resolution, transparent). */
  function composeClip(lctx, project, clip, frame, W, H, media, opts) {
    const p = M().clipParamsAt(clip, frame);
    const fade = fadeAlpha(clip, frame, project.fps.rate);
    const fxAlpha = OS.effects.opacityAt(p.effects, p.local, clip.length, project.fps.rate);
    const alpha = clamp(p.opacity * fade * fxAlpha, 0, 1);
    const t = p.transform;

    lctx.save();
    if (alpha < 1) lctx.globalAlpha = alpha;
    const fstr = OS.effects.filterString(p.effects);
    if (fstr && fstr !== 'none') lctx.filter = fstr;

    const moved = t.x !== 0 || t.y !== 0 || t.rotation !== 0 || t.scale !== 1;
    if (moved) {
      lctx.translate(W / 2 + t.x * W, H / 2 + t.y * H);
      if (t.rotation) lctx.rotate((t.rotation * Math.PI) / 180);
      if (t.scale !== 1) lctx.scale(t.scale, t.scale);
      lctx.translate(-W / 2, -H / 2);
    }
    drawMedia(lctx, project, clip, p.local, W, H, media);
    lctx.restore();

    if (OS.effects.hasDrawEffect(p.effects)) {
      lctx.save();
      if (alpha < 1) lctx.globalAlpha = alpha;
      OS.effects.applyDrawEffects(lctx, W, H, p.effects, opts && opts.scratchEffects, p.local, project.fps.rate);
      lctx.restore();
    }
    if (OS.effects.hasPixelEffect(p.effects)) {
      OS.effects.applyPixelEffects(lctx, W, H, p.effects, opts && opts.scratchEffects, p.local, project.fps.rate);
    }
    return p;
  }

  /* Apply an adjustment layer's effect stack to everything composited so far.
     Runs in device pixels so the CPU pixel passes and the CSS filters line up
     with whatever scale renderFrame is drawing at. */
  function applyAdjustment(ctx, project, clip, frame, W, H, opts, scratch) {
    const p = M().clipParamsAt(clip, frame);
    const effects = p.effects || [];
    const fstr = OS.effects.filterString(effects);
    const hasFilter = !!fstr && fstr !== 'none';
    const hasDraw = OS.effects.hasDrawEffect(effects);
    const hasPixel = OS.effects.hasPixelEffect(effects);
    const fade = fadeAlpha(clip, frame, project.fps.rate);
    const alpha = clamp(p.opacity * fade * OS.effects.opacityAt(effects, p.local, clip.length, project.fps.rate), 0, 1);
    if (!hasFilter && !hasDraw && !hasPixel) return;
    if (alpha <= 0) return;

    const cw = ctx.canvas.width, ch = ctx.canvas.height;
    if (!cw || !ch) return;

    // snapshot the composite underneath (in device pixels)
    const orig = adjScratch(scratch, cw, ch);
    const octx = orig.getContext('2d');
    octx.setTransform(1, 0, 0, 1, 0, 0);
    octx.clearRect(0, 0, cw, ch);
    octx.drawImage(ctx.canvas, 0, 0);

    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    if (hasFilter) {
      ctx.clearRect(0, 0, cw, ch);
      ctx.filter = fstr;
      ctx.drawImage(orig, 0, 0);
      ctx.filter = 'none';
    }
    if (hasDraw) {
      ctx.save();
      if (alpha < 1) ctx.globalAlpha = alpha;
      OS.effects.applyDrawEffects(ctx, cw, ch, effects, opts && opts.scratchEffects, p.local, project.fps.rate);
      ctx.restore();
    }
    if (hasPixel) {
      OS.effects.applyPixelEffects(ctx, cw, ch, effects, opts && opts.scratchEffects, p.local, project.fps.rate);
    }
    // mix the graded result back over the original with the layer's opacity
    if (alpha < 1) {
      ctx.globalAlpha = 1 - alpha;
      ctx.drawImage(orig, 0, 0);
      ctx.globalAlpha = 1;
    }
    ctx.restore();
    void W; void H;
  }

  /* Which clip owns a frame on a track.

     Normally it is the first clip covering the frame. During a cross-fade it is
     not: the outgoing clip is still covering exactly those frames, so choosing
     it renders the tail of A and the transition can never appear. The incoming
     clip — the one whose transitionIn window contains the frame — wins instead.
     This is why the whole transition library was invisible before: every one of
     the 57 types was drawn into a frame that was then overwritten by A. */
  function clipAtFrame(project, track, frame) {
    const list = M().clipsOf(project, track);
    let first = null;
    for (let i = 0; i < list.length; i++) {
      const c = list[i];
      if (frame < c.start || frame >= M().clipEnd(c)) continue;
      const tin = c.transitionIn;
      if (tin && i > 0 && frame < c.start + tin.length) return c;
      if (!first) first = c;
    }
    return first;
  }

  /* Render a full project frame into ctx (which must be W×H = project size, or scaled). */
  function renderFrame(project, frame, ctx, opts = {}) {
    const W = project.width, H = project.height;
    const media = opts.media || (OS.media && OS.media.instance);
    const scratch = opts.scratch || (opts.scratch = makeScratch());
    // draw/pixel effects need a scratch object of their own for their work canvases
    if (!opts.scratchEffects) opts.scratchEffects = scratch.effectScratch || (scratch.effectScratch = {});
    const cw = ctx.canvas.width, ch = ctx.canvas.height;
    const sx = cw / W, sy = ch / H;

    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, cw, ch);
    ctx.fillStyle = project.backgroundColor || '#000';
    ctx.fillRect(0, 0, cw, ch);
    if (sx !== 1 || sy !== 1) ctx.scale(sx, sy);

    for (let ti = project.tracks.length - 1; ti >= 0; ti--) {
      const track = project.tracks[ti];
      if (track.kind !== 'video' || track.hidden) continue;
      const clip = clipAtFrame(project, track, frame);
      if (!clip) continue;

      // An adjustment layer has no media of its own: it grades what is below it.
      if (clip.adjustment) { applyAdjustment(ctx, project, clip, frame, W, H, opts, scratch); continue; }

      const pNow = M().clipParamsAt(clip, frame);
      const prev = M().prevClip(track, clip);
      const ov = prev ? M().overlapOf(prev, clip) : 0;
      const tin = ov > 0 ? clip.transitionIn : null;
      const inTransition = !!(tin && frame < clip.start + tin.length);

      /* Slot 0 is the composite; slot 1 only exists while a transition needs
         both sides live at once. Both come from the pool (see layerAt), so a
         project with many tracks still only ever holds two full-resolution
         surfaces — which is the difference between working and running out of
         memory at 16K. */
      const softA = OS.effects.hasPixelEffect(M().clipParamsAt(inTransition ? prev : clip, frame).effects);
      const A = layerAt(scratch, softA, 0, W, H);
      const lctx = A.ctx;
      lctx.setTransform(1, 0, 0, 1, 0, 0);
      lctx.globalAlpha = 1;
      lctx.filter = 'none';
      lctx.clearRect(0, 0, W, H);

      if (inTransition) {
        const B = layerAt(scratch, OS.effects.hasPixelEffect(pNow.effects), 1, W, H);
        const bctx = B.ctx;
        bctx.setTransform(1, 0, 0, 1, 0, 0);
        bctx.globalAlpha = 1;
        bctx.filter = 'none';
        bctx.clearRect(0, 0, W, H);
        composeClip(lctx, project, prev, frame, W, H, media, opts);   // A
        composeClip(bctx, project, clip, frame, W, H, media, opts);   // B
        const p = clamp((frame - clip.start) / Math.max(1, tin.length), 0, 1);
        lctx.save();
        lctx.setTransform(1, 0, 0, 1, 0, 0);
        OS.transitions.draw(lctx, W, H, tin.type, p, (c) => c.drawImage(A.c, 0, 0), (c) => c.drawImage(B.c, 0, 0), scratch.trans);
        lctx.restore();
      } else {
        composeClip(lctx, project, clip, frame, W, H, media, opts);
      }
      const op = M().blendOp(clip.blend);
      if (op === 'source-over') {
        ctx.drawImage(A.c, 0, 0, W, H);
      } else {
        ctx.save();
        ctx.globalCompositeOperation = op;
        ctx.drawImage(A.c, 0, 0, W, H);
        ctx.restore();
      }
    }
    ctx.restore();
  }

  /* Render a single clip standalone (used by bin thumbnails and clip preview). */
  function renderClipPreview(project, clip, frame, ctx, W, H, media, scratch) {
    scratch = scratch || makeScratch();
    const effects = M().clipParamsAt(clip, frame).effects;
    const A = layerAt(scratch, OS.effects.hasPixelEffect(effects), 0, W, H);
    const lctx = A.ctx;
    lctx.setTransform(1, 0, 0, 1, 0, 0);
    lctx.globalAlpha = 1;
    lctx.filter = 'none';
    lctx.clearRect(0, 0, W, H);
    const fx = scratch.effectScratch || (scratch.effectScratch = {});
    composeClip(lctx, project, clip, frame, W, H, media, { scratchEffects: fx });
    ctx.drawImage(A.c, 0, 0);
  }

  OS.renderer = { makeScratch, releaseScratch, fitRect, drawMedia, drawPlaceholder, composeClip, applyAdjustment, renderFrame, renderClipPreview, fadeAlpha };
})();
