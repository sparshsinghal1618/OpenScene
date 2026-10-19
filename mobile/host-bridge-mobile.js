/* OpenScene — mobile host bridge (Android / iOS).
   Injected by the native mobile shells before any page script runs.

   Mirrors native/host-bridge.js: it exposes exactly the same window.openscene
   API that js/persist.js consumes, so the web app gains real native file
   dialogs and real filesystem access without any platform-specific code in the
   app itself.

   Transport (one JSON string channel, provided by the native shell):
     JS  -> native : window.OpenSceneHost.post(jsonString)
     native -> JS  : window.__opensceneReply(jsonString)

   The method names and the chunked binary protocol are identical to the Windows
   WebView2 host, so the native side can be ported one-for-one:
     app:quit  app:info
     project:save  project:open  project:openPath
     files:pick  file:open  file:chunk  file:close
     export:begin  export:chunk  export:end

   On Android the shell exposes window.OpenSceneHost via addJavascriptInterface
   and sets window.__openscenePlatform = 'android'.
   On iOS the shell adds a WKScriptMessageHandler named 'openscene' and sets
   window.__openscenePlatform = 'ios' before injecting this file.
*/
(function () {
  'use strict';

  /* The Windows host also defines window.openscene; never clobber it. */
  if (window.openscene) return;

  var host = window.OpenSceneHost;
  if (!host || typeof host.post !== 'function') return;

  /* 1 MiB per message: @JavascriptInterface and WKScriptMessage round trips are
     cheaper in smaller payloads than the 2 MiB the desktop host uses. */
  var CHUNK = 1 * 1024 * 1024;
  var pending = {};
  var nextId = 1;

  function call(method, args) {
    return new Promise(function (resolve, reject) {
      var id = nextId++;
      pending[id] = { resolve: resolve, reject: reject };
      try {
        host.post(JSON.stringify({ id: id, method: method, args: args || {} }));
      } catch (e) {
        delete pending[id];
        reject(e);
      }
    });
  }

  /* Called by the native shell whenever an RPC completes. */
  window.__opensceneReply = function (json) {
    var msg = json;
    if (typeof msg === 'string') {
      try { msg = JSON.parse(msg); } catch (e) { return; }
    }
    if (!msg || msg.id == null) return;
    var p = pending[msg.id];
    if (!p) return;
    delete pending[msg.id];
    if (msg.error) p.reject(new Error(msg.error));
    else p.resolve(msg.result);
  };

  function b64ToBytes(b64) {
    var bin = atob(b64);
    var n = bin.length;
    var out = new Uint8Array(n);
    for (var i = 0; i < n; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  function bytesToB64(u8) {
    var s = '';
    var step = 0x8000;
    for (var i = 0; i < u8.length; i += step) {
      s += String.fromCharCode.apply(null, u8.subarray(i, Math.min(u8.length, i + step)));
    }
    return btoa(s);
  }

  function concat(parts, total) {
    var out = new Uint8Array(total);
    var o = 0;
    for (var i = 0; i < parts.length; i++) { out.set(parts[i], o); o += parts[i].length; }
    return out;
  }

  window.openscene = {
    isHost: true,
    platform: window.__openscenePlatform || 'mobile',
    versions: { host: window.__opensceneHostName || 'mobile' },

    quit: function () { return call('app:quit', {}); },
    info: function () { return call('app:info', {}); },

    /* --- projects --- */
    saveProject: function (opts) { return call('project:save', opts || {}); },
    openProject: function () { return call('project:open', {}); },
    openProjectPath: function (path) { return call('project:openPath', { path: path }); },

    /* --- media --- */
    pickFiles: function (opts) { return call('files:pick', opts || {}); },
    readFile: function (path) {
      return call('file:open', { path: path }).then(function (opened) {
        if (!opened || opened.id == null) {
          throw new Error((opened && opened.error) || ('cannot open ' + path));
        }
        var parts = [];
        var total = 0;
        function pump() {
          return call('file:chunk', { id: opened.id, offset: total, length: CHUNK }).then(function (c) {
            if (!c) return null;
            if (c.b64 && c.b64.length) {
              var bytes = b64ToBytes(c.b64);
              parts.push(bytes);
              total += bytes.length;
            }
            if (c.eof) return null;
            return pump();
          });
        }
        function done() {
          return call('file:close', { id: opened.id }).then(
            function () { return concat(parts, total); },
            function () { return concat(parts, total); }
          );
        }
        return pump().then(done);
      });
    },

    /* --- exports --- */
    saveExport: function (opts) {
      opts = opts || {};
      return call('export:begin', { suggestedName: opts.suggestedName }).then(function (begin) {
        if (!begin || begin.canceled) return { canceled: true };
        var buf = opts.buffer;
        var u8 = (buf instanceof Uint8Array) ? buf : new Uint8Array(buf);
        var chain = Promise.resolve();
        for (var off = 0; off < u8.length; off += CHUNK) {
          (function (o) {
            chain = chain.then(function () {
              return call('export:chunk', {
                id: begin.id,
                b64: bytesToB64(u8.subarray(o, Math.min(u8.length, o + CHUNK))),
              });
            });
          })(off);
        }
        return chain.then(function () { return call('export:end', { id: begin.id }); });
      });
    },
  };
})();
