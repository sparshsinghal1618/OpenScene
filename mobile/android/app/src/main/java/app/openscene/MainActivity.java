/* OpenScene — MainActivity.java
   Android shell: a full-screen WebView served from a loopback HTTP server, wired
   to the native file bridge.

   The bundled web app is byte-for-byte the same app that ships in the Windows
   build (see sync-assets.ps1), so the editor, effects, transitions, scopes and
   export path are identical on desktop and mobile. */
package app.openscene;

import android.app.Activity;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.database.Cursor;
import android.net.Uri;
import android.os.Bundle;
import android.provider.OpenableColumns;
import android.view.KeyEvent;
import android.view.View;
import android.view.ViewGroup;
import android.view.Window;
import android.view.WindowManager;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import org.json.JSONObject;

import java.io.InputStream;
import java.io.OutputStream;

public class MainActivity extends Activity {
  private static final String ASSET_ROOT = "www";

  private LocalServer server;
  private WebView web;
  private HostBridge bridge;

  @Override protected void onCreate(Bundle state) {
    super.onCreate(state);
    requestWindowFeature(Window.FEATURE_NO_TITLE);
    getWindow().setFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON,
        WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);

    try {
      server = new LocalServer(this, ASSET_ROOT);
      server.start();
    } catch (Exception e) {
      throw new RuntimeException("OpenScene could not start its local server", e);
    }

