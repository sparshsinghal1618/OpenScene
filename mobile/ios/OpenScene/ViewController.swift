// OpenScene — ViewController.swift
//
// Hosts the editor in a WKWebView served from the loopback server, with the
// native file bridge installed before any page script runs.

import UIKit
import WebKit

final class ViewController: UIViewController {

    private var server: LocalServer?
    private var webView: WKWebView!
    private let bridge = HostBridge()

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = UIColor(red: 0.055, green: 0.067, blue: 0.086, alpha: 1)

        let config = WKWebViewConfiguration()
        config.websiteDataStore = .default()          // persistent IndexedDB + localStorage
        config.mediaTypesRequiringUserActionForPlayback = []
        config.allowsInlineMediaPlayback = true
        config.defaultWebpagePreferences.allowsContentJavaScript = true

        /* The bridge shim goes in first so host-bridge-mobile.js finds
           window.OpenSceneHost when it runs, immediately afterwards. */
        let shim = """
        window.__openscenePlatform = 'ios';
        window.__opensceneHostName = 'ios-wkwebview';
        window.OpenSceneHost = {
          post: function (json) { window.webkit.messageHandlers.openscene.postMessage(json); }
        };
        """
        config.userContentController.addUserScript(WKUserScript(
            source: shim, injectionTime: .atDocumentStart, forMainFrameOnly: true))

        if let bridgeSource = Self.bridgeSource() {
            config.userContentController.addUserScript(WKUserScript(
                source: bridgeSource, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        } else {
            NSLog("[OpenScene] host-bridge-mobile.js missing from the app bundle")
        }

        config.userContentController.add(bridge, name: "openscene")

        webView = WKWebView(frame: .zero, configuration: config)
        webView.translatesAutoresizingMaskIntoConstraints = false
        webView.isOpaque = false
        webView.backgroundColor = .clear
        webView.scrollView.bounces = false
        webView.scrollView.contentInsetAdjustmentBehavior = .never
        webView.allowsBackForwardNavigationGestures = false
        if #available(iOS 16.4, *) { webView.isInspectable = true }

        bridge.webView = webView
        bridge.presenter = self

        view.addSubview(webView)
        NSLayoutConstraint.activate([
            webView.leadingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.leadingAnchor),
            webView.trailingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.trailingAnchor),
            webView.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor),
            webView.bottomAnchor.constraint(equalTo: view.bottomAnchor),
        ])

        do {
            let server = LocalServer()
            guard let started = server else { throw NSError(
                domain: "OpenScene", code: 3,
                userInfo: [NSLocalizedDescriptionKey: "www/ resources missing from the app bundle"]) }
            let port = try started.start()
            self.server = started
            let url = URL(string: "http://127.0.0.1:\(port)/index.html")!
            webView.load(URLRequest(url: url))
        } catch {
            let label = UILabel()
            label.numberOfLines = 0
            label.textAlignment = .center
            label.textColor = .white
            label.text = "OpenScene could not start.\n\n\(error.localizedDescription)"
            label.translatesAutoresizingMaskIntoConstraints = false
            view.addSubview(label)
            NSLayoutConstraint.activate([
                label.centerXAnchor.constraint(equalTo: view.centerXAnchor),
                label.centerYAnchor.constraint(equalTo: view.centerYAnchor),
                label.widthAnchor.constraint(equalTo: view.widthAnchor, multiplier: 0.8),
            ])
        }
    }

    override var prefersStatusBarHidden: Bool { true }
    override var prefersHomeIndicatorAutoHidden: Bool { true }

    override func viewDidDisappear(_ animated: Bool) {
        super.viewDidDisappear(animated)
        /* Media must stop when the app leaves the screen. */
        webView.evaluateJavaScript("window.OS && OS.player && OS.player.pause && OS.player.pause();",
                                   completionHandler: nil)
    }

    deinit {
        bridge.shutdown()
        server?.stop()
    }

    private static func bridgeSource() -> String? {
        let bundle = Bundle.main
        if let url = bundle.url(forResource: "host-bridge-mobile", withExtension: "js", subdirectory: "www")
            ?? bundle.url(forResource: "host-bridge-mobile", withExtension: "js") {
            return try? String(contentsOf: url, encoding: .utf8)
        }
        return nil
    }
}
