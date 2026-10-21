# Contributing to OpenScene

Thanks for wanting to help. OpenScene is a from-scratch video editor for
Windows: no framework, no build step for the web layer, no third-party runtime
code. Contributions that respect that design are very welcome.

## Before you start

- **Read the licence.** The project is licensed under the **GNU Affero General
  Public License v3.0** (see `LICENSE`). It is also offered under a paid
  commercial licence to companies that cannot accept the AGPL.
- **Sign the CLA.** Any non-trivial contribution needs the agreement in
  `CLA.md`. Add this line to your pull request, or use `git commit -s`:

  > I have read the CLA in CLA.md and I agree to it.

  This is what allows the project to keep offering a commercial licence. A pull
  request without it cannot be merged.

## What fits the project

OpenScene has a few rules that keep it small and fast. Please respect them:

| Rule | Why |
|---|---|
| **No third-party runtime dependencies** | The whole editor runs on the WebView2 engine Windows already ships. Adding a library breaks that promise. |
| **No build step for `js/`** | Files are loaded as native ES modules. There is no bundler, transpiler, or minifier to run. |
| **No emojis in the UI** | Icons are drawn with SVG or plain glyphs. |
| **Windows is the only target** | Linux, macOS, Android and iOS targets were removed on purpose. |
| **`.ps1` files must be pure ASCII** | PowerShell 5.1 misreads UTF-8 without a BOM. |
| **Everything degrades honestly** | If a codec or effect cannot be applied, say so in the UI rather than failing silently. |

## Setting up

There is nothing to install to work on the web layer.

```powershell
git clone https://github.com/sparshsinghal1618/OpenScene
cd OpenScene
Run-OpenScene.bat          # opens the editor in Edge app mode
```

To build the native Windows app you need the .NET Framework compiler that ships
with Windows; the build script finds it itself:

```powershell
.\Build-WindowsApp.ps1
.\Build-Installer.bat
```

## Running the tests

Every change must keep the self-test suite green. Open the editor, press
**Ctrl+Shift+T** (or open the self-test panel), and confirm **all checks pass,
zero failures**. The current baseline is **81/81**.

If you add a feature, add a check for it. If you fix a bug, add a check that
would have caught it.

## Making a change

1. **Open an issue first** for anything larger than a small fix, so we can agree
   on the approach before you write code.
2. **Keep the diff focused.** One logical change per pull request.
3. **Match the surrounding style.** Tabs in PowerShell, two-space indent in
   JavaScript, the existing comment style.
4. **Update the docs.** If you change behaviour, update `README.md`. If you
   change the website, update `docs/` and bump `site.css?v=N` in
   `docs/index.html` so browsers pick up the new stylesheet.
5. **Describe what you tested** and on what. "Works on my machine" is not a test
   report.

## Areas that need work

These are genuinely useful and not yet done:

- More transitions and effects (the libraries are large but not complete).
- Better `.osp` import fidelity: some OpenShot filters have no equivalent and
  are currently counted and reported rather than silently dropped.
- Export presets for common targets.
- Accessibility of the timeline for keyboard-only users.

## Reporting bugs

Include:

- What you did, what you expected, what happened.
- The exact steps, so it can be reproduced.
- Your Windows version and whether WebView2 is installed.
- The media file's format and size, if the bug involves importing or playback.

Do not attach media you do not have the right to share.

## Code of conduct

Be decent to people. No harassment, no personal attacks, no dismissing someone
because they are new. Technical disagreement is fine and expected; being rude is
not.
