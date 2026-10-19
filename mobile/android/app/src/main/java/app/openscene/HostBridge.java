/* OpenScene — HostBridge.java
   The Android half of the window.openscene host bridge.

   The web app (js/persist.js) talks to window.openscene, which is implemented by
   mobile/host-bridge-mobile.js. That shim posts JSON RPC messages to
   window.OpenSceneHost.post(json) and waits for window.__opensceneReply(json).
   This class is the other end of that wire: it implements the same method names
   and the same chunked binary protocol as the Windows WebView2 host, so the
   native side is a direct port.

   Threading: post() arrives on a WebView background thread, RPC work runs on a
   single I/O executor, and evaluateJavascript() is always marshalled back to the
   UI thread. File pickers are launched on the UI thread and their results are
   routed through onActivityResult below.

   Framework only: SAF (no runtime permissions), org.json, android.util.Base64. */
package app.openscene;

import android.app.Activity;
import android.content.Intent;
import android.net.Uri;
import android.os.Handler;
import android.os.Looper;
import android.util.Base64;
import android.webkit.JavascriptInterface;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.HashMap;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicLong;

final class HostBridge {
  static final int REQ_SAVE_PROJECT = 1001;
  static final int REQ_OPEN_PROJECT = 1002;
  static final int REQ_PICK_FILES = 1003;
  static final int REQ_EXPORT = 1004;
  static final int REQ_OPEN_PROJECT_PATH = 1005;

  interface Callback { void onResult(int resultCode, Intent data); }

  private final MainActivity activity;
  private final Handler ui = new Handler(Looper.getMainLooper());
  private final ExecutorService io = Executors.newSingleThreadExecutor();
  private final AtomicLong ids = new AtomicLong(1);
  private final Map<String, InputStream> readers = new HashMap<String, InputStream>();
  private final Map<String, OutputStream> writers = new HashMap<String, OutputStream>();
  private final Map<String, String> exportNames = new HashMap<String, String>();
  private final Map<Integer, Callback> waiting = new HashMap<Integer, Callback>();

  HostBridge(MainActivity activity) {
    this.activity = activity;
  }

  /* ---------------- entry points ---------------- */

  @JavascriptInterface
  public void post(final String json) {
    try {
      final JSONObject msg = new JSONObject(json);
      final long id = msg.getLong("id");
      final String method = msg.getString("method");
      JSONObject a = msg.optJSONObject("args");
      final JSONObject args = a == null ? new JSONObject() : a;
      io.execute(new Runnable() {
        @Override public void run() {
          try {
            dispatch(id, method, args);
          } catch (Exception e) {
            fail(id, String.valueOf(e.getMessage()));
          }
        }
      });
    } catch (Exception ignored) {
      // malformed message: nothing sane to reply to
    }
  }

  void onActivityResult(int requestCode, int resultCode, Intent data) {
    Callback cb;
    synchronized (waiting) { cb = waiting.remove(requestCode); }
    if (cb != null) cb.onResult(resultCode, data);
  }

  void shutdown() {
    io.shutdownNow();
  }

  /* ---------------- dispatch ---------------- */

  private void dispatch(long id, String method, JSONObject args) throws Exception {
    if ("app:info".equals(method)) {
      JSONObject o = new JSONObject();
      o.put("platform", "android");
      o.put("host", "android-webview");
      o.put("sdk", android.os.Build.VERSION.SDK_INT);
      o.put("version", activity.versionName());
      reply(id, o);
    } else if ("app:quit".equals(method)) {
      reply(id, true);
      ui.post(new Runnable() { @Override public void run() { activity.finish(); } });
    } else if ("project:save".equals(method)) {
      saveProject(id, args);
    } else if ("project:open".equals(method)) {
      openProject(id);
    } else if ("project:openPath".equals(method)) {
      openProjectPath(id, args.optString("path", ""));
    } else if ("files:pick".equals(method)) {
      pickFiles(id);
    } else if ("file:open".equals(method)) {
      openFile(id, args.optString("path", ""));
    } else if ("file:chunk".equals(method)) {
      readChunk(id, args);
    } else if ("file:close".equals(method)) {
      closeReader(id, args.optString("id", ""));
    } else if ("export:begin".equals(method)) {
      exportBegin(id, args.optString("suggestedName", "export.mp4"));
    } else if ("export:chunk".equals(method)) {
      exportChunk(id, args);
    } else if ("export:end".equals(method)) {
      exportEnd(id, args.optString("id", ""));
    } else {
      fail(id, "unknown method " + method);
    }
  }

  /* ---------------- projects ---------------- */

