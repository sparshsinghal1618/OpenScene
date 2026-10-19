/* OpenScene — titles.js
   Text/title generator clips: presets, styling, entrance/exit animations.
   Rendered at project resolution; font size is relative to project height. */
(() => {
  'use strict';
  const OS = (window.OS = window.OS || {});
  const { clamp } = OS.util;

  const FONTS = [
    'Arial', 'Arial Black', 'Calibri', 'Cambria', 'Comic Sans MS', 'Consolas',
    'Courier New', 'Franklin Gothic Medium', 'Georgia', 'Impact', 'Palatino Linotype',
    'Segoe UI', 'Segoe UI Semibold', 'Tahoma', 'Times New Roman', 'Trebuchet MS', 'Verdana',
  ];

  const ANIMATIONS = [
    ['none', 'None'], ['fade', 'Fade'], ['slideup', 'Slide Up'], ['slidedown', 'Slide Down'],
    ['slideleft', 'Slide Left'], ['slideright', 'Slide Right'], ['zoom', 'Zoom In'],
    ['typewriter', 'Typewriter'], ['blur', 'Blur In'],
  ];

  const defaultParams = () => ({
    name: 'Title',
    text: 'Your Title',
    font: 'Segoe UI Semibold',
    size: 0.09,            // fraction of project height
    color: '#ffffff',
    bold: true,
    italic: false,
    align: 'center',       // left | center | right
    anchorX: 0.5,          // 0..1 within frame
    anchorY: 0.5,
    lineHeight: 1.15,
    tracking: 0,           // extra letter spacing in em/100
    uppercase: false,
    stroke: 0,             // stroke width (fraction of size)
    strokeColor: '#000000',
    shadow: 0.35,          // shadow strength 0..1
    boxOpacity: 0,         // background box behind text
    boxColor: '#000000',
    boxPad: 0.35,          // padding relative to font size
    fadeIn: 0.4,           // seconds
    fadeOut: 0.4,
    animation: 'fade',
    // gradient text
    gradient: false,
    color2: '#ffcc00',
  });

  const PRESETS = [
    {
      id: 'main-title', name: 'Main Title', params: {
        text: 'MAIN TITLE', font: 'Segoe UI Semibold', size: 0.11, align: 'center', anchorX: 0.5, anchorY: 0.42,
        bold: true, uppercase: true, tracking: 12, animation: 'zoom', fadeIn: 0.5, fadeOut: 0.5, shadow: 0.5,
      },
    },
    {
      id: 'subtitle', name: 'Subtitle', params: {
        text: 'A supporting line of text', font: 'Segoe UI', size: 0.045, align: 'center', anchorX: 0.5, anchorY: 0.56,
        bold: false, color: '#e8e8e8', animation: 'fade', fadeIn: 0.6, fadeOut: 0.5,
      },
    },
    {
      id: 'lower-third', name: 'Lower Third', params: {
        text: 'NAME\nRole or description', font: 'Segoe UI Semibold', size: 0.05, align: 'left', anchorX: 0.07, anchorY: 0.8,
        bold: true, boxOpacity: 0.55, boxColor: '#101418', boxPad: 0.5, animation: 'slideleft', fadeIn: 0.35, fadeOut: 0.35, shadow: 0.3,
      },
    },
    {
      id: 'caption', name: 'Caption', params: {
        text: 'Caption text', font: 'Segoe UI', size: 0.042, align: 'center', anchorX: 0.5, anchorY: 0.9,
        bold: false, boxOpacity: 0.45, boxColor: '#000000', animation: 'fade', fadeIn: 0.2, fadeOut: 0.2,
      },
    },
    {
      id: 'end-credits', name: 'End Credits', params: {
        text: 'DIRECTED BY\nYour Name\n\nEDITED WITH\nOpenScene', font: 'Georgia', size: 0.055, align: 'center',
        anchorX: 0.5, anchorY: 0.5, lineHeight: 1.6, animation: 'slideup', fadeIn: 0.8, fadeOut: 0.8,
      },
    },
    {
      id: 'callout', name: 'Callout', params: {
        text: 'Point of interest', font: 'Segoe UI Semibold', size: 0.04, align: 'left', anchorX: 0.6, anchorY: 0.3,
        boxOpacity: 0.7, boxColor: '#1460ff', boxPad: 0.45, animation: 'slideleft', fadeIn: 0.25, fadeOut: 0.25,
      },
    },
  ];

  /* Draw a title clip. local = clip-relative frame, length = clip length, fps = project fps. */
  function draw(ctx, w, h, params, local, length, fps) {
    const p = { ...defaultParams(), ...params };
    const fontPx = Math.max(8, p.size * h);
    const sec = local / fps;
    const dur = length / fps;

    let alpha = 1, dx = 0, dy = 0, scale = 1, blur = 0, chars = Infinity;
    const inSec = clamp(p.fadeIn, 0, dur / 2), outSec = clamp(p.fadeOut, 0, dur / 2);
    const inT = inSec > 0 ? clamp(sec / inSec, 0, 1) : 1;
    const outT = outSec > 0 ? clamp((dur - sec) / outSec, 0, 1) : 1;
    const t = Math.min(inT, outT);
    const ease = (x) => 1 - Math.pow(1 - x, 3);

    switch (p.animation) {
      case 'fade': alpha = t; break;
      case 'slideup': dy = (1 - ease(inT)) * fontPx * 2; alpha = t; break;
      case 'slidedown': dy = -(1 - ease(inT)) * fontPx * 2; alpha = t; break;
      case 'slideleft': dx = -(1 - ease(inT)) * w * 0.25; alpha = t; break;
      case 'slideright': dx = (1 - ease(inT)) * w * 0.25; alpha = t; break;
      case 'zoom': scale = 0.82 + 0.18 * ease(inT); alpha = t; break;
      case 'blur': blur = (1 - inT) * fontPx * 0.25; alpha = t; break;
      case 'typewriter': {
        const total = p.text.length;
        chars = Math.round(clamp(sec / Math.max(0.02, dur * 0.6), 0, 1) * total);
        alpha = t;
        break;
      }
      default: alpha = t;
    }
    if (alpha <= 0.003) return;

    const lines = String(p.uppercase ? p.text.toUpperCase() : p.text).split('\n');
    const weight = p.bold ? 'bold ' : '';
    const style = p.italic ? 'italic ' : '';
    ctx.save();
    ctx.globalAlpha = alpha;
    if (blur > 0.5) ctx.filter = `blur(${blur.toFixed(1)}px)`;

    ctx.font = `${style}${weight}${fontPx}px "${p.font}", sans-serif`;
    ctx.textBaseline = 'alphabetic';
    const align = p.align === 'left' ? 'left' : p.align === 'right' ? 'right' : 'center';
    ctx.textAlign = align;

    const lineH = fontPx * p.lineHeight;
    let maxWidth = 0;
    for (const line of lines) maxWidth = Math.max(maxWidth, measure(ctx, line, p.tracking));
    const blockH = lineH * lines.length;
    const pad = fontPx * p.boxPad;

    let x = p.anchorX * w + dx;
    let y = p.anchorY * h - blockH / 2 + lineH * 0.8 + dy;

    ctx.translate(x, y);
    if (scale !== 1) ctx.scale(scale, scale);
    if (p.tracking) ctx.letterSpacing = `${p.tracking / 100}em`;

    const left = align === 'left' ? 0 : align === 'right' ? -maxWidth : -maxWidth / 2;
    if (p.boxOpacity > 0) {
      ctx.globalAlpha = alpha * clamp(p.boxOpacity, 0, 1);
      ctx.fillStyle = p.boxColor;
      roundRect(ctx, left - pad, -lineH * 0.78 - pad, maxWidth + pad * 2, blockH + pad * 1.4, fontPx * 0.12);
      ctx.fill();
      ctx.globalAlpha = alpha;
    }

    let remaining = chars;
    for (let i = 0; i < lines.length; i++) {
      let line = lines[i];
      if (remaining !== Infinity) {
        if (remaining <= 0) break;
        line = line.slice(0, remaining);
        remaining -= lines[i].length;
      }
      const ly = i * lineH;
      if (p.shadow > 0) {
        ctx.save();
        ctx.globalAlpha = alpha * clamp(p.shadow, 0, 1) * 0.9;
        ctx.shadowColor = 'rgba(0,0,0,0.85)';
        ctx.shadowBlur = fontPx * 0.18;
        ctx.shadowOffsetY = fontPx * 0.05;
        ctx.fillStyle = '#000';
        ctx.fillText(line, 0, ly, undefined);
        ctx.restore();
      }
      if (p.stroke > 0) {
        ctx.lineWidth = fontPx * p.stroke * 2;
        ctx.lineJoin = 'round';
        ctx.strokeStyle = p.strokeColor;
        ctx.strokeText(line, 0, ly);
      }
      if (p.gradient) {
        const g = ctx.createLinearGradient(left, 0, left + maxWidth, 0);
        g.addColorStop(0, p.color);
        g.addColorStop(1, p.color2);
        ctx.fillStyle = g;
      } else ctx.fillStyle = p.color;
      ctx.fillText(line, 0, ly);
    }
    ctx.restore();
  }

  function measure(ctx, text, tracking) {
    if (!text) return 0;
    const w = ctx.measureText(text).width;
    return tracking ? w + (tracking / 100) * parseFloat(ctx.font || '16') * text.length : w;
  }

  function roundRect(ctx, x, y, w, h, r) {
    r = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  /* Solid colour + gradient generators. */
  function drawColor(ctx, w, h, params) {
    const p = { type: 'solid', color: '#1460ff', color2: '#0a0f1a', angle: 90, ...params };
    if (p.type === 'gradient') {
      const a = ((p.angle || 90) - 90) * (Math.PI / 180);
      const cx = w / 2, cy = h / 2, r = Math.hypot(w, h) / 2;
      const g = ctx.createLinearGradient(cx - Math.cos(a) * r, cy - Math.sin(a) * r, cx + Math.cos(a) * r, cy + Math.sin(a) * r);
      g.addColorStop(0, p.color);
      g.addColorStop(1, p.color2);
      ctx.fillStyle = g;
    } else ctx.fillStyle = p.color;
    ctx.fillRect(0, 0, w, h);
  }

  OS.titles = { FONTS, ANIMATIONS, PRESETS, defaultParams, draw, drawColor, roundRect };
})();
