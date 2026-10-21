# Launch kit

Everything needed to put OpenScene in front of people. Nothing here is
mandatory; it is a set of drafts to edit and use.

The order matters: **video first, then posts**. A post without a demo video
wastes the one moment a community will look at the project.

---

## 1. The demo video (do this first)

**Goal:** 60-90 seconds, no narration needed. Screen recording only.

**Why it matters most:** people decide in about ten seconds whether an editor is
any good. They decide by watching the timeline move, not by reading a feature
list. DaVinci and Shotcut have videos; a project without one looks unfinished.

### Script

| Time | What to show | On-screen text |
|---|---|---|
| 0:00-0:06 | The editor opening, empty timeline | "A video editor with no runtime dependencies." |
| 0:06-0:16 | Drag 4-5 clips in; they land end-to-end on **one** track | "Drop files. They land on one track." |
| 0:16-0:28 | Razor, drag, snap. Ripple one clip | "Razor, ripple, roll, slip" |
| 0:28-0:40 | Drag a transition between two clips, play it | "164 transitions" |
| 0:40-0:52 | Open the effects library, apply one, animate a keyframe | "136 effects, keyframed" |
| 0:52-1:04 | Add a title, move it | "Titling" |
| 1:04-1:16 | Export dialog, start export, show it finish | "Frame-exact H.264/AAC export" |
| 1:16-1:26 | Open Task Manager next to it, showing one process | "0 runtime dependencies. No Electron. No Node." |
| 1:26-1:30 | The website, installer size | "Free. AGPL-3.0. 0.6 MB installer." |

### How to record

- **Windows:** `Win + G` (Game Bar) or `Win + Shift + S`. Game Bar records a
  window cleanly at 1080p.
- Use a **clean desktop**: close unrelated windows, hide the taskbar if you can,
  remove personal files from view.
- **Work at 1080p or higher**, and set the editor's window to a 16:9 shape so the
  video is not letterboxed.
- Use **real footage**, not black frames. Ten seconds of something recognisable
  is far more convincing than a test pattern.
- Keep the mouse movements **deliberate**. Pause briefly at each step so a viewer
  can follow.
- Export the video at 1080p, then upload to YouTube unlisted first and check it
  looks right.

### The thumbnail

Take a still with the timeline full of clips and a transition mid-play.
Overlay just this: **"0 dependencies. 1 installer."**

---

## 2. Where to post, in order

Post **one at a time**, a few days apart, so you can respond to each properly.

### a) r/VideoEditing and r/opensource

Title options (pick one):

- `I built a video editor with zero runtime dependencies - it runs on the WebView2 engine Windows already ships`
- `OpenScene: a free AGPL video editor for Windows, 0.6 MB installer, no Electron, no Node`

Body:

> I've spent a long time building a non-linear video editor for Windows from
> scratch - the timeline, compositor, 164 transitions, 136 effects, titler,
> audio mixer and the MP4 muxer are all hand-written JS running on WebView2.
>
> There are no third-party runtime dependencies at all. The installer is about
> 0.6 MB, because it is a native shell around the engine Windows already has.
> No Electron, no Node, no bundled browser.
>
> It is free and open source (AGPL-3.0), it never touches the network, and it
> has no accounts or telemetry. [video link]
>
> [download link]
>
> Happy to answer anything about how it works.

### b) Hacker News - Show HN

Title: `Show HN: OpenScene - a video editor with zero runtime dependencies`

First comment (post it yourself immediately):

> Author here. The unusual part is the constraint: no third-party runtime
> libraries at all. The timeline, compositor, effects, transitions, titler,
> audio engine, MP4/ISO-BMFF muxer and the whole UI are hand-written and run on
> WebView2, which is already on every up-to-date Windows machine.
>
> That is why the installer is 0.6 MB instead of the 100-200 MB an Electron
> editor needs. It also means there is no bundled browser to keep patched.
>
> Things I know are still weak: no macOS or Linux build, .osp import drops
> filters it cannot map, and full-frame effects at very high resolutions use a
> lot of memory. There is a self-test suite (81 checks) you can run from the
> Help menu.
>
> Happy to answer anything.

**Timing:** weekday morning, US Eastern. Stay at your keyboard for the first
three hours and answer everything, including criticism.

### c) A short video post

Post the 60-90 second clip to r/opensource, X, and any community you are in.
Video posts travel much further than link posts.

---

## 3. Things that make a launch go badly

Worth knowing before you post:

- **Do not claim it beats Premiere or DaVinci.** It does not. Claiming it invites
  a pile-on. Claim the thing that is actually true: it is tiny, offline, and has
  no runtime dependencies.
- **Do not argue with critics.** "Fair, that's not implemented yet" is a
  complete answer and looks far better than defending a gap.
- **Do not post to five places on the same day.** You cannot answer everyone,
  and the threads die.
- **Do not hide the licence change.** Someone will notice OpenScene was MIT. Say
  plainly that it moved to AGPL to stop rebranded closed-source forks, and that
  older releases keep MIT. You have `LICENSE-MIT` and the changelog to point to.
- **Fix the thing a reviewer finds.** The second-best outcome of a launch is a
  list of real bugs from people using it on hardware you do not have.

---

## 4. What to measure

Only two numbers matter at this stage:

- **Installer downloads** (the release page shows a count per asset).
- **GitHub stars and issues opened** - issues from real users are the strongest
  possible signal that people are actually using it.

Write both down on the day you launch. They are the numbers a future buyer will
ask for, and they are what turns "an MIT repo" into "a project with users".
