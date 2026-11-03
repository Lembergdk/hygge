import SwiftUI
import Observation

/// Shared across inline, sheet and fullscreen views: one live remote session.
@MainActor @Observable
final class LiveBrowserSession {
    let id: String
    let accountToken: String
    var image: UIImage?
    var pageURL = ""
    var viewport = CGSize(width: 1365, height: 900)
    var pointer = CGPoint(x: 0.5, y: 0.5)
    var humanControlled = false
    var ownsControl = false
    var connected = false
    var ended = false
    var busy = false
    var keyboardVisible = false
    var precisionPointer = false
    var problem: String?
    @ObservationIgnored private var request: URLRequest
    @ObservationIgnored private var socket: URLSessionWebSocketTask?
    @ObservationIgnored private var runner: Task<Void, Never>?
    @ObservationIgnored private var sending: Task<Void, Never>?
    @ObservationIgnored private var replies: [String: CheckedContinuation<Void, Error>] = [:]
    @ObservationIgnored private var lastMove = Date.distantPast
    @ObservationIgnored private var scrollDelta = CGPoint.zero
    @ObservationIgnored private var scrollSender: Task<Void, Never>?
    @ObservationIgnored private var viewers = 0
    @ObservationIgnored private var foreground = true
    @ObservationIgnored private var lastResponse = Date.distantPast

    init(id: String, backend: BackendClient) {
        self.id = id
        accountToken = backend.apiToken
        var components = URLComponents(url: backend.baseURL.appendingPathComponent("sessions/\(id)/stream"), resolvingAgainstBaseURL: false)!
        components.scheme = components.scheme == "https" ? "wss" : "ws"
        request = URLRequest(url: components.url!)
        request.setValue("Bearer \(accountToken)", forHTTPHeaderField: "Authorization")
        request.timeoutInterval = 20
    }

    var status: String { ended ? "Finished" : connected ? "Live" : image == nil ? "Connecting…" : "Reconnecting…" }

