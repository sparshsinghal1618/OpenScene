/* OpenScene — persist.js
   Project save / open / autosave / recovery and media relinking.
   Native file dialogs are used when running inside a native shell (the Windows
   WebView2 host or a mobile host); otherwise the File System Access API is used,
   with a download fallback. Media files live in
   IndexedDB (structured-cloned File objects) so reopening a project restores
   everything without relinking. */
(() => {
  'use strict';
  const OS = (window.OS = window.OS || {});
  const U = OS.util;
  const { el, on, withTimeout } = U;

  const AUTOSAVE_MS = 45_000;
  const PROJECT_EXT = '.osceneproj';
  const AUTOSAVE_KEY = 'autosave-current';
  const RECENTS_KEY = 'recents';

  class Persist {
    constructor(app) {
      this.app = app;
      this.dirty = false;
      this.lastSavedAt = 0;
      this._timer = null;
      this.autosaveEnabled = true;
      this.currentHandle = null;
      this._startAutosave();
      window.addEventListener('beforeunload', (e) => {
        if (this.dirty) { e.preventDefault(); e.returnValue = 'You have unsaved changes in OpenScene.'; }
      });
    }

    get native() { return window.openscene || null; }

    markDirty() {
      this.dirty = true;
      if (this.app.titleEl) this.app.updateTitle();
    }

    _startAutosave() {
      clearInterval(this._timer);
      this._timer = setInterval(() => this.autosave(), AUTOSAVE_MS);
    }

    /* ---------- save ---------- */

    async saveProject({ forceDialog = false } = {}) {
      const app = this.app;
      const p = app.project;
      const json = OS.model.serialize(p);
      const suggested = (p.name || 'Untitled Project').replace(/[\\/:*?"<>|]+/g, '_') + PROJECT_EXT;
      try {
        if (this.native) {
          const saved = await this.native.saveProject({ json, suggestedName: suggested, force: forceDialog });
          if (saved && saved.canceled) return false;
          this.dirty = false;
          this.lastSavedAt = Date.now();
          app.setStatus('Project saved');
          app.dialogs.toast('Project saved', 'info', 2500);
          app.updateTitle();
          if (saved && saved.filePath) { app.recentPath = saved.filePath; await this._rememberPath(saved.filePath); }
          return true;
        }
        if (window.showSaveFilePicker && forceDialog !== false) {
          try {
            const handle = await window.showSaveFilePicker({
              suggestedName: suggested,
              types: [{ description: 'OpenScene project', accept: { 'application/json': [PROJECT_EXT, '.json'] } }],
            });
            this.currentHandle = handle;
            const w = await handle.createWritable();
            await w.write(json);
            await w.close();
            const name = handle.name.replace(/\.(osceneproj|json)$/i, '');
            if (name) app.setProjectName(name);
            this.dirty = false; this.lastSavedAt = Date.now();
            app.setStatus('Project saved to ' + handle.name);
            app.dialogs.toast('Project saved: ' + handle.name, 'info', 3000);
            app.updateTitle();
            return true;
          } catch (e) {
            if (e && e.name === 'AbortError') return false;
            // fall through to download
          }
        }
        this._download(new Blob([json], { type: 'application/json' }), suggested);
        this.dirty = false; this.lastSavedAt = Date.now();
        app.setStatus('Project downloaded as ' + suggested);
        app.dialogs.toast('Project downloaded — keep it with your media files', 'info', 5000);
        app.updateTitle();
        return true;
      } catch (e) {
        console.error(e);
        app.dialogs.toast('Could not save project: ' + e.message, 'error', 8000);
        return false;
      }
    }

    async autosave() {
      if (!this.autosaveEnabled || !this.dirty) return;
      const p = this.app.project;
      if (!p) return;
      try {
        const payload = { json: OS.model.serialize(p), at: Date.now(), name: p.name };
        await OS.media.idbPut('kv', AUTOSAVE_KEY, payload);
        this.app.setStatus('Autosaved ' + new Date().toLocaleTimeString());
      } catch (e) { /* ignore quota errors */ }
    }

    async readAutosave() {
      try { return await OS.media.idbGet('kv', AUTOSAVE_KEY); } catch (e) { return null; }
    }
    async clearAutosave() { try { await OS.media.idbDelete('kv', AUTOSAVE_KEY); } catch (e) {} }

    /* ---------- open ---------- */

    async openProject(pickedJson, nameHint) {
      const app = this.app;
      try {
        let json = pickedJson, fname = nameHint || 'Untitled Project.osceneproj';
        if (json == null) {
          if (this.native) {
            const res = await this.native.openProject();
            if (!res || res.canceled) return false;
            json = res.json; fname = res.name || fname;
            app.recentPath = res.filePath || null;
            if (res.filePath) await this._rememberPath(res.filePath);
          } else if (window.showOpenFilePicker) {
            try {
              const [handle] = await window.showOpenFilePicker({
                types: [{ description: 'OpenScene project', accept: { 'application/json': [PROJECT_EXT, '.json'] } }],
                multiple: false,
              });
              this.currentHandle = handle;
              const file = await handle.getFile();
              json = await file.text(); fname = handle.name;
            } catch (e) {
              if (e && e.name === 'AbortError') return false;
              throw e;
            }
          } else {
            const file = await this._pickFile('application/json,' + PROJECT_EXT + ',.json');
            if (!file) return false;
            json = await file.text(); fname = file.name;
          }
        }
        const project = OS.model.deserialize(json);
        await this._loadProject(project, fname);
        return true;
      } catch (e) {
        console.error(e);
        app.dialogs.toast('Could not open project: ' + e.message, 'error', 9000);
        return false;
      }
    }

    async _loadProject(project, fname) {
      const app = this.app;
      project.name = fname ? fname.replace(/\.(osceneproj|json)$/i, '') : project.name || 'Untitled Project';
      app.media.disposeAll();
      app.project = project;
      app.player.attach(project, app.media);
      app.timeline.selection.clear();
      app.timeline.refreshHeaders();
      app.timeline.zoomToFit();
      app.player.setPreviewScale(app.previewScale || 1);
      app.player.requestRender();
      app.events.emit('project-loaded', project);
      app.bin.refresh();
      app.properties.showClip(null, []);
      app.commands.clear();
      this.dirty = false;
      app.updateTitle();
      app.setStatus('Opened ' + project.name);
      // restore each asset's File from IndexedDB (or mark missing)
      let missing = 0, restored = 0;
      for (const asset of project.assets) {
        app.media.registerExisting(asset);
        if (asset.fileKey) {
          const rec = await app.media.restoreFile(asset);
          if (rec && !rec.missing) restored++;
          else missing++;
        } else { asset.missing = true; missing++; }
      }
      app.events.emit('media-relinked', null);
      app.bin.refresh();
      if (missing) {
        app.dialogs.toast(`Restored ${restored} media item(s); ${missing} need relinking.`, 'warn', 8000);
        this._offerRelink(project);
      } else if (restored) {
        app.dialogs.toast(`Project loaded with ${restored} media item(s) restored from local storage.`, 'info', 4500);
      }
    }

    async _offerRelink(project) {
      const app = this.app;
      const missing = project.assets.filter((a) => a.missing);
      if (!missing.length) return;
      const want = await app.dialogs.confirm('Relink missing media',
        `${missing.length} media item(s) are not available locally. Select the files now to relink them?`, { okLabel: 'Select files…', cancelLabel: 'Later' });
      if (!want) return;
      const files = this.native ? await this._nativePickMany() : await this._pickMany();
      if (!files || !files.length) return;
      let linked = 0;
      for (const asset of missing) {
        const match = matchFile(files, asset.name);
        if (match) { app.media.relinkFile(asset, match); linked++; }
      }
      app.bin.refresh();
      app.dialogs.toast(`Relinked ${linked} of ${missing.length} item(s).`, linked === missing.length ? 'info' : 'warn', 6000);
      app.player.requestRender();
    }

    async relinkAsset(asset) {
      const app = this.app;
      let file = null;
      if (this.native) {
        const files = await this._nativePickMany();
        file = files && files[0];
      } else {
        file = await this._pickFile(OS.media.ACCEPT_ATTR);
      }
      if (!file) return;
      app.media.relinkFile(asset, file);
      app.bin.refresh();
      app.properties.refreshAsset();
      app.player.requestRender();
      app.setStatus('Relinked ' + asset.name);
    }

    /* ---------- helpers ---------- */

    _download(blob, filename) {
      // iOS Safari cannot write blob: URLs to disk from a page, so hand the file
      // to the system share sheet (Save to Files / AirDrop / Photos) when it is
      // offered. Best effort only: every failure falls back to a plain download.
      if (U.isIOS() && typeof navigator.canShare === 'function' && typeof File === 'function') {
        let file = null;
        try { file = new File([blob], filename, { type: blob.type || 'application/octet-stream' }); } catch (_) { file = null; }
        if (file && navigator.canShare({ files: [file] })) {
          try {
            navigator.share({ files: [file], title: filename })
              .catch((err) => { if (!err || err.name !== 'AbortError') this._anchorDownload(blob, filename); });
            return;
          } catch (_) { /* not inside a user gesture — fall through */ }
        }
      }
      this._anchorDownload(blob, filename);
    }

    _anchorDownload(blob, filename) {
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 30000);
    }

    async saveBlob(blob, filename, container) {
      const app = this.app;
      if (this.native) {
        const res = await this.native.saveExport({ buffer: await blob.arrayBuffer(), suggestedName: filename });
        if (res && !res.canceled) { app.setStatus('Exported to ' + (res.filePath || filename)); return { path: res.filePath }; }
        return { canceled: true };
      }
      if (window.showSaveFilePicker) {
        try {
          const handle = await window.showSaveFilePicker({ suggestedName: filename });
          const w = await handle.createWritable();
          await w.write(blob);
          await w.close();
          app.setStatus('Exported to ' + handle.name);
          return { path: handle.name };
        } catch (e) {
          if (e && e.name === 'AbortError') return { canceled: true };
        }
      }
      this._download(blob, filename);
      app.setStatus('Exported ' + filename);
      return { downloaded: true };
    }

    _pickFile(accept, multiple = false) {
      return new Promise((resolve) => {
        const input = el('input', { type: 'file', accept, multiple });
        input.style.display = 'none';
        document.body.appendChild(input);
        on(input, 'change', () => { const f = multiple ? [...input.files] : input.files[0]; input.remove(); resolve(f); });
        window.addEventListener('focus', () => setTimeout(() => { if (input.isConnected) { input.remove(); resolve(multiple ? [] : null); } }, 500), { once: true });
        input.click();
      });
    }
    _pickMany() { return this._pickFile(OS.media.ACCEPT_ATTR, true); }
    async _nativePickMany() {
      const r = await this.native.pickFiles({ multiple: true });
      return this.app._toFiles(r || []);
    }

    async pickImportFiles() {
      if (this.native) {
        const files = await this.native.pickFiles({ multiple: true });
        return this.app._toFiles(files || []);
      }
      if (window.showOpenFilePicker) {
        try {
          const handles = await window.showOpenFilePicker({
            multiple: true,
            excludeAcceptAllOption: false,
            types: [{
              description: 'All media (video, audio, images)',
              accept: {
                'video/*': OS.media.EXTS_FOR('video'),
                'audio/*': OS.media.EXTS_FOR('audio'),
                'image/*': OS.media.EXTS_FOR('image'),
              },
            }],
          });
          const out = [];
          for (const h of handles) out.push(await h.getFile());
          return out;
        } catch (e) {
          if (e && e.name === 'AbortError') return [];
        }
      }
      const files = await this._pickMany();
      return files || [];
    }

    async _rememberPath(path) {
      try {
        const list = (await OS.media.idbGet('kv', RECENTS_KEY)) || [];
        const next = [path, ...list.filter((p) => p !== path)].slice(0, 12);
        await OS.media.idbPut('kv', RECENTS_KEY, next);
        this.app.events.emit('recents-changed', next);
      } catch (e) {}
    }
    async getRecents() { try { return (await OS.media.idbGet('kv', RECENTS_KEY)) || []; } catch (e) { return []; } }

    async recoveryPrompt() {
      const saved = await this.readAutosave();
      if (!saved || !saved.json) return;
      const age = Math.round((Date.now() - saved.at) / 60000);
      const when = age < 1 ? 'less than a minute ago' : age < 60 ? `${age} minute(s) ago` : `${Math.round(age / 60)} hour(s) ago`;
      const want = await this.app.dialogs.confirm('Recover autosave',
        `An autosave of “${saved.name || 'Untitled'}” from ${when} was found. Recover it?`, { okLabel: 'Recover', cancelLabel: 'Discard' });
      if (want) {
        const project = OS.model.deserialize(saved.json);
        await this._loadProject(project, (saved.name || 'Recovered project') + PROJECT_EXT);
        this.app.dialogs.toast('Autosave recovered.', 'info');
      } else {
        await this.clearAutosave();
      }
    }
  }

  function matchFile(files, name) {
    const base = (name || '').toLowerCase();
    const exact = files.find((f) => f.name.toLowerCase() === base);
    if (exact) return exact;
    const stem = base.replace(/\.[^.]+$/, '');
    return files.find((f) => f.name.toLowerCase().replace(/\.[^.]+$/, '') === stem) || null;
  }

  OS.persist = { Persist, PROJECT_EXT, matchFile };
})();
