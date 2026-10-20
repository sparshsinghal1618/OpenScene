/* OpenScene — shortcuts.js
   Global keyboard map (NLE conventions). Ignored while typing in inputs. */
(() => {
  'use strict';
  const OS = (window.OS = window.OS || {});

  const SHORTCUTS = {
    'Transport': [
      ['Space', 'Play / pause'],
      ['J / K / L', 'Shuttle reverse / stop / forward (press again to go faster)'],
      ['← / →', 'Step one frame (Shift = 10 frames)'],
      ['Shift+← / Shift+→', 'Jump 10 frames'],
      ['Home / End', 'Go to project start / end'],
      ['Page Up / Page Down', 'Previous / next edit point'],
      ['I / O', 'Set in / out point'],
      ['Shift+I / Shift+O', 'Clear in / out point'],
      ['L', 'Toggle loop playback'],
    ],
    'Editing': [
      ['S', 'Split selected clip(s) at the playhead'],
      ['Shift+S', 'Split all clips at the playhead'],
      ['Delete', 'Lift selected clips (leave a gap)'],
      ['Shift+Delete', 'Ripple delete selected clips (close the gap)'],
      ['Ctrl+C / Ctrl+X / Ctrl+V', 'Copy / cut / paste at playhead'],
      ['Ctrl+D', 'Duplicate selected clips'],
      ['Ctrl+A', 'Select all clips'],
      ['Ctrl+G / Ctrl+Shift+G', 'Group / ungroup the selected clips'],
      ['[ / ]', 'Trim selected clip start / end to the playhead'],
      ['Y / Shift+Y', 'Slip the selected clip one frame left / right'],
      ['U / Shift+U', 'Slide the selected clip one frame right / left'],
      ['Alt+N', 'Roll the join between the selected clip and the clip before it'],
      ['Alt+↑ / Alt+↓', 'Move selected clips to the track above / below'],
      ['Ctrl+Z / Ctrl+Y', 'Undo / redo'],
      ['Ctrl+Shift+Z', 'Redo'],
    ],
    'Timeline view': [
      ['Mouse wheel', 'Zoom in / out around the cursor'],
      ['Shift + wheel', 'Scroll horizontally'],
      ['Alt + wheel', 'Scroll tracks vertically'],
      ['Middle-drag / Space-drag', 'Pan the timeline'],
      ['+ / -', 'Zoom in / out'],
      ['Ctrl+0', 'Zoom to fit project'],
      ['N', 'Toggle snapping'],
      ['R', 'Toggle ripple editing'],
    ],
    'Library panels': [
      ['Ctrl+1 / Ctrl+2 / Ctrl+3', 'Project Files / Transitions / Effects panel'],
      ['T', 'Show the Transitions panel'],
      ['E', 'Show the Effects panel'],
      ['Tracks: right-click a track head', 'Add, reorder, duplicate, rename or delete a track'],
      ['Drag & drop', 'Drop media, an effect or a transition onto the timeline'],
    ],
    'Tracks & audio': [
      ['Ctrl+Shift+V', 'Add a video track'],
      ['Ctrl+Shift+A', 'Add an audio track'],
      ['Drop an audio file on an audio track', 'Place a separate audio clip exactly where you drop it'],
      ['Audio track Mute / Solo', 'Toggle with the buttons on the track head'],
    ],
    'Markers & media': [
      ['M', 'Add a marker at the playhead'],
      ['Ctrl+I', 'Import media'],
      ['Ctrl+O', 'Open project'],
      ['Ctrl+S', 'Save project (download .oscene)'],
      ['Ctrl+E', 'Export dialog'],
      ['Ctrl+Shift+E', 'Export a still frame (PNG)'],
    ],
    'Interaction': [
      ['Drag clip body', 'Move (hold Alt = duplicate, hold Ctrl = ripple insert)'],
      ['Drag clip edge', 'Trim in / out'],
      ['Drag overlap top corner', 'Resize a transition'],
      ['Drag on empty track', 'Marquee select'],
      ['Drag the ruler', 'Scrub the playhead'],
      ['Double-click a clip', 'Open its properties'],
      ['Right-click', 'Context menu'],
      ['Drag a clip over the previous clip', 'Create an overlap transition'],
    ],
    'View': [
      ['Ctrl+Shift+C', 'Toggle the video scopes'],
      ['F11', 'Toggle fullscreen preview'],
      ['F3', 'Toggle performance stats'],
      ['?', 'Show this shortcut list'],
    ],
  };

  class ShortcutManager {
    constructor(app) {
      this.app = app;
      this.enabled = true;
      this._onKey = (e) => this.handle(e);
      window.addEventListener('keydown', this._onKey, true);
      window.addEventListener('keyup', (e) => { if (e.code === 'Space') app.timeline.setSpaceDown(false); });
    }

    _typing(e) {
      const t = e.target;
      if (!t) return false;
      const tag = (t.tagName || '').toLowerCase();
      return tag === 'input' || tag === 'textarea' || tag === 'select' || t.isContentEditable;
    }

    handle(e) {
      const app = this.app;
      if (!this.enabled || !app.project) return;
      if (this._typing(e)) {
        if (e.key === 'Escape') e.target.blur();
        return;
      }
      const mod = e.ctrlKey || e.metaKey;
      const key = e.key;
      const lower = key.length === 1 ? key.toLowerCase() : key;
      let handled = true;
      const player = app.player;

      if (e.code === 'Space' && !mod) { player.togglePlay(); app.timeline.setSpaceDown(true); }
      else if (mod && lower === 'z' && !e.shiftKey) app.undo();
      else if ((mod && lower === 'y') || (mod && e.shiftKey && lower === 'z')) app.redo();
      else if (mod && lower === 'a') app.timeline.selectAll();
      else if (mod && e.shiftKey && lower === 'c') app.scopes.toggle();
      else if (mod && lower === 'c') app.copySelection();
      else if (mod && lower === 'x') app.cutSelection();
      else if (mod && e.shiftKey && lower === 'v') app.addTrack('video');
      else if (mod && e.shiftKey && lower === 'a') app.addTrack('audio');
      else if (mod && lower === '1') app.showDock('binPanel');
      else if (mod && lower === '2') app.showDock('transitionsPanel');
      else if (mod && lower === '3') app.showDock('effectsPanel');
      else if (mod && lower === 'v') app.pasteAtPlayhead();
      else if (mod && lower === 'd') app.duplicateSelection();
      else if (mod && lower === 'g') { e.shiftKey ? app.ungroupSelection() : app.groupSelection(); }
      else if (mod && lower === 'i') app.importMedia();
      else if (mod && lower === 'o') app.persist.openProject();
      else if (mod && lower === 's') app.persist.saveProject();
      else if (mod && e.shiftKey && lower === 'e') app.exportStill();
      else if (mod && lower === 'e') app.dialogs.exportDialog();
      else if (mod && lower === '0') app.timeline.zoomToFit();
      else if (key === 'Delete' || key === 'Backspace') { e.shiftKey ? app.rippleDeleteSelection() : app.liftSelection(); }
      else if (lower === 's' && !mod) { e.shiftKey ? app.splitAllAtPlayhead() : app.splitAtPlayhead(); }
      else if (lower === 'j') player.shuttle(-1);
      else if (lower === 'k') player.shuttle(0);
      else if (lower === 'l' && !mod) {
        if (e.shiftKey) { player.loop = !player.loop; app.setStatus('Loop ' + (player.loop ? 'on' : 'off')); }
        else player.shuttle(1);
      }
      else if (key === 'ArrowLeft') player.step(e.shiftKey ? -10 : -1);
      else if (key === 'ArrowRight') player.step(e.shiftKey ? 10 : 1);
      else if (key === 'ArrowUp' && e.altKey) app.moveSelectionTrack(-1);
      else if (key === 'ArrowDown' && e.altKey) app.moveSelectionTrack(1);
      else if (key === 'ArrowUp') app.adjustVolume(+0.1);
      else if (key === 'ArrowDown') app.adjustVolume(-0.1);
      else if (key === 'Home') player.gotoStart();
      else if (key === 'End') player.gotoEnd();
      else if (key === 'PageUp') player.nextEditPoint(-1);
      else if (key === 'PageDown') player.nextEditPoint(1);
      else if (lower === 'i' && !mod) { e.shiftKey ? app.clearInOut(e.shiftKey) : app.setInPoint(); }
      else if (lower === 'o' && !mod) { e.shiftKey ? app.clearInOut(true, true) : app.setOutPoint(); }
      else if (lower === 'm' && !mod) app.addMarkerAtPlayhead();
      else if (lower === 'n' && !mod && e.altKey) app.rollEdit(app.timeline.getSelectedClips()[0], e.shiftKey ? -1 : 1);
      else if (lower === 'n' && !mod) app.timeline.snapBtn.click();
      else if (lower === 'y' && !mod) app.slipClip(app.timeline.getSelectedClips()[0], e.shiftKey ? 1 : -1);
      else if (lower === 'u' && !mod) app.slideClip(app.timeline.getSelectedClips()[0], e.shiftKey ? -1 : 1);
      else if (lower === 'r' && !mod) app.timeline.rippleBtn.click();
      else if (lower === 't' && !mod) app.showDock('transitionsPanel');
      else if (lower === 'e' && !mod) app.showDock('effectsPanel');
      else if (lower === '[' || lower === ']') app.trimSelectedToPlayhead(lower === '[' ? 'in' : 'out');
      else if (key === '+') app.timeline.zoomBy(1.3);
      else if (key === '-') app.timeline.zoomBy(1 / 1.3);
      else if (key === 'F11') app.toggleFullscreenPreview();
      else if (key === 'F3') app.toggleStats();
      else if (key === '?') app.dialogs.shortcuts();
      else handled = false;

      if (handled) { e.preventDefault(); e.stopPropagation(); }
    }
  }

  OS.shortcuts = { ShortcutManager, SHORTCUTS };
})();
