/* OpenScene — media.js
   Media store: import, probe, thumbnails, waveform peaks (background), element pools,
   blob URL lifecycle and IndexedDB persistence for project relinking/autosave. */
(() => {
  'use strict';
  const OS = (window.OS = window.OS || {});
  const { uid, clamp, withTimeout, deferred } = OS.util;
  const M = () => OS.model;

  const MAX_PEAKS = 500_000;

  /* ---------------- IndexedDB ---------------- */

  const DB_NAME = 'openscene', DB_VERSION = 1;
  let _db = null;
  function db() {
    if (_db) return _db;
    _db = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const d = req.result;
        if (!d.objectStoreNames.contains('files')) d.createObjectStore('files');
        if (!d.objectStoreNames.contains('kv')) d.createObjectStore('kv');
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return _db;
  }
  async function idbPut(store, key, value) {
    const d = await db();
    return new Promise((resolve, reject) => {
      const tx = d.transaction(store, 'readwrite');
      tx.objectStore(store).put(value, key);
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => reject(tx.error);
    });
  }
  async function idbGet(store, key) {
    const d = await db();
    return new Promise((resolve, reject) => {
      const tx = d.transaction(store, 'readonly');
      const req = tx.objectStore(store).get(key);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  async function idbDelete(store, key) {
    const d = await db();
    return new Promise((resolve, reject) => {
      const tx = d.transaction(store, 'readwrite');
      tx.objectStore(store).delete(key);
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => reject(tx.error);
    });
  }

  /* ---------------- media formats (single source of truth) ----------------
     Every place that lists "what can be imported" reads these tables: the file
     pickers, the native Windows dialog filter, kind detection and the MIME map.
     Keeping one list is what stops formats drifting out of sync between the
     browser, the PWA and the desktop shell. */

  const VIDEO_EXT = [
    // MPEG-4 / QuickTime family
    'mp4', 'm4v', 'mp4v', 'm4s', 'mov', 'qt', '3gp', '3g2', '3gpp', '3gpp2', 'f4v', 'f4p',
    // Matroska / WebM
    'mkv', 'mk3d', 'webm',
    // Microsoft / ASF
    'avi', 'divx', 'wmv', 'asf', 'dvr-ms', 'wtv',
    // MPEG program / transport streams
    'mpg', 'mpeg', 'mpe', 'm2v', 'm1v', 'mpv', 'm2p', 'ts', 'mts', 'm2ts', 'm2t', 'ts4', 'tp', 'trp',
    // Disc / broadcast containers
    'vob', 'ifo', 'mxf', 'dv', 'dvr', 'roq', 'y4m', 'yuv', 'nut', 'ivf', 'bik', 'smk', 'nsv', 'amv',
    // Flash / RealMedia
    'flv', 'f4v', 'rm', 'rmvb',
    // Ogg / Theora
    'ogv', 'ogm', 'ogx',
    // Elementary / raw streams
    'h264', '264', 'avc', 'h265', '265', 'hevc', 'av1', 'vc1', 'mjpeg', 'mjpg', 'mjpa', 'mjpb', 'y4m',
    // Camera / intermediate
    'r3d', 'braw', 'crm', 'mxf', 'mts', 'sdp', 'mjp', 'dvr'
  ];

  const AUDIO_EXT = [
    // MPEG audio
    'mp3', 'mp2', 'mp1', 'mpa', 'mpga', 'm4a', 'm4b', 'm4r', 'm4p', 'mp4a', 'aac', 'adts',
    // PCM / uncompressed
    'wav', 'wave', 'bwf', 'aif', 'aiff', 'aifc', 'au', 'snd', 'voc', '8svx', 'sln', 'gsm', 'caf',
    // Lossless
    'flac', 'ape', 'wv', 'tta', 'tak', 'shn', 'als', 'alac',
    // Speech
    'amr', 'awb', 'spx', 'qcp', 'evc',
    // Ogg / Opus / WebM audio
    'ogg', 'oga', 'opus', 'weba', 'ogx', 'mka',
    // Windows / Real
    'wma', 'asf', 'ra', 'ram',
    // Surround / cinema
    'ac3', 'eac3', 'ec3', 'dts', 'dtshd', 'thd', 'mlp',
    // MIDI / tracker
    'mid', 'midi', 'rmi', 'kar', 'xm', 'it', 's3m', 'mod', 'mtm', 'umx'
  ];

  const IMAGE_EXT = [
    // Web / common
    'png', 'apng', 'jpg', 'jpeg', 'jpe', 'jfif', 'jif', 'jfi', 'webp', 'gif', 'bmp', 'dib',
    'avif', 'heic', 'heif', 'hif', 'svg', 'svgz', 'ico', 'cur', 'wbmp',
    // TIFF / TGA / Photoshop / interchange
    'tif', 'tiff', 'tga', 'icb', 'vda', 'vst', 'psd', 'psb', 'exr', 'hdr', 'rgbe', 'dds',
    'pcx', 'ppm', 'pgm', 'pbm', 'pnm', 'pam', 'pfm', 'xbm', 'xpm', 'ras', 'sun', 'eps', 'ai',
    'emf', 'wmf', 'jp2', 'j2k', 'jpf', 'jpx', 'jpm', 'jxl', 'qoi', 'astc', 'ktx', 'ktx2', 'ff',
    // Camera raw
    'dng', 'cr2', 'cr3', 'crw', 'nef', 'nrw', 'arw', 'sr2', 'srf', 'orf', 'rw2', 'raw', 'raf',
    'pef', 'ptx', 'x3f', '3fr', 'erf', 'mef', 'mos', 'mrw', 'rwl', 'srw', 'iiq', 'k25', 'kdc', 'dcr'
  ];

  const MIME_FIX = {
    mp4: 'video/mp4', m4v: 'video/mp4', mp4v: 'video/mp4', m4s: 'video/iso.segment',
    mov: 'video/quicktime', qt: 'video/quicktime', '3gp': 'video/3gpp', '3g2': 'video/3gpp2',
    webm: 'video/webm', mkv: 'video/x-matroska', mk3d: 'video/x-matroska', mka: 'audio/x-matroska',
    avi: 'video/x-msvideo', divx: 'video/divx', wmv: 'video/x-ms-wmv', asf: 'video/x-ms-asf',
    mpg: 'video/mpeg', mpeg: 'video/mpeg', mpe: 'video/mpeg', m2v: 'video/mpeg', m1v: 'video/mpeg',
    vob: 'video/dvd', ts: 'video/mp2t', mts: 'video/mp2t', m2ts: 'video/mp2t', m2t: 'video/mp2t',
    flv: 'video/x-flv', f4v: 'video/x-f4v', ogv: 'video/ogg', ogm: 'video/ogg',
    mxf: 'video/mxf', dv: 'video/dv', h264: 'video/h264', avc: 'video/h264',
    h265: 'video/h265', hevc: 'video/h265', av1: 'video/av01', mjpeg: 'video/x-motion-jpeg',
    mp3: 'audio/mpeg', mp2: 'audio/mpeg', mp1: 'audio/mpeg', mpa: 'audio/mpeg',
    m4a: 'audio/mp4', m4b: 'audio/mp4', m4r: 'audio/mp4', aac: 'audio/aac',
    wav: 'audio/wav', wave: 'audio/wav', bwf: 'audio/wav',
    aif: 'audio/aiff', aiff: 'audio/aiff', aifc: 'audio/aiff', au: 'audio/basic',
    snd: 'audio/basic', voc: 'audio/x-voc', gsm: 'audio/gsm', sln: 'audio/x-sln', caf: 'audio/x-caf',
    flac: 'audio/flac', ape: 'audio/x-ape', wv: 'audio/x-wavpack', tta: 'audio/x-tta',
    amr: 'audio/amr', awb: 'audio/amr-wb', spx: 'audio/ogg',
    ogg: 'audio/ogg', oga: 'audio/ogg', opus: 'audio/ogg', weba: 'audio/webm', ogx: 'audio/ogg',
    wma: 'audio/x-ms-wma', ra: 'audio/vnd.rn-realaudio', ram: 'audio/vnd.rn-realaudio',
    ac3: 'audio/ac3', eac3: 'audio/eac3', ec3: 'audio/eac3', dts: 'audio/vnd.dts',
    dtshd: 'audio/vnd.dts.hd', thd: 'audio/true-hd', mlp: 'audio/mlp',
    mid: 'audio/midi', midi: 'audio/midi', rmi: 'audio/midi', xm: 'audio/x-xm',
    it: 'audio/x-it', s3m: 'audio/x-s3m', mod: 'audio/x-mod',
    png: 'image/png', apng: 'image/apng', jpg: 'image/jpeg', jpeg: 'image/jpeg',
    jpe: 'image/jpeg', jfif: 'image/jpeg', jif: 'image/jpeg', jfi: 'image/jpeg',
    webp: 'image/webp', gif: 'image/gif', bmp: 'image/bmp', dib: 'image/bmp',
    avif: 'image/avif', heic: 'image/heic', heif: 'image/heif', hif: 'image/heif',
    svg: 'image/svg+xml', svgz: 'image/svg+xml', ico: 'image/x-icon', cur: 'image/x-icon',
    wbmp: 'image/vnd.wap.wbmp', tif: 'image/tiff', tiff: 'image/tiff', tga: 'image/x-tga',
    icb: 'image/x-tga', vda: 'image/x-tga', vst: 'image/x-tga',
    psd: 'image/vnd.adobe.photoshop', psb: 'image/vnd.adobe.photoshop',
    exr: 'image/x-exr', hdr: 'image/vnd.radiance', rgbe: 'image/vnd.radiance',
    dds: 'image/vnd.ms-dds', pcx: 'image/x-pcx', ppm: 'image/x-portable-pixmap',
    pgm: 'image/x-portable-graymap', pbm: 'image/x-portable-bitmap', pnm: 'image/x-portable-anymap',
    pam: 'image/x-portable-anymap', pfm: 'image/x-portable-floatmap',
    xbm: 'image/x-xbitmap', xpm: 'image/x-xpixmap', ras: 'image/x-cmu-raster',
    sun: 'image/x-cmu-raster', eps: 'application/postscript', ai: 'application/postscript',
    emf: 'image/emf', wmf: 'image/wmf', jp2: 'image/jp2', j2k: 'image/jp2',
    jpx: 'image/jpx', jpm: 'image/jpm', jxl: 'image/jxl', qoi: 'image/qoi',
    ktx: 'image/ktx', ktx2: 'image/ktx2', astc: 'image/astc',
    dng: 'image/x-adobe-dng', cr2: 'image/x-canon-cr2', cr3: 'image/x-canon-cr3',
    crw: 'image/x-canon-crw', nef: 'image/x-nikon-nef', nrw: 'image/x-nikon-nrw',
    arw: 'image/x-sony-arw', sr2: 'image/x-sony-sr2', srf: 'image/x-sony-srf',
    orf: 'image/x-olympus-orf', rw2: 'image/x-panasonic-rw2', raw: 'image/x-panasonic-raw',
    raf: 'image/x-fuji-raf', pef: 'image/x-pentax-pef', ptx: 'image/x-pentax-pef',
    x3f: 'image/x-sigma-x3f', '3fr': 'image/x-hasselblad-3fr', erf: 'image/x-epson-erf',
    mef: 'image/x-mamiya-mef', mrw: 'image/x-minolta-mrw', rwl: 'image/x-leica-rwl',
    srw: 'image/x-samsung-srw', iiq: 'image/x-phaseone-iiq',
    k25: 'image/x-kodak-k25', kdc: 'image/x-kodak-kdc', dcr: 'image/x-kodak-dcr',
    ff: 'image/x-farbfeld', yuv: 'video/x-raw-yuv', nut: 'video/x-nut', ivf: 'video/x-ivf'
  };

  /* ext -> kind, plus ext -> MIME. Built once so the pickers, the native filter
     and the renderer all agree on what a given file is. */
  const EXT_KIND = {};
  const MIME_BY_EXT = {};
  const addExts = (list, kind) => {
    for (const e of list) {
      if (EXT_KIND[e]) continue;              // first table wins (video before audio)
      EXT_KIND[e] = kind;
      MIME_BY_EXT[e] = MIME_FIX[e] || kind + '/x-' + e;
    }
  };
  addExts(VIDEO_EXT, 'video');
  addExts(AUDIO_EXT, 'audio');
  addExts(IMAGE_EXT, 'image');

  /* Extensions as the pickers want them, e.g. ['.mp4', '.mov', ...]. */
  const ALL_EXT_LIST = Object.keys(EXT_KIND).map((e) => '.' + e);
  const EXTS_FOR = (kind) => Object.keys(EXT_KIND).filter((e) => EXT_KIND[e] === kind).map((e) => '.' + e);
  const ACCEPT_ATTR = 'video/*,audio/*,image/*,' + ALL_EXT_LIST.join(',');

  const extOf = (name) => (String(name || '').split('.').pop() || '').toLowerCase().replace(/[^a-z0-9-]/g, '');

  /* Container signatures. Used when a file has no useful extension or MIME —
     screen recordings, telegram/whatsapp downloads and re-muxed streams often
     arrive as "videoplayback" or ".bin". */
  function sniffKind(file) {
    return file.slice(0, 4096).arrayBuffer().then((buf) => {
      const b = new Uint8Array(buf);
      const ascii = (o, n) => { let s = ''; for (let i = o; i < o + n && i < b.length; i++) s += String.fromCharCode(b[i]); return s; };
      const u32 = (o) => (b[o] << 24 | b[o + 1] << 16 | b[o + 2] << 8 | b[o + 3]) >>> 0;
      if (b.length < 12) return '';
      const tag4 = ascii(4, 4);
      // ISO base media (MP4/MOV/3GP/HEIF/AVIF)
      if (tag4 === 'ftyp') {
        const brand = ascii(8, 4);
        if (brand === 'avif' || brand === 'avis' || brand === 'heic' || brand === 'heix' ||
            brand === 'hevc' || brand === 'hevx' || brand === 'mif1' || brand === 'msf1') return 'image';
        return 'video';
      }
      if (u32(0) === 0x1a45dfa3) return 'video';                       // Matroska / WebM
      if (ascii(0, 4) === 'RIFF') {
        const form = ascii(8, 4);
        if (form === 'AVI ') return 'video';
        if (form === 'WAVE') return 'audio';
        if (form === 'WEBP') return 'image';
        return 'audio';
      }
      if (ascii(0, 3) === 'FLV' || ascii(1, 3) === 'FLV') return 'video';
      if (ascii(0, 4) === 'OggS') {
        const head = ascii(0, 4096);
        if (head.indexOf('theora') >= 0) return 'video';
        return 'audio';                                                // vorbis / opus / flac-in-ogg
      }
      if (b[0] === 0x1f && b[1] === 0x8b) return '';                   // gzip: not media
      if (b[0] === 0x30 && b[1] === 0x26 && b[2] === 0xb2 && b[3] === 0x75) return 'video'; // ASF/WMV
      if (b[0] === 0x00 && b[1] === 0x00 && b[2] === 0x01) {
        if (b[3] === 0xba || b[3] === 0xb3) return 'video';            // MPEG program stream
      }
      if (b[0] === 0x47 && (b.length < 189 || b[188] === 0x47)) return 'video';  // MPEG-TS
      if (ascii(0, 4) === 'fLaC') return 'audio';
      if (ascii(0, 3) === 'ID3') return 'audio';
      if (b[0] === 0xff && (b[1] & 0xe0) === 0xe0) {
        if ((b[1] & 0x06) !== 0) return 'audio';                       // MPEG audio frame
        return 'audio';                                                // ADTS AAC
      }
      if (ascii(0, 4) === 'FORM' && (ascii(8, 4) === 'AIFF' || ascii(8, 4) === 'AIFC')) return 'audio';
      if (ascii(0, 4) === 'caff') return 'audio';
      if (ascii(0, 5) === '#!AMR') return 'audio';
      if (ascii(0, 4) === 'MThd') return 'audio';
      // Images
      if (b[0] === 0x89 && ascii(1, 3) === 'PNG') return 'image';
      if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image';
      if (ascii(0, 4) === 'GIF8') return 'image';
      if (b[0] === 0x42 && b[1] === 0x4d) return 'image';
      if (ascii(0, 4) === 'II*\u0000' || ascii(0, 4) === 'MM\u0000*') return 'image';
      if (b[0] === 0x00 && b[1] === 0x00 && b[2] === 0x00 && b[3] === 0x0c && ascii(4, 4) === 'jP  ') return 'image';
      if (ascii(0, 4) === '8BPS') return 'image';
      if (b[0] === 0x76 && b[1] === 0x2f && b[2] === 0x31 && b[3] === 0x01) return 'image'; // EXR
      if (ascii(0, 2) === '#?') return 'image';                        // Radiance HDR
      if (ascii(0, 4) === 'qoif') return 'image';
      // SVG / XML text
      const text = ascii(0, 300).trim().toLowerCase();
      if (text.slice(0, 5) === '<?xml' || text.slice(0, 4) === '<svg') return 'image';
      return '';
    }).catch(() => '');
  }

  /* ---------------- probing helpers ---------------- */

  function kindFromName(name, type) {
    const t = (type || '').toLowerCase();
    const known = EXT_KIND[extOf(name)];
    if (known) return known;
    if (t.startsWith('video/')) return 'video';
    if (t.startsWith('audio/')) return 'audio';
    if (t.startsWith('image/')) return 'image';
    if (t.indexOf('matroska') >= 0 || t.indexOf('quicktime') >= 0 || t.indexOf('mp4') >= 0) return 'video';
    if (t.indexOf('ogg') >= 0 || t.indexOf('mpeg') >= 0) return t.indexOf('video') >= 0 ? 'video' : 'audio';
    return 'video';
  }

  function probeVideo(file) {
    return new Promise((resolve) => {
      const url = URL.createObjectURL(file);
      const v = document.createElement('video');
      v.preload = 'auto';
      v.muted = true;
      v.playsInline = true;
      let done = false;
      const finish = (ok) => {
        if (done) return; done = true;
        const res = ok
          ? { width: v.videoWidth, height: v.videoHeight, duration: isFinite(v.duration) ? v.duration : 0 }
          : { width: 0, height: 0, duration: 0, failed: true };
        v.removeAttribute('src'); v.load();
        URL.revokeObjectURL(url);
        resolve(res);
      };
      v.onloadedmetadata = () => finish(true);
      v.onerror = () => finish(false);
      setTimeout(() => finish(v.readyState >= 1), 15000);
      v.src = url;
    });
  }

  function probeAudio(file) {
    return new Promise((resolve) => {
      const url = URL.createObjectURL(file);
      const a = document.createElement('audio');
      let done = false;
      const finish = (ok) => {
        if (done) return; done = true;
        const res = ok ? { duration: isFinite(a.duration) ? a.duration : 0 } : { duration: 0, failed: true };
        a.removeAttribute('src'); a.load();
        URL.revokeObjectURL(url);
        resolve(res);
      };
      a.onloadedmetadata = () => finish(true);
      a.onerror = () => finish(false);
      setTimeout(() => finish(a.readyState >= 1), 15000);
      a.src = url;
    });
  }

  function probeImage(file) {
    return new Promise((resolve) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      let done = false;
      const finish = (ok) => {
        if (done) return; done = true;
        resolve(ok ? { width: img.naturalWidth, height: img.naturalHeight } : { width: 0, height: 0, failed: true });
      };
      img.onload = () => finish(true);
      img.onerror = () => finish(false);
      setTimeout(() => finish(img.complete && img.naturalWidth > 0), 15000);
      img.src = url;
    });
  }

  /* A decoded frame has more than one distinct pixel; a uniform canvas means the
     element was drawn before any frame actually arrived. */
  function frameHasDetail(ctx, w, h) {
    try {
      const d = ctx.getImageData(0, 0, w, h).data;
      const rgb0 = (d[0] << 16) | (d[1] << 8) | d[2];
      const a0 = d[3];
      for (let i = 4; i < d.length; i += 4) {
        if (((d[i] << 16) | (d[i + 1] << 8) | d[i + 2]) !== rgb0 || d[i + 3] !== a0) return true;
      }
      return false;
    } catch (e) {
      return true; // unreadable canvas: assume it holds content
    }
  }

  /* Poster jobs run one at a time. Several 4K decodes at once starve each other,
     which is what produced empty thumbnails during batch imports. */
  let posterChain = Promise.resolve();
  function queuePoster(job) {
    const run = posterChain.then(job, job);
    posterChain = run.catch(() => {});
    return run;
  }

  /* Poster frame for a video clip. Every wait is bounded and the element is always
     torn down, because a missing thumbnail must never stall an import. */
  async function makeVideoThumb(file, duration) {
    const url = URL.createObjectURL(file);
    const v = document.createElement('video');
    try {
      v.preload = 'auto'; v.muted = true; v.playsInline = true;
      const want = isFinite(duration) && duration > 0 ? duration : 10;
      v.src = url;
      await withTimeout(new Promise((res) => {
        v.onloadeddata = res; v.onloadedmetadata = res; v.onerror = res;
      }), 10000, 'thumb load').catch(() => {});
      if (!v.videoWidth || !v.videoHeight) return null;
      const c = document.createElement('canvas');
      const scale = 192 / Math.max(v.videoWidth, v.videoHeight);
      c.width = Math.max(2, Math.round(v.videoWidth * scale));
      c.height = Math.max(2, Math.round(v.videoHeight * scale));
      const ctx = c.getContext('2d');
      // A detached element stops at HAVE_METADATA and never decodes on its own, so
      // asking for a timestamp is what actually forces a frame into existence.
      const grab = async (t) => {
        if (v.readyState < 2 || Math.abs(v.currentTime - t) > 0.001) {
          v.currentTime = t;
          await withTimeout(new Promise((res) => { v.onseeked = res; v.onloadeddata = res; }), 10000, 'thumb seek').catch(() => {});
        }
        ctx.clearRect(0, 0, c.width, c.height);
        ctx.drawImage(v, 0, 0, c.width, c.height);
        return frameHasDetail(ctx, c.width, c.height);
      };
      let ok = await grab(Math.min(Math.max(0.05, want * 0.1), Math.max(0, want - 0.05)));
      if (!ok) ok = await grab(0);           // flat sample: try the opening frame
      if (!ok && v.readyState < 2) return null;
      return c.toDataURL('image/webp', 0.72);
    } catch (e) {
      return null;
    } finally {
      try { v.removeAttribute('src'); v.load(); } catch (e) { /* already detached */ }
      URL.revokeObjectURL(url);
    }
  }

  async function makeImageThumb(file) {
    const url = URL.createObjectURL(file);
    const img = new Image();
    try {
      img.src = url;
      await withTimeout(new Promise((res, rej) => { img.onload = res; img.onerror = rej; }), 8000, 'img thumb').catch(() => {});
      if (!img.naturalWidth) return null;
      const scale = 192 / Math.max(img.naturalWidth, img.naturalHeight);
      const c = document.createElement('canvas');
      c.width = Math.max(2, Math.round(img.naturalWidth * scale));
      c.height = Math.max(2, Math.round(img.naturalHeight * scale));
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      return c.toDataURL('image/webp', 0.72);
    } catch (e) {
      return null;
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  /* Hard ceiling on what we are willing to hand to decodeAudioData. A 4K clip is
     hundreds of megabytes of container; decoding it whole to draw a waveform
     blocks the main thread for minutes (and on many machines never returns).
     Anything above this is reported as "no peaks" straight away and the clip
     still imports, plays and exports — it simply shows a flat waveform. */
  const MAX_PEAK_DECODE_BYTES = 96 * 1024 * 1024;

  /* Peaks decoded from a container that also carries video are always a guess:
     decodeAudioData on an .mp4/.mkv decodes the *whole* file, so a 3 GB movie
     would push gigabytes of PCM through memory. Only "audio-first" containers
     or small files are worth the cost, and even then the work is bounded. */
  function worthDecoding(file) {
    if (!file) return false;
    if (file.size > MAX_PEAK_DECODE_BYTES) return false;
    const ext = extOf(file.name || '');
    // Video containers that can hold a full movie: skip unless tiny.
    const heavy = VIDEO_EXT.indexOf(ext) >= 0;
    if (heavy && file.size > 24 * 1024 * 1024) return false;
    return true;
  }

  /* Waveform peaks from an audio Asset file. Returns Float32Array [max0,min0,max1,min1,...]. */
  async function computePeaks(file, onProgress) {
    if (!worthDecoding(file)) {
      return { peaks: null, buckets: 0, duration: 0, sampleRate: 0, channels: 0, skipped: true };
    }
    const buf = await file.arrayBuffer();
    const ac = new (window.AudioContext || window.webkitAudioContext)();
    try {
      const audio = await withTimeout(ac.decodeAudioData(buf), 20000, 'decodeAudioData');
      const ch = audio.numberOfChannels, sr = audio.sampleRate, len = audio.length;
      const buckets = Math.min(MAX_PEAKS, len);
      const per = len / buckets;
      const out = new Float32Array(buckets * 2);
      const data = [];
      for (let c = 0; c < ch; c++) data.push(audio.getChannelData(c));
      const step = Math.max(1, Math.floor(per / 512)); // subsample long windows
      for (let b = 0; b < buckets; b++) {
        const s = Math.floor(b * per), e = Math.min(len, Math.floor((b + 1) * per));
        let mx = 0, mn = 0;
        for (let c = 0; c < ch; c++) {
          const d = data[c];
          for (let i = s; i < e; i += step) {
            const v = d[i];
            if (v > mx) mx = v;
            if (v < mn) mn = v;
          }
        }
        out[b * 2] = mx; out[b * 2 + 1] = mn;
        if (onProgress && (b & 8191) === 0) onProgress(b / buckets);
      }
      return { peaks: out, buckets, duration: audio.duration, sampleRate: sr, channels: ch };
    } finally { ac.close().catch(() => {}); }
  }

  function peaksToThumb(peaksRes) {
    const c = document.createElement('canvas');
    c.width = 192; c.height = 108;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#12151b';
    ctx.fillRect(0, 0, c.width, c.height);
    ctx.strokeStyle = '#4fd1a5';
    ctx.lineWidth = 1;
    ctx.beginPath();
    const { peaks, buckets } = peaksRes;
    for (let x = 0; x < c.width; x++) {
      const b0 = Math.floor((x / c.width) * buckets), b1 = Math.max(b0 + 1, Math.floor(((x + 1) / c.width) * buckets));
      let mx = 0, mn = 0;
      for (let b = b0; b < b1 && b < buckets; b++) { mx = Math.max(mx, peaks[b * 2]); mn = Math.min(mn, peaks[b * 2 + 1]); }
      ctx.moveTo(x + 0.5, c.height / 2 - mx * c.height * 0.45);
      ctx.lineTo(x + 0.5, c.height / 2 - mn * c.height * 0.45);
    }
    ctx.stroke();
    return c.toDataURL('image/webp', 0.72);
  }

  /* ---------------- MediaStore ---------------- */

  class MediaStore {
    constructor() {
      this.records = new Map();      // assetId -> {asset, url, image?, video?, audio?, peaks?, peaksPromise?, failed}
      this.videoPool = new Map();    // assetId -> [video elements]
      this.audioPool = new Map();
      this.onprogress = new OS.util.Emitter();
    }

    get instance() { return this; }

    /* Renderer resolver: which element draws this clip? Player overrides via getForClip. */
    get(assetId, clipId) {
      return this.records.get(assetId) || null;
    }

    async importFiles(files, opts = {}) {
      const out = [];
      const list = [...files].filter((f) => f && f.name);
      for (let i = 0; i < list.length; i++) {
        const file = list[i];
        this.onprogress.emit('progress', { index: i, total: list.length, name: file.name });
        const asset = await this.importFile(file, opts);
        if (asset) out.push(asset);
      }
      this.onprogress.emit('done', { count: out.length });
      return out;
    }

    async importFile(file, opts = {}) {
      const fps = OS.app && OS.app.project ? OS.app.project.fps : OS.timebase.fps(30, 1);
      const knownExt = !!EXT_KIND[extOf(file.name)];
      const knownMime = /^(video|audio|image)\//.test((file.type || '').toLowerCase());
      let kind = kindFromName(file.name, file.type);
      // A file with no usable extension or MIME (screen recordings, chat downloads,
      // re-muxed streams) is classified from its container signature instead.
      if (!knownExt && !knownMime) {
        const sniffed = await sniffKind(file);
        if (sniffed) kind = sniffed;
      }
      let meta = { name: file.name, kind, bytes: file.size, type: file.type || MIME_BY_EXT[extOf(file.name)] || '' };
      let poster = null;   // deferred poster-frame job, run off the critical path
      let decoded = false;
      // Probe the detected kind; an unrecognised file also gets the other channels,
      // so a mislabelled clip still lands on the right track.
      const order = knownExt || knownMime
        ? [kind]
        : [kind].concat(['video', 'audio', 'image'].filter((k) => k !== kind));
      for (const k of order) {
        try {
          if (k === 'image') {
            const p = await probeImage(file);
            if (p.failed || !p.width) continue;
            kind = 'image';
            Object.assign(meta, { kind, width: p.width, height: p.height, durationFrames: fps.num });
            poster = () => makeImageThumb(file);
          } else if (k === 'video') {
            const p = await probeVideo(file);
            if (p.failed || !p.width) continue;
            kind = 'video';
            Object.assign(meta, { kind, width: p.width, height: p.height, durationFrames: OS.timebase.secondsToFrames(p.duration || 0, fps), hasAudio: true });
            poster = () => makeVideoThumb(file, p.duration);
          } else {
            const p = await probeAudio(file);
            if (p.failed || !(p.duration > 0)) continue;
            kind = 'audio';
            Object.assign(meta, { kind, durationFrames: OS.timebase.secondsToFrames(p.duration || 0, fps), hasAudio: true });
          }
          decoded = true;
          break;
        } catch (e) { /* try the next channel */ }
      }
      if (!decoded) {
        // The container is understood but this build's decoders are not: keep the
        // clip so nothing is silently lost, and flag it for the bin to explain.
        console.warn('[OpenScene] no decoder for', file.name, '- kept as', kind);
        if (!opts.tolerant) return null;
        meta.undecodable = true;
        meta.thumb = null;
      }
      const asset = M().createAsset(meta);
      const rec = { asset, file, url: URL.createObjectURL(file), failed: !!meta.failed, kind };
      if (kind === 'image') {
        const img = new Image();
        img.src = rec.url;
        rec.image = img;
      }
      this.records.set(asset.id, rec);
      // Draw the poster frame in the background: importing a batch of 4K clips must
      // never queue behind thumbnail decoding. The bin refreshes on media-updated.
      if (poster) queuePoster(poster).then((thumb) => {
        if (thumb) { asset.thumb = thumb; OS.app && OS.app.events.emit('media-updated', asset); }
      }).catch(() => {});
      // Persist the file for autosave restore / relinking, off the critical path.
      // Awaiting this used to serialise every import behind a full IndexedDB write
      // of the source bytes — for a folder of 4K clips that is minutes of stall
      // before anything appears in the bin. Fire it and let it settle later.
      if (asset.bytes < 1.5 * 1024 ** 3) {
        const key = uid('file');
        asset.fileKey = key;
        const pending = idbPut('files', key, file).catch(() => { asset.fileKey = null; });
        this._persistChain = (this._persistChain || Promise.resolve()).then(() => pending);
      }
      // Background waveform for audio + videos that may carry audio. This is
      // best-effort and must never hold up an import: computePeaks is bounded,
      // and a skipped/failed decode simply leaves the clip with no waveform.
      if (kind !== 'image') this.ensurePeaks(asset.id).then((res) => {
        if (res && res.peaks && !asset.thumb) { asset.thumb = peaksToThumb(res); OS.app && OS.app.events.emit('media-updated', asset); }
        else OS.app && OS.app.events.emit('media-updated', asset);
      }).catch(() => {});
      OS.app && OS.app.events.emit('media-added', asset);
      return asset;
    }

    registerExisting(asset) {
      // asset loaded from a project file: element/file restored separately
      if (!this.records.has(asset.id)) this.records.set(asset.id, { asset, url: null, missing: !asset.fileKey });
      return this.records.get(asset.id);
    }

    async restoreFile(asset) {
      const rec = this.records.get(asset.id) || this.registerExisting(asset);
      if (rec.file || !asset.fileKey) return rec;
      try {
        const file = await idbGet('files', asset.fileKey);
        if (!file) { asset.missing = true; rec.missing = true; return rec; }
        rec.file = file;
        rec.url = URL.createObjectURL(file);
        rec.missing = false;
        asset.missing = false;
        if (asset.kind === 'image') { const img = new Image(); img.src = rec.url; rec.image = img; }
        this.ensurePeaks(asset.id).then(() => OS.app && OS.app.events.emit('media-updated', asset)).catch(() => {});
      } catch (e) { asset.missing = true; rec.missing = true; }
      return rec;
    }

    relinkFile(asset, file) {
      const rec = this.records.get(asset.id) || this.registerExisting(asset);
      if (rec.url) URL.revokeObjectURL(rec.url);
      rec.file = file;
      rec.url = URL.createObjectURL(file);
      rec.missing = false;
      asset.missing = false;
      asset.name = file.name;
      asset.bytes = file.size;
      if (asset.kind === 'image') { const img = new Image(); img.src = rec.url; rec.image = img; }
      idbPut('files', asset.fileKey || (asset.fileKey = uid('file')), file).catch(() => {});
      this.ensurePeaks(asset.id).then(() => OS.app && OS.app.events.emit('media-updated', asset)).catch(() => {});
      OS.app && OS.app.events.emit('media-relinked', asset);
    }

    /* Per-clip media elements (video/audio) from the pool. */
    acquire(assetId, clipId, kind) {
      const rec = this.records.get(assetId);
      if (!rec || !rec.url) return null;
      const pool = kind === 'audio' ? this.audioPool : this.videoPool;
      let list = pool.get(assetId);
      if (!list) { list = []; pool.set(assetId, list); }
      let el = list.find((e) => e.__clipId === clipId);
      if (el) return el;
      el = list.find((e) => !e.__clipId);
      if (!el) {
        el = document.createElement(kind === 'audio' ? 'audio' : 'video');
        el.preload = 'auto';
        el.playsInline = true;
        el.crossOrigin = 'anonymous';
        el.src = rec.url;
        el.__assetId = assetId;
        list.push(el);
      }
      el.__clipId = clipId;
      return el;
    }

    release(assetId, clipId, kind) {
      const pool = kind === 'audio' ? this.audioPool : this.videoPool;
      const list = pool.get(assetId) || [];
      for (const el of list) if (el.__clipId === clipId) { el.__clipId = null; el.pause && el.pause(); }
    }

    /* Primary element for stills/bin/scrub (single shared element per asset). */
    primary(assetId) {
      const rec = this.records.get(assetId);
      if (!rec) return null;
      if (rec.asset.kind === 'video') {
        if (!rec.video) {
          rec.video = document.createElement('video');
          rec.video.preload = 'auto'; rec.video.muted = true; rec.video.playsInline = true;
          if (rec.url) rec.video.src = rec.url;
        }
        return rec.video;
      }
      return null;
    }

    async seekPrimary(assetId, mediaFrame, fps) {
      const rec = this.records.get(assetId);
      if (!rec || rec.asset.kind !== 'video' || !rec.url) return null;
      const v = this.primary(assetId);
      if (v.readyState < 1) {
        await withTimeout(new Promise((res) => { v.onloadeddata = res; v.onloadedmetadata = res; }), 10000, 'seek load').catch(() => {});
      }
      const t = mediaFrame / fps;
      if (Math.abs(v.currentTime - t) > 0.0005) {
        v.currentTime = t;
        await withTimeout(new Promise((res) => { v.onseeked = res; }), 10000, 'seek').catch(() => {});
      }
      return v;
    }

    ensurePeaks(assetId) {
      const rec = this.records.get(assetId);
      if (!rec || rec.asset.kind === 'image') return Promise.resolve(null);
      if (rec.peaks) return Promise.resolve(rec.peaks);
      if (rec.peaksPromise) return rec.peaksPromise;
      if (!rec.file) return Promise.resolve(null);
      rec.peaksPromise = computePeaks(rec.file)
        .then((res) => {
          if (!res || res.skipped || !(res.duration > 0)) return null;
          rec.peaks = res;
          rec.asset.durationFrames = rec.asset.durationFrames || OS.timebase.secondsToFrames(res.duration, OS.app ? OS.app.project.fps : OS.timebase.fps(30, 1));
          return res;
        })
        .catch((e) => { rec.peaksFailed = true; return null; });
      return rec.peaksPromise;
    }

    peaks(assetId) { const r = this.records.get(assetId); return r && r.peaks ? r.peaks : null; }

    /* Decoded PCM for offline (export) mixing — cached per asset. */
    ensureAudioBuffer(assetId) {
      const rec = this.records.get(assetId);
      if (!rec) return Promise.resolve(null);
      if (rec.audioBuffer) return Promise.resolve(rec.audioBuffer);
      if (rec.audioBufferPromise) return rec.audioBufferPromise;
      if (!rec.file) return Promise.resolve(null);
      rec.audioBufferPromise = rec.file.arrayBuffer()
        .then((buf) => {
          const AC = window.AudioContext || window.webkitAudioContext;
          const ac = new AC();
          return ac.decodeAudioData(buf)
            .then((decoded) => { rec.audioBuffer = decoded; return decoded; })
            .finally(() => ac.close().catch(() => {}));
        })
        .catch(() => null);
      return rec.audioBufferPromise;
    }

    async durationOf(assetId) {
      const rec = this.records.get(assetId);
      if (!rec) return 0;
      if (rec.asset.durationFrames) return rec.asset.durationFrames;
      const pk = await this.ensurePeaks(assetId);
      if (pk) return OS.timebase.secondsToFrames(pk.duration, OS.app.project.fps);
      return rec.asset.durationFrames;
    }

    revoke(assetId) {
      const rec = this.records.get(assetId);
      if (!rec) return;
      if (rec.url) URL.revokeObjectURL(rec.url);
      for (const list of [this.videoPool.get(assetId) || [], this.audioPool.get(assetId) || []]) {
        for (const el of list) { try { el.pause(); el.removeAttribute('src'); el.load(); } catch (e) {} }
      }
      this.videoPool.delete(assetId); this.audioPool.delete(assetId);
      this.records.delete(assetId);
      if (rec.asset.fileKey) idbDelete('files', rec.asset.fileKey).catch(() => {});
    }

    disposeAll() {
      for (const id of [...this.records.keys()]) this.revoke(id);
    }
  }

  OS.media = {
    MediaStore, idbPut, idbGet, idbDelete, computePeaks, kindFromName, probeVideo, probeAudio, probeImage,
    // format tables, shared by the pickers, the native dialog filter and the UI
    MIME_BY_EXT, EXT_KIND, ALL_EXT_LIST, EXTS_FOR, ACCEPT_ATTR, extOf, sniffKind,
  };
})();
