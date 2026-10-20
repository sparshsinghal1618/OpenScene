/* OpenScene — native Windows host (WebView2)
 *
 * A real Win32 desktop application: a native resizable window with a native icon,
 * native Windows file dialogs (Open / Save / multi-select Import), and Chromium's
 * engine rendering the OpenScene editor through the WebView2 runtime that ships with
 * Windows 10/11.
 *
 * The editor itself lives in the folder next to this executable and is served to the
 * WebView over the virtual https origin https://openscene.app so the page runs in a
 * secure context (required for WebCodecs, MediaRecorder and IndexedDB) with no file://
 * restrictions.
 *
 * Compiled with the in-box compiler (C# 5), so this file deliberately avoids C# 6+
 * syntax: no string interpolation, no null-conditional operator, no expression-bodied
 * members, no nameof, no auto-property initialisers.
 *
 * Usage:
 *   OpenScene.exe [--devtools] [--fullscreen] [--selftest] [--out=<file>]
 *                [--export-out=<file>] [--appdir=<dir>] [--version] [--help]
 */

using System;
using System.Collections.Generic;
using System.Drawing;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading.Tasks;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace OpenScene
{
    internal sealed class WriteHandle
    {
        public FileStream Stream;
        public string Path;
        public WriteHandle(FileStream stream, string path) { Stream = stream; Path = path; }
    }

    internal sealed class Options
    {
        public bool SelfTest;
        public bool DevTools;
        public bool FullScreen;
        public bool Help;
        public bool Version;
        public string Out;
        public string ExportOut;
        public string AppDir;
    }

    internal static class Program
    {
        internal const string Version = "1.0.0";
        internal const string Product = "OpenScene";

        [DllImport("kernel32.dll")]
        private static extern bool AttachConsole(int dwProcessId);

        [DllImport("kernel32.dll")]
        private static extern bool AllocConsole();

        private static Options Parse(string[] args)
        {
            Options o = new Options();
            for (int i = 0; i < args.Length; i++)
            {
                string a = args[i];
                string lower = a.ToLowerInvariant();
                if (lower == "--selftest" || lower == "/selftest") o.SelfTest = true;
                else if (lower == "--devtools" || lower == "/devtools" || lower == "-d") o.DevTools = true;
                else if (lower == "--fullscreen" || lower == "/fullscreen") o.FullScreen = true;
                else if (lower == "--help" || lower == "-h" || lower == "/?" || lower == "/help") o.Help = true;
                else if (lower == "--version" || lower == "-v" || lower == "/version") o.Version = true;
                else if (lower.StartsWith("--out=")) o.Out = a.Substring(6).Trim('"');
                else if (lower.StartsWith("--export-out=")) o.ExportOut = a.Substring(13).Trim('"');
                else if (lower.StartsWith("--appdir=")) o.AppDir = a.Substring(9).Trim('"');
            }
            return o;
        }

        [STAThread]
        private static void Main(string[] args)
        {
            Options opts = Parse(args);

            if (opts.SelfTest || opts.ExportOut != null)
            {
                if (!AttachConsole(-1)) AllocConsole();
            }

            if (opts.Help)
            {
                Console.WriteLine(Usage());
                return;
            }
            if (opts.Version)
            {
                Console.WriteLine(Product + " " + Version);
                return;
            }

            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);

            try
            {
                Application.Run(new MainForm(opts));
            }
            catch (Exception ex)
            {
                MessageBox.Show("OpenScene could not start.\n\n" + ex.Message,
                    "OpenScene", MessageBoxButtons.OK, MessageBoxIcon.Error);
                Environment.ExitCode = 2;
            }
        }

        internal static string Usage()
        {
            return Product + " " + Version + " — native Windows host\r\n" +
                "\r\n" +
                "Usage: OpenScene.exe [options]\r\n" +
                "\r\n" +
                "  --devtools            enable the developer tools (F12)\r\n" +
                "  --fullscreen          start in fullscreen preview mode\r\n" +
                "  --selftest            run the built-in self-test, write a report and exit\r\n" +
                "  --out=<file>          where --selftest writes its JSON report\r\n" +
                "  --export-out=<file>   write exports to this path without asking\r\n" +
                "  --appdir=<dir>        the folder containing index.html\r\n" +
                "  --version             print the version and exit\r\n" +
                "  --help                print this message and exit\r\n";
        }
    }

    internal sealed class MainForm : Form
    {
        private const string VirtualHost = "openscene.app";
        private const string BaseUrl = "https://openscene.app/index.html";

        private readonly Options _opt;
        private readonly object _ioLock = new object();
        private readonly Dictionary<string, FileStream> _readers =
            new Dictionary<string, FileStream>();
        private readonly Dictionary<string, WriteHandle> _writers =
            new Dictionary<string, WriteHandle>();

        private WebView2 _web;
        private string _appDir;
        private string _lastProjectPath;
        private long _handleSeq;
        private bool _booted;
        private bool _selfTestStarted;
        private bool _reported;
        private string _baseUrl = BaseUrl;

        public MainForm(Options opt)
        {
            _opt = opt;

            Text = Program.Product;
            BackColor = Color.FromArgb(11, 13, 17);
            StartPosition = FormStartPosition.CenterScreen;
            KeyPreview = false;

            try { Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath); }
            catch (Exception) { }

            Rectangle wa = Screen.PrimaryScreen.WorkingArea;
            int w = Math.Min(1600, Math.Max(1024, wa.Width - 60));
            int h = Math.Min(1000, Math.Max(640, wa.Height - 60));
            MinimumSize = new Size(900, 560);
            ClientSize = new Size(w, h);
        }

        protected override void OnLoad(EventArgs e)
        {
            base.OnLoad(e);
            if (_opt.FullScreen) WindowState = FormWindowState.Maximized;

            _appDir = ResolveAppDir(_opt.AppDir);
            if (_appDir == null)
            {
                MessageBox.Show(
                    "OpenScene could not find its editor files.\n\n" +
                    "index.html has to sit in the same folder as OpenScene.exe.\n" +
                    "If you moved the executable, move the whole folder with it.",
                    "OpenScene", MessageBoxButtons.OK, MessageBoxIcon.Error);
                Close();
                return;
            }

            _web = new WebView2();
            _web.Dock = DockStyle.Fill;
            _web.DefaultBackgroundColor = Color.FromArgb(11, 13, 17);
            Controls.Add(_web);

            Boot();
        }

        /* ------------------------------------------------------------------ */
        /*  startup                                                            */
        /* ------------------------------------------------------------------ */

        private async void Boot()
        {
            try
            {
                string userData = System.IO.Path.Combine(
                    Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                    "OpenScene", "WebView2");
                Directory.CreateDirectory(userData);

                CoreWebView2EnvironmentOptions envOpts = new CoreWebView2EnvironmentOptions();
                envOpts.AdditionalBrowserArguments =
                    "--autoplay-policy=no-user-gesture-required" +
                    " --disable-features=Translate,msEdgeSidebarV2,msEdgeIdentityDefaultBrowser,msSmartScreenProtection" +
                    " --disable-sync --no-first-run --no-default-browser-check";
                envOpts.Language = "en-US";

                CoreWebView2Environment env =
                    await CoreWebView2Environment.CreateAsync(null, userData, envOpts);
                await _web.EnsureCoreWebView2Async(env);
            }
            catch (Exception ex)
            {
                ShowRuntimeProblem(ex);
                return;
            }

            CoreWebView2 core = _web.CoreWebView2;
            Configure(core);

            string bridge = ReadBridgeScript();
            if (bridge != null)
            {
                await core.AddScriptToExecuteOnDocumentCreatedAsync(bridge);
            }

            core.SetVirtualHostNameToFolderMapping(
                VirtualHost, _appDir, CoreWebView2HostResourceAccessKind.Allow);

            string url = _baseUrl;
            if (_opt.FullScreen) url = url + "#fullscreen";
            core.Navigate(url);

            _booted = true;
        }

        private void Configure(CoreWebView2 core)
        {
            CoreWebView2Settings s = core.Settings;
            s.IsScriptEnabled = true;
            s.IsWebMessageEnabled = true;
            s.AreDefaultScriptDialogsEnabled = true;
            s.AreHostObjectsAllowed = true;
            s.IsStatusBarEnabled = false;
            s.AreDevToolsEnabled = _opt.DevTools;
            s.IsZoomControlEnabled = false;
            s.IsPasswordAutosaveEnabled = false;
            s.IsGeneralAutofillEnabled = false;
            s.IsSwipeNavigationEnabled = false;
            s.IsPinchZoomEnabled = false;
            s.IsBuiltInErrorPageEnabled = true;
            /* Disables browser chrome keys (F5/Ctrl+R reload, Ctrl+P print, Ctrl+F find,
               F12 devtools, Ctrl+zoom). Text-editing shortcuts (Ctrl+C/V/X, Ctrl+A,
               Ctrl+Z/Y) always stay enabled. */
            s.AreBrowserAcceleratorKeysEnabled = false;

            core.WebMessageReceived += OnWebMessage;
            core.NavigationStarting += OnNavigationStarting;
            core.NavigationCompleted += OnNavigationCompleted;
            core.NewWindowRequested += OnNewWindowRequested;
            core.DocumentTitleChanged += OnDocumentTitleChanged;
            core.ProcessFailed += OnProcessFailed;
            core.PermissionRequested += OnPermissionRequested;
            core.DownloadStarting += OnDownloadStarting;
        }

        private string ReadBridgeScript()
        {
            try
            {
                System.Reflection.Assembly asm = typeof(Program).Assembly;
                using (Stream st = asm.GetManifestResourceStream("host-bridge.js"))
                {
                    if (st == null) return null;
                    using (StreamReader sr = new StreamReader(st, Encoding.UTF8))
                    {
                        return sr.ReadToEnd();
                    }
                }
            }
            catch (Exception) { return null; }
        }

        private static string ResolveAppDir(string overrideDir)
        {
            if (!string.IsNullOrEmpty(overrideDir))
            {
                string full = System.IO.Path.GetFullPath(overrideDir);
                if (File.Exists(System.IO.Path.Combine(full, "index.html"))) return full;
            }
            string dir = AppDomain.CurrentDomain.BaseDirectory;
            for (int i = 0; i < 4 && dir != null; i++)
            {
                if (File.Exists(System.IO.Path.Combine(dir, "index.html"))) return dir;
                DirectoryInfo parent = Directory.GetParent(dir);
                dir = parent == null ? null : parent.FullName;
            }
            return null;
        }

        private void ShowRuntimeProblem(Exception ex)
        {
            string msg =
                "OpenScene needs the Microsoft Edge WebView2 runtime, which is part of\n" +
                "Windows 10 and Windows 11 by default.\n\n" +
                "It appears to be missing on this PC. Install the small free runtime from\n" +
                "https://go.microsoft.com/fwlink/p/?LinkId=2124703 and start OpenScene again.\n\n" +
                "Details: " + ex.Message;
            MessageBox.Show(msg, "OpenScene", MessageBoxButtons.OK, MessageBoxIcon.Warning);
            try
            {
                System.Diagnostics.Process.Start("https://go.microsoft.com/fwlink/p/?LinkId=2124703");
            }
            catch (Exception) { }
            Close();
        }

        /* ------------------------------------------------------------------ */
        /*  navigation policy                                                  */
        /* ------------------------------------------------------------------ */

        private void OnNavigationStarting(object sender, CoreWebView2NavigationStartingEventArgs e)
        {
            string uri = e.Uri == null ? string.Empty : e.Uri;
            if (uri.StartsWith("https://" + VirtualHost + "/", StringComparison.OrdinalIgnoreCase)) return;
            if (uri.StartsWith("blob:", StringComparison.OrdinalIgnoreCase)) return;
            if (uri.StartsWith("data:", StringComparison.OrdinalIgnoreCase)) return;
            if (uri.StartsWith("about:", StringComparison.OrdinalIgnoreCase)) return;

            e.Cancel = true;
            OpenExternally(uri);
        }

        private void OnNewWindowRequested(object sender, CoreWebView2NewWindowRequestedEventArgs e)
        {
            e.Handled = true;
            OpenExternally(e.Uri);
        }

        private static void OpenExternally(string uri)
        {
            if (string.IsNullOrEmpty(uri)) return;
            if (!(uri.StartsWith("http://", StringComparison.OrdinalIgnoreCase) ||
                  uri.StartsWith("https://", StringComparison.OrdinalIgnoreCase))) return;
            try { System.Diagnostics.Process.Start(uri); }
            catch (Exception) { }
        }

        private void OnDocumentTitleChanged(object sender, object e)
        {
            try
            {
                string t = _web.CoreWebView2.DocumentTitle;
                if (!string.IsNullOrEmpty(t)) Text = t;
            }
            catch (Exception) { }
        }

        private void OnProcessFailed(object sender, CoreWebView2ProcessFailedEventArgs e)
        {
            if (e.ProcessFailedKind == CoreWebView2ProcessFailedKind.BrowserProcessExited)
            {
                MessageBox.Show(
                    "The OpenScene renderer stopped unexpectedly. Please start OpenScene again.",
                    "OpenScene", MessageBoxButtons.OK, MessageBoxIcon.Error);
                Close();
            }
        }

        private void OnPermissionRequested(object sender, CoreWebView2PermissionRequestedEventArgs e)
        {
            /* A local editor never needs camera, microphone, geolocation or notifications. */
            e.State = CoreWebView2PermissionState.Deny;
        }

        private void OnDownloadStarting(object sender, CoreWebView2DownloadStartingEventArgs e)
        {
            /* Exports go through the native bridge; anything that still reaches the
               download pipeline is a genuine user download, so leave it alone but keep
               it out of the way of the app window. */
            e.DownloadOperation.StateChanged += delegate { };
        }

        /* ------------------------------------------------------------------ */
        /*  self-test                                                          */
        /* ------------------------------------------------------------------ */

        private async void OnNavigationCompleted(object sender, CoreWebView2NavigationCompletedEventArgs e)
        {
            if (!e.IsSuccess)
            {
                if (_opt.SelfTest) FinishSelfTest(null, "navigation failed: " + e.WebErrorStatus);
                return;
            }
            if (!_opt.SelfTest || _selfTestStarted) return;
            _selfTestStarted = true;

            await Task.Delay(1500);

            string script =
                "(function(){try{" +
                "if(!window.OS||!window.opensceneApp){chrome.webview.postMessage({type:'selftest',error:'app did not boot'});return;}" +
                "Promise.resolve(OS.selftest.run(window.opensceneApp))" +
                ".then(function(r){chrome.webview.postMessage({type:'selftest',result:r});})" +
                ".catch(function(e){chrome.webview.postMessage({type:'selftest',error:String((e&&e.stack)||e)});});" +
                "}catch(e){chrome.webview.postMessage({type:'selftest',error:String((e&&e.stack)||e)});}})();";

            try { await _web.CoreWebView2.ExecuteScriptAsync(script); }
            catch (Exception ex) { FinishSelfTest(null, ex.Message); }
        }

        private void FinishSelfTest(Dictionary<string, object> result, string error)
        {
            if (_reported) return;
            _reported = true;

            string path = _opt.Out;
            if (string.IsNullOrEmpty(path))
            {
                path = System.IO.Path.Combine(
                    Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                    "OpenScene", "selftest-report.json");
            }

            bool ok = false;
            StringBuilder sb = new StringBuilder();
            sb.Append("{\r\n");
            sb.Append("  \"host\": \"webview2\",\r\n");
            sb.Append("  \"version\": \"").Append(Program.Version).Append("\",\r\n");
            sb.Append("  \"platform\": \"").Append(Escape(Environment.OSVersion.ToString())).Append("\",\r\n");

            if (error != null)
            {
                sb.Append("  \"error\": \"").Append(Escape(error)).Append("\",\r\n");
                sb.Append("  \"passed\": 0,\r\n  \"failed\": 1,\r\n  \"results\": []\r\n");
            }
            else
            {
                object passed = null, failed = null, results = null;
                if (result != null)
                {
                    result.TryGetValue("passed", out passed);
                    result.TryGetValue("failed", out failed);
                    result.TryGetValue("results", out results);
                }
                int p = ToInt(passed), f = ToInt(failed);
                ok = (f == 0 && p > 0);
                sb.Append("  \"passed\": ").Append(p).Append(",\r\n");
                sb.Append("  \"failed\": ").Append(f).Append(",\r\n");
                sb.Append("  \"results\": ");
                sb.Append(results == null ? "[]" : Json.Serialize(results));
                sb.Append("\r\n");
            }
            sb.Append("}\r\n");

            try
            {
                Directory.CreateDirectory(System.IO.Path.GetDirectoryName(path));
                File.WriteAllText(path, sb.ToString(), new UTF8Encoding(false));
                Console.WriteLine("[OpenScene] self-test report: " + path);
            }
            catch (Exception ex)
            {
                Console.WriteLine("[OpenScene] could not write report: " + ex.Message);
            }

            if (error != null) Console.WriteLine("[OpenScene] self-test error: " + error);

            Environment.ExitCode = ok ? 0 : 1;
            Console.WriteLine(ok ? "[OpenScene] SELF-TEST PASSED" : "[OpenScene] SELF-TEST FAILED");
            BeginInvoke(new Action(Close));
        }

        /* ------------------------------------------------------------------ */
        /*  RPC                                                                */
        /* ------------------------------------------------------------------ */

        private static readonly System.Web.Script.Serialization.JavaScriptSerializer Json =
            NewSerializer();

        private static System.Web.Script.Serialization.JavaScriptSerializer NewSerializer()
        {
            System.Web.Script.Serialization.JavaScriptSerializer s =
                new System.Web.Script.Serialization.JavaScriptSerializer();
            s.MaxJsonLength = 256 * 1024 * 1024;
            s.RecursionLimit = 64;
            return s;
        }

        private void OnWebMessage(object sender, CoreWebView2WebMessageReceivedEventArgs e)
        {
            Dictionary<string, object> msg = null;
            try { msg = Json.DeserializeObject(e.WebMessageAsJson) as Dictionary<string, object>; }
            catch (Exception) { return; }
            if (msg == null) return;

            object typeObj;
            if (msg.TryGetValue("type", out typeObj) && "selftest".Equals(typeObj))
            {
                object resObj, errObj;
                msg.TryGetValue("result", out resObj);
                msg.TryGetValue("error", out errObj);
                FinishSelfTest(resObj as Dictionary<string, object>, errObj as string);
                return;
            }

            object idObj;
            msg.TryGetValue("id", out idObj);
            object methodObj;
            msg.TryGetValue("method", out methodObj);
            string method = methodObj as string;

            Dictionary<string, object> args = null;
            object argsObj;
            if (msg.TryGetValue("args", out argsObj)) args = argsObj as Dictionary<string, object>;
            if (args == null) args = new Dictionary<string, object>();

            try
            {
                object result = Dispatch(method, args);
                Respond(idObj, result, null);
            }
            catch (Exception ex)
            {
                Respond(idObj, null, ex.Message);
            }
        }

        private void Respond(object id, object result, string error)
        {
            if (_web == null || _web.CoreWebView2 == null) return;
            Dictionary<string, object> payload = new Dictionary<string, object>();
            payload["id"] = id;
            if (error != null) payload["error"] = error;
            else payload["result"] = result;
            try { _web.CoreWebView2.PostWebMessageAsJson(Json.Serialize(payload)); }
            catch (Exception) { }
        }

        private object Dispatch(string method, Dictionary<string, object> args)
        {
            switch (method)
            {
                case "app:quit":
                    BeginInvoke(new Action(Close));
                    return null;
                case "app:info":
                    return Info();
                case "project:save":
                    return ProjectSave(args);
                case "project:open":
                    return ProjectOpenDialog();
                case "project:openPath":
                    return ProjectOpenPath(GetString(args, "path"));
                case "files:pick":
                    return FilesPick(args);
                case "file:open":
                    return FileOpen(GetString(args, "path"));
                case "file:chunk":
                    return FileChunk(args);
                case "file:close":
                    return FileClose(args);
                case "export:begin":
                    return ExportBegin(args);
                case "export:chunk":
                    return ExportChunk(args);
                case "export:end":
                    return ExportEnd(args);
                default:
                    throw new Exception("unknown host method: " + method);
            }
        }

        private Dictionary<string, object> Info()
        {
            Dictionary<string, object> d = new Dictionary<string, object>();
            d["host"] = "webview2";
            d["version"] = Program.Version;
            d["platform"] = "win32";
            d["arch"] = Environment.Is64BitProcess ? "x64" : "x86";
            d["os"] = Environment.OSVersion.VersionString;
            try { d["runtime"] = _web.CoreWebView2.Environment.BrowserVersionString; }
            catch (Exception) { }
            if (_appDir != null) d["appDir"] = _appDir;
            return d;
        }

        /* ------------------------------------------------------------------ */
        /*  project files                                                      */
        /* ------------------------------------------------------------------ */

        private const string ProjectFilter =
            "OpenScene project (*.oscene)|*.oscene|" +
            "OpenShot project (*.osp)|*.osp|" +
            "Legacy OpenScene project (*.osceneproj)|*.osceneproj|" +
            "JSON file (*.json)|*.json|All files (*.*)|*.*";

        private object ProjectSave(Dictionary<string, object> args)
        {
            string json = GetString(args, "json");
            string suggested = GetString(args, "suggestedName");
            bool force = GetBool(args, "force");

            string path = _lastProjectPath;
            if (force || string.IsNullOrEmpty(path))
            {
                using (SaveFileDialog dlg = new SaveFileDialog())
                {
                    dlg.Title = "Save OpenScene project";
                    dlg.Filter = "OpenScene project (*.oscene)|*.oscene|All files (*.*)|*.*";
                    dlg.DefaultExt = "oscene";
                    dlg.AddExtension = true;
                    dlg.OverwritePrompt = true;
                    dlg.FileName = string.IsNullOrEmpty(suggested)
                        ? "Untitled Project.oscene" : suggested;
                    if (dlg.ShowDialog(this) != DialogResult.OK) return Canceled();
                    path = dlg.FileName;
                }
            }

            File.WriteAllText(path, json, new UTF8Encoding(false));
            _lastProjectPath = path;

            Dictionary<string, object> r = new Dictionary<string, object>();
            r["canceled"] = false;
            r["filePath"] = path;
            return r;
        }

        private object ProjectOpenDialog()
        {
            using (OpenFileDialog dlg = new OpenFileDialog())
            {
                dlg.Title = "Open OpenScene project";
                dlg.Filter = ProjectFilter;
                dlg.CheckFileExists = true;
                if (dlg.ShowDialog(this) != DialogResult.OK) return Canceled();
                return ProjectOpenPath(dlg.FileName);
            }
        }

        private object ProjectOpenPath(string path)
        {
            if (string.IsNullOrEmpty(path) || !File.Exists(path))
            {
                Dictionary<string, object> c = Canceled();
                c["error"] = "File not found: " + path;
                return c;
            }
            string json = File.ReadAllText(path, Encoding.UTF8);
            _lastProjectPath = path;

            Dictionary<string, object> r = new Dictionary<string, object>();
            r["canceled"] = false;
            r["json"] = json;
            r["name"] = System.IO.Path.GetFileName(path);
            r["filePath"] = path;
            return r;
        }

        /* ------------------------------------------------------------------ */
        /*  media picking + reading                                            */
        /* ------------------------------------------------------------------ */

        /* Mirrors the format tables in js/media.js. The "All files" entry is the
           safety net: anything picked there is classified by content in the page. */
        private const string MediaFilter =
            "All media files|*.mp4;*.m4v;*.mp4v;*.m4s;*.mov;*.qt;*.3gp;*.3g2;*.3gpp;*.f4v;*.mkv;*.mk3d;*.mka;*.webm;*.avi;*.divx;*.wmv;*.asf;*.dvr-ms;*.wtv;*.mpg;*.mpeg;*.mpe;*.m2v;*.m1v;*.mpv;*.m2p;*.ts;*.mts;*.m2ts;*.m2t;*.ts4;*.tp;*.trp;*.vob;*.ifo;*.mxf;*.dv;*.roq;*.y4m;*.nut;*.ivf;*.bik;*.smk;*.nsv;*.amv;*.flv;*.f4v;*.rm;*.rmvb;*.ogv;*.ogm;*.ogx;*.h264;*.264;*.avc;*.h265;*.265;*.hevc;*.av1;*.vc1;*.mjpeg;*.mjpg;*.r3d;*.braw;*.crm;*.sdp;*.mp3;*.mp2;*.mp1;*.mpa;*.mpga;*.m4a;*.m4b;*.m4r;*.m4p;*.aac;*.adts;*.wav;*.wave;*.bwf;*.aif;*.aiff;*.aifc;*.au;*.snd;*.voc;*.sln;*.gsm;*.caf;*.flac;*.ape;*.wv;*.tta;*.tak;*.shn;*.als;*.alac;*.amr;*.awb;*.spx;*.qcp;*.ogg;*.oga;*.opus;*.weba;*.wma;*.ra;*.ram;*.ac3;*.eac3;*.ec3;*.dts;*.dtshd;*.thd;*.mlp;*.mid;*.midi;*.rmi;*.kar;*.xm;*.it;*.s3m;*.mod;*.mtm;*.png;*.apng;*.jpg;*.jpeg;*.jpe;*.jfif;*.jif;*.jfi;*.webp;*.gif;*.bmp;*.dib;*.avif;*.heic;*.heif;*.hif;*.svg;*.svgz;*.ico;*.cur;*.wbmp;*.tif;*.tiff;*.tga;*.icb;*.vda;*.vst;*.psd;*.psb;*.exr;*.hdr;*.rgbe;*.dds;*.pcx;*.ppm;*.pgm;*.pbm;*.pnm;*.pam;*.pfm;*.xbm;*.xpm;*.ras;*.sun;*.eps;*.ai;*.emf;*.wmf;*.jp2;*.j2k;*.jpx;*.jxl;*.qoi;*.ktx;*.ktx2;*.dng;*.cr2;*.cr3;*.crw;*.nef;*.nrw;*.arw;*.sr2;*.srf;*.orf;*.rw2;*.raw;*.raf;*.pef;*.ptx;*.x3f;*.3fr;*.erf;*.mef;*.mrw;*.rwl;*.srw;*.iiq;*.k25;*.kdc;*.dcr|" +
            "Video|*.mp4;*.m4v;*.mp4v;*.mov;*.qt;*.3gp;*.3g2;*.f4v;*.mkv;*.mk3d;*.webm;*.avi;*.divx;*.wmv;*.asf;*.dvr-ms;*.wtv;*.mpg;*.mpeg;*.mpe;*.m2v;*.m1v;*.mpv;*.ts;*.mts;*.m2ts;*.m2t;*.tp;*.trp;*.vob;*.mxf;*.dv;*.roq;*.y4m;*.nut;*.ivf;*.nsv;*.amv;*.flv;*.rm;*.rmvb;*.ogv;*.ogm;*.h264;*.264;*.avc;*.h265;*.265;*.hevc;*.av1;*.vc1;*.mjpeg;*.mjpg;*.r3d;*.braw;*.crm|" +
            "Audio|*.mp3;*.mp2;*.mp1;*.mpa;*.m4a;*.m4b;*.m4r;*.m4p;*.aac;*.adts;*.wav;*.wave;*.bwf;*.aif;*.aiff;*.aifc;*.au;*.snd;*.voc;*.sln;*.gsm;*.caf;*.flac;*.ape;*.wv;*.tta;*.tak;*.shn;*.alac;*.amr;*.awb;*.spx;*.qcp;*.ogg;*.oga;*.opus;*.weba;*.mka;*.wma;*.ra;*.ram;*.ac3;*.eac3;*.ec3;*.dts;*.dtshd;*.thd;*.mlp;*.mid;*.midi;*.rmi;*.kar;*.xm;*.it;*.s3m;*.mod;*.mtm|" +
            "Images|*.png;*.apng;*.jpg;*.jpeg;*.jpe;*.jfif;*.jif;*.jfi;*.webp;*.gif;*.bmp;*.dib;*.avif;*.heic;*.heif;*.hif;*.svg;*.svgz;*.ico;*.cur;*.wbmp;*.tif;*.tiff;*.tga;*.icb;*.vda;*.vst;*.psd;*.psb;*.exr;*.hdr;*.rgbe;*.dds;*.pcx;*.ppm;*.pgm;*.pbm;*.pnm;*.pam;*.xbm;*.xpm;*.ras;*.eps;*.ai;*.emf;*.wmf;*.jp2;*.j2k;*.jpx;*.jxl;*.qoi;*.ktx;*.ktx2;*.dng;*.cr2;*.cr3;*.crw;*.nef;*.nrw;*.arw;*.sr2;*.srf;*.orf;*.rw2;*.raw;*.raf;*.pef;*.ptx;*.x3f;*.3fr;*.erf;*.mef;*.mrw;*.rwl;*.srw;*.iiq;*.k25;*.kdc;*.dcr|" +
            "All files (*.*)|*.*";

        private object FilesPick(Dictionary<string, object> args)
        {
            List<object> list = new List<object>();
            using (OpenFileDialog dlg = new OpenFileDialog())
            {
                dlg.Title = "Import media into OpenScene";
                dlg.Filter = MediaFilter;
                dlg.Multiselect = GetBoolDefault(args, "multiple", true);
                dlg.CheckFileExists = true;
                if (dlg.ShowDialog(this) != DialogResult.OK) return list;

                string[] names = dlg.FileNames;
                for (int i = 0; i < names.Length; i++)
                {
                    string f = names[i];
                    Dictionary<string, object> d = new Dictionary<string, object>();
                    FileInfo info = new FileInfo(f);
                    d["name"] = info.Name;
                    d["path"] = info.FullName;
                    d["size"] = info.Exists ? info.Length : 0L;
                    d["type"] = MimeFor(info.Extension);
                    list.Add(d);
                }
            }
            return list;
        }

        private object FileOpen(string path)
        {
            if (string.IsNullOrEmpty(path) || !File.Exists(path))
                throw new Exception("cannot open " + path);
            FileStream fs = new FileStream(path, FileMode.Open, FileAccess.Read,
                FileShare.ReadWrite, 1 << 16, FileOptions.SequentialScan);
            string id = NextHandle();
            lock (_ioLock) { _readers[id] = fs; }
            Dictionary<string, object> r = new Dictionary<string, object>();
            r["id"] = id;
            r["size"] = fs.Length;
            return r;
        }

        private object FileChunk(Dictionary<string, object> args)
        {
            string id = GetString(args, "id");
            long offset = GetLong(args, "offset", 0);
            int length = (int)GetLong(args, "length", 2 * 1024 * 1024);
            if (length <= 0) length = 2 * 1024 * 1024;
            if (length > 8 * 1024 * 1024) length = 8 * 1024 * 1024;

            FileStream fs;
            lock (_ioLock)
            {
                if (!_readers.TryGetValue(id, out fs)) throw new Exception("file handle is closed");
            }

            byte[] buf = new byte[length];
            int n = 0;
            lock (_ioLock)
            {
                fs.Seek(offset, SeekOrigin.Begin);
                while (n < length)
                {
                    int k = fs.Read(buf, n, length - n);
                    if (k <= 0) break;
                    n += k;
                }
            }

            Dictionary<string, object> r = new Dictionary<string, object>();
            r["b64"] = Convert.ToBase64String(buf, 0, n);
            r["eof"] = (offset + n) >= fs.Length;
            r["read"] = n;
            return r;
        }

        private object FileClose(Dictionary<string, object> args)
        {
            string id = GetString(args, "id");
            lock (_ioLock)
            {
                FileStream fs;
                if (_readers.TryGetValue(id, out fs))
                {
                    _readers.Remove(id);
                    try { fs.Dispose(); } catch (Exception) { }
                }
            }
            return null;
        }

        /* ------------------------------------------------------------------ */
        /*  exports                                                            */
        /* ------------------------------------------------------------------ */

        private object ExportBegin(Dictionary<string, object> args)
        {
            string suggested = GetString(args, "suggestedName");
            if (string.IsNullOrEmpty(suggested)) suggested = "OpenScene Export.mp4";

            string path;
            if (!string.IsNullOrEmpty(_opt.ExportOut))
            {
                path = _opt.ExportOut;
            }
            else
            {
                using (SaveFileDialog dlg = new SaveFileDialog())
                {
                    dlg.Title = "Export from OpenScene";
                    dlg.FileName = suggested;
                    string ext = System.IO.Path.GetExtension(suggested);
                    if (string.IsNullOrEmpty(ext)) ext = ".mp4";
                    dlg.DefaultExt = ext.TrimStart('.');
                    dlg.AddExtension = true;
                    dlg.OverwritePrompt = true;
                    dlg.Filter = FilterForExport(ext);
                    if (dlg.ShowDialog(this) != DialogResult.OK) return Canceled();
                    path = dlg.FileName;
                }
            }

            FileStream fs = new FileStream(path, FileMode.Create, FileAccess.Write,
                FileShare.None, 1 << 20);
            string id = NextHandle();
            lock (_ioLock) { _writers[id] = new WriteHandle(fs, path); }

            Dictionary<string, object> r = new Dictionary<string, object>();
            r["id"] = id;
            r["filePath"] = path;
            r["canceled"] = false;
            return r;
        }

        private object ExportChunk(Dictionary<string, object> args)
        {
            string id = GetString(args, "id");
            string b64 = GetString(args, "b64");
            if (string.IsNullOrEmpty(b64)) return null;

            byte[] bytes = Convert.FromBase64String(b64);
            lock (_ioLock)
            {
                WriteHandle h;
                if (!_writers.TryGetValue(id, out h)) throw new Exception("export handle is closed");
                h.Stream.Write(bytes, 0, bytes.Length);
            }
            return null;
        }

        private object ExportEnd(Dictionary<string, object> args)
        {
            string id = GetString(args, "id");
            string path = null;
            lock (_ioLock)
            {
                WriteHandle h;
                if (_writers.TryGetValue(id, out h))
                {
                    _writers.Remove(id);
                    path = h.Path;
                    try { h.Stream.Flush(true); } catch (Exception) { }
                    try { h.Stream.Dispose(); } catch (Exception) { }
                }
            }
            Dictionary<string, object> r = new Dictionary<string, object>();
            r["canceled"] = false;
            r["filePath"] = path;
            return r;
        }

        private static string FilterForExport(string ext)
        {
            string e = (ext ?? string.Empty).TrimStart('.').ToLowerInvariant();
            if (e == "mp4") return "MP4 video (*.mp4)|*.mp4|All files (*.*)|*.*";
            if (e == "webm") return "WebM video (*.webm)|*.webm|All files (*.*)|*.*";
            if (e == "m4a") return "M4A audio (*.m4a)|*.m4a|All files (*.*)|*.*";
            if (e == "wav") return "WAV audio (*.wav)|*.wav|All files (*.*)|*.*";
            if (e == "png") return "PNG image (*.png)|*.png|All files (*.*)|*.*";
            if (e == "jpg" || e == "jpeg") return "JPEG image (*.jpg)|*.jpg|All files (*.*)|*.*";
            return "All files (*.*)|*.*";
        }

        /* ------------------------------------------------------------------ */
        /*  helpers                                                            */
        /* ------------------------------------------------------------------ */

        private string NextHandle()
        {
            lock (_ioLock)
            {
                _handleSeq++;
                return "h" + _handleSeq.ToString(CultureInfo.InvariantCulture);
            }
        }

        private static Dictionary<string, object> Canceled()
        {
            Dictionary<string, object> d = new Dictionary<string, object>();
            d["canceled"] = true;
            return d;
        }

        private static string GetString(Dictionary<string, object> d, string key)
        {
            object v;
            if (d != null && d.TryGetValue(key, out v) && v != null) return v as string ?? v.ToString();
            return null;
        }

        private static bool GetBool(Dictionary<string, object> d, string key)
        {
            object v;
            if (d != null && d.TryGetValue(key, out v) && v != null)
            {
                if (v is bool) return (bool)v;
                bool b;
                if (bool.TryParse(v.ToString(), out b)) return b;
            }
            return false;
        }

        private static bool GetBoolDefault(Dictionary<string, object> d, string key, bool fallback)
        {
            object v;
            if (d != null && d.TryGetValue(key, out v) && v != null)
            {
                if (v is bool) return (bool)v;
                bool b;
                if (bool.TryParse(v.ToString(), out b)) return b;
            }
            return fallback;
        }

        private static long GetLong(Dictionary<string, object> d, string key, long fallback)
        {
            object v;
            if (d != null && d.TryGetValue(key, out v) && v != null)
            {
                if (v is long) return (long)v;
                if (v is int) return (int)v;
                if (v is double) return (long)(double)v;
                long l;
                if (long.TryParse(v.ToString(), NumberStyles.Any, CultureInfo.InvariantCulture, out l)) return l;
            }
            return fallback;
        }

        private static int ToInt(object v)
        {
            if (v == null) return 0;
            if (v is int) return (int)v;
            if (v is long) return (int)(long)v;
            if (v is double) return (int)(double)v;
            int i;
            if (int.TryParse(v.ToString(), out i)) return i;
            return 0;
        }

        private static string Escape(string s)
        {
            if (s == null) return string.Empty;
            return Json.Serialize(s).Trim('"');
        }

        private static string MimeFor(string extension)
        {
            string e = (extension ?? string.Empty).TrimStart('.').ToLowerInvariant();
            switch (e)
            {
                case "mp4": case "m4v": case "mp4v": case "m4s": return "video/mp4";
                case "mov": case "qt": return "video/quicktime";
                case "3gp": case "3gpp": return "video/3gpp";
                case "3g2": case "3gpp2": return "video/3gpp2";
                case "webm": return "video/webm";
                case "mkv": case "mk3d": return "video/x-matroska";
                case "avi": return "video/x-msvideo";
                case "divx": return "video/divx";
                case "wmv": return "video/x-ms-wmv";
                case "asf": case "dvr-ms": case "wtv": return "video/x-ms-asf";
                case "mpg": case "mpeg": case "mpe": case "m2v": case "m1v": case "mpv": return "video/mpeg";
                case "ts": case "mts": case "m2ts": case "m2t": case "ts4": case "tp": case "trp": return "video/mp2t";
                case "vob": return "video/dvd";
                case "mxf": return "video/mxf";
                case "dv": return "video/dv";
                case "flv": return "video/x-flv";
                case "f4v": case "f4p": return "video/x-f4v";
                case "ogv": case "ogm": case "ogx": return "video/ogg";
                case "rm": case "rmvb": return "application/vnd.rn-realmedia";
                case "h264": case "264": case "avc": return "video/h264";
                case "h265": case "265": case "hevc": return "video/h265";
                case "av1": return "video/av01";
                case "mjpeg": case "mjpg": case "mjpa": case "mjpb": case "mjp": return "video/x-motion-jpeg";
                case "y4m": case "yuv": return "video/x-raw-yuv";
                case "nut": return "video/x-nut";
                case "ivf": return "video/x-ivf";
                case "r3d": case "braw": case "crm": return "video/x-raw-camera";

                case "mp3": case "mp2": case "mp1": case "mpa": case "mpga": return "audio/mpeg";
                case "m4a": case "m4b": case "m4r": case "m4p": case "mp4a": return "audio/mp4";
                case "mka": return "audio/x-matroska";
                case "aac": case "adts": return "audio/aac";
                case "wav": case "wave": case "bwf": return "audio/wav";
                case "aif": case "aiff": case "aifc": return "audio/aiff";
                case "au": case "snd": return "audio/basic";
                case "voc": return "audio/x-voc";
                case "sln": return "audio/x-sln";
                case "gsm": return "audio/gsm";
                case "caf": return "audio/x-caf";
                case "flac": return "audio/flac";
                case "ape": return "audio/x-ape";
                case "wv": return "audio/x-wavpack";
                case "tta": return "audio/x-tta";
                case "tak": return "audio/x-tak";
                case "shn": return "audio/x-shorten";
                case "alac": return "audio/mp4";
                case "amr": return "audio/amr";
                case "awb": return "audio/amr-wb";
                case "spx": return "audio/ogg";
                case "qcp": return "audio/qcelp";
                case "ogg": case "oga": case "opus": return "audio/ogg";
                case "weba": return "audio/webm";
                case "wma": return "audio/x-ms-wma";
                case "ra": case "ram": return "audio/vnd.rn-realaudio";
                case "ac3": return "audio/ac3";
                case "eac3": case "ec3": return "audio/eac3";
                case "dts": return "audio/vnd.dts";
                case "dtshd": return "audio/vnd.dts.hd";
                case "thd": return "audio/true-hd";
                case "mlp": return "audio/mlp";
                case "mid": case "midi": case "rmi": case "kar": return "audio/midi";
                case "xm": return "audio/x-xm";
                case "it": return "audio/x-it";
                case "s3m": return "audio/x-s3m";
                case "mod": case "mtm": return "audio/x-mod";

                case "png": case "apng": return "image/png";
                case "jpg": case "jpeg": case "jpe": case "jfif": case "jif": case "jfi": return "image/jpeg";
                case "webp": return "image/webp";
                case "gif": return "image/gif";
                case "bmp": case "dib": return "image/bmp";
                case "avif": return "image/avif";
                case "heic": return "image/heic";
                case "heif": case "hif": return "image/heif";
                case "svg": case "svgz": return "image/svg+xml";
                case "ico": case "cur": return "image/x-icon";
                case "wbmp": return "image/vnd.wap.wbmp";
                case "tif": case "tiff": return "image/tiff";
                case "tga": case "icb": case "vda": case "vst": return "image/x-tga";
                case "psd": case "psb": return "image/vnd.adobe.photoshop";
                case "exr": return "image/x-exr";
                case "hdr": case "rgbe": return "image/vnd.radiance";
                case "dds": return "image/vnd.ms-dds";
                case "pcx": return "image/x-pcx";
                case "ppm": return "image/x-portable-pixmap";
                case "pgm": return "image/x-portable-graymap";
                case "pbm": return "image/x-portable-bitmap";
                case "pnm": case "pam": return "image/x-portable-anymap";
                case "pfm": return "image/x-portable-floatmap";
                case "xbm": return "image/x-xbitmap";
                case "xpm": return "image/x-xpixmap";
                case "ras": case "sun": return "image/x-cmu-raster";
                case "eps": case "ai": return "application/postscript";
                case "emf": return "image/emf";
                case "wmf": return "image/wmf";
                case "jp2": case "j2k": return "image/jp2";
                case "jpx": return "image/jpx";
                case "jxl": return "image/jxl";
                case "qoi": return "image/qoi";
                case "ktx": return "image/ktx";
                case "ktx2": return "image/ktx2";
                case "ff": return "image/x-farbfeld";
                case "dng": return "image/x-adobe-dng";
                case "cr2": return "image/x-canon-cr2";
                case "cr3": return "image/x-canon-cr3";
                case "crw": return "image/x-canon-crw";
                case "nef": return "image/x-nikon-nef";
                case "nrw": return "image/x-nikon-nrw";
                case "arw": return "image/x-sony-arw";
                case "sr2": return "image/x-sony-sr2";
                case "srf": return "image/x-sony-srf";
                case "orf": return "image/x-olympus-orf";
                case "rw2": return "image/x-panasonic-rw2";
                case "raw": return "image/x-panasonic-raw";
                case "raf": return "image/x-fuji-raf";
                case "pef": case "ptx": return "image/x-pentax-pef";
                case "x3f": return "image/x-sigma-x3f";
                case "3fr": return "image/x-hasselblad-3fr";
                case "erf": return "image/x-epson-erf";
                case "mef": return "image/x-mamiya-mef";
                case "mrw": return "image/x-minolta-mrw";
                case "rwl": return "image/x-leica-rwl";
                case "srw": return "image/x-samsung-srw";
                case "iiq": return "image/x-phaseone-iiq";
                case "k25": return "image/x-kodak-k25";
                case "kdc": return "image/x-kodak-kdc";
                case "dcr": return "image/x-kodak-dcr";
                default: return "application/octet-stream";
            }
        }

        protected override void OnFormClosed(FormClosedEventArgs e)
        {
            lock (_ioLock)
            {
                foreach (FileStream fs in _readers.Values)
                {
                    try { fs.Dispose(); } catch (Exception) { }
                }
                _readers.Clear();
                foreach (WriteHandle h in _writers.Values)
                {
                    try { h.Stream.Dispose(); } catch (Exception) { }
                }
                _writers.Clear();
            }
            base.OnFormClosed(e);
        }
    }
}
