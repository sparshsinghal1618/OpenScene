// OpenScene — HostBridge.swift
//
// The iOS half of the window.openscene host bridge.
//
// mobile/host-bridge-mobile.js posts JSON RPC messages to
// window.OpenSceneHost.post(json) and waits for window.__opensceneReply(json).
// Here that channel is a WKScriptMessageHandler named "openscene" (the shim that
// wires window.OpenSceneHost to it is installed by ViewController as a user
// script, so the bridge JS file is byte-for-byte the same as Android's).
//
// Method names and the chunked binary protocol are identical to the Windows
// WebView2 host and the Android shell.
//
// iOS note on saving: UIDocumentPickerViewController cannot stream to a
// destination of the app's choosing, so exports and project saves are staged in
// a temporary file and then handed to the export picker. The RPC contract is
// unchanged — the web app still sees export:begin / export:chunk / export:end.

import Foundation
import UIKit
import WebKit
import UniformTypeIdentifiers

final class HostBridge: NSObject, WKScriptMessageHandler, UIDocumentPickerDelegate {

    weak var webView: WKWebView?
    weak var presenter: UIViewController?

    private let io = DispatchQueue(label: "app.openscene.io")
    private var readers: [String: InputStream] = [:]
    private var readersScoped: [String: URL] = [:]
    private var writers: [String: OutputStream] = [:]
    private var staged: [String: URL] = [:]
    private var nextId = 1

    /// Pending document-picker completion handlers, in presentation order.
    private var pickerCompletion: (([URL]) -> Void)?
    private var pickerMultiple = false

    private let bookmarkKey = "app.openscene.bookmarks"