  private void saveProject(final long id, JSONObject args) throws Exception {
    final String json = args.optString("json", "");
    final String name = args.optString("suggestedName", "Untitled Project.osceneproj");
    final boolean force = args.optBoolean("force", false);
    final String known = args.optString("path", "");

    if (!force && known.length() > 0) {
      try {
        OutputStream out = activity.openWrite(Uri.parse(known));
        out.write(json.getBytes("UTF-8"));
        out.close();
        JSONObject o = new JSONObject();
        o.put("filePath", known);
        reply(id, o);
        return;
      } catch (Exception ignored) {
        // fall through to the picker
      }
    }

    launchCreate(REQ_SAVE_PROJECT, "application/json", name, new Callback() {
      @Override public void onResult(int resultCode, Intent data) {
        if (resultCode != Activity.RESULT_OK || data == null || data.getData() == null) {
          replyCanceled(id);
          return;
        }
        final Uri uri = data.getData();
        io.execute(new Runnable() {
          @Override public void run() {
            try {
              OutputStream out = activity.openWrite(uri);
              out.write(json.getBytes("UTF-8"));
              out.close();
              activity.takePersistable(uri);
              JSONObject o = new JSONObject();
              o.put("filePath", uri.toString());
              reply(id, o);
            } catch (Exception e) {
              fail(id, String.valueOf(e.getMessage()));
            }
          }
        });
      }
    });
  }

  private void openProject(final long id) {
    Intent i = new Intent(Intent.ACTION_OPEN_DOCUMENT);
    i.addCategory(Intent.CATEGORY_OPENABLE);
    i.setType("*/*");
    i.putExtra(Intent.EXTRA_MIME_TYPES, new String[] { "application/json", "text/plain" });
    launchPicker(REQ_OPEN_PROJECT, i, new Callback() {
      @Override public void onResult(int resultCode, Intent data) {
        if (resultCode != Activity.RESULT_OK || data == null || data.getData() == null) {
          replyCanceled(id);
          return;
        }
        finishOpenProject(id, data.getData(), true);
      }
    });
  }

  private void openProjectPath(final long id, final String path) {
    if (path == null || path.length() == 0) { fail(id, "no path"); return; }
    io.execute(new Runnable() {
      @Override public void run() {
        finishOpenProject(id, Uri.parse(path), false);
      }
    });
  }

  private void finishOpenProject(long id, Uri uri, boolean persistable) {
    try {
      InputStream in = activity.openRead(uri);
      byte[] bytes = drain(in);
      String json = new String(bytes, "UTF-8");
      JSONObject o = new JSONObject();
      o.put("json", json);
      o.put("name", activity.displayName(uri));
      o.put("filePath", uri.toString());
      if (persistable) activity.takePersistable(uri);
      reply(id, o);
    } catch (Exception e) {
      fail(id, String.valueOf(e.getMessage()));
    }
  }

  /* ---------------- media ---------------- */

  private void pickFiles(final long id) {
    Intent i = new Intent(Intent.ACTION_OPEN_DOCUMENT);
    i.addCategory(Intent.CATEGORY_OPENABLE);
    i.setType("*/*");
    i.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
    i.putExtra(Intent.EXTRA_MIME_TYPES, new String[] { "video/*", "audio/*", "image/*" });
    launchPicker(REQ_PICK_FILES, i, new Callback() {
      @Override public void onResult(int resultCode, Intent data) {
        JSONArray out = new JSONArray();
        if (resultCode == Activity.RESULT_OK && data != null) {
          try {
            if (data.getClipData() != null) {
              int n = data.getClipData().getItemCount();
              for (int k = 0; k < n; k++) {
                Uri u = data.getClipData().getItemAt(k).getUri();
                activity.takePersistable(u);
                out.put(activity.describe(u));
              }
            } else if (data.getData() != null) {
              Uri u = data.getData();
              activity.takePersistable(u);
              out.put(activity.describe(u));
            }
          } catch (Exception e) {
            fail(id, String.valueOf(e.getMessage()));
            return;
          }
        }
        reply(id, out);
      }
    });
  }

  private void openFile(long id, String path) {
    if (path == null || path.length() == 0) { fail(id, "no path"); return; }
    try {
      InputStream in = activity.openRead(Uri.parse(path));
      String key = "f" + ids.getAndIncrement();
      synchronized (readers) { readers.put(key, in); }
      JSONObject o = new JSONObject();
      o.put("id", key);
      reply(id, o);
    } catch (Exception e) {
      JSONObject o = new JSONObject();
      try { o.put("error", String.valueOf(e.getMessage())); } catch (Exception ignored) { }
      reply(id, o);
    }
  }

