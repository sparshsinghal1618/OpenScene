# OpenScene on Android and iOS

OpenScene is one web app with three thin native shells. The editor itself —
timeline, effects, transitions, scopes, mastering bus, export pipeline — is the
same code on Windows, Android and iOS. Only the file dialogs and filesystem
access are native, because a browser sandbox cannot provide them.

```
index.html + js/ + css/ + resources/ + icons/     <- the whole editor (shared)
        |
        |  served from http://127.0.0.1:<port>/ by a tiny in-app HTTP server
        v
+---------------------+   +---------------------+   +---------------------+
|  Windows (WebView2) |   |  Android (WebView)  |   |  iOS (WKWebView)    |
|  native/            |   |  mobile/android/    |   |  mobile/ios/        |
+---------------------+   +---------------------+   +---------------------+
        \                        |                        /
         \------ window.openscene host bridge contract --/
```

## Why a loopback HTTP server instead of `file://` or a custom scheme

The editor stores imported media in IndexedDB and autosaves to `localStorage`.
`file://` pages are opaque origins: IndexedDB, `localStorage` and service
workers are all unavailable or unreliable there. Serving the app from
`http://127.0.0.1` gives it a real, stable origin, so the phone behaves exactly
like the desktop build. The server binds to loopback only, on an ephemeral port,
and never touches the network.

## The host bridge contract

`js/persist.js` reads `window.openscene` and, when it exists, uses real native
file dialogs. Every shell must expose these members:

| Member | Returns |
| --- | --- |
| `isHost` | `true` |
| `platform` | `'win32'` / `'android'` / `'ios'` |
| `versions` | `{ host }` |
| `info()` | platform details |
| `quit()` | — |
| `saveProject({ json, suggestedName, force })` | `{ filePath }` or `{ canceled: true }` |
| `openProject()` | `{ json, name, filePath }` or `{ canceled: true }` |
| `openProjectPath(path)` | same as `openProject()` |
| `pickFiles({ multiple })` | `[{ path, name, size, type }]` |
| `readFile(path)` | `Uint8Array` |
| `saveExport({ buffer, suggestedName })` | `{ filePath }` or `{ canceled: true }` |

`path` is opaque to the web app, so each platform uses whatever is natural: a
filesystem path on Windows, a `content://` URI on Android, a bookmark key on
iOS.

Binary payloads move in chunks (1 MiB on mobile, 2 MiB on Windows) so that a
multi-gigabyte export never has to exist as one JavaScript string.

Implementations:

| Platform | Bridge JS | Native |
| --- | --- | --- |
| Windows | `native/host-bridge.js` | `native/` (C# / WebView2) |
| Android | `mobile/host-bridge-mobile.js` | `mobile/android/app/src/main/java/app/openscene/HostBridge.java` |
| iOS | `mobile/host-bridge-mobile.js` | `mobile/ios/OpenScene/HostBridge.swift` |

---

## Android

**Requirements:** JDK 17 and the Android SDK (platform 34, build-tools 34).
Nothing else — the shell has zero third-party dependencies (no AndroidX, no
Compose, no Kotlin), so it builds with plain `aapt2` / `javac` / `d8` /
`zipalign` / `apksigner`. No Gradle, no AGP, no Maven.

```powershell
# 1. copy the shared web app into the shell (run after every web change)
powershell -ExecutionPolicy Bypass -File mobile\android\sync-assets.ps1

# 2. build (downloads the JDK and SDK on first run, then produces the APK)
powershell -ExecutionPolicy Bypass -File tools\Build-AndroidApp.ps1
#  -> mobile\android\app\build\outputs\apk\debug\app-debug.apk

# 3. install
adb install -r mobile\android\app\build\outputs\apk\debug\app-debug.apk
```

`tools\Build-AndroidApp.ps1` bootstraps everything: it downloads Temurin
JDK 17 and the Android command-line tools into `tools\android-toolchain\`,
accepts the SDK licenses, installs `platforms;android-34` and
`build-tools;34.0.0`, then runs the full build chain
(`aapt2 compile` -> `aapt2 link` -> `javac` -> `d8` -> `zipalign` ->
`apksigner`) and signs with a generated debug keystore. After the first run
the toolchain is cached and subsequent builds are fast.

Notes:

- **No runtime permissions.** Files are chosen through the Storage Access
  Framework, so there is no storage permission prompt and no file access to
  grant by hand. The only manifest permission is `INTERNET`, which is what
  binding a loopback socket requires.
- **Cleartext is limited to loopback.** `res/xml/network_security_config.xml`
  permits cleartext for `127.0.0.1` and `localhost` and denies it everywhere
  else.
- **Back button** navigates the WebView history before leaving the app.
- **Landscape is the intended editing orientation**; the layout switches to a
  single-pane editor under 900 px of width (`css/app.css`, `js/mobile.js`).

## iOS

**Requirements:** macOS with Xcode 15+, and a signing identity (a free Apple ID
works for device testing; 7-day provisioning).

```sh
# 1. copy the shared web app into the shell
sh mobile/ios/sync-assets.sh
```

```
# 2. create the Xcode project once
#    File ▸ New ▸ Project ▸ iOS ▸ App
#      Product Name: OpenScene
#      Interface:    Storyboard          (delete the generated storyboard)
#      Language:     Swift
#    Then:
#      - delete the generated ViewController.swift and Main.storyboard,
#        and the AppDelegate/SceneDelegate Xcode writes for a storyboard app
#      - drag the whole mobile/ios/OpenScene/ folder into the project
#        (Create groups ▸ do not copy items)
#      - set the target's Info.plist to OpenScene/Info.plist and add
#        INFOPLIST_KEY_UIApplicationSceneManifest_Generation = NO
#        (AppDelegate drives the window; no scene manifest is needed)
#      - drag mobile/ios/www/ into the project as a *folder reference*
#        (blue icon, "Create folder references") so the path structure is
#        preserved inside the bundle
#      - App Icon ▸ set to AppIcon, Launch Screen ▸ LaunchBackground

# 3. run
#    ⌘R on a simulator or a connected device
```

The Xcode project is deliberately not checked in: it contains an absolute-path
build state and a signing identity, both of which are machine-specific and
belong to whoever is building. The five source files, the asset catalog and
`Info.plist` are everything the project needs.

Notes:

- **App Transport Security** allows local networking only
  (`NSAllowsLocalNetworking`); arbitrary loads stay disabled.
- **Saving** stages the file in `tmp/openscene-stage` and hands it to the export
  picker, which is the only way iOS lets an app choose a destination. The bridge
  contract is unchanged, so the web app never knows the difference.
- **`pickFiles` returns bookmark keys** rather than raw paths so that access
  survives app restarts.

---

## Verifying a shell change

Both shells are thin by design: if the bridge contract is right, the app is
right. The web app itself is covered by the built-in self-test
(Help ▸ Run self-test, 67 checks), which runs the same code path on every
platform.

## What cannot be verified here

This repository can be built and tested on Windows only. The Android APK builds
and signs cleanly via `tools\Build-AndroidApp.ps1` but cannot be installed on a
device in this environment (no emulator or adb). Producing an IPA needs macOS
and Xcode, which is not available here. The iOS shell sources are complete and
are direct ports of the working Windows host.
