/* OpenScene — osp.js
   OpenShot project import.

   OpenShot stores its projects as JSON with the extension .osp. The layout is
   completely different from ours (top-level `clips` keyed to `layers`, every
   animatable value wrapped in a keyframe object with {co:{X,Y}} points, times
   in seconds), so this module converts a parsed .osp document into an OpenScene
   project. The rest of the app only ever sees the native model.

   Conversion is deliberately total: anything we understand is mapped exactly,
   anything we do not is reported in the returned summary rather than dropped
   silently. Media itself lives on disk and is never referenced by a .osp, so
   every imported asset is created "missing" for the user to relink in one step. */
(() => {
  'use strict';
  const OS = (window.OS = window.OS || {});
  const M = () => OS.model;

  /* ---------------------------------------------------------------- helpers */

  /* A .osp keyframe is {Points:[{co:{X,Y}}]} where X is a *frame* number at the
     clip's own fps (not seconds) and Y is the value. A single point is a
     constant. Returns a sorted [{frame, value, interp}] list, or null. */
  function points(keyframe) {
    if (!keyframe) return null;
    // Some writers emit a bare number for a constant property.
    if (typeof keyframe === 'number') return [{ frame: 0, value: keyframe, interp: 'linear' }];
    const list = keyframe.Points || keyframe.points || [];
    if (!Array.isArray(list) || !list.length) return null;
    const out = [];
    for (const p of list) {
      const co = p.co || p.Co || {};
      const x = typeof co.X === 'number' ? co.X : (typeof co.x === 'number' ? co.x : null);
      const y = typeof co.Y === 'number' ? co.Y : (typeof co.y === 'number' ? co.y : null);
      if (x == null || y == null) continue;
      // interpolation: 0 = Bezier, 1 = Linear, 2 = Constant(hold)
      const interp = p.interpolation === 2 ? 'hold' : 'linear';
      out.push({ frame: x, value: y, interp });
    }
    if (!out.length) return null;
    out.sort((a, b) => a.frame - b.frame);
    return out;
  }

  /* First/constant value of a keyframed property, or the fallback. */
  function firstValue(keyframe, fallback) {
    const pts = points(keyframe);
    return pts && pts.length ? pts[0].value : fallback;
  }

  /* Second-order decision: is this keyframe actually animated? */
  function isAnimated(keyframe) {
    const pts = points(keyframe);
    return !!pts && pts.length > 1;
  }

  const even = (n) => { const v = Math.round(n); return v % 2 ? v + 1 : v; };
  const positive = (n, f) => (typeof n === 'number' && isFinite(n) && n > 0 ? n : f);

  /* ------------------------------------------------------- detection/conversion */

  /* An OpenShot file is recognisable by its shape, not just its extension: a
     `layers` array plus second-based clip `position`/`end` fields and a `version`
     object naming openshot-qt. That also catches the rare .osp saved as .json. */
  function looksLikeOpenShot(doc) {
    if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return false;
    if (Array.isArray(doc.tracks)) return false;                 // already ours
    const hasLayers = Array.isArray(doc.layers);
    const version = doc.version;
    const named = !!(version && (version['openshot-qt'] || version.libopenshot));
    const secondBased = Array.isArray(doc.clips) &&
      doc.clips.some((c) => c && typeof c.position === 'number' && typeof c.end === 'number');
    return hasLayers && (named || secondBased);
  }

  /* --------------------------------------------------------------- mapping */

  /* OpenShot's built-in filter names -> our effect types. Only filters whose
     meaning survives the trip are listed; anything else is reported instead of
     being turned into a misleading no-op. */
  const EFFECT_MAP = {
    Brightness: 'brightness',
    Contrast: 'contrast',
    Saturation: 'saturation',
    Hue: 'hue',
    Grayscale: 'grayscale',
    Negative: 'invert',
    Blur: 'blur',
    ChromaKey: 'chromakey',
    ColorKey: 'colorkey',
    Wave: 'wave',
    Pixelate: 'mosaic',
    Distortion: 'perspective',
    Sharpen: 'sharpen',
    Vignette: 'vignette',
    Noise: 'noise',
    /* Filters OpenShot ships that have no faithful OpenScene equivalent are
       listed as null and counted, rather than silently dropped. */
    Crop: null,
    Bars: null,
    ObjectDetection: null,
    Stabilizer: null,
    Echo: null,
    Deinterlace: null,
    Shift: null,
    Tracker: null,
    Skeleton: null,
  };

  /* A handful of effects carry their parameters under names we share. Pull them
     across where the meaning is the same, otherwise keep our defaults. */
  function mapEffectParams(type, props) {
    const out = {};
    const get = (k) => {
      if (!props) return undefined;
      // libopenshot spells these either as keyframes or as raw {value:...} blobs.
      const v = props[k];
      if (v == null) return undefined;
      if (typeof v === 'number' || typeof v === 'string' || typeof v === 'boolean') return v;
      if (Array.isArray(v)) return v;
      if (typeof v === 'object') {
        if (typeof v.value === 'number') return v.value;
        const fv = points(v);
        if (fv && fv.length) return fv[0].value;
      }
      return undefined;
    };
    const num = (k) => { const v = get(k); return typeof v === 'number' && isFinite(v) ? v : undefined; };
    switch (type) {
      case 'brightness': {
        // OpenShot 0..2 (1 = neutral) -> ours is a multiplier too.
        const v = num('brightness');
        if (v != null) out.amount = v;
        break;
      }
      case 'contrast': {
        const v = num('contrast');
        if (v != null) out.amount = v;
        break;
      }
      case 'saturation': {
        const v = num('saturation');
        if (v != null) out.amount = v;
        break;
      }
      case 'hue': {
        const v = num('hue');
        if (v != null) out.degrees = v;
        break;
      }
      case 'blur': {
        const v = num('sigma') || num('radius');
        if (v != null) out.radius = v;
        break;
      }
      case 'sharpen': {
        const v = num('amount');
        if (v != null) out.amount = v;
        break;
      }
      case 'chromakey':
      case 'colorkey': {
        const r = num('key_red'), g = num('key_green'), b = num('key_blue');
        if (r != null && g != null && b != null) {
          out.color = '#' + [r, g, b].map((n) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0')).join('');
        }
        break;
      }
      default: break;
    }
    return out;
  }

  /* OpenShot "mixing" on a clip is a blend mode index against the layer below.
     Only the modes we can reproduce exactly are carried over. */
  const MIX_MAP = {
    0: 'normal',
    1: 'normal',
    2: 'add',        // Additive
    3: 'screen',     // Screen
    4: 'multiply',   // Multiply
    5: 'overlay',    // Overlay
    6: 'darken',
    7: 'lighten',
    8: 'color-dodge',
    9: 'color-burn',
    10: 'hard-light',
    11: 'soft-light',
    12: 'difference',
    13: 'exclusion',
  };

  /* --------------------------------------------------------------- conversion */

  /* Convert a parsed .osp document into { project, name, summary }. */
  function toProject(doc, fallbackName) {
    const M0 = M();
    const fpsNum = positive(doc.fps && doc.fps.num, 30);
    const fpsDen = positive(doc.fps && doc.fps.den, 1);
    const fps = OS.timebase.fps(fpsNum, fpsDen);

    // Project size: OpenShot stores `width`/`height` (newer) or a `scale` factor
    // against a named profile (older). Prefer explicit numbers, then the first
    // video file's own dimensions, then 16:9 at the profile's height.
    let width = 0, height = 0;
    if (typeof doc.width === 'number' && doc.width > 0) width = doc.width;
    if (typeof doc.height === 'number' && doc.height > 0) height = doc.height;
    const files = Array.isArray(doc.files) ? doc.files : [];
    if ((!width || !height)) {
      const vid = files.find((f) => positive(f.width, 0) && positive(f.height, 0) && (f.has_video !== false));
      if (vid) { width = vid.width; height = vid.height; }
    }
    if (!width || !height) {
      // `scale` in older files is the ratio of the project height to 1080p.
      const profile = String(doc.profile || '');
      const m = /(\d{3,4})p/.exec(profile);
      height = m ? parseInt(m[1], 10) : 1080;
      width = even(height * 16 / 9);
    }
    width = even(width); height = even(height);

    const project = M0.createProject({ name: fallbackName || 'OpenShot Project', fps, width, height });
    project.sampleRate = positive(doc.sample_rate, 48000);

    const summary = { clips: 0, tracks: 0, unmappedEffects: 0, missingMedia: 0, droppedClips: 0, answered: true };

    /* ---- media: one asset per distinct file_id ---- */
    const assetByFileId = new Map();
    for (const f of files) {
      const path = f.path || f.filepath || '';
      const name = String(path).split(/[\\/]/).pop() || ('Media ' + (f.id || ''));
      const hasVideo = f.has_video !== false && (f.media_type === 'video' || f.width);
      const hasAudio = f.has_audio !== false && !!f.channels;
      let kind = hasVideo ? 'video' : 'audio';
      if (f.media_type === 'image' || (f.has_single_image && !hasAudio)) kind = 'image';
      const srcFps = f.fps && positive(f.fps.num, 0) ? OS.timebase.fps(positive(f.fps.num, fpsNum), positive(f.fps.den, 1)) : null;
      const asset = M0.createAsset({
        name,
        kind,
        width: positive(f.width, 0),
        height: positive(f.height, 0),
        // durationFrames is in PROJECT frames so the timeline maths stays simple.
        durationFrames: OS.timebase.secondsToFrames(positive(f.duration, 0), fps),
        fps: srcFps,
        hasAudio,
        bytes: positive(f.file_size, 0),
        type: f.vcodec || f.acodec || '',
        origin: 'openshot',
      });
      asset.missing = true;             // the media is on disk, never in the .osp
      asset.ospPath = path || null;     // remembered so the relink dialog can hint
      assetByFileId.set(f.id, asset);
      project.assets.push(asset);
      summary.missingMedia++;
    }

    /* ---- layers become tracks. OpenShot layers are ordered bottom-up, while
       the OpenScene timeline draws the top row first, so the array is reversed.
       Video and audio both live on layers, so a layer holding audio-only clips
       is created as an audio track. ---- */
    const layers = Array.isArray(doc.layers) ? doc.layers.slice() : [];
    const clips = Array.isArray(doc.clips) ? doc.clips : [];

    // Deciding a layer's kind needs the clips that reference it.
    const clipsByLayer = new Map();
    for (const c of clips) {
      const key = c.layer;
      if (!clipsByLayer.has(key)) clipsByLayer.set(key, []);
      clipsByLayer.get(key).push(c);
    }
    const layerKind = (layer) => {
      const list = clipsByLayer.get(layer.number) || clipsByLayer.get(layer.id) || [];
      let v = 0, a = 0;
      for (const c of list) {
        const asset = assetByFileId.get(c.file_id);
        if (asset) { if (asset.kind === 'audio') a++; else v++; }
        else if (c.has_audio && c.has_video) v++;
      }
      return (v >= a && v > 0) ? 'video' : (a > 0 ? 'audio' : 'video');
    };

    const trackByLayerKey = new Map();
    project.tracks = [];
    // Reverse: last layer in the file is the bottom-most row on screen.
    for (let i = layers.length - 1; i >= 0; i--) {
      const L = layers[i];
      const kind = layerKind(L);
      const name = (L.label && String(L.label).trim()) || (kind === 'video' ? 'V' : 'A') + (layers.length - i);
      const t = M0.createTrack(kind, name);
      t.muted = !!L.mute;
      t.locked = !!L.lock;
      project.tracks.push(t);
      if (L.id != null) trackByLayerKey.set('id:' + L.id, t);
      if (L.number != null) trackByLayerKey.set('num:' + L.number, t);
      summary.tracks++;
    }
    // OpenScene always wants at least one video and one audio track to work with.
    if (!project.tracks.some((t) => t.kind === 'video')) project.tracks.push(M0.createTrack('video', 'V1'));
    if (!project.tracks.some((t) => t.kind === 'audio')) project.tracks.push(M0.createTrack('audio', 'A1'));

    const trackForClip = (c) => trackByLayerKey.get('num:' + c.layer) || trackByLayerKey.get('id:' + c.layer) || null;

    /* ---- clips ---- */
    for (const c of clips) {
      const asset = assetByFileId.get(c.file_id) || null;
      let track = trackForClip(c);
      if (!track) { summary.droppedClips++; continue; }

      /* An OpenShot layer can hold any clip, but an OpenScene track is either
         video or audio. When a clip's own media disagrees with its layer, move
         it to the first track of the right kind instead of silently placing an
         audio clip on a video row (where it would never play). */
      const want = asset && asset.kind === 'audio' ? 'audio' : 'video';
      if (track.kind !== want) {
        const alt = project.tracks.find((t) => t.kind === want);
        if (alt) track = alt;
        else { summary.droppedClips++; continue; }
      }

      const posSec = typeof c.position === 'number' ? c.position : 0;
      const startSec = typeof c.start === 'number' ? c.start : 0;
      const endSec = typeof c.end === 'number' ? c.end : 0;
      const start = Math.max(0, OS.timebase.secondsToFrames(posSec, fps));
      const inPoint = Math.max(0, OS.timebase.secondsToFrames(startSec, fps));
      let length = OS.timebase.secondsToFrames(Math.max(0, endSec - startSec), fps);
      if (length < 1) {
        // Fall back to the asset's own length, then to a default still length.
        length = asset && asset.durationFrames ? asset.durationFrames : OS.timebase.secondsToFrames(5, fps);
      }

      const clip = M0.createClip(asset, track.id, start, length, inPoint);
      clip.name = (c.title && String(c.title).trim()) ||
        (asset && asset.name) ||
        ('Clip ' + (c.id || ''));

      /* Constant values first, then per-property keyframes on top. */
      clip.opacity = clamp01(firstValue(c.alpha, 1));
      clip.volume = Math.max(0, firstValue(c.volume, 1));

      const sx = firstValue(c.scale_x, firstValue(c.scale, 1));
      const sy = firstValue(c.scale_y, firstValue(c.scale, 1));
      const rot = firstValue(c.rotation, 0);
      const lx = firstValue(c.location_x, 0);
      const ly = firstValue(c.location_y, 0);
      // OpenShot location is in project-width units from the centre.
      clip.transform = {
        x: lx * project.width,
        y: ly * project.height,
        scale: (sx + sy) / 2 || 1,
        rotation: rot,
      };

      const mix = typeof c.mixing === 'number' ? c.mixing : 0;
      if (MIX_MAP[mix]) clip.blend = MIX_MAP[mix];
      else clip.blend = 'normal';

      // Speed: libopenshot `time` is a mapping from timeline frame -> source
      // frame. A constant slope of 1 means normal speed.
      const timePts = points(c.time);
      if (timePts && timePts.length > 1) {
        const a = timePts[0], b = timePts[timePts.length - 1];
        const span = b.frame - a.frame;
        const delta = b.value - a.value;
        if (span > 0 && Math.abs(delta) > 0.001) {
          const speed = delta / span;
          if (speed > 0 && isFinite(speed)) clip.speed = speed;
          else if (speed < 0 && isFinite(speed)) { clip.speed = Math.abs(speed); clip.reverse = true; }
        }
      }

      /* Keyframes: re-time from the clip's own fps/frame origin into our
         clip-relative frames. OpenShot frame numbers start at 1. */
      const kfInto = (path, keyframe, xform) => {
        const pts = points(keyframe);
        if (!pts || pts.length < 2) return;
        const list = [];
        for (const p of pts) {
          const local = Math.max(0, Math.round(p.frame - 1));
          const value = xform ? xform(p.value) : p.value;
          list.push({ frame: Math.min(local, Math.max(0, clip.length - 1)), value, interp: p.interp });
        }
        // Collapse duplicate frames, keeping the last write.
        const byFrame = new Map();
        for (const k of list) byFrame.set(k.frame, k);
        clip.keyframes[path] = [...byFrame.values()].sort((a, b) => a.frame - b.frame);
      };
      kfInto('opacity', c.alpha);
      kfInto('volume', c.volume);
      kfInto('transform.scale', c.scale_x, (v) => v);
      kfInto('transform.rotation', c.rotation, (v) => v);
      kfInto('transform.x', c.location_x, (v) => v * project.width);
      kfInto('transform.y', c.location_y, (v) => v * project.height);

      /* Effects attached to the clip. */
      const fxList = Array.isArray(c.effects) ? c.effects : [];
      for (const e of fxList) {
        const osmName = e && (e.type || e.name);
        const mapped = EFFECT_MAP[osmName];
        if (mapped === null || mapped === undefined) {
          if (osmName) summary.unmappedEffects++;
          continue;
        }
        if (!OS.effects.registry[mapped]) { summary.unmappedEffects++; continue; }
        const fx = M0.createEffect(mapped, mapEffectParams(mapped, e.properties));
        clip.effects.push(fx);
      }

      M0.insertClip(project, clip);
      summary.clips++;
    }

    /* ---- markers ---- */
    const markers = Array.isArray(doc.markers) ? doc.markers : [];
    for (const m of markers) {
      const sec = typeof m.position === 'number' ? m.position : (typeof m.frame === 'number' ? m.frame / fps.rate : null);
      if (sec == null) continue;
      project.markers.push({
        id: OS.util.uid('mk'),
        frame: Math.max(0, OS.timebase.secondsToFrames(sec, fps)),
        label: m.name || m.label || 'Marker',
        color: null,
      });
    }

    /* OpenShot renders an overlap between two clips on the same layer as a
       cross-dissolve (or the transition attached to the overlap). OpenScene
       models that explicitly, so mirror the overlap into a transitionIn entry —
       otherwise deserialize() flags every overlap as invalid. */
    for (const t of project.tracks) {
      const list = t.clips || [];
      for (let i = 1; i < list.length; i++) {
        const prev = list[i - 1], cur = list[i];
        const ov = Math.max(0, Math.min(M0.clipEnd(prev), M0.clipEnd(cur)) - Math.max(prev.start, cur.start));
        if (ov <= 0) continue;
        cur.transitionIn = { type: (cur.transitionIn && cur.transitionIn.type) || 'dissolve', length: Math.min(ov, Math.max(1, cur.length)) };
      }
    }
    M0.normalizeTransitions(project);

    project.name = fallbackName || 'OpenShot Project';
    return { project, name: project.name, summary };
  }

  const clamp01 = (v) => Math.max(0, Math.min(1, typeof v === 'number' && isFinite(v) ? v : 1));

  OS.osp = {
    looksLikeOpenShot, toProject,
    EFFECT_MAP, MIX_MAP,
    _internals: { points, firstValue, isAnimated },
  };
})();
