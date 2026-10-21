# Security Policy

## Reporting a vulnerability

Please **do not open a public issue** for a security problem. Use the
repository's **Security** tab and choose **Report a vulnerability**, which opens
a private advisory visible only to the maintainer.

Include:

- What the vulnerability allows an attacker to do.
- The steps to reproduce it.
- The version or commit you tested.
- Any suggested fix, if you have one.

You will get an acknowledgement as soon as reasonably possible. If the report is
valid you will be credited in the advisory unless you ask not to be.

## Scope

OpenScene is a local, offline desktop application. It makes no network requests
and has no server component, so a large class of web vulnerabilities does not
apply. The areas that genuinely matter are:

| Area | Why it matters |
|---|---|
| **Project and media file parsing** | `.oscene`, `.osp` and media files come from untrusted sources. A malformed file must not corrupt data or execute code. |
| **The MP4 / ZIP readers and writers** | These parse binary structures with attacker-controlled lengths and offsets. |
| **The WebView2 host** | `native/OpenScene.cs` sets the WebView2 options. Any weakening of the sandbox or navigation restrictions is a security issue. |
| **Memory use on hostile input** | Crafted files should cause a clean error, not exhaust memory or hang the app. |

## Out of scope

- Anything requiring an attacker to already have local code execution.
- Denial of service from a project file so large that it is simply unrealistic.
- Missing hardening headers on the marketing site in `docs/`, which is a static
  page with no user input.
- Reports produced solely by an automated scanner with no demonstrated impact.

## Supported versions

The latest release receives security fixes. Older releases are not maintained.
Because the project is licensed under the AGPL-3.0, you are free to build from
source if you need a fix on an older version.

## A note on the threat model

OpenScene reads files from your disk and decodes them in-process. It does not
sandbox media decoding beyond what the underlying web engine does. Treat media
and project files from unknown sources the way you would treat any untrusted
file.
