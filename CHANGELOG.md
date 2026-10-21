# Changelog

All notable changes to OpenScene are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
semantic versioning.

## [1.2.0] - 2026-10-21

### Added

- **Workspace presets** (Window > Workspace). Built-in layouts named after the
  task they suit - Editing, Assembly, Effects, Transitions, Colour, Audio and
  Preview only - plus your own saved layouts, which are restored on startup.
  Panels can be hidden, and dock and timeline sizes are remembered. The presets
  are original layouts, not a copy of another editor's chrome.
- **Custom transitions** (Effects > Custom transitions...). Two ways to build one:
  a parameter builder covering nine families (wipe, slide, zoom, iris, blinds,
  checker, blur, dissolve, plus softness, angle, band count, origin, easing and
  reverse), or a script that draws the blend directly. Either way the transition
  joins the normal library, gets a thumbnail, and works in the exporter with no
  other change. Scripts are refused access to the page and the network, and are
  smoke-tested before they are saved.

### Changed

- **Relicensed from MIT to the GNU Affero General Public License v3.0.**
  Releases up to and including `v1.1.0` keep their MIT terms; the change is not
  retroactive and the historical text is kept in `LICENSE-MIT`. The AGPL closes
  the rebrand-and-resell loophole: a modified version that is distributed, or
  run as a network service, must publish its changes.
- Corrected the copyright holder, which was incorrectly listed as
  "OpenKino contributors", to Sparsh Singhal.
- **The installer now bundles the Microsoft Edge WebView2 bootstrapper** and
  installs the runtime only when it is missing. OpenScene is a WebView2 host, so
  a machine without the runtime would otherwise install a window that shows
  nothing. The bootstrapper is fetched at build time and refused unless it
  carries a valid Microsoft signature. The full runtime (~870 MB) was rejected:
  it would turn a 2 MB installer into a ~200 MB one for machines that lack a
  component Windows 10 and 11 already ship.
- The installer shows an **AGPL licence page**, and its `DisplayVersion` and
  `Publisher` were corrected from `1.0.0` and `OpenScene` to `1.2.0` and the
  actual copyright holder.
- The install folder now ships `LICENSING.md`, `CLA.md` and `LICENSE-MIT`, so
  the reference to them in `START-HERE.txt` resolves.
- The service worker is **network-first** rather than cache-first. The old design
  was invalidated only by a hand-edited version constant, so any edit to a cached
  file could silently ship the previous build.
- `LICENSING.md` describes the paid commercial licence offered to organisations
  that cannot accept the AGPL, and `CLA.md` grants the right to relicense - which
  is what makes that licence enforceable. Added alongside them:
  `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md` and `SECURITY.md`, plus a licensing
  section on the website explaining the licence in plain language.

### Fixed

- A custom transition whose script would not compile was registered in the
  transitions panel before it was validated, leaving a visible entry that did
  nothing when applied. Compilation now happens before registration, so a
  rejected transition touches no shared state.
- **Custom transitions and workspaces were never restored on startup.** Both were
  written to IndexedDB but nothing ever read the store back, so a saved workspace
  and every custom transition disappeared when the app was reopened.
- A throwing transition script now degrades to a dissolve instead of aborting
  the frame, and every transition is forced to render exactly the outgoing clip
  at one end and exactly the incoming clip at the other, so a cut cannot flash.

### Removed

- The website's donation section. It linked to a Buy Me a Coffee account that
  was never created, so the button returned 404.

## [1.1.0] - 2026-10-20

### Added

- Importing **OpenShot `.osp` projects** through File > Open, with a best-effort
  mapping of clips, tracks and effects. Filters with no equivalent are counted
  and reported rather than silently dropped.
- Single-file NSIS installer (`OpenScene-Setup.exe`) with Start-menu and desktop
  shortcuts and an uninstaller.
- Portable build (`OpenScene-portable.zip`).
- Project website, published to GitHub Pages from `docs/`.

### Changed

- **Windows only.** Linux, macOS, Android and iOS targets were removed. The
  other platforms are listed as coming soon on the website.
- The timeline is now open-ended rather than capped at one second.
- Dropping many files onto the timeline places them end to end on a **single**
  track instead of scattering them across sections.
- The status bar now names the **selected clip** rather than the project.
- Media import is hardened. Peak decoding is bounded, heavy video containers are
  skipped for waveform generation, and audio decoding runs under a timeout, so a
  large file can no longer hang the import.
- Project files use the `.oscene` extension. `.osceneproj` and `.json` are still
  accepted, and `.osp` is imported.

### Fixed

- Importing a 4K clip no longer hangs; it completes in a fraction of a second.
- IndexedDB persistence was moved off the import critical path.

## [1.0.0] - 2026-10-19

### Added

- First release. Multi-track timeline, compositor, 164 transitions, 136 effects,
  keyframing, titling, a mastering audio bus and a frame-exact H.264/AAC
  exporter, all written from scratch with no third-party runtime dependencies.
- Self-test suite, reporting 81 passed and 0 failed.

[Unreleased]: https://github.com/sparshsinghal1618/OpenScene/compare/v1.2.0...HEAD
[1.2.0]: https://github.com/sparshsinghal1618/OpenScene/releases/tag/v1.2.0
[1.1.0]: https://github.com/sparshsinghal1618/OpenScene/releases/tag/v1.1.0
[1.0.0]: https://github.com/sparshsinghal1618/OpenScene/commits/master
