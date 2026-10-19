/* OpenScene — zip.js
   A minimal, dependency-free ZIP writer (store method, no compression).

   Why store-only: the payload is PNG image sequences and PNG is already
   DEFLATE-compressed internally, so re-compressing it would cost seconds of CPU
   per frame for well under 1% of size.

   Why not a giant Uint8Array: a 16K PNG frame is tens of megabytes and a
   sequence is gigabytes. Everything here is assembled from Blob parts, so the
   browser can spill to disk and the renderer never needs one contiguous buffer.
   ZIP64 records are emitted whenever a size or offset crosses 4 GiB.

   API:
     const z = OS.zip.create();
     z.add('frame-00001.png', pngBlob);
     const blob = z.build();          // application/zip
*/
(() => {
  'use strict';
  const OS = (window.OS = window.OS || {});

  /* ---------------- CRC-32 ---------------- */

  let crcTable = null;
  function crc32Table() {
    if (crcTable) return crcTable;
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
    return crcTable;
  }

  function crc32(bytes, seed) {
    const t = crc32Table();
    let c = ((seed || 0) ^ 0xffffffff) >>> 0;
    for (let i = 0; i < bytes.length; i++) c = (t[(c ^ bytes[i]) & 0xff] ^ (c >>> 8)) >>> 0;
    return (c ^ 0xffffffff) >>> 0;
  }

  /* ---------------- little-endian helpers ---------------- */

  function u16(v) { return [v & 0xff, (v >>> 8) & 0xff]; }
  function u32(v) { return [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff]; }
  function u64(v) {
    /* v is a Number of bytes; sequences are well under 2^53. */
    const lo = v % 0x100000000;
    const hi = Math.floor(v / 0x100000000);
    return u32(lo).concat(u32(hi));
  }

  const LIMIT32 = 0xffffffff;

  /* MS-DOS date/time, as ZIP has stored it since 1989. */
  function dosTime(d) {
    const year = Math.max(1980, d.getFullYear());
    return {
      time: ((d.getHours() & 0x1f) << 11) | ((d.getMinutes() & 0x3f) << 5) | ((d.getSeconds() / 2) & 0x1f),
      date: (((year - 1980) & 0x7f) << 9) | (((d.getMonth() + 1) & 0x0f) << 5) | (d.getDate() & 0x1f),
    };
  }

  /* ---------------- writer ---------------- */

  function create() {
    const parts = [];
    const entries = [];
    let offset = 0;

    const push = (bytes) => { parts.push(new Uint8Array(bytes)); offset += bytes.length; };
    const pushBlob = (blob) => { parts.push(blob); offset += blob.size; };

    async function add(name, blob) {
      const bytes = new Uint8Array(await blob.arrayBuffer());
      const crc = crc32(bytes);
      const size = bytes.length;
      const nameBytes = new TextEncoder().encode(name);
      const stamp = dosTime(new Date());
      const max = 0xffffffff;

      const needs64 = size >= max || offset >= max;
      const extra = needs64 ? [].concat(u16(0x0001), u16(16), u64(size), u64(size)) : [];
      // in a ZIP64 entry the 32-bit size fields must be the sentinel value
      const sizeField = needs64 ? max : size;

      const header = [].concat(
        u32(0x04034b50),          // local file header signature
        u16(needs64 ? 45 : 20),   // version needed (4.5 for ZIP64)
        u16(0),                   // flags
        u16(0),                   // method: store
        u16(stamp.time), u16(stamp.date),
        u32(crc),
        u32(sizeField), u32(sizeField),
        u16(nameBytes.length),
        u16(extra.length),
      );

      entries.push({
        name: nameBytes, crc, size, offset,
        time: stamp.time, date: stamp.date, needs64,
      });

      push(header);
      push(extra);
      push(nameBytes);
      pushBlob(blob);
      return size;
    }

    function build() {
      const central = [];
      for (const e of entries) {
        const extra = e.needs64 ? [].concat(u16(0x0001), u16(24), u64(e.size), u64(e.size), u64(e.offset)) : [];
        /* Numbers only: `name` and `extra` are appended as their own parts. Putting
           a Uint8Array inside a plain array and passing that to the Uint8Array
           constructor stores a single element (NaN -> 0) instead of its bytes. */
        const rec = [].concat(
          u32(0x02014b50),        // central directory header signature
          u16(e.needs64 ? 45 : 20), // version made by
          u16(e.needs64 ? 45 : 20), // version needed
          u16(0),
          u16(0),                 // method: store
          u16(e.time), u16(e.date),
          u32(e.crc),
          u32(e.needs64 ? LIMIT32 : e.size),
          u32(e.needs64 ? LIMIT32 : e.size),
          u16(e.name.length),
          u16(extra.length),
          u16(0),                 // comment length
          u16(0),                 // disk number
          u16(0),                 // internal attributes
          u32(0),                 // external attributes
          u32(e.needs64 ? LIMIT32 : e.offset),
        );
        central.push(new Uint8Array(rec));
        central.push(e.name);
        if (extra.length) central.push(new Uint8Array(extra));
      }

      const cdOffset = offset;
      let cdSize = 0;
      for (const c of central) cdSize += c.length;

      const needZip64 = entries.length > 0xffff || cdSize >= LIMIT32 || cdOffset >= LIMIT32;
      const tail = [];

      if (needZip64) {
        tail.push(new Uint8Array([].concat(
          u32(0x06064b50),        // ZIP64 end of central directory
          u64(44),                // size of remaining record
          u16(45), u16(45),
          u32(0), u32(0),
          u64(entries.length), u64(entries.length),
          u64(cdSize), u64(cdOffset),
        )));
        tail.push(new Uint8Array([].concat(
          u32(0x07064b50),        // ZIP64 end of central directory locator
          u32(0), u64(cdOffset + cdSize), u32(1),
        )));
      }

      tail.push(new Uint8Array([].concat(
        u32(0x06054b50),          // end of central directory
        u16(0), u16(0),
        u16(Math.min(entries.length, 0xffff)), u16(Math.min(entries.length, 0xffff)),
        u32(Math.min(cdSize, LIMIT32)),
        u32(Math.min(cdOffset, LIMIT32)),
        u16(0),
      )));

      return new Blob(parts.concat(central, tail), { type: 'application/zip' });
    }

    return { add, build, get count() { return entries.length; } };
  }

  OS.zip = { create, crc32 };
})();