    func watch() async {
        viewers += 1
        start()
        defer { viewers -= 1; if viewers == 0 { stop() } }
        do { while !Task.isCancelled { try await Task.sleep(for: .seconds(60)) } } catch {}
    }
    func setForeground(_ value: Bool) {
        foreground = value
        if value { start() } else { stop() }
    }
    func reconnect() { ended = false; problem = nil; stop(); start() }
    private func start() {
        guard runner == nil, viewers > 0, foreground, !ended else { return }
        runner = Task { [weak self] in
            while !Task.isCancelled {
                guard let self, !self.ended else { return }
                let ws = URLSession.shared.webSocketTask(with: self.request)
                self.socket = ws
                self.lastResponse = .now
                ws.resume()
                let heartbeat = Task { [weak self] in
                    while !Task.isCancelled {
                        do { try await Task.sleep(for: .seconds(5)) } catch { return }
                        guard let self else { return }
                        if Date.now.timeIntervalSince(self.lastResponse) > 15 {
                            ws.cancel(with: .goingAway, reason: nil); return
                        }
                        self.send(["type": "ping"])
                    }
                }
                do {
                    while !Task.isCancelled {
                        let message = try await ws.receive()
                        guard self.socket === ws else { break }
                        let data: Data
                        switch message { case .data(let value): data = value
                        case .string(let value): data = Data(value.utf8)
                        @unknown default: continue }
                        self.receive(data)
                    }
                } catch {
                    if !Task.isCancelled && !self.ended { self.problem = "Reconnecting to the browser…" }
                }
                heartbeat.cancel()
                guard self.socket === ws else { return }
                self.connected = false
                self.ownsControl = false
                self.keyboardVisible = false
                self.failReplies()
                guard !Task.isCancelled, !self.ended else { return }
                do { try await Task.sleep(for: .seconds(2)) } catch { return }
            }
        }
    }
    private func stop() {
        runner?.cancel(); runner = nil
        sending?.cancel(); sending = nil
        scrollSender?.cancel(); scrollSender = nil; scrollDelta = .zero
        socket?.cancel(with: .goingAway, reason: nil); socket = nil
        connected = false; ownsControl = false; keyboardVisible = false
        failReplies()
    }
    private func failReplies() {
        let pending = replies; replies.removeAll()
        for reply in pending.values { reply.resume(throwing: URLError(.networkConnectionLost)) }
    }
    private func receive(_ data: Data) {
        guard let value = try? JSONSerialization.jsonObject(with: data) as? [String: Any], let type = value["type"] as? String else { return }
        lastResponse = .now
        switch type {
        case "frame":
            if let base64 = value["data"] as? String, let bytes = Data(base64Encoded: base64), let frame = UIImage(data: bytes) {
                image = frame; connected = true; problem = nil
            }
            send(["type": "ack"])
        case "pong": if image != nil { connected = true }
        case "state":
            pageURL = value["url"] as? String ?? pageURL
            if let w = value["width"] as? Double, let h = value["height"] as? Double { viewport = CGSize(width: w, height: h) }
            humanControlled = value["humanControlled"] as? Bool ?? false
            if !humanControlled { ownsControl = false; keyboardVisible = false }
            if let p = value["pointer"] as? [String: Double], let x = p["x"], let y = p["y"] { pointer = CGPoint(x: x, y: y) }
        case "focus": if ownsControl { keyboardVisible = value["keyboard"] as? Bool ?? false }
        case "controlled", "released":
            ownsControl = type == "controlled"
            if let id = value["requestID"] as? String { replies.removeValue(forKey: id)?.resume() }
        case "error":
            problem = value["message"] as? String ?? "The browser action couldn’t finish."
            if let id = value["requestID"] as? String { replies.removeValue(forKey: id)?.resume(throwing: URLError(.cannotLoadFromNetwork)) }
        case "ended": ended = true; connected = false; ownsControl = false; keyboardVisible = false
        default: break
        }
    }
    func send(_ payload: [String: Any]) {
        guard let socket, let bytes = try? JSONSerialization.data(withJSONObject: payload), let text = String(data: bytes, encoding: .utf8) else { return }
        let previous = sending
        sending = Task { [weak self] in
            await previous?.value
            guard !Task.isCancelled else { return }
            do { try await socket.send(.string(text)) }
            catch { self?.connected = false; socket.cancel(with: .goingAway, reason: nil) }
        }
    }
    private func transfer(_ type: String) async -> Bool {
        guard connected, !busy else { return false }
        busy = true; problem = nil
        defer { busy = false }
        let requestID = UUID().uuidString
        do {
            try await withCheckedThrowingContinuation { continuation in
                replies[requestID] = continuation
                send(["type": type, "requestID": requestID])
                Task { [weak self] in
                    try? await Task.sleep(for: .seconds(25))
                    self?.replies.removeValue(forKey: requestID)?.resume(throwing: URLError(.timedOut))
                }
            }
            return true
        } catch { if problem == nil { problem = "The handoff wasn’t confirmed. Reconnect before continuing." }; return false }
    }
    func resize(_ size: CGSize) {
        guard connected, size.width > 100, size.height > 100 else { return }
        let width = Int(size.width.rounded()), height = Int(size.height.rounded())
        guard abs(viewport.width - size.width) > 2 || abs(viewport.height - size.height) > 2 else { return }
        send(["type": "viewport", "width": width, "height": height])
    }
    func takeControl() async -> Bool { await transfer("takeControl") }
    func handBack() async -> Bool { keyboardVisible = false; return await transfer("releaseControl") }
    func input(_ payload: [String: Any]) {
        guard connected, ownsControl, !busy else { return }
        if payload["type"] as? String == "pointer", payload["phase"] as? String == "move" {
            guard Date.now.timeIntervalSince(lastMove) > 1.0 / 30 else { return }
            lastMove = .now
        }
        if payload["type"] as? String == "scroll" {
            scrollDelta.x += payload["dx"] as? CGFloat ?? 0
            scrollDelta.y += payload["dy"] as? CGFloat ?? 0
            guard scrollSender == nil else { return }
            scrollSender = Task { [weak self] in
                do { try await Task.sleep(for: .milliseconds(33)) } catch { return }
                guard let self else { return }
                let delta = self.scrollDelta; self.scrollDelta = .zero; self.scrollSender = nil
                if self.connected && self.ownsControl { self.send(["type": "scroll", "dx": max(-3000, min(3000, delta.x)), "dy": max(-3000, min(3000, delta.y))]) }
            }
            return
        }
        send(payload)
    }
}
