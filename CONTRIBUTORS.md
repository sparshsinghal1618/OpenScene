# Contributors

OpenScene was written by **Sparsh Singhal** and released under the GNU Affero
General Public License v3.0.

## Maintainer

- **Sparsh Singhal** ([@sparshsinghal1618](https://github.com/sparshsinghal1618)) -
  author and copyright holder.

## How to be listed here

Contribute under the terms of [`CLA.md`](CLA.md). Once a contribution is merged
you will be added below. Being listed here means you have agreed to that CLA and
confirmed you have the right to submit your work.

## Contributors

- Sparsh Singhal

## Third-party components

OpenScene contains **no third-party runtime code**. Everything - the timeline,
compositor, effects, transitions, titler, audio engine, MP4 (ISO-BMFF) muxer and
the user interface - is hand-written and runs on the web engine already present
on Windows.

| Component | Use | Licence |
|---|---|---|
| WebView2 SDK headers | Build-time only, to host the web engine in the native Windows shell (`native/webview2/`) | Microsoft, see `native/webview2/LICENSE.txt` and `NOTICE.txt` |

The WebView2 **runtime** that the shell drives is a component of Windows, not
something OpenScene ships or redistributes.
