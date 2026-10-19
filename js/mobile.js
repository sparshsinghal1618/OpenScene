/* OpenScene — mobile.js
   Touch/small-screen shell. On a phone there is no room for three side-by-side
   panes, so the middle band shows one pane at a time (Preview / Library /
   Inspector) chosen from a bottom bar, and the timeline can be maximised.
   Entirely additive: on a wide screen nothing here engages. */
(() => {
  'use strict';
  const OS = (window.OS = window.OS || {});
  const { on } = OS.util;

  const MOBILE_MQ = '(max-width: 900px)';

  class MobileShell {
    constructor(app) {
      this.app = app;
      this.root = document.getElementById('app');
      this.bar = document.getElementById('mobileBar');
      this.mq = window.matchMedia ? window.matchMedia(MOBILE_MQ) : null;
      this.pane = 'preview';
      this.timelineMax = false;
      this._picked = false;
      this._bind();
      if (this.mq) {
        const handler = () => this._onViewportChange();
        if (this.mq.addEventListener) this.mq.addEventListener('change', handler);
        else if (this.mq.addListener) this.mq.addListener(handler);
      }
      this._apply();
    }

    get active() { return !!(this.mq && this.mq.matches); }

    _bind() {
      if (!this.bar) return;
      for (const btn of this.bar.querySelectorAll('[data-pane]')) {
        on(btn, 'click', () => this.showPane(btn.dataset.pane));
      }
      const tl = this.bar.querySelector('#mbarTimeline');
      if (tl) on(tl, 'click', () => this.toggleTimeline());
    }

    /* Show one of the middle-band panes. No-op on a wide screen. */
    showPane(name, { force = false } = {}) {
      if (!this.active && !force) return;
      if (['preview', 'library', 'props'].indexOf(name) < 0) return;
      this.pane = name;
      this._picked = true;
      this._apply();
    }

    focusPane(name) { if (this.active) this.showPane(name, { force: true }); }

    toggleTimeline(force) {
      this.timelineMax = typeof force === 'boolean' ? force : !this.timelineMax;
      this._apply();
    }

    _onViewportChange() {
      if (this.mq.matches && !this._picked) this.pane = this._defaultPane();
      this._apply();
    }

    _defaultPane() {
      const p = this.app.project;
      if (p && (!p.assets || !p.assets.length) && (!p.tracks || !p.tracks.length)) return 'library';
      return 'preview';
    }

    _apply() {
      if (!this.root) return;
      this.root.dataset.pane = this.pane;
      this.root.classList.toggle('tl-max', !!this.timelineMax);
      if (this.bar) {
        for (const btn of this.bar.querySelectorAll('[data-pane]')) {
          btn.classList.toggle('on', btn.dataset.pane === this.pane);
        }
        const tl = this.bar.querySelector('#mbarTimeline');
        if (tl) tl.classList.toggle('on', !!this.timelineMax);
      }
      // panes come and go, so both canvases need a fresh size measurement
      const app = this.app;
      requestAnimationFrame(() => {
        if (app.timeline && app.timeline.resize) app.timeline.resize();
        if (app.player && app.player.requestRender) app.player.requestRender();
      });
    }
  }

  OS.mobile = { MobileShell, MOBILE_MQ };
})();
