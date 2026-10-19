/* OpenScene — wav.js
   Minimal 16-bit PCM WAV writer (audio-only export). */
(() => {
  'use strict';
  const OS = (window.OS = window.OS || {});

  /* channels: array of Float32Array (one per channel), sampleRate */
  function encodeWav(channels, sampleRate) {
    const numCh = channels.length;
    const len = channels[0].length;
    const bytesPerSample = 2;
    const blockAlign = numCh * bytesPerSample;
    const dataSize = len * blockAlign;
    const buf = new ArrayBuffer(44 + dataSize);
    const dv = new DataView(buf);
    const writeStr = (off, s) => { for (let i = 0; i < s.length; i++) dv.setUint8(off + i, s.charCodeAt(i)); };
    writeStr(0, 'RIFF');
    dv.setUint32(4, 36 + dataSize, true);
    writeStr(8, 'WAVE');
    writeStr(12, 'fmt ');
    dv.setUint32(16, 16, true);
    dv.setUint16(20, 1, true);              // PCM
    dv.setUint16(22, numCh, true);
    dv.setUint32(24, sampleRate, true);
    dv.setUint32(28, sampleRate * blockAlign, true);
    dv.setUint16(32, blockAlign, true);
    dv.setUint16(34, 16, true);
    writeStr(36, 'data');
    dv.setUint32(40, dataSize, true);
    let off = 44;
    for (let i = 0; i < len; i++) {
      for (let c = 0; c < numCh; c++) {
        let v = channels[c][i];
        v = v < -1 ? -1 : v > 1 ? 1 : v;
        dv.setInt16(off, v < 0 ? v * 0x8000 : v * 0x7fff, true);
        off += 2;
      }
    }
    return new Blob([buf], { type: 'audio/wav' });
  }

  OS.wav = { encodeWav };
})();
