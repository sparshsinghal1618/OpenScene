/* OpenScene — transitions.js
   Overlap transitions (OpenShot-style): when a clip overlaps its neighbour on the
   same video track, the overlap region renders clip A fading/wiping into clip B.
   Every transition is a pure function of progress p (0 = outgoing clip, 1 =
   incoming clip) so previews and exports stay frame-exact. */
(() => {
  'use strict';
  const OS = (window.OS = window.OS || {});
  const { clamp } = OS.util;

  /* [key, label, group, description] — groups mirror the panel in the left dock. */
  const TYPES = [
    /* ---- Dissolve ---- */
    ['dissolve', 'Cross Dissolve', 'Dissolve', 'Blend the outgoing clip into the incoming one.'],
    ['blurdissolve', 'Blur Dissolve', 'Dissolve', 'Blur through the midpoint of the blend.'],
    ['checker', 'Checkerboard Dissolve', 'Dissolve', 'The incoming clip appears square by square in a checker pattern.'],
    ['noisedissolve', 'Noise Dissolve', 'Dissolve', 'The incoming clip resolves out of random pixel noise.'],
    /* ---- Wipe ---- */
    ['wipeleft', 'Wipe Right to Left', 'Wipe', 'A hard edge sweeps across, revealing the incoming clip.'],
    ['wiperight', 'Wipe Left to Right', 'Wipe', 'A hard edge sweeps across, revealing the incoming clip.'],
    ['wipeup', 'Wipe Up', 'Wipe', 'The incoming clip is revealed from the bottom upward.'],
    ['wipedown', 'Wipe Down', 'Wipe', 'The incoming clip is revealed from the top downward.'],
    ['featherwipe', 'Feathered Wipe', 'Wipe', 'A soft, graduated edge wipes across the frame.'],
    ['circlewipe', 'Circle Wipe (Iris)', 'Wipe', 'An expanding circle opens from the centre to reveal the next clip.'],
    ['diamondwipe', 'Diamond Wipe', 'Wipe', 'A growing diamond reveals the incoming clip.'],
    ['starwipe', 'Star Wipe', 'Wipe', 'A five-pointed star grows from the centre.'],
    ['boxwipe', 'Box Wipe', 'Wipe', 'A rectangle grows from the centre of the frame.'],
    ['blinds', 'Venetian Blinds', 'Wipe', 'Horizontal slats open across the frame.'],
    ['lumawipe', 'Luma Wipe', 'Wipe', 'Reveal follows a bright-to-dark diagonal ramp.'],
    ['ripplewipe', 'Ripple Wipe', 'Wipe', 'The wipe edge undulates like a wave.'],
    ['barnopen', 'Barn Doors Open', 'Wipe', 'Black bars part from the centre outward to reveal the next clip.'],
    ['barnClose', 'Barn Doors Close', 'Wipe', 'A horizontal split opens out from the middle line to reveal the next clip.'],
    /* ---- Slide / Cover / Push ---- */
    ['slideleft', 'Cover Right to Left', 'Slide', 'The incoming clip slides in over the stationary outgoing clip.'],
    ['slideright', 'Cover Left to Right', 'Slide', 'The incoming clip slides in over the stationary outgoing clip.'],
    ['slideup', 'Cover Up', 'Slide', 'The incoming clip slides up over the stationary outgoing clip.'],
    ['slidedown', 'Cover Down', 'Slide', 'The incoming clip slides down over the stationary outgoing clip.'],
    ['pushleft', 'Push Right to Left', 'Slide', 'Both clips travel together, the outgoing one pushed off frame.'],
    ['pushright', 'Push Left to Right', 'Slide', 'Both clips travel together, the outgoing one pushed off frame.'],
    ['pushup', 'Push Up', 'Slide', 'Both clips travel together, the outgoing one pushed off frame.'],
    ['pushdown', 'Push Down', 'Slide', 'Both clips travel together, the outgoing one pushed off frame.'],
    ['squeeze', 'Squeeze', 'Slide', 'The outgoing clip compresses as the incoming one stretches back out.'],
    /* ---- Zoom ---- */
    ['zoomin', 'Zoom In', 'Zoom', 'The incoming clip scales up from the centre over the outgoing clip.'],
    ['zoomout', 'Zoom Out', 'Zoom', 'The incoming clip settles down from an overscanned size.'],
    ['crosszoom', 'Cross Zoom', 'Zoom', 'Zoom and blur blend together, the classic documentary cut.'],
    /* ---- Stylised ---- */
    ['spin', 'Spin', 'Stylised', 'The incoming clip rotates and scales into place.'],
    ['pageturn', 'Page Turn', 'Stylised', 'The outgoing clip folds away like the page of a book.'],
    ['burn', 'Film Burn', 'Stylised', 'A hot, irregular edge burns the new clip through the old one.'],
    ['matrix', 'Matrix', 'Stylised', 'The next clip pops in through a grid of cells.'],
    ['clock', 'Clock Sweep', 'Stylised', 'The next clip is revealed by a sweeping clock hand.'],
    /* ---- Flash ---- */
    ['whiteflash', 'White Flash', 'Flash', 'Flash to white between the two clips.'],
    ['blackflash', 'Black Flash', 'Flash', 'Dip to black between the two clips.'],
    /* ---- Dissolve ---- */
    ['hexdissolve', 'Hexagon Dissolve', 'Dissolve', 'The incoming clip appears cell by cell in a honeycomb of hexagons.'],
    ['blockdissolve', 'Block Dissolve', 'Dissolve', 'Chunky blocks of the new clip pop in, in a shuffled order.'],
    ['additivedissolve', 'Additive Dissolve', 'Dissolve', 'A glowing double exposure: the two clips add together through the blend.'],
    ['multiplydissolve', 'Film Dissolve', 'Dissolve', 'The clips multiply together for a dark, moody film dissolve.'],
    /* ---- Wipe ---- */
    ['diagonaldown', 'Diagonal Wipe Down', 'Wipe', 'A hard diagonal edge sweeps from the top-left corner.'],
    ['diagonalup', 'Diagonal Wipe Up', 'Wipe', 'A hard diagonal edge sweeps from the bottom-left corner.'],
    ['curtain', 'Curtain Wipe', 'Wipe', 'Vertical bands open from the top and bottom edges toward the middle.'],
    ['pinwheel', 'Pinwheel Wipe', 'Wipe', 'Six pie slices grow outward and close the circle.'],
    ['zipperwipe', 'Zipper Wipe', 'Wipe', 'A zig-zag edge zips across the frame.'],
    ['puzzlewipe', 'Puzzle Wipe', 'Wipe', 'Tiles pop in along the diagonal, each one snapping into place.'],
    ['sweepwipe', 'Corner Sweep', 'Wipe', 'An angular wedge sweeps out from the top-left corner.'],
    /* ---- Slide / Cover / Push ---- */
    ['fliphorizontal', 'Flip Horizontal', 'Slide', 'The frame flips about the vertical axis like a card turning over.'],
    ['flipvertical', 'Flip Vertical', 'Slide', 'The frame flips about the horizontal axis like a card turning over.'],
    ['swing', 'Swing Door', 'Slide', 'The new clip swings in on a hinge with a moving shadow.'],
    ['whippan', 'Whip Pan', 'Slide', 'A motion-blurred pan smears both clips together for a fast cut.'],
    /* ---- Zoom ---- */
    ['zoomtwist', 'Zoom Twist', 'Zoom', 'The clips zoom and counter-rotate past each other.'],
    ['radialbloom', 'Radial Bloom', 'Zoom', 'A radial blur blooms out of the outgoing clip as the new one settles in.'],
    /* ---- Stylised ---- */
    ['glass', 'Shattered Glass', 'Stylised', 'The new clip is revealed through shards of glass that drift apart.'],
    ['stripslide', 'Strip Slide', 'Stylised', 'Horizontal strips slide in at different speeds and directions.'],
    ['glitchcut', 'Glitch Cut', 'Stylised', 'An RGB-split, strip-displaced digital glitch bridges the cut.'],

    /* ---- Dissolve: blend-mode family ---- */
    ['screendissolve', 'Screen Dissolve', 'Dissolve', 'The clips screen together, lifting the midtones through the blend.'],
    ['overlaydissolve', 'Overlay Dissolve', 'Dissolve', 'Overlay blending keeps the contrast punchy across the blend.'],
    ['darkendissolve', 'Darken Dissolve', 'Dissolve', 'Only the darker of the two clips survives the blend, then cross-fades.'],
    ['lightendissolve', 'Lighten Dissolve', 'Dissolve', 'Only the lighter of the two clips survives the blend, then cross-fades.'],
    ['colorburndissolve', 'Colour Burn Dissolve', 'Dissolve', 'A dark, saturated colour-burn blend through the cut.'],
    ['colordodgedissolve', 'Colour Dodge Dissolve', 'Dissolve', 'A bright, glowing colour-dodge blend through the cut.'],
    ['hardlightdissolve', 'Hard Light Dissolve', 'Dissolve', 'A hard-light blend for a punchy, contrasty mix.'],
    ['softlightdissolve', 'Soft Light Dissolve', 'Dissolve', 'A gentle soft-light blend, the subtlest of the luminous dissolves.'],
    ['differencedissolve', 'Difference Dissolve', 'Dissolve', 'The clips subtract and invert for an electric, negative-looking blend.'],
    ['exclusiondissolve', 'Exclusion Dissolve', 'Dissolve', 'A softer, lower-contrast version of the difference blend.'],
    ['huedissolve', 'Hue Dissolve', 'Dissolve', 'The incoming hue washes over the outgoing luminance.'],
    ['saturationdissolve', 'Saturation Dissolve', 'Dissolve', 'Saturation is taken from the incoming clip while the rest holds.'],
    ['colordissolve', 'Colour Dissolve', 'Dissolve', 'Colour is taken from the incoming clip while the rest holds.'],
    ['luminositydissolve', 'Luminosity Dissolve', 'Dissolve', 'Luminance comes from the incoming clip while the colour holds.'],

    /* ---- Dissolve: screen patterns ---- */
    ['ditherdissolve', 'Ordered Dither Dissolve', 'Dissolve', 'A classic Bayer dither ramps the new clip in dot by dot.'],
    ['halftonedissolve', 'Halftone Dissolve', 'Dissolve', 'Print-style halftone dots grow until they merge into the new clip.'],
    ['linedissolve', 'Line Dissolve', 'Dissolve', 'Horizontal line screens thicken across the frame.'],
    ['vlinedissolve', 'Vertical Line Dissolve', 'Dissolve', 'Vertical line screens thicken across the frame.'],
    ['diaglinedissolve', 'Diagonal Line Dissolve', 'Dissolve', 'Diagonal line screens thicken across the frame.'],
    ['crosshatchdissolve', 'Crosshatch Dissolve', 'Dissolve', 'Horizontal and vertical screens cross over the cut.'],
    ['dotdissolve', 'Dot Dissolve', 'Dissolve', 'Dots pop in across the frame, then swell to close the gaps.'],
    ['scanlinedissolve', 'Scanline Dissolve', 'Dissolve', 'A bright scan band sweeps down, resolving the new clip behind it.'],

    /* ---- Dissolve: tiles in motion ---- */
    ['dominoeffect', 'Domino Dissolve', 'Dissolve', 'Tiles topple into place with a staggered rotation.'],
    ['gravitydissolve', 'Gravity Dissolve', 'Dissolve', 'Tiles fall in from above and settle into the new clip.'],
    ['vacuumdissolve', 'Vacuum Dissolve', 'Dissolve', 'Tiles are sucked toward the centre as the new clip arrives.'],
    ['flyindissolve', 'Fly In Dissolve', 'Dissolve', 'Tiles fly in from scattered directions.'],
    ['flipcells', 'Flip Cells', 'Dissolve', 'Each cell flips open along its vertical axis.'],
    ['zoomcells', 'Zoom Cells', 'Dissolve', 'Cells scale up from nothing in a shuffled order.'],
    ['posterizedissolve', 'Posterize Dissolve', 'Dissolve', 'The blend steps through a handful of quantised levels.'],
    ['kaleidoscope', 'Kaleidoscope Dissolve', 'Dissolve', 'Mirrored wedges rotate the new clip into view.'],
    ['bokehdissolve', 'Bokeh Dissolve', 'Dissolve', 'Soft out-of-focus discs bloom the new clip in.'],
    ['particledissolve', 'Particle Dissolve', 'Dissolve', 'The new clip resolves out of a cloud of drifting particles.'],

    /* ---- Wipe: growing shapes ---- */
    ['trianglewipe', 'Triangle Wipe', 'Wipe', 'A triangle opens outward from the centre of the frame.'],
    ['pentagonwipe', 'Pentagon Wipe', 'Wipe', 'A pentagon opens outward from the centre of the frame.'],
    ['hexagonwipe', 'Hexagon Wipe', 'Wipe', 'A hexagon opens outward from the centre of the frame.'],
    ['heptagonwipe', 'Heptagon Wipe', 'Wipe', 'A seven-sided shape opens outward from the centre.'],
    ['octagonwipe', 'Octagon Wipe', 'Wipe', 'An octagon opens outward from the centre of the frame.'],
    ['decagonwipe', 'Decagon Wipe', 'Wipe', 'A ten-sided shape opens outward from the centre.'],
    ['burstwipe', 'Burst Wipe', 'Wipe', 'A many-pointed burst blasts outward from the centre.'],
    ['sunburstwipe', 'Sunburst Wipe', 'Wipe', 'Rotating rays sweep the new clip into view.'],
    ['heartwipe', 'Heart Wipe', 'Wipe', 'A heart grows out of the centre of the frame.'],
    ['arrowwipe', 'Arrow Wipe', 'Wipe', 'An arrow pushes through to the right, revealing the new clip.'],
    ['keyholewipe', 'Keyhole Wipe', 'Wipe', 'A keyhole shape opens from the centre.'],
    ['crosswipe', 'Cross Wipe', 'Wipe', 'A cross grows outward along both axes.'],
    ['hourglasswipe', 'Hourglass Wipe', 'Wipe', 'A bow-tie shape opens from the middle line.'],
    ['spiralwipe', 'Spiral Wipe', 'Wipe', 'A spiral arm coils outward from the centre.'],
    ['ringwipe', 'Soft Iris Wipe', 'Wipe', 'A soft-edged iris opens from the centre of the frame.'],
    ['radialblinds', 'Radial Blinds', 'Wipe', 'Polar slats fan open around the centre.'],
    ['splitwipe', 'Split Wipe', 'Wipe', 'The outgoing clip splits down the middle and parts.'],
    ['gridwipe', 'Grid Grow Wipe', 'Wipe', 'Each cell of a grid grows from its own centre.'],
    ['vblinds', 'Vertical Blinds', 'Wipe', 'Vertical slats open across the frame.'],
    ['waveblinds', 'Wave Blinds', 'Wipe', 'Slats open along a travelling wave.'],
    ['cornerwipeNE', 'Corner Sweep NE', 'Wipe', 'A wedge sweeps out of the top-right corner.'],
    ['cornerwipeSE', 'Corner Sweep SE', 'Wipe', 'A wedge sweeps out of the bottom-right corner.'],
    ['cornerwipeSW', 'Corner Sweep SW', 'Wipe', 'A wedge sweeps out of the bottom-left corner.'],

    /* ---- Slide / Cover / Push ---- */
    ['revealleft', 'Reveal Left', 'Slide', 'The outgoing clip slides away to the left, uncovering the next one.'],
    ['revealright', 'Reveal Right', 'Slide', 'The outgoing clip slides away to the right, uncovering the next one.'],
    ['revealup', 'Reveal Up', 'Slide', 'The outgoing clip slides away upward, uncovering the next one.'],
    ['revealdown', 'Reveal Down', 'Slide', 'The outgoing clip slides away downward, uncovering the next one.'],
    ['slidediagUL', 'Cover from Bottom-Right', 'Slide', 'The next clip slides in diagonally from the bottom-right.'],
    ['slidediagUR', 'Cover from Bottom-Left', 'Slide', 'The next clip slides in diagonally from the bottom-left.'],
    ['slidediagDL', 'Cover from Top-Right', 'Slide', 'The next clip slides in diagonally from the top-right.'],
    ['slidediagDR', 'Cover from Top-Left', 'Slide', 'The next clip slides in diagonally from the top-left.'],
    ['pushdiagUL', 'Push Diagonal NE', 'Slide', 'Both clips travel diagonally toward the top-right.'],
    ['pushdiagUR', 'Push Diagonal NW', 'Slide', 'Both clips travel diagonally toward the top-left.'],
    ['pushdiagDL', 'Push Diagonal SE', 'Slide', 'Both clips travel diagonally toward the bottom-right.'],
    ['pushdiagDR', 'Push Diagonal SW', 'Slide', 'Both clips travel diagonally toward the bottom-left.'],
    ['squeezeV', 'Vertical Squeeze', 'Slide', 'The outgoing clip compresses vertically as the next one stretches out.'],
    ['rollleft', 'Roll Left', 'Slide', 'The clips roll past each other like a cylinder, left to right.'],
    ['rollright', 'Roll Right', 'Slide', 'The clips roll past each other like a cylinder, right to left.'],
    ['rollup', 'Roll Up', 'Slide', 'The clips roll vertically past each other.'],
    ['rolldown', 'Roll Down', 'Slide', 'The clips roll vertically past each other, top to bottom.'],
    ['barnvertical', 'Barn Doors Vertical', 'Slide', 'Bars part vertically from the centre to reveal the next clip.'],
    ['curtainV', 'Curtain Wipe Vertical', 'Slide', 'Rows open from the left and right edges toward the middle.'],
    ['turnleft', 'Cube Turn Left', 'Slide', 'The frame turns in perspective toward the left like a cube face.'],
    ['turnright', 'Cube Turn Right', 'Slide', 'The frame turns in perspective toward the right like a cube face.'],
    ['turnup', 'Cube Turn Up', 'Slide', 'The frame turns in perspective upward like a cube face.'],
    ['turndown', 'Cube Turn Down', 'Slide', 'The frame turns in perspective downward like a cube face.'],
    ['foldover', 'Fold Over', 'Slide', 'The next clip folds out from the centre line.'],

    /* ---- Zoom ---- */
    ['zoomblurdissolve', 'Zoom Blur Dissolve', 'Zoom', 'A soft zoom and blur carries the outgoing clip into the next one.'],
    ['punchzoom', 'Punch Zoom', 'Zoom', 'A hard, fast punch-in snaps the next clip into place.'],
    ['divezoom', 'Dive Zoom', 'Zoom', 'The camera dives through the outgoing clip and out of the next one.'],
    ['zoomrotate', 'Zoom Rotate', 'Zoom', 'Both clips zoom and rotate as they trade places.'],
    ['explodezoom', 'Explode Zoom', 'Zoom', 'The outgoing clip blows past the lens as the next one settles.'],
    ['implodezoom', 'Implode Zoom', 'Zoom', 'The outgoing clip collapses to a point and the next one inflates.'],
    ['iriszoom', 'Iris Zoom', 'Zoom', 'An iris opens on a zooming copy of the next clip.'],
    ['whipzoom', 'Whip Zoom', 'Zoom', 'An extreme motion-blurred zoom whips between the clips.'],

    /* ---- Stylised ---- */
    ['vhscut', 'VHS Cut', 'Stylised', 'Tape noise, dropout bars and a chroma split bridge the cut.'],
    ['datamosh', 'Datamosh', 'Stylised', 'Macro-blocks smear and displace the frame between the clips.'],
    ['crtpoweron', 'CRT Power On', 'Stylised', 'A bright line snaps open vertically like an old television.'],
    ['liquidwipe', 'Liquid Wipe', 'Stylised', 'The wipe edge flows and bulges like liquid.'],
    ['tunnelwipe', 'Tunnel Wipe', 'Stylised', 'Nested rectangles fly out of the centre of the frame.'],
    ['spotlightwipe', 'Spotlight Wipe', 'Stylised', 'A soft spotlight opens and widens to reveal the next clip.'],
    ['prismcut', 'Prism Cut', 'Stylised', 'Split colour channels snap together across the cut.'],
    ['inkspill', 'Ink Spill', 'Stylised', 'An ink blot blooms across the outgoing clip.'],
    ['waterripple', 'Water Ripple', 'Stylised', 'Concentric ripples carry the new clip across the frame.'],
    ['neoncut', 'Neon Cut', 'Stylised', 'A glowing neon edge races across the frame.'],
    ['sketchcut', 'Sketch Cut', 'Stylised', 'The outgoing clip washes out as the new one draws itself in.'],
    ['fracturecut', 'Fracture Cut', 'Stylised', 'The frame cracks and the two halves shear apart.'],
    ['lightleak', 'Light Leak', 'Stylised', 'A warm light leak flares across the cut.'],
    ['filmstrip', 'Film Strip', 'Stylised', 'Vertical strips of the clips slide past each other.'],
    ['glitchblinds', 'Glitch Blinds', 'Stylised', 'Digital blinds tear across the frame.'],
    ['matrixrain', 'Matrix Rain', 'Stylised', 'Columns of cells rain down to reveal the next clip.'],
    ['mirrorwipe', 'Mirror Wipe', 'Stylised', 'The frame mirrors about the centre as it turns over.'],
    ['heartbeat', 'Heartbeat', 'Stylised', 'A double pulse punches between the two clips.'],

    /* ---- Flash ---- */
    ['flashcolor', 'Colour Flash', 'Flash', 'Flash through a tinted colour between the two clips.'],
    ['flashstrobe', 'Strobe Flash', 'Flash', 'A strobing flash stutters across the cut.'],
  ];

  /* =========================================================================
     Extended transition families
     ---------------------------------------------------------------------
     These live in a lookup table instead of the classic switch further down.
     The reason is coverage: one well-tested renderer backs a whole group of
     variants (four directions, fourteen blend modes, ...), so a new transition
     is a one-line registration and cannot drift from its siblings.

     Every renderer must be exactly A at p = 0 and exactly B at p = 1; the
     endpoints() guard enforces that for the multi-pass reveals, which keeps
     previews and exports frame-exact.
     ========================================================================= */

  const FAMILY = {};

  /* Exact endpoints for multi-pass reveals. Returns true when p sits on an end
     stop, in which case A (or B) has already been painted and the caller must
     stop. */
  function endpoints(ctx, A, B, w, h, p) {
    if (p <= 0) { ctx.clearRect(0, 0, w, h); ctx.drawImage(A, 0, 0); return true; }
    if (p >= 1) { ctx.clearRect(0, 0, w, h); ctx.drawImage(B, 0, 0); return true; }
    return false;
  }

  /* Opaque A -> B cross-fade used underneath any transition that animates
     scaled, blurred or translated copies of the two clips. Without it the frame
     goes semi-transparent wherever those copies pull apart, and a clip on a
     lower track bleeds through the middle of the move. */
  function coverageBackdrop(ctx, A, B, w, h, p) {
    ctx.globalAlpha = 1;
    ctx.drawImage(A, 0, 0);
    if (p > 0.001) {
      ctx.globalAlpha = clamp(p, 0, 1);
      ctx.drawImage(B, 0, 0);
      ctx.globalAlpha = 1;
    }
  }

  /* Recursive Bayer index for an n x n ordered-dither matrix (n a power of two). */
  function bayerIndex(x, y, n) {
    let v = 0, step = 1;
    while (n > 1) {
      const half = n >> 1;
      const qx = x >= half ? 1 : 0, qy = y >= half ? 1 : 0;
      const add = qx === 0 ? (qy === 0 ? 0 : 3) : (qy === 0 ? 2 : 1);
      v += add * step;
      step *= 4;
      x %= half; y %= half; n = half;
    }
    return v;
  }

  /* ---- blend-mode dissolves ---- */

  /* A cross-fade that also runs the two clips through a canvas blend mode,
     peaking at the midpoint so both ends stay clean cuts. */
  function blendDissolve(ctx, A, B, w, h, p, mode) {
    ctx.drawImage(A, 0, 0);
    const k = Math.sin(p * Math.PI);
    if (k > 0.01) {
      ctx.save();
      ctx.globalCompositeOperation = mode;
      ctx.globalAlpha = k;
      ctx.drawImage(B, 0, 0);
      ctx.restore();
    }
    ctx.save();
    ctx.globalAlpha = p;
    ctx.drawImage(B, 0, 0);
    ctx.restore();
  }
  const blend = (key, mode) => {
    FAMILY[key] = (ctx, A, B, w, h, p) => {
      if (endpoints(ctx, A, B, w, h, p)) return;
      blendDissolve(ctx, A, B, w, h, p, mode);
    };
  };
  blend('screendissolve', 'screen');
  blend('overlaydissolve', 'overlay');
  blend('darkendissolve', 'darken');
  blend('lightendissolve', 'lighten');
  blend('colorburndissolve', 'color-burn');
  blend('colordodgedissolve', 'color-dodge');
  blend('hardlightdissolve', 'hard-light');
  blend('softlightdissolve', 'soft-light');
  blend('differencedissolve', 'difference');
  blend('exclusiondissolve', 'exclusion');
  blend('huedissolve', 'hue');
  blend('saturationdissolve', 'saturation');
  blend('colordissolve', 'color');
  blend('luminositydissolve', 'luminosity');

  /* ---- screen-pattern dissolves ----
     The reveal threshold is drawn into a small tile, tiled across the frame
     with a CanvasPattern. Cost is a few hundred pixels plus one fill, so these
     stay cheap at 4K, 8K and 16K alike. */
  function tileReveal(ctx, A, B, w, h, scratch, size, paint) {
    maskComposite(ctx, A, B, w, h, scratch, (m) => {
      const cache = scratch.tiles || (scratch.tiles = {});
      let t = cache[size];
      if (!t) { t = cache[size] = document.createElement('canvas'); t.width = size; t.height = size; }
      const g = t.getContext('2d');
      g.setTransform(1, 0, 0, 1, 0, 0);
      g.globalCompositeOperation = 'source-over';
      g.clearRect(0, 0, size, size);
      paint(g, size);
      m.fillStyle = m.createPattern(t, 'repeat');
      m.fillRect(0, 0, w, h);
    });
  }

  const pattern = (key, size, paint) => {
    FAMILY[key] = (ctx, A, B, w, h, p, scratch) => {
      if (endpoints(ctx, A, B, w, h, p)) return;
      tileReveal(ctx, A, B, w, h, scratch, size, (g, s) => paint(g, s, p));
    };
  };

  pattern('ditherdissolve', 8, (g, s, p) => {
    const img = g.createImageData(s, s);
    const total = s * s;
    for (let y = 0; y < s; y++) {
      for (let x = 0; x < s; x++) {
        const o = (y * s + x) * 4;
        img.data[o + 3] = (bayerIndex(x, y, s) + 0.5) / total <= p ? 255 : 0;
      }
    }
    g.putImageData(img, 0, 0);
  });

  pattern('halftonedissolve', 16, (g, s, p) => {
    const r = p * s * 0.5;
    if (r <= 0.2) return;
    g.fillStyle = '#000';
    g.beginPath();
    g.arc(s * 0.25, s * 0.25, r, 0, 6.2832);
    g.arc(s * 0.75, s * 0.25, r, 0, 6.2832);
    g.arc(s * 0.25, s * 0.75, r, 0, 6.2832);
    g.arc(s * 0.75, s * 0.75, r, 0, 6.2832);
    g.fill();
  });

  pattern('dotdissolve', 16, (g, s, p) => {
    const reveal = Math.min(1, p / 0.62);
    const grow = clamp((p - 0.62) / 0.38, 0, 1);
    const r = s * (0.17 + 0.33 * grow);
    g.fillStyle = '#000';
    const pts = [[0.25, 0.25], [0.75, 0.75], [0.75, 0.25], [0.25, 0.75]];
    g.beginPath();
    for (let i = 0; i < 4; i++) {
      if ((bayerIndex(i & 1, i >> 1, 2) + 0.5) / 4 > reveal) continue;
      g.moveTo(pts[i][0] * s + r, pts[i][1] * s);
      g.arc(pts[i][0] * s, pts[i][1] * s, r, 0, 6.2832);
    }
    g.fill();
  });

  pattern('linedissolve', 8, (g, s, p) => { g.fillStyle = '#000'; g.fillRect(0, 0, s, p * s); });
  pattern('vlinedissolve', 8, (g, s, p) => { g.fillStyle = '#000'; g.fillRect(0, 0, p * s, s); });
  pattern('diaglinedissolve', 16, (g, s, p) => {
    g.fillStyle = '#000';
    g.save();
    g.translate(s / 2, s / 2);
    g.rotate(Math.PI / 4);
    g.fillRect(-s * 1.5, -s * 1.5, s * 3, p * s * 1.5);
    g.restore();
  });
  pattern('crosshatchdissolve', 8, (g, s, p) => {
    g.fillStyle = '#000';
    g.fillRect(0, 0, s, p * s);
    g.fillRect(0, 0, p * s, s);
  });

  /* A bright band sweeps down, resolving the new clip in its wake. */
  FAMILY.scanlinedissolve = (ctx, A, B, w, h, p, scratch) => {
    if (endpoints(ctx, A, B, w, h, p)) return;
    ctx.drawImage(A, 0, 0);
    const y = p * h;
    ctx.save();
    ctx.beginPath(); ctx.rect(0, 0, w, y); ctx.clip();
    ctx.drawImage(B, 0, 0);
    ctx.restore();
    const k = Math.sin(p * Math.PI);
    if (k > 0.02) {
      const bh = h * 0.07;
      const g = ctx.createLinearGradient(0, y - bh, 0, y + bh);
      g.addColorStop(0, 'rgba(180,230,255,0)');
      g.addColorStop(0.5, `rgba(205,240,255,${(0.6 * k).toFixed(3)})`);
      g.addColorStop(1, 'rgba(180,230,255,0)');
      ctx.save();
      ctx.fillStyle = g;
      ctx.fillRect(0, y - bh, w, bh * 2);
      ctx.restore();
    }
  };

  /* ---- tiles with an entrance motion ---- */

  /* Cells pop in on a hashed order, each with its own way of arriving. */
  function cellReveal(ctx, A, B, w, h, p, style) {
    const cols = 10, rows = Math.max(2, Math.round((cols * h) / w));
    const cw = w / cols, ch = h / rows, total = cols * rows;
    ctx.drawImage(A, 0, 0);
    const shown = p * total;
    for (let i = 0; i < total; i++) {
      const order = (i * 2654435761) % total;
      const local = clamp((shown - order) * 1.6, 0, 1);
      if (local <= 0.001) continue;
      const x = (i % cols) * cw, y = Math.floor(i / cols) * ch;
      const e = easeInOut(local);
      let dx = 0, dy = 0, s = 1, rot = 0;
      const alpha = clamp(local * 1.5, 0, 1);
      if (style === 'gravity') dy = -(1 - e) * h * 0.55;
      else if (style === 'vacuum') { dx = (w / 2 - (x + cw / 2)) * (1 - e); dy = (h / 2 - (y + ch / 2)) * (1 - e); }
      else if (style === 'fly') {
        dx = Math.cos(hash(i * 2.7) * 6.2832) * (1 - e) * w * 0.35;
        dy = Math.sin(hash(i * 5.1 + 9) * 6.2832) * (1 - e) * h * 0.35;
      } else if (style === 'flip') s = Math.max(0.02, e);
      else if (style === 'zoom') s = 0.15 + 0.85 * e;
      else if (style === 'domino') rot = (1 - e) * 1.25;
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.translate(x + cw / 2 + dx, y + ch / 2 + dy);
      if (rot) ctx.rotate(rot);
      if (s !== 1) ctx.scale(s, s);
      ctx.beginPath();
      ctx.rect(-cw / 2, -ch / 2, cw, ch);
      ctx.clip();
      ctx.drawImage(B, -(x + cw / 2), -(y + ch / 2));
      ctx.restore();
    }
  }
  const cells = (key, style) => {
    FAMILY[key] = (ctx, A, B, w, h, p) => {
      if (endpoints(ctx, A, B, w, h, p)) return;
      cellReveal(ctx, A, B, w, h, p, style);
    };
  };
  cells('dominoeffect', 'domino');
  cells('gravitydissolve', 'gravity');
  cells('vacuumdissolve', 'vacuum');
  cells('flyindissolve', 'fly');
  cells('flipcells', 'flip');
  cells('zoomcells', 'zoom');

  FAMILY.posterizedissolve = (ctx, A, B, w, h, p) => {
    if (endpoints(ctx, A, B, w, h, p)) return;
    const steps = 8;
    const q = Math.round(p * steps) / steps;
    ctx.drawImage(A, 0, 0);
    ctx.save();
    ctx.globalAlpha = clamp(q * 1.2, 0, 1);
    ctx.drawImage(B, 0, 0);
    ctx.restore();
  };

  FAMILY.kaleidoscope = (ctx, A, B, w, h, p) => {
    if (endpoints(ctx, A, B, w, h, p)) return;
    ctx.drawImage(A, 0, 0);
    const seg = 6, R = Math.hypot(w, h) * 0.8;
    const rot = easeInOut(p) * (Math.PI * 2 / seg);
    for (let i = 0; i < seg; i++) {
      ctx.save();
      ctx.translate(w / 2, h / 2);
      ctx.rotate(rot + (Math.PI * 2 * i) / seg);
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.arc(0, 0, R, -Math.PI / seg, Math.PI / seg);
      ctx.closePath();
      ctx.clip();
      ctx.globalAlpha = clamp(p * 1.3, 0, 1) * 0.6;
      ctx.drawImage(B, -w / 2, -h / 2);
      ctx.restore();
    }
  };

  FAMILY.bokehdissolve = (ctx, A, B, w, h, p) => {
    if (endpoints(ctx, A, B, w, h, p)) return;
    ctx.drawImage(A, 0, 0);
    const n = 40;
    const e = easeInOut(p);
    const path = new Path2D();
    for (let i = 0; i < n; i++) {
      const cx = hash(i * 3.7) * w, cy = hash(i * 5.9 + 2) * h;
      const R = (0.08 + hash(i * 9.1) * 0.14) * Math.min(w, h) * 1.5 * e;
      path.moveTo(cx + R, cy);
      path.arc(cx, cy, R, 0, 6.2832);
    }
    ctx.save();
    const soft = Math.sin(p * Math.PI) * Math.min(w, h) * 0.005;
    if (soft > 0.2) ctx.filter = `blur(${soft.toFixed(2)}px)`;
    ctx.beginPath();
    ctx.clip(path);
    ctx.drawImage(B, 0, 0);
    ctx.restore();
  };

  FAMILY.particledissolve = (ctx, A, B, w, h, p, scratch) => {
    if (endpoints(ctx, A, B, w, h, p)) return;
    ctx.drawImage(A, 0, 0);
    const cols = 40, rows = Math.max(4, Math.round((cols * h) / w));
    const cw = w / cols, ch = h / rows;
    const e = easeInOut(p);
    ctx.save();
    ctx.globalAlpha = clamp(p * 1.25, 0, 1);
    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < cols; x++) {
        if (hash(x * 3.13 + y * 7.77) > 0.35 + 0.65 * e) continue;
        const px = (x + 0.5) * cw, py = (y + 0.5) * ch;
        const dx = (hash(x * 1.7 + y) - 0.5) * cw * 1.2 * (1 - e);
        const dy = -(hash(x + y * 2.3) * ch * 1.6 * (1 - e));
        ctx.save();
        ctx.translate(px + dx, py + dy);
        ctx.rotate((1 - e) * hash(x * 4.4 + y) * 3);
        const s = 0.4 + 0.6 * e;
        ctx.scale(s, s);
        ctx.drawImage(B, x * cw, y * ch, cw, ch, -cw / 2, -ch / 2, cw, ch);
        ctx.restore();
      }
    }
    ctx.restore();
  };

  /* ---- growing-shape wipes ---- */

  function polygonPath(cx, cy, R, sides, rot) {
    const c = new Path2D();
    for (let i = 0; i < sides; i++) {
      const a = rot + (Math.PI * 2 * i) / sides;
      const x = cx + Math.cos(a) * R, y = cy + Math.sin(a) * R;
      if (i === 0) c.moveTo(x, y); else c.lineTo(x, y);
    }
    c.closePath();
    return c;
  }

  /* Lay A down, then reveal B through a clip path that the shape function
     builds for the current progress. */
  function shapeGrow(ctx, A, B, w, h, p, makePath) {
    ctx.drawImage(A, 0, 0);
    ctx.save();
    ctx.clip(makePath(p));
    ctx.drawImage(B, 0, 0);
    ctx.restore();
  }

  const growShape = (key, sides) => {
    FAMILY[key] = (ctx, A, B, w, h, p) => {
      if (endpoints(ctx, A, B, w, h, p)) return;
      shapeGrow(ctx, A, B, w, h, p, (pp) =>
        polygonPath(w / 2, h / 2, pp * Math.hypot(w, h) * 1.15, sides, -Math.PI / 2));
    };
  };
  growShape('trianglewipe', 3);
  growShape('pentagonwipe', 5);
  growShape('hexagonwipe', 6);
  growShape('heptagonwipe', 7);
  growShape('octagonwipe', 8);
  growShape('decagonwipe', 10);

  const starburst = (key, points, inner) => {
    FAMILY[key] = (ctx, A, B, w, h, p) => {
      if (endpoints(ctx, A, B, w, h, p)) return;
      shapeGrow(ctx, A, B, w, h, p, (pp) => {
        const R = pp * Math.hypot(w, h) * 1.15;
        const c = new Path2D();
        for (let i = 0; i < points * 2; i++) {
          const a = -Math.PI / 2 + (i * Math.PI) / points;
          const r = i % 2 ? R * inner : R;
          const x = w / 2 + Math.cos(a) * r, y = h / 2 + Math.sin(a) * r;
          if (i === 0) c.moveTo(x, y); else c.lineTo(x, y);
        }
        c.closePath();
        return c;
      });
    };
  };
  starburst('burstwipe', 24, 0.86);

  FAMILY.sunburstwipe = (ctx, A, B, w, h, p) => {
    if (endpoints(ctx, A, B, w, h, p)) return;
    ctx.drawImage(A, 0, 0);
    const arms = 16;
    const e = easeInOut(p);
    const R = Math.hypot(w, h) * 1.15 * Math.min(1, e * 1.15);
    const fill = clamp((e - 0.82) / 0.18, 0, 1);
    const sector = (Math.PI * 2) / arms;
    const c = new Path2D();
    for (let i = 0; i < arms; i++) {
      const a0 = sector * i + e * 0.4;
      const wid = sector * (0.6 + 0.4 * fill);
      c.moveTo(w / 2, h / 2);
      c.lineTo(w / 2 + Math.cos(a0) * R, h / 2 + Math.sin(a0) * R);
      c.lineTo(w / 2 + Math.cos(a0 + wid) * R, h / 2 + Math.sin(a0 + wid) * R);
      c.closePath();
    }
    ctx.save();
    ctx.clip(c);
    ctx.drawImage(B, 0, 0);
    ctx.restore();
  };

  FAMILY.heartwipe = (ctx, A, B, w, h, p) => {
    if (endpoints(ctx, A, B, w, h, p)) return;
    shapeGrow(ctx, A, B, w, h, p, (pp) => {
      const s = pp * Math.hypot(w, h) * 0.78;
      const cx = w / 2, cy = h / 2;
      const c = new Path2D();
      c.moveTo(cx, cy + s * 0.95);
      c.bezierCurveTo(cx - s * 1.6, cy - s * 0.35, cx - s * 0.8, cy - s * 1.45, cx, cy - s * 0.45);
      c.bezierCurveTo(cx + s * 0.8, cy - s * 1.45, cx + s * 1.6, cy - s * 0.35, cx, cy + s * 0.95);
      c.closePath();
      return c;
    });
  };

  FAMILY.arrowwipe = (ctx, A, B, w, h, p) => {
    if (endpoints(ctx, A, B, w, h, p)) return;
    shapeGrow(ctx, A, B, w, h, p, (pp) => {
      const s = pp * Math.hypot(w, h) * 0.95;
      const cx = w / 2, cy = h / 2;
      const c = new Path2D();
      c.moveTo(cx + s, cy);
      c.lineTo(cx + s * 0.2, cy - s * 0.5);
      c.lineTo(cx + s * 0.2, cy - s * 0.2);
      c.lineTo(cx - s, cy - s * 0.2);
      c.lineTo(cx - s, cy + s * 0.2);
      c.lineTo(cx + s * 0.2, cy + s * 0.2);
      c.lineTo(cx + s * 0.2, cy + s * 0.5);
      c.closePath();
      return c;
    });
  };

  FAMILY.keyholewipe = (ctx, A, B, w, h, p) => {
    if (endpoints(ctx, A, B, w, h, p)) return;
    shapeGrow(ctx, A, B, w, h, p, (pp) => {
      const s = pp * Math.hypot(w, h) * 1.05;
      const cx = w / 2, cy = h / 2;
      const c = new Path2D();
      c.moveTo(cx, cy + s);
      c.lineTo(cx - s * 0.14, cy + s * 0.02);
      c.lineTo(cx + s * 0.14, cy + s * 0.02);
      c.closePath();
      c.moveTo(cx + s * 0.44, cy - s * 0.14);
      c.arc(cx, cy - s * 0.14, s * 0.44, 0, Math.PI * 2);
      return c;
    });
  };

  FAMILY.crosswipe = (ctx, A, B, w, h, p) => {
    if (endpoints(ctx, A, B, w, h, p)) return;
    shapeGrow(ctx, A, B, w, h, p, (pp) => {
      const s = pp * Math.hypot(w, h) * 1.15;
      const t = Math.max(2, s * 0.34);
      const c = new Path2D();
      c.rect(w / 2 - t / 2, h / 2 - s / 2, t, s);
      c.rect(w / 2 - s / 2, h / 2 - t / 2, s, t);
      return c;
    });
  };

  FAMILY.hourglasswipe = (ctx, A, B, w, h, p) => {
    if (endpoints(ctx, A, B, w, h, p)) return;
    shapeGrow(ctx, A, B, w, h, p, (pp) => {
      const t = pp * Math.hypot(w, h) * 1.15;
      const c = new Path2D();
      c.moveTo(w / 2 - t, 0); c.lineTo(w / 2 + t, 0); c.lineTo(w / 2, h / 2); c.closePath();
      c.moveTo(w / 2 - t, h); c.lineTo(w / 2 + t, h); c.lineTo(w / 2, h / 2); c.closePath();
      return c;
    });
  };

  FAMILY.spiralwipe = (ctx, A, B, w, h, p) => {
    if (endpoints(ctx, A, B, w, h, p)) return;
    shapeGrow(ctx, A, B, w, h, p, (pp) => {
      const turns = 3.2, R = Math.hypot(w, h) * 1.2;
      const maxA = Math.PI * 2 * turns * pp;
      const k = R / (Math.PI * 2 * turns);
      const band = Math.max(Math.min(w, h) * 0.06, (R / turns) * pp * 1.05);
      const c = new Path2D();
      c.moveTo(w / 2, h / 2);
      for (let a = 0; a <= maxA; a += 0.08) {
        const r = k * a;
        c.lineTo(w / 2 + Math.cos(a) * r, h / 2 + Math.sin(a) * r);
      }
      for (let a = maxA; a >= 0; a -= 0.08) {
        const r = Math.max(0, k * a - band);
        c.lineTo(w / 2 + Math.cos(a) * r, h / 2 + Math.sin(a) * r);
      }
      c.closePath();
      return c;
    });
  };

  FAMILY.ringwipe = (ctx, A, B, w, h, p, scratch) => {
    if (endpoints(ctx, A, B, w, h, p)) return;
    const r = p * Math.hypot(w, h) * 0.8;
    maskComposite(ctx, A, B, w, h, scratch, (m) => {
      const g = m.createRadialGradient(w / 2, h / 2, Math.max(0, r * 0.55), w / 2, h / 2, Math.max(0.5, r));
      g.addColorStop(0, 'rgba(0,0,0,1)');
      g.addColorStop(0.82, 'rgba(0,0,0,1)');
      g.addColorStop(1, 'rgba(0,0,0,0)');
      m.fillStyle = g;
      m.fillRect(0, 0, w, h);
    });
  };

  FAMILY.radialblinds = (ctx, A, B, w, h, p, scratch) => {
    if (endpoints(ctx, A, B, w, h, p)) return;
    maskComposite(ctx, A, B, w, h, scratch, (m) => {
      const n = 24, R = Math.hypot(w, h) * 0.7;
      const wA = (Math.PI * 2) / n * p;
      if (wA <= 0) return;
      m.fillStyle = '#000';
      for (let i = 0; i < n; i++) {
        const a = (Math.PI * 2 * i) / n;
        m.beginPath();
        m.moveTo(w / 2, h / 2);
        m.arc(w / 2, h / 2, R, a, a + wA);
        m.closePath();
        m.fill();
      }
    });
  };

  FAMILY.splitwipe = (ctx, A, B, w, h, p) => {
    if (endpoints(ctx, A, B, w, h, p)) return;
    const e = easeInOut(p);
    ctx.drawImage(B, 0, 0);
    const off = (w / 2) * e;
    ctx.drawImage(A, 0, 0, w / 2, h, -off, 0, w / 2, h);
    ctx.drawImage(A, w / 2, 0, w / 2, h, w / 2 + off, 0, w / 2, h);
  };

  FAMILY.gridwipe = (ctx, A, B, w, h, p, scratch) => {
    if (endpoints(ctx, A, B, w, h, p)) return;
    maskComposite(ctx, A, B, w, h, scratch, (m) => {
      m.fillStyle = '#000';
      const cols = 6, rows = Math.max(2, Math.round((cols * h) / w));
      const cw = w / cols, ch = h / rows;
      const gx = cw * p, gy = ch * p;
      for (let y = 0; y < rows; y++) {
        for (let x = 0; x < cols; x++) {
          m.fillRect(x * cw + (cw - gx) / 2, y * ch + (ch - gy) / 2, gx + 0.5, gy + 0.5);
        }
      }
    });
  };

  FAMILY.vblinds = (ctx, A, B, w, h, p) => {
    if (endpoints(ctx, A, B, w, h, p)) return;
    ctx.drawImage(A, 0, 0);
    const count = 14, bw = w / count;
    ctx.save();
    ctx.beginPath();
    for (let i = 0; i < count; i++) ctx.rect(i * bw, 0, bw * p, h);
    ctx.clip();
    ctx.drawImage(B, 0, 0);
    ctx.restore();
  };

  FAMILY.waveblinds = (ctx, A, B, w, h, p, scratch) => {
    if (endpoints(ctx, A, B, w, h, p)) return;
    maskComposite(ctx, A, B, w, h, scratch, (m) => {
      const count = 14, bh = h / count;
      const amp = bh * 0.35;
      const step = Math.max(4, w / 60);
      m.fillStyle = '#000';
      for (let i = 0; i < count; i++) {
        const y0 = i * bh;
        m.beginPath();
        for (let x = 0; x <= w; x += step) m.lineTo(x, y0 + Math.sin((x / w) * Math.PI * 6) * amp);
        for (let x = w; x >= 0; x -= step) m.lineTo(x, y0 + bh * p + Math.sin((x / w) * Math.PI * 6) * amp);
        m.closePath();
        m.fill();
      }
    });
  };

  const cornerWedge = (key, fx, fy, a0) => {
    FAMILY[key] = (ctx, A, B, w, h, p) => {
      if (endpoints(ctx, A, B, w, h, p)) return;
      ctx.drawImage(A, 0, 0);
      const cx = fx * w, cy = fy * h, R = Math.hypot(w, h) * 1.25;
      ctx.save();
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.arc(cx, cy, R, a0, a0 + (Math.PI / 2) * easeInOut(p));
      ctx.closePath();
      ctx.clip();
      ctx.drawImage(B, 0, 0);
      ctx.restore();
    };
  };
  cornerWedge('cornerwipeNE', 1, 0, Math.PI / 2);
  cornerWedge('cornerwipeSE', 1, 1, Math.PI);
  cornerWedge('cornerwipeSW', 0, 1, -Math.PI / 2);

  /* ---- slide geometry ----
     One implementation for the three ways two clips can travel: cover (B
     crosses a still A), reveal (A leaves a still B) and push (both move). */
  function sideShift(ctx, A, B, w, h, p, ox, oy, style) {
    const e = easeInOut(p);
    if (style === 'reveal') {
      ctx.drawImage(B, 0, 0);
      ctx.drawImage(A, ox * w * e, oy * h * e);
      return;
    }
    ctx.drawImage(A, 0, 0);
    if (style === 'push') ctx.drawImage(A, -ox * w * e, -oy * h * e);
    ctx.drawImage(B, ox * w * (1 - e), oy * h * (1 - e));
  }
  const shift = (key, ox, oy, style) => {
    FAMILY[key] = (ctx, A, B, w, h, p) => {
      if (endpoints(ctx, A, B, w, h, p)) return;
      sideShift(ctx, A, B, w, h, p, ox, oy, style);
    };
  };
  shift('revealleft', -1, 0, 'reveal');
  shift('revealright', 1, 0, 'reveal');
  shift('revealup', 0, -1, 'reveal');
  shift('revealdown', 0, 1, 'reveal');
  shift('slidediagUL', 1, 1, 'cover');
  shift('slidediagUR', -1, 1, 'cover');
  shift('slidediagDL', 1, -1, 'cover');
  shift('slidediagDR', -1, -1, 'cover');
  shift('pushdiagUL', 1, 1, 'push');
  shift('pushdiagUR', -1, 1, 'push');
  shift('pushdiagDL', 1, -1, 'push');
  shift('pushdiagDR', -1, -1, 'push');

  FAMILY.squeezeV = (ctx, A, B, w, h, p) => {
    if (endpoints(ctx, A, B, w, h, p)) return;
    const e = easeInOut(p);
    const a = Math.max(0, h * (1 - e));
    const b = Math.max(0, h * e);
    if (a > 0.5) ctx.drawImage(A, 0, 0, w, a, 0, 0, w, a);
    if (b > 0.5) ctx.drawImage(B, 0, 0, w, b, 0, h - b, w, b);
  };

  FAMILY.barnvertical = (ctx, A, B, w, h, p) => {
    if (endpoints(ctx, A, B, w, h, p)) return;
    ctx.drawImage(A, 0, 0);
    const half = (h / 2) * easeInOut(p);
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, h / 2 - half, w, half * 2);
    ctx.clip();
    ctx.drawImage(B, 0, 0);
    ctx.restore();
  };

  FAMILY.curtainV = (ctx, A, B, w, h, p) => {
    if (endpoints(ctx, A, B, w, h, p)) return;
    ctx.drawImage(A, 0, 0);
    const bands = 16, bh = h / bands;
    const open = (w / 2) * easeInOut(p);
    ctx.save();
    ctx.beginPath();
    for (let i = 0; i < bands; i++) {
      ctx.rect(0, i * bh, open, bh);
      ctx.rect(w - open, i * bh, open, bh);
    }
    ctx.clip();
    ctx.drawImage(B, 0, 0);
    ctx.restore();
  };

  /* A push with a cylindrical shading band riding the seam. */
  function rollShift(ctx, A, B, w, h, p, dir) {
    const e = easeInOut(p);
    const vert = dir === 'up' || dir === 'down';
    const sgn = (dir === 'up' || dir === 'left') ? -1 : 1;
    if (vert) { ctx.drawImage(A, 0, sgn * h * e); ctx.drawImage(B, 0, -sgn * h * (1 - e)); }
    else { ctx.drawImage(A, sgn * w * e, 0); ctx.drawImage(B, -sgn * w * (1 - e), 0); }
    const k = Math.sin(p * Math.PI);
    if (k <= 0.02) return;
    const L = vert ? h : w;
    const seam = sgn < 0 ? L * (1 - e) : L * e;
    const band = Math.max(4, L * 0.06);
    const g = vert
      ? ctx.createLinearGradient(0, seam - band, 0, seam + band)
      : ctx.createLinearGradient(seam - band, 0, seam + band, 0);
    g.addColorStop(0, 'rgba(0,0,0,0.8)');
    g.addColorStop(0.5, 'rgba(255,255,255,0.22)');
    g.addColorStop(1, 'rgba(0,0,0,0.8)');
    ctx.save();
    ctx.globalAlpha = k * 0.9;
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
    ctx.restore();
  }
  const roll = (key, dir) => {
    FAMILY[key] = (ctx, A, B, w, h, p) => {
      if (endpoints(ctx, A, B, w, h, p)) return;
      rollShift(ctx, A, B, w, h, p, dir);
    };
  };
  roll('rollleft', 'left');
  roll('rollright', 'right');
  roll('rollup', 'up');
  roll('rolldown', 'down');

  /* A perspective face turn: the outgoing face narrows to nothing while the
     incoming one widens out of the same axis. */
  function turn3d(ctx, A, B, w, h, p, dir) {
    const e = easeInOut(p);
    const horiz = dir === 'left' || dir === 'right';
    const sgn = (dir === 'left' || dir === 'up') ? -1 : 1;
    const aS = Math.max(0.001, Math.cos((e * Math.PI) / 2));
    const off = (1 - aS) * 0.5;
    /* The incoming clip waits underneath at full size, so the frame is never
       see-through; only the outgoing face narrows and slides toward the edge. */
    ctx.drawImage(B, 0, 0);
    ctx.save();
    ctx.translate(
      horiz ? w / 2 + sgn * off * w : w / 2,
      horiz ? h / 2 : h / 2 + sgn * off * h
    );
    if (horiz) ctx.scale(aS, 1); else ctx.scale(1, aS);
    ctx.drawImage(A, -w / 2, -h / 2);
    ctx.restore();
    const shade = Math.sin(p * Math.PI) * 0.55;
    if (shade > 0.02) {
      const g = horiz
        ? ctx.createLinearGradient(0, 0, w, 0)
        : ctx.createLinearGradient(0, 0, 0, h);
      g.addColorStop(0, 'rgba(0,0,0,0.7)');
      g.addColorStop(0.5, 'rgba(0,0,0,0)');
      g.addColorStop(1, 'rgba(0,0,0,0.7)');
      ctx.save();
      ctx.globalAlpha = shade;
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, w, h);
      ctx.restore();
    }
  }
  const turn = (key, dir) => {
    FAMILY[key] = (ctx, A, B, w, h, p) => {
      if (endpoints(ctx, A, B, w, h, p)) return;
      turn3d(ctx, A, B, w, h, p, dir);
    };
  };
  turn('turnleft', 'left');
  turn('turnright', 'right');
  turn('turnup', 'up');
  turn('turndown', 'down');

  FAMILY.foldover = (ctx, A, B, w, h, p) => {
    if (endpoints(ctx, A, B, w, h, p)) return;
    const e = easeInOut(p);
    ctx.drawImage(A, 0, 0);
    const half = w / 2;
    ctx.save();
    ctx.beginPath(); ctx.rect(0, 0, half, h + 0.5); ctx.clip();
    ctx.drawImage(B, 0, 0, half, h, -half * (1 - e), 0, half, h);
    ctx.restore();
    ctx.save();
    ctx.beginPath(); ctx.rect(half, 0, half, h + 0.5); ctx.clip();
    const s = Math.max(0.02, e);
    ctx.translate(w, h / 2);
    ctx.scale(s, 1);
    ctx.drawImage(B, half, 0, half, h, -half, -h / 2, half, h);
    ctx.restore();
  };

  /* ---- zoom geometry ----
     The incoming clip is laid down first at full opacity and the outgoing one
     rides on top, fading and scaling away. That ordering means the frame is
     never transparent mid-transition and p = 0 is still exactly A. */
  function zoomBlend(ctx, A, B, w, h, p, o) {
    const e = easeInOut(p);
    const sa = 1 + (o.sa - 1) * e;
    const sb0 = o.sb0 === undefined ? 1.35 : o.sb0;
    /* The incoming clip may also be rotated. A rotated rectangle only keeps
       covering the frame if it grows by cos + (w/h)|sin|, so take that as a
       floor: otherwise the corners come back as a wedge of transparency. */
    const rotB = (o.rotB || 0) * (1 - e);
    let sb = sb0 + (1 - sb0) * e;
    if (rotB !== 0) {
      const cs = Math.abs(Math.cos(rotB)), sn = Math.abs(Math.sin(rotB));
      sb = Math.max(sb, cs + (w / h) * sn, cs + (h / w) * sn);
    }
    /* Blur is expressed as a fraction of the frame so previews at any size
       match the export. */
    const blur = (o.blur || 0) * Math.min(w, h) * 0.03 * Math.sin(p * Math.PI);
    const bf = blur > 0.3 ? `blur(${blur.toFixed(2)}px)` : 'none';
    ctx.save();
    if (bf !== 'none') ctx.filter = bf;
    ctx.translate(w / 2, h / 2);
    ctx.rotate(rotB);
    ctx.scale(sb, sb);
    ctx.drawImage(B, -w / 2, -h / 2);
    ctx.restore();
    ctx.save();
    if (bf !== 'none') ctx.filter = bf;
    ctx.globalAlpha = clamp(1 - e, 0, 1);
    ctx.translate(w / 2, h / 2);
    ctx.rotate((o.rotA || 0) * e);
    ctx.scale(sa, sa);
    ctx.drawImage(A, -w / 2, -h / 2);
    ctx.restore();
  }
  const zooms = (key, o) => {
    FAMILY[key] = (ctx, A, B, w, h, p) => {
      if (endpoints(ctx, A, B, w, h, p)) return;
      zoomBlend(ctx, A, B, w, h, p, o);
    };
  };
  /* sb0 is always at or above 1: the incoming clip starts zoomed in and settles
     back to a full-frame fit, so the frame is never left with a hole. */
  zooms('zoomblurdissolve', { sa: 1.35, sb0: 1.25, blur: 0.45 });
  zooms('punchzoom', { sa: 1.12, sb0: 3.0 });
  zooms('divezoom', { sa: 4.0, sb0: 1.6, blur: 0.2 });
  zooms('zoomrotate', { sa: 1.9, sb0: 1.5, rotA: 0.5, rotB: -0.35 });
  zooms('explodezoom', { sa: 2.8, sb0: 1.8 });
  zooms('implodezoom', { sa: 0.05, sb0: 1.7 });
  zooms('whipzoom', { sa: 6.0, sb0: 2.5, blur: 0.8 });

  FAMILY.iriszoom = (ctx, A, B, w, h, p) => {
    if (endpoints(ctx, A, B, w, h, p)) return;
    const e = easeInOut(p);
    ctx.drawImage(A, 0, 0);
    const r = p * Math.hypot(w, h) * 0.62;
    ctx.save();
    ctx.beginPath();
    ctx.arc(w / 2, h / 2, r, 0, Math.PI * 2);
    ctx.clip();
    const s = 1.5 - 0.5 * e;
    ctx.translate(w / 2, h / 2);
    ctx.scale(s, s);
    ctx.globalAlpha = clamp(p * 1.2, 0, 1);
    ctx.drawImage(B, -w / 2, -h / 2);
    ctx.restore();
  };

  /* ---- stylised ----
     Anything that filters or multiplies the picture is weighted by sin(p*pi)
     so it cancels out at both end stops and p = 1 stays a plain, exact B. */

  FAMILY.vhscut = (ctx, A, B, w, h, p) => {
    if (endpoints(ctx, A, B, w, h, p)) return;
    const k = Math.sin(p * Math.PI);
    ctx.drawImage(A, 0, 0);
    ctx.save();
    ctx.globalAlpha = clamp(p * 1.15, 0, 1);
    ctx.drawImage(B, 0, 0);
    ctx.restore();
    if (k <= 0.02) return;
    const shift = k * Math.min(w, h) * 0.012;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = k * 0.32;
    ctx.drawImage(B, -shift, 0);
    ctx.drawImage(B, shift, 0);
    ctx.restore();
    ctx.save();
    ctx.globalAlpha = k * 0.45;
    ctx.fillStyle = '#000';
    const lines = 110;
    for (let i = 0; i < lines; i += 2) ctx.fillRect(0, (i / lines) * h, w, Math.max(1, h / lines));
    ctx.restore();
    ctx.save();
    ctx.globalAlpha = k * 0.4;
    ctx.fillStyle = 'rgba(255,255,255,0.55)';
    const bars = 4, seed = Math.floor(p * 9);
    for (let i = 0; i < bars; i++) {
      const yy = hash(i * 5.1 + seed) * h;
      ctx.fillRect(0, yy, w, Math.max(2, h * 0.012));
    }
    ctx.restore();
  };

  FAMILY.datamosh = (ctx, A, B, w, h, p) => {
    if (endpoints(ctx, A, B, w, h, p)) return;
    const k = Math.sin(p * Math.PI);
    ctx.drawImage(A, 0, 0);
    const cols = 14, rows = Math.max(2, Math.round((cols * h) / w));
    const cw = w / cols, ch = h / rows;
    const seed = Math.floor(p * 12);
    ctx.save();
    ctx.globalAlpha = clamp(p * 1.3, 0, 1);
    for (let i = 0; i < cols * rows; i++) {
      const x = (i % cols) * cw, y = Math.floor(i / cols) * ch;
      const dx = (hash(i * 3.3 + seed * 2) - 0.5) * cw * 2.4 * k;
      const dy = (hash(i * 7.9 + seed * 3) - 0.5) * ch * 1.4 * k;
      ctx.drawImage(B, x + dx, y + dy, cw, ch, x, y, cw, ch);
    }
    ctx.restore();
  };

  FAMILY.crtpoweron = (ctx, A, B, w, h, p) => {
    if (endpoints(ctx, A, B, w, h, p)) return;
    ctx.drawImage(A, 0, 0);
    const e = easeInOut(p);
    const half = (h / 2) * e;
    const line = Math.max(1, h * 0.012);
    if (half > 0.5) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, h / 2 - half - line / 2, w, half * 2 + line);
      ctx.clip();
      ctx.drawImage(B, 0, 0);
      ctx.restore();
    }
    ctx.save();
    ctx.globalAlpha = clamp(1 - p, 0, 1) * 0.9;
    ctx.fillStyle = '#dff3ff';
    ctx.fillRect(0, h / 2 - line / 2, w, line);
    ctx.restore();
  };

  FAMILY.liquidwipe = (ctx, A, B, w, h, p) => {
    if (endpoints(ctx, A, B, w, h, p)) return;
    ctx.drawImage(A, 0, 0);
    const e = easeInOut(p);
    const slices = 60, sw = w / slices;
    const k = Math.sin(p * Math.PI);
    const edge = e * (w * 1.25) - w * 0.1;
    for (let i = 0; i < slices; i++) {
      const x = i * sw;
      const a = clamp((edge - x) / (w * 0.09), 0, 1);
      if (a <= 0) continue;
      const dy = Math.sin((x / w) * Math.PI * 8 + p * 8) * h * 0.05 * k;
      const dx = Math.sin((x / w) * Math.PI * 5 + p * 6) * w * 0.03 * k;
      ctx.save();
      ctx.globalAlpha = a;
      ctx.drawImage(B, x + dx, dy, sw + 1, h, x, 0, sw + 1, h);
      ctx.restore();
    }
  };

  FAMILY.tunnelwipe = (ctx, A, B, w, h, p) => {
    if (endpoints(ctx, A, B, w, h, p)) return;
    const e = easeInOut(p);
    ctx.drawImage(A, 0, 0);
    const count = 12;
    for (let i = count - 1; i >= 0; i--) {
      const t = clamp(e * (count + 2) - i, 0, 1);
      if (t <= 0) continue;
      const s = 0.1 + t * 1.05;
      const rw = w * s, rh = h * s;
      ctx.save();
      ctx.globalAlpha = clamp(t * 1.25, 0, 1);
      ctx.drawImage(B, 0, 0, w, h, (w - rw) / 2, (h - rh) / 2, rw, rh);
      ctx.restore();
    }
  };

  FAMILY.spotlightwipe = (ctx, A, B, w, h, p, scratch) => {
    if (endpoints(ctx, A, B, w, h, p)) return;
    const r = (0.06 + 0.94 * easeInOut(p)) * Math.hypot(w, h) * 0.75;
    maskComposite(ctx, A, B, w, h, scratch, (m) => {
      const g = m.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, Math.max(1, r));
      g.addColorStop(0, 'rgba(0,0,0,1)');
      g.addColorStop(0.85, 'rgba(0,0,0,1)');
      g.addColorStop(1, 'rgba(0,0,0,0)');
      m.fillStyle = g;
      m.fillRect(0, 0, w, h);
    });
  };

  FAMILY.prismcut = (ctx, A, B, w, h, p) => {
    if (endpoints(ctx, A, B, w, h, p)) return;
    const k = Math.sin(p * Math.PI);
    ctx.drawImage(A, 0, 0);
    ctx.save();
    ctx.globalAlpha = clamp(p * 1.3, 0, 1);
    ctx.drawImage(B, 0, 0);
    ctx.restore();
    if (k <= 0.02) return;
    const off = k * Math.min(w, h) * 0.02;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = k * 0.3;
    ctx.drawImage(B, -off, 0);
    ctx.drawImage(B, off, 0);
    ctx.restore();
  };

  FAMILY.inkspill = (ctx, A, B, w, h, p) => {
    if (endpoints(ctx, A, B, w, h, p)) return;
    const e = easeInOut(p);
    ctx.drawImage(A, 0, 0);
    const blobs = 9;
    const c = new Path2D();
    for (let i = 0; i < blobs; i++) {
      const bx = (0.15 + 0.7 * hash(i * 3.1)) * w;
      const by = (0.15 + 0.7 * hash(i * 5.7 + 1)) * h;
      const R = e * (0.18 + 0.22 * hash(i * 9.3)) * Math.hypot(w, h);
      if (R < 0.5) continue;
      const steps = 16;
      for (let s2 = 0; s2 <= steps; s2++) {
        const a = (s2 / steps) * Math.PI * 2;
        const rr = R * (0.75 + 0.45 * hash(i * 13 + s2));
        const x = bx + Math.cos(a) * rr, y = by + Math.sin(a) * rr;
        if (s2 === 0) c.moveTo(x, y); else c.lineTo(x, y);
      }
      c.closePath();
    }
    ctx.save();
    ctx.clip(c);
    ctx.drawImage(B, 0, 0);
    ctx.restore();
    const k = Math.sin(p * Math.PI);
    if (k > 0.03) {
      ctx.save();
      ctx.globalAlpha = k * 0.5;
      ctx.strokeStyle = 'rgba(22,22,32,0.9)';
      ctx.lineWidth = Math.max(1, Math.min(w, h) * 0.004);
      ctx.stroke(c);
      ctx.restore();
    }
  };

  FAMILY.waterripple = (ctx, A, B, w, h, p, scratch) => {
    if (endpoints(ctx, A, B, w, h, p)) return;
    const R = Math.hypot(w, h) * 0.95;
    const r = p * R;
    maskComposite(ctx, A, B, w, h, scratch, (m) => {
      const g = m.createRadialGradient(w / 2, h / 2, Math.max(0, r * 0.45), w / 2, h / 2, Math.max(1, r));
      for (let i = 0; i <= 12; i++) {
        const t = i / 12;
        const ripple = 0.5 + 0.5 * Math.sin(t * Math.PI * 7 - p * 12);
        const base = clamp(t * 1.25 - 0.15 + ripple * 0.28, 0, 1);
        const a = clamp(base + clamp((p - 0.75) / 0.25, 0, 1), 0, 1);
        g.addColorStop(t, 'rgba(0,0,0,' + a.toFixed(3) + ')');
      }
      m.fillStyle = g;
      m.fillRect(0, 0, w, h);
    });
  };

  FAMILY.neoncut = (ctx, A, B, w, h, p) => {
    if (endpoints(ctx, A, B, w, h, p)) return;
    const e = easeInOut(p);
    ctx.drawImage(A, 0, 0);
    ctx.save();
    ctx.beginPath(); ctx.rect(0, 0, w * e, h + 1); ctx.clip();
    ctx.drawImage(B, 0, 0);
    ctx.restore();
    const k = Math.sin(p * Math.PI);
    if (k <= 0.03) return;
    const x = w * e, bh = Math.max(4, w * 0.06);
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    const g = ctx.createLinearGradient(x - bh, 0, x + bh, 0);
    g.addColorStop(0, 'rgba(0,0,0,0)');
    g.addColorStop(0.5, 'rgba(255,110,235,' + (0.85 * k).toFixed(3) + ')');
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    ctx.fillRect(x - bh, 0, bh * 2, h);
    ctx.fillStyle = 'rgba(255,255,255,' + (0.9 * k).toFixed(3) + ')';
    ctx.fillRect(x - Math.max(1, w * 0.002), 0, Math.max(2, w * 0.004), h);
    ctx.restore();
  };

  FAMILY.sketchcut = (ctx, A, B, w, h, p) => {
    if (endpoints(ctx, A, B, w, h, p)) return;
    const k = Math.sin(p * Math.PI);
    ctx.drawImage(A, 0, 0);
    if (k > 0.03) {
      ctx.save();
      ctx.globalAlpha = k * 0.85;
      ctx.filter = 'grayscale(1) contrast(2.4) brightness(1.3)';
      ctx.drawImage(A, 0, 0);
      ctx.restore();
    }
    ctx.save();
    ctx.globalAlpha = clamp(p * 1.25, 0, 1);
    ctx.drawImage(B, 0, 0);
    ctx.restore();
    if (k <= 0.03) return;
    ctx.save();
    ctx.globalAlpha = k * 0.22;
    ctx.strokeStyle = 'rgba(28,28,38,0.9)';
    ctx.lineWidth = Math.max(1, Math.min(w, h) * 0.0016);
    const step = Math.max(6, Math.min(w, h) * 0.02);
    const off = w * (1 - easeInOut(p));
    for (let i = -h; i < w; i += step) {
      ctx.beginPath();
      ctx.moveTo(i + off, 0);
      ctx.lineTo(i + off + h, h);
      ctx.stroke();
    }
    ctx.restore();
  };

  FAMILY.fracturecut = (ctx, A, B, w, h, p) => {
    if (endpoints(ctx, A, B, w, h, p)) return;
    const e = easeInOut(p);
    const splits = 9, sh = h / splits;
    ctx.drawImage(A, 0, 0);
    for (let i = 0; i < splits; i++) {
      const t = clamp(e * (splits + 2) - i, 0, 1);
      if (t <= 0) continue;
      const dx = (hash(i * 4.1) - 0.5) * w * 0.12 * (1 - t);
      const dy = (hash(i * 7.7) - 0.5) * h * 0.06 * (1 - t);
      ctx.save();
      ctx.beginPath(); ctx.rect(0, i * sh, w, sh + 0.5); ctx.clip();
      ctx.globalAlpha = clamp(t, 0, 1);
      ctx.drawImage(B, dx, dy);
      ctx.restore();
    }
    const k = Math.sin(p * Math.PI);
    if (k <= 0.03) return;
    ctx.save();
    ctx.globalAlpha = k * 0.55;
    ctx.strokeStyle = 'rgba(255,255,255,0.85)';
    ctx.lineWidth = Math.max(1, Math.min(w, h) * 0.002);
    for (let i = 1; i < splits; i++) {
      const y = i * sh;
      ctx.beginPath();
      ctx.moveTo(0, y);
      for (let x = 0; x <= w; x += Math.max(8, w / 10)) {
        ctx.lineTo(x, y + (hash(x + i * 3) - 0.5) * sh * 0.5);
      }
      ctx.stroke();
    }
    ctx.restore();
  };

  FAMILY.lightleak = (ctx, A, B, w, h, p) => {
    if (endpoints(ctx, A, B, w, h, p)) return;
    const k = Math.sin(p * Math.PI);
    ctx.drawImage(A, 0, 0);
    ctx.save();
    ctx.globalAlpha = clamp(p * 1.15, 0, 1);
    ctx.drawImage(B, 0, 0);
    ctx.restore();
    if (k <= 0.03) return;
    const x = p * (w * 1.3) - w * 0.15;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    const g = ctx.createLinearGradient(x - w * 0.5, 0, x + w * 0.5, 0);
    g.addColorStop(0, 'rgba(0,0,0,0)');
    g.addColorStop(0.35, 'rgba(255,120,40,' + (0.3 * k).toFixed(3) + ')');
    g.addColorStop(0.5, 'rgba(255,210,150,' + (0.5 * k).toFixed(3) + ')');
    g.addColorStop(0.65, 'rgba(255,120,40,' + (0.3 * k).toFixed(3) + ')');
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
    ctx.restore();
  };

  FAMILY.filmstrip = (ctx, A, B, w, h, p) => {
    if (endpoints(ctx, A, B, w, h, p)) return;
    ctx.drawImage(A, 0, 0);
    const strips = 8, sw = w / strips;
    for (let i = 0; i < strips; i++) {
      const lag = 0.1 * hash(i * 4.3);
      const t = easeInOut(clamp((p - lag) / (1 - lag * 2), 0, 1));
      const off = (1 - t) * h * (i % 2 ? 1 : -1);
      ctx.save();
      ctx.beginPath(); ctx.rect(i * sw, 0, sw + 0.5, h); ctx.clip();
      ctx.drawImage(B, 0, off);
      ctx.restore();
    }
    const k = Math.sin(p * Math.PI);
    if (k <= 0.03) return;
    ctx.save();
    ctx.globalAlpha = k * 0.4;
    ctx.fillStyle = '#0b0b0f';
    const bw = Math.max(3, w * 0.008);
    for (let x = 0; x < w; x += Math.max(10, w * 0.03)) ctx.fillRect(x, 0, bw, h);
    ctx.restore();
  };

  FAMILY.glitchblinds = (ctx, A, B, w, h, p) => {
    if (endpoints(ctx, A, B, w, h, p)) return;
    ctx.drawImage(A, 0, 0);
    const e = easeInOut(p);
    const strips = 22, sh = h / strips;
    const seed = Math.floor(p * 20);
    for (let i = 0; i < strips; i++) {
      const s1 = hash(i * 3.7 + seed);
      const s2 = hash(i * 8.3 + seed * 2 + 5);
      const t = clamp((e - s1 * 0.35) / 0.65, 0, 1);
      if (t <= 0) continue;
      ctx.save();
      ctx.beginPath(); ctx.rect(0, i * sh, w, sh + 0.5); ctx.clip();
      ctx.globalAlpha = clamp(t, 0, 1);
      ctx.drawImage(B, (s2 - 0.5) * w * 0.3 * (1 - t), 0);
      ctx.restore();
    }
  };

  FAMILY.matrixrain = (ctx, A, B, w, h, p) => {
    if (endpoints(ctx, A, B, w, h, p)) return;
    const e = easeInOut(p);
    ctx.drawImage(A, 0, 0);
    const cols = 24, rows = 14;
    const cw = w / cols, ch = h / rows;
    const frontOf = (x) => {
      const delay = hash(x * 9.7) * 0.4;
      const t = clamp((e - delay) / (1 - delay), 0, 1);
      return t * (rows + 1);
    };
    for (let x = 0; x < cols; x++) {
      const front = frontOf(x);
      for (let y = 0; y < rows; y++) {
        if (y > front) continue;
        const local = clamp(front - y, 0, 1);
        ctx.save();
        ctx.globalAlpha = clamp(local * 1.6, 0, 1);
        ctx.drawImage(B, x * cw, y * ch, cw, ch, x * cw, y * ch, cw, ch);
        ctx.restore();
      }
    }
    const k = Math.sin(p * Math.PI);
    if (k <= 0.04) return;
    ctx.save();
    ctx.globalAlpha = k * 0.45;
    ctx.fillStyle = 'rgba(120,255,170,0.6)';
    for (let x = 0; x < cols; x++) {
      const y = Math.min(rows, frontOf(x)) * ch;
      ctx.fillRect(x * cw, Math.max(0, y - ch), cw, ch * 0.7);
    }
    ctx.restore();
  };

  FAMILY.mirrorwipe = (ctx, A, B, w, h, p) => {
    if (endpoints(ctx, A, B, w, h, p)) return;
    const keep = (w / 2) * (1 - easeInOut(p));
    const half = w / 2;
    ctx.drawImage(B, 0, 0);
    if (keep > 0.5) {
      ctx.save();
      ctx.beginPath(); ctx.rect(0, 0, keep, h + 1); ctx.clip();
      ctx.drawImage(A, 0, 0, half, h, 0, 0, half, h);
      ctx.restore();
      ctx.save();
      ctx.beginPath(); ctx.rect(w - keep, 0, keep, h + 1); ctx.clip();
      ctx.drawImage(A, half, 0, half, h, w - keep, 0, half, h);
      ctx.restore();
    }
  };

  FAMILY.heartbeat = (ctx, A, B, w, h, p) => {
    if (endpoints(ctx, A, B, w, h, p)) return;
    const e = easeInOut(p);
    const pulse = Math.abs(Math.sin(p * Math.PI * 2));
    /* B underneath at full size keeps the frame solid; the pulse rides on top. */
    ctx.save();
    const s2 = 1 + pulse * 0.03;
    ctx.translate(w / 2, h / 2);
    ctx.scale(s2, s2);
    ctx.drawImage(B, -w / 2, -h / 2);
    ctx.restore();
    ctx.save();
    ctx.globalAlpha = clamp(1 - e * 1.15, 0, 1);
    const s = 1 + pulse * 0.12;
    ctx.translate(w / 2, h / 2);
    ctx.scale(s, s);
    ctx.drawImage(A, -w / 2, -h / 2);
    ctx.restore();
  };

  /* ---- flashes ---- */
  FAMILY.flashcolor = (ctx, A, B, w, h, p) => {
    if (endpoints(ctx, A, B, w, h, p)) return;
    const k = Math.max(0, 1 - Math.abs(p - 0.5) * 2);
    ctx.drawImage(A, 0, 0);
    ctx.save();
    ctx.globalAlpha = clamp(p * 1.3, 0, 1);
    ctx.drawImage(B, 0, 0);
    ctx.restore();
    if (k <= 0.01) return;
    ctx.save();
    ctx.globalAlpha = k * 0.85;
    ctx.fillStyle = '#ff7a1a';
    ctx.fillRect(0, 0, w, h);
    ctx.restore();
  };

  FAMILY.flashstrobe = (ctx, A, B, w, h, p) => {
    if (endpoints(ctx, A, B, w, h, p)) return;
    ctx.drawImage(A, 0, 0);
    ctx.save();
    ctx.globalAlpha = clamp(p * 1.3, 0, 1);
    ctx.drawImage(B, 0, 0);
    ctx.restore();
    const s = Math.abs(Math.sin(p * Math.PI * 5));
    if (s * (1 - p) <= 0.01) return;
    ctx.save();
    ctx.globalAlpha = s * (1 - p) * 0.9;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, w, h);
    ctx.restore();
  };

  const labelOf = (type) => (TYPES.find(([k]) => k === type) || [type, type])[1];
  const groupOf = (type) => (TYPES.find(([k]) => k === type) || [type, type, 'Other'])[2];
  const descOf = (type) => (TYPES.find(([k]) => k === type) || [type, type, 'Other', ''])[3];
  const defaultType = 'dissolve';

  const easeInOut = (t) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);
  /* Deterministic 0..1 hash so previews never flicker between renders. */
  const hash = (n) => { const s = Math.sin(n * 127.1) * 43758.5453; return s - Math.floor(s); };

  /* ctx: target 2d context (project resolution).
     drawA(progress-independent full draw of outgoing clip), drawB(incoming).
     We composite so that p=0 shows A fully, p=1 shows B fully. */
  function draw(ctx, w, h, type, p, drawA, drawB, scratch) {
    p = clamp(p, 0, 1);
    const A = scratch.layerA, B = scratch.layerB;
    ensure(A, w, h); ensure(B, w, h);
    const actx = A.getContext('2d'), bctx = B.getContext('2d');
    actx.clearRect(0, 0, w, h); bctx.clearRect(0, 0, w, h);
    drawA(actx);
    drawB(bctx);

    ctx.save();
    ctx.clearRect(0, 0, w, h);

    /* Extended families dispatch here; anything not in the table falls through
       to the classic switch below. */
    const custom = FAMILY[type];
    if (custom) custom(ctx, A, B, w, h, p, scratch);
    else switch (type) {
      /* ---------------- dissolves ---------------- */
      case 'dissolve': {
        ctx.drawImage(A, 0, 0);
        ctx.globalAlpha = p;
        ctx.drawImage(B, 0, 0);
        break;
      }
      case 'blurdissolve': {
        /* An opaque cross-fade sits underneath, so the blur at its peak can
           never leave the frame semi-transparent. */
        coverageBackdrop(ctx, A, B, w, h, p);
        const k = Math.sin(p * Math.PI); // blur peaks mid-transition
        ctx.save();
        if (k > 0.01) ctx.filter = `blur(${(k * Math.min(w, h) * 0.01).toFixed(2)}px)`;
        if (p > 0.001) {
          ctx.globalAlpha = clamp(p * 1.3, 0, 1);
          ctx.drawImage(B, 0, 0);
        }
        if (p < 0.75) {
          ctx.globalAlpha = 1 - clamp(p * 1.33, 0, 1);
          ctx.drawImage(A, 0, 0);
        }
        ctx.restore();
        break;
      }
      case 'checker':
        maskComposite(ctx, A, B, w, h, scratch, (m) => {
          const cols = 16, rows = Math.max(1, Math.round((cols * h) / w));
          const cw = w / cols, ch = h / rows;
          m.fillStyle = '#000';
          for (let y = 0; y < rows; y++) {
            for (let x = 0; x < cols; x++) {
              if (hash(x * 91.7 + y * 17.3) <= p) m.fillRect(x * cw - 0.5, y * ch - 0.5, cw + 1, ch + 1);
            }
          }
        });
        break;
      case 'noisedissolve':
        maskComposite(ctx, A, B, w, h, scratch, (m) => {
          const cols = Math.max(12, Math.round(w / 12)), rows = Math.max(8, Math.round(h / 12));
          const cw = w / cols, ch = h / rows;
          m.fillStyle = '#000';
          for (let y = 0; y < rows; y++) {
            for (let x = 0; x < cols; x++) {
              if (hash(x * 3.13 + y * 7.77) <= p) m.fillRect(x * cw - 0.5, y * ch - 0.5, cw + 1, ch + 1);
            }
          }
        });
        break;

      /* ---------------- wipes ---------------- */
      case 'wipeleft': wipe(ctx, A, B, w, h, p, 'left'); break;
      case 'wiperight': wipe(ctx, A, B, w, h, p, 'right'); break;
      case 'wipeup': wipe(ctx, A, B, w, h, p, 'up'); break;
      case 'wipedown': wipe(ctx, A, B, w, h, p, 'down'); break;
      case 'featherwipe':
        maskComposite(ctx, A, B, w, h, scratch, (m) => {
          const fw = w * 0.28;
          const x0 = p * (w + fw) - fw;
          const g = m.createLinearGradient(x0, 0, x0 + fw, 0);
          g.addColorStop(0, 'rgba(0,0,0,1)');
          g.addColorStop(1, 'rgba(0,0,0,0)');
          m.fillStyle = g;
          m.fillRect(0, 0, w, h);
        });
        break;
      case 'lumawipe':
        maskComposite(ctx, A, B, w, h, scratch, (m) => {
          const span = Math.hypot(w, h);
          const x0 = p * (span * 1.35) - span * 0.35;
          const g = m.createLinearGradient(x0, x0 * 0.5, x0 + span * 0.35, x0 * 0.5 + span * 0.35);
          g.addColorStop(0, 'rgba(0,0,0,1)');
          g.addColorStop(0.45, 'rgba(0,0,0,1)');
          g.addColorStop(1, 'rgba(0,0,0,0)');
          m.fillStyle = g;
          m.fillRect(0, 0, w, h);
        });
        break;
      case 'circlewipe':
        radialClip(ctx, A, B, w, h, p, () => {
          const r = p * Math.hypot(w, h) * 0.62;
          const c = new Path2D();
          c.arc(w / 2, h / 2, r, 0, Math.PI * 2);
          return c;
        });
        break;
      case 'boxwipe':
        radialClip(ctx, A, B, w, h, p, () => {
          const bw = (p * w) / 2, bh = (p * h) / 2;
          const c = new Path2D();
          c.rect(w / 2 - bw, h / 2 - bh, bw * 2, bh * 2);
          return c;
        });
        break;
      case 'diamondwipe':
        radialClip(ctx, A, B, w, h, p, () => {
          const s = p * Math.max(w, h);
          const c = new Path2D();
          c.moveTo(w / 2, h / 2 - s);
          c.lineTo(w / 2 + s, h / 2);
          c.lineTo(w / 2, h / 2 + s);
          c.lineTo(w / 2 - s, h / 2);
          c.closePath();
          return c;
        });
        break;
      case 'starwipe':
        radialClip(ctx, A, B, w, h, p, () => {
          const R = p * Math.hypot(w, h);
          const c = new Path2D();
          for (let i = 0; i < 10; i++) {
            const a = -Math.PI / 2 + (i * Math.PI) / 5;
            const r = i % 2 ? R * 0.62 : R;
            const x = w / 2 + Math.cos(a) * r, y = h / 2 + Math.sin(a) * r;
            if (i === 0) c.moveTo(x, y); else c.lineTo(x, y);
          }
          c.closePath();
          return c;
        });
        break;
      case 'blinds':
        blinds(ctx, A, B, w, h, p);
        break;
      case 'ripplewipe':
        rippleWipe(ctx, A, B, w, h, p);
        break;
      case 'barnopen': barn(ctx, A, B, w, h, p, false); break;
      case 'barnClose': barn(ctx, A, B, w, h, p, true); break;

      /* ---------------- slide / cover / push ---------------- */
      case 'slideleft': cover(ctx, A, B, w, h, p, 'left'); break;
      case 'slideright': cover(ctx, A, B, w, h, p, 'right'); break;
      case 'slideup': cover(ctx, A, B, w, h, p, 'up'); break;
      case 'slidedown': cover(ctx, A, B, w, h, p, 'down'); break;
      case 'pushleft': push(ctx, A, B, w, h, p, 'left'); break;
      case 'pushright': push(ctx, A, B, w, h, p, 'right'); break;
      case 'pushup': push(ctx, A, B, w, h, p, 'up'); break;
      case 'pushdown': push(ctx, A, B, w, h, p, 'down'); break;
      case 'squeeze': squeeze(ctx, A, B, w, h, p); break;

      /* ---------------- zoom ---------------- */
      case 'zoomin': zoom(ctx, A, B, w, h, p, false); break;
      case 'zoomout': zoom(ctx, A, B, w, h, p, true); break;
      case 'crosszoom': crossZoom(ctx, A, B, w, h, p); break;

      /* ---------------- stylised ---------------- */
      case 'spin': spin(ctx, A, B, w, h, p); break;
      case 'pageturn': pageTurn(ctx, A, B, w, h, p); break;
      case 'burn': burn(ctx, A, B, w, h, p); break;
      case 'matrix': {
        // incoming revealed in a grid of cells that pop in pseudo-random order
        ctx.drawImage(A, 0, 0);
        const cols = 12, rows = Math.max(1, Math.round((cols * h) / w));
        const cw = w / cols, ch = h / rows;
        const cells = cols * rows;
        const shown = Math.floor(p * cells);
        ctx.save();
        for (let i = 0; i < cells; i++) {
          const order = (i * 2654435761) % cells; // deterministic shuffle
          if (order >= shown) continue;
          const cx = (i % cols) * cw, cy = Math.floor(i / cols) * ch;
          ctx.drawImage(B, cx, cy, cw, ch, cx, cy, cw, ch);
        }
        ctx.restore();
        if (p >= 1) { ctx.clearRect(0, 0, w, h); ctx.drawImage(B, 0, 0); }
        break;
      }
      case 'clock': {
        ctx.drawImage(A, 0, 0);
        ctx.save();
        ctx.beginPath();
        ctx.moveTo(w / 2, h / 2);
        ctx.arc(w / 2, h / 2, Math.hypot(w, h) / 2, -Math.PI / 2, -Math.PI / 2 + p * Math.PI * 2);
        ctx.closePath();
        ctx.clip();
        ctx.drawImage(B, 0, 0);
        ctx.restore();
        break;
      }

      /* ---------------- flashes ---------------- */
      case 'whiteflash':
      case 'blackflash': {
        const c = type === 'whiteflash' ? 255 : 0;
        ctx.drawImage(A, 0, 0);
        if (p < 0.5) {
          ctx.globalAlpha = p / 0.5;
          ctx.fillStyle = `rgb(${c},${c},${c})`;
          ctx.fillRect(0, 0, w, h);
          ctx.globalAlpha = 1;
        } else {
          ctx.globalAlpha = 1 - (p - 0.5) / 0.5;
          ctx.fillStyle = `rgb(${c},${c},${c})`;
          ctx.fillRect(0, 0, w, h);
          ctx.globalAlpha = 1;
          ctx.drawImage(B, 0, 0);
          if (p < 0.98) {
            ctx.globalAlpha = 1 - (p - 0.5) / 0.5;
            ctx.fillStyle = `rgb(${c},${c},${c})`;
            ctx.fillRect(0, 0, w, h);
            ctx.globalAlpha = 1;
          }
        }
        break;
      }
      /* ---------------- extended dissolve set ---------------- */
      case 'hexdissolve':
        maskComposite(ctx, A, B, w, h, scratch, (m) => {
          m.fillStyle = '#000';
          const r = Math.max(5, Math.min(w, h) / 24);
          const dx = r * 1.5, dy = r * Math.sqrt(3);
          for (let ci = 0, x = -dx; x <= w + dx; ci++, x += dx) {
            const off = ci % 2 ? dy / 2 : 0;
            for (let ri = 0, y = -dy; y <= h + dy; ri++, y += dy) {
              if (hash(ci * 3.13 + ri * 7.77) <= p) { hexPath(m, x, y + off, r * 1.04); m.fill(); }
            }
          }
        });
        break;
      case 'blockdissolve':
        maskComposite(ctx, A, B, w, h, scratch, (m) => {
          m.fillStyle = '#000';
          const cell = Math.max(26, Math.min(w, h) / 8);
          const cols = Math.max(2, Math.ceil(w / cell)), rows = Math.max(2, Math.ceil(h / cell));
          const cw = w / cols, ch = h / rows, total = cols * rows;
          const shown = p * total;
          for (let i = 0; i < total; i++) {
            if ((i * 2654435761) % total >= shown) continue;
            m.fillRect((i % cols) * cw - 0.5, Math.floor(i / cols) * ch - 0.5, cw + 1, ch + 1);
          }
        });
        break;
      case 'additivedissolve': {
        ctx.globalCompositeOperation = 'lighter';
        ctx.globalAlpha = 1 - p;
        ctx.drawImage(A, 0, 0);
        ctx.globalAlpha = p;
        ctx.drawImage(B, 0, 0);
        ctx.globalAlpha = 1;
        ctx.globalCompositeOperation = 'source-over';
        break;
      }
      case 'multiplydissolve': {
        ctx.drawImage(A, 0, 0);
        const k = Math.sin(p * Math.PI);
        if (k > 0.01) {
          ctx.save();
          ctx.globalCompositeOperation = 'multiply';
          ctx.globalAlpha = k * 0.9;
          ctx.drawImage(B, 0, 0);
          ctx.restore();
        }
        ctx.globalAlpha = p;
        ctx.drawImage(B, 0, 0);
        ctx.globalAlpha = 1;
        ctx.globalCompositeOperation = 'source-over';
        break;
      }

      /* ---------------- extended wipe set ---------------- */
      case 'diagonaldown':
      case 'diagonalup': {
        ctx.drawImage(A, 0, 0);
        const span = w + h;
        const d = p * (span * 1.1) - span * 0.05;
        ctx.save();
        ctx.beginPath();
        if (type === 'diagonaldown') {
          ctx.moveTo(-1, -1);
          ctx.lineTo(Math.min(w + 1, d), -1);
          ctx.lineTo(Math.max(-1, d - h), h + 1);
          ctx.lineTo(-1, h + 1);
        } else {
          ctx.moveTo(-1, h + 1);
          ctx.lineTo(Math.min(w + 1, d), h + 1);
          ctx.lineTo(Math.max(-1, d - h), -1);
          ctx.lineTo(-1, -1);
        }
        ctx.closePath();
        ctx.clip();
        ctx.drawImage(B, 0, 0);
        ctx.restore();
        break;
      }
      case 'curtain': {
        ctx.drawImage(A, 0, 0);
        const bands = 16, bw = w / bands;
        const open = (h / 2) * easeInOut(p);
        ctx.save();
        ctx.beginPath();
        for (let i = 0; i < bands; i++) {
          ctx.rect(i * bw, 0, bw, open);
          ctx.rect(i * bw, h - open, bw, open);
        }
        ctx.clip();
        ctx.drawImage(B, 0, 0);
        ctx.restore();
        break;
      }
      case 'pinwheel':
        radialClip(ctx, A, B, w, h, p, () => {
          const arms = 6, k = easeInOut(p);
          const R = Math.hypot(w, h) * 0.62;
          const c = new Path2D();
          for (let i = 0; i < arms * 2; i++) {
            const a0 = (Math.PI / arms) * i;
            const sweep = k * (Math.PI / arms);
            c.moveTo(w / 2, h / 2);
            c.lineTo(w / 2 + Math.cos(a0) * R, h / 2 + Math.sin(a0) * R);
            c.lineTo(w / 2 + Math.cos(a0 + sweep) * R, h / 2 + Math.sin(a0 + sweep) * R);
            c.closePath();
          }
          return c;
        });
        break;
      case 'zipperwipe': {
        ctx.drawImage(A, 0, 0);
        const teeth = 12, th = h / teeth;
        const amp = Math.min(w * 0.06, 48);
        const base = p * (w + amp) - amp;
        ctx.save();
        ctx.beginPath();
        ctx.moveTo(-1, -1);
        for (let i = 0; i <= teeth; i++) ctx.lineTo(base + (i % 2 ? amp : 0), i * th);
        ctx.lineTo(-1, h + 1);
        ctx.closePath();
        ctx.clip();
        ctx.drawImage(B, 0, 0);
        ctx.restore();
        break;
      }
      case 'puzzlewipe': {
        ctx.drawImage(A, 0, 0);
        const cols = 6, rows = Math.max(2, Math.round((cols * h) / w));
        const cw = w / cols, ch = h / rows;
        const maxD = (cols - 1) + (rows - 1);
        for (let y = 0; y < rows; y++) {
          for (let x = 0; x < cols; x++) {
            const local = clamp(p * (maxD + 1.4) - (x + y), 0, 1);
            if (local <= 0) continue;
            const s = 0.8 + 0.2 * easeInOut(local);
            const tw = cw * s, th2 = ch * s;
            ctx.save();
            ctx.globalAlpha = Math.min(1, local * 1.7);
            ctx.drawImage(B, x * cw, y * ch, cw, ch, x * cw + (cw - tw) / 2, y * ch + (ch - th2) / 2, tw, th2);
            ctx.restore();
          }
        }
        break;
      }
      case 'sweepwipe':
        radialClip(ctx, A, B, w, h, p, () => {
          const R = Math.hypot(w, h) * 1.25;
          const c = new Path2D();
          c.moveTo(0, 0);
          c.arc(0, 0, R, 0, (Math.PI / 2) * easeInOut(p));
          c.closePath();
          return c;
        });
        break;

      /* ---------------- extended slide set ---------------- */
      case 'fliphorizontal':
      case 'flipvertical': {
        const e = easeInOut(p);
        const s = Math.max(0.001, p < 0.5 ? 1 - e * 2 : e * 2 - 1);
        /* A cross-fade behind the card: as the card turns edge-on the frame
           stays opaque instead of fading to nothing at the midpoint. */
        coverageBackdrop(ctx, A, B, w, h, p);
        ctx.save();
        ctx.translate(w / 2, h / 2);
        if (type === 'fliphorizontal') ctx.scale(s, 1); else ctx.scale(1, s);
        ctx.drawImage(p < 0.5 ? A : B, -w / 2, -h / 2);
        ctx.restore();
        const shade = (1 - s) * 0.6;
        if (shade > 0.01) {
          ctx.save();
          ctx.globalAlpha = shade;
          ctx.fillStyle = '#000';
          ctx.fillRect(0, 0, w, h);
          ctx.restore();
        }
        break;
      }
      case 'swing': {
        const e = easeInOut(p);
        ctx.drawImage(A, 0, 0);
        ctx.save();
        ctx.translate(0, h / 2);
        ctx.transform(Math.max(0.001, e), 0, -0.22 * (1 - e), 1, 0, 0);
        ctx.globalAlpha = clamp(p * 1.4, 0, 1);
        ctx.drawImage(B, 0, -h / 2);
        ctx.restore();
        const shade = Math.sin(p * Math.PI) * 0.7;
        if (shade > 0.01) {
          ctx.save();
          ctx.globalAlpha = shade;
          const g = ctx.createLinearGradient(0, 0, w * 0.38, 0);
          g.addColorStop(0, 'rgba(0,0,0,0.85)');
          g.addColorStop(1, 'rgba(0,0,0,0)');
          ctx.fillStyle = g;
          ctx.fillRect(0, 0, w, h);
          ctx.restore();
        }
        break;
      }
      case 'whippan': {
        const e = easeInOut(p);
        const blur = Math.sin(p * Math.PI) * Math.min(w, h) * 0.05;
        /* Opaque cross-fade under the smear: the blurred edges of the two
           sliding copies would otherwise leave a transparent seam where they meet. */
        coverageBackdrop(ctx, A, B, w, h, p);
        ctx.save();
        if (blur > 0.2) ctx.filter = `blur(${blur.toFixed(2)}px)`;
        ctx.drawImage(A, -w * e, 0);
        ctx.drawImage(B, w * (1 - e), 0);
        ctx.restore();
        break;
      }

      /* ---------------- extended zoom set ---------------- */
      case 'zoomtwist': {
        const e = easeInOut(p);
        /* Backing cross-fade first: the two counter-rotating copies are both
           partially transparent at the midpoint. */
        coverageBackdrop(ctx, A, B, w, h, p);
        ctx.save();
        ctx.translate(w / 2, h / 2);
        ctx.rotate(e * Math.PI * 0.3);
        const sa = 1 + 0.8 * e;
        ctx.scale(sa, sa);
        ctx.globalAlpha = clamp(1 - p * 1.15, 0, 1);
        ctx.drawImage(A, -w / 2, -h / 2);
        ctx.restore();
        ctx.save();
        ctx.translate(w / 2, h / 2);
        ctx.rotate((e - 1) * Math.PI * 0.3);
        const sb = 0.55 + 0.45 * e;
        ctx.scale(sb, sb);
        ctx.globalAlpha = clamp(p * 1.15, 0, 1);
        ctx.drawImage(B, -w / 2, -h / 2);
        ctx.restore();
        break;
      }
      case 'radialbloom': {
        ctx.drawImage(A, 0, 0);
        const k = Math.sin(p * Math.PI);
        if (k > 0.01) {
          const steps = 8;
          ctx.save();
          ctx.globalCompositeOperation = 'lighter';
          for (let i = 1; i <= steps; i++) {
            const s = 1 + (i / steps) * 0.22 * k;
            ctx.globalAlpha = (k * 0.85) / steps;
            ctx.save();
            ctx.translate(w / 2, h / 2);
            ctx.scale(s, s);
            ctx.drawImage(A, -w / 2, -h / 2);
            ctx.restore();
          }
          ctx.restore();
        }
        ctx.save();
        ctx.globalAlpha = clamp(p * 1.25, 0, 1);
        ctx.translate(w / 2, h / 2);
        const sb = 0.82 + 0.18 * easeInOut(p);
        ctx.scale(sb, sb);
        ctx.drawImage(B, -w / 2, -h / 2);
        ctx.restore();
        break;
      }

      /* ---------------- extended stylised set ---------------- */
      case 'glass': {
        const e = easeInOut(p);
        const shards = 16;
        ctx.drawImage(A, 0, 0);
        for (let i = 0; i < shards; i++) {
          const cx = hash(i * 3.1 + 0.4) * w, cy = hash(i * 5.7 + 1.3) * h;
          const r = (0.13 + hash(i * 9.4) * 0.17) * Math.min(w, h);
          const rot = hash(i * 2.2 + 0.7) * Math.PI * 2;
          const drift = e * r * 1.5;
          const path = new Path2D();
          const sides = 5;
          for (let k2 = 0; k2 < sides; k2++) {
            const a = (Math.PI * 2 * k2) / sides + hash(i * 11 + k2) * 0.6;
            const rr = r * (0.6 + hash(i * 7 + k2 * 3) * 0.85);
            const x = cx + Math.cos(a) * rr, y = cy + Math.sin(a) * rr;
            if (k2 === 0) path.moveTo(x, y); else path.lineTo(x, y);
          }
          path.closePath();
          ctx.save();
          ctx.clip(path);
          ctx.globalAlpha = clamp(p * 4, 0, 1);
          ctx.drawImage(B, Math.cos(rot) * drift, Math.sin(rot) * drift);
          ctx.restore();
          ctx.save();
          ctx.globalAlpha = Math.sin(p * Math.PI) * 0.5;
          ctx.strokeStyle = 'rgba(255,255,255,0.85)';
          ctx.lineWidth = 1.5;
          ctx.stroke(path);
          ctx.restore();
        }
        if (p > 0.85) {
          ctx.save();
          ctx.globalAlpha = clamp((p - 0.85) / 0.15, 0, 1);
          ctx.drawImage(B, 0, 0);
          ctx.restore();
        }
        break;
      }
      case 'stripslide': {
        ctx.drawImage(A, 0, 0);
        const strips = 10, sh = h / strips;
        for (let i = 0; i < strips; i++) {
          const lag = 0.06 * hash(i * 4.3);
          const t = easeInOut(clamp((p - lag) / (1 - lag * 2), 0, 1));
          const off = (i % 2 ? 1 : -1) * (1 - t) * w;
          ctx.save();
          ctx.beginPath();
          ctx.rect(0, i * sh, w, sh + 1);
          ctx.clip();
          ctx.drawImage(B, off, 0);
          ctx.restore();
        }
        break;
      }
      case 'glitchcut': {
        const k = Math.sin(p * Math.PI);
        ctx.globalAlpha = clamp(1 - p * 1.12, 0, 1);
        ctx.drawImage(A, 0, 0);
        ctx.globalAlpha = clamp(p * 1.15 - 0.12, 0, 1);
        ctx.drawImage(B, 0, 0);
        ctx.globalAlpha = 1;
        if (k > 0.02) {
          const split = k * Math.min(w, h) * 0.022;
          ctx.save();
          ctx.globalCompositeOperation = 'lighter';
          ctx.globalAlpha = k * 0.45;
          ctx.drawImage(B, -split, 0, w, h);
          ctx.globalAlpha = k * 0.3;
          ctx.drawImage(B, split, 0, w, h);
          ctx.restore();
          const strips = 12, sh = h / strips;
          const seed = Math.floor(p * 18);
          for (let i = 0; i < strips; i++) {
            const s1 = hash(i * 3.7 + seed), s2 = hash(i * 8.1 + seed + 5);
            ctx.save();
            ctx.beginPath();
            ctx.rect(0, i * sh, w, sh + 1);
            ctx.clip();
            ctx.globalAlpha = clamp(k * 1.2, 0, 1) * 0.8;
            ctx.drawImage(s2 > 0.5 ? B : A, (s1 - 0.5) * w * 0.25 * k, 0);
            ctx.restore();
          }
        }
        if (p >= 1) { ctx.clearRect(0, 0, w, h); ctx.drawImage(B, 0, 0); }
        break;
      }
      default: {
        ctx.drawImage(A, 0, 0);
        ctx.globalAlpha = p;
        ctx.drawImage(B, 0, 0);
      }
    }
    ctx.restore();
  }

  /* ================= primitives ================= */

  /* Hard-edge straight wipe. */
  function wipe(ctx, A, B, w, h, p, dir) {
    ctx.drawImage(A, 0, 0);
    ctx.save();
    ctx.beginPath();
    if (dir === 'left') ctx.rect(w * p - w, 0, w, h);
    else if (dir === 'right') ctx.rect(0, 0, w * p, h);
    else if (dir === 'up') ctx.rect(0, h * p - h, w, h);
    else ctx.rect(0, 0, w, h * p);
    ctx.clip();
    ctx.drawImage(B, 0, 0);
    ctx.restore();
  }

  /* Cover: the incoming clip travels over a stationary outgoing clip. */
  function cover(ctx, A, B, w, h, p, dir) {
    const e = easeInOut(p);
    ctx.drawImage(A, 0, 0);
    ctx.save();
    if (dir === 'left') ctx.drawImage(B, w * (1 - e), 0);
    else if (dir === 'right') ctx.drawImage(B, -w * (1 - e), 0);
    else if (dir === 'up') ctx.drawImage(B, 0, h * (1 - e));
    else ctx.drawImage(B, 0, -h * (1 - e));
    ctx.restore();
  }

  /* Push: both clips travel together so the frame never goes empty. */
  function push(ctx, A, B, w, h, p, dir) {
    const e = easeInOut(p);
    ctx.save();
    if (dir === 'left') { ctx.drawImage(A, -w * e, 0); ctx.drawImage(B, w * (1 - e), 0); }
    else if (dir === 'right') { ctx.drawImage(A, w * e, 0); ctx.drawImage(B, -w * (1 - e), 0); }
    else if (dir === 'up') { ctx.drawImage(A, 0, -h * e); ctx.drawImage(B, 0, h * (1 - e)); }
    else { ctx.drawImage(A, 0, h * e); ctx.drawImage(B, 0, -h * (1 - e)); }
    ctx.restore();
  }

  /* Squeeze: the outgoing clip compresses toward one edge while the incoming
     one stretches back out to fill the frame. */
  function squeeze(ctx, A, B, w, h, p) {
    const e = easeInOut(p);
    const aw = Math.max(0, w * (1 - e));
    const bw = Math.max(0, w * e);
    ctx.save();
    if (aw > 0.5) ctx.drawImage(A, 0, 0, aw, h, 0, 0, aw, h);
    if (bw > 0.5) ctx.drawImage(B, w - bw, 0, bw, h, w - bw, 0, bw, h);
    ctx.restore();
  }

  /* Barn doors: a centre band opens outward to reveal the next clip. The
     "open" variant parts horizontally, the "close" variant vertically. */
  function barn(ctx, A, B, w, h, p, close) {
    const e = easeInOut(p);
    ctx.drawImage(A, 0, 0);
    ctx.save();
    ctx.beginPath();
    if (close) {
      const half = (h / 2) * e;
      ctx.rect(0, h / 2 - half, w, half * 2);
    } else {
      const half = (w / 2) * e;
      ctx.rect(w / 2 - half, 0, half * 2, h);
    }
    ctx.clip();
    ctx.drawImage(B, 0, 0);
    ctx.restore();
  }

  /* Venetian blinds: N slats widen together. */
  function blinds(ctx, A, B, w, h, p) {
    ctx.drawImage(A, 0, 0);
    ctx.save();
    ctx.beginPath();
    const count = 14;
    const bh = h / count;
    for (let i = 0; i < count; i++) ctx.rect(0, i * bh, w, bh * p);
    ctx.clip();
    ctx.drawImage(B, 0, 0);
    ctx.restore();
  }

  /* Ripple wipe: the boundary is a travelling sine wave. */
  function rippleWipe(ctx, A, B, w, h, p) {
    ctx.drawImage(A, 0, 0);
    ctx.save();
    ctx.beginPath();
    const amp = Math.min(w, h) * 0.07;
    const edge = p * (w + amp * 2) - amp;
    ctx.moveTo(0, 0);
    ctx.lineTo(edge, 0);
    for (let y = 0; y <= h; y += Math.max(2, h / 40)) {
      ctx.lineTo(edge + Math.sin((y / h) * Math.PI * 5 + p * 6) * amp, y);
    }
    ctx.lineTo(0, h);
    ctx.closePath();
    ctx.clip();
    ctx.drawImage(B, 0, 0);
    ctx.restore();
  }

  /* Regular hexagon sub-path on a flat-top lattice. */
  function hexPath(m, cx, cy, r) {
    m.beginPath();
    for (let i = 0; i < 6; i++) {
      const a = (Math.PI / 3) * i;
      const x = cx + Math.cos(a) * r, y = cy + Math.sin(a) * r;
      if (i === 0) m.moveTo(x, y); else m.lineTo(x, y);
    }
    m.closePath();
  }

  /* A shape that grows from the centre and clips the incoming clip. */
  function radialClip(ctx, A, B, w, h, p, pathFn) {
    ctx.drawImage(A, 0, 0);
    if (p <= 0) return;
    ctx.save();
    ctx.clip(pathFn());
    ctx.drawImage(B, 0, 0);
    ctx.restore();
  }

  /* Zoom: the incoming clip scales up (or settles down) over the outgoing one. */
  function zoom(ctx, A, B, w, h, p, out) {
    const e = easeInOut(p);
    ctx.drawImage(A, 0, 0);
    ctx.save();
    ctx.globalAlpha = clamp(p * 1.15, 0, 1);
    const s = out ? 1.55 - 0.55 * e : 0.55 + 0.45 * e;
    ctx.translate(w / 2, h / 2);
    ctx.scale(s, s);
    ctx.drawImage(B, -w / 2, -h / 2);
    ctx.restore();
  }

  /* Cross zoom: A pushes in and blurs out while B settles in from overscan. */
  function crossZoom(ctx, A, B, w, h, p) {
    const k = Math.sin(p * Math.PI);
    ctx.save();
    if (k > 0.01) ctx.filter = `blur(${(k * Math.min(w, h) * 0.02).toFixed(2)}px)`;
    const sa = 1 + 0.28 * p;
    ctx.translate(w / 2, h / 2);
    ctx.scale(sa, sa);
    ctx.drawImage(A, -w / 2, -h / 2);
    ctx.restore();

    ctx.save();
    const sb = 1.38 - 0.38 * easeInOut(p);
    ctx.globalAlpha = clamp(p * 1.3 - 0.12, 0, 1);
    ctx.translate(w / 2, h / 2);
    ctx.scale(sb, sb);
    ctx.drawImage(B, -w / 2, -h / 2);
    ctx.restore();
  }

  /* Spin: the incoming clip rotates and scales into place. */
  function spin(ctx, A, B, w, h, p) {
    const e = easeInOut(p);
    ctx.drawImage(A, 0, 0);
    ctx.save();
    ctx.globalAlpha = clamp(p * 1.25, 0, 1);
    ctx.translate(w / 2, h / 2);
    ctx.rotate((1 - e) * Math.PI * 0.75);
    const s = 0.3 + 0.7 * e;
    ctx.scale(s, s);
    ctx.drawImage(B, -w / 2, -h / 2);
    ctx.restore();
  }

  /* Page turn: a slanted fold sweeps across with a shaded crease. The crease
     flattens as the page comes down so the incoming clip ends up edge to edge. */
  function pageTurn(ctx, A, B, w, h, p) {
    const e = easeInOut(p);
    const skew = h * 0.35 * (1 - e);
    /* Start the sheet fully off-frame: the slanted leading edge must sit at or
       beyond the right edge until the turn begins. */
    const x = w + skew - (w + 2 * skew) * e;
    ctx.drawImage(A, 0, 0);
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(w + 1, -1);
    ctx.lineTo(x + skew, -1);
    ctx.lineTo(x - skew, h + 1);
    ctx.lineTo(w + 1, h + 1);
    ctx.closePath();
    ctx.clip();
    ctx.drawImage(B, 0, 0);
    ctx.restore();
    // crease shadow, strongest mid-turn
    const shade = Math.sin(p * Math.PI) * 0.7;
    if (shade > 0.01) {
      ctx.save();
      ctx.globalAlpha = shade;
      ctx.fillStyle = 'rgba(0,0,0,0.55)';
      ctx.beginPath();
      ctx.moveTo(x + skew, 0);
      ctx.lineTo(x - skew, h);
      ctx.lineTo(x - skew + Math.max(10, w * 0.03), h);
      ctx.lineTo(x + skew + Math.max(10, w * 0.03), 0);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    }
  }

  /* Film burn: an irregular hot-edged hole eats through the outgoing clip. */
  function burn(ctx, A, B, w, h, p) {
    const cx = w / 2, cy = h / 2;
    const r = p * Math.hypot(w, h) * 0.62;
    ctx.drawImage(A, 0, 0);
    if (r > 0.5) {
      ctx.save();
      ctx.beginPath();
      const steps = 28;
      for (let i = 0; i <= steps; i++) {
        const a = (i / steps) * Math.PI * 2;
        const rr = r * (0.8 + 0.34 * hash(i));
        const x = cx + Math.cos(a) * rr, y = cy + Math.sin(a) * rr;
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.closePath();
      ctx.clip();
      ctx.drawImage(B, 0, 0);
      ctx.restore();
    }
    // hot rim, strongest at the mid point
    const heat = (1 - Math.abs(p - 0.5) * 2) * 0.7;
    if (heat > 0.01 && r > 1) {
      ctx.save();
      ctx.globalAlpha = heat;
      const g = ctx.createRadialGradient(cx, cy, r * 0.82, cx, cy, r * 1.18);
      g.addColorStop(0, 'rgba(255,190,80,0)');
      g.addColorStop(0.55, 'rgba(255,140,40,0.9)');
      g.addColorStop(1, 'rgba(110,35,0,0)');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, w, h);
      ctx.restore();
    }
  }

  /* Mask composite: paint the incoming clip into a scratch layer, punch an
     alpha mask into it, then lay it over the outgoing clip. Used by every
     transition whose reveal is driven by an alpha ramp rather than a clip path. */
  function maskComposite(ctx, A, B, w, h, scratch, paintMask) {
    /* The mask is painted with plain source-over fills into its own canvas.
       (Painting several disjoint shapes straight into a 'destination-in'
       composite would erase all but the last shape: each fill re-applies the
       composite across the whole canvas.) */
    const mask = scratch.mask;
    ensure(mask, w, h);
    const m = mask.getContext('2d');
    m.setTransform(1, 0, 0, 1, 0, 0);
    m.globalCompositeOperation = 'source-over';
    m.clearRect(0, 0, w, h);
    m.fillStyle = '#000';
    paintMask(m);

    /* Punch that mask into a copy of the incoming clip with a single pass. */
    const cut = scratch.cut || (scratch.cut = document.createElement('canvas'));
    ensure(cut, w, h);
    const cctx = cut.getContext('2d');
    cctx.setTransform(1, 0, 0, 1, 0, 0);
    cctx.globalCompositeOperation = 'source-over';
    cctx.clearRect(0, 0, w, h);
    cctx.drawImage(B, 0, 0);
    cctx.globalCompositeOperation = 'destination-in';
    cctx.drawImage(mask, 0, 0);
    cctx.globalCompositeOperation = 'source-over';

    ctx.drawImage(A, 0, 0);
    ctx.drawImage(cut, 0, 0);
  }

  function makeScratch() {
    return {
      layerA: document.createElement('canvas'),
      layerB: document.createElement('canvas'),
      mask: document.createElement('canvas'),
    };
  }
  function ensure(c, w, h) { if (c.width !== w || c.height !== h) { c.width = w; c.height = h; } }

  OS.transitions = { TYPES, labelOf, groupOf, descOf, defaultType, draw, makeScratch };
})();
