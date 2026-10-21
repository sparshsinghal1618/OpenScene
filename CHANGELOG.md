# Changelog

All notable changes to OpenScene are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
semantic versioning.

## [Unreleased]

### Changed

- **Relicensed from MIT to the GNU Affero General Public License v3.0.**
  Releases up to and including `v1.1.0` keep their MIT terms; the change is not
  retroactive and the historical text is kept in `LICENSE-MIT`. The AGPL closes
  the rebrand-and-resell loophole: a modified version that is distributed, or
  run as a network service, must publish its changes.
- Corrected the copyright holder, which was incorrectly listed as
  "OpenKino contributors", to Sparsh Singhal.

### Added

- `LICENSING.md` describing the paid commercial licence offered to
  organisations that cannot accept the AGPL.
- `CLA.md`, a contributor agreement granting the right to relicense. This is
  what makes the commercial licence enforceable.
- `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md` and `SECURITY.md`.
- A licensing section on the project website explaining the licence in plain
  language.

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

[Unreleased]: https://github.com/sparshsinghal1618/OpenScene/compare/v1.1.0...HEAD
[1.1.0]: https://github.com/sparshsinghal1618/OpenScene/releases/tag/v1.1.0
[1.0.0]: https://github.com/sparshsinghal1618/OpenScene/commits/master
