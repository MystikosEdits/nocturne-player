// Talks to the Nocturne engine (127.0.0.1:<port>): one long-lived event stream (/api/events, the same
// one the window uses) for live state, plain POSTs for buttons. Idle cost: one socket that gets a
// small JSON on every state change and a ping every 15 s.
import AppKit
import Foundation

struct Track: Equatable {
    var id: String
    var title: String
    var artist: String
    var thumb: String?
    var like: String
}

final class Player: ObservableObject {
    @Published var track: Track?
    @Published var paused = true
    @Published var loading = false
    @Published var dur: Double = 0
    @Published var connected = false
    @Published var authed = false
    @Published var art: NSImage?
    // position = pos at stamp, moving at `speed` while playing (no timer needed to keep it)
    @Published var pos: Double = 0
    var stamp = Date()
    var speed: Double = 1

    var onChange: (() -> Void)?          // track or play/pause changed (menu tooltip, widget reload)
    private var artCache: [String: NSImage] = [:]
    private var artOrder: [String] = []
    private var artWanted: String?

    func position(at d: Date = Date()) -> Double {
        guard !paused, !loading else { return pos }
        let p = pos + d.timeIntervalSince(stamp) * speed
        return dur > 0 ? min(dur, max(0, p)) : max(0, p)
    }

    func apply(_ s: [String: Any]) {
        let t = s["track"] as? [String: Any]
        let nt: Track? = t.map { t in
            var artist = t["artist"] as? String ?? ""
            if artist.isEmpty, let arts = t["artists"] as? [[String: Any]] {
                artist = arts.compactMap { $0["name"] as? String }.joined(separator: ", ")
            }
            return Track(id: t["id"] as? String ?? "", title: t["title"] as? String ?? "", artist: artist,
                         thumb: t["thumb"] as? String, like: t["like"] as? String ?? "")
        }
        let wasPaused = paused, oldId = track?.id
        let p = s["paused"] as? Bool ?? true
        let l = s["loading"] as? Bool ?? false
        let d = num(s["dur"]) ?? 0
        if paused != p { paused = p }
        if loading != l { loading = l }
        if dur != d { dur = d }
        speed = num(s["speed"]) ?? 1
        if let ts = num(s["ts"]) { stamp = Date(timeIntervalSince1970: ts) } else { stamp = Date() }
        pos = num(s["pos"]) ?? 0
        let a = (s["auth"] as? [String: Any])?["yt"] as? Bool ?? false
        if authed != a { authed = a }
        if nt != track {
            let newArt = nt?.thumb != track?.thumb
            track = nt
            if newArt { loadArt() }
        }
        if oldId != track?.id || wasPaused != paused { onChange?() }
    }

    func setLike(id: String, status: String) {
        if track?.id == id { track?.like = status }
    }

    /// bigger artwork than the 226 px the queue carries (same rewrite as the UI's sizedArt)
    static func sized(_ src: String, _ px: Int) -> String {
        guard src.contains("googleusercontent.com") || src.contains("ggpht.com") else { return src }
        if let r = src.range(of: "=(w\\d+-h\\d+|s\\d+)[^/?#]*$", options: .regularExpression) {
            return src.replacingCharacters(in: r, with: "=w\(px)-h\(px)-l90-rj")
        }
        return src
    }

    private func loadArt() {
        guard let thumb = track?.thumb, !thumb.isEmpty else { art = nil; artWanted = nil; return }
        let src = Player.sized(thumb, 544)
        artWanted = src
        if let img = artCache[src] { art = img; return }
        guard let url = URL(string: src) else { art = nil; return }
        URLSession.shared.dataTask(with: url) { [weak self] data, _, _ in
            let img = data.flatMap { NSImage(data: $0) }
            DispatchQueue.main.async {
                guard let self = self else { return }
                if let img = img {
                    self.artCache[src] = img
                    self.artOrder.append(src)
                    if self.artOrder.count > 6 { self.artCache.removeValue(forKey: self.artOrder.removeFirst()) }
                }
                if self.artWanted == src { self.art = img }
            }
        }.resume()
    }
}

