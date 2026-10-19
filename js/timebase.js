/* OpenScene — timebase.js
   All timeline positions are INTEGER FRAMES at the project frame rate.
   Using rational fps (e.g. 30000/1001) keeps timecode honest. */
(() => {
  'use strict';
  const OS = (window.OS = window.OS || {});

  const PRESETS = [
    { label: '23.976p', num: 24000, den: 1001 },
    { label: '24p', num: 24, den: 1 },
    { label: '25p (PAL)', num: 25, den: 1 },
    { label: '29.97p (NTSC)', num: 30000, den: 1001 },
    { label: '30p', num: 30, den: 1 },
    { label: '48p', num: 48, den: 1 },
    { label: '50p', num: 50, den: 1 },
    { label: '59.94p (NTSC)', num: 60000, den: 1001 },
    { label: '60p', num: 60, den: 1 },
    { label: '119.88p', num: 120000, den: 1001 },
    { label: '120p', num: 120, den: 1 },
  ];

  const fps = (num, den = 1) => ({ num, den, rate: num / den, label: PRESETS.find((p) => p.num === num && p.den === den)?.label || `${+(num / den).toFixed(3)}p` });
  const framesToSeconds = (frames, f) => (frames * f.den) / f.num;
  const secondsToFrames = (sec, f) => Math.round((sec * f.num) / f.den);
  const frameMs = (f) => (1000 * f.den) / f.num;

  /* HH:MM:SS:FF timecode (drop-frame notation is not applied; frames are exact). */
  function tc(frames, f) {
    const fr = Math.round(frames);
    const sign = fr < 0 ? '-' : '';
    let n = Math.abs(fr);
    const ff = n % f.num; n = (n - ff) / f.num;
    const ss = n % 60; n = (n - ss) / 60;
    const mm = n % 60;
    const hh = (n - mm) / 60;
    const d = (v, w = 2) => String(v).padStart(w, '0');
    return `${sign}${d(hh)}:${d(mm)}:${d(ss)}:${d(ff)}`;
  }

  /* Parse "12:34", "1:02:03", "1:02:03.12", "1:02:03:12" (hh:mm:ss:ff) into frames. */
  function parseTC(str, f) {
    if (str == null) return null;
    const s = String(str).trim();
    let m = /^(?:(\d+):)?(\d{1,2}):(\d{1,2})(?:[.:](\d{1,3}))?$/.exec(s);
    if (m) {
      const hh = +(m[1] || 0), mm = +m[2], ss = +m[3], tail = m[4];
      if (tail == null) return secondsToFrames(hh * 3600 + mm * 60 + ss, f);
      if (s.includes(':')) return secondsToFrames(hh * 3600 + mm * 60 + ss, f) + +tail; // frames field
      return secondsToFrames(hh * 3600 + mm * 60 + ss + parseFloat(`0.${tail}`), f);
    }
    m = /^(\d+(?:\.\d+)?)(s|ms|f)?$/.exec(s);
    if (m) {
      const v = parseFloat(m[1]);
      return m[2] === 'ms' ? secondsToFrames(v / 1000, f) : m[2] === 'f' ? Math.round(v) : secondsToFrames(v, f);
    }
    return null;
  }

  OS.timebase = { PRESETS, fps, framesToSeconds, secondsToFrames, frameMs, tc, parseTC };
})();
