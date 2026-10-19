// OpenScene — LocalServer.swift
//
// A loopback HTTP server that serves the bundled web app from the app bundle so
// the phone gets a real, stable http origin. That matters: IndexedDB (the media
// store), localStorage (autosave) and service worker behaviour are then
// identical to the desktop build, which file:// URLs and custom URL schemes
// cannot deliver reliably.
//
// Network.framework only — no third-party dependencies.

import Foundation
import Network

final class LocalServer {
    private let queue = DispatchQueue(label: "app.openscene.http")
    private var listener: NWListener?
    private(set) var port: UInt16 = 0

    /// Directory to serve. Defaults to www/ inside the app bundle.
    private let root: URL

    init?(root: URL? = nil) {
        if let root = root {
            self.root = root
        } else if let bundled = Bundle.main.url(forResource: "www", withExtension: nil) {
            self.root = bundled
        } else {
            return nil
        }
    }

    func start() throws -> UInt16 {
        let params = NWParameters.tcp
        params.allowLocalEndpointReuse = true
        params.requiredInterfaceType = .loopback

        let listener = try NWListener(using: params, on: .any)
        listener.newConnectionHandler = { [weak self] connection in
            self?.accept(connection)
        }
        listener.stateUpdateHandler = { _ in }
        listener.start(queue: queue)

        // NWListener(.any) resolves asynchronously; spin briefly for the port.
        let deadline = Date().addingTimeInterval(3)
        while listener.port == nil && Date() < deadline {
            usleep(20_000)
        }
        guard let resolved = listener.port else {
            throw NSError(domain: "OpenScene", code: 1,
                          userInfo: [NSLocalizedDescriptionKey: "local server did not bind"])
        }
        self.listener = listener
        self.port = resolved.rawValue
        return self.port
    }

    func stop() {
        listener?.cancel()
        listener = nil
    }

    // MARK: - connection handling

    private func accept(_ connection: NWConnection) {
        connection.start(queue: queue)
        receiveHeaders(connection, buffer: Data())
    }

    private func receiveHeaders(_ connection: NWConnection, buffer: Data) {
        connection.receive(minimumIncompleteLength: 1, maximumLength: 16 * 1024) { [weak self] data, _, isComplete, error in
            guard let self = self else { return }
            var acc = buffer
            if let data = data { acc.append(data) }

            if let range = acc.range(of: Data("\r\n\r\n".utf8)) {
                let head = String(decoding: acc[..<range.lowerBound], as: UTF8.self)
                self.respond(to: head, on: connection)
                return
            }
            if error != nil || isComplete || acc.count > 64 * 1024 {
                connection.cancel()
                return
            }
            self.receiveHeaders(connection, buffer: acc)
        }
    }

    private func respond(to head: String, on connection: NWConnection) {
        let requestLine = head.split(separator: "\r\n", maxSplits: 1).first.map(String.init) ?? ""
        let fields = requestLine.split(separator: " ")
        var path = fields.count > 1 ? String(fields[1]) : "/"

        if let cut = path.firstIndex(where: { $0 == "?" || $0 == "#" }) {
            path = String(path[..<cut])
        }
        path = path.removingPercentEncoding ?? path
        if !path.hasPrefix("/") { path = "/" + path }
        if path.hasSuffix("/") { path += "index.html" }

        // Never escape the served root.
        let parts = path.split(separator: "/").map(String.init).filter { $0 != "." && $0 != ".." }
        var fileURL = root
        for p in parts { fileURL.appendPathComponent(p) }

        let body = try? Data(contentsOf: fileURL)
        let response: Data
        if let body = body {
            response = Self.head(status: "200 OK", type: Self.mime(path), length: body.count) + body
        } else {
            let notFound = Data("Not found".utf8)
            response = Self.head(status: "404 Not Found", type: "text/plain; charset=utf-8",
                                 length: notFound.count) + notFound
        }

        connection.send(content: response, completion: .contentProcessed { _ in
            connection.cancel()
        })
    }

    private static func head(status: String, type: String, length: Int) -> Data {
        let h = "HTTP/1.1 \(status)\r\n"
            + "Content-Type: \(type)\r\n"
            + "Content-Length: \(length)\r\n"
            + "Cache-Control: no-store\r\n"
            + "Connection: close\r\n\r\n"
        return Data(h.utf8)
    }

    private static func mime(_ path: String) -> String {
        switch (path as NSString).pathExtension.lowercased() {
        case "html": return "text/html; charset=utf-8"
        case "js", "mjs": return "text/javascript; charset=utf-8"
        case "css": return "text/css; charset=utf-8"
        case "json": return "application/json; charset=utf-8"
        case "webmanifest": return "application/manifest+json; charset=utf-8"
        case "svg": return "image/svg+xml"
        case "png": return "image/png"
        case "jpg", "jpeg": return "image/jpeg"
        case "webp": return "image/webp"
        case "gif": return "image/gif"
        case "ico": return "image/x-icon"
        case "woff2": return "font/woff2"
        case "txt", "md": return "text/plain; charset=utf-8"
        default: return "application/octet-stream"
        }
    }
}
