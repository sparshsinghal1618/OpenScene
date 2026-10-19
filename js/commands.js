/* OpenScene — commands.js
   Undo/redo via a bounded command stack. Every user edit is a command. */
(() => {
  'use strict';
  const OS = (window.OS = window.OS || {});
  const { deepClone } = OS.util;
  const M = () => OS.model;

  class CommandStack {
    constructor(limit = 250) {
      this.limit = limit;
      this.done = [];
      this.undone = [];
      this.onchange = new OS.util.Emitter();
    }
    exec(cmd) {
      cmd.do();
      this.done.push(cmd);
      if (this.done.length > this.limit) this.done.shift();
      this.undone.length = 0;
      this.onchange.emit('change');
      return cmd;
    }
    get canUndo() { return this.done.length > 0; }
    get canRedo() { return this.undone.length > 0; }
    peekUndo() { return this.done[this.done.length - 1] || null; }
    peekRedo() { return this.undone[this.undone.length - 1] || null; }
    undo() {
      const cmd = this.done.pop();
      if (!cmd) return null;
      cmd.undo();
      this.undone.push(cmd);
      this.onchange.emit('change');
      return cmd;
    }
    redo() {
      const cmd = this.undone.pop();
      if (!cmd) return null;
      cmd.do();
      this.done.push(cmd);
      this.onchange.emit('change');
      return cmd;
    }
    clear() { this.done.length = 0; this.undone.length = 0; this.onchange.emit('change'); }
    /* Group a burst of commands so one undo reverts all of them. */
    beginGroup(label) {
      const group = { label: label || 'Edit', items: [], do() { for (const c of this.items) c.do(); }, undo() { for (let i = this.items.length - 1; i >= 0; i--) this.items[i].undo(); } };
      this._group = group;
      return group;
    }
    execInGroup(label, cmd) {
      if (!this._group) { this._group = { label: label || 'Edit', items: [], do() { for (const c of this.items) c.do(); }, undo() { for (let i = this.items.length - 1; i >= 0; i--) this.items[i].undo(); } }; return this.exec(cmd); }
      cmd.do();
      this._group.items.push(cmd);
      return cmd;
    }
    endGroup() {
      const g = this._group;
      this._group = null;
      if (!g || !g.items.length) return null;
      if (g.items.length === 1) { this.done.push(g.items[0]); }
      else { this.done.push(g); }
      this.undone.length = 0;
      this.onchange.emit('change');
      return g;
    }
  }

  /* ---------- command helpers ---------- */

  const label = (cmd, text) => { if (typeof text === 'string' && text) cmd.label = text; return cmd; };

  function AddClips(project, clips, opts = {}) {
    return label({
      label: opts.name || (clips.length === 1 ? `Add ${clips[0].name || 'clip'}` : `Add ${clips.length} clips`),
      do() { for (const c of clips) M().insertClip(project, c); M().normalizeTransitions(project); },
      undo() { for (const c of clips) M().removeClip(project, c); M().normalizeTransitions(project); },
    }, this);
  }

  function RemoveClips(project, clips, opts = {}) {
    const snapshot = clips.map((c) => ({ clip: c, prev: M().prevClip(M().findTrack(project, c.trackId), c), trackId: c.trackId }));
    return label({
      label: opts.name || (clips.length === 1 ? 'Delete clip' : `Delete ${clips.length} clips`),
      do() { for (const c of clips) M().removeClip(project, c); M().normalizeTransitions(project); },
      undo() { for (const s of snapshot) M().insertClip(project, s.clip); M().normalizeTransitions(project); },
    });
  }

  /* Ripple-delete: close the gap left by removed clips on their tracks. */
  function RippleRemoveClips(project, clips, opts = {}) {
    const byTrack = new Map();
    for (const c of clips) { (byTrack.get(c.trackId) || byTrack.set(c.trackId, []).get(c.trackId)).push(c); }
    const shifts = [];
    for (const [trackId, list] of byTrack) {
      const track = M().findTrack(project, trackId);
      list.sort((a, b) => a.start - b.start);
      let acc = 0;
      for (const c of list) {
        const removedLen = c.length;
        for (const other of M().clipsOf(project, track)) {
          if (other.start >= M().clipEnd(c)) {
            let sh = shifts.find((s) => s.clip === other);
            if (!sh) { sh = { clip: other, before: other.start, delta: 0 }; shifts.push(sh); }
            sh.delta -= removedLen;
          }
        }
        acc += removedLen;
      }
    }
    const rm = RemoveClips(project, clips, opts);
    return label({
      label: `Ripple delete${clips.length > 1 ? ` (${clips.length})` : ''}`,
      do() {
        for (const s of shifts) s.clip.start = Math.max(0, s.before + s.delta);
        for (const t of project.tracks) M().sortClips(t);
        rm.do();
      },
      undo() {
        rm.undo();
        for (const s of shifts) s.clip.start = s.before;
        for (const t of project.tracks) M().sortClips(t);
      },
    });
  }

  /* Move clips horizontally and/or across tracks. positions: [{clip, start, trackId}] */
  function MoveClips(project, positions, opts = {}) {
    const before = positions.map((p) => ({ clip: p.clip, start: p.clip.start, trackId: p.clip.trackId }));
    return label({
      label: opts.name || (positions.length === 1 ? 'Move clip' : `Move ${positions.length} clips`),
      do() {
        for (const p of positions) { p.clip.start = Math.max(0, Math.round(p.start)); if (p.trackId) p.clip.trackId = p.trackId; }
        for (const t of project.tracks) { M().sortClips(t); M().normalizeTransitions(project); }
      },
      undo() {
        for (const b of before) { b.clip.start = b.start; b.clip.trackId = b.trackId; }
        for (const t of project.tracks) { M().sortClips(t); M().normalizeTransitions(project); }
      },
    });
  }

  /* Trim a clip edge. mode 'in' adjusts start+inPoint+length; 'out' adjusts length. */
  function TrimClip(project, clip, mode, newStartOrLength, opts = {}) {
    const before = { start: clip.start, length: clip.length, inPoint: clip.inPoint };
    const asset = M().findAsset(project, clip.assetId);
    const maxLen = clip.generator || !asset ? Infinity : Math.max(1, Math.round((asset.durationFrames - clip.inPoint) / (clip.speed || 1)) + (mode === 'in' ? clip.length - Math.max(0, clip.start - newStartOrLength) : 0));
    return label({
      label: opts.name || (mode === 'in' ? 'Trim clip in' : 'Trim clip out'),
      do() {
        if (mode === 'in') {
          const delta = Math.round(newStartOrLength - clip.start);
          const maxDelta = clip.length - M().MIN_CLIP_FRAMES;
          const d = OS.util.clamp(delta, -before.inPoint, maxDelta);
          clip.start = before.start + d;
          clip.inPoint = before.inPoint + Math.round(d * (clip.speed || 1));
          clip.length = before.length - d;
        } else {
          const desired = Math.round(newStartOrLength);
          let maxLen2 = Infinity;
          if (asset && !clip.generator) maxLen2 = Math.max(M().MIN_CLIP_FRAMES, Math.round((asset.durationFrames - clip.inPoint) / (clip.speed || 1)));
          clip.length = OS.util.clamp(desired, M().MIN_CLIP_FRAMES, maxLen2);
        }
        M().normalizeTransitions(project);
      },
      undo() { clip.start = before.start; clip.length = before.length; clip.inPoint = before.inPoint; M().normalizeTransitions(project); },
    });
  }

  /* ---------- professional trim operations ---------- */

  /* Longest length a clip may reach, given its source media. */
  function maxLengthOf(project, clip) {
    const asset = M().findAsset(project, clip.assetId);
    if (clip.generator || clip.adjustment || !asset) return Infinity;
    const speed = clip.speed || 1;
    return Math.max(M().MIN_CLIP_FRAMES, Math.round((asset.durationFrames - clip.inPoint) / speed));
  }

  /* Roll: move the shared edge between two neighbouring clips without moving
     anything else. Both sides are re-trimmed against their own media. */
  function RollEdit(project, a, b, frame, opts = {}) {
    const before = { aLen: a.length, bStart: b.start, bLen: b.length, bIn: b.inPoint };
    const speedB = b.speed || 1;
    const want = Math.round(frame - M().clipEnd(a));
    const maxA = maxLengthOf(project, a), maxB = maxLengthOf(project, b);
    let lo = Math.max(M().MIN_CLIP_FRAMES - before.aLen, M().MIN_CLIP_FRAMES - before.bLen, Math.ceil(-before.bIn / speedB), -Math.max(0, b.start));
    let hi = Math.min(before.bLen - M().MIN_CLIP_FRAMES, maxA - before.aLen, maxB - before.bLen);
    if (hi < lo) hi = lo;
    const d = OS.util.clamp(want, lo, hi);
    return label({
      label: opts.name || 'Roll edit',
      do() {
        a.length = before.aLen + d;
        b.start = before.bStart + d;
        b.length = before.bLen - d;
        b.inPoint = before.bIn + Math.round(d * speedB);
        M().normalizeTransitions(project);
      },
      undo() {
        a.length = before.aLen; b.start = before.bStart; b.length = before.bLen; b.inPoint = before.bIn;
        M().normalizeTransitions(project);
      },
    });
  }

  /* Slip: slide the source window inside a clip. The clip never moves. */
  function SlipClip(project, clip, deltaFrames, opts = {}) {
    const asset = M().findAsset(project, clip.assetId);
    const speed = clip.speed || 1;
    const maxIn = asset && !clip.generator && !clip.adjustment
      ? Math.max(0, Math.floor(asset.durationFrames - (clip.length - 1) * speed - 1))
      : Infinity;
    const before = clip.inPoint;
    const target = OS.util.clamp(before + Math.round(deltaFrames * speed), 0, maxIn);
    const delta = target - before;
    return label({
      label: opts.name || 'Slip clip',
      do() { clip.inPoint = before + delta; },
      undo() { clip.inPoint = before; },
    });
  }

  /* Slide: move a clip between its neighbours, extending the one before it and
     consuming the head of the one after it, so the sequence length never changes. */
  function SlideClip(project, clip, deltaFrames, opts = {}) {
    const track = M().findTrack(project, clip.trackId);
    if (!track) return MoveClips(project, [{ clip, start: clip.start + deltaFrames }], { name: opts.name || 'Slide clip' });
    const list = M().clipsOf(project, track);
    const i = list.indexOf(clip);
    const prev = i > 0 ? list[i - 1] : null;
    const next = i >= 0 && i + 1 < list.length ? list[i + 1] : null;
    if (!prev && !next) return MoveClips(project, [{ clip, start: clip.start + deltaFrames }], { name: opts.name || 'Slide clip' });

    const before = { start: clip.start, prevLen: prev ? prev.length : 0, nextStart: next ? next.start : 0, nextLen: next ? next.length : 0, nextIn: next ? next.inPoint : 0 };
    const speedN = next ? (next.speed || 1) : 1;
    let lo = -before.start;
    let hi = Infinity;
    if (prev) { lo = Math.max(lo, M().MIN_CLIP_FRAMES - before.prevLen); hi = Math.min(hi, maxLengthOf(project, prev) - before.prevLen); }
    if (next) { hi = Math.min(hi, before.nextLen - M().MIN_CLIP_FRAMES); lo = Math.max(lo, Math.ceil(-before.nextIn / speedN), -before.nextStart); }
    if (hi < lo) hi = lo;
    const d = OS.util.clamp(Math.round(deltaFrames), lo, hi);
    if (!d) return null;

    return label({
      label: opts.name || 'Slide clip',
      do() {
        clip.start = before.start + d;
        if (prev) prev.length = before.prevLen + d;
        if (next) { next.start = before.nextStart + d; next.length = before.nextLen - d; next.inPoint = before.nextIn + Math.round(d * speedN); }
        M().sortClips(track);
        M().normalizeTransitions(project);
      },
      undo() {
        clip.start = before.start;
        if (prev) prev.length = before.prevLen;
        if (next) { next.start = before.nextStart; next.length = before.nextLen; next.inPoint = before.nextIn; }
        M().sortClips(track);
        M().normalizeTransitions(project);
      },
    });
  }

  /* Split a clip at a project frame (inside its body).
     Every mutation happens inside do()/undo() so the command is truly reversible.
     Returns the command; the created right-hand clip is exposed as `_right`. */
  function SplitClip(project, clip, frame, opts = {}) {
    const beforeLength = clip.length;
    const beforeKeyframes = deepClone(clip.keyframes || {});
    const beforeTransition = clip.transitionIn;
    const beforeFadeOut = clip.fadeOut;
    const at = Math.max(clip.start + 1, Math.min(M().clipEnd(clip) - 1, frame));
    const cutLocal = at - clip.start;

    // keyframes are clip-relative: the right half is re-based to start at the cut
    const leftKf = {};
    const rightKf = {};
    for (const [path, list] of Object.entries(beforeKeyframes)) {
      const lk = list.filter((k) => k.frame < cutLocal);
      const rk = list.filter((k) => k.frame >= cutLocal).map((k) => ({ ...k, frame: k.frame - cutLocal }));
      if (lk.length) leftKf[path] = lk;
      if (rk.length) rightKf[path] = rk;
    }

    const right = deepClone(clip);
    right.id = OS.util.uid('clp');
    right.start = at;
    right.length = beforeLength - cutLocal;
    right.inPoint = clip.inPoint + Math.round(cutLocal * (clip.speed || 1));
    right.keyframes = rightKf;
    right.transitionIn = null;         // incoming transition stays with the left half
    right.fadeOut = beforeFadeOut;     // the tail keeps the outgoing fade
    // the left half keeps its fade-in and drops the (now detached) outgoing fade
    const leftFadeOut = cutLocal >= beforeLength ? beforeFadeOut : 0;

    return label({
      label: opts.name || 'Split clip',
      _right: right,
      do() {
        clip.length = cutLocal;
        clip.keyframes = deepClone(leftKf);
        clip.fadeOut = leftFadeOut;
        M().insertClip(project, right);
        M().normalizeTransitions(project);
      },
      undo() {
        M().removeClip(project, right);
        clip.length = beforeLength;
        clip.keyframes = deepClone(beforeKeyframes);
        clip.transitionIn = beforeTransition;
        clip.fadeOut = beforeFadeOut;
        M().normalizeTransitions(project);
      },
    });
  }

  /* Set one or more clip properties atomically. values: {path: newValue} using dotted paths. */
  function SetClipProps(project, edits, opts = {}) {
    // edits: [{clip, values:{path:v}, prev:{path:v}}]
    const resolve = (obj, path) => path.split('.').reduce((o, k) => (o ? o[k] : undefined), obj);
    const assign = (obj, path, v) => {
      const keys = path.split('.');
      const last = keys.pop();
      const target = keys.reduce((o, k) => (o[k] = o[k] || {}), obj);
      target[last] = v;
    };
    for (const e of edits) {
      e.prev = e.prev || {};
      for (const path of Object.keys(e.values)) if (!(path in e.prev)) e.prev[path] = resolve(e.clip, path);
    }
    return label({
      label: opts.name || 'Change clip properties',
      do() { for (const e of edits) for (const [path, v] of Object.entries(e.values)) assign(e.clip, path, v); M().normalizeTransitions(project); },
      undo() { for (const e of edits) for (const [path, v] of Object.entries(e.prev)) assign(e.clip, path, v); M().normalizeTransitions(project); },
    });
  }

  function AddEffect(project, clip, effect, opts = {}) {
    return label({
      label: opts.name || `Add effect: ${effect.type}`,
      do() { clip.effects.push(effect); },
      undo() { const i = clip.effects.indexOf(effect); if (i >= 0) clip.effects.splice(i, 1); },
    });
  }

  function RemoveEffect(project, clip, effect) {
    let index = -1;
    return label({
      label: `Remove effect: ${effect.type}`,
      do() { index = clip.effects.indexOf(effect); if (index >= 0) clip.effects.splice(index, 1); },
      undo() { if (index >= 0) clip.effects.splice(Math.min(index, clip.effects.length), 0, effect); },
    });
  }

  function ReorderEffects(project, clip, effect, dir) {
    let from = -1;
    return label({
      label: dir < 0 ? 'Move effect up' : 'Move effect down',
      do() {
        from = clip.effects.indexOf(effect);
        const to = from + dir;
        if (from < 0 || to < 0 || to >= clip.effects.length) return;
        clip.effects.splice(from, 1);
        clip.effects.splice(to, 0, effect);
      },
      undo() {
        const to = from + dir;
        if (from < 0 || to < 0 || to >= clip.effects.length + 1) return;
        clip.effects.splice(to, 1);
        clip.effects.splice(from, 0, effect);
      },
    });
  }

  function AddTrack(project, track, index, opts = {}) {
    return label({
      label: opts.name || `Add ${track.kind} track`,
      do() { project.tracks.splice(index, 0, track); },
      undo() { const i = project.tracks.indexOf(track); if (i >= 0) project.tracks.splice(i, 1); },
    });
  }

  function RemoveTrack(project, track) {
    const index = project.tracks.indexOf(track);
    const clips = [...M().clipsOf(project, track)];
    return label({
      label: `Delete track ${track.name}`,
      do() { const i = project.tracks.indexOf(track); if (i >= 0) project.tracks.splice(i, 1); },
      undo() { if (index >= 0) project.tracks.splice(index, 0, track); for (const c of clips) M().insertClip(project, c); },
    });
  }

  function MoveTrack(project, track, targetIndex) {
    const from = project.tracks.indexOf(track);
    return label({
      label: `Move ${track.kind} track`,
      do() {
        const i = project.tracks.indexOf(track);
        if (i < 0) return;
        project.tracks.splice(i, 1);
        project.tracks.splice(Math.max(0, Math.min(targetIndex, project.tracks.length)), 0, track);
      },
      undo() {
        const i = project.tracks.indexOf(track);
        if (i < 0) return;
        project.tracks.splice(i, 1);
        project.tracks.splice(Math.max(0, Math.min(from, project.tracks.length)), 0, track);
      },
    });
  }

  function SetTrackProps(project, track, values, opts = {}) {
    const prev = {};
    for (const k of Object.keys(values)) prev[k] = track[k];
    return label({
      label: opts.name || `Change track ${track.name}`,
      do() { Object.assign(track, values); },
      undo() { Object.assign(track, prev); },
    });
  }

  function AddMarker(project, marker, opts = {}) {
    return label({
      label: opts.name || 'Add marker',
      do() { project.markers.push(marker); project.markers.sort((a, b) => a.frame - b.frame); },
      undo() { const i = project.markers.indexOf(marker); if (i >= 0) project.markers.splice(i, 1); },
    });
  }

  function RemoveMarker(project, marker) {
    return label({
      label: 'Remove marker',
      do() { const i = project.markers.indexOf(marker); if (i >= 0) project.markers.splice(i, 1); },
      undo() { project.markers.push(marker); project.markers.sort((a, b) => a.frame - b.frame); },
    });
  }

  function SetMarker(project, marker, values) {
    const prev = {}; for (const k of Object.keys(values)) prev[k] = marker[k];
    return label({
      label: 'Edit marker',
      do() { Object.assign(marker, values); project.markers.sort((a, b) => a.frame - b.frame); },
      undo() { Object.assign(marker, prev); project.markers.sort((a, b) => a.frame - b.frame); },
    });
  }

  function AddAsset(project, asset) {
    return label({
      label: `Import ${asset.name}`,
      do() { project.assets.push(asset); },
      undo() { const i = project.assets.indexOf(asset); if (i >= 0) project.assets.splice(i, 1); },
    });
  }

  function RemoveAssets(project, assets) {
    const usedClips = project.tracks.flatMap((t) => M().clipsOf(project, t).filter((c) => assets.includes(c.assetId)));
    const snapshot = usedClips.map((c) => ({ c, trackId: c.trackId }));
    return label({
      label: 'Remove media',
      do() {
        for (const a of assets) { const i = project.assets.indexOf(a); if (i >= 0) project.assets.splice(i, 1); }
        for (const c of usedClips) M().removeClip(project, c);
      },
      undo() {
        for (const a of assets) project.assets.push(a);
        for (const s of snapshot) M().insertClip(project, s.c);
      },
    });
  }

  /* Replace clip media, keeping timing (used by relink). */
  function SetProjectProps(project, values, opts = {}) {
    const prev = {}; for (const k of Object.keys(values)) prev[k] = project[k];
    return label({
      label: opts.name || 'Project settings',
      do() { Object.assign(project, values); },
      undo() { Object.assign(project, prev); },
    });
  }

  /* Generic keyframe edit: add/remove a keyframe at a path+frame. */
  function EditKeyframes(project, clip, path, frame, value, opts = {}) {
    const had = M().keyframeAt(clip, path, frame);
    return label({
      label: opts.name || (had ? 'Remove keyframe' : 'Add keyframe'),
      do() { if (value === undefined) M().removeKeyframe(clip, path, frame); else M().setKeyframe(clip, path, frame, value); },
      undo() {
        if (had) M().setKeyframe(clip, path, frame, had.value);
        else M().removeKeyframe(clip, path, frame);
      },
    });
  }

  OS.commands = {
    CommandStack,
    AddClips, RemoveClips, RippleRemoveClips, MoveClips, TrimClip, SplitClip, SetClipProps,
    RollEdit, SlipClip, SlideClip, maxLengthOf,
    AddEffect, RemoveEffect, ReorderEffects, AddTrack, RemoveTrack, MoveTrack, SetTrackProps,
    AddMarker, RemoveMarker, SetMarker, AddAsset, RemoveAssets, SetProjectProps, EditKeyframes,
  };
})();