    web = new WebView(this);
    web.setLayoutParams(new ViewGroup.LayoutParams(
        ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
    web.setBackgroundColor(0xFF0E1116);

    WebSettings s = web.getSettings();
    s.setJavaScriptEnabled(true);
    s.setDomStorageEnabled(true);
    s.setDatabaseEnabled(true);
    s.setMediaPlaybackRequiresUserGesture(false);
    s.setAllowFileAccess(false);
    s.setAllowContentAccess(true);
    s.setSupportZoom(false);
    s.setBuiltInZoomControls(false);
    s.setLoadWithOverviewMode(false);
    s.setUseWideViewPort(false);
    s.setCacheMode(WebSettings.LOAD_NO_CACHE);
    s.setTextZoom(100);

    bridge = new HostBridge(this);
    web.addJavascriptInterface(bridge, "OpenSceneHost");

    final String initJs = "window.__openscenePlatform='android';"
        + "window.__opensceneHostName='android-webview';";
    final String bridgeJs = readAsset("host-bridge-mobile.js");

    web.setWebViewClient(new WebViewClient() {
      @Override public void onPageStarted(WebView view, String url, android.graphics.Bitmap favicon) {
        view.evaluateJavascript(initJs, null);
        if (bridgeJs != null) view.evaluateJavascript(bridgeJs, null);
      }
      @Override public void onPageFinished(WebView view, String url) {
        /* re-inject after a full load so a hard navigation cannot leave the
           page without the bridge */
        if (view.getUrl() != null && view.getUrl().startsWith("http://127.0.0.1")) {
          view.evaluateJavascript(initJs, null);
          if (bridgeJs != null) view.evaluateJavascript(bridgeJs, null);
        }
      }
    });

    setContentView(web);
    web.loadUrl("http://127.0.0.1:" + server.port() + "/index.html");
  }

  @Override protected void onDestroy() {
    if (bridge != null) bridge.shutdown();
    if (server != null) server.stop();
    super.onDestroy();
  }

  @Override protected void onActivityResult(int requestCode, int resultCode, Intent data) {
    super.onActivityResult(requestCode, resultCode, data);
    if (bridge != null) bridge.onActivityResult(requestCode, resultCode, data);
  }

  @Override public boolean onKeyDown(int keyCode, KeyEvent event) {
    if (keyCode == KeyEvent.KEYCODE_BACK && web != null && web.canGoBack()) {
      web.goBack();
      return true;
    }
    return super.onKeyDown(keyCode, event);
  }

  /* ---------------- helpers used by HostBridge ---------------- */

  void evalJs(final String js) {
    if (web == null) return;
    runOnUiThread(new Runnable() {
      @Override public void run() { web.evaluateJavascript(js, null); }
    });
  }

  @Override public void startActivityForResult(Intent intent, int requestCode) {
    super.startActivityForResult(intent, requestCode);
  }

  InputStream openRead(Uri uri) throws Exception {
    if ("file".equals(uri.getScheme()) || uri.getScheme() == null) {
      return new java.io.FileInputStream(uri.getPath());
    }
    InputStream in = getContentResolver().openInputStream(uri);
    if (in == null) throw new Exception("cannot open " + uri);
    return in;
  }

  OutputStream openWrite(Uri uri) throws Exception {
    if ("file".equals(uri.getScheme()) || uri.getScheme() == null) {
      return new java.io.FileOutputStream(uri.getPath());
    }
    /* "wt" truncates: a re-export over the same document must not append. */
    OutputStream out = getContentResolver().openOutputStream(uri, "wt");
    if (out == null) throw new Exception("cannot write " + uri);
    return out;
  }

  void takePersistable(Uri uri) {
    try {
      if (uri == null || uri.getScheme() == null || !"content".equals(uri.getScheme())) return;
      getContentResolver().takePersistableUriPermission(uri,
          Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION);
    } catch (Exception ignored) {
      /* some providers do not offer persistable grants; the session still works */
    }
  }

  String displayName(Uri uri) {
    if (uri == null) return "Untitled Project.osceneproj";
    if ("content".equals(uri.getScheme())) {
      Cursor c = null;
      try {
        c = getContentResolver().query(uri, new String[] { OpenableColumns.DISPLAY_NAME }, null, null, null);
        if (c != null && c.moveToFirst()) {
          String name = c.getString(0);
          if (name != null && name.length() > 0) return name;
        }
      } catch (Exception ignored) {
        // fall through to the last path segment
      } finally {
        if (c != null) c.close();
      }
    }
    String last = uri.getLastPathSegment();
    return last == null ? "Untitled Project.osceneproj" : last;
  }

  String mimeOf(Uri uri) {
    try {
      String m = getContentResolver().getType(uri);
      if (m != null && m.length() > 0) return m;
    } catch (Exception ignored) { }
    return "application/octet-stream";
  }

  /** Reported size only — never read the file itself, media can be huge. */
  long sizeOf(Uri uri) {
    if (uri == null) return -1;
    if ("content".equals(uri.getScheme())) {
      Cursor c = null;
      try {
        c = getContentResolver().query(uri, new String[] { OpenableColumns.SIZE }, null, null, null);
        if (c != null && c.moveToFirst() && !c.isNull(0)) return c.getLong(0);
      } catch (Exception ignored) {
        // fall through
      } finally {
        if (c != null) c.close();
      }
      return -1;
    }
    try {
      return new java.io.File(uri.getPath()).length();
    } catch (Exception e) {
      return -1;
    }
  }

  /** The { path, name, size, type } record the web app expects from pickFiles. */
  JSONObject describe(Uri uri) {
    JSONObject o = new JSONObject();
    try {
      o.put("path", uri.toString());
      o.put("name", displayName(uri));
      o.put("type", mimeOf(uri));
      o.put("size", sizeOf(uri));
    } catch (Exception ignored) { }
    return o;
  }

  String versionName() {
    try {
      return getPackageManager().getPackageInfo(getPackageName(), 0).versionName;
    } catch (PackageManager.NameNotFoundException e) {
      return "1.0.0";
    }
  }

  private String readAsset(String name) {
    try {
      InputStream in = getAssets().open(ASSET_ROOT + "/" + name);
      byte[] bytes = HostBridge.drain(in);
      return new String(bytes, "UTF-8");
    } catch (Exception e) {
      /* fall back to the copy kept outside www so the bridge can never be lost */
      try {
        InputStream in = getAssets().open(name);
        byte[] bytes = HostBridge.drain(in);
        return new String(bytes, "UTF-8");
      } catch (Exception ignored) {
        return null;
      }
    }
  }
}
