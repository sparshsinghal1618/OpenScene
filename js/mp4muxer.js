/* OpenScene — mp4muxer.js
   Minimal ISO-BMFF (MP4/QuickTime) muxer for WebCodecs output:
     H.264 video  -> avc1 + avcC
     AAC audio    -> mp4a + esds
   Layout: ftyp | moov | mdat. Single sample-per-chunk tables with a 1-entry stco.
   Timestamps are microseconds, and the track timescale is 1e6 so WebCodecs
   timestamps map 1:1 onto sample durations. */
(() => {
  'use strict';
  const OS = (window.OS = window.OS || {});

  const MICRO = 1_000_000;

  class Writer {
    constructor() { this.parts = []; this.length = 0; }
    _push(b) { this.parts.push(b); this.length += b.length; return this; }
    u8(v) { return this._push(new Uint8Array([v & 0xff])); }
    u16(v) { const b = new Uint8Array(2); new DataView(b.buffer).setUint16(0, v & 0xffff); return this._push(b); }
    u24(v) { return this._push(new Uint8Array([(v >> 16) & 0xff, (v >> 8) & 0xff, v & 0xff])); }
    u32(v) { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, v >>> 0); return this._push(b); }
    i16(v) { const b = new Uint8Array(2); new DataView(b.buffer).setInt16(0, v); return this._push(b); }
    i32(v) { const b = new Uint8Array(4); new DataView(b.buffer).setInt32(0, v); return this._push(b); }
    str(s) { const b = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i) & 0xff; return this._push(b); }
    zeros(n) { return this._push(new Uint8Array(n)); }
    bytes(v) { return this._push(v instanceof Uint8Array ? v : new Uint8Array(v)); }
    concat() {
      const out = new Uint8Array(this.length);
      let o = 0;
      for (const p of this.parts) { out.set(p, o); o += p.length; }
      return out;
    }
    get size() { return this.length; }
  }

  const asBytes = (w) => (w instanceof Uint8Array ? w : w.concat());

  /* box('mdat', [writer|bytes|null, ...]) */
  function box(type, items = []) {
    const body = new Writer();
    for (const it of items) {
      if (it == null) continue;
      body.bytes(asBytes(it));
    }
    const inner = body.concat();
    const w = new Writer();
    w.u32(8 + inner.length);
    w.str(type);
    w.bytes(inner);
    return w;
  }

  function fullBox(type, version, flags, items = []) {
    const head = new Writer();
    head.u8(version).u24(flags);
    return box(type, [head, ...items]);
  }

  /* ---- sample entries ---- */

  function videoSampleEntry(tr) {
    const e = new Writer();
    e.zeros(6).u16(1);                       // reserved, data_reference_index
    e.u16(0).u16(0).u32(0).u32(0).u32(0);    // pre_defined, reserved, pre_defined[3]
    e.u16(tr.width).u16(tr.height);
    e.u32(0x00480000).u32(0x00480000);       // 72 dpi
    e.u32(0).u16(1);                         // reserved, frame_count
    const label = 'OpenScene H.264';
    const cname = new Uint8Array(32);
    cname[0] = label.length;
    for (let i = 0; i < label.length; i++) cname[1 + i] = label.charCodeAt(i);
    e.bytes(cname);
    e.u16(0x0018).i16(-1);                   // depth, pre_defined
    const avcC = box('avcC', [tr.description ? tr.description : avcCFromSps()]);
    return box('avc1', [e, avcC]);
  }

  /* Fallback avcC (baseline level 3.1) used only if the encoder gives no description. */
  function avcCFromSps() {
    return new Uint8Array([
      0x01, 0x42, 0x00, 0x1f, 0xff, 0xe1, 0x00, 0x0b, 0x67, 0x42, 0x00, 0x1f, 0x96, 0x54, 0x05, 0x01,
      0xe9, 0x80, 0x01, 0x00, 0x04, 0x68, 0xce, 0x3c, 0x80,
    ]);
  }

  function audioSampleEntry(tr) {
    const e = new Writer();
    e.zeros(6).u16(1);                       // reserved, data_reference_index
    e.u32(0).u32(0);                         // reserved[2]
    e.u16(tr.channels || 2).u16(16);         // channelcount, samplesize
    e.u16(0).u16(0);                         // pre_defined, reserved
    e.u32((tr.sampleRate || 48000) << 16);   // 16.16 fixed
    const asc = tr.description || new Uint8Array([0x12, 0x10]);
    const dsi = new Writer().u8(0x05).u8(asc.length).bytes(asc);
    const dcd = new Writer()
      .u8(0x04).u8(13 + asc.length)
      .u8(0x40)                              // objectTypeIndication: MPEG-4 audio (AAC)
      .u8(0x15)                              // streamType = audio, upstream 0, reserved 1
      .u24(0)
      .u32(tr.avgBitrate || 128000)
      .u32(tr.avgBitrate || 128000)
      .bytes(dsi.concat());
    const es = new Writer().u8(0x03).u8(3 + dcd.length).u16(2).u8(0).bytes(dcd.concat());
    return box('mp4a', [e, fullBox('esds', 0, 0, [es])]);
  }

  /* ---- muxer ---- */

  class MP4Muxer {
    constructor(opts = {}) {
      this.video = opts.video ? {
        kind: 'video', samples: [], description: null,
        width: opts.video.width || 1920, height: opts.video.height || 1080,
        frameDur: Math.round(MICRO / (opts.video.fps || 30)),
        chunkSize: 0,
      } : null;
      this.audio = opts.audio ? {
        kind: 'audio', samples: [], description: null,
        sampleRate: opts.audio.sampleRate || 48000, channels: opts.audio.channels || 2,
        avgBitrate: opts.audio.bitrate || 192000, chunkSize: 0,
      } : null;
      if (!this.video && !this.audio) throw new Error('MP4Muxer needs at least one track');
      this.durationUs = 0;
      this.stats = { videoSamples: 0, audioSamples: 0 };
    }

    addVideoChunk(chunk, meta) {
      if (!this.video) return;
      const desc = meta && meta.decoderConfig && meta.decoderConfig.description;
      if (desc) this.video.description = new Uint8Array(desc.buffer ? desc : new Uint8Array(desc));
      const data = new Uint8Array(chunk.byteLength);
      chunk.copyTo(data);
      this.video.samples.push({ data, ts: chunk.timestamp, duration: 0, sync: chunk.type === 'key' });
      this.stats.videoSamples++;
      this.durationUs = Math.max(this.durationUs, chunk.timestamp + this.video.frameDur);
    }

    addAudioChunk(chunk, meta) {
      if (!this.audio) return;
      const desc = meta && meta.decoderConfig && meta.decoderConfig.description;
      if (desc) this.audio.description = new Uint8Array(desc.buffer ? desc : new Uint8Array(desc));
      const data = new Uint8Array(chunk.byteLength);
      chunk.copyTo(data);
      this.audio.samples.push({ data, ts: chunk.timestamp, duration: 0, sync: true });
      this.stats.audioSamples++;
      this.durationUs = Math.max(this.durationUs, chunk.timestamp + 1024 * (MICRO / this.audio.sampleRate));
    }

    finalise() {
      this._fillDurations(this.video, this.video ? this.video.frameDur : 0);
      this._fillDurations(this.audio, this.audio ? 1024 * (MICRO / this.audio.sampleRate) : 0);
      // pass 1: measure sizes with placeholder offsets
      const pass1 = this._build(0, 0);
      const mdatStart = pass1.headLength + pass1.moovLength + 8;
      const videoOffset = mdatStart;
      const audioOffset = mdatStart + (this.video ? this.video.chunkSize : 0);
      // pass 2: real offsets (identical sizes because offsets are fixed-width u32)
      const pass2 = this._build(videoOffset, audioOffset);
      if (pass2.moovLength !== pass1.moovLength) throw new Error('mp4 muxer: moov size drift');
      const mdatBody = new Writer();
      for (const tr of [this.video, this.audio]) {
        if (!tr) continue;
        for (const s of tr.samples) mdatBody.bytes(s.data);
      }
      const mdatHead = new Writer().u32(8 + mdatBody.length).str('mdat');
      const total = pass2.head.length + pass2.moov.length + mdatHead.length + mdatBody.length;
      const out = new Uint8Array(total);
      let o = 0;
      out.set(pass2.head, o); o += pass2.head.length;
      out.set(pass2.moov, o); o += pass2.moov.length;
      out.set(mdatHead.concat(), o); o += mdatHead.length;
      out.set(mdatBody.concat(), o);
      return out;
    }

    _fillDurations(tr, defaultDur) {
      if (!tr) return;
      tr.samples.sort((a, b) => a.ts - b.ts);
      for (let i = 0; i < tr.samples.length - 1; i++) {
        tr.samples[i].duration = Math.max(1, tr.samples[i + 1].ts - tr.samples[i].ts);
      }
      const last = tr.samples[tr.samples.length - 1];
      if (last) last.duration = Math.max(1, last.duration || defaultDur || 1);
      tr.chunkSize = tr.samples.reduce((a, s) => a + s.data.length, 0);
    }

    _build(videoOffset, audioOffset) {
      const duration = Math.max(1, Math.round(this.durationUs));
      const mvhd = fullBox('mvhd', 0, 0, [(w => {
        w.u32(0).u32(0).u32(MICRO).u32(duration);
        w.u32(0x00010000).u16(0x0100).u16(0);
        w.u32(0).u32(0);
        w.u32(0x00010000).u32(0).u32(0);
        w.u32(0).u32(0x00010000).u32(0);
        w.u32(0).u32(0).u32(0x40000000);
        for (let i = 0; i < 6; i++) w.u32(0);
        w.u32((this.video ? 1 : 0) + (this.audio ? 1 : 0) + 1); // next_track_ID
        return w;
      })(new Writer())]);
      const ftyp = box('ftyp', [(w => {
        w.str('isom').u32(0x200).str('isom').str('iso2').str('avc1').str('mp41');
        return w;
      })(new Writer())]);
      const children = [];
      let tid = 1;
      if (this.video) children.push(this._trak(this.video, tid++, duration, videoOffset));
      if (this.audio) children.push(this._trak(this.audio, tid++, duration, audioOffset));
      const moov = box('moov', [mvhd, ...children]);
      const head = ftyp.concat();
      return { head, headLength: head.length, moov: moov.concat(), moovLength: moov.length };
    }

    _trak(tr, trackId, duration, chunkOffset) {
      const isVideo = tr.kind === 'video';
      const mdhd = fullBox('mdhd', 0, 0, [(w => {
        w.u32(0).u32(0).u32(MICRO).u32(duration).u16(0x55c4).u16(0);
        return w;
      })(new Writer())]);
      const hdlr = fullBox('hdlr', 0, 0, [(w => {
        w.u32(0).str(isVideo ? 'vide' : 'soun').u32(0).u32(0).u32(0);
        const name = isVideo ? 'OpenScene Video' : 'OpenScene Audio';
        w.str(name).u8(0);
        return w;
      })(new Writer())]);
      const mediaHeader = isVideo
        ? fullBox('vmhd', 0, 1, [(w => { w.u16(0).u16(0).u16(0).u16(0); return w; })(new Writer())])
        : fullBox('smhd', 0, 0, [(w => { w.u16(0).u16(0); return w; })(new Writer())]);
      const dref = fullBox('dref', 0, 0, [
        new Writer().u32(1),
        fullBox('url ', 0, 1, []),   // self-contained
      ]);
      const minf = box('minf', [mediaHeader, box('dinf', [dref]), this._stbl(tr, chunkOffset)]);
      const tkhd = fullBox('tkhd', 0, 7, [(w => {
        w.u32(0).u32(0).u32(trackId).u32(0).u32(duration);
        w.u32(0).u32(0);
        w.i16(0).i16(isVideo ? 0 : 0x0100);
        w.u16(isVideo ? 0 : 0x0100).u16(0);
        w.u32(0x00010000).u32(0).u32(0);
        w.u32(0).u32(0x00010000).u32(0);
        w.u32(0).u32(0).u32(0x40000000);
        w.u32(isVideo ? tr.width << 16 : 0);
        w.u32(isVideo ? tr.height << 16 : 0);
        return w;
      })(new Writer())]);
      return box('trak', [tkhd, box('mdia', [mdhd, hdlr, minf])]);
    }

    _stbl(tr, chunkOffset) {
      const n = tr.samples.length;
      if (!n) throw new Error('mp4 muxer: track with no samples');
      const stsd = fullBox('stsd', 0, 0, [
        new Writer().u32(1),
        tr.kind === 'video' ? videoSampleEntry(tr) : audioSampleEntry(tr),
      ]);
      const runs = [];
      for (const s of tr.samples) {
        const last = runs[runs.length - 1];
        if (last && last.delta === s.duration) last.count++;
        else runs.push({ delta: s.duration, count: 1 });
      }
      const stts = fullBox('stts', 0, 0, [(w => {
        w.u32(runs.length);
        for (const r of runs) w.u32(r.count).u32(r.delta);
        return w;
      })(new Writer())]);
      let stss = null;
      if (tr.kind === 'video') {
        const sync = [];
        tr.samples.forEach((s, i) => { if (s.sync) sync.push(i + 1); });
        if (!sync.length) sync.push(1);
        stss = fullBox('stss', 0, 0, [(w => { w.u32(sync.length); for (const i of sync) w.u32(i); return w; })(new Writer())]);
      }
      const stsc = fullBox('stsc', 0, 0, [(w => { w.u32(1).u32(1).u32(n).u32(1); return w; })(new Writer())]);
      const stsz = fullBox('stsz', 0, 0, [(w => {
        w.u32(0).u32(n);
        for (const s of tr.samples) w.u32(s.data.length);
        return w;
      })(new Writer())]);
      const stco = fullBox('stco', 0, 0, [(w => { w.u32(1).u32(chunkOffset); return w; })(new Writer())]);
      return box('stbl', [stsd, stts, stss, stsc, stsz, stco]);
    }
  }

  /* ---- helpers used by the export pipeline ---- */

  async function pickH264Config(width, height, bitrate, fps, hardware = true) {
    const levels = ['avc1.640034', 'avc1.640033', 'avc1.640032', 'avc1.640028', 'avc1.4d0028', 'avc1.42e01f', 'avc1.42001f'];
    for (const codec of levels) {
      const cfg = { codec, width, height, bitrate, framerate: fps, avc: { format: 'avc' }, hardwareAcceleration: hardware ? 'prefer-hardware' : 'prefer-software' };
      try {
        const s = await VideoEncoder.isConfigSupported(cfg);
        if (s && s.supported) return s.config || cfg;
      } catch (e) { /* try next */ }
    }
    // last resort: software baseline
    const cfg = { codec: 'avc1.42001f', width, height, bitrate, framerate: fps, avc: { format: 'avc' }, hardwareAcceleration: 'prefer-software' };
    const s = await VideoEncoder.isConfigSupported(cfg).catch(() => null);
    return s && s.supported ? (s.config || cfg) : null;
  }

  async function pickAacConfig(sampleRate, channels, bitrate) {
    const cfg = { codec: 'mp4a.40.2', sampleRate, numberOfChannels: channels, bitrate };
    const s = await AudioEncoder.isConfigSupported(cfg).catch(() => null);
    return s && s.supported ? (s.config || cfg) : null;
  }

  OS.mp4muxer = { MP4Muxer, pickH264Config, pickAacConfig, isSupported: async () => {
    if (!('VideoEncoder' in window) || !('AudioEncoder' in window)) return false;
    return !!(await pickH264Config(1280, 720, 2_000_000, 30));
  } };
})();
