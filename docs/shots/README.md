# Screenshots

This folder holds the screenshots shown in the project README.

## Generating them

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File ..\..\tools\CaptureScreenshots.ps1
```

The script drives headless Chrome or Edge and writes `editor.png` here. It needs
a browser and Python installed; it requires nothing else.

## Adding the rest by hand

The script captures the editor's default view. For per-panel shots, open the
editor and capture each one, saving with these names:

| File | What to show |
|---|---|
| `editor.png` | The full window, timeline populated |
| `timeline.png` | A close-up of clips, a transition mid-play |
| `library.png` | The effects or transitions panel open |
| `export.png` | The export dialog |

Good screenshots matter more than the feature list: they are how someone decides
in ten seconds whether the editor is any good. Use real footage, a clean desktop,
and a 16:9 window so the images are consistent.