func num(_ v: Any?) -> Double? {
    if let d = v as? Double { return d }
    if let i = v as? Int { return Double(i) }
    if let n = v as? NSNumber { return n.doubleValue }
    return nil
}

final class EngineLink: NSObject, URLSessionDataDelegate {
    let base: URL
    let player: Player
    private var session: URLSession!
    private var task: URLSessionDataTask?
    private var buffer = Data()
    private var retry: Double = 0.5

    init(port: Int, player: Player) {
        base = URL(string: "http://127.0.0.1:\(port)")!
        self.player = player
        super.init()
        let cfg = URLSessionConfiguration.ephemeral
        cfg.timeoutIntervalForRequest = 45          // the engine pings every 15 s
        cfg.timeoutIntervalForResource = 365 * 86400
        cfg.requestCachePolicy = .reloadIgnoringLocalCacheData
        session = URLSession(configuration: cfg, delegate: self, delegateQueue: .main)
    }

    func connect() {
        task?.cancel()
        buffer.removeAll()
        var req = URLRequest(url: base.appendingPathComponent("api/events"))
        req.setValue("text/event-stream", forHTTPHeaderField: "Accept")
        task = session.dataTask(with: req)
        task?.resume()
    }

    func urlSession(_ s: URLSession, dataTask: URLSessionDataTask, didReceive response: URLResponse,
                    completionHandler: @escaping (URLSession.ResponseDisposition) -> Void) {
        let ok = (response as? HTTPURLResponse)?.statusCode == 200
        if ok { retry = 0.5; if !player.connected { player.connected = true } }
        completionHandler(ok ? .allow : .cancel)
    }

    func urlSession(_ s: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        buffer.append(data)
        let sep = Data("\n\n".utf8)
        while let r = buffer.range(of: sep) {
            let chunk = buffer.subdata(in: buffer.startIndex..<r.lowerBound)
            buffer.removeSubrange(buffer.startIndex..<r.upperBound)
            handle(chunk)
        }
    }

    func urlSession(_ s: URLSession, task t: URLSessionTask, didCompleteWithError error: Error?) {
        guard t === task else { return }
        if player.connected { player.connected = false }
        let wait = retry
        retry = min(retry * 2, 5)
        DispatchQueue.main.asyncAfter(deadline: .now() + wait) { [weak self] in self?.connect() }
    }

    private func handle(_ chunk: Data) {
        guard let text = String(data: chunk, encoding: .utf8) else { return }
        var event = "message", data = ""
        for line in text.split(separator: "\n", omittingEmptySubsequences: false) {
            if line.hasPrefix("event:") { event = line.dropFirst(6).trimmingCharacters(in: .whitespaces) }
            else if line.hasPrefix("data:") { data += line.dropFirst(5).trimmingCharacters(in: .whitespaces) }
        }
        guard event == "state" || event == "like", let d = data.data(using: .utf8),
              let obj = try? JSONSerialization.jsonObject(with: d) as? [String: Any] else { return }
        if event == "state" { player.apply(obj) }
        else if let id = obj["id"] as? String { player.setLike(id: id, status: obj["status"] as? String ?? "") }
    }

    // ---------------- commands
    func post(_ path: String, _ body: [String: Any], done: ((Bool) -> Void)? = nil) {
        var req = URLRequest(url: base.appendingPathComponent(path))
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.setValue("1", forHTTPHeaderField: "X-Tempo")
        req.timeoutInterval = 10
        req.httpBody = try? JSONSerialization.data(withJSONObject: body)
        URLSession.shared.dataTask(with: req) { _, resp, _ in
            let ok = (resp as? HTTPURLResponse)?.statusCode == 200
            DispatchQueue.main.async { done?(ok) }
        }.resume()
    }

    func cmd(_ action: String, _ value: Any? = nil) {
        var b: [String: Any] = ["action": action]
        if let v = value { b["value"] = v }
        post("api/cmd", b)
    }
}
