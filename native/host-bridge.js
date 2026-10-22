/* OpenScene — native host bridge.
   Injected by the Windows WebView2 host before any page script runs, and exposes
   the same window.openscene API the mobile host bridge provides, so js/persist.js
   works unchanged and gets real Windows file dialogs.

   Transport: request/response RPC over chrome.webview.postMessage, with binary
   payloads (media files, exports) transferred as base64 in chunks so multi-hundred
   megabyte files never materialise as one giant string. */
(function () {
  'use strict';

  var host = window.chrome && window.chrome.webview;
  if (!host) return;

  var CHUNK = 2 * 1024 * 1024;
  var pending = {};
  var nextId = 1;

  function call(method, args) {
    return new Promise(function (resolve, reject) {
      var id = nextId++;
      pending[id] = { resolve: resolve, reject: reject };
      try {
        host.postMessage({ id: id, method: method, args: args || {} });
      } catch (e) {
        delete pending[id];
        reject(e);
      }
    });
  }

  host.addEventListener('message', function (e) {
    var msg = e.data;
    if (typeof msg === 'string') {
      try { msg = JSON.parse(msg); } catch (err) { return; }
    }
    if (!msg || msg.id == null) return;
    var p = pending[msg.id];
    if (!p) return;
    delete pending[msg.id];
    if (msg.error) p.reject(new Error(msg.error));
    else p.resolve(msg.result);
  });

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
    platform: 'win32',
    versions: { host: 'webview2' },

    quit: function () { return call('app:quit', {}); },
    info: function () { return call('app:info', {}); },

    /* --- projects --- */
    saveProject: function (opts) { return call('project:save', opts || {}); },
    openProject: function () { return call('project:open', {}); },
    openProjectPath: function (path) { return call('project:openPath', { path: path }); },

    /* --- media --- */
    pickFiles: function (opts) { return call('files:pick', opts || {}); },
    /* Stream files from disk directly via the host's WebResource handler so
       the browser handles range requests. Only the header is needed for
       probing duration/resolution, and nothing is base64-copied. */
    readFile: function (path) {
      try {
        var b64path = btoa(unescape(encodeURIComponent(path))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
        var url = 'https://openscene.app/localfile/' + b64path + '/' + encodeURIComponent((path.split(/[\\/]/).pop()) || 'file');
        return fetch(url).then(function (res) { return res.blob(); }).then(function (blob) {
          var name = (path.split(/[\\/]/).pop()) || 'file';
          return new File([blob], name, { type: blob.type || 'application/octet-stream' });
        });
      } catch (e) {
        return Promise.reject(e);
      }
    },
    streamUrl: function (path) {
      try {
        var b64path = btoa(unescape(encodeURIComponent(path))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
        var name = (path.split(/[\\/]/).pop()) || 'file';
        return 'https://openscene.app/localfile/' + b64path + '/' + encodeURIComponent(name);
      } catch (e) {
        return null;
      }
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