    // MARK: - RPC entry point

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.name == "openscene",
              let text = message.body as? String,
              let data = text.data(using: .utf8),
              let msg = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
              let id = msg["id"] as? Int,
              let method = msg["method"] as? String else { return }
        let args = msg["args"] as? [String: Any] ?? [:]
        io.async { [weak self] in
            guard let self = self else { return }
            do { try self.dispatch(id: id, method: method, args: args) }
            catch { self.fail(id, error.localizedDescription) }
        }
    }

    func shutdown() {
        for (_, s) in readers { s.close() }
        for (_, url) in readersScoped { url.stopAccessingSecurityScopedResource() }
        readers.removeAll()
        readersScoped.removeAll()
        for (_, s) in writers { s.close() }
        writers.removeAll()
    }

    // MARK: - dispatch

    private func dispatch(id: Int, method: String, args: [String: Any]) throws {
        switch method {
        case "app:info":
            reply(id, [
                "platform": "ios",
                "host": "ios-wkwebview",
                "version": (Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String) ?? "1.0.0",
            ])
        case "app:quit":
            reply(id, true)

        case "project:save":
            try saveProject(id, args)
        case "project:open":
            openProject(id)
        case "project:openPath":
            try openProjectPath(id, args["path"] as? String ?? "")

        case "files:pick":
            pickFiles(id)
        case "file:open":
            try openFile(id, args["path"] as? String ?? "")
        case "file:chunk":
            try readChunk(id, args)
        case "file:close":
            closeReader(id, args["id"] as? String ?? "")

        case "export:begin":
            try exportBegin(id, args["suggestedName"] as? String ?? "export.mp4")
        case "export:chunk":
            try exportChunk(id, args)
        case "export:end":
            try exportEnd(id, args["id"] as? String ?? "")

        default:
            fail(id, "unknown method \(method)")
        }
    }

    // MARK: - projects

    private func saveProject(_ id: Int, _ args: [String: Any]) throws {
        let json = args["json"] as? String ?? ""
        let name = args["suggestedName"] as? String ?? "Untitled Project.osceneproj"
        let force = args["force"] as? Bool ?? false
        let known = args["path"] as? String ?? ""

        if !force, !known.isEmpty, let url = resolveBookmark(known) {
            let scoped = url.startAccessingSecurityScopedResource()
            defer { if scoped { url.stopAccessingSecurityScopedResource() } }
            try json.write(to: url, atomically: true, encoding: .utf8)
            reply(id, ["filePath": known])
            return
        }

        let temp = try stage(json.data(using: .utf8) ?? Data(), name: name)
        presentExport(temp, name: name) { [weak self] url in
            guard let self = self else { return }
            if let url = url {
                self.rememberBookmark(url, key: self.key(for: url))
                self.reply(id, ["filePath": self.key(for: url)])
            } else {
                self.replyCanceled(id)
            }
            try? FileManager.default.removeItem(at: temp)
        }
    }

    private func openProject(_ id: Int) {
        presentOpen(types: [.json, .plainText], multiple: false) { [weak self] urls in
            guard let self = self else { return }
            guard let url = urls.first else { self.replyCanceled(id); return }
            self.finishOpenProject(id, url)
        }
    }

    private func openProjectPath(_ id: Int, _ path: String) throws {
        guard !path.isEmpty else { throw err("no path") }
        guard let url = resolveBookmark(path) ?? URL(string: path) else { throw err("cannot resolve \(path)") }
        finishOpenProject(id, url)
    }

    private func finishOpenProject(_ id: Int, _ url: URL) {
        let scoped = url.startAccessingSecurityScopedResource()
        defer { if scoped { url.stopAccessingSecurityScopedResource() } }
        do {
            let data = try Data(contentsOf: url)
            let json = String(decoding: data, as: UTF8.self)
            let key = key(for: url)
            rememberBookmark(url, key: key)
            reply(id, ["json": json, "name": url.lastPathComponent, "filePath": key])
        } catch {
            fail(id, error.localizedDescription)
        }
    }

    // MARK: - media

    private func pickFiles(_ id: Int) {
        presentOpen(types: [.movie, .audio, .image], multiple: true) { [weak self] urls in
            guard let self = self else { return }
            var out: [[String: Any]] = []
            for url in urls {
                let key = self.key(for: url)
                self.rememberBookmark(url, key: key)
                var record: [String: Any] = ["path": key, "name": url.lastPathComponent]
                if let values = try? url.resourceValues(forKeys: [.contentTypeKey, .fileSizeKey]) {
                    if let type = values.contentType { record["type"] = type.preferredMIMEType ?? "application/octet-stream" }
                    if let size = values.fileSize { record["size"] = size }
                }
                out.append(record)
            }
            self.reply(id, out)
        }
    }

    private func openFile(_ id: Int, _ path: String) throws {
        guard let url = resolveBookmark(path) ?? URL(string: path) else {
            reply(id, ["error": "cannot resolve \(path)"])
            return
        }
        let scoped = url.startAccessingSecurityScopedResource()
        guard let stream = InputStream(url: url) else {
            if scoped { url.stopAccessingSecurityScopedResource() }
            reply(id, ["error": "cannot open \(path)"])
            return
        }
        stream.open()
        let key = "f\(takeId())"
        readers[key] = stream
        if scoped { readersScoped[key] = url }
        reply(id, ["id": key])
    }

    private func readChunk(_ id: Int, _ args: [String: Any]) throws {
        let key = args["id"] as? String ?? ""
        guard let stream = readers[key] else { throw err("file not open: \(key)") }
        let length = max(1, args["length"] as? Int ?? (1 << 20))

        var buffer = [UInt8](repeating: 0, count: length)
        var got = 0
        while got < length {
            let n = buffer.withUnsafeMutableBytes { ptr -> Int in
                stream.read(ptr.baseAddress!.advanced(by: got).assumingMemoryBound(to: UInt8.self), maxLength: length - got)
            }
            if n <= 0 { break }
            got += n
        }
        var result: [String: Any] = ["eof": got < length]
        if got > 0 {
            result["b64"] = Data(buffer[0..<got]).base64EncodedString()
        }
        reply(id, result)
    }

    private func closeReader(_ id: Int, _ key: String) {
        if let stream = readers.removeValue(forKey: key) { stream.close() }
        if let url = readersScoped.removeValue(forKey: key) { url.stopAccessingSecurityScopedResource() }
        reply(id, true)
    }

    // MARK: - exports

    private func exportBegin(_ id: Int, _ suggested: String) throws {
        let temp = try stage(Data(), name: suggested)
        guard let stream = OutputStream(url: temp, append: true) else { throw err("cannot stage export") }
        stream.open()
        let key = "e\(takeId())"
        writers[key] = stream
        staged[key] = temp
        reply(id, ["id": key, "filePath": temp.path])
    }

    private func exportChunk(_ id: Int, _ args: [String: Any]) throws {
        let key = args["id"] as? String ?? ""
        guard let stream = writers[key] else { throw err("export not open: \(key)") }
        guard let data = Data(base64Encoded: args["b64"] as? String ?? "") else { throw err("bad chunk") }
        var written = 0
        while written < data.count {
            let n = data.withUnsafeBytes { ptr -> Int in
                stream.write(ptr.baseAddress!.advanced(by: written).assumingMemoryBound(to: UInt8.self),
                             maxLength: data.count - written)
            }
            if n <= 0 { throw err("write failed") }
            written += n
        }
        reply(id, true)
    }

    private func exportEnd(_ id: Int, _ key: String) throws {
        guard let stream = writers.removeValue(forKey: key) else { throw err("export not open: \(key)") }
        stream.close()
        guard let temp = staged.removeValue(forKey: key) else { throw err("no staged file") }
        let name = temp.lastPathComponent
        presentExport(temp, name: name) { [weak self] url in
            guard let self = self else { return }
            if let url = url {
                self.rememberBookmark(url, key: self.key(for: url))
                self.reply(id, ["filePath": self.key(for: url)])
            } else {
                self.replyCanceled(id)
            }
            try? FileManager.default.removeItem(at: temp)
        }
    }

    // MARK: - document pickers

    private func presentOpen(types: [UTType], multiple: Bool, completion: @escaping ([URL]) -> Void) {
        DispatchQueue.main.async { [weak self] in
            guard let self = self, let presenter = self.presenter else { completion([]); return }
            self.pickerCompletion = completion
            self.pickerMultiple = multiple
            let picker = UIDocumentPickerViewController(forOpeningContentTypes: types, asCopy: false)
            picker.allowsMultipleSelection = multiple
            picker.delegate = self
            presenter.present(picker, animated: true)
        }
    }

    private func presentExport(_ fileURL: URL, name: String, completion: @escaping (URL?) -> Void) {
        DispatchQueue.main.async { [weak self] in
            guard let self = self, let presenter = self.presenter else { completion(nil); return }
            self.pickerCompletion = { urls in completion(urls.first) }
            self.pickerMultiple = false
            let picker = UIDocumentPickerViewController(forExporting: [fileURL], asCopy: true)
            picker.delegate = self
            presenter.present(picker, animated: true)
        }
    }

    func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) {
        let cb = pickerCompletion
        pickerCompletion = nil
        cb?(urls)
    }

    func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) {
        let cb = pickerCompletion
        pickerCompletion = nil
        cb?([])
    }

    // MARK: - staging + bookmarks

    private func stage(_ data: Data, name: String) throws -> URL {
        let dir = FileManager.default.temporaryDirectory
            .appendingPathComponent("openscene-stage", isDirectory: true)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let url = dir.appendingPathComponent(name.isEmpty ? "OpenScene.mp4" : name)
        try data.write(to: url)
        return url
    }

    /// The web app treats "path" as an opaque string, so a bookmark key is used.
    private func key(for url: URL) -> String {
        return "bookmark:" + url.absoluteString
    }

    private func rememberBookmark(_ url: URL, key: String) {
        guard let data = try? url.bookmarkData() else { return }
        var store = UserDefaults.standard.dictionary(forKey: bookmarkKey) as? [String: Data] ?? [:]
        store[key] = data
        UserDefaults.standard.set(store, forKey: bookmarkKey)
    }

    private func resolveBookmark(_ key: String) -> URL? {
        let store = UserDefaults.standard.dictionary(forKey: bookmarkKey) as? [String: Data] ?? [:]
        guard let data = store[key] else { return nil }
        var stale = false
        return try? URL(resolvingBookmarkData: data, bookmarkDataIsStale: &stale)
    }

    // MARK: - plumbing

    private func takeId() -> Int {
        nextId += 1
        return nextId
    }

    private func reply(_ id: Int, _ result: Any) {
        send(["id": id, "result": result])
    }

    private func replyCanceled(_ id: Int) {
        send(["id": id, "result": ["canceled": true]])
    }

    private func fail(_ id: Int, _ message: String) {
        send(["id": id, "error": message])
    }

    private func send(_ object: [String: Any]) {
        guard JSONSerialization.isValidJSONObject(object),
              let data = try? JSONSerialization.data(withJSONObject: object),
              let json = String(data: data, encoding: .utf8) else { return }
        /* Build a JS string literal by round-tripping a one-element JSON array. */
        guard let litData = try? JSONSerialization.data(withJSONObject: [json]),
              let lit = String(data: litData, encoding: .utf8) else { return }
        let literal = String(lit.dropFirst().dropLast())
        let js = "window.__opensceneReply(\(literal));"
        DispatchQueue.main.async { [weak self] in
            self?.webView?.evaluateJavaScript(js, completionHandler: nil)
        }
    }

    private func err(_ message: String) -> NSError {
        NSError(domain: "OpenScene", code: 2, userInfo: [NSLocalizedDescriptionKey: message])
    }
}
