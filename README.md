# OpenScene

**A free, open-source, professional non-linear video editor for Windows.**

[![Licence: AGPL-3.0](https://img.shields.io/badge/licence-AGPL--3.0-blue)](LICENSE)
[![Platform: Windows](https://img.shields.io/badge/platform-Windows%2010%2F11-0078d4)](#get-it)
[![Runtime dependencies: 0](https://img.shields.io/badge/runtime%20dependencies-0-brightgreen)](#architecture)
[![Self-test: 81 passing](https://img.shields.io/badge/self--test-81%20passing-brightgreen)](#self-test)
[![Download](https://img.shields.io/badge/download-installer-2ea44f)](https://github.com/sparshsinghal1618/OpenScene/releases/latest/download/OpenScene-Setup.exe)

OpenScene is a complete editor: a multi-track timeline, a real compositor, **164
transitions**, **136 effects**, keyframing, titling, a mastering audio bus and a
frame-exact H.264/AAC exporter. Everything runs on your own machine — no cloud, no
accounts, no telemetry, no runtime dependencies.

Built with **zero third-party runtime libraries**. The timeline, the compositor, the
effects, the transitions, the titler, the audio engine, the MP4 (ISO-BMFF) muxer and the
entire interface are written from scratch and run directly on the web engine that already
ships with the operating system.

> **Android, iOS and the web app are coming soon.** This repository is the Windows editor.

<p align="center">
  <img src="icons/icon-192.png" width="128" alt="OpenScene logo">
</p>

**[Download the installer](https://github.com/sparshsinghal1618/OpenScene/releases/latest/download/OpenScene-Setup.exe)**
· **[Project website](https://sparshsinghal1618.github.io/OpenScene/)** (source in [`docs/`](docs/))

---

## Screenshots

Screenshots live in [`docs/shots/`](docs/shots/). Generate them from the running
app with:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\tools\CaptureScreenshots.ps1
```

The script drives a headless Chrome or Edge, so nothing needs installing beyond a
browser and Python. It captures the default view; open the editor and grab the
rest by hand if you want per-panel shots.

---

## Get it

### Windows (the real desktop app)

The fastest route is the single-file installer from the releases page:

**[OpenScene-Setup.exe](https://github.com/sparshsinghal1618/OpenScene/releases/latest/download/OpenScene-Setup.exe)** - one file, about 0.6 MB.

Or build it yourself. Double-click the build script, or run the two steps by hand:

```bat
Build-Installer.bat
```

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\Build-WindowsApp.ps1 -Clean
& "C:\Program Files (x86)\NSIS\makensis.exe" .\tools\OpenScene.nsi
```

This produces a genuine native Windows executable — no Node, no Electron, no runtime to
install:

| Path | What it is |
| --- | --- |
| `Dist\OpenScene\OpenScene.exe` | The editor (WebView2 host, ~73 KB) |
| `Dist\OpenScene-Setup.exe` | Single-file NSIS installer — Start-menu and desktop shortcuts, uninstaller |
| `Dist\OpenScene-portable.zip` | The same app as a portable folder; unzip and run |

Requires Windows 10/11 with the WebView2 runtime (present on every up-to-date machine).
NSIS is only needed for the installer — without it the app itself still builds.

### Browser / installable PWA

`index.html` runs straight from disk or from any static host. Served over `http(s)` it
also installs as a PWA (manifest, icons and a service worker are included), with
`localStorage` autosave and IndexedDB media storage.

```powershell
python -m http.server 8080        # then open http://127.0.0.1:8080/
```

### Verify it

```powershell
Dist\OpenScene\OpenScene.exe --selftest --out=selftest.json
```

Or from inside the app: **Help ▸ Run self-test**.

---

## Feature tour

### Editing
- **Multi-track timeline** (any number of video and audio tracks) drawn on a virtualised
  canvas — only the visible window is painted, so huge projects stay smooth.
- **Separate video and audio tracks.** Drop an audio file onto an audio track
  (`Ctrl+Shift+A` adds one), or right-click a clip and *Detach audio* to slide its sound
  onto its own track, exactly as OpenShot users expect.
- Drag to move, drag the edges to trim, drag with **Alt** to duplicate, drag with **Ctrl**
  to insert-ripple; snapping with a live snap line and magnet zones.
- **Roll**, **slip** and **slide** edits, plus ripple-delete, lift, split, freeze frame,
  reverse and per-clip speed.
- **JKL** shuttle, frame stepping, edit-point jumping, in/out work area, markers.
- **Clip grouping** — group clips so they move, trim and delete together.
- Full undo/redo across every edit: the whole stack is a command list, and even a
  multi-clip gesture commits as a single undo step.
- Track header controls: mute, solo, lock, hide, height, delete.

### Compositing
- A real compositor renders any project frame at full project resolution — the same code
  path powers the preview, the still export and the movie export, so **what you see is
  what you get**.
- **17 blend modes** per clip (Multiply, Screen, Overlay, Color Dodge/Burn,
  Hard/Soft Light, Difference, Exclusion, Add, Hue, Saturation, Color, Luminosity…).
- **Adjustment layers** that grade every track beneath them, instead of one clip at a
  time.
- Per-clip **transform** (position, scale, rotation), opacity, crop, speed and volume.
- **Keyframes** on any numeric parameter, edited from the inspector with diamonds that
  follow the playhead.

### Effects — 123 video, 13 audio
Grouped in the library, each with its own controls, each keyframeable:

| Group | What you get |
| --- | --- |
| **Color & Tone** (34) | Brightness, Contrast, Saturation, Vibrance, Hue Rotate, Colour Temperature, White Balance, Levels, Auto Levels, Curves, Gamma, Exposure, Black & White, Sepia, Invert, Duotone, Colour Grade, Colour Balance, Channel Mixer, Colourise, Gradient Map, Selective Colour, Bleach Bypass, Split Toning, Infrared, plus **nine film-look presets** — Technicolor, Cross Process, Lomo, Kodachrome, Polaroid, Vaporwave, Cyberpunk, Film Noir, Green Teal |
| **Blur & Sharpen** (12) | Blur, Box Blur, Zoom Blur, Motion Blur, Directional Blur, Radial Blur, Sharpen, Unsharp Mask, High Pass, Clarity, Soft Focus, Noise Reduction |
| **Stylize** (33) | Emboss, Edge Detect, Threshold, Posterize, Solarize, Mosaic, Halftone, Ordered Dither, Oil Paint, Pencil Sketch, Crosshatch, Cartoon, Watercolour, Newsprint, Blueprint, Night Vision, Dot Matrix, Palette, CRT Screen, Halation, Glow, Film Grain, Scan Lines, VHS, Old Film, Light Leak, Glitch, Neon Glow, Comic Book, Thermal Camera, X-Ray, Stained Glass, Vignette |
| **Distort** (18) | Mirror, Wave, Swirl, Bulge / Pinch, Ripple, Chromatic Aberration, Kaleidoscope, Extrude, Skew, Tile Grid, Stretch, Barrel / Pincushion, Sphere, Perspective, Vortex, Polar Coordinates, Noise Displace, Fracture |
| **Keying** (4) | Colour Key, Chroma Key (Green Screen), Luma Key, Spill Suppression |
| **Render** (22) | Letterbox, Fade In / Out, Border, Drop Shadow, Blurred Background, Picture in Picture, Lens Flare, Timecode Burn-in, Bokeh Lights, Solid Colour, Gradient Overlay, Grid Overlay, Safe Area, Light Rays, Star Filter, Rain, Snow, Dust Motes, Fire, Clouds, Smoke, Sparkle |
| **Audio** (13) | Volume, Audio Boost / Cut, Audio Fade, Volume Ramp, Swell, Tremolo, Stereo Pan, Stutter Gate, Pumping Duck, Level Envelope, Auto Pan, Mono Fold, Level Window |

Filter-based effects (colour, blur) are collapsed into a single canvas filter pass so a
long stack still plays in real time; the rest are handwritten pixel passes. The edge-based
looks (Cartoon, Watercolour, Blueprint) share one precomputed luminance plane, so their
neighbourhood maths costs a single array read per sample instead of three multiplies.

### Transitions — 164 types
A transition is created the OpenShot way: overlap two clips on the same video track, then
drag the triangle to change its length. They are grouped in the library with a search box:

- **Dissolve** (40) — cross, blur, checkerboard, noise, hexagon, block, film, the blend-mode
  dissolves (screen, overlay, darken, colour burn, hue…), ordered dither, halftone, line,
  crosshatch, dot, scanline, domino, fly-in, cells and particle dissolves.
- **Wipe** (44) — left / right / up / down, feathered, circle (iris), diamond, star, box,
  luma, ripple, barn doors, diagonal, curtain, pinwheel, zipper, puzzle, corner sweep, the
  polygon set (triangle through decagon), burst, sunburst, heart, arrow, keyhole, cross,
  hourglass, spiral, plus radial, vertical and wave blinds.
- **Slide** (37) — cover, push, reveal, squeeze, roll, the diagonals, barn doors, cube turn,
  flip horizontal / vertical, swing door, whip pan and fold over.
- **Zoom** (13) — zoom in / out, cross zoom, zoom twist, radial bloom, zoom blur dissolve,
  punch zoom, dive, rotate, explode, implode, iris and whip zoom.
- **Stylised** (26) — spin, page turn, film burn, matrix, clock sweep, shattered glass, strip
  slide, glitch cut, VHS cut, datamosh, CRT power on, liquid, tunnel, spotlight, prism, ink
  spill, water ripple, neon, sketch, fracture, light leak, film strip and heartbeat.
- **Flash** (4) — white, black, colour and strobe flashes.

Every registered transition is machine-verified to be **exactly A at `p=0` and exactly B
at `p=1`**, and to leave no semi-transparent hole mid-move — so a clip on a lower track can
never bleed through the middle of a blend. Large groups of variants share one tested
renderer through a family table, so a new look never ships untested.

### Titling
Six title presets (Main Title, Subtitle, Lower Third, Caption, End Credits, Callout),
17 fonts, nine in/out animations (fade, slides, zoom, typewriter, blur), fill and stroke
colour, alignment, tracking, line height, shadow and background box.

### Audio
- Per-clip volume with keyframes, fade in/out handles, and a **per-clip 3-band EQ**
  (low / mid / high).
- **Mastering bus** on the output: 3-band EQ → compressor → brickwall limiter, so a mixed
  project arrives at the export at a consistent, sane level.
- **Normalise audio** on any selection.
- Master volume and live L/R level meters, plus a floating **scopes** window
  (waveform, RGB parade, vectorscope, histogram) that follows the playhead.
- Offline audio mixdown used by the exporter, so exports match the timeline exactly.

### Export
Three engines, every result verified before you're told it worked:

| Engine | How it works | Output |
| --- | --- | --- |
| **Precise** | WebCodecs hardware/software encode, frame-exact seek-based rendering, written through OpenScene's own MP4 muxer | MP4 (H.264 + AAC) |
| **Fast / Realtime** | Realtime capture of the live preview through `MediaRecorder` | MP4 where supported, otherwise WebM/VP9 |
| **Audio** | Offline `OfflineAudioContext` mixdown | WAV or M4A (AAC) |

Fourteen resolution presets — **16K UHD (8640p)**, **8K UHD and 8K DCI** in WebM/VP9, 4K UHD
down to SD, vertical and square social formats, and audio-only WAV/M4A — plus quality steps,
custom bitrate, hardware-encode toggle, and three export **ranges**: whole project, work
area, or a custom in/out span.

No web engine can encode 16K video, so OpenScene routes by size instead of pretending:
H.264 in MP4 up to 4K, VP9 in WebM up to 8K, and at 16K it delivers **PNG stills and a PNG
image-sequence ZIP**. Rendering a 16K frame works; encoding one as a movie is beyond the
platform, and OpenScene says so rather than failing halfway.

### Projects
- **Native Open/Save dialogs** in the Windows build.
- Projects are `.oscene` files (the counterpart to OpenShot's `.osp`); imported media
  lives in IndexedDB, so reopening a
  project restores everything automatically. If a file is gone, OpenScene offers to
  **relink** it.
- **OpenShot projects open directly.** Dropping a `.osp` file converts its layers,
  clips, keyframes, blend modes and filters into an OpenScene project on the spot.
- **Autosave** every 45 seconds with a recovery prompt on the next launch.
- Recent-projects list.

### Importing media — every format the engine can meet
The import dialog and drag-and-drop accept the same
**221 extensions: 72 video, 63 audio, 86 image** — MP4/MOV/MKV/WebM/AVI/MPEG/OGV/FLV/M4V
and friends; MP3/AAC/M4A/WAV/FLAC/OGG/Opus/WMA/AIFF and friends; JPEG/PNG/WebP/GIF/BMP/
TIFF/HEIC/SVG/AVIF and friends, including RAW-ish and oddball containers.

Two things make that promise real rather than a long `accept` attribute:

- **Unknown or extension-less files are sniffed, not rejected.** OpenScene reads the first
  4 KB and identifies the container by magic number, so a file named `clip` or `.bin` is
  still classified correctly and imported.
- **A file that this build cannot decode is still kept.** If the container is known but the
  codec inside it is not supported by the web engine on this machine (a common case with
  HEVC or certain AVI/ProRes variants), OpenScene imports the file anyway, badges it
  **NO CODEC** in the media bin, explains why, and refuses to put it on the timeline rather
  than silently dropping it. Switch machines or re-wrap the file and it plays — nothing was
  ever lost.

The format tables live in one place, `js/media.js`, and the native Windows host mirrors
them, so the picker, the drop zone and the OS file dialog can never disagree.

---

## Keyboard shortcuts

Press **?** or open *Help ▸ Keyboard shortcuts* for the full list. Highlights:

| Keys | Action |
| --- | --- |
| `Space` | Play / pause |
| `J` `K` `L` | Shuttle back / stop / shuttle forward (repeated presses speed up) |
| `←` `→` | Step one frame |
| `Shift+←` / `Shift+→` | Jump one second |
| `Home` / `End`, `Page Up` / `Page Down` | Start / end, previous / next edit point |
| `S` / `Shift+S` | Split at playhead / split everything |
| `Delete` / `Shift+Delete` | Lift / ripple delete |
| `Ctrl+X` `Ctrl+C` `Ctrl+V` `Ctrl+D` | Cut, copy, paste, duplicate |
| `Ctrl+Z` / `Ctrl+Y` | Undo / redo |
| `Ctrl+I` | Import media |
| `Ctrl+S` / `Ctrl+O` | Save / open project |
| `Ctrl+E` / `Ctrl+Shift+E` | Export / export still frame |
| `M` | Add a marker |
| `I` / `O` | Set in / out point |
| `N` / `R` | Toggle snapping / ripple editing |
| `Alt+↑` / `Alt+↓` | Move the selection a track up / down |
| `+` `-` `Ctrl+0` | Zoom in / out / fit |
| `F11` | Fullscreen preview |
| `F3` | Performance stats overlay |

---

## Architecture

```
index.html              classic <script> tags, no bundler, no build step
css/app.css             the whole dark theme
css/mobile.css          the sub-900 px single-pane layout
js/                     the engine — plain ES2020, one global OS namespace
  util.js               helpers, DOM builder, Emitter, FrameMeter, onActivate
  timebase.js           integer-frame timebase + rational fps + timecode
  model.js              project data model (assets, tracks, clips, effects, keyframes,
                        blend modes, adjustment layers, groups)
  commands.js           undo/redo command stack
  effects.js            136 effects (123 video, 13 audio) + the filter/pixel/draw appliers
  transitions.js        164 transition renderers (shared-family dispatch table)
  titles.js             titler presets + renderers
  renderer.js           the compositor
  media.js              IndexedDB store, element pools, thumbnails, waveform peaks
  player.js             transport, master frame clock, WebAudio graph, mastering bus, meters
  scopes.js             floating waveform / parade / vectorscope / histogram
  wav.js                16-bit PCM WAV encoder
  mp4muxer.js           hand-written ISO-BMFF (MP4) muxer + codec config
  export.js             the three export engines + verification
  timeline.js           the canvas timeline (largest module)
  bin.js                project media bin
  library.js            effects + transitions pickers and thumbnails
  properties.js         the inspector
  dialogs.js            modals, context menus, toasts, export dialog
  shortcuts.js          the keymap
  persist.js            save/open/autosave/recovery/relink — consumes window.openscene
  mobile.js             the sub-900 px single-pane mobile layout
  selftest.js           the end-to-end acceptance suite (67 checks)
  app.js                the application shell (menus, transport, wiring)
native/                 the Windows host
  OpenScene.cs          WebView2 window, native dialogs, --selftest CLI
  host-bridge.js        window.openscene over chrome.webview RPC
  webview2/             the vendored WebView2 SDK used to build the host
icons/                  generated logo (favicon, PWA, maskable)
resources/              generated app icon (.ico / .png), logo wordmark, installer art
tools/OpenScene.nsi     NSIS installer script
Build-WindowsApp.ps1    builds Dist\OpenScene\OpenScene.exe
Build-Installer.bat     one click: the app plus the single-file installer
Run-OpenScene.bat       smart launcher (the built app, else Edge app mode)
OpenScene-EdgeApp.cmd   zero-install Edge app-mode launcher
```

**No build step for the app itself.** `index.html` is what the Windows host loads — the
timeline, compositor, effects, exporter and interface are all plain files, so the editor
builds with nothing but the .NET compiler that already ships with Windows.

The logo is drawn by a stdlib-only script (System.Drawing): a rounded navy gradient badge
with a playhead-triangle mark and filmstrip sprocket holes, rendered at every size the
native shell needs.

---

## Self-test

OpenScene ships with an end-to-end acceptance suite that synthesises its own media and
exercises the whole engine: it generates a video (canvas → `MediaRecorder`), an audio tone
(WAV) and an image (`toBlob`), imports them into the real media store, builds a real
project (a title, a video clip with a dissolve transition, effect stacks and scale
keyframes, an image clip and an audio clip with fades), renders every frame, verifies the
transition actually blends, runs the offline audio mixdown, encodes a WAV, performs a
**real frame-exact MP4 export and an M4A export**, re-verifies the bytes, exports a still,
checks the model's validation negative cases, and then — for regression safety — applies
**every registered effect** and draws **every registered transition** at `p=0`, `p=0.5`
and `p=1` to prove none of them throws and none of them fails to reach the incoming clip.

That last pair of checks is what keeps this editor's effect and transition libraries
honest. It is currently **81 passed, 0 failed**.

Run it from **Help ▸ Run self-test…**, launch with `#selftest` appended to the URL
(`index.html#selftest`), or use the CLI form shown above.

---

## Requirements

- **Windows 10 or 11** (x64) with the WebView2 runtime — preinstalled on current machines.
- Hardware H.264 encoding requires a GPU/driver that exposes it to the web engine;
  OpenScene falls back to software encoding, and then to the realtime engine,
  automatically.

---

## Privacy

OpenScene never makes a network request. Media is read from your disk, decoded
in-process, and stored locally so projects reopen instantly. Nothing is uploaded, ever.

---

## Licence

**GNU Affero General Public License v3.0** - see [LICENSE](LICENSE).

OpenScene was MIT-licensed up to and including `v1.1.0`. Anyone who received it
under those terms keeps them; the change is not retroactive. See
[LICENSE-MIT](LICENSE-MIT) for the historical text.

The AGPL is strong copyleft. It matters most for its network clause: if you run
a *modified* OpenScene so users interact with it over a network, you must offer
those users the source of your version.

If your organisation cannot accept those terms, a **commercial licence** is
available - see [LICENSING.md](LICENSING.md). Contributions are accepted under
the terms in [CLA.md](CLA.md), which is what allows the project to keep offering
that commercial option.

OpenScene contains **no third-party runtime code**. The Windows host is
built against the WebView2 SDK (vendored under `native/webview2/` for offline builds);
the WebView2 *runtime* it drives is a Windows component, not something OpenScene ships.
