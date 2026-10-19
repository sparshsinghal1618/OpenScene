/* OpenScene — LocalServer.java
   A tiny loopback HTTP server that serves the bundled web app from
   assets/www over http://127.0.0.1:<port>/.

   Why a server instead of file:// URLs or loadDataWithBaseURL:
     - the app gets a real, stable origin, so IndexedDB (the media store),
       localStorage (autosave) and service workers all behave exactly as they
       do in the desktop app;
     - relative asset paths in index.html keep working untouched;
     - no Content-Security-Policy or opaque-origin surprises.

   Framework only: ServerSocket + AssetManager. No dependencies. */
package app.openscene;

import android.content.Context;
import android.content.res.AssetManager;

import java.io.BufferedInputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.util.HashMap;
import java.util.Map;

final class LocalServer {
  private final AssetManager assets;
  private final String root;
  private final Map<String, String> mime = new HashMap<String, String>();
  private ServerSocket socket;
  private Thread thread;
  private volatile boolean running = false;
  private volatile int port = 0;

  LocalServer(Context ctx, String root) {
    this.assets = ctx.getAssets();
    this.root = root;
    mime.put("html", "text/html; charset=utf-8");
    mime.put("js", "text/javascript; charset=utf-8");
    mime.put("mjs", "text/javascript; charset=utf-8");
    mime.put("css", "text/css; charset=utf-8");
    mime.put("json", "application/json; charset=utf-8");
    mime.put("webmanifest", "application/manifest+json; charset=utf-8");
    mime.put("svg", "image/svg+xml");
    mime.put("png", "image/png");
    mime.put("jpg", "image/jpeg");
    mime.put("jpeg", "image/jpeg");
    mime.put("webp", "image/webp");
    mime.put("gif", "image/gif");
    mime.put("ico", "image/x-icon");
    mime.put("woff2", "font/woff2");
    mime.put("txt", "text/plain; charset=utf-8");
    mime.put("md", "text/markdown; charset=utf-8");
  }

  int start() throws IOException {
    socket = new ServerSocket(0, 24, InetAddress.getByName("127.0.0.1"));
    port = socket.getLocalPort();
    running = true;
    thread = new Thread(new Runnable() {
      @Override public void run() { loop(); }
    }, "openscene-http");
    thread.setDaemon(true);
    thread.start();
    return port;
  }

  int port() { return port; }
  boolean isRunning() { return running; }

  void stop() {
    running = false;
    try { if (socket != null) socket.close(); } catch (IOException ignored) { }
    socket = null;
  }

  private void loop() {
    while (running) {
      Socket s = null;
      try {
        s = socket.accept();
      } catch (IOException e) {
        if (!running) break;
        continue;
      }
      try {
        handle(s);
      } catch (IOException ignored) {
        // a dropped connection is normal when the WebView aborts a request
      } finally {
        try { s.close(); } catch (IOException ignored) { }
      }
    }
  }

  private void handle(Socket s) throws IOException {
    s.setSoTimeout(15000);
    InputStream in = new BufferedInputStream(s.getInputStream());
    String request = readLine(in);
    if (request == null) return;
    String[] parts = request.split(" ");
    String path = parts.length > 1 ? parts[1] : "/";
    // drain the headers
    String h;
    while ((h = readLine(in)) != null && h.length() > 0) { /* keep draining */ }

    int q = path.indexOf('?');
    if (q >= 0) path = path.substring(0, q);
    int hash = path.indexOf('#');
    if (hash >= 0) path = path.substring(0, hash);
    if (path.length() == 0 || path.charAt(0) != '/') path = "/" + path;
    if (path.endsWith("/")) path = path + "index.html";

    OutputStream out = s.getOutputStream();
    byte[] body = null;
    try {
      body = readAll(assets.open(root + path));
    } catch (IOException notFound) {
      body = null;
    }
    if (body == null) {
      byte[] msg = "Not found".getBytes("UTF-8");
      writeHead(out, "404 Not Found", "text/plain; charset=utf-8", msg.length);
      out.write(msg);
    } else {
      writeHead(out, "200 OK", mimeOf(path), body.length);
      out.write(body);
    }
    out.flush();
  }

  private void writeHead(OutputStream out, String status, String type, int length) throws IOException {
    String head = "HTTP/1.1 " + status + "\r\n"
        + "Content-Type: " + type + "\r\n"
        + "Content-Length: " + length + "\r\n"
        + "Cache-Control: no-store\r\n"
        + "Connection: close\r\n"
        + "\r\n";
    out.write(head.getBytes("UTF-8"));
  }

  private String mimeOf(String path) {
    int dot = path.lastIndexOf('.');
    if (dot >= 0) {
      String ext = path.substring(dot + 1).toLowerCase();
      String t = mime.get(ext);
      if (t != null) return t;
    }
    return "application/octet-stream";
  }

  private static String readLine(InputStream in) throws IOException {
    ByteArrayOutputStream buf = new ByteArrayOutputStream(128);
    int c;
    while ((c = in.read()) != -1) {
      if (c == '\n') break;
      if (c == '\r') continue;
      buf.write(c);
      if (buf.size() > 8192) break;
    }
    if (c == -1 && buf.size() == 0) return null;
    return new String(buf.toByteArray(), "UTF-8");
  }

  private static byte[] readAll(InputStream in) throws IOException {
    try {
      ByteArrayOutputStream out = new ByteArrayOutputStream(64 * 1024);
      byte[] buf = new byte[32 * 1024];
      int n;
      while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
      return out.toByteArray();
    } finally {
      try { in.close(); } catch (IOException ignored) { }
    }
  }
}
