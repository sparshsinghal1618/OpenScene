/* OpenScene — model.js
   Project data model: assets, tracks, clips, effects, keyframes, markers.
   Times are integer frames at project fps. Media times account for clip speed. */
(() => {
  'use strict';
  const OS = (window.OS = window.OS || {});
  const { uid, clamp, deepClone } = OS.util;

  const VERSION = 1;
  const MIN_CLIP_FRAMES = 1;

  /* ---------- blend modes ---------- */
  /* name -> canvas globalCompositeOperation. Every one of these is part of the
     portable 2D canvas spec, so the same list drives preview, still export and
     the encoder path identically. */
  const BLEND_MODES = [
    ['normal', 'Normal', 'source-over'],
    ['multiply', 'Multiply', 'multiply'],
    ['screen', 'Screen', 'screen'],
    ['overlay', 'Overlay', 'overlay'],
    ['darken', 'Darken', 'darken'],
    ['lighten', 'Lighten', 'lighten'],
    ['color-dodge', 'Color Dodge', 'color-dodge'],
    ['color-burn', 'Color Burn', 'color-burn'],
    ['hard-light', 'Hard Light', 'hard-light'],
    ['soft-light', 'Soft Light', 'soft-light'],
    ['difference', 'Difference', 'difference'],
    ['exclusion', 'Exclusion', 'exclusion'],
    ['add', 'Add (Linear Dodge)', 'lighter'],
    ['hue', 'Hue', 'hue'],
    ['saturation', 'Saturation', 'saturation'],
    ['color', 'Color', 'color'],
    ['luminosity', 'Luminosity', 'luminosity'],
  ];
  const BLEND_LABEL = {};
  const BLEND_OP = {};
  for (const [id, label, op] of BLEND_MODES) { BLEND_LABEL[id] = label; BLEND_OP[id] = op; }
  const blendOp = (name) => BLEND_OP[name] || 'source-over';
  const blendLabel = (name) => BLEND_LABEL[name] || 'Normal';

  /* ---------- factories ---------- */

  function createProject(opts = {}) {
    return {
      version: VERSION,
      name: opts.name || 'Untitled Project',
      fps: opts.fps || OS.timebase.fps(30, 1),
      width: opts.width || 1920,
      height: opts.height || 1080,
      sampleRate: opts.sampleRate || 48000,
      backgroundColor: opts.backgroundColor || '#000000',
      tracks: [
        createTrack('video', 'V2'),
        createTrack('video', 'V1'),
        createTrack('audio', 'A1'),
        createTrack('audio', 'A2'),
      ],
      markers: [],
      assets: [],
      inPoint: null,
      outPoint: null,
      createdAt: Date.now(),
      modifiedAt: Date.now(),
    };
  }

  function createTrack(kind, name, after = {}) {
    return {
      id: uid('trk'), kind, name,
      height: after.height || (kind === 'video' ? 76 : 60),
      muted: false, solo: false, locked: false, hidden: false,
    };
  }

  function createAsset(meta) {
    return {
      id: uid('ast'),
      name: meta.name || 'Media',
      kind: meta.kind, // video | audio | image
      width: meta.width || 0,
      height: meta.height || 0,
      durationFrames: meta.durationFrames || 0,
      fps: meta.fps || null,          // source fps if known
      hasAudio: !!meta.hasAudio,
      hasVideo: meta.kind !== 'audio',
      bytes: meta.bytes || 0,
      type: meta.type || '',
      thumb: meta.thumb || null,      // data URL
      undecodable: !!meta.undecodable, // container understood, codec unsupported here
      fileKey: meta.fileKey || null,  // IndexedDB key for the raw File (persistence)
      filePath: meta.filePath || null, // native host absolute path for direct streaming
      missing: false,
      origin: meta.origin || 'import',
    };
  }

  function createClip(asset, trackId, start, length, inPoint = 0) {
    return {
      id: uid('clp'),
      assetId: asset ? asset.id : null,
      name: asset ? asset.name : 'Clip',
      trackId,
      start: Math.max(0, Math.round(start)),
      length: Math.max(MIN_CLIP_FRAMES, Math.round(length)),
      inPoint: Math.max(0, Math.round(inPoint)),
      speed: 1,
      reverse: false,
      volume: 1,
      fadeIn: 0,
      fadeOut: 0,
      opacity: 1,
      blend: 'normal',      // canvas composite operation against the tracks below
      adjustment: false,    // true: applies its effect stack to the composite below
      groupId: null,        // clips sharing a groupId move, trim and delete together
      audioEq: { low: 0, mid: 0, high: 0 },   // per-clip shelving/peaking EQ, in dB
      transform: { x: 0, y: 0, scale: 1, rotation: 0 },
      crop: { l: 0, t: 0, r: 0, b: 0 },
      effects: [],
      keyframes: {},        // 'param.path' -> [{frame (clip-relative), value, interp}]
      transitionIn: null,   // { type, length } — overlap transition from previous clip on same track
      generator: null,      // { type:'title'|'color'|'gradient', params:{...} }
      label: '',
      colorTag: null,
    };
  }

  function createGeneratorClip(kind, trackId, start, length, params = {}) {
    const c = createClip(null, trackId, start, length);
    c.name = params.name || (kind === 'title' ? 'Title' : kind === 'gradient' ? 'Gradient' : 'Color');
    // The colour/gradient painter reads its mode from params.type, so seed it
    // here rather than at every call site (the inspector edits the same field).
    const gp = (kind === 'color' || kind === 'gradient')
      ? { type: kind === 'gradient' ? 'gradient' : 'solid', ...params }
      : params;
    c.generator = { type: kind, params: gp };
    return c;
  }

  /* An adjustment layer carries no media: its effect stack is applied to
     everything composited beneath it, exactly like a colour-grading layer-up. */
  function createAdjustmentClip(trackId, start, length, params = {}) {
    const c = createClip(null, trackId, start, length);
    c.name = params.name || 'Adjustment';
    c.adjustment = true;
    return c;
  }

  function createEffect(type, params) {
    const reg = OS.effects && OS.effects.registry ? OS.effects.registry[type] : null;
    // A misspelt effect id used to produce a silent no-op; say so instead.
    if (OS.effects && OS.effects.registry && !reg) console.warn('createEffect: unknown effect type "' + type + '"');
    return { id: uid('fx'), type, params: { ...(reg ? reg.defaultParams : {}), ...(params || {}) }, enabled: true };
  }

  /* ---------- lookups ---------- */

  const findTrack = (p, id) => p.tracks.find((t) => t.id === id) || null;
  const findClip = (p, id) => {
    for (const t of p.tracks) { const c = t.clips ? t.clips.find((c) => c.id === id) : null; if (c) return c; }
    return null;
  };
  const findAsset = (p, id) => p.assets.find((a) => a.id === id) || null;
  const trackOf = (p, clip) => findTrack(p, clip.trackId);
  const clipEnd = (c) => c.start + c.length;

  /* Media time (frames, in source timeline) for a clip at project frame f. */
  function mediaFrameAt(clip, f) {
    const local = f - clip.start;
    const eff = local * (clip.speed || 1);
    return clip.reverse ? clip.inPoint + (clip.length - 1 - eff) : clip.inPoint + eff;
  }

  function clipsOf(p, track) { return (track.clips = track.clips || []); }

  /* All clips overlapping [start, end) on a track. */
  function clipsBetween(p, track, start, end) {
    return clipsOf(p, track).filter((c) => c.start < end && clipEnd(c) > start);
  }

  /* Clips visible at a frame, per track (bottom-to-top compositing order). */
  function activeClipsAt(p, frame) {
    const out = [];
    for (let i = p.tracks.length - 1; i >= 0; i--) {
      const t = p.tracks[i];
      if (t.kind !== 'video') continue;
      const c = clipsOf(p, t).find((c) => frame >= c.start && frame < clipEnd(c));
      if (c) out.push(c);
    }
    return out;
  }

  /* Active audio clips at frame (all audio tracks, honouring solo/mute). */
  function activeAudioClipsAt(p, frame) {
    const solo = p.tracks.some((t) => t.kind === 'audio' && t.solo);
    const out = [];
    for (const t of p.tracks) {
      if (t.kind !== 'audio') continue;
      if (t.muted || (solo && !t.solo)) continue;
      const c = clipsOf(p, t).find((c) => frame >= c.start && frame < clipEnd(c));
      if (c) out.push(c);
    }
    return out;
  }

  const anySolo = (p) => p.tracks.some((t) => t.solo);

  /* ---------- editing primitives (pure model ops — UI goes through commands) ---------- */

  function insertClip(p, clip) {
    const t = findTrack(p, clip.trackId);
    if (!t) throw new Error('insertClip: unknown track ' + clip.trackId);
    clip.trackId = t.id;
    clipsOf(p, t).push(clip);
    sortClips(t);
    return clip;
  }

  function removeClip(p, clip) {
    const t = findTrack(p, clip.trackId);
    if (!t) return false;
    const i = clipsOf(p, t).indexOf(clip);
    if (i < 0) return false;
    clipsOf(p, t).splice(i, 1);
    return true;
  }

  function sortClips(track) { clipsOf({ tracks: [track] }, track).sort((a, b) => a.start - b.start || a.id.localeCompare(b.id)); }

  /* Overlap of B onto A (frames), or 0. */
  const overlapOf = (a, b) => Math.max(0, Math.min(clipEnd(a), clipEnd(b)) - Math.max(a.start, b.start));

  /* The clip immediately preceding `clip` on its track (by start). */
  function prevClip(track, clip) {
    const list = clipsOf({ tracks: [track] }, track);
    const i = list.indexOf(clip);
    return i > 0 ? list[i - 1] : null;
  }

  /* Ensure a clip has a transitionIn entry if it overlaps its predecessor. */
  function syncTransitions(track) {
    const list = clipsOf({ tracks: [track] }, track);
    for (let i = 0; i < list.length; i++) {
      const c = list[i], prev = i > 0 ? list[i - 1] : null;
      const ov = prev ? overlapOf(prev, c) : 0;
      if (ov > 0 && c.transitionIn && c.transitionIn.length > ov) c.transitionIn.length = ov;
    }
  }

  /* Clamp transition lengths after any edit. */
  function normalizeTransitions(p) {
    for (const t of p.tracks) {
      const list = clipsOf(p, t);
      for (let i = 1; i < list.length; i++) {
        const c = list[i], prev = list[i - 1];
        const ov = overlapOf(prev, c);
        if (ov <= 0) { if (c.transitionIn) c.transitionIn = null; continue; }
        if (!c.transitionIn) continue;
        c.transitionIn.length = clamp(c.transitionIn.length || ov, 1, ov);
      }
    }
  }

  /* ---------- keyframes ---------- */

  function keyframeList(clip, path, create = false) {
    if (!clip.keyframes[path] && create) clip.keyframes[path] = [];
    return clip.keyframes[path] || null;
  }

  function hasKeyframes(clip, path) { const k = clip.keyframes[path]; return !!(k && k.length); }

  function setKeyframe(clip, path, frame, value) {
    const list = keyframeList(clip, path, true);
    const f = Math.max(0, Math.min(clip.length - 1, Math.round(frame)));
    const existing = list.find((k) => k.frame === f);
    if (existing) { existing.value = value; return existing; }
    const kf = { frame: f, value, interp: 'linear' };
    list.push(kf);
    list.sort((a, b) => a.frame - b.frame);
    return kf;
  }

  function removeKeyframe(clip, path, frame) {
    const list = keyframeList(clip, path);
    if (!list) return false;
    const i = list.findIndex((k) => k.frame === frame);
    if (i < 0) return false;
    list.splice(i, 1);
    if (!list.length) delete clip.keyframes[path];
    return true;
  }

  function keyframeAt(clip, path, frame) {
    const list = keyframeList(clip, path);
    return list ? list.find((k) => k.frame === frame) : null;
  }

  /* Interpolated value of a keyframed parameter at a CLIP-RELATIVE frame. */
  function evalKeyframes(clip, path, frame, fallback) {
    const list = keyframeList(clip, path);
    if (!list || !list.length) return fallback;
    if (list.length === 1 || frame <= list[0].frame) return list[0].value;
    const last = list[list.length - 1];
    if (frame >= last.frame) return last.value;
    for (let i = 0; i < list.length - 1; i++) {
      const a = list[i], b = list[i + 1];
      if (frame >= a.frame && frame <= b.frame) {
        if (a.interp === 'hold' || b.frame === a.frame) return a.value;
        const t = (frame - a.frame) / (b.frame - a.frame);
        return typeof a.value === 'number' && typeof b.value === 'number' ? a.value + (b.value - a.value) * t : t < 0.5 ? a.value : b.value;
      }
    }
    return last.value;
  }

  /* Convenience: value of a keyframed parameter for a clip at a PROJECT frame. */
  function evalAt(clip, projectFrame, path, fallback) {
    if (!hasKeyframes(clip, path)) return fallback;
    const local = clamp(projectFrame - clip.start, 0, Math.max(0, clip.length - 1));
    return evalKeyframes(clip, path, local, fallback);
  }

  /* ---------- clip property access with keyframe support ---------- */
  /* Returns effective property values for a clip at a project frame. */
  function clipParamsAt(clip, frame) {
    const local = clamp(frame - clip.start, 0, Math.max(0, clip.length - 1));
    const kf = (path, def) => (hasKeyframes(clip, path) ? evalKeyframes(clip, path, local, def) : def);
    const t = clip.transform;
    const transform = {
      x: kf('transform.x', t.x), y: kf('transform.y', t.y),
      scale: kf('transform.scale', t.scale), rotation: kf('transform.rotation', t.rotation),
    };
    const opacity = kf('opacity', clip.opacity);
    const volume = kf('volume', clip.volume);
    const effects = clip.effects.map((fx) => {
      if (!OS.effects) return fx;
      const reg = OS.effects.registry[fx.type];
      if (!reg) return fx;
      const params = { ...fx.params };
      for (const key of Object.keys(params)) {
        const path = `fx.${fx.id}.${key}`;
        if (hasKeyframes(clip, path)) params[key] = evalKeyframes(clip, path, local, params[key]);
      }
      return { ...fx, params };
    });
    return { local, transform, opacity, volume, effects };
  }

  /* ---------- grouping ---------- */

  /* Every clip that shares `clip`'s group (or just the clip itself). */
  function groupMembers(p, clip) {
    if (!clip.groupId) return [clip];
    const out = [];
    for (const t of p.tracks) for (const c of clipsOf(p, t)) if (c.groupId === clip.groupId) out.push(c);
    return out;
  }

  /* All clips on a track belonging to the same group as `clip`. */
  function groupPeers(track, clip) {
    if (!clip.groupId) return [clip];
    return clipsOf({ tracks: [track] }, track).filter((c) => c.groupId === clip.groupId);
  }

  /* ---------- project-level helpers ---------- */

  function projectDuration(p) {
    let end = 0;
    for (const t of p.tracks) for (const c of clipsOf(p, t)) end = Math.max(end, clipEnd(c));
    return end;
  }

  function frameToSec(p, f) { return OS.timebase.framesToSeconds(f, p.fps); }
  function secToFrame(p, s) { return OS.timebase.secondsToFrames(s, p.fps); }

  /* Every clip edge (starts and ends) — used for snapping and edit-point navigation. */
  function editPoints(p) {
    const pts = new Set([0]);
    for (const t of p.tracks) for (const c of clipsOf(p, t)) { pts.add(c.start); pts.add(clipEnd(c)); }
    for (const m of p.markers) pts.add(m.frame);
    return [...pts].sort((a, b) => a - b);
  }

  /* ---------- validation (used by self-test and after deserialize) ---------- */

  function validate(p) {
    const errors = [];
    if (!p || typeof p !== 'object') return ['not an object'];
    if (p.version > VERSION) errors.push(`project version ${p.version} is newer than supported ${VERSION}`);
    const trackIds = new Set();
    for (const t of p.tracks || []) {
      if (trackIds.has(t.id)) errors.push(`duplicate track id ${t.id}`);
      trackIds.add(t.id);
      for (const c of t.clips || []) {
        if (c.trackId !== t.id) errors.push(`clip ${c.id} trackId mismatch`);
        if (!(c.length >= MIN_CLIP_FRAMES)) errors.push(`clip ${c.id} has zero/negative length`);
        if (c.start < 0) errors.push(`clip ${c.id} starts before0`);
        const ov = overlapOf(c, clipsOf(p, t).find((o) => o !== c && o.start < clipEnd(c) && clipEnd(o) > c.start) || {});
        if (ov > 0 && !c.transitionIn && !clipsOf(p, t).find((o) => o !== c && o.start < clipEnd(c) && clipEnd(o) > c.start && o.transitionIn)) {
          errors.push(`untransitioned overlap at clip ${c.id}`);
        }
      }
    }
    for (const c of p.tracks.flatMap((t) => t.clips || [])) {
      if (c.assetId && !findAsset(p, c.assetId)) errors.push(`clip ${c.id} references missing asset ${c.assetId}`);
    }
    return errors;
  }

  /* ---------- (de)serialisation ---------- */

  function serialize(p) {
    const out = deepClone(p);
    out.appVersion = OS.app ? OS.app.VERSION : 'dev';
    out.modifiedAt = Date.now();
    return JSON.stringify(out, null, 1);
  }

  function deserialize(json) {
    const p = typeof json === 'string' ? JSON.parse(json) : deepClone(json);
    p.version = p.version || VERSION;
    p.fps = p.fps && p.fps.num ? p.fps : OS.timebase.fps(30, 1);
    p.tracks = p.tracks || [];
    for (const t of p.tracks) {
      t.clips = t.clips || [];
      t.height = t.height || (t.kind === 'video' ? 76 : 60);
      for (const c of t.clips) {
        c.effects = c.effects || [];
        c.keyframes = c.keyframes || {};
        c.transform = { x: 0, y: 0, scale: 1, rotation: 0, ...(c.transform || {}) };
        c.crop = { l: 0, t: 0, r: 0, b: 0, ...(c.crop || {}) };
        c.speed = c.speed || 1;
        c.volume = c.volume == null ? 1 : c.volume;
        c.opacity = c.opacity == null ? 1 : c.opacity;
        c.blend = BLEND_OP[c.blend] ? c.blend : 'normal';
        c.adjustment = !!c.adjustment;
        c.groupId = c.groupId || null;
        c.audioEq = { low: 0, mid: 0, high: 0, ...(c.audioEq || {}) };
        c.fadeIn = c.fadeIn || 0; c.fadeOut = c.fadeOut || 0;
        c.length = Math.max(MIN_CLIP_FRAMES, c.length | 0);
      }
      t.clips.sort((a, b) => a.start - b.start);
    }
    p.markers = p.markers || [];
    p.assets = p.assets || [];
    p.sampleRate = p.sampleRate || 48000;
    p.backgroundColor = p.backgroundColor || '#000000';
    normalizeTransitions(p);
    const errs = validate(p);
    if (errs.length) console.warn('[OpenScene] project validation:', errs);
    return p;
  }

  OS.model = {
    VERSION, MIN_CLIP_FRAMES, BLEND_MODES, blendOp, blendLabel,
    createProject, createTrack, createAsset, createClip, createGeneratorClip, createAdjustmentClip, createEffect,
    findTrack, findClip, findAsset, trackOf, clipEnd, clipsOf, clipsBetween,
    activeClipsAt, activeAudioClipsAt, anySolo, mediaFrameAt,
    insertClip, removeClip, sortClips, overlapOf, prevClip, syncTransitions, normalizeTransitions,
    groupMembers, groupPeers,
    keyframeList, hasKeyframes, setKeyframe, removeKeyframe, keyframeAt, evalKeyframes, evalAt, clipParamsAt,
    projectDuration, frameToSec, secToFrame, editPoints, validate, serialize, deserialize,
  };
})();
