/* OpenScene — effects.js
   Effect registry, OpenShot-style. Every effect carries a category (video/audio),
   a UI group and a human description. GPU-backed effects map to Canvas2D filter
   strings (compositor accelerated in Chromium/WebView2), draw effects paint over
   the composed layer, pixel effects run a CPU pass and audio effects contribute a
   gain factor to the mixer. Parameters are keyframeable. */
(() => {
  'use strict';
  const OS = (window.OS = window.OS || {});
  const { clamp } = OS.util;

  const registry = {};
  const define = (type, def) => { registry[type] = { type, category: 'video', group: 'General', description: '', params: {}, defaultParams: {}, ...def }; };

  const numParam = (label, min, max, step, def, unit = '') => ({ kind: 'number', label, min, max, step, default: def, unit });
  const selParam = (label, options, def) => ({ kind: 'select', label, options, default: def });
  const colParam = (label, def) => ({ kind: 'color', label, default: def });

  /* Group order used by the dock / inspector. */
  const GROUPS = ['Color & Tone', 'Blur & Sharpen', 'Stylize', 'Distort', 'Keying', 'Render', 'Audio'];

  /* ---- GPU (canvas filter) effects: contribute to a single filter string ---- */

  define('brightness', {
    label: 'Brightness', group: 'Color & Tone',
    description: 'Lift or lower the overall luminance of the clip.',
    params: { amount: numParam('Amount', 0, 3, 0.01, 1.2) }, defaultParams: { amount: 1.2 },
    filter: (p) => `brightness(${p.amount})`,
  });
  define('contrast', {
    label: 'Contrast', group: 'Color & Tone',
    description: 'Expand or compress the difference between light and dark areas.',
    params: { amount: numParam('Amount', 0, 3, 0.01, 1.3) }, defaultParams: { amount: 1.3 },
    filter: (p) => `contrast(${p.amount})`,
  });
  define('saturation', {
    label: 'Saturation', group: 'Color & Tone',
    description: 'Make colours more vivid (above 1) or more muted (below 1).',
    params: { amount: numParam('Amount', 0, 3, 0.01, 1.5) }, defaultParams: { amount: 1.5 },
    filter: (p) => `saturate(${p.amount})`,
  });
  define('grayscale', {
    label: 'Black & White', group: 'Color & Tone',
    description: 'Desaturate the clip to a monochrome image.',
    params: { amount: numParam('Amount', 0, 1, 0.01, 1) }, defaultParams: { amount: 1 },
    filter: (p) => `grayscale(${clamp(p.amount, 0, 1)})`,
  });
  define('sepia', {
    label: 'Sepia', group: 'Color & Tone',
    description: 'Apply a warm, vintage brown tone.',
    params: { amount: numParam('Amount', 0, 1, 0.01, 0.8) }, defaultParams: { amount: 0.8 },
    filter: (p) => `sepia(${clamp(p.amount, 0, 1)})`,
  });
  define('hue', {
    label: 'Hue Rotate', group: 'Color & Tone',
    description: 'Shift every colour around the hue wheel.',
    params: { degrees: numParam('Angle', -180, 180, 1, 0, ' deg') }, defaultParams: { degrees: 0 },
    filter: (p) => `hue-rotate(${p.degrees}deg)`,
  });
  define('invert', {
    label: 'Invert', group: 'Color & Tone',
    description: 'Invert the colours to produce a negative image.',
    params: { amount: numParam('Amount', 0, 1, 0.01, 1) }, defaultParams: { amount: 1 },
    filter: (p) => `invert(${clamp(p.amount, 0, 1)})`,
  });
  define('blur', {
    label: 'Blur', group: 'Blur & Sharpen',
    description: 'Soften the image with a Gaussian blur.',
    params: { radius: numParam('Radius', 0, 60, 0.5, 4, 'px') }, defaultParams: { radius: 4 },
    filter: (p) => (p.radius > 0.01 ? `blur(${p.radius}px)` : ''),
  });

  /* ---- CPU pixel effects (ImageData pass) ---- */

  function convolve(s, d, w, h, kernel, divisor, bias) {
    const k = kernel, div = divisor || 1, b = bias || 0;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let r = 0, g = 0, bl = 0;
        for (let ky = -1; ky <= 1; ky++) {
          const yy = Math.min(h - 1, Math.max(0, y + ky));
          for (let kx = -1; kx <= 1; kx++) {
            const xx = Math.min(w - 1, Math.max(0, x + kx));
            const i = (yy * w + xx) * 4;
            const kv = k[(ky + 1) * 3 + (kx + 1)];
            r += s[i] * kv; g += s[i + 1] * kv; bl += s[i + 2] * kv;
          }
        }
        const o = (y * w + x) * 4;
        d[o] = Math.max(0, Math.min(255, r / div + b));
        d[o + 1] = Math.max(0, Math.min(255, g / div + b));
        d[o + 2] = Math.max(0, Math.min(255, bl / div + b));
        d[o + 3] = s[o + 3];
      }
    }
  }

  define('sharpen', {
    label: 'Sharpen', group: 'Blur & Sharpen',
    description: 'Increase edge contrast to make the image look crisper.',
    params: { amount: numParam('Amount', 0, 3, 0.01, 0.8) }, defaultParams: { amount: 0.8 },
    pixelEffect: true,
    pixelWork(src, dst, w, h, p) {
      const a = clamp(p.amount, 0, 3);
      const kernel = [0, -a, 0, -a, 1 + 4 * a, -a, 0, -a, 0];
      convolve(src.data, dst.data, w, h, kernel, 1, 0);
    },
  });

  define('emboss', {
    label: 'Emboss', group: 'Stylize',
    description: 'Relief-style edge lighting that makes the frame look engraved.',
    params: { amount: numParam('Strength', 0, 2, 0.01, 1) }, defaultParams: { amount: 1 },
    pixelEffect: true,
    pixelWork(src, dst, w, h, p) {
      const a = clamp(p.amount, 0, 2);
      convolve(src.data, dst.data, w, h, [-2 * a, -a, 0, -a, 1, a, 0, a, 2 * a], 1, 128);
    },
  });

  define('edge', {
    label: 'Edge Detect', group: 'Stylize',
    description: 'Highlight edges to produce a line-drawing look.',
    params: { amount: numParam('Strength', 0, 3, 0.01, 1) }, defaultParams: { amount: 1 },
    pixelEffect: true,
    pixelWork(src, dst, w, h, p) {
      const a = clamp(p.amount, 0, 3);
      convolve(src.data, dst.data, w, h, [-a, -a, -a, -a, 8 * a, -a, -a, -a, -a], 1, 0);
    },
  });

  define('threshold', {
    label: 'Threshold', group: 'Stylize',
    description: 'Snap every pixel to pure black or white past a cutoff.',
    params: { level: numParam('Level', 0, 1, 0.01, 0.5) }, defaultParams: { level: 0.5 },
    pixelEffect: true,
    pixelWork(src, dst, w, h, p) {
      const s = src.data, d = dst.data, t = clamp(p.level, 0, 1) * 255;
      for (let i = 0; i < s.length; i += 4) {
        const v = (s[i] + s[i + 1] + s[i + 2]) / 3 >= t ? 255 : 0;
        d[i] = d[i + 1] = d[i + 2] = v;
        d[i + 3] = s[i + 3];
      }
    },
  });

  define('posterize', {
    label: 'Posterize', group: 'Stylize',
    description: 'Reduce the number of colour levels for a banded, poster look.',
    params: { levels: numParam('Levels', 2, 32, 1, 6) }, defaultParams: { levels: 6 },
    pixelEffect: true,
    pixelWork(src, dst, w, h, p) {
      const s = src.data, d = dst.data, n = Math.max(2, Math.round(p.levels));
      const step = 255 / (n - 1);
      for (let i = 0; i < s.length; i += 4) {
        d[i] = Math.round(Math.round(s[i] / step) * step);
        d[i + 1] = Math.round(Math.round(s[i + 1] / step) * step);
        d[i + 2] = Math.round(Math.round(s[i + 2] / step) * step);
        d[i + 3] = s[i + 3];
      }
    },
  });

  define('colorkey', {
    label: 'Colour Key', group: 'Keying',
    description: 'Remove a chosen colour (default green). Use for blue/green screens.',
    params: {
      color: { kind: 'color', label: 'Key colour', default: '#00ff00' },
      tolerance: numParam('Tolerance', 0, 1, 0.01, 0.3),
      softness: numParam('Softness', 0, 1, 0.01, 0.12),
    },
    defaultParams: { color: '#00ff00', tolerance: 0.35, softness: 0.15 },
    pixelEffect: true,
    pixelWork(src, dst, w, h, p) {
      const s = src.data, d = dst.data;
      const hex = String(p.color || '#00ff00').replace('#', '');
      const kr = parseInt(hex.slice(0, 2), 16) || 0;
      const kg = parseInt(pair(hex, 2), 16);
      const kb = parseInt(pair(hex, 4), 16);
      const tol = 0.04 + clamp(p.tolerance, 0, 1) * 0.5;
      const soft = 0.005 + clamp(p.softness, 0, 1) * 0.4;
      for (let i = 0; i < s.length; i += 4) {
        const dr = (s[i] - kr) / 255, dg = (s[i + 1] - kg) / 255, db = (s[i + 2] - kb) / 255;
        const dist = Math.sqrt(dr * dr + dg * dg + db * db);
        let a;
        if (dist <= tol - soft) a = 0;
        else if (dist >= tol + soft) a = 1;
        else a = (dist - (tol - soft)) / (2 * soft);
        d[i] = s[i]; d[i + 1] = s[i + 1]; d[i + 2] = s[i + 2];
        d[i + 3] = s[i + 3] * a;
      }
    },
  });
  function pair(hex, at) { return hex.slice(at, at + 2) || '00'; }
  /* Deterministic 0..1 noise so animated effects strobe identically on every
     render pass (preview and export must agree frame for frame). */
  function hash01(n) { const s = Math.sin(n * 127.1) * 43758.5453; return s - Math.floor(s); }
  /* Rounded rectangle sub-path helper (Path2D.roundRect is not everywhere). */
  function roundRectPath(path, x, y, w, h, r) {
    r = Math.max(0, Math.min(r, w / 2, h / 2));
    path.moveTo(x + r, y);
    path.lineTo(x + w - r, y);
    path.arcTo(x + w, y, x + w, y + r, r);
    path.lineTo(x + w, y + h - r);
    path.arcTo(x + w, y + h, x + w - r, y + h, r);
    path.lineTo(x + r, y + h);
    path.arcTo(x, y + h, x, y + h - r, r);
    path.lineTo(x, y + r);
    path.arcTo(x, y, x + r, y, r);
    path.closePath();
    return path;
  }

  define('chromakey', {
    label: 'Chroma Key (Green Screen)', group: 'Keying',
    description: 'Remove a green background and suppress green spill on edges.',
    params: {
      similarity: numParam('Similarity', 0, 1, 0.01, 0.35),
      smoothness: numParam('Smoothness', 0, 1, 0.01, 0.15),
      spill: numParam('Spill suppression', 0, 1, 0.01, 0.5),
    },
    defaultParams: { similarity: 0.35, smoothness: 0.15, spill: 0.5 },
    pixelEffect: true,
    pixelWork(src, dst, w, h, p) {
      const s = src.data, d = dst.data;
      const sim = 0.08 + clamp(p.similarity, 0, 1) * 0.55;
      const smooth = 0.01 + clamp(p.smoothness, 0, 1) * 0.4;
      const spill = clamp(p.spill, 0, 1);
      for (let i = 0; i < s.length; i += 4) {
        const r = s[i] / 255, g = s[i + 1] / 255, b = s[i + 2] / 255;
        const key = g - Math.max(r, b);
        let a;
        if (key <= sim - smooth) a = 1;
        else if (key >= sim + smooth) a = 0;
        else a = 1 - (key - (sim - smooth)) / (2 * smooth);
        if (spill > 0 && a > 0) {
          const over = Math.max(0, g - Math.max(r, b)) * spill;
          d[i] = clamp((r - over) * 255, 0, 255);
          d[i + 1] = s[i + 1];
          d[i + 2] = clamp((b - over) * 255, 0, 255);
        } else { d[i] = s[i]; d[i + 2] = s[i + 2]; }
        d[i + 1] = s[i + 1];
        d[i + 3] = s[i + 3] * a;
      }
    },
  });

  /* ---- drawn effects (paint over the composed layer) ---- */

  define('vignette', {
    label: 'Vignette', group: 'Stylize',
    description: 'Darken the corners to draw the eye to the centre.',
    params: { strength: numParam('Strength', 0, 1, 0.01, 0.6), softness: numParam('Softness', 0, 1, 0.01, 0.5) },
    defaultParams: { strength: 0.6, softness: 0.5 },
    draw(ctx, w, h, p) {
      const s = clamp(p.strength, 0, 1);
      if (s <= 0.001) return;
      const r = Math.hypot(w, h) / 2;
      const inner = r * (1 - clamp(p.softness, 0.02, 1));
      const g = ctx.createRadialGradient(w / 2, h / 2, inner, w / 2, h / 2, r);
      g.addColorStop(0, 'rgba(0,0,0,0)');
      g.addColorStop(1, `rgba(0,0,0,${s})`);
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, w, h);
    },
  });

  define('letterbox', {
    label: 'Letterbox (Cinematic bars)', group: 'Render',
    description: 'Add black cinema bars to letterbox the frame.',
    params: { amount: numParam('Bars', 0, 0.4, 0.005, 0.115) },
    defaultParams: { amount: 0.115 },
    draw(ctx, w, h, p) {
      const b = clamp(p.amount, 0, 0.49) * h;
      if (b < 0.5) return;
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, w, b);
      ctx.fillRect(0, h - b, w, b);
    },
  });

  define('glow', {
    label: 'Glow', group: 'Stylize',
    description: 'Bloom the bright areas with a soft, dreamy halo.',
    params: { amount: numParam('Amount', 0, 1, 0.01, 0.45), radius: numParam('Radius', 0, 40, 0.5, 10, 'px') },
    defaultParams: { amount: 0.45, radius: 10 },
    draw(ctx, w, h, p, t) {
      const a = clamp(p.amount, 0, 1);
      if (a <= 0.001) return;
      const src = t.glowCanvas || (t.glowCanvas = document.createElement('canvas'));
      if (src.width !== w || src.height !== h) { src.width = w; src.height = h; }
      const sctx = src.getContext('2d');
      sctx.clearRect(0, 0, w, h);
      sctx.drawImage(ctx.canvas, 0, 0);
      ctx.save();
      ctx.globalCompositeOperation = 'screen';
      ctx.globalAlpha = a;
      if (p.radius > 0.01) ctx.filter = `blur(${p.radius}px)`;
      ctx.drawImage(src, 0, 0);
      ctx.restore();
    },
  });

  define('noise', {
    label: 'Film Grain', group: 'Stylize',
    description: 'Overlay animated grain for a filmic texture.',
    params: { amount: numParam('Amount', 0, 1, 0.01, 0.16), size: numParam('Grain size', 1, 4, 1, 1, 'px') },
    defaultParams: { amount: 0.16, size: 1 },
    draw(ctx, w, h, p, t) {
      const a = clamp(p.amount, 0, 1);
      if (a <= 0.001) return;
      const block = Math.max(1, Math.round(p.size));
      const gw = Math.max(2, Math.ceil(w / block)), gh = Math.max(2, Math.ceil(h / block));
      const noise = t.noiseCanvas || (t.noiseCanvas = document.createElement('canvas'));
      if (noise.width !== gw || noise.height !== gh || t.noiseBlock !== block) {
        noise.width = gw; noise.height = gh; t.noiseBlock = block;
        t.noiseData = noise.getContext('2d').createImageData(gw, gh);
      }
      const data = t.noiseData.data;
      const seed = (t.noiseSeed = (t.noiseSeed || 1) * 16807 % 2147483647);
      let s = seed;
      for (let i = 0; i < data.length; i += 4) {
        s = (s * 16807) % 2147483647;
        const v = s % 256;
        data[i] = data[i + 1] = data[i + 2] = v;
        data[i + 3] = 255;
      }
      noise.getContext('2d').putImageData(t.noiseData, 0, 0);
      ctx.save();
      ctx.globalAlpha = a;
      ctx.globalCompositeOperation = 'overlay';
      const prev = ctx.imageSmoothingEnabled;
      ctx.imageSmoothingEnabled = block === 1;
      ctx.drawImage(noise, 0, 0, w, h);
      ctx.imageSmoothingEnabled = prev;
      ctx.restore();
    },
  });

  define('mosaic', {
    label: 'Mosaic (Pixelate)', group: 'Stylize',
    description: 'Replace blocks of pixels with their average for a pixelated look.',
    params: { size: numParam('Block size', 2, 90, 1, 14, 'px') }, defaultParams: { size: 12 },
    draw(ctx, w, h, p, t) {
      const size = Math.max(2, Math.round(p.size));
      // downsample to a block grid, then blow it back up without smoothing
      const sw = Math.max(1, Math.ceil(w / size)), sh = Math.max(1, Math.ceil(h / size));
      const small = scratchCanvas(t, 'mosaicSmall', sw, sh);
      const sctx = small.getContext('2d');
      sctx.setTransform(1, 0, 0, 1, 0, 0);
      sctx.clearRect(0, 0, sw, sh);
      sctx.imageSmoothingEnabled = true;
      sctx.drawImage(ctx.canvas, 0, 0, w, h, 0, 0, sw, sh);
      ctx.save();
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(small, 0, 0, sw, sh, 0, 0, sw * size, sh * size);
      ctx.restore();
    },
  });

  define('mirror', {
    label: 'Mirror', group: 'Distort',
    description: 'Reflect the image across an axis or into four quadrants.',
    params: { mode: { kind: 'select', label: 'Mode', options: [['horizontal', 'Horizontal'], ['vertical', 'Vertical'], ['quad', 'Quad mirror']], default: 'horizontal' } },
    defaultParams: { mode: 'horizontal' },
    draw(ctx, w, h, p, t) {
      const src = t.mirrorCanvas || (t.mirrorCanvas = document.createElement('canvas'));
      if (src.width !== w || src.height !== h) { src.width = w; src.height = h; }
      const sctx = src.getContext('2d');
      sctx.clearRect(0, 0, w, h);
      sctx.drawImage(ctx.canvas, 0, 0);
      ctx.save();
      if (p.mode === 'horizontal' || p.mode === 'quad') {
        ctx.translate(w, 0); ctx.scale(-1, 1);
        ctx.drawImage(src, 0, 0, w / 2, h, w / 2, 0, w / 2, h);
      }
      if (p.mode === 'vertical' || p.mode === 'quad') {
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.translate(0, h); ctx.scale(1, -1);
        ctx.drawImage(src, 0, 0, w, h / 2, 0, 0, w, h / 2);
      }
      ctx.restore();
    },
  });

  define('colortemp', {
    label: 'Colour Temperature', group: 'Color & Tone',
    description: 'Warm up (orange) or cool down (blue) the image.',
    params: { warmth: numParam('Warmth', -1, 1, 0.01, 0) },
    defaultParams: { warmth: 0 },
    draw(ctx, w, h, p) {
      const t = clamp(p.warmth, -1, 1);
      if (Math.abs(t) < 0.002) return;
      ctx.save();
      ctx.globalCompositeOperation = t > 0 ? 'overlay' : 'soft-light';
      ctx.globalAlpha = Math.abs(t) * 0.5;
      ctx.fillStyle = t > 0 ? '#ff9640' : '#4096ff';
      ctx.fillRect(0, 0, w, h);
      ctx.restore();
    },
  });

  define('fade', {
    label: 'Fade In / Out', group: 'Render',
    description: 'Fade the clip up from black and/or down to black.',
    params: { fadeIn: numParam('Fade in', 0, 10, 0.1, 0, 's'), fadeOut: numParam('Fade out', 0, 10, 0.1, 0, 's') },
    defaultParams: { fadeIn: 0, fadeOut: 0 },
    opacityAt(p, local, length, fps) {
      const inF = Math.round((p.fadeIn || 0) * fps), outF = Math.round((p.fadeOut || 0) * fps);
      let o = 1;
      if (inF > 0 && local < inF) o = Math.min(o, local / inF);
      if (outF > 0 && local > length - outF) o = Math.min(o, (length - local) / outF);
      return clamp(o, 0, 1);
    },
  });

  /* ---- more colour grading (CPU pixel passes) ---- */

  const lum = (r, g, b) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
  function hexRGB(hex) {
    const s = String(hex || '#000000').replace('#', '');
    return [parseInt(s.slice(0, 2), 16) || 0, parseInt(pair(s, 2), 16) || 0, parseInt(pair(s, 4), 16) || 0];
  }

  define('levels', {
    label: 'Levels', group: 'Color & Tone',
    description: 'Set the black point, white point and midtone gamma.',
    params: {
      black: numParam('Black point', 0, 0.9, 0.01, 0),
      white: numParam('White point', 0.1, 1, 0.01, 1),
      gamma: numParam('Gamma', 0.2, 4, 0.01, 1),
    },
    defaultParams: { black: 0, white: 1, gamma: 1 },
    pixelEffect: true,
    pixelWork(src, dst, w, h, p) {
      const s = src.data, d = dst.data;
      const bl = clamp(p.black, 0, 0.9), wh = Math.max(bl + 0.02, clamp(p.white, 0.1, 1));
      const inv = 1 / (wh - bl), g = 1 / Math.max(0.05, p.gamma || 1);
      const lut = new Uint8ClampedArray(256);
      for (let i = 0; i < 256; i++) {
        const v = clamp((i / 255 - bl) * inv, 0, 1);
        lut[i] = Math.round(Math.pow(v, g) * 255);
      }
      for (let i = 0; i < s.length; i += 4) {
        d[i] = lut[s[i]]; d[i + 1] = lut[s[i + 1]]; d[i + 2] = lut[s[i + 2]]; d[i + 3] = s[i + 3];
      }
    },
  });

  define('vibrance', {
    label: 'Vibrance', group: 'Color & Tone',
    description: 'Boost the less-saturated colours first, so skin tones stay natural.',
    params: { amount: numParam('Amount', 0, 2, 0.01, 0.6) },
    defaultParams: { amount: 0.6 },
    pixelEffect: true,
    pixelWork(src, dst, w, h, p) {
      const s = src.data, d = dst.data, a = clamp(p.amount, 0, 2);
      for (let i = 0; i < s.length; i += 4) {
        const r = s[i], g = s[i + 1], b = s[i + 2];
        const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
        const sat = (mx - mn) / 255;
        const boost = a * (1 - sat);
        const l = lum(r, g, b);
        d[i] = clamp(r + (r - l) * boost, 0, 255);
        d[i + 1] = clamp(g + (g - l) * boost, 0, 255);
        d[i + 2] = clamp(b + (b - l) * boost, 0, 255);
        d[i + 3] = s[i + 3];
      }
    },
  });

  define('duotone', {
    label: 'Duotone', group: 'Color & Tone',
    description: 'Map the shadows and highlights to two colours for a duotone poster look.',
    params: { shadow: colParam('Shadow colour', '#12183a'), highlight: colParam('Highlight colour', '#ffd166') },
    defaultParams: { shadow: '#12183a', highlight: '#ffd166' },
    pixelEffect: true,
    pixelWork(src, dst, w, h, p) {
      const s = src.data, d = dst.data;
      const [r1, g1, b1] = hexRGB(p.shadow), [r2, g2, b2] = hexRGB(p.highlight);
      for (let i = 0; i < s.length; i += 4) {
        const t = lum(s[i], s[i + 1], s[i + 2]) / 255;
        d[i] = r1 + (r2 - r1) * t;
        d[i + 1] = g1 + (g2 - g1) * t;
        d[i + 2] = b1 + (b2 - b1) * t;
        d[i + 3] = s[i + 3];
      }
    },
  });

  /* ---- stylise (CPU) ---- */

  define('solarize', {
    label: 'Solarize', group: 'Stylize',
    description: 'Partially invert the brighter tones for a photographic solar effect.',
    params: { threshold: numParam('Threshold', 0, 1, 0.01, 0.5) },
    defaultParams: { threshold: 0.5 },
    pixelEffect: true,
    pixelWork(src, dst, w, h, p) {
      const s = src.data, d = dst.data, t = clamp(p.threshold, 0, 1) * 255;
      for (let i = 0; i < s.length; i += 4) {
        d[i] = s[i] < t ? s[i] : 255 - s[i];
        d[i + 1] = s[i + 1] < t ? s[i + 1] : 255 - s[i + 1];
        d[i + 2] = s[i + 2] < t ? s[i + 2] : 255 - s[i + 2];
        d[i + 3] = s[i + 3];
      }
    },
  });

  define('oilpaint', {
    label: 'Oil Paint', group: 'Stylize',
    description: 'Smear colours into flat regions for an oil-painting texture.',
    params: { strength: numParam('Strength', 0, 1, 0.01, 0.7) },
    defaultParams: { strength: 0.7 },
    pixelEffect: true,
    pixelWork(src, dst, w, h, p) {
      const s = src.data, d = dst.data;
      const mix = clamp(p.strength, 0, 1);
      const at = (x, y) => ((Math.min(h - 1, Math.max(0, y)) * w) + Math.min(w - 1, Math.max(0, x))) * 4;
      const quad = (x, y, ox, oy, out) => {
        let sr = 0, sg = 0, sb = 0, sl = 0, sl2 = 0, n = 0;
        for (let j = 0; j <= 1; j++) {
          for (let i = 0; i <= 1; i++) {
            const o = at(x + ox + i, y + oy + j);
            const l = lum(s[o], s[o + 1], s[o + 2]);
            sr += s[o]; sg += s[o + 1]; sb += s[o + 2]; sl += l; sl2 += l * l; n++;
          }
        }
        const mean = sl / n;
        out[0] = sr / n; out[1] = sg / n; out[2] = sb / n;
        out[3] = sl2 / n - mean * mean;                    // variance
        out[4] = mean;
      };
      const q = [0, 0, 0, 0, 0], best = [0, 0, 0];
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          let bestVar = Infinity;
          for (let k = 0; k < 4; k++) {
            quad(x, y, k & 1 ? 0 : -1, k & 2 ? 0 : -1, q);
            if (q[3] < bestVar) { bestVar = q[3]; best[0] = q[0]; best[1] = q[1]; best[2] = q[2]; }
          }
          const o = (y * w + x) * 4;
          d[o] = s[o] + (best[0] - s[o]) * mix;
          d[o + 1] = s[o + 1] + (best[1] - s[o + 1]) * mix;
          d[o + 2] = s[o + 2] + (best[2] - s[o + 2]) * mix;
          d[o + 3] = s[o + 3];
        }
      }
    },
  });

  define('pencil', {
    label: 'Pencil Sketch', group: 'Stylize',
    description: 'Reduce the frame to pencil strokes along its edges.',
    params: { strength: numParam('Strength', 0, 3, 0.01, 1.4), tone: numParam('Paper tone', 0, 1, 0.01, 1) },
    defaultParams: { strength: 1.4, tone: 1 },
    pixelEffect: true,
    pixelWork(src, dst, w, h, p) {
      const s = src.data, d = dst.data;
      const st = clamp(p.strength, 0, 3), paper = clamp(p.tone, 0, 1) * 255;
      const at = (x, y) => (Math.min(h - 1, Math.max(0, y)) * w + Math.min(w - 1, Math.max(0, x))) * 4;
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const c = lum(s[at(x, y)], s[at(x, y) + 1], s[at(x, y) + 2]);
          const l = lum(s[at(x - 1, y)], s[at(x - 1, y) + 1], s[at(x - 1, y) + 2]);
          const r = lum(s[at(x + 1, y)], s[at(x + 1, y) + 1], s[at(x + 1, y) + 2]);
          const u = lum(s[at(x, y - 1)], s[at(x, y - 1) + 1], s[at(x, y - 1) + 2]);
          const dn = lum(s[at(x, y + 1)], s[at(x, y + 1) + 1], s[at(x, y + 1) + 2]);
          const edge = Math.abs(c - l) + Math.abs(c - r) + Math.abs(c - u) + Math.abs(c - dn);
          const o = (y * w + x) * 4;
          const v = clamp(paper - edge * st * 2, 0, 255);
          d[o] = d[o + 1] = d[o + 2] = v;
          d[o + 3] = s[o + 3];
        }
      }
    },
  });

  define('crosshatch', {
    label: 'Crosshatch', group: 'Stylize',
    description: 'Render the frame as engraved crosshatch lines by luminance band.',
    params: { spacing: numParam('Line spacing', 2, 16, 1, 5, 'px'), width: numParam('Line width', 0.5, 6, 0.25, 1.6, 'px') },
    defaultParams: { spacing: 5, width: 1.6 },
    pixelEffect: true,
    pixelWork(src, dst, w, h, p) {
      const s = src.data, d = dst.data;
      const sp = Math.max(2, Math.round(p.spacing)), wd = clamp(p.width, 0.25, 8);
      const a1 = Math.PI / 4, a2 = -Math.PI / 4;
      const c1 = Math.cos(a1), s1 = Math.sin(a1), c2 = Math.cos(a2), s2 = Math.sin(a2);
      for (let i = 0, y = 0; y < h; y++) {
        for (let x = 0; x < w; x++, i += 4) {
          const l = lum(s[i], s[i + 1], s[i + 2]) / 255;
          const m1 = (((x * c1 + y * s1) % sp) + sp) % sp < wd;
          const m2 = (((x * c2 + y * s2) % sp) + sp) % sp < wd;
          const ink = l < 0.25 ? (m1 && m2) : l < 0.5 ? m1 : l < 0.72 ? m2 : false;
          const v = ink ? 30 : 245;
          d[i] = d[i + 1] = d[i + 2] = v;
          d[i + 3] = s[i + 3];
        }
      }
    },
  });

  define('halftone', {
    label: 'Halftone', group: 'Stylize',
    description: 'Reproduce the frame as a printed halftone dot screen.',
    params: { size: numParam('Dot size', 3, 24, 1, 8, 'px'), invert: { kind: 'select', label: 'Ink', options: [['dark', 'Dark dots'], ['light', 'Light dots']], default: 'dark' } },
    defaultParams: { size: 8, invert: 'dark' },
    pixelEffect: true,
    pixelWork(src, dst, w, h, p) {
      const s = src.data, d = dst.data;
      const cell = Math.max(3, Math.round(p.size));
      const cols = Math.ceil(w / cell), rows = Math.ceil(h / cell);
      const avg = new Float32Array(cols * rows);
      const cnt = new Float32Array(cols * rows);
      for (let y = 0; y < h; y++) {
        const cy = Math.floor(y / cell);
        for (let x = 0; x < w; x++) {
          const i = (y * w + x) * 4;
          avg[cy * cols + Math.floor(x / cell)] += lum(s[i], s[i + 1], s[i + 2]);
          cnt[cy * cols + Math.floor(x / cell)]++;
        }
      }
      for (let i = 0; i < avg.length; i++) avg[i] = cnt[i] ? avg[i] / cnt[i] / 255 : 1;
      const light = p.invert === 'light';
      const maxR = cell * 0.78;
      for (let y = 0; y < h; y++) {
        const cy = Math.floor(y / cell);
        for (let x = 0; x < w; x++) {
          const cx = Math.floor(x / cell);
          const t = avg[cy * cols + cx];
          const r = (light ? t : 1 - t) * maxR;
          const dx = x - (cx * cell + cell / 2), dy = y - (cy * cell + cell / 2);
          const v = (dx * dx + dy * dy) <= r * r ? (light ? 255 : 25) : (light ? 25 : 255);
          const i = (y * w + x) * 4;
          d[i] = d[i + 1] = d[i + 2] = v;
          d[i + 3] = s[i + 3];
        }
      }
    },
  });

  define('dither', {
    label: 'Ordered Dither', group: 'Stylize',
    description: 'Quantise the frame with a Bayer screen for a retro dithered look.',
    params: { levels: numParam('Levels', 2, 8, 1, 4) },
    defaultParams: { levels: 4 },
    pixelEffect: true,
    pixelWork(src, dst, w, h, p) {
      const s = src.data, d = dst.data;
      const n = Math.max(2, Math.round(p.levels));
      const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];
      const step = 255 / (n - 1);
      for (let y = 0, i = 0; y < h; y++) {
        const row = (y & 3) * 4;
        for (let x = 0; x < w; x++, i += 4) {
          const th = (BAYER[row + (x & 3)] / 16 - 0.5) * step * 0.9;
          d[i] = clamp(Math.round((s[i] + th) / step) * step, 0, 255);
          d[i + 1] = clamp(Math.round((s[i + 1] + th) / step) * step, 0, 255);
          d[i + 2] = clamp(Math.round((s[i + 2] + th) / step) * step, 0, 255);
          d[i + 3] = s[i + 3];
        }
      }
    },
  });

  /* ---- distort (CPU, nearest-neighbour resampling) ---- */

  function resample(src, dst, w, h, sampler) {
    const s = src.data, d = dst.data;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const o = (y * w + x) * 4;
        const c = sampler(x, y);
        if (!c) { d[o] = s[o]; d[o + 1] = s[o + 1]; d[o + 2] = s[o + 2]; d[o + 3] = s[o + 3]; continue; }
        const i = (c[1] * w + c[0]) * 4;
        d[o] = s[i]; d[o + 1] = s[i + 1]; d[o + 2] = s[i + 2]; d[o + 3] = s[o + 3];
      }
    }
  }

  define('wave', {
    label: 'Wave', group: 'Distort',
    description: 'Ripple the frame with two travelling sine waves.',
    params: {
      amplitudeX: numParam('Amplitude X', 0, 80, 1, 12, 'px'),
      amplitudeY: numParam('Amplitude Y', 0, 80, 1, 6, 'px'),
      frequency: numParam('Frequency', 0.005, 0.3, 0.005, 0.05),
      speed: numParam('Speed', -4, 4, 0.1, 1),
    },
    defaultParams: { amplitudeX: 12, amplitudeY: 6, frequency: 0.05, speed: 1 },
    pixelEffect: true,
    pixelWork(src, dst, w, h, p, t, frameLocal) {
      const ax = p.amplitudeX, ay = p.amplitudeY, f = p.frequency;
      const phase = (frameLocal || 0) * 0.06 * (p.speed || 0);
      resample(src, dst, w, h, (x, y) => [
        clamp(Math.round(x + Math.sin(y * f + phase) * ax), 0, w - 1),
        clamp(Math.round(y + Math.sin(x * f * 0.7 + phase) * ay), 0, h - 1),
      ]);
    },
  });

  define('swirl', {
    label: 'Swirl', group: 'Distort',
    description: 'Twist the frame around its centre.',
    params: { strength: numParam('Strength', -8, 8, 0.1, 2.5), radius: numParam('Radius', 0.05, 1, 0.01, 0.6) },
    defaultParams: { strength: 2.5, radius: 0.6 },
    pixelEffect: true,
    pixelWork(src, dst, w, h, p) {
      const cx = w / 2, cy = h / 2, R = Math.min(w, h) * clamp(p.radius, 0.05, 1);
      resample(src, dst, w, h, (x, y) => {
        const dx = x - cx, dy = y - cy;
        const d = Math.hypot(dx, dy);
        if (d > R || d < 0.001) return null;
        const a = Math.atan2(dy, dx) + p.strength * (1 - d / R);
        return [clamp(Math.round(cx + Math.cos(a) * d), 0, w - 1), clamp(Math.round(cy + Math.sin(a) * d), 0, h - 1)];
      });
    },
  });

  define('fisheye', {
    label: 'Bulge / Pinch', group: 'Distort',
    description: 'Magnify the centre outward (bulge) or pull it inward (pinch).',
    params: { strength: numParam('Strength', -0.9, 0.9, 0.01, 0.4), radius: numParam('Radius', 0.1, 1.6, 0.01, 1) },
    defaultParams: { strength: 0.4, radius: 1 },
    pixelEffect: true,
    pixelWork(src, dst, w, h, p) {
      const cx = w / 2, cy = h / 2;
      const R = Math.hypot(cx, cy) * clamp(p.radius, 0.1, 2);
      const ex = 1 / (1 + clamp(p.strength, -0.9, 0.9));
      resample(src, dst, w, h, (x, y) => {
        const dx = x - cx, dy = y - cy;
        const d = Math.hypot(dx, dy);
        if (d > R || d < 0.001) return null;
        const f = Math.pow(d / R, ex) * R;
        return [clamp(Math.round(cx + (dx / d) * f), 0, w - 1), clamp(Math.round(cy + (dy / d) * f), 0, h - 1)];
      });
    },
  });

  define('ripple', {
    label: 'Ripple', group: 'Distort',
    description: 'Concentric water ripples spreading from the centre.',
    params: { amplitude: numParam('Amplitude', 0, 40, 1, 10, 'px'), frequency: numParam('Frequency', 0.01, 0.5, 0.01, 0.15), speed: numParam('Speed', -6, 6, 0.1, 1.5) },
    defaultParams: { amplitude: 10, frequency: 0.15, speed: 1.5 },
    pixelEffect: true,
    pixelWork(src, dst, w, h, p, t, frameLocal) {
      const cx = w / 2, cy = h / 2;
      const phase = (frameLocal || 0) * 0.12 * (p.speed || 0);
      resample(src, dst, w, h, (x, y) => {
        const dx = x - cx, dy = y - cy;
        const d = Math.hypot(dx, dy) || 0.001;
        const off = Math.sin(d * p.frequency - phase) * p.amplitude;
        return [clamp(Math.round(cx + (dx / d) * (d + off)), 0, w - 1), clamp(Math.round(cy + (dy / d) * (d + off)), 0, h - 1)];
      });
    },
  });

  define('chromatic', {
    label: 'Chromatic Aberration', group: 'Distort',
    description: 'Split the colour channels radially, like a cheap lens.',
    params: { amount: numParam('Amount', 0, 40, 0.5, 8, 'px') },
    defaultParams: { amount: 8 },
    pixelEffect: true,
    pixelWork(src, dst, w, h, p) {
      const s = src.data, d = dst.data;
      const cx = w / 2, cy = h / 2, maxD = Math.hypot(cx, cy) || 1;
      const amt = clamp(p.amount, 0, 60);
      const pick = (x, y) => (Math.min(h - 1, Math.max(0, y)) * w + Math.min(w - 1, Math.max(0, x))) * 4;
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const dx = x - cx, dy = y - cy;
          const k = (Math.hypot(dx, dy) / maxD) * (amt / maxD);
          const o = (y * w + x) * 4;
          d[o] = s[pick(Math.round(x + dx * k), Math.round(y + dy * k))];
          d[o + 1] = s[o + 1];
          d[o + 2] = s[pick(Math.round(x - dx * k), Math.round(y - dy * k)) + 2];
          d[o + 3] = s[o + 3];
        }
      }
    },
  });

  /* ---- drawn overlays (GPU compositing) ---- */

  function scratchCanvas(t, key, w, h) {
    if (!t) t = scratchCanvas._fallback || (scratchCanvas._fallback = {});
    const c = t[key] || (t[key] = document.createElement('canvas'));
    if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
    return c;
  }

  define('scanlines', {
    label: 'Scan Lines', group: 'Stylize',
    description: 'Overlay CRT scan lines across the frame.',
    params: { spacing: numParam('Spacing', 2, 8, 1, 3, 'px'), opacity: numParam('Opacity', 0, 1, 0.01, 0.35), speed: numParam('Roll speed', -4, 4, 0.1, 0) },
    defaultParams: { spacing: 3, opacity: 0.35, speed: 0 },
    draw(ctx, w, h, p, t, frameLocal) {
      const sp = Math.max(2, Math.round(p.spacing));
      const off = ((frameLocal || 0) * (p.speed || 0)) % sp;
      ctx.save();
      ctx.globalAlpha = clamp(p.opacity, 0, 1);
      ctx.fillStyle = '#000';
      for (let y = off - sp; y < h; y += sp) ctx.fillRect(0, y, w, Math.max(1, sp * 0.45));
      ctx.restore();
    },
  });

  define('vhs', {
    label: 'VHS', group: 'Stylize',
    description: 'Worn videotape look: tracking wobble, noise band and colour bleed.',
    params: { wobble: numParam('Wobble', 0, 1, 0.01, 0.4), noise: numParam('Noise', 0, 1, 0.01, 0.25) },
    defaultParams: { wobble: 0.4, noise: 0.25 },
    draw(ctx, w, h, p, t, frameLocal) {
      const f = frameLocal || 0;
      const src = scratchCanvas(t, 'vhsSrc', w, h);
      const sctx = src.getContext('2d');
      sctx.setTransform(1, 0, 0, 1, 0, 0);
      sctx.globalCompositeOperation = 'source-over';
      sctx.clearRect(0, 0, w, h);
      sctx.drawImage(ctx.canvas, 0, 0);
      const wob = clamp(p.wobble, 0, 1);
      // tracking: shift one band of the picture sideways, drawn over the original
      // (never cleared, so the layer can never end up with transparent holes)
      const bandH = Math.max(4, Math.min(h, h * 0.06));
      const bandY = Math.max(0, Math.min(h - bandH, ((f * 3.1) % (h + 240)) - 120));
      const dx = Math.sin(f * 0.7) * w * 0.04 * wob;
      ctx.save();
      ctx.drawImage(src, 0, bandY, w, bandH, dx, bandY, w, bandH);
      ctx.restore();
      // colour fringe + grain
      ctx.save();
      ctx.globalCompositeOperation = 'screen';
      ctx.globalAlpha = clamp(p.noise, 0, 1) * 0.18;
      ctx.fillStyle = '#3a2f6a';
      ctx.fillRect(0, bandY, w, bandH);
      ctx.restore();
      ctx.save();
      ctx.globalAlpha = 0.5;
      ctx.fillStyle = '#000';
      for (let y = (f % 3); y < h; y += 3) ctx.fillRect(0, y, w, 1);
      ctx.restore();
    },
  });

  define('oldfilm', {
    label: 'Old Film', group: 'Stylize',
    description: 'Flicker, dust, scratches and a warm cast for aged footage.',
    params: { grain: numParam('Grain', 0, 1, 0.01, 0.22), scratches: numParam('Scratches', 0, 1, 0.01, 0.5), flicker: numParam('Flicker', 0, 1, 0.01, 0.35) },
    defaultParams: { grain: 0.22, scratches: 0.5, flicker: 0.35 },
    draw(ctx, w, h, p, t, frameLocal) {
      const f = Math.round(frameLocal || 0);
      // warm cast
      ctx.save();
      ctx.globalCompositeOperation = 'overlay';
      ctx.globalAlpha = 0.22;
      ctx.fillStyle = '#c8a05a';
      ctx.fillRect(0, 0, w, h);
      ctx.restore();
      // scratches
      const sc = clamp(p.scratches, 0, 1);
      if (sc > 0.002) {
        ctx.save();
        ctx.globalAlpha = sc * 0.5;
        ctx.strokeStyle = 'rgba(255,255,255,0.8)';
        ctx.lineWidth = 1;
        const n = Math.round(sc * 4);
        for (let i = 0; i < n; i++) {
          const seed = f * 13.7 + i * 91.3;
          const x = (hash01(seed) * w) | 0;
          ctx.beginPath();
          ctx.moveTo(x, 0);
          ctx.lineTo(x + (hash01(seed + 1) - 0.5) * 6, h);
          ctx.stroke();
        }
        ctx.restore();
      }
      // dust
      if (sc > 0.002) {
        ctx.save();
        ctx.globalAlpha = sc * 0.6;
        ctx.fillStyle = '#100c08';
        for (let i = 0; i < Math.round(sc * 26); i++) {
          const seed = f * 7.3 + i * 37.1;
          const x = hash01(seed) * w, y = hash01(seed + 5) * h;
          const r = 0.6 + hash01(seed + 9) * 2.2;
          ctx.beginPath();
          ctx.arc(x, y, r, 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.restore();
      }
      // flicker
      const fl = clamp(p.flicker, 0, 1);
      if (fl > 0.002) {
        ctx.save();
        ctx.globalAlpha = fl * 0.16 * (hash01(f * 3.11) * 2 - 1);
        ctx.fillStyle = '#000';
        ctx.fillRect(0, 0, w, h);
        ctx.restore();
      }
      // grain
      const gr = clamp(p.grain, 0, 1);
      if (gr > 0.002) {
        const c = scratchCanvas(t, 'filmGrain', Math.max(2, w >> 1), Math.max(2, h >> 1));
        const g = c.getContext('2d');
        const img = g.createImageData(c.width, c.height);
        let s = (f * 2654435761) >>> 0 || 1;
        for (let i = 0; i < img.data.length; i += 4) {
          s = (s * 1664525 + 1013904223) >>> 0;
          const v = (s >>> 24);
          img.data[i] = img.data[i + 1] = img.data[i + 2] = v;
          img.data[i + 3] = 255;
        }
        g.putImageData(img, 0, 0);
        ctx.save();
        ctx.globalAlpha = gr * 0.5;
        ctx.globalCompositeOperation = 'overlay';
        ctx.drawImage(c, 0, 0, w, h);
        ctx.restore();
      }
    },
  });

  define('lightleak', {
    label: 'Light Leak', group: 'Stylize',
    description: 'Bleed a warm light leak across the frame from one corner.',
    params: { amount: numParam('Amount', 0, 1, 0.01, 0.45), angle: numParam('Angle', -180, 180, 1, 35, ' deg'), speed: numParam('Drift', -3, 3, 0.1, 0.6) },
    defaultParams: { amount: 0.45, angle: 35, speed: 0.6 },
    draw(ctx, w, h, p, t, frameLocal) {
      const a = clamp(p.amount, 0, 1);
      if (a <= 0.002) return;
      const drift = Math.sin((frameLocal || 0) * 0.02 * (p.speed || 0)) * 0.12;
      const rad = ((p.angle || 0) + drift * 60) * Math.PI / 180;
      const cx = w / 2 + Math.cos(rad) * w * (0.55 + drift);
      const cy = h / 2 + Math.sin(rad) * h * (0.55 + drift);
      const r = Math.hypot(w, h) * 0.85;
      ctx.save();
      ctx.globalCompositeOperation = 'screen';
      ctx.globalAlpha = a;
      const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
      g.addColorStop(0, 'rgba(255,236,180,0.95)');
      g.addColorStop(0.25, 'rgba(255,150,70,0.55)');
      g.addColorStop(0.6, 'rgba(190,60,90,0.22)');
      g.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, w, h);
      ctx.restore();
    },
  });

  define('glitch', {
    label: 'Glitch', group: 'Stylize',
    description: 'Slice, offset and colour-shift the frame like a broken signal.',
    params: { amount: numParam('Amount', 0, 1, 0.01, 0.5), slices: numParam('Slices', 2, 30, 1, 12) },
    defaultParams: { amount: 0.5, slices: 12 },
    draw(ctx, w, h, p, t, frameLocal) {
      const a = clamp(p.amount, 0, 1);
      if (a <= 0.002) return;
      const f = Math.round(frameLocal || 0);
      const src = scratchCanvas(t, 'glitchSrc', w, h);
      const sctx = src.getContext('2d');
      sctx.clearRect(0, 0, w, h);
      sctx.drawImage(ctx.canvas, 0, 0);
      // only glitch on some frames so it strobes rather than smears
      if (hash01(f * 1.7) > 0.75) return;
      const n = Math.max(2, Math.round(p.slices));
      ctx.save();
      for (let i = 0; i < n; i++) {
        if (hash01(f * 3.3 + i * 17.1) > a) continue;
        const y = hash01(f * 5.1 + i * 29.3) * h;
        const bh = 2 + hash01(f * 7.7 + i * 41.9) * (h / 12);
        const dx = (hash01(f * 9.3 + i * 53.7) - 0.5) * w * 0.22 * a;
        ctx.drawImage(src, 0, y, w, bh, dx, y, w, bh);
      }
      ctx.restore();
      // channel tint on the shifted slices
      ctx.save();
      ctx.globalCompositeOperation = 'screen';
      ctx.globalAlpha = a * 0.22;
      ctx.fillStyle = '#ff2e6a';
      ctx.fillRect(0, 0, w, h);
      ctx.restore();
    },
  });

  define('zoomblur', {
    label: 'Zoom Blur', group: 'Blur & Sharpen',
    description: 'Radial streaks from the centre, as if zooming during the exposure.',
    params: { amount: numParam('Amount', 0, 1, 0.01, 0.4), steps: numParam('Steps', 2, 24, 1, 10) },
    defaultParams: { amount: 0.4, steps: 10 },
    draw(ctx, w, h, p, t) {
      const a = clamp(p.amount, 0, 1);
      if (a <= 0.002) return;
      const src = scratchCanvas(t, 'zoomSrc', w, h);
      const sctx = src.getContext('2d');
      sctx.clearRect(0, 0, w, h);
      sctx.drawImage(ctx.canvas, 0, 0);
      const steps = Math.max(2, Math.round(p.steps));
      ctx.save();
      ctx.globalAlpha = a / steps;
      for (let i = 1; i <= steps; i++) {
        const s = 1 + (i / steps) * 0.22 * a;
        ctx.setTransform(s, 0, 0, s, (w / 2) * (1 - s), (h / 2) * (1 - s));
        ctx.drawImage(src, 0, 0);
      }
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.restore();
    },
  });

  define('motionblur', {
    label: 'Motion Blur', group: 'Blur & Sharpen',
    description: 'Directional smear, as if the subject moved during the exposure.',
    params: { angle: numParam('Angle', -180, 180, 1, 0, ' deg'), distance: numParam('Distance', 0, 120, 1, 28, 'px'), steps: numParam('Steps', 2, 24, 1, 10) },
    defaultParams: { angle: 0, distance: 28, steps: 10 },
    draw(ctx, w, h, p, t) {
      const dist = clamp(p.distance, 0, 200);
      if (dist < 0.5) return;
      const src = scratchCanvas(t, 'motionSrc', w, h);
      const sctx = src.getContext('2d');
      sctx.clearRect(0, 0, w, h);
      sctx.drawImage(ctx.canvas, 0, 0);
      const rad = (p.angle || 0) * Math.PI / 180;
      const dx = Math.cos(rad), dy = Math.sin(rad);
      const steps = Math.max(2, Math.round(p.steps));
      ctx.save();
      ctx.globalAlpha = 1 / steps;
      for (let i = 1; i <= steps; i++) {
        const off = (i / steps) * dist;
        ctx.drawImage(src, dx * off, dy * off);
      }
      ctx.restore();
    },
  });

  define('kaleidoscope', {
    label: 'Kaleidoscope', group: 'Distort',
    description: 'Mirror the frame into rotating wedges.',
    params: { segments: numParam('Segments', 2, 16, 1, 6), angle: numParam('Angle', -180, 180, 1, 0, ' deg') },
    defaultParams: { segments: 6, angle: 0 },
    draw(ctx, w, h, p, t) {
      const src = scratchCanvas(t, 'kaleidoSrc', w, h);
      const sctx = src.getContext('2d');
      sctx.clearRect(0, 0, w, h);
      sctx.drawImage(ctx.canvas, 0, 0);
      const seg = Math.max(2, Math.round(p.segments));
      const wedge = (Math.PI * 2) / seg;
      const R = Math.hypot(w, h);
      ctx.save();
      ctx.clearRect(0, 0, w, h);
      ctx.translate(w / 2, h / 2);
      ctx.rotate(((p.angle || 0) * Math.PI) / 180);
      for (let i = 0; i < seg; i++) {
        ctx.save();
        ctx.rotate(i * wedge);
        ctx.beginPath();
        ctx.moveTo(0, 0);
        ctx.arc(0, 0, R, 0, wedge);
        ctx.closePath();
        ctx.clip();
        if (i % 2) ctx.scale(-1, 1);
        ctx.drawImage(src, -w / 2, -h / 2);
        ctx.restore();
      }
      ctx.restore();
    },
  });

  define('extrude', {
    label: 'Extrude', group: 'Distort',
    description: 'Drag the frame out into 3D-looking slabs from its brightest shapes.',
    params: { depth: numParam('Depth', 0, 120, 1, 34, 'px'), angle: numParam('Angle', -180, 180, 1, 135, ' deg') },
    defaultParams: { depth: 34, angle: 135 },
    draw(ctx, w, h, p, t) {
      const depth = clamp(p.depth, 0, 200);
      if (depth < 1) return;
      const src = scratchCanvas(t, 'extrudeSrc', w, h);
      const sctx = src.getContext('2d');
      sctx.clearRect(0, 0, w, h);
      sctx.drawImage(ctx.canvas, 0, 0);
      const rad = ((p.angle || 0) * Math.PI) / 180;
      const dx = Math.cos(rad), dy = Math.sin(rad);
      ctx.save();
      for (let i = 1; i <= 12; i++) {
        const f = i / 12;
        ctx.globalAlpha = 0.9 * (1 - f * 0.85);
        ctx.drawImage(src, -dx * depth * f, -dy * depth * f);
      }
      ctx.restore();
    },
  });

  /* ---- render / framing ---- */

  define('border', {
    label: 'Border', group: 'Render',
    description: 'Draw a coloured frame around the clip.',
    params: { size: numParam('Thickness', 0, 0.2, 0.002, 0.03), color: colParam('Colour', '#0d0f14'), radius: numParam('Rounded', 0, 0.5, 0.01, 0) },
    defaultParams: { size: 0.03, color: '#0d0f14', radius: 0 },
    draw(ctx, w, h, p) {
      const s = clamp(p.size, 0, 0.49);
      if (s <= 0.0005) return;
      const bw = Math.min(w, h) * s;
      const r = Math.min(bw / 2, clamp(p.radius, 0, 0.5) * Math.min(w, h));
      // one path: outer rect + inner hole, clipped even-odd -> a frame
      const path = new Path2D();
      path.rect(0, 0, w, h);
      if (r > 0.5) roundRectPath(path, bw, bw, w - bw * 2, h - bw * 2, r);
      else path.rect(bw, bw, w - bw * 2, h - bw * 2);
      ctx.save();
      ctx.fillStyle = p.color || '#000';
      ctx.clip(path, 'evenodd');
      ctx.fillRect(0, 0, w, h);
      ctx.restore();
    },
  });

  define('shadow', {
    label: 'Drop Shadow', group: 'Render',
    description: 'Cast a soft shadow behind the clip, useful for titles over video.',
    params: { distance: numParam('Distance', 0, 0.25, 0.005, 0.05), angle: numParam('Angle', -180, 180, 1, 135, ' deg'), blur: numParam('Softness', 0, 60, 1, 18, 'px'), opacity: numParam('Opacity', 0, 1, 0.01, 0.55) },
    defaultParams: { distance: 0.05, angle: 135, blur: 18, opacity: 0.55 },
    draw(ctx, w, h, p, t) {
      const op = clamp(p.opacity, 0, 1);
      if (op <= 0.002) return;
      // snapshot the clip, build a black silhouette from it, lay the shadow down,
      // then put the original back on top so only the offset edge stays visible
      const src = scratchCanvas(t, 'shadowSrc', w, h);
      const sctx = src.getContext('2d');
      sctx.setTransform(1, 0, 0, 1, 0, 0);
      sctx.globalCompositeOperation = 'source-over';
      sctx.clearRect(0, 0, w, h);
      sctx.drawImage(ctx.canvas, 0, 0);
      const sil = scratchCanvas(t, 'shadowSil', w, h);
      const vctx = sil.getContext('2d');
      vctx.setTransform(1, 0, 0, 1, 0, 0);
      vctx.globalCompositeOperation = 'source-over';
      vctx.clearRect(0, 0, w, h);
      vctx.drawImage(src, 0, 0);
      vctx.globalCompositeOperation = 'source-in';
      vctx.fillStyle = '#000';
      vctx.fillRect(0, 0, w, h);
      vctx.globalCompositeOperation = 'source-over';
      const rad = ((p.angle || 0) * Math.PI) / 180;
      const d = clamp(p.distance, 0, 0.5) * Math.min(w, h);
      ctx.save();
      ctx.globalAlpha = op;
      if (p.blur > 0.5) ctx.filter = `blur(${p.blur}px)`;
      ctx.drawImage(sil, Math.cos(rad) * d, Math.sin(rad) * d);
      ctx.restore();
      ctx.drawImage(src, 0, 0);
    },
  });

  define('background', {
    label: 'Blurred Background', group: 'Render',
    description: 'Pad a clip to fill the frame with a blurred, scaled copy behind it.',
    params: { blur: numParam('Blur', 0, 80, 1, 26, 'px'), scale: numParam('Zoom', 1, 3, 0.01, 1.6), dim: numParam('Dim', 0, 1, 0.01, 0.25) },
    defaultParams: { blur: 26, scale: 1.6, dim: 0.25 },
    draw(ctx, w, h, p, t) {
      const src = scratchCanvas(t, 'bgSrc', w, h);
      const sctx = src.getContext('2d');
      sctx.clearRect(0, 0, w, h);
      sctx.drawImage(ctx.canvas, 0, 0);
      const s = clamp(p.scale, 1, 4);
      ctx.save();
      if (p.blur > 0.5) ctx.filter = `blur(${p.blur}px)`;
      ctx.setTransform(s, 0, 0, s, (w / 2) * (1 - s), (h / 2) * (1 - s));
      ctx.drawImage(src, 0, 0, w, h);
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.filter = 'none';
      const dm = clamp(p.dim, 0, 1);
      if (dm > 0.002) { ctx.globalAlpha = dm; ctx.fillStyle = '#000'; ctx.fillRect(0, 0, w, h); }
      ctx.restore();
      ctx.drawImage(src, 0, 0, w, h);
    },
  });

  /* ---- second wave: colour science, restoration, stylise, distort, render ---- */

  /* Parse "#rrggbb" into a normalised [r,g,b] triple (0..1). */
  function rgb01(hex) {
    const h = String(hex || '#000000').replace('#', '');
    return [
      (parseInt(h.slice(0, 2), 16) || 0) / 255,
      (parseInt(pair(h, 2), 16) || 0) / 255,
      (parseInt(pair(h, 4), 16) || 0) / 255,
    ];
  }
  const smoothstep = (a, b, t) => { const k = clamp((t - a) / ((b - a) || 1e-6), 0, 1); return k * k * (3 - 2 * k); };

  /* Reusable typed-array work planes so heavy pixel passes do not allocate a
     fresh megabyte buffer on every rendered frame. */
  const fallbackScratch = {};
  function plane(scratch, key, len) {
    const t = scratch || fallbackScratch;
    let a = t[key];
    if (!a || a.length !== len) a = t[key] = new Float32Array(len);
    return a;
  }
  /* Reuse the shared scratch canvases for the separable blur passes. */
  function blurPlane(scratch, w, h, src, radius) {
    const step = Math.max(2, Math.round(radius));
    const sw = Math.max(1, Math.ceil(w / step)), sh = Math.max(1, Math.ceil(h / step));
    const full = scratchCanvas(scratch, 'blurFull', w, h);
    const small = scratchCanvas(scratch, 'blurSmall', sw, sh);
    const fctx = full.getContext('2d'), sctx = small.getContext('2d');
    fctx.putImageData(src, 0, 0);
    sctx.clearRect(0, 0, sw, sh);
    sctx.drawImage(full, 0, 0, w, h, 0, 0, sw, sh);
    return { data: sctx.getImageData(0, 0, sw, sh).data, sw, sh };
  }
  /* Sobel gradient magnitude of the luma plane, written into `out`. */
  function sobelLuma(lum, out, w, h) {
    const at = (x, y) => lum[Math.min(h - 1, Math.max(0, y)) * w + Math.min(w - 1, Math.max(0, x))];
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const gx = -at(x - 1, y - 1) + at(x + 1, y - 1) - 2 * at(x - 1, y) + 2 * at(x + 1, y) - at(x - 1, y + 1) + at(x + 1, y + 1);
        const gy = -at(x - 1, y - 1) - 2 * at(x, y - 1) - at(x + 1, y - 1) + at(x - 1, y + 1) + 2 * at(x, y + 1) + at(x + 1, y + 1);
        out[y * w + x] = Math.hypot(gx, gy);
      }
    }
  }
  function tcStr(frames, fps) {
    const f = Math.max(0, Math.round(frames)), r = Math.max(1, Math.round(fps));
    const total = Math.floor(f / r), ff = f % r;
    const p2 = (n) => ('0' + n).slice(-2);
    return `${p2(Math.floor(total / 3600) % 24)}:${p2(Math.floor(total / 60) % 60)}:${p2(total % 60)}:${p2(ff)}`;
  }

  define('grade', {
    label: 'Colour Grade', group: 'Color & Tone',
    description: 'Lift shadows, midtones and highlights independently, then warm or cool the tint.',
    params: {
      shadows: numParam('Shadows', -1, 1, 0.01, 0.1),
      midtones: numParam('Midtones', -1, 1, 0.01, 0.05),
      highlights: numParam('Highlights', -1, 1, 0.01, -0.05),
      contrast: numParam('Contrast', 0.4, 2, 0.01, 1),
      warmth: numParam('Warmth', -1, 1, 0.01, 0),
    },
    defaultParams: { shadows: 0.1, midtones: 0.05, highlights: -0.05, contrast: 1, warmth: 0 },
    pixelEffect: true,
    pixelWork(src, dst, w, h, p) {
      const s = src.data, d = dst.data;
      const sh = clamp(p.shadows, -1, 1) * 70;
      const mid = clamp(p.midtones, -1, 1) * 50;
      const hi = clamp(p.highlights, -1, 1) * 70;
      const c = clamp(p.contrast, 0.2, 2);
      const warm = clamp(p.warmth, -1, 1) * 45;
      for (let i = 0; i < s.length; i += 4) {
        const L = (s[i] * 0.2126 + s[i + 1] * 0.7152 + s[i + 2] * 0.0722) / 255;
        const lift = sh * Math.exp(-Math.pow(L / 0.35, 2)) + mid * Math.exp(-Math.pow((L - 0.5) / 0.28, 2)) + hi * Math.exp(-Math.pow((L - 1) / 0.35, 2));
        d[i] = clamp((s[i] - 128) * c + 128 + lift + warm, 0, 255);
        d[i + 1] = clamp((s[i + 1] - 128) * c + 128 + lift, 0, 255);
        d[i + 2] = clamp((s[i + 2] - 128) * c + 128 + lift - warm, 0, 255);
        d[i + 3] = s[i + 3];
      }
    },
  });

  define('whitebalance', {
    label: 'White Balance', group: 'Color & Tone',
    description: 'Correct the colour temperature and the green/magenta tint of a shot.',
    params: {
      temperature: numParam('Temperature', -1, 1, 0.01, 0.15),
      tint: numParam('Tint', -1, 1, 0.01, 0),
      strength: numParam('Strength', 0, 1, 0.01, 1),
    },
    defaultParams: { temperature: 0.15, tint: 0, strength: 1 },
    pixelEffect: true,
    pixelWork(src, dst, w, h, p) {
      const s = src.data, d = dst.data;
      const k = clamp(p.strength, 0, 1);
      const t = clamp(p.temperature, -1, 1) * 55 * k;
      const ti = clamp(p.tint, -1, 1) * 45 * k;
      for (let i = 0; i < s.length; i += 4) {
        d[i] = clamp(s[i] + t + ti * 0.5, 0, 255);
        d[i + 1] = clamp(s[i + 1] - ti, 0, 255);
        d[i + 2] = clamp(s[i + 2] - t + ti * 0.5, 0, 255);
        d[i + 3] = s[i + 3];
      }
    },
  });

  define('autolevels', {
    label: 'Auto Levels', group: 'Color & Tone',
    description: 'Stretch every colour channel across the full range for a balanced, punchy frame.',
    params: {
      amount: numParam('Amount', 0, 1, 0.01, 1),
      clip: numParam('Clipping', 0, 0.1, 0.001, 0.005),
    },
    defaultParams: { amount: 1, clip: 0.005 },
    pixelEffect: true,
    pixelWork(src, dst, w, h, p) {
      const s = src.data, d = dst.data;
      const hist = [new Uint32Array(256), new Uint32Array(256), new Uint32Array(256)];
      for (let i = 0; i < s.length; i += 4) { hist[0][s[i]]++; hist[1][s[i + 1]]++; hist[2][s[i + 2]]++; }
      const cut = clamp(p.clip, 0, 0.1) * ((s.length / 4) || 1);
      const k = clamp(p.amount, 0, 1);
      const lut = [];
      for (let c = 0; c < 3; c++) {
        let acc = 0, lo = 0, hi = 255;
        for (let v = 0; v < 256; v++) { acc += hist[c][v]; if (acc > cut) { lo = v; break; } }
        acc = 0;
        for (let v = 255; v >= 0; v--) { acc += hist[c][v]; if (acc > cut) { hi = v; break; } }
        const span = Math.max(1, hi - lo);
        const t = new Uint8Array(256);
        for (let v = 0; v < 256; v++) {
          const stretched = clamp(((v - lo) * 255) / span, 0, 255);
          t[v] = v + (stretched - v) * k;
        }
        lut.push(t);
      }
      for (let i = 0; i < s.length; i += 4) {
        d[i] = lut[0][s[i]];
        d[i + 1] = lut[1][s[i + 1]];
        d[i + 2] = lut[2][s[i + 2]];
        d[i + 3] = s[i + 3];
      }
    },
  });

  define('bleach', {
    label: 'Bleach Bypass', group: 'Color & Tone',
    description: 'The silver-retention look: desaturated, contrasty and slightly blown out.',
    params: {
      amount: numParam('Amount', 0, 1, 0.01, 0.8),
      contrast: numParam('Contrast', 0.5, 2.5, 0.01, 1.35),
    },
    defaultParams: { amount: 0.8, contrast: 1.35 },
    pixelEffect: true,
    pixelWork(src, dst, w, h, p) {
      const s = src.data, d = dst.data;
      const a = clamp(p.amount, 0, 1), c = clamp(p.contrast, 0.2, 2.5);
      for (let i = 0; i < s.length; i += 4) {
        const L = s[i] * 0.2126 + s[i + 1] * 0.7152 + s[i + 2] * 0.0722;
        for (let ch = 0; ch < 3; ch++) {
          const base = s[i + ch];
          const desat = base + (L - base) * 0.85;
          const con = (desat - 128) * c + 128;
          d[i + ch] = clamp(base + (con - base) * a, 0, 255);
        }
        d[i + 3] = s[i + 3];
      }
    },
  });

  define('splittone', {
    label: 'Split Toning', group: 'Color & Tone',
    description: 'Tint the shadows one colour and the highlights another, like a graded film print.',
    params: {
      shadow: colParam('Shadow tint', '#1a3b6e'),
      highlight: colParam('Highlight tint', '#e0a568'),
      balance: numParam('Balance', 0, 1, 0.01, 0.5),
      strength: numParam('Strength', 0, 1, 0.01, 0.5),
    },
    defaultParams: { shadow: '#1a3b6e', highlight: '#e0a568', balance: 0.5, strength: 0.5 },
    pixelEffect: true,
    pixelWork(src, dst, w, h, p) {
      const s = src.data, d = dst.data;
      const A = rgb01(p.shadow), B = rgb01(p.highlight);
      const bal = clamp(p.balance, 0, 1), str = clamp(p.strength, 0, 1) * 255;
      for (let i = 0; i < s.length; i += 4) {
        const L = (s[i] * 0.2126 + s[i + 1] * 0.7152 + s[i + 2] * 0.0722) / 255;
        const t = smoothstep(bal - 0.5, bal + 0.5, L);
        for (let ch = 0; ch < 3; ch++) {
          const tint = A[ch] + (B[ch] - A[ch]) * t;
          d[i + ch] = clamp(s[i + ch] + (tint - 0.5) * str, 0, 255);
        }
        d[i + 3] = s[i + 3];
      }
    },
  });

  define('clarity', {
    label: 'Clarity', group: 'Blur & Sharpen',
    description: 'Boost local midtone contrast for a crisp, three-dimensional look without halos.',
    params: {
      amount: numParam('Amount', 0, 2, 0.01, 0.6),
      radius: numParam('Radius', 1, 40, 1, 12, 'px'),
    },
    defaultParams: { amount: 0.6, radius: 12 },
    pixelEffect: true,
    pixelWork(src, dst, w, h, p, scratch) {
      const s = src.data, d = dst.data;
      const a = clamp(p.amount, 0, 2);
      const blur = blurPlane(scratch, w, h, src, clamp(p.radius, 1, 40));
      const bd = blur.data, sw = blur.sw, sh = blur.sh;
      for (let y = 0; y < h; y++) {
        const by = Math.min(sh - 1, (y * sh / h) | 0);
        for (let x = 0; x < w; x++) {
          const bi = (by * sw + Math.min(sw - 1, (x * sw / w) | 0)) * 4;
          const o = (y * w + x) * 4;
          const L = s[o] * 0.2126 + s[o + 1] * 0.7152 + s[o + 2] * 0.0722;
          const LB = bd[bi] * 0.2126 + bd[bi + 1] * 0.7152 + bd[bi + 2] * 0.0722;
          const diff = (L - LB) * a * (1 - Math.abs(L / 255 - 0.5) * 0.9) * 0.85;
          d[o] = clamp(s[o] + diff, 0, 255);
          d[o + 1] = clamp(s[o + 1] + diff, 0, 255);
          d[o + 2] = clamp(s[o + 2] + diff, 0, 255);
          d[o + 3] = s[o + 3];
        }
      }
    },
  });

  define('softfocus', {
    label: 'Soft Focus', group: 'Blur & Sharpen',
    description: 'Diffuse highlight bloom that gives a dreamy, flattering glow to skin and lights.',
    params: {
      amount: numParam('Amount', 0, 1, 0.01, 0.5),
      radius: numParam('Radius', 2, 60, 1, 18, 'px'),
      threshold: numParam('Threshold', 0, 1, 0.01, 0.55),
    },
    defaultParams: { amount: 0.5, radius: 18, threshold: 0.55 },
    pixelEffect: true,
    pixelWork(src, dst, w, h, p, scratch) {
      const s = src.data, d = dst.data;
      const amt = clamp(p.amount, 0, 1);
      const thr = clamp(p.threshold, 0, 0.98);
      const blur = blurPlane(scratch, w, h, src, clamp(p.radius, 2, 60));
      const bd = blur.data, sw = blur.sw, sh = blur.sh;
      for (let y = 0; y < h; y++) {
        const by = Math.min(sh - 1, (y * sh / h) | 0);
        for (let x = 0; x < w; x++) {
          const bi = (by * sw + Math.min(sw - 1, (x * sw / w) | 0)) * 4;
          const o = (y * w + x) * 4;
          const LB = (bd[bi] * 0.2126 + bd[bi + 1] * 0.7152 + bd[bi + 2] * 0.0722) / 255;
          const gate = clamp((LB - thr) / (1 - thr || 1e-6), 0, 1) * amt * 2.2;
          for (let ch = 0; ch < 3; ch++) {
            const glow = Math.min(255, bd[bi + ch] * Math.min(1, gate));
            d[o + ch] = 255 - ((255 - s[o + ch]) * (255 - glow)) / 255;
          }
          d[o + 3] = s[o + 3];
        }
      }
    },
  });

  define('noisereduce', {
    label: 'Noise Reduction', group: 'Blur & Sharpen',
    description: 'Smooth sensor grain while holding edges crisp, using a selective 3x3 average.',
    params: { strength: numParam('Strength', 0, 3, 0.01, 1) }, defaultParams: { strength: 1 },
    pixelEffect: true,
    pixelWork(src, dst, w, h, p) {
      const s = src.data, d = dst.data;
      const tol = 14 + clamp(p.strength, 0, 3) * 26;
      const tol2 = tol * tol * 3;
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const o = (y * w + x) * 4;
          const r = s[o], g = s[o + 1], b = s[o + 2];
          let ar = r, ag = g, ab = b, n = 1;
          for (let ky = -1; ky <= 1; ky++) {
            const yy = y + ky; if (yy < 0 || yy >= h) continue;
            for (let kx = -1; kx <= 1; kx++) {
              if (!kx && !ky) continue;
              const xx = x + kx; if (xx < 0 || xx >= w) continue;
              const i = (yy * w + xx) * 4;
              const dr = s[i] - r, dg = s[i + 1] - g, db = s[i + 2] - b;
              if (dr * dr + dg * dg + db * db > tol2) continue;
              ar += s[i]; ag += s[i + 1]; ab += s[i + 2]; n++;
            }
          }
          d[o] = ar / n; d[o + 1] = ag / n; d[o + 2] = ab / n; d[o + 3] = s[o + 3];
        }
      }
    },
  });

  define('neon', {
    label: 'Neon Glow', group: 'Stylize',
    description: 'Trace edges in glowing saturated colour over a darkened frame, like a neon sign.',
    params: {
      glow: numParam('Glow', 0, 3, 0.01, 1.4),
      boost: numParam('Colour boost', 0, 2, 0.01, 1),
      dark: numParam('Dark background', 0, 1, 0.01, 0.85),
    },
    defaultParams: { glow: 1.4, boost: 1, dark: 0.85 },
    pixelEffect: true,
    pixelWork(src, dst, w, h, p, scratch) {
      const s = src.data, d = dst.data;
      const n = w * h;
      const lum = plane(scratch, 'neonLum', n), edge = plane(scratch, 'neonEdge', n);
      for (let i = 0, k = 0; i < s.length; i += 4, k++) lum[k] = s[i] * 0.2126 + s[i + 1] * 0.7152 + s[i + 2] * 0.0722;
      sobelLuma(lum, edge, w, h);
      const g = clamp(p.glow, 0, 3), boost = clamp(p.boost, 0, 2), dark = clamp(p.dark, 0, 1);
      const bg = (1 - dark) * 14;
      for (let i = 0, k = 0; i < s.length; i += 4, k++) {
        const mx = Math.max(s[i], s[i + 1], s[i + 2]) || 1;
        const e = Math.min(1, edge[k] / 255) * g * 255 * (1 + boost * 0.5);
        d[i] = clamp(bg + (s[i] / mx) * e, 0, 255);
        d[i + 1] = clamp(bg + (s[i + 1] / mx) * e, 0, 255);
        d[i + 2] = clamp(bg + (s[i + 2] / mx) * e, 0, 255);
        d[i + 3] = s[i + 3];
      }
    },
  });

  define('comic', {
    label: 'Comic Book', group: 'Stylize',
    description: 'Flat posterised colour with bold ink outlines, like a printed comic panel.',
    params: {
      levels: numParam('Colours', 2, 12, 1, 5),
      ink: numParam('Ink lines', 0, 2, 0.01, 1),
      saturation: numParam('Saturation', 0, 3, 0.01, 1.4),
    },
    defaultParams: { levels: 5, ink: 1, saturation: 1.4 },
    pixelEffect: true,
    pixelWork(src, dst, w, h, p, scratch) {
      const s = src.data, d = dst.data;
      const n = w * h;
      const lum = plane(scratch, 'comicLum', n), edge = plane(scratch, 'comicEdge', n);
      for (let i = 0, k = 0; i < s.length; i += 4, k++) lum[k] = s[i] * 0.2126 + s[i + 1] * 0.7152 + s[i + 2] * 0.0722;
      sobelLuma(lum, edge, w, h);
      const steps = Math.max(2, Math.round(p.levels));
      const step = 255 / (steps - 1);
      const ink = clamp(p.ink, 0, 2), sat = clamp(p.saturation, 0, 3);
      for (let i = 0, k = 0; i < s.length; i += 4, k++) {
        const L = lum[k];
        const e = Math.min(1, edge[k] / 180) * ink;
        const m = 1 - e;
        for (let ch = 0; ch < 3; ch++) {
          const v = L + (s[i + ch] - L) * sat;
          d[i + ch] = clamp(Math.round(v / step) * step * m, 0, 255);
        }
        d[i + 3] = s[i + 3];
      }
    },
  });

  define('thermal', {
    label: 'Thermal Camera', group: 'Stylize',
    description: 'Remap the frame to a false-colour heat palette, like a thermal imager.',
    params: {
      gain: numParam('Gain', 0.2, 4, 0.01, 1),
      offset: numParam('Offset', -1, 1, 0.01, 0),
    },
    defaultParams: { gain: 1, offset: 0 },
    pixelEffect: true,
    pixelWork(src, dst, w, h, p) {
      const s = src.data, d = dst.data;
      const gain = clamp(p.gain, 0.05, 4), off = clamp(p.offset, -1, 1);
      const STOPS = [[0, 0, 0], [0, 0, 140], [0, 66, 255], [0, 200, 255], [40, 226, 120], [255, 232, 0], [255, 120, 0], [255, 36, 0], [255, 255, 255]];
      const last = STOPS.length - 1;
      for (let i = 0; i < s.length; i += 4) {
        const L = clamp(((s[i] * 0.2126 + s[i + 1] * 0.7152 + s[i + 2] * 0.0722) / 255) * gain + off, 0, 1);
        const f = L * last, k = Math.min(last - 1, Math.floor(f)), t = f - k;
        const A = STOPS[k], B = STOPS[k + 1];
        d[i] = A[0] + (B[0] - A[0]) * t;
        d[i + 1] = A[1] + (B[1] - A[1]) * t;
        d[i + 2] = A[2] + (B[2] - A[2]) * t;
        d[i + 3] = s[i + 3];
      }
    },
  });

  define('xray', {
    label: 'X-Ray', group: 'Stylize',
    description: 'Inverted, edge-enhanced and blue-tinted, like a radiograph.',
    params: {
      amount: numParam('Amount', 0, 1, 0.01, 1),
      edges: numParam('Edge boost', 0, 2, 0.01, 0.8),
    },
    defaultParams: { amount: 1, edges: 0.8 },
    pixelEffect: true,
    pixelWork(src, dst, w, h, p, scratch) {
      const s = src.data, d = dst.data;
      const n = w * h;
      const lum = plane(scratch, 'xrayLum', n), edge = plane(scratch, 'xrayEdge', n);
      for (let i = 0, k = 0; i < s.length; i += 4, k++) lum[k] = s[i] * 0.2126 + s[i + 1] * 0.7152 + s[i + 2] * 0.0722;
      sobelLuma(lum, edge, w, h);
      const a = clamp(p.amount, 0, 1), eb = clamp(p.edges, 0, 2);
      for (let i = 0, k = 0; i < s.length; i += 4, k++) {
        const v = clamp(255 - lum[k] + Math.min(255, edge[k] * 0.4) * eb, 0, 255);
        d[i] = clamp(s[i] + (clamp(v * 0.62, 0, 255) - s[i]) * a, 0, 255);
        d[i + 1] = clamp(s[i + 1] + (clamp(v * 0.86, 0, 255) - s[i + 1]) * a, 0, 255);
        d[i + 2] = clamp(s[i + 2] + (clamp(v * 1.12, 0, 255) - s[i + 2]) * a, 0, 255);
        d[i + 3] = s[i + 3];
      }
    },
  });

  define('stainedglass', {
    label: 'Stained Glass', group: 'Stylize',
    description: 'Break the frame into leaded panes of flat colour with dark grout lines.',
    params: {
      size: numParam('Pane size', 4, 48, 1, 14, 'px'),
      grout: numParam('Lead lines', 0, 1, 0.01, 0.35),
      jitter: numParam('Irregularity', 0, 1, 0.01, 0.5),
    },
    defaultParams: { size: 14, grout: 0.35, jitter: 0.5 },
    pixelEffect: true,
    pixelWork(src, dst, w, h, p) {
      const s = src.data, d = dst.data;
      const size = Math.max(3, Math.round(p.size));
      const cols = Math.max(1, Math.ceil(w / size)), rows = Math.max(1, Math.ceil(h / size));
      const jit = clamp(p.jitter, 0, 1), grout = clamp(p.grout, 0, 1);
      const cr = new Float32Array(cols * rows), cg = new Float32Array(cols * rows), cb = new Float32Array(cols * rows);
      for (let cy = 0; cy < rows; cy++) {
        for (let cx = 0; cx < cols; cx++) {
          const ox = cx * size + (((hash01(cx * 3.7 + cy * 11.1) - 0.5) * size * jit) | 0);
          const oy = cy * size + (((hash01(cx * 7.3 + cy * 5.1) - 0.5) * size * jit) | 0);
          let r = 0, g = 0, b = 0, n = 0;
          for (let y = oy; y < oy + size; y += 2) {
            if (y < 0 || y >= h) continue;
            for (let x = ox; x < ox + size; x += 2) {
              if (x < 0 || x >= w) continue;
              const i = (y * w + x) * 4;
              r += s[i]; g += s[i + 1]; b += s[i + 2]; n++;
            }
          }
          const ci = cy * cols + cx;
          if (n) { cr[ci] = r / n; cg[ci] = g / n; cb[ci] = b / n; }
        }
      }
      const edge = Math.max(1, size * 0.16);
      for (let y = 0; y < h; y++) {
        const cy = Math.min(rows - 1, (y / size) | 0);
        const fy = Math.min(y - cy * size, (cy + 1) * size - 1 - y);
        for (let x = 0; x < w; x++) {
          const cx = Math.min(cols - 1, (x / size) | 0);
          const fx = Math.min(x - cx * size, (cx + 1) * size - 1 - x);
          const ci = cy * cols + cx, o = (y * w + x) * 4;
          const m = 1 - grout * (1 - Math.min(1, Math.min(fx, fy) / edge));
          d[o] = cr[ci] * m; d[o + 1] = cg[ci] * m; d[o + 2] = cb[ci] * m; d[o + 3] = s[o + 3];
        }
      }
    },
  });

  define('skew', {
    label: 'Skew', group: 'Distort',
    description: 'Slant the frame along either axis and rescale it to cover the edges.',
    params: {
      x: numParam('Skew X', -0.8, 0.8, 0.01, 0.25),
      y: numParam('Skew Y', -0.8, 0.8, 0.01, 0),
      zoom: numParam('Scale', 0.5, 2, 0.01, 1.18),
    },
    defaultParams: { x: 0.25, y: 0, zoom: 1.18 },
    draw(ctx, w, h, p, scratch) {
      const sx = clamp(p.x, -0.85, 0.85), sy = clamp(p.y, -0.85, 0.85);
      const z = clamp(p.zoom, 0.2, 2.5);
      if (!sx && !sy && Math.abs(z - 1) < 0.001) return;
      const src = scratchCanvas(scratch, 'skewSrc', w, h);
      const sctx = src.getContext('2d');
      sctx.setTransform(1, 0, 0, 1, 0, 0);
      sctx.clearRect(0, 0, w, h);
      sctx.drawImage(ctx.canvas, 0, 0, w, h, 0, 0, w, h);
      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, w, h);
      ctx.translate(w / 2, h / 2);
      ctx.scale(z, z);
      ctx.transform(1, sy, sx, 1, 0, 0);
      ctx.drawImage(src, -w / 2, -h / 2, w, h);
      ctx.restore();
    },
  });

  define('tile', {
    label: 'Tile Grid', group: 'Distort',
    description: 'Repeat the frame in a grid, like a video wall.',
    params: {
      columns: numParam('Columns', 1, 8, 1, 3),
      rows: numParam('Rows', 1, 8, 1, 2),
    },
    defaultParams: { columns: 3, rows: 2 },
    draw(ctx, w, h, p, scratch) {
      const cols = Math.max(1, Math.round(p.columns)), rows = Math.max(1, Math.round(p.rows));
      if (cols === 1 && rows === 1) return;
      const src = scratchCanvas(scratch, 'tileSrc', w, h);
      const sctx = src.getContext('2d');
      sctx.setTransform(1, 0, 0, 1, 0, 0);
      sctx.clearRect(0, 0, w, h);
      sctx.drawImage(ctx.canvas, 0, 0, w, h, 0, 0, w, h);
      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, w, h);
      const tw = w / cols, th = h / rows;
      for (let y = 0; y < rows; y++) {
        for (let x = 0; x < cols; x++) ctx.drawImage(src, 0, 0, w, h, x * tw, y * th, tw, th);
      }
      ctx.restore();
    },
  });

  define('stretch', {
    label: 'Stretch', group: 'Distort',
    description: 'Squeeze the frame along either axis and fill the gap with a mirrored copy.',
    params: {
      x: numParam('Horizontal', -1, 1, 0.01, 0.4),
      y: numParam('Vertical', -1, 1, 0.01, 0),
    },
    defaultParams: { x: 0.4, y: 0 },
    draw(ctx, w, h, p, scratch) {
      const px = clamp(p.x, -1, 1), py = clamp(p.y, -1, 1);
      const sx = clamp(1 - Math.abs(px), 0.05, 1);
      const sy = clamp(1 - Math.abs(py), 0.05, 1);
      if (sx > 0.999 && sy > 0.999) return;
      const src = scratchCanvas(scratch, 'stretchSrc', w, h);
      const sctx = src.getContext('2d');
      sctx.setTransform(1, 0, 0, 1, 0, 0);
      sctx.clearRect(0, 0, w, h);
      sctx.drawImage(ctx.canvas, 0, 0, w, h, 0, 0, w, h);
      const dw = w * sx, dh = h * sy;
      const x0 = px >= 0 ? 0 : w - dw;
      const y0 = py >= 0 ? 0 : h - dh;
      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, w, h);
      if (dw < w - 0.5) {
        ctx.save();
        ctx.translate(x0 === 0 ? w : 0, 0);
        ctx.scale(-1, 1);
        ctx.drawImage(src, 0, 0, w, h, 0, 0, w, h);
        ctx.restore();
      }
      if (dh < h - 0.5) {
        ctx.save();
        ctx.translate(0, y0 === 0 ? h : 0);
        ctx.scale(1, -1);
        ctx.drawImage(src, 0, 0, w, h, 0, 0, w, h);
        ctx.restore();
      }
      ctx.drawImage(src, 0, 0, w, h, x0, y0, dw, dh);
      ctx.restore();
    },
  });

  define('pip', {
    label: 'Picture in Picture', group: 'Render',
    description: 'Drop a framed inset of the frame into a corner, broadcast style.',
    params: {
      size: numParam('Inset size', 0.15, 0.6, 0.01, 0.32),
      x: numParam('Position X', 0, 1, 0.01, 0.04),
      y: numParam('Position Y', 0, 1, 0.01, 0.04),
      border: numParam('Border', 0, 40, 1, 6, 'px'),
    },
    defaultParams: { size: 0.32, x: 0.04, y: 0.04, border: 6 },
    draw(ctx, w, h, p, scratch) {
      const sz = clamp(p.size, 0.05, 0.9);
      const iw = w * sz, ih = h * sz;
      const px = clamp(p.x, 0, 1) * (w - iw), py = clamp(p.y, 0, 1) * (h - ih);
      const src = scratchCanvas(scratch, 'pipSrc', w, h);
      const sctx = src.getContext('2d');
      sctx.setTransform(1, 0, 0, 1, 0, 0);
      sctx.clearRect(0, 0, w, h);
      sctx.drawImage(ctx.canvas, 0, 0, w, h, 0, 0, w, h);
      const b = clamp(p.border, 0, 40);
      if (b > 0.5) {
        ctx.save();
        ctx.fillStyle = 'rgba(255,255,255,0.92)';
        ctx.fillRect(px - b, py - b, iw + b * 2, ih + b * 2);
        ctx.restore();
      }
      ctx.drawImage(src, 0, 0, w, h, px, py, iw, ih);
      ctx.save();
      ctx.strokeStyle = 'rgba(0,0,0,0.35)';
      ctx.lineWidth = 1;
      ctx.strokeRect(px + 0.5, py + 0.5, iw - 1, ih - 1);
      ctx.restore();
    },
  });

  define('lensflare', {
    label: 'Lens Flare', group: 'Render',
    description: 'Add an anamorphic streak and a chain of flare ghosts at a light source.',
    params: {
      x: numParam('Position X', 0, 1, 0.01, 0.72),
      y: numParam('Position Y', 0, 1, 0.01, 0.28),
      size: numParam('Size', 0.05, 1, 0.01, 0.35),
      streak: numParam('Streak', 0, 1, 0.01, 0.7),
      ghosts: numParam('Ghosts', 0, 1, 0.01, 0.5),
    },
    defaultParams: { x: 0.72, y: 0.28, size: 0.35, streak: 0.7, ghosts: 0.5 },
    draw(ctx, w, h, p) {
      const cx = clamp(p.x, 0, 1) * w, cy = clamp(p.y, 0, 1) * h;
      const R = clamp(p.size, 0.02, 1) * Math.min(w, h) * 0.5;
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, R);
      g.addColorStop(0, 'rgba(255,255,240,0.95)');
      g.addColorStop(0.18, 'rgba(255,238,190,0.5)');
      g.addColorStop(0.5, 'rgba(120,170,255,0.16)');
      g.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, w, h);
      const st = clamp(p.streak, 0, 1);
      if (st > 0.01) {
        ctx.save();
        ctx.globalAlpha = st;
        ctx.translate(cx, cy);
        ctx.scale(1, (R * 0.5) / w);
        const lg = ctx.createLinearGradient(-w, 0, w, 0);
        lg.addColorStop(0, 'rgba(60,120,255,0)');
        lg.addColorStop(0.5, 'rgba(160,205,255,0.85)');
        lg.addColorStop(1, 'rgba(60,120,255,0)');
        ctx.fillStyle = lg;
        ctx.fillRect(-w, -R * 8, w * 2, R * 16);
        ctx.restore();
      }
      const gh = clamp(p.ghosts, 0, 1);
      if (gh > 0.01) {
        const dx = w / 2 - cx, dy = h / 2 - cy;
        for (let i = 1; i <= 6; i++) {
          const k = i * 0.42;
          const gx = cx + dx * k * 2, gy = cy + dy * k * 2;
          const r = R * (0.12 + 0.3 * hash01(i * 5.3));
          ctx.globalAlpha = gh * (0.3 - i * 0.03);
          const cg = ctx.createRadialGradient(gx, gy, r * 0.4, gx, gy, r);
          cg.addColorStop(0, 'rgba(0,0,0,0)');
          cg.addColorStop(0.72, `rgba(${(120 + i * 18) | 0},${(190 - i * 12) | 0},255,0.55)`);
          cg.addColorStop(1, 'rgba(0,0,0,0)');
          ctx.fillStyle = cg;
          ctx.beginPath();
          ctx.arc(gx, gy, r, 0, Math.PI * 2);
          ctx.fill();
        }
      }
      ctx.restore();
    },
  });

  define('timecode', {
    label: 'Timecode Burn-in', group: 'Render',
    description: 'Burn a running timecode and frame count into the picture.',
    params: {
      size: numParam('Size', 8, 96, 1, 26, 'px'),
      x: numParam('Position X', 0, 1, 0.01, 0.03),
      y: numParam('Position Y', 0, 1, 0.01, 0.9),
      color: colParam('Colour', '#ffffff'),
      backing: selParam('Backing', ['Outline', 'Solid', 'None'], 'Outline'),
    },
    defaultParams: { size: 26, x: 0.03, y: 0.9, color: '#ffffff', backing: 'Outline' },
    draw(ctx, w, h, p, scratch, local, fps) {
      const str = tcStr(local || 0, fps || 30);
      const size = clamp(p.size, 6, 120);
      ctx.save();
      ctx.font = `600 ${size}px "Consolas","Segoe UI Mono",monospace`;
      ctx.textBaseline = 'top';
      const tw = ctx.measureText(str).width;
      const x = clamp(p.x, 0, 1) * Math.max(0, w - tw);
      const y = clamp(p.y, 0, 1) * Math.max(0, h - size * 1.4);
      if (p.backing === 'Solid') {
        ctx.fillStyle = 'rgba(0,0,0,0.55)';
        ctx.fillRect(x - size * 0.3, y - size * 0.1, tw + size * 0.6, size * 1.3);
      } else if (p.backing === 'Outline') {
        ctx.lineWidth = Math.max(2, size * 0.14);
        ctx.lineJoin = 'round';
        ctx.strokeStyle = 'rgba(0,0,0,0.85)';
        ctx.strokeText(str, x, y);
      }
      ctx.fillStyle = p.color || '#ffffff';
      ctx.fillText(str, x, y);
      ctx.restore();
    },
  });

  define('bokeh', {
    label: 'Bokeh Lights', group: 'Render',
    description: 'Overlay drifting, softly glowing out-of-focus bokeh circles.',
    params: {
      count: numParam('Count', 4, 60, 1, 16),
      size: numParam('Size', 0.02, 0.5, 0.01, 0.12),
      speed: numParam('Drift', 0, 3, 0.01, 0.5),
      color: colParam('Tint', '#ffd9a0'),
    },
    defaultParams: { count: 16, size: 0.12, speed: 0.5, color: '#ffd9a0' },
    draw(ctx, w, h, p, scratch, local) {
      const n = Math.max(1, Math.round(p.count));
      const base = clamp(p.size, 0.01, 0.6) * Math.min(w, h) * 0.5;
      const spd = clamp(p.speed, 0, 3);
      const t = (local || 0) * spd;
      const c = rgb01(p.color);
      const rgb = `${(c[0] * 255) | 0},${(c[1] * 255) | 0},${(c[2] * 255) | 0}`;
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      for (let i = 0; i < n; i++) {
        const s1 = hash01(i * 12.9898), s2 = hash01(i * 78.233), s3 = hash01(i * 43.77);
        const R = base * (0.4 + s3);
        const y = ((s2 * h + t * (6 + s1 * 14)) % (h + R * 2)) - R;
        const x = s1 * w + Math.sin(t * 0.06 + i) * w * 0.05;
        const g = ctx.createRadialGradient(x, y, R * 0.2, x, y, R);
        g.addColorStop(0, `rgba(${rgb},0.5)`);
        g.addColorStop(0.7, `rgba(${rgb},0.15)`);
        g.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(x, y, R, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();
    },
  });

  /* ---- audio effects ---- */

  define('volume', {
    label: 'Volume', category: 'audio', group: 'Audio',
    description: 'Adjust the level of this clip’s audio.',
    params: { gain: numParam('Gain', 0, 4, 0.01, 1, 'x') },
    defaultParams: { gain: 1 },
    gainAt: (p) => clamp(p.gain, 0, 4),
  });

  define('audiofade', {
    label: 'Audio Fade', category: 'audio', group: 'Audio',
    description: 'Fade the audio in and out over a set number of seconds.',
    params: { fadeIn: numParam('Fade in', 0, 20, 0.1, 1, 's'), fadeOut: numParam('Fade out', 0, 20, 0.1, 1, 's') },
    defaultParams: { fadeIn: 1, fadeOut: 1 },
    gainAt(p, local, length, fps) {
      const inF = Math.round((p.fadeIn || 0) * fps), outF = Math.round((p.fadeOut || 0) * fps);
      let g = 1;
      if (inF > 0 && local < inF) g = Math.min(g, local / inF);
      if (outF > 0 && local > length - outF) g = Math.min(g, (length - local) / outF);
      return clamp(g, 0, 1);
    },
  });

  define('audiogain', {
    label: 'Audio Boost / Cut', category: 'audio', group: 'Audio',
    description: 'Apply a fixed dB boost or cut to this clip.',
    params: { db: numParam('Gain (dB)', -40, 24, 0.5, 6, ' dB') },
    defaultParams: { db: 6 },
    gainAt: (p) => clamp(Math.pow(10, clamp(p.db, -40, 24) / 20), 0, 16),
  });

  define('audiopulse', {
    label: 'Tremolo', category: 'audio', group: 'Audio',
    description: 'Pulse the level at a fixed rate for a tremolo effect.',
    params: { rate: numParam('Rate', 0.2, 24, 0.1, 6, ' Hz'), depth: numParam('Depth', 0, 1, 0.01, 0.7) },
    defaultParams: { rate: 6, depth: 0.7 },
    gainAt(p, local, length, fps) {
      const depth = clamp(p.depth, 0, 1);
      if (depth <= 0.001) return 1;
      const t = (local / Math.max(1, fps));
      const lfo = 0.5 + 0.5 * Math.sin(t * Math.PI * 2 * clamp(p.rate, 0.2, 24));
      return clamp(1 - depth * (1 - lfo), 0, 1);
    },
  });

  define('audiopan', {
    label: 'Stereo Pan', category: 'audio', group: 'Audio',
    description: 'Place the clip’s audio in the stereo field, left to right.',
    params: { pan: numParam('Position', -1, 1, 0.01, 0) },
    defaultParams: { pan: 0 },
    panAt: (p) => clamp(p.pan, -1, 1),
  });

  define('audioramp', {
    label: 'Volume Ramp', category: 'audio', group: 'Audio',
    description: 'Ramp the level from a start gain to an end gain across the whole clip.',
    params: { from: numParam('Start', 0, 4, 0.01, 0), to: numParam('End', 0, 4, 0.01, 1) },
    defaultParams: { from: 0, to: 1 },
    gainAt(p, local, length) {
      const t = length > 0 ? clamp(local / length, 0, 1) : 0;
      return clamp(p.from + (p.to - p.from) * t, 0, 4);
    },
  });

  define('audioswell', {
    label: 'Swell', category: 'audio', group: 'Audio',
    description: 'A slow raised-cosine swell that lifts and drops the level over the clip.',
    params: { depth: numParam('Depth', 0, 1, 0.01, 0.5), cycles: numParam('Cycles', 0.5, 8, 0.1, 1) },
    defaultParams: { depth: 0.5, cycles: 1 },
    gainAt(p, local, length) {
      const t = length > 0 ? clamp(local / length, 0, 1) : 0;
      const lfo = 0.5 - 0.5 * Math.cos(t * Math.PI * 2 * clamp(p.cycles, 0.25, 12));
      return clamp(1 - clamp(p.depth, 0, 1) * (1 - lfo), 0, 1);
    },
  });

  /* Combined opacity of every enabled effect that animates alpha (eg. Fade). */
  function opacityAt(effects, local, length, fps) {
    let o = 1;
    for (const fx of effects) {
      if (!fx.enabled) continue;
      const reg = registry[fx.type];
      if (reg && reg.opacityAt) o = Math.min(o, reg.opacityAt(fx.params, local, length, fps));
    }
    return clamp(o, 0, 1);
  }

  const all = () => Object.values(registry);
  const list = (category) => Object.values(registry).filter((r) => !category || r.category === category);
  const groups = (category) => {
    const seen = [];
    for (const r of list(category)) if (!seen.includes(r.group)) seen.push(r.group);
    return seen;
  };

  /* Compose the canvas filter string for a list of enabled effects. */
  /* =========================================================================
     Extended effect catalogue
     ---------------------------------------------------------------------
     Colour work goes through 256-entry lookup tables and the blur family
     through a separable moving-average pass, so a whole frame costs one
     linear sweep rather than a per-pixel transcendental. Anything animated
     is keyed off frameLocal, which keeps previews and exports identical.
     ========================================================================= */

  /* Build a 256-entry transfer table from a function of t in 0..1. */
  function lut(fn) {
    const t = new Uint8ClampedArray(256);
    for (let i = 0; i < 256; i++) t[i] = clamp(fn(i / 255), 0, 1) * 255;
    return t;
  }

  /* Three tables sampled from a colour ramp: stops are [position, [r,g,b]]. */
  function rampLut(stops) {
    const out = [new Uint8ClampedArray(256), new Uint8ClampedArray(256), new Uint8ClampedArray(256)];
    for (let i = 0; i < 256; i++) {
      const t = i / 255;
      let lo = stops[0], hi = stops[stops.length - 1];
      for (let k = 0; k < stops.length - 1; k++) {
        if (t >= stops[k][0] && t <= stops[k + 1][0]) { lo = stops[k]; hi = stops[k + 1]; break; }
      }
      const span = Math.max(1e-6, hi[0] - lo[0]);
      const f = clamp((t - lo[0]) / span, 0, 1);
      for (let c = 0; c < 3; c++) out[c][i] = lo[1][c] + (hi[1][c] - lo[1][c]) * f;
    }
    return out;
  }

  /* Per-channel table pass. */
  function applyLut3(src, dst, t3) {
    const s = src, d = dst;
    const a = t3[0], b = t3[1], c = t3[2];
    for (let i = 0; i < s.length; i += 4) {
      d[i] = a[s[i]]; d[i + 1] = b[s[i + 1]]; d[i + 2] = c[s[i + 2]]; d[i + 3] = s[i + 3];
    }
  }

  /* Luminance-keyed table pass: the ramp is indexed by brightness, not by the
     individual channels, which is what gives maps their tonal look. */
  function applyLumLut(src, dst, t3) {
    const s = src, d = dst;
    const a = t3[0], b = t3[1], c = t3[2];
    for (let i = 0; i < s.length; i += 4) {
      const l = (s[i] * 0.2126 + s[i + 1] * 0.7152 + s[i + 2] * 0.0722) | 0;
      d[i] = a[l]; d[i + 1] = b[l]; d[i + 2] = c[l]; d[i + 3] = s[i + 3];
    }
  }

  /* Hue channel of an HSL triple, factored out so the per-pixel loops never
     allocate a closure. */
  function hueChannel(pq, q, t0) {
    let t = t0;
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return pq + (q - pq) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return pq + (q - pq) * (2 / 3 - t) * 6;
    return pq;
  }
  /* HSL -> RGB into a reusable 3-slot array. */
  function hslToRgb(hh, ss, ll, out) {
    if (ss < 1e-6) { out[0] = out[1] = out[2] = ll; return out; }
    const q = ll < 0.5 ? ll * (1 + ss) : ll + ss - ll * ss;
    const pq = 2 * ll - q;
    out[0] = hueChannel(pq, q, hh + 1 / 3);
    out[1] = hueChannel(pq, q, hh);
    out[2] = hueChannel(pq, q, hh - 1 / 3);
    return out;
  }

  /* Shared saturation / contrast / warmth / fade core behind the film looks. */
  function filmLook(s, d, o) {
    const sat = o.sat === undefined ? 1 : o.sat;
    const con = o.con === undefined ? 1 : o.con;
    const wr = (o.warm || 0) * 15, wb = -(o.warm || 0) * 11;
    const lr = (o.liftR || 0) * 255, lg = (o.liftG || 0) * 255, lb = (o.liftB || 0) * 255;
    const f = o.fade || 0;
    const keep = 1 - f * 0.5;
    for (let i = 0; i < s.length; i += 4) {
      let r = s[i], g = s[i + 1], b = s[i + 2];
      const l = r * 0.2126 + g * 0.7152 + b * 0.0722;
      r = l + (r - l) * sat; g = l + (g - l) * sat; b = l + (b - l) * sat;
      r = r * keep + f * 48 + ((r - 128) * (con - 1)) + wr + lr;
      g = g * keep + f * 46 + ((g - 128) * (con - 1)) + lg;
      b = b * keep + f * 58 + ((b - 128) * (con - 1)) + wb + lb;
      d[i] = clamp(r, 0, 255);
      d[i + 1] = clamp(g, 0, 255);
      d[i + 2] = clamp(b, 0, 255);
      d[i + 3] = s[i + 3];
    }
  }

  /* Separable moving-average blur over raw RGBA data. Two linear sweeps, so the
     cost does not grow with the radius. */
  function boxBlurRGBA(s, d, w, h, radius) {
    const r = Math.max(1, Math.round(radius));
    const div = r * 2 + 1;
    const tmp = new Uint8ClampedArray(s.length);
    for (let y = 0; y < h; y++) {
      const row = y * w;
      let sr = 0, sg = 0, sb = 0;
      for (let k = -r; k <= r; k++) {
        const i = (row + Math.min(w - 1, Math.max(0, k))) * 4;
        sr += s[i]; sg += s[i + 1]; sb += s[i + 2];
      }
      for (let x = 0; x < w; x++) {
        const o = (row + x) * 4;
        tmp[o] = sr / div; tmp[o + 1] = sg / div; tmp[o + 2] = sb / div; tmp[o + 3] = s[o + 3];
        const iAdd = (row + Math.min(w - 1, x + r + 1)) * 4;
        const iSub = (row + Math.max(0, x - r)) * 4;
        sr += s[iAdd] - s[iSub];
        sg += s[iAdd + 1] - s[iSub + 1];
        sb += s[iAdd + 2] - s[iSub + 2];
      }
    }
    for (let x = 0; x < w; x++) {
      let sr = 0, sg = 0, sb = 0;
      for (let k = -r; k <= r; k++) {
        const i = (Math.min(h - 1, Math.max(0, k)) * w + x) * 4;
        sr += tmp[i]; sg += tmp[i + 1]; sb += tmp[i + 2];
      }
      for (let y = 0; y < h; y++) {
        const o = (y * w + x) * 4;
        d[o] = sr / div; d[o + 1] = sg / div; d[o + 2] = sb / div; d[o + 3] = tmp[o + 3];
        const iAdd = (Math.min(h - 1, y + r + 1) * w + x) * 4;
        const iSub = (Math.max(0, y - r) * w + x) * 4;
        sr += tmp[iAdd] - tmp[iSub];
        sg += tmp[iAdd + 1] - tmp[iSub + 1];
        sb += tmp[iAdd + 2] - tmp[iSub + 2];
      }
    }
  }

  const blurredCopy = (src, w, h, radius) => {
    const out = new Uint8ClampedArray(src.length);
    boxBlurRGBA(src, out, w, h, radius);
    return out;
  };

  /* ---- Color & Tone: transfer curves ---- */

  define('exposure', {
    label: 'Exposure', group: 'Color & Tone',
    description: 'Push or pull the exposure in stops, as if the shot had been re-metered.',
    params: { stops: numParam('Stops', -4, 4, 0.05, 0.5) }, defaultParams: { stops: 0.5 },
    pixelEffect: true,
    pixelWork(src, dst, w, h, p) {
      const t = lut((v) => v * Math.pow(2, clamp(p.stops, -4, 4)));
      applyLut3(src.data, dst.data, [t, t, t]);
    },
  });

  define('gamma', {
    label: 'Gamma', group: 'Color & Tone',
    description: 'Bend the midtones without touching black or white.',
    params: { gamma: numParam('Gamma', 0.1, 4, 0.01, 1) }, defaultParams: { gamma: 1 },
    pixelEffect: true,
    pixelWork(src, dst, w, h, p) {
      const g = Math.max(0.05, clamp(p.gamma, 0.1, 4));
      const t = lut((v) => Math.pow(v, 1 / g));
      applyLut3(src.data, dst.data, [t, t, t]);
    },
  });

  define('curves', {
    label: 'Curves', group: 'Color & Tone',
    description: 'Independent lift for shadows, midtones and highlights.',
    params: {
      shadows: numParam('Shadows', -1, 1, 0.01, 0),
      midtones: numParam('Midtones', -1, 1, 0.01, 0),
      highlights: numParam('Highlights', -1, 1, 0.01, 0),
    },
    defaultParams: { shadows: 0, midtones: 0, highlights: 0 },
    pixelEffect: true,
    pixelWork(src, dst, w, h, p) {
      const s = clamp(p.shadows, -1, 1) * 0.25;
      const m = clamp(p.midtones, -1, 1) * 0.25;
      const hi = clamp(p.highlights, -1, 1) * 0.25;
      const t = lut((v) => {
        const sw = (1 - v) * (1 - v);
        const hw = v * v;
        const mw = Math.max(0, 1 - sw - hw);
        return v + sw * s + mw * m + hw * hi;
      });
      applyLut3(src.data, dst.data, [t, t, t]);
    },
  });

  define('channelmixer', {
    label: 'Channel Mixer', group: 'Color & Tone',
    description: 'Trim each colour channel independently.',
    params: {
      red: numParam('Red', 0, 3, 0.01, 1),
      green: numParam('Green', 0, 3, 0.01, 1),
      blue: numParam('Blue', 0, 3, 0.01, 1),
    },
    defaultParams: { red: 1, green: 1, blue: 1 },
    pixelEffect: true,
    pixelWork(src, dst, w, h, p) {
      const g = (k) => lut((v) => v * clamp(p[k], 0, 3));
      applyLut3(src.data, dst.data, [g('red'), g('green'), g('blue')]);
    },
  });

  define('colorbalance', {
    label: 'Colour Balance', group: 'Color & Tone',
    description: 'Tint the shadows and highlights separately, the way a colourist balances a grade.',
    params: {
      shadowColor: colParam('Shadow tint', '#2050ff'),
      shadowAmount: numParam('Shadow amount', 0, 1, 0.01, 0.25),
      highColor: colParam('Highlight tint', '#ffb060'),
      highAmount: numParam('Highlight amount', 0, 1, 0.01, 0.25),
    },
    defaultParams: { shadowColor: '#2050ff', shadowAmount: 0.25, highColor: '#ffb060', highAmount: 0.25 },
    pixelEffect: true,
    pixelWork(src, dst, w, h, p) {
      const sc = hexRGB(p.shadowColor), hc = hexRGB(p.highColor);
      const sa = clamp(p.shadowAmount, 0, 1) * 0.5, ha = clamp(p.highAmount, 0, 1) * 0.5;
      const t3 = [0, 1, 2].map((c) => lut((v) => {
        const sw = (1 - v) * (1 - v);
        const hw = v * v;
        return v + ((sc[c] / 255) - 0.5) * sa * sw + ((hc[c] / 255) - 0.5) * ha * hw;
      }));
      applyLut3(src.data, dst.data, t3);
    },
  });

  define('colorize', {
    label: 'Colourise', group: 'Color & Tone',
    description: 'Replace the picture with a tint that follows its brightness.',
    params: { dark: colParam('Dark tint', '#101040'), light: colParam('Light tint', '#ffd090') },
    defaultParams: { dark: '#101040', light: '#ffd090' },
    pixelEffect: true,
    pixelWork(src, dst, w, h, p) {
      applyLumLut(src.data, dst.data, rampLut([[0, hexRGB(p.dark)], [1, hexRGB(p.light)]]));
    },
  });

  define('gradientmap', {
    label: 'Gradient Map', group: 'Color & Tone',
    description: 'Map brightness through a three-stop colour ramp.',
    params: {
      shadow: colParam('Shadows', '#1a0b3a'),
      mid: colParam('Midtones', '#d13a6a'),
      high: colParam('Highlights', '#ffe9a8'),
    },
    defaultParams: { shadow: '#1a0b3a', mid: '#d13a6a', high: '#ffe9a8' },
    pixelEffect: true,
    pixelWork(src, dst, w, h, p) {
      applyLumLut(src.data, dst.data, rampLut([
        [0, hexRGB(p.shadow)], [0.5, hexRGB(p.mid)], [1, hexRGB(p.high)],
      ]));
    },
  });

  define('selectivecolor', {
    label: 'Selective Colour', group: 'Color & Tone',
    description: 'Boost or drain one colour range while leaving the rest of the frame alone.',
    params: {
      hue: numParam('Hue', 0, 360, 1, 25, 'deg'),
      range: numParam('Range', 10, 180, 1, 60, 'deg'),
      amount: numParam('Amount', -1, 1, 0.01, 0.6),
    },
    defaultParams: { hue: 25, range: 60, amount: 0.6 },
    pixelEffect: true,
    pixelWork(src, dst, w, h, p) {
      const s = src.data, d = dst.data;
      const target = ((clamp(p.hue, 0, 360) % 360)) / 360;
      const range = Math.max(10, clamp(p.range, 10, 180)) / 360;
      const amt = clamp(p.amount, -1, 1);
      const out = [0, 0, 0];
      for (let i = 0; i < s.length; i += 4) {
        const r = s[i] / 255, g = s[i + 1] / 255, b = s[i + 2] / 255;
        const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
        const l = (mx + mn) / 2;
        const c = mx - mn;
        let hh = 0;
        if (c > 1e-6) {
          if (mx === r) hh = ((((g - b) / c) % 6) + 6) % 6;
          else if (mx === g) hh = (b - r) / c + 2;
          else hh = (r - g) / c + 4;
          hh /= 6;
        }
        const denom = 1 - Math.abs(2 * l - 1);
        const sat = c < 1e-6 || denom < 1e-6 ? 0 : c / denom;
        const dist = Math.min(Math.abs(hh - target), 1 - Math.abs(hh - target));
        const w2 = c < 1e-6 ? 0 : Math.max(0, 1 - dist / range);
        const ns = clamp(sat * (1 + amt * w2), 0, 1);
        hslToRgb(hh, ns, l, out);
        d[i] = clamp(out[0] * 255, 0, 255);
        d[i + 1] = clamp(out[1] * 255, 0, 255);
        d[i + 2] = clamp(out[2] * 255, 0, 255);
        d[i + 3] = s[i + 3];
      }
    },
  });

  /* Film-look presets share one engine; `strength` blends between the original
     image and the graded look so every preset also works as a subtle grade. */
  function filmPreset(type, label, desc, preset) {
    define(type, {
      label, group: 'Color & Tone', description: desc,
      params: { strength: numParam('Strength', 0, 1, 0.01, 0.8) },
      defaultParams: { strength: 0.8 },
      pixelEffect: true,
      pixelWork(src, dst, w, h, p) {
        const a = clamp(p.strength, 0, 1);
        filmLook(src.data, dst.data, {
          sat: 1 + (preset.sat - 1) * a,
          con: 1 + (preset.con - 1) * a,
          warm: (preset.warm || 0) * a,
          fade: (preset.fade || 0) * a,
          liftR: (preset.liftR || 0) * a,
          liftG: (preset.liftG || 0) * a,
          liftB: (preset.liftB || 0) * a,
        });
      },
    });
  }

  filmPreset('technicolor', 'Technicolor', 'Three-strip colour with rich reds and warm highlights.', { sat: 1.45, con: 1.12, warm: 0.55, liftR: 0.02 });
  filmPreset('crossprocess', 'Cross Process', 'Slide film pushed through C-41 chemistry: green shadows, yellow highlights.', { sat: 1.2, con: 1.35, warm: 0.2, liftG: 0.05, liftB: 0.06 });
  filmPreset('lomo', 'Lomo', 'Punchy contrast and deliberately oversaturated colour.', { sat: 1.55, con: 1.3, warm: 0.3 });
  filmPreset('kodachrome', 'Kodachrome', 'Dense reds with calm, clean blues.', { sat: 1.35, con: 1.15, warm: 0.45, liftR: 0.015 });
  filmPreset('polaroid', 'Polaroid', 'Faded instant film: lifted blacks and soft warmth.', { sat: 0.85, con: 1.02, warm: 0.3, fade: 0.4 });
  filmPreset('vaporwave', 'Vaporwave', 'Magenta and cyan split tone over washed-out contrast.', { sat: 1.25, con: 1.05, warm: 0.4, fade: 0.3, liftB: 0.08 });
  filmPreset('cyberpunk', 'Cyberpunk', 'Hard teal shadows beneath hot orange highlights.', { sat: 1.3, con: 1.4, warm: 0.35, liftB: 0.07, liftR: 0.015 });
  filmPreset('filmnoir', 'Film Noir', 'High-contrast monochrome with a cold lift.', { sat: 0.04, con: 1.5, liftB: 0.035 });
  filmPreset('greenteal', 'Green Teal', 'The pale, green-shifted grade of a hospital drama.', { sat: 0.7, con: 1.18, liftG: 0.045, liftB: 0.04, fade: 0.18 });

  define('infrared', {
    label: 'Infrared', group: 'Color & Tone',
    description: 'False-colour infrared: foliage glow bursts white while skies sink dark.',
    params: { strength: numParam('Strength', 0, 1, 0.01, 0.75) },
    defaultParams: { strength: 0.75 },
    pixelEffect: true,
    pixelWork(src, dst, w, h, p) {
      const s = src.data, d = dst.data, a = clamp(p.strength, 0, 1);
      for (let i = 0; i < s.length; i += 4) {
        const r = s[i], g = s[i + 1], b = s[i + 2];
        const nr = g * 0.85 + b * 0.35;
        const ng = r * 0.25 + g * 0.6;
        const nb = b * 0.55 + r * 0.15;
        d[i] = clamp(r + (nr - r) * a, 0, 255);
        d[i + 1] = clamp(g + (ng - g) * a, 0, 255);
        d[i + 2] = clamp(b + (nb - b) * a, 0, 255);
        d[i + 3] = s[i + 3];
      }
    },
  });

  /* ---- Blur & Sharpen ---- */

  define('boxblur', {
    label: 'Box Blur', group: 'Blur & Sharpen',
    description: 'Flat, even blur that costs the same at any radius. Good for clearing grain.',
    params: { radius: numParam('Radius', 1, 80, 0.5, 8, 'px') },
    defaultParams: { radius: 8 },
    pixelEffect: true,
    pixelWork(src, dst, w, h, p) {
      boxBlurRGBA(src.data, dst.data, w, h, clamp(p.radius, 1, 80));
    },
  });

  define('unsharp', {
    label: 'Unsharp Mask', group: 'Blur & Sharpen',
    description: 'Sharpen by subtracting a blurred copy, so detail crisps up without halos.',
    params: {
      radius: numParam('Radius', 1, 40, 0.5, 4, 'px'),
      amount: numParam('Amount', 0, 3, 0.01, 1),
      threshold: numParam('Threshold', 0, 64, 1, 0, 'lvl'),
    },
    defaultParams: { radius: 4, amount: 1, threshold: 0 },
    pixelEffect: true,
    pixelWork(src, dst, w, h, p) {
      const s = src.data, d = dst.data;
      const bl = blurredCopy(s, w, h, clamp(p.radius, 1, 40));
      const amt = clamp(p.amount, 0, 3);
      const th = clamp(p.threshold, 0, 64);
      for (let i = 0; i < s.length; i += 4) {
        for (let c = 0; c < 3; c++) {
          const v = s[i + c];
          const diff = v - bl[i + c];
          d[i + c] = Math.abs(diff) < th ? v : clamp(v + diff * amt, 0, 255);
        }
        d[i + 3] = s[i + 3];
      }
    },
  });

  define('highpass', {
    label: 'High Pass', group: 'Blur & Sharpen',
    description: 'Keep only the detail a blur removes: flat areas go mid grey, edges flare.',
    params: {
      radius: numParam('Radius', 1, 60, 0.5, 6, 'px'),
      gain: numParam('Gain', 0.25, 4, 0.01, 1),
    },
    defaultParams: { radius: 6, gain: 1 },
    pixelEffect: true,
    pixelWork(src, dst, w, h, p) {
      const s = src.data, d = dst.data;
      const bl = blurredCopy(s, w, h, clamp(p.radius, 1, 60));
      const g = clamp(p.gain, 0.25, 4);
      for (let i = 0; i < s.length; i += 4) {
        const l = s[i] * 0.2126 + s[i + 1] * 0.7152 + s[i + 2] * 0.0722;
        const lb = bl[i] * 0.2126 + bl[i + 1] * 0.7152 + bl[i + 2] * 0.0722;
        const v = clamp(128 + (l - lb) * g, 0, 255);
        d[i] = d[i + 1] = d[i + 2] = v;
        d[i + 3] = s[i + 3];
      }
    },
  });

  define('directionalblur', {
    label: 'Directional Blur', group: 'Blur & Sharpen',
    description: 'Smear the frame along one axis for a speed-line streak.',
    params: {
      angle: numParam('Angle', 0, 360, 1, 0, 'deg'),
      length: numParam('Length', 1, 120, 1, 24, 'px'),
      samples: numParam('Samples', 3, 24, 1, 10),
    },
    defaultParams: { angle: 0, length: 24, samples: 10 },
    pixelEffect: true,
    pixelWork(src, dst, w, h, p) {
      const s = src.data, d = dst.data;
      const a = (clamp(p.angle, 0, 360) * Math.PI) / 180;
      const len = clamp(p.length, 1, 120);
      const n = Math.max(3, Math.round(clamp(p.samples, 3, 24)));
      const dx = Math.cos(a), dy = Math.sin(a);
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          let r = 0, g = 0, b = 0, al = 0;
          for (let k = 0; k < n; k++) {
            const t = (k / (n - 1) - 0.5) * len;
            const xx = Math.min(w - 1, Math.max(0, Math.round(x + dx * t)));
            const yy = Math.min(h - 1, Math.max(0, Math.round(y + dy * t)));
            const i = (yy * w + xx) * 4;
            r += s[i]; g += s[i + 1]; b += s[i + 2]; al += s[i + 3];
          }
          const o = (y * w + x) * 4;
          d[o] = r / n; d[o + 1] = g / n; d[o + 2] = b / n; d[o + 3] = al / n;
        }
      }
    },
  });

  define('radialblur', {
    label: 'Radial Blur', group: 'Blur & Sharpen',
    description: 'Streak pixels outward from a centre point for a zoom-burst feel.',
    params: {
      amount: numParam('Amount', 0, 0.5, 0.005, 0.12),
      samples: numParam('Samples', 3, 24, 1, 10),
      cx: numParam('Centre X', 0, 1, 0.01, 0.5),
      cy: numParam('Centre Y', 0, 1, 0.01, 0.5),
    },
    defaultParams: { amount: 0.12, samples: 10, cx: 0.5, cy: 0.5 },
    pixelEffect: true,
    pixelWork(src, dst, w, h, p) {
      const s = src.data, d = dst.data;
      const n = Math.max(3, Math.round(clamp(p.samples, 3, 24)));
      const amt = clamp(p.amount, 0, 0.5);
      const cx = clamp(p.cx, 0, 1) * w, cy = clamp(p.cy, 0, 1) * h;
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          let r = 0, g = 0, b = 0, al = 0;
          for (let k = 0; k < n; k++) {
            const t = 1 - amt * (k / (n - 1));
            const xx = Math.min(w - 1, Math.max(0, Math.round(cx + (x - cx) * t)));
            const yy = Math.min(h - 1, Math.max(0, Math.round(cy + (y - cy) * t)));
            const i = (yy * w + xx) * 4;
            r += s[i]; g += s[i + 1]; b += s[i + 2]; al += s[i + 3];
          }
          const o = (y * w + x) * 4;
          d[o] = r / n; d[o + 1] = g / n; d[o + 2] = b / n; d[o + 3] = al / n;
        }
      }
    },
  });

  /* ---- Stylize ---- */

  /* Precomputed luminance plane: turns every neighbourhood lookup in the
     edge-based looks into a single array read instead of three multiplies. */
  function lumaPlane(s, w, h) {
    const p = new Float32Array(w * h);
    for (let i = 0, j = 0; i < s.length; i += 4, j++) {
      p[j] = s[i] * 0.2126 + s[i + 1] * 0.7152 + s[i + 2] * 0.0722;
    }
    return p;
  }
  const planeAt = (p, w, h, x, y) =>
    p[Math.min(h - 1, Math.max(0, y)) * w + Math.min(w - 1, Math.max(0, x))];

  define('cartoon', {
    label: 'Cartoon', group: 'Stylize',
    description: 'Flat cel colours walled in by inked outlines.',
    params: {
      levels: numParam('Levels', 2, 12, 1, 5),
      edge: numParam('Ink', 0, 1, 0.01, 0.55),
    },
    defaultParams: { levels: 5, edge: 0.55 },
    pixelEffect: true,
    pixelWork(src, dst, w, h, p) {
      const s = src.data, d = dst.data;
      const n = Math.max(2, Math.round(clamp(p.levels, 2, 12)));
      const step = 255 / (n - 1);
      const edge = clamp(p.edge, 0, 1);
      const lp = lumaPlane(s, w, h);
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const o = (y * w + x) * 4;
          const tl = planeAt(lp, w, h, x - 1, y - 1), tm = planeAt(lp, w, h, x, y - 1), tr = planeAt(lp, w, h, x + 1, y - 1);
          const ml = planeAt(lp, w, h, x - 1, y), mr = planeAt(lp, w, h, x + 1, y);
          const bl2 = planeAt(lp, w, h, x - 1, y + 1), bm = planeAt(lp, w, h, x, y + 1), br = planeAt(lp, w, h, x + 1, y + 1);
          const gx = (tr + 2 * mr + br) - (tl + 2 * ml + bl2);
          const gy = (bl2 + 2 * bm + br) - (tl + 2 * tm + tr);
          const k = clamp(Math.sqrt(gx * gx + gy * gy) / 255 * (1.4 + edge * 2.6), 0, 1);
          d[o] = Math.round(Math.round(s[o] / step) * step) * (1 - k);
          d[o + 1] = Math.round(Math.round(s[o + 1] / step) * step) * (1 - k);
          d[o + 2] = Math.round(Math.round(s[o + 2] / step) * step) * (1 - k);
          d[o + 3] = s[o + 3];
        }
      }
    },
  });

  define('watercolor', {
    label: 'Watercolour', group: 'Stylize',
    description: 'Soft washes of flat colour that pool darker along every contour.',
    params: {
      wash: numParam('Wash', 1, 24, 1, 5, 'px'),
      pigment: numParam('Pigment', 3, 16, 1, 7),
      paper: numParam('Paper grain', 0, 1, 0.01, 0.35),
    },
    defaultParams: { wash: 5, pigment: 7, paper: 0.35 },
    pixelEffect: true,
    pixelWork(src, dst, w, h, p) {
      const s = src.data, d = dst.data;
      const bl = blurredCopy(s, w, h, clamp(p.wash, 1, 24));
      const n = Math.max(2, Math.round(clamp(p.pigment, 3, 16)));
      const step = 255 / (n - 1);
      const grain = clamp(p.paper, 0, 1) * 22;
      const lp = lumaPlane(s, w, h);
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const o = (y * w + x) * 4;
          const gx = planeAt(lp, w, h, x + 1, y) - planeAt(lp, w, h, x - 1, y);
          const gy = planeAt(lp, w, h, x, y + 1) - planeAt(lp, w, h, x, y - 1);
          const k = clamp(Math.sqrt(gx * gx + gy * gy) / 255 * 1.7, 0, 0.5);
          const nz = grain * (hash01(x * 7.13 + y * 31.7) - 0.5);
          d[o] = clamp(Math.round(Math.round(bl[o] / step) * step) * (1 - k) + 8 + nz, 0, 255);
          d[o + 1] = clamp(Math.round(Math.round(bl[o + 1] / step) * step) * (1 - k) + 8 + nz, 0, 255);
          d[o + 2] = clamp(Math.round(Math.round(bl[o + 2] / step) * step) * (1 - k) + 6 + nz, 0, 255);
          d[o + 3] = s[o + 3];
        }
      }
    },
  });

  define('newsprint', {
    label: 'Newsprint', group: 'Stylize',
    description: 'Halftone dots of black ink pressed into cheap grey paper.',
    params: {
      cell: numParam('Cell', 3, 16, 1, 6, 'px'),
      ink: numParam('Ink', 0.2, 1, 0.01, 1),
      paperTone: colParam('Paper', '#efe7d5'),
    },
    defaultParams: { cell: 6, ink: 1, paperTone: '#efe7d5' },
    pixelEffect: true,
    pixelWork(src, dst, w, h, p) {
      const s = src.data, d = dst.data;
      const cell = Math.max(3, Math.round(clamp(p.cell, 3, 16)));
      const pc = hexRGB(p.paperTone);
      const ink = clamp(p.ink, 0.1, 1);
      const half = cell / 2, rad = half * 1.42;
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const o = (y * w + x) * 4;
          const l = (s[o] * 0.2126 + s[o + 1] * 0.7152 + s[o + 2] * 0.0722) / 255;
          const dx = (x % cell) - half + 0.5, dy = (y % cell) - half + 0.5;
          const r0 = Math.sqrt(clamp(1 - l, 0, 1)) * rad;
          const cov = clamp((r0 - Math.sqrt(dx * dx + dy * dy)) * ink * 2, 0, 1);
          d[o] = pc[0] * (1 - cov);
          d[o + 1] = pc[1] * (1 - cov);
          d[o + 2] = pc[2] * (1 - cov);
          d[o + 3] = s[o + 3];
        }
      }
    },
  });

  define('blueprint', {
    label: 'Blueprint', group: 'Stylize',
    description: 'White technical linework over drafting blue, as if photocopied from a plan.',
    params: {
      lineWeight: numParam('Line weight', 0, 1, 0.01, 0.5),
      paper: colParam('Paper', '#123a7a'),
    },
    defaultParams: { lineWeight: 0.5, paper: '#123a7a' },
    pixelEffect: true,
    pixelWork(src, dst, w, h, p) {
      const s = src.data, d = dst.data;
      const pc = hexRGB(p.paper);
      const lw = clamp(p.lineWeight, 0, 1);
      const lp = lumaPlane(s, w, h);
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const o = (y * w + x) * 4;
          const gx = planeAt(lp, w, h, x + 1, y) - planeAt(lp, w, h, x - 1, y);
          const gy = planeAt(lp, w, h, x, y + 1) - planeAt(lp, w, h, x, y - 1);
          const mag = clamp(Math.sqrt(gx * gx + gy * gy) / 255 * (1.2 + lw * 3), 0, 1);
          const l = planeAt(lp, w, h, x, y) / 255;
          const v = clamp(mag + l * 0.3 * lw, 0, 1);
          d[o] = pc[0] + (255 - pc[0]) * v;
          d[o + 1] = pc[1] + (255 - pc[1]) * v;
          d[o + 2] = pc[2] + (255 - pc[2]) * v;
          d[o + 3] = s[o + 3];
        }
      }
    },
  });

  define('nightvision', {
    label: 'Night Vision', group: 'Stylize',
    description: 'Image-intensifier green with bloom lift and sensor speckle.',
    params: {
      gain: numParam('Gain', 0.5, 6, 0.05, 2.4),
      grain: numParam('Sensor grain', 0, 1, 0.01, 0.35),
      tint: colParam('Tint', '#7dff8f'),
    },
    defaultParams: { gain: 2.4, grain: 0.35, tint: '#7dff8f' },
    pixelEffect: true,
    pixelWork(src, dst, w, h, p) {
      const s = src.data, d = dst.data;
      const t = hexRGB(p.tint);
      const gain = clamp(p.gain, 0.5, 6);
      const grain = clamp(p.grain, 0, 1);
      for (let i = 0, px = 0; i < s.length; i += 4, px++) {
        const l = clamp(((s[i] * 0.2126 + s[i + 1] * 0.7152 + s[i + 2] * 0.0722) / 255) * gain, 0, 1);
        const n = grain * (hash01(px * 12.9898) - 0.5) * 0.3;
        const v = clamp(l + n, 0, 1);
        const glow = v * v * 46;
        d[i] = clamp(t[0] * v + glow, 0, 255);
        d[i + 1] = clamp(t[1] * v + glow, 0, 255);
        d[i + 2] = clamp(t[2] * v + glow * 0.6, 0, 255);
        d[i + 3] = s[i + 3];
      }
    },
  });

  define('dotmatrix', {
    label: 'Dot Matrix', group: 'Stylize',
    description: 'A grid of round LEDs, each lit in proportion to the brightness beneath it.',
    params: {
      cell: numParam('Cell', 3, 20, 1, 7, 'px'),
      gap: numParam('Gap', 0, 0.6, 0.01, 0.22),
    },
    defaultParams: { cell: 7, gap: 0.22 },
    pixelEffect: true,
    pixelWork(src, dst, w, h, p) {
      const s = src.data, d = dst.data;
      const cell = Math.max(3, Math.round(clamp(p.cell, 3, 20)));
      const gap = clamp(p.gap, 0, 0.6);
      const c = cell / 2 - 0.5;
      const rad = c * (1 - gap);
      const soft = Math.max(0.5, rad * 0.4);
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const o = (y * w + x) * 4;
          const dx = (x % cell) - c, dy = (y % cell) - c;
          const cov = clamp((rad - Math.sqrt(dx * dx + dy * dy)) / soft, 0, 1);
          const k = 0.05 + cov * 0.95;
          d[o] = s[o] * k;
          d[o + 1] = s[o + 1] * k;
          d[o + 2] = s[o + 2] * k;
          d[o + 3] = s[o + 3];
        }
      }
    },
  });

  define('palette', {
    label: 'Palette', group: 'Stylize',
    description: 'Snap the picture to a small retro palette with ordered dithering.',
    params: {
      size: numParam('Colours', 4, 64, 1, 16),
      dither: numParam('Dither', 0, 1, 0.01, 0.6),
      spread: numParam('Spread', 0.4, 1.6, 0.01, 1),
    },
    defaultParams: { size: 16, dither: 0.6, spread: 1 },
    pixelEffect: true,
    pixelWork(src, dst, w, h, p) {
      const s = src.data, d = dst.data;
      const n = Math.max(4, Math.round(clamp(p.size, 4, 64)));
      const sp = clamp(p.spread, 0.4, 1.6);
      const dith = clamp(p.dither, 0, 1);
      /* Cube root keeps the number of levels per channel near the cube the user asked for. */
      const per = Math.max(2, Math.round(Math.cbrt(n)));
      const step = 255 / (per - 1);
      const bayer = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const o = (y * w + x) * 4;
          const th = (bayer[(y & 3) * 4 + (x & 3)] / 16 - 0.5) * step * dith * sp;
          for (let ch = 0; ch < 3; ch++) {
            const q = Math.round(clamp((s[o + ch] * sp + th) / step, 0, per - 1)) * step;
            d[o + ch] = clamp(q, 0, 255);
          }
          d[o + 3] = s[o + 3];
        }
      }
    },
  });

  define('crt', {
    label: 'CRT Screen', group: 'Stylize',
    description: 'Shadow-mask triads, a glassy vignette and one slow rolling bar.',
    params: {
      triad: numParam('Triad size', 1, 8, 1, 3, 'px'),
      mask: numParam('Mask', 0, 1, 0.01, 0.35),
      curve: numParam('Glass curve', 0, 1, 0.01, 0.5),
      roll: numParam('Roll speed', -3, 3, 0.1, 0.6),
    },
    defaultParams: { triad: 3, mask: 0.35, curve: 0.5, roll: 0.6 },
    draw(ctx, w, h, p, t, frameLocal, fps) {
      const size = Math.max(1, Math.round(clamp(p.triad, 1, 8)));
      const mask = clamp(p.mask, 0, 1);
      const curve = clamp(p.curve, 0, 1);
      if (mask > 0.001) {
        const tile = scratchCanvas(t, 'crtTile', size * 3, 1);
        const g = tile.getContext('2d');
        g.clearRect(0, 0, size * 3, 1);
        const damp = (v) => Math.round(255 - (255 - v) * mask);
        const cols = [[255, 60, 60], [60, 255, 60], [60, 60, 255]];
        for (let i = 0; i < 3; i++) {
          g.fillStyle = 'rgb(' + damp(cols[i][0]) + ',' + damp(cols[i][1]) + ',' + damp(cols[i][2]) + ')';
          g.fillRect(i * size, 0, size, 1);
        }
        const pat = ctx.createPattern(tile, 'repeat');
        if (pat) {
          ctx.save();
          ctx.globalCompositeOperation = 'multiply';
          ctx.fillStyle = pat;
          ctx.fillRect(0, 0, w, h);
          ctx.restore();
        }
      }
      if (curve > 0.001) {
        const r = Math.hypot(w, h) / 2;
        const vg = ctx.createRadialGradient(w / 2, h / 2, r * 0.45, w / 2, h / 2, r);
        vg.addColorStop(0, 'rgba(0,0,0,0)');
        vg.addColorStop(1, 'rgba(0,0,0,' + (curve * 0.55).toFixed(3) + ')');
        ctx.fillStyle = vg;
        ctx.fillRect(0, 0, w, h);
      }
      const speed = clamp(p.roll, -3, 3);
      if (Math.abs(speed) > 0.01 && fps) {
        const span = h * 0.16;
        const secs = frameLocal / fps;
        const y = ((secs * speed * 0.35) % 1 + 1) % 1 * (h + span) - span;
        const rg = ctx.createLinearGradient(0, y, 0, y + span);
        rg.addColorStop(0, 'rgba(255,255,255,0)');
        rg.addColorStop(0.5, 'rgba(255,255,255,0.05)');
        rg.addColorStop(1, 'rgba(255,255,255,0)');
        ctx.save();
        ctx.globalCompositeOperation = 'lighter';
        ctx.fillStyle = rg;
        ctx.fillRect(0, y, w, span);
        ctx.restore();
      }
    },
  });

  define('halation', {
    label: 'Halation', group: 'Stylize',
    description: 'A red-weighted bloom that leaks out of the highlights the way film backing does.',
    params: {
      amount: numParam('Amount', 0, 1, 0.01, 0.5),
      radius: numParam('Radius', 1, 60, 1, 12, 'px'),
      threshold: numParam('Threshold', 0, 1, 0.01, 0.55),
    },
    defaultParams: { amount: 0.5, radius: 12, threshold: 0.55 },
    pixelEffect: true,
    pixelWork(src, dst, w, h, p) {
      const s = src.data, d = dst.data;
      const amt = clamp(p.amount, 0, 1) * 1.5;
      if (amt <= 0.001) {
        d.set(s);
        return;
      }
      const thr = clamp(p.threshold, 0, 1) * 255;
      const span = Math.max(1, 255 - thr);
      const hi = new Uint8ClampedArray(s.length);
      for (let i = 0; i < s.length; i += 4) {
        const l = s[i] * 0.2126 + s[i + 1] * 0.7152 + s[i + 2] * 0.0722;
        const k = l > thr ? (l - thr) / span : 0;
        hi[i] = s[i] * k;
        hi[i + 1] = s[i + 1] * k;
        hi[i + 2] = s[i + 2] * k;
        hi[i + 3] = 255;
      }
      const bloom = blurredCopy(hi, w, h, clamp(p.radius, 1, 60));
      for (let i = 0; i < s.length; i += 4) {
        d[i] = clamp(s[i] + bloom[i] * amt * 0.8, 0, 255);
        d[i + 1] = clamp(s[i + 1] + bloom[i + 1] * amt * 0.34, 0, 255);
        d[i + 2] = clamp(s[i + 2] + bloom[i + 2] * amt * 0.22, 0, 255);
        d[i + 3] = s[i + 3];
      }
    },
  });

  /* ---- Distort ---- */

  define('barrel', {
    label: 'Barrel / Pincushion', group: 'Distort',
    description: 'Bend straight lines the way a real lens does. Positive bows outward, negative pinches in.',
    params: {
      amount: numParam('Amount', -1, 1, 0.01, 0.2),
      zoom: numParam('Zoom', 0.5, 2, 0.01, 1),
    },
    defaultParams: { amount: 0.2, zoom: 1 },
    pixelEffect: true,
    pixelWork(src, dst, w, h, p) {
      const s = src.data, d = dst.data;
      const k = clamp(p.amount, -1, 1);
      const zoom = clamp(p.zoom, 0.5, 2);
      const cx = w / 2, cy = h / 2;
      const R = Math.max(cx, cy);
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const ux = (x - cx) / R, uy = (y - cy) / R;
          const f = (1 + k * (ux * ux + uy * uy)) / zoom;
          const xi = Math.min(w - 1, Math.max(0, Math.round(cx + ux * R * f)));
          const yi = Math.min(h - 1, Math.max(0, Math.round(cy + uy * R * f)));
          const i = (yi * w + xi) * 4, o = (y * w + x) * 4;
          d[o] = s[i]; d[o + 1] = s[i + 1]; d[o + 2] = s[i + 2]; d[o + 3] = s[i + 3];
        }
      }
    },
  });

  define('sphere', {
    label: 'Sphere', group: 'Distort',
    description: 'Wrap the picture around a glossy ball, as if caught in a glass ornament.',
    params: {
      amount: numParam('Bulge', 0, 1, 0.01, 0.7),
      radius: numParam('Radius', 0.2, 1.2, 0.01, 0.6),
      light: numParam('Specular', 0, 1, 0.01, 0.3),
    },
    defaultParams: { amount: 0.7, radius: 0.6, light: 0.3 },
    pixelEffect: true,
    pixelWork(src, dst, w, h, p) {
      const s = src.data, d = dst.data;
      const amt = clamp(p.amount, 0, 1);
      const light = clamp(p.light, 0, 1);
      const R = clamp(p.radius, 0.2, 1.2) * Math.min(w, h) / 2;
      const cx = w / 2, cy = h / 2;
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const o = (y * w + x) * 4;
          const dx = x - cx, dy = y - cy;
          const dist = Math.hypot(dx, dy);
          if (dist > R) {
            d[o] = 0; d[o + 1] = 0; d[o + 2] = 0; d[o + 3] = s[o + 3];
            continue;
          }
          const t = dist / R;
          const z = Math.sqrt(Math.max(0, 1 - t * t));
          const k = amt > 0.001 ? Math.pow(Math.max(1e-6, t), amt * 1.6) : 1;
          const i = (
            Math.min(h - 1, Math.max(0, Math.round(cy + dy * k))) * w +
            Math.min(w - 1, Math.max(0, Math.round(cx + dx * k)))
          ) * 4;
          const hx = (dx + 0.34 * R) / (R * 0.46);
          const hy = (dy + 0.4 * R) / (R * 0.46);
          const spec = light * Math.max(0, 1 - (hx * hx + hy * hy)) * z * 235;
          d[o] = clamp(s[i] + spec, 0, 255);
          d[o + 1] = clamp(s[i + 1] + spec, 0, 255);
          d[o + 2] = clamp(s[i + 2] + spec, 0, 255);
          d[o + 3] = s[o + 3];
        }
      }
    },
  });

  define('perspective', {
    label: 'Perspective', group: 'Distort',
    description: 'Tilt the frame in three dimensions for a keystone, as if the screen were facing away.',
    params: {
      tiltX: numParam('Tilt X', -0.8, 0.8, 0.01, 0.25),
      tiltY: numParam('Tilt Y', -0.8, 0.8, 0.01, 0),
      zoom: numParam('Zoom', 0.5, 2, 0.01, 1),
    },
    defaultParams: { tiltX: 0.25, tiltY: 0, zoom: 1 },
    pixelEffect: true,
    pixelWork(src, dst, w, h, p) {
      const s = src.data, d = dst.data;
      const kx = clamp(p.tiltX, -0.8, 0.8) / 1.6;
      const ky = clamp(p.tiltY, -0.8, 0.8) / 1.6;
      const zoom = clamp(p.zoom, 0.5, 2);
      const cx = w / 2, cy = h / 2;
      const R = Math.max(w, h);
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const o = (y * w + x) * 4;
          const ux = ((x - cx) / R) * zoom, uy = ((y - cy) / R) * zoom;
          const den = 1 + kx * uy + ky * ux;
          const f = Math.abs(den) < 1e-4 ? 1e4 : 1 / den;
          const xi = Math.min(w - 1, Math.max(0, Math.round(cx + ux * f * R)));
          const yi = Math.min(h - 1, Math.max(0, Math.round(cy + uy * f * R)));
          const i = (yi * w + xi) * 4;
          d[o] = s[i]; d[o + 1] = s[i + 1]; d[o + 2] = s[i + 2]; d[o + 3] = s[i + 3];
        }
      }
    },
  });

  define('vortex', {
    label: 'Vortex', group: 'Distort',
    description: 'Spin the picture into a whirlpool that unwinds again before it reaches the edges.',
    params: {
      twist: numParam('Twist', -8, 8, 0.1, 2.5),
      radius: numParam('Radius', 0.1, 1.2, 0.01, 0.6),
      falloff: numParam('Falloff', 0.2, 3, 0.05, 1),
    },
    defaultParams: { twist: 2.5, radius: 0.6, falloff: 1 },
    pixelEffect: true,
    pixelWork(src, dst, w, h, p) {
      const s = src.data, d = dst.data;
      const twist = clamp(p.twist, -8, 8);
      const R = clamp(p.radius, 0.1, 1.2) * Math.min(w, h) / 2;
      const fall = clamp(p.falloff, 0.2, 3);
      const cx = w / 2, cy = h / 2;
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const dx = x - cx, dy = y - cy;
          const a = twist * Math.pow(1 - Math.min(1, Math.hypot(dx, dy) / R), fall);
          const ca = Math.cos(a), sa = Math.sin(a);
          const xi = Math.min(w - 1, Math.max(0, Math.round(cx + dx * ca - dy * sa)));
          const yi = Math.min(h - 1, Math.max(0, Math.round(cy + dx * sa + dy * ca)));
          const i = (yi * w + xi) * 4, o = (y * w + x) * 4;
          d[o] = s[i]; d[o + 1] = s[i + 1]; d[o + 2] = s[i + 2]; d[o + 3] = s[i + 3];
        }
      }
    },
  });

  define('polar', {
    label: 'Polar Coordinates', group: 'Distort',
    description: 'Unroll the picture into a ring, or coil a ring back into the frame.',
    params: {
      mode: selParam('Direction', [['rect2polar', 'Circle the frame'], ['polar2rect', 'Unroll the circle']], 'rect2polar'),
    },
    defaultParams: { mode: 'rect2polar' },
    pixelEffect: true,
    pixelWork(src, dst, w, h, p) {
      const s = src.data, d = dst.data;
      const rect2polar = p.mode !== 'polar2rect';
      const cx = w / 2, cy = h / 2;
      const maxR = Math.min(cx, cy);
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          let sx, sy;
          if (rect2polar) {
            const dx = x - cx, dy = y - cy;
            sx = (Math.atan2(dy, dx) / (Math.PI * 2) + 0.5) * w;
            sy = (Math.hypot(dx, dy) / maxR) * h;
          } else {
            const a = (x / w - 0.5) * Math.PI * 2;
            const r = (y / h) * maxR;
            sx = cx + Math.cos(a) * r;
            sy = cy + Math.sin(a) * r;
          }
          const i = (
            Math.min(h - 1, Math.max(0, Math.round(sy))) * w +
            Math.min(w - 1, Math.max(0, Math.round(sx)))
          ) * 4;
          const o = (y * w + x) * 4;
          d[o] = s[i]; d[o + 1] = s[i + 1]; d[o + 2] = s[i + 2]; d[o + 3] = s[i + 3];
        }
      }
    },
  });

  define('noisedisplace', {
    label: 'Noise Displace', group: 'Distort',
    description: 'Jitter pixels along a drifting noise field: heat haze, underwater wobble or a dodgy tape.',
    params: {
      amount: numParam('Amount', 0, 120, 1, 18, 'px'),
      scale: numParam('Scale', 8, 200, 1, 42, 'px'),
      speed: numParam('Speed', 0, 8, 0.1, 1),
      axis: selParam('Axis', [['both', 'Both'], ['x', 'Horizontal'], ['y', 'Vertical']], 'both'),
    },
    defaultParams: { amount: 18, scale: 42, speed: 1, axis: 'both' },
    pixelEffect: true,
    pixelWork(src, dst, w, h, p, scratch, frameLocal, fps) {
      const s = src.data, d = dst.data;
      const amt = clamp(p.amount, 0, 120);
      const scale = Math.max(4, clamp(p.scale, 8, 200));
      const speed = clamp(p.speed, 0, 8);
      const tsec = fps ? ((frameLocal || 0) / fps) * speed : 0;
      const ax = p.axis !== 'y', ay = p.axis !== 'x';
      /* The field is separable, so four small tables replace four trig calls per pixel. */
      const px = new Float32Array(w), qx = new Float32Array(w);
      const py = new Float32Array(h), qy = new Float32Array(h);
      for (let x = 0; x < w; x++) {
        const g = x / scale;
        px[x] = Math.sin(g * 3.1 + tsec * 1.7);
        qx[x] = Math.cos(g * 2.1 + tsec * 0.9);
      }
      for (let y = 0; y < h; y++) {
        const g = y / scale;
        py[y] = Math.cos(g * 2.3 - tsec * 1.1);
        qy[y] = Math.sin(g * 3.7 - tsec * 1.3);
      }
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const o = (y * w + x) * 4;
          const sx = ax ? x + px[x] * py[y] * amt : x;
          const sy = ay ? y + qy[y] * qx[x] * amt : y;
          const i = (
            Math.min(h - 1, Math.max(0, Math.round(sy))) * w +
            Math.min(w - 1, Math.max(0, Math.round(sx)))
          ) * 4;
          d[o] = s[i]; d[o + 1] = s[i + 1]; d[o + 2] = s[i + 2]; d[o + 3] = s[i + 3];
        }
      }
    },
  });

  define('fracture', {
    label: 'Fracture', group: 'Distort',
    description: 'Shatter the picture into shards and let each one slide out of true.',
    params: {
      shards: numParam('Shards', 6, 40, 1, 16),
      offset: numParam('Offset', 0, 0.3, 0.005, 0.06),
      seed: numParam('Seed', 0, 99, 1, 7),
    },
    defaultParams: { shards: 16, offset: 0.06, seed: 7 },
    draw(ctx, w, h, p, t) {
      const n = Math.max(3, Math.round(clamp(p.shards, 6, 40)));
      const off = clamp(p.offset, 0, 0.3);
      if (off <= 0.001) return;
      const seed = clamp(p.seed, 0, 99);
      const src = scratchCanvas(t, 'fractureSrc', w, h);
      const sg = src.getContext('2d');
      sg.clearRect(0, 0, w, h);
      sg.drawImage(ctx.canvas, 0, 0);
      /* The undistorted frame stays put underneath so the shards can never
         leave a hole at the edges. */
      ctx.drawImage(src, 0, 0);
      const cx = w / 2, cy = h / 2;
      const R = Math.hypot(w, h);
      const pts = [];
      for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2 + hash01(i * 5.7 + seed) * 0.6;
        const r = R * (0.78 + hash01(i * 9.3 + seed + 41) * 0.42);
        pts.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r]);
      }
      for (let i = 0; i < n; i++) {
        const a = pts[i], b = pts[(i + 1) % n];
        ctx.save();
        ctx.beginPath();
        ctx.moveTo(cx, cy);
        ctx.lineTo(a[0], a[1]);
        ctx.lineTo(b[0], b[1]);
        ctx.closePath();
        ctx.clip();
        ctx.drawImage(src,
          (hash01(i * 3.3 + seed + 7) - 0.5) * off * w,
          (hash01(i * 8.1 + seed + 19) - 0.5) * off * h);
        ctx.restore();
        ctx.save();
        ctx.strokeStyle = 'rgba(0,0,0,0.35)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(cx, cy);
        ctx.lineTo(a[0], a[1]);
        ctx.moveTo(cx, cy);
        ctx.lineTo(b[0], b[1]);
        ctx.stroke();
        ctx.restore();
      }
    },
  });

  /* ---- Render ---- */

  define('matte', {
    label: 'Solid Colour', group: 'Render',
    description: 'Flood the frame with a flat colour: a backing, a matte, or a straight fade to black.',
    params: {
      color: colParam('Colour', '#000000'),
      opacity: numParam('Opacity', 0, 1, 0.01, 1),
      blend: selParam('Blend', [['source-over', 'Normal'], ['multiply', 'Multiply'], ['screen', 'Screen'], ['overlay', 'Overlay'], ['lighter', 'Add']], 'source-over'),
    },
    defaultParams: { color: '#000000', opacity: 1, blend: 'source-over' },
    draw(ctx, w, h, p) {
      const a = clamp(p.opacity, 0, 1);
      if (a <= 0.001) return;
      ctx.save();
      ctx.globalAlpha = a;
      ctx.globalCompositeOperation = p.blend || 'source-over';
      ctx.fillStyle = p.color || '#000000';
      ctx.fillRect(0, 0, w, h);
      ctx.restore();
    },
  });

  define('gradient', {
    label: 'Gradient Overlay', group: 'Render',
    description: 'Wash the frame with a linear or radial gradient tint.',
    params: {
      from: colParam('From', '#ff8a3c'),
      to: colParam('To', '#2a1a6a'),
      angle: numParam('Angle', 0, 360, 1, 200, 'deg'),
      shape: selParam('Shape', [['linear', 'Linear'], ['radial', 'Radial']], 'linear'),
      swap: selParam('Fade ends', [['no', 'Normal'], ['yes', 'Swap ends']], 'no'),
      opacity: numParam('Opacity', 0, 1, 0.01, 0.6),
    },
    defaultParams: { from: '#ff8a3c', to: '#2a1a6a', angle: 200, shape: 'linear', swap: 'no', opacity: 0.6 },
    draw(ctx, w, h, p) {
      const a = clamp(p.opacity, 0, 1);
      if (a <= 0.001) return;
      let g;
      if (p.shape === 'radial') {
        g = ctx.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, Math.hypot(w, h) / 2);
      } else {
        const ang = (clamp(p.angle, 0, 360) * Math.PI) / 180;
        const dx = Math.cos(ang) * w * 0.5, dy = Math.sin(ang) * h * 0.5;
        g = ctx.createLinearGradient(w / 2 - dx, h / 2 - dy, w / 2 + dx, h / 2 + dy);
      }
      g.addColorStop(0, p.swap === 'yes' ? p.to : p.from);
      g.addColorStop(1, p.swap === 'yes' ? p.from : p.to);
      ctx.save();
      ctx.globalAlpha = a;
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, w, h);
      ctx.restore();
    },
  });

  define('grid', {
    label: 'Grid Overlay', group: 'Render',
    description: 'A layout grid for composing: eighths, a fine mesh, or bold rule-of-thirds.',
    params: {
      divisions: numParam('Divisions', 2, 48, 1, 8),
      thickness: numParam('Thickness', 1, 6, 1, 1, 'px'),
      color: colParam('Colour', '#66ffcc'),
      opacity: numParam('Opacity', 0, 1, 0.01, 0.35),
      thirds: selParam('Bold thirds', [['yes', 'Yes'], ['no', 'No']], 'yes'),
    },
    defaultParams: { divisions: 8, thickness: 1, color: '#66ffcc', opacity: 0.35, thirds: 'yes' },
    draw(ctx, w, h, p) {
      const a = clamp(p.opacity, 0, 1);
      if (a <= 0.001) return;
      const n = Math.max(2, Math.round(clamp(p.divisions, 2, 48)));
      const th = clamp(p.thickness, 1, 6);
      ctx.save();
      ctx.globalAlpha = a;
      ctx.fillStyle = p.color || '#ffffff';
      for (let i = 1; i < n; i++) ctx.fillRect((i / n) * w - th / 2, 0, th, h);
      for (let i = 1; i < n; i++) ctx.fillRect(0, (i / n) * h - th / 2, w, th);
      if (p.thirds === 'yes') {
        ctx.globalAlpha = clamp(a * 1.9, 0, 1);
        const t2 = th * 1.7;
        ctx.fillRect(w / 3 - t2 / 2, 0, t2, h);
        ctx.fillRect((2 * w) / 3 - t2 / 2, 0, t2, h);
        ctx.fillRect(0, h / 3 - t2 / 2, w, t2);
        ctx.fillRect(0, (2 * h) / 3 - t2 / 2, w, t2);
      }
      ctx.restore();
    },
  });

  define('safearea', {
    label: 'Safe Area', group: 'Render',
    description: 'Title- and action-safe guides for checking a frame before broadcast.',
    params: {
      title: numParam('Title safe', 0.5, 1, 0.01, 0.9),
      action: numParam('Action safe', 0.5, 1, 0.01, 0.95),
      color: colParam('Colour', '#ffffff'),
      opacity: numParam('Opacity', 0, 1, 0.01, 0.4),
    },
    defaultParams: { title: 0.9, action: 0.95, color: '#ffffff', opacity: 0.4 },
    draw(ctx, w, h, p) {
      const a = clamp(p.opacity, 0, 1);
      if (a <= 0.001) return;
      ctx.save();
      ctx.globalAlpha = a;
      ctx.strokeStyle = p.color || '#ffffff';
      ctx.lineWidth = Math.max(1, Math.round(Math.min(w, h) / 400));
      const box = (s, dash) => {
        const bw = w * clamp(s, 0.5, 1), bh = h * clamp(s, 0.5, 1);
        ctx.save();
        if (dash) ctx.setLineDash(dash);
        ctx.strokeRect(Math.round((w - bw) / 2) + 0.5, Math.round((h - bh) / 2) + 0.5, Math.round(bw), Math.round(bh));
        ctx.restore();
      };
      box(p.action, null);
      box(p.title, [Math.max(4, w / 60), Math.max(4, w / 90)]);
      ctx.restore();
    },
  });

  define('lightrays', {
    label: 'Light Rays', group: 'Render',
    description: 'Volumetric god-rays fanning out from a point in the frame.',
    params: {
      count: numParam('Rays', 4, 64, 1, 22),
      length: numParam('Length', 0.2, 3, 0.01, 1.4),
      spread: numParam('Spread', 0.1, 1, 0.01, 0.8),
      falloff: numParam('Falloff', 0, 1, 0.01, 0.7),
      color: colParam('Colour', '#ffd9a0'),
      opacity: numParam('Opacity', 0, 1, 0.01, 0.4),
      cx: numParam('Source X', 0, 1, 0.01, 0.5),
      cy: numParam('Source Y', 0, 1, 0.01, 0.35),
    },
    defaultParams: { count: 22, length: 1.4, spread: 0.8, falloff: 0.7, color: '#ffd9a0', opacity: 0.4, cx: 0.5, cy: 0.35 },
    draw(ctx, w, h, p) {
      const a = clamp(p.opacity, 0, 1);
      if (a <= 0.001) return;
      const n = Math.max(2, Math.round(clamp(p.count, 4, 64)));
      const len = clamp(p.length, 0.2, 3) * Math.hypot(w, h);
      const cx = clamp(p.cx, 0, 1) * w, cy = clamp(p.cy, 0, 1) * h;
      const rgb = hexRGB(p.color);
      const soft = clamp(p.falloff, 0, 1);
      const spread = clamp(p.spread, 0.1, 1);
      const rgba = (k) => 'rgba(' + rgb.join(',') + ',' + (a * k).toFixed(3) + ')';
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      for (let i = 0; i < n; i++) {
        const base = (i / n) * Math.PI * 2;
        const half = (Math.PI / n) * spread;
        const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, len);
        g.addColorStop(0, rgba(1 - soft * 0.6));
        g.addColorStop(0.55, rgba(0.35 * (1 - soft * 0.4)));
        g.addColorStop(1, rgba(0));
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.moveTo(cx, cy);
        ctx.arc(cx, cy, len, base - half, base + half);
        ctx.closePath();
        ctx.fill();
      }
      ctx.restore();
    },
  });

  define('starflare', {
    label: 'Star Filter', group: 'Render',
    description: 'Cross-shaped streaks thrown off a bright point, as if a star filter were on the lens.',
    params: {
      points: numParam('Streaks', 2, 12, 1, 4),
      length: numParam('Length', 0.1, 1.5, 0.01, 0.7),
      thickness: numParam('Thickness', 0.002, 0.12, 0.001, 0.02),
      rotation: numParam('Rotation', 0, 180, 1, 0, 'deg'),
      color: colParam('Colour', '#fff3d0'),
      opacity: numParam('Opacity', 0, 1, 0.01, 0.45),
      cx: numParam('Source X', 0, 1, 0.01, 0.5),
      cy: numParam('Source Y', 0, 1, 0.01, 0.4),
    },
    defaultParams: { points: 4, length: 0.7, thickness: 0.02, rotation: 0, color: '#fff3d0', opacity: 0.45, cx: 0.5, cy: 0.4 },
    draw(ctx, w, h, p) {
      const a = clamp(p.opacity, 0, 1);
      if (a <= 0.001) return;
      const n = Math.max(2, Math.round(clamp(p.points, 2, 12)));
      const len = clamp(p.length, 0.1, 1.5) * Math.hypot(w, h) * 0.6;
      const th = clamp(p.thickness, 0.002, 0.12) * Math.min(w, h);
      const rgb = hexRGB(p.color);
      const head = 'rgba(' + rgb.join(',') + ',' + a.toFixed(3) + ')';
      const tail = 'rgba(' + rgb.join(',') + ',0)';
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.translate(clamp(p.cx, 0, 1) * w, clamp(p.cy, 0, 1) * h);
      ctx.rotate((clamp(p.rotation, 0, 180) * Math.PI) / 180);
      for (let i = 0; i < n; i++) {
        ctx.save();
        ctx.rotate((i / n) * Math.PI);
        const g = ctx.createLinearGradient(0, 0, len, 0);
        g.addColorStop(0, head);
        g.addColorStop(1, tail);
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.moveTo(0, -th / 2);
        ctx.lineTo(len, -th * 0.16);
        ctx.lineTo(len, th * 0.16);
        ctx.lineTo(0, th / 2);
        ctx.closePath();
        ctx.fill();
        ctx.restore();
      }
      ctx.restore();
    },
  });

  define('rain', {
    label: 'Rain', group: 'Render',
    description: 'Sheets of falling rain, drawn over a couple of depth layers.',
    params: {
      density: numParam('Density', 10, 400, 1, 120),
      angle: numParam('Angle', -40, 40, 1, 8, 'deg'),
      speed: numParam('Speed', 1, 30, 0.5, 12),
      streak: numParam('Streak', 4, 120, 1, 34, 'px'),
      color: colParam('Colour', '#cfe6ff'),
      opacity: numParam('Opacity', 0, 1, 0.01, 0.45),
    },
    defaultParams: { density: 120, angle: 8, speed: 12, streak: 34, color: '#cfe6ff', opacity: 0.45 },
    draw(ctx, w, h, p, t, frameLocal, fps) {
      const a = clamp(p.opacity, 0, 1);
      if (a <= 0.001) return;
      const n = Math.max(4, Math.round(clamp(p.density, 10, 400)));
      const ax = Math.tan((clamp(p.angle, -40, 40) * Math.PI) / 180);
      const len = clamp(p.streak, 4, 120);
      const sp = clamp(p.speed, 1, 30);
      const secs = fps ? (frameLocal || 0) / fps : 0;
      const span = h + len * 2;
      ctx.save();
      ctx.strokeStyle = p.color || '#cfe6ff';
      ctx.lineCap = 'round';
      for (let i = 0; i < n; i++) {
        const depth = 0.45 + hash01(i * 11.3) * 0.85;
        const x0 = hash01(i * 3.1) * w * 1.2 - w * 0.1;
        const y = (((hash01(i * 7.7) * span + secs * sp * depth * h * 0.5) % span) + span) % span - len;
        const fade = clamp((y + len) / (h * 0.22), 0, 1) * clamp((span - y) / (h * 0.18), 0, 1);
        ctx.lineWidth = depth;
        ctx.globalAlpha = a * depth * 0.85 * fade;
        ctx.beginPath();
        ctx.moveTo(x0, y);
        ctx.lineTo(x0 + ax * len, y + len);
        ctx.stroke();
      }
      ctx.restore();
    },
  });

  define('snow', {
    label: 'Snow', group: 'Render',
    description: 'Slow drifting flakes in assorted sizes for a wintry frame.',
    params: {
      density: numParam('Flakes', 10, 500, 1, 160),
      size: numParam('Size', 1, 20, 0.5, 4, 'px'),
      speed: numParam('Fall speed', 0.5, 20, 0.5, 3),
      sway: numParam('Sway', 0, 60, 1, 18, 'px'),
      color: colParam('Colour', '#ffffff'),
      opacity: numParam('Opacity', 0, 1, 0.01, 0.8),
    },
    defaultParams: { density: 160, size: 4, speed: 3, sway: 18, color: '#ffffff', opacity: 0.8 },
    draw(ctx, w, h, p, t, frameLocal, fps) {
      const a = clamp(p.opacity, 0, 1);
      if (a <= 0.001) return;
      const n = Math.max(4, Math.round(clamp(p.density, 10, 500)));
      const sz = clamp(p.size, 1, 20);
      const sp = clamp(p.speed, 0.5, 20);
      const sway = clamp(p.sway, 0, 60);
      const secs = fps ? (frameLocal || 0) / fps : 0;
      const span = h + sz * 4;
      ctx.save();
      ctx.fillStyle = p.color || '#ffffff';
      for (let i = 0; i < n; i++) {
        const depth = 0.35 + hash01(i * 4.9) * 0.9;
        const baseX = hash01(i * 2.7) * w;
        const y = (((hash01(i * 6.1) * span + secs * sp * depth * h * 0.3) % span) + span) % span - sz * 2;
        const x = baseX + Math.sin(secs * 0.6 + i * 1.7) * sway * depth;
        ctx.globalAlpha = a * (0.35 + depth * 0.65);
        ctx.beginPath();
        ctx.arc(x, y, sz * depth * 0.5, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();
    },
  });

  define('dustmotes', {
    label: 'Dust Motes', group: 'Render',
    description: 'Drifting specks that catch a soft light, like motes in a projected beam.',
    params: {
      count: numParam('Motes', 10, 400, 1, 90),
      size: numParam('Size', 1, 14, 0.5, 3, 'px'),
      drift: numParam('Drift', 0, 80, 1, 22, 'px'),
      speed: numParam('Speed', 0, 4, 0.05, 0.5),
      color: colParam('Colour', '#fff0d0'),
      opacity: numParam('Opacity', 0, 1, 0.01, 0.5),
    },
    defaultParams: { count: 90, size: 3, drift: 22, speed: 0.5, color: '#fff0d0', opacity: 0.5 },
    draw(ctx, w, h, p, t, frameLocal, fps) {
      const a = clamp(p.opacity, 0, 1);
      if (a <= 0.001) return;
      const n = Math.max(4, Math.round(clamp(p.count, 10, 400)));
      const sz = clamp(p.size, 1, 14);
      const drift = clamp(p.drift, 0, 80);
      const sp = clamp(p.speed, 0, 4);
      const secs = fps ? (frameLocal || 0) / fps : 0;
      const rgb = hexRGB(p.color);
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      for (let i = 0; i < n; i++) {
        const d = 0.35 + hash01(i * 6.7) * 0.9;
        const spanX = w + drift * 2;
        const x = ((hash01(i * 3.1) * spanX - drift + Math.sin(secs * sp * 0.8 + i) * drift * 0.5) % spanX + spanX) % spanX;
        const spanY = h + drift * 2;
        const y = ((hash01(i * 9.3) * spanY - drift + secs * sp * h * 0.05 * d) % spanY + spanY) % spanY;
        const tw = 0.35 + 0.65 * Math.abs(Math.sin(secs * sp * 1.7 + i * 1.3));
        const r = sz * d * (0.7 + tw * 0.5) * 2.4;
        const g = ctx.createRadialGradient(x, y, 0, x, y, r);
        g.addColorStop(0, 'rgba(' + rgb.join(',') + ',' + (a * d * tw).toFixed(3) + ')');
        g.addColorStop(1, 'rgba(' + rgb.join(',') + ',0)');
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(x, y, r, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();
    },
  });

  define('fire', {
    label: 'Fire', group: 'Render',
    description: 'Licking flames running along the bottom of the frame.',
    params: {
      height: numParam('Height', 0.05, 1, 0.01, 0.45),
      intensity: numParam('Intensity', 0, 1, 0.01, 0.7),
      speed: numParam('Speed', 0.2, 6, 0.05, 1.6),
      color: colParam('Colour', '#ff8a20'),
    },
    defaultParams: { height: 0.45, intensity: 0.7, speed: 1.6, color: '#ff8a20' },
    draw(ctx, w, h, p, t, frameLocal, fps) {
      const a = clamp(p.intensity, 0, 1);
      if (a <= 0.001) return;
      const H = clamp(p.height, 0.05, 1) * h;
      const secs = fps ? (frameLocal || 0) / fps : 0;
      const sp = clamp(p.speed, 0.2, 6);
      const rgb = hexRGB(p.color);
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      const bands = 5;
      for (let b = 0; b < bands; b++) {
        const k = 1 - b / bands;
        const amp = H * (0.35 + 0.65 * k);
        const g = ctx.createLinearGradient(0, h, 0, h - amp);
        g.addColorStop(0, 'rgba(' + rgb.join(',') + ',' + (a * 0.5 * k).toFixed(3) + ')');
        g.addColorStop(0.6, 'rgba(' + Math.min(255, rgb[0] + 40) + ',' + Math.round(rgb[1] * 0.6) + ',' + Math.round(rgb[2] * 0.3) + ',' + (a * 0.22 * k).toFixed(3) + ')');
        g.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.moveTo(0, h);
        const steps = Math.max(8, Math.round(w / 24));
        for (let i = 0; i <= steps; i++) {
          const x = (i / steps) * w;
          const ph = (x / w) * Math.PI * 2;
          ctx.lineTo(x, h - amp * (0.62 + 0.38 * Math.sin(ph * (1.4 + b * 0.5) + secs * sp * (1 + b * 0.3))));
        }
        ctx.lineTo(w, h);
        ctx.closePath();
        ctx.fill();
      }
      ctx.restore();
    },
  });

  define('clouds', {
    label: 'Clouds', group: 'Render',
    description: 'Layered cloud banks built from soft blobs, drifting across the skyline.',
    params: {
      coverage: numParam('Coverage', 0.1, 1, 0.01, 0.5),
      scale: numParam('Scale', 0.2, 2, 0.01, 0.8),
      drift: numParam('Drift', -3, 3, 0.05, 0.3),
      color: colParam('Colour', '#eaf0ff'),
      opacity: numParam('Opacity', 0, 1, 0.01, 0.5),
      seed: numParam('Seed', 0, 99, 1, 12),
    },
    defaultParams: { coverage: 0.5, scale: 0.8, drift: 0.3, color: '#eaf0ff', opacity: 0.5, seed: 12 },
    draw(ctx, w, h, p, t, frameLocal, fps) {
      const a = clamp(p.opacity, 0, 1);
      if (a <= 0.001) return;
      const cov = clamp(p.coverage, 0.1, 1);
      const sc = clamp(p.scale, 0.2, 2);
      const seed = clamp(p.seed, 0, 99);
      const secs = fps ? (frameLocal || 0) / fps : 0;
      const drift = clamp(p.drift, -3, 3) * secs * w * 0.06;
      const blobs = Math.round(10 + cov * 26);
      const rgb = hexRGB(p.color);
      const rgba = (k) => 'rgba(' + rgb.join(',') + ',' + k.toFixed(3) + ')';
      ctx.save();
      ctx.globalAlpha = a;
      for (let i = 0; i < blobs; i++) {
        const bx = hash01(i * 3.7 + seed) * w * 1.4 - w * 0.2 + drift * (0.6 + hash01(i * 5.1) * 0.8);
        const by = h * (0.08 + hash01(i * 8.3 + seed) * 0.42) * (0.5 + cov);
        const r = Math.min(w, h) * sc * (0.1 + hash01(i * 12.9 + seed) * 0.22);
        const g = ctx.createRadialGradient(bx, by, 0, bx, by, r);
        g.addColorStop(0, rgba(0.55));
        g.addColorStop(0.6, rgba(0.22));
        g.addColorStop(1, rgba(0));
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(bx, by, r, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();
    },
  });

  define('smoke', {
    label: 'Smoke', group: 'Render',
    description: 'Curling plumes that rise and spread as they climb out of frame.',
    params: {
      plumes: numParam('Plumes', 1, 6, 1, 2),
      rise: numParam('Rise speed', 0.2, 6, 0.05, 1.2),
      density: numParam('Density', 0.1, 1, 0.01, 0.5),
      color: colParam('Colour', '#d8d8e0'),
      opacity: numParam('Opacity', 0, 1, 0.01, 0.4),
      seed: numParam('Seed', 0, 99, 1, 3),
    },
    defaultParams: { plumes: 2, rise: 1.2, density: 0.5, color: '#d8d8e0', opacity: 0.4, seed: 3 },
    draw(ctx, w, h, p, t, frameLocal, fps) {
      const a = clamp(p.opacity, 0, 1);
      if (a <= 0.001) return;
      const cols = Math.max(1, Math.round(clamp(p.plumes, 1, 6)));
      const rise = clamp(p.rise, 0.2, 6);
      const dens = clamp(p.density, 0.1, 1);
      const seed = clamp(p.seed, 0, 99);
      const secs = fps ? (frameLocal || 0) / fps : 0;
      const rgb = hexRGB(p.color);
      const rgba = (k) => 'rgba(' + rgb.join(',') + ',' + k.toFixed(3) + ')';
      const puffs = Math.round(14 + dens * 22);
      ctx.save();
      for (let c = 0; c < cols; c++) {
        const bx = w * ((c + 0.5) / cols + (hash01(c * 7.1 + seed) - 0.5) * 0.3);
        for (let i = 0; i < puffs; i++) {
          const life = ((i / puffs) + secs * rise * 0.12) % 1;
          const y = h - life * h * 1.1;
          const wob = Math.sin(life * 5 + c * 2 + secs * 0.7) * w * 0.05 * (0.3 + life);
          const x = bx + wob;
          const r = Math.min(w, h) * (0.05 + life * 0.22) * (0.6 + hash01(i * 3.3 + c) * 0.5);
          const fade = Math.sin(life * Math.PI) * 0.9;
          const g = ctx.createRadialGradient(x, y, 0, x, y, r);
          g.addColorStop(0, rgba(a * dens * fade * 0.7));
          g.addColorStop(0.55, rgba(a * dens * fade * 0.3));
          g.addColorStop(1, rgba(0));
          ctx.fillStyle = g;
          ctx.beginPath();
          ctx.arc(x, y, r, 0, Math.PI * 2);
          ctx.fill();
        }
      }
      ctx.restore();
    },
  });

  define('sparkle', {
    label: 'Sparkle', group: 'Render',
    description: 'Points of light that flare and die at random, for a bit of fairy dust.',
    params: {
      count: numParam('Sparks', 4, 200, 1, 40),
      size: numParam('Size', 2, 40, 0.5, 9, 'px'),
      rate: numParam('Rate', 0.2, 8, 0.05, 1.8),
      streak: numParam('Streak', 0, 4, 0.05, 1.4),
      color: colParam('Colour', '#fff3c0'),
      opacity: numParam('Opacity', 0, 1, 0.01, 0.8),
      seed: numParam('Seed', 0, 99, 1, 5),
    },
    defaultParams: { count: 40, size: 9, rate: 1.8, streak: 1.4, color: '#fff3c0', opacity: 0.8, seed: 5 },
    draw(ctx, w, h, p, t, frameLocal, fps) {
      const a = clamp(p.opacity, 0, 1);
      if (a <= 0.001) return;
      const n = Math.max(2, Math.round(clamp(p.count, 4, 200)));
      const sz = clamp(p.size, 2, 40);
      const rate = clamp(p.rate, 0.2, 8);
      const streak = clamp(p.streak, 0, 4);
      const seed = clamp(p.seed, 0, 99);
      const secs = fps ? (frameLocal || 0) / fps : 0;
      const rgb = hexRGB(p.color);
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.strokeStyle = 'rgba(' + rgb.join(',') + ',' + (a * 0.55).toFixed(3) + ')';
      for (let i = 0; i < n; i++) {
        const ph = (secs * rate + hash01(i * 3.9 + seed)) % 1;
        const tw = Math.sin(ph * Math.PI);
        if (tw <= 0.02) continue;
        const x = hash01(i * 7.3 + seed) * w;
        const y = hash01(i * 5.1 + seed + 21) * h;
        const r = sz * (0.35 + hash01(i * 11.7) * 0.75) * tw;
        const g = ctx.createRadialGradient(x, y, 0, x, y, r);
        g.addColorStop(0, 'rgba(255,255,255,' + (a * tw).toFixed(3) + ')');
        g.addColorStop(0.4, 'rgba(' + rgb.join(',') + ',' + (a * tw * 0.7).toFixed(3) + ')');
        g.addColorStop(1, 'rgba(' + rgb.join(',') + ',0)');
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(x, y, r, 0, Math.PI * 2);
        ctx.fill();
        if (streak > 0.01) {
          ctx.lineWidth = Math.max(0.6, r * 0.16);
          ctx.beginPath();
          ctx.moveTo(x - r * streak, y);
          ctx.lineTo(x + r * streak, y);
          ctx.moveTo(x, y - r * streak);
          ctx.lineTo(x, y + r * streak);
          ctx.stroke();
        }
      }
      ctx.restore();
    },
  });

  /* ---- Keying ---- */

  define('lumakey', {
    label: 'Luma Key', group: 'Keying',
    description: 'Cut by brightness: keep the subject, knock out a blown sky or a black backdrop.',
    params: {
      threshold: numParam('Threshold', 0, 1, 0.01, 0.7),
      softness: numParam('Softness', 0, 1, 0.01, 0.12),
      keep: selParam('Keep', [['dark', 'Shadows'], ['bright', 'Highlights']], 'dark'),
    },
    defaultParams: { threshold: 0.7, softness: 0.12, keep: 'dark' },
    pixelEffect: true,
    pixelWork(src, dst, w, h, p) {
      const s = src.data, d = dst.data;
      const thr = clamp(p.threshold, 0, 1) * 255;
      const soft = Math.max(1, clamp(p.softness, 0, 1) * 255);
      const keepBright = p.keep === 'bright';
      for (let i = 0; i < s.length; i += 4) {
        const l = s[i] * 0.2126 + s[i + 1] * 0.7152 + s[i + 2] * 0.0722;
        let a = clamp((l - (thr - soft / 2)) / soft, 0, 1);
        if (!keepBright) a = 1 - a;
        d[i] = s[i];
        d[i + 1] = s[i + 1];
        d[i + 2] = s[i + 2];
        d[i + 3] = s[i + 3] * a;
      }
    },
  });

  define('spill', {
    label: 'Spill Suppression', group: 'Keying',
    description: 'Drain the screen colour that bounces onto skin and hair after a chroma key.',
    params: {
      screen: selParam('Screen', [['green', 'Green screen'], ['blue', 'Blue screen']], 'green'),
      amount: numParam('Amount', 0, 1, 0.01, 0.8),
      preserve: numParam('Preserve detail', 0, 1, 0.01, 0.4),
    },
    defaultParams: { screen: 'green', amount: 0.8, preserve: 0.4 },
    pixelEffect: true,
    pixelWork(src, dst, w, h, p) {
      const s = src.data, d = dst.data;
      const amt = clamp(p.amount, 0, 1);
      const pres = clamp(p.preserve, 0, 1);
      const green = p.screen !== 'blue';
      for (let i = 0; i < s.length; i += 4) {
        const r = s[i], g = s[i + 1], b = s[i + 2];
        if (green) {
          const spill = Math.max(0, g - Math.max(r, b)) * amt;
          d[i] = r;
          d[i + 1] = clamp(g - spill, 0, 255);
          d[i + 2] = clamp(b + spill * pres, 0, 255);
        } else {
          const spill = Math.max(0, b - Math.max(r, g)) * amt;
          d[i] = r;
          d[i + 1] = clamp(g + spill * pres, 0, 255);
          d[i + 2] = clamp(b - spill, 0, 255);
        }
        d[i + 3] = s[i + 3];
      }
    },
  });

  /* ---- further audio effects ---- */

  define('audiogate', {
    label: 'Stutter Gate', category: 'audio', group: 'Audio',
    description: 'Chop the level on and off at a fixed rate for a stutter or gated pulse.',
    params: {
      rate: numParam('Rate', 0.5, 24, 0.5, 8, ' Hz'),
      duty: numParam('Duty', 0.05, 0.95, 0.01, 0.5),
      floor: numParam('Floor', 0, 1, 0.01, 0),
    },
    defaultParams: { rate: 8, duty: 0.5, floor: 0 },
    gainAt(p, local, length, fps) {
      const ph = ((local / Math.max(1, fps)) * clamp(p.rate, 0.5, 24)) % 1;
      return ph < clamp(p.duty, 0.05, 0.95) ? 1 : clamp(p.floor, 0, 1);
    },
  });

  define('audioduck', {
    label: 'Pumping Duck', category: 'audio', group: 'Audio',
    description: 'Drop the level on every beat, the sidechain pump of dance music.',
    params: {
      rate: numParam('Rate', 0.25, 8, 0.25, 2, ' Hz'),
      depth: numParam('Depth', 0, 1, 0.01, 0.5),
      floor: numParam('Floor', 0, 1, 0.01, 0.2),
      release: numParam('Release', 0.05, 1, 0.01, 0.5),
    },
    defaultParams: { rate: 2, depth: 0.5, floor: 0.2, release: 0.5 },
    gainAt(p, local, length, fps) {
      const ph = ((local / Math.max(1, fps)) * clamp(p.rate, 0.25, 8)) % 1;
      const rel = clamp(p.release, 0.05, 1);
      const k = ph < rel ? ph / rel : 1;
      const fl = clamp(p.floor, 0, 1);
      return clamp(1 - clamp(p.depth, 0, 1) * (1 - (fl + (1 - fl) * k)), 0, 1);
    },
  });

  define('audioenvelope', {
    label: 'Level Envelope', category: 'audio', group: 'Audio',
    description: 'Shape the clip with attack, hold, decay and release stages.',
    params: {
      attack: numParam('Attack', 0, 10, 0.05, 0.5, 's'),
      hold: numParam('Hold', 0, 10, 0.05, 0, 's'),
      decay: numParam('Decay', 0, 20, 0.05, 2, 's'),
      sustain: numParam('Sustain', 0, 1, 0.01, 0.7),
      release: numParam('Release', 0, 20, 0.05, 1, 's'),
    },
    defaultParams: { attack: 0.5, hold: 0, decay: 2, sustain: 0.7, release: 1 },
    gainAt(p, local, length, fps) {
      const at = Math.round(clamp(p.attack, 0, 10) * fps);
      const ho = Math.round(clamp(p.hold, 0, 10) * fps);
      const de = Math.round(clamp(p.decay, 0, 20) * fps);
      const su = clamp(p.sustain, 0, 1);
      const re = Math.round(clamp(p.release, 0, 20) * fps);
      const L = Math.max(1, length);
      if (at > 0 && local < at) return clamp(local / at, 0, 1);
      if (local < at + ho) return 1;
      if (de > 0 && local < at + ho + de) return clamp(1 + (su - 1) * ((local - at - ho) / de), 0, 1);
      if (re > 0 && local > L - re) return clamp(su * ((L - local) / re), 0, 1);
      return su;
    },
  });

  define('audiopingpong', {
    label: 'Auto Pan', category: 'audio', group: 'Audio',
    description: 'Sweep the audio back and forth across the stereo field.',
    params: {
      rate: numParam('Rate', 0.05, 8, 0.05, 0.5, ' Hz'),
      depth: numParam('Depth', 0, 1, 0.01, 1),
      offset: numParam('Offset', -1, 1, 0.01, 0),
    },
    defaultParams: { rate: 0.5, depth: 1, offset: 0 },
    panAt(p, local, length, fps) {
      const lfo = Math.sin((local / Math.max(1, fps)) * Math.PI * 2 * clamp(p.rate, 0.05, 8));
      return clamp(clamp(p.offset, -1, 1) + lfo * clamp(p.depth, 0, 1), -1, 1);
    },
  });

  define('audiomono', {
    label: 'Mono Fold', category: 'audio', group: 'Audio',
    description: 'Collapse the clip into a single point of the stereo field.',
    params: { centre: numParam('Centre', -1, 1, 0.01, 0) },
    defaultParams: { centre: 0 },
    panAt: (p) => clamp(p.centre, -1, 1),
  });

  define('audiotrim', {
    label: 'Level Window', category: 'audio', group: 'Audio',
    description: 'Silence everything outside a time window, with soft edges.',
    params: {
      start: numParam('Start', 0, 60, 0.05, 0, 's'),
      end: numParam('End', 0, 60, 0.05, 3, 's'),
      edge: numParam('Soft edge', 0, 2, 0.01, 0.1, 's'),
    },
    defaultParams: { start: 0, end: 3, edge: 0.1 },
    gainAt(p, local, length, fps) {
      const t = local / Math.max(1, fps);
      const a = clamp(p.start, 0, 60), b = clamp(p.end, 0, 60);
      const lo = Math.min(a, b), hi = Math.max(a, b);
      const e = clamp(p.edge, 0, 2);
      if (t < lo) return e > 0 ? clamp(1 - (lo - t) / e, 0, 1) : 0;
      if (t > hi) return e > 0 ? clamp(1 - (t - hi) / e, 0, 1) : 0;
      return 1;
    },
  });

  function filterString(effects) {
    const parts = [];
    for (const fx of effects) {
      if (!fx.enabled) continue;
      const reg = registry[fx.type];
      if (reg && reg.filter) { const f = reg.filter(fx.params); if (f) parts.push(f); }
    }
    return parts.length ? parts.join(' ') : 'none';
  }

  const hasPixelEffect = (effects) => effects.some((fx) => fx.enabled && registry[fx.type] && registry[fx.type].pixelEffect);
  const hasDrawEffect = (effects) => effects.some((fx) => fx.enabled && registry[fx.type] && registry[fx.type].draw);

  /* Run draw-type effects in order. `t` is the shared scratch object. */
  function applyDrawEffects(ctx, w, h, effects, scratch, frameLocal, fps) {
    for (const fx of effects) {
      if (!fx.enabled) continue;
      const reg = registry[fx.type];
      if (reg && reg.draw) {
        if (reg.pixelEffect) continue;
        reg.draw(ctx, w, h, fx.params, scratch, frameLocal, fps);
      }
    }
  }

  /* CPU pixel pass: snapshot -> process -> put back. */
  function applyPixelEffects(ctx, w, h, effects, scratch, frameLocal, fps) {
    for (const fx of effects) {
      if (!fx.enabled) continue;
      const reg = registry[fx.type];
      if (!reg || !reg.pixelEffect) continue;
      const img = ctx.getImageData(0, 0, w, h);
      const out = ctx.createImageData(w, h);
      reg.pixelWork(img, out, w, h, fx.params, scratch, frameLocal, fps);
      ctx.putImageData(out, 0, 0);
    }
  }

  /* Combined gain of every enabled audio effect for a clip-relative frame. */
  function audioGain(effects, local, length, fps) {
    let g = 1;
    for (const fx of effects) {
      if (!fx.enabled) continue;
      const reg = registry[fx.type];
      if (!reg || reg.category !== 'audio') continue;
      if (reg.gainAt) g *= reg.gainAt(fx.params, local, length, fps);
    }
    return clamp(g, 0, 16);
  }

  /* Combined stereo position of every enabled pan effect. Pans do not multiply,
     so the last enabled pan effect wins — same rule most NLEs use. */
  function audioPan(effects) {
    let pan = 0;
    for (const fx of effects) {
      if (!fx.enabled) continue;
      const reg = registry[fx.type];
      if (!reg || reg.category !== 'audio' || !reg.panAt) continue;
      pan = reg.panAt(fx.params, 0, 1, 30);
    }
    return clamp(pan, -1, 1);
  }

  OS.effects = {
    registry, all, list, groups, filterString, hasPixelEffect, hasDrawEffect,
    applyDrawEffects, applyPixelEffects, audioGain, audioPan, opacityAt, numParam,
  };
})();