  private void readChunk(long id, JSONObject args) throws Exception {
    String key = args.optString("id", "");
    int length = Math.max(1, args.optInt("length", 1 << 20));
    InputStream in;
    synchronized (readers) { in = readers.get(key); }
    if (in == null) { fail(id, "file not open: " + key); return; }

    byte[] buf = new byte[length];
    int got = 0;
    while (got < length) {
      int n = in.read(buf, got, length - got);
      if (n < 0) break;
      got += n;
    }
    JSONObject o = new JSONObject();
    o.put("eof", got < length);
    if (got > 0) o.put("b64", Base64.encodeToString(buf, 0, got, Base64.NO_WRAP));
    reply(id, o);
  }

  private void closeReader(long id, String key) {
    synchronized (readers) {
      InputStream in = readers.remove(key);
      if (in != null) { try { in.close(); } catch (Exception ignored) { } }
    }
    reply(id, true);
  }

  /* ---------------- exports ---------------- */

  private void exportBegin(final long id, final String suggested) {
    launchCreate(REQ_EXPORT, "video/mp4", suggested, new Callback() {
      @Override public void onResult(int resultCode, Intent data) {
        if (resultCode != Activity.RESULT_OK || data == null || data.getData() == null) {
          replyCanceled(id);
          return;
        }
        final Uri uri = data.getData();
        io.execute(new Runnable() {
          @Override public void run() {
            try {
              OutputStream out = activity.openWrite(uri);
              String key = "e" + ids.getAndIncrement();
              synchronized (writers) {
                writers.put(key, out);
                exportNames.put(key, uri.toString());
              }
              JSONObject o = new JSONObject();
              o.put("id", key);
              o.put("filePath", uri.toString());
              reply(id, o);
            } catch (Exception e) {
              fail(id, String.valueOf(e.getMessage()));
            }
          }
        });
      }
    });
  }

  private void exportChunk(long id, JSONObject args) throws Exception {
    String key = args.optString("id", "");
    OutputStream out;
    synchronized (writers) { out = writers.get(key); }
    if (out == null) { fail(id, "export not open: " + key); return; }
    byte[] bytes = Base64.decode(args.optString("b64", ""), Base64.DEFAULT);
    out.write(bytes);
    reply(id, true);
  }

  private void exportEnd(long id, String key) throws Exception {
    OutputStream out;
    String path;
    synchronized (writers) {
      out = writers.remove(key);
      path = exportNames.remove(key);
    }
    if (out == null) { fail(id, "export not open: " + key); return; }
    out.flush();
    out.close();
    JSONObject o = new JSONObject();
    o.put("filePath", path == null ? "" : path);
    reply(id, o);
  }

  /* ---------------- plumbing ---------------- */

  private void launchCreate(int requestCode, String mime, String name, Callback cb) {
    Intent i = new Intent(Intent.ACTION_CREATE_DOCUMENT);
    i.addCategory(Intent.CATEGORY_OPENABLE);
    i.setType(mime);
    if (name != null && name.length() > 0) i.putExtra(Intent.EXTRA_TITLE, name);
    launchPicker(requestCode, i, cb);
  }

  private void launchPicker(final int requestCode, final Intent intent, Callback cb) {
    synchronized (waiting) { waiting.put(requestCode, cb); }
    ui.post(new Runnable() {
      @Override public void run() { activity.startActivityForResult(intent, requestCode); }
    });
  }

  void reply(long id, Object result) {
    try {
      JSONObject o = new JSONObject();
      o.put("id", id);
      o.put("result", result);
      send(o.toString());
    } catch (Exception ignored) { }
  }

  private void replyCanceled(long id) {
    try {
      JSONObject o = new JSONObject();
      o.put("id", id);
      JSONObject res = new JSONObject();
      res.put("canceled", true);
      o.put("result", res);
      send(o.toString());
    } catch (Exception ignored) { }
  }

  private void fail(long id, String message) {
    try {
      JSONObject o = new JSONObject();
      o.put("id", id);
      o.put("error", message == null ? "unknown error" : message);
      send(o.toString());
    } catch (Exception ignored) { }
  }

  private void send(final String payload) {
    ui.post(new Runnable() {
      @Override public void run() { activity.evalJs("window.__opensceneReply(" + JSONObject.quote(payload) + ")"); }
    });
  }

  static byte[] drain(InputStream in) throws Exception {
    try {
      ByteArrayOutputStream out = new ByteArrayOutputStream(64 * 1024);
      byte[] buf = new byte[32 * 1024];
      int n;
      while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
      return out.toByteArray();
    } finally {
      try { in.close(); } catch (Exception ignored) { }
    }
  }
}
