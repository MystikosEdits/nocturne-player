// The menu-bar panel and the desktop player (SwiftUI). Both read the same Player model.
import AppKit
import SwiftUI

/// Buttons and toggles the views call; implemented by the app delegate.
final class Controls: ObservableObject {
    let player: Player
    let link: EngineLink
    @Published var deskShown = false
    @Published var deskOnTop = false
    var openApp: () -> Void = {}
    var quitApp: () -> Void = {}
    var setDesk: (Bool) -> Void = { _ in }
    var setDeskOnTop: (Bool) -> Void = { _ in }

    init(player: Player, link: EngineLink) { self.player = player; self.link = link }

    func toggle() { player.paused.toggle(); link.cmd("toggle") }   // optimistic; the engine confirms
    func next() { link.cmd("next") }
    func prev() { link.cmd("prev") }
    func seek(_ t: Double) {
        player.pos = t
        player.stamp = Date()
        link.cmd("seek", t)
    }
    func like() {
        guard let t = player.track else { return }
        let status = t.like == "LIKE" ? "INDIFFERENT" : "LIKE"
        player.setLike(id: t.id, status: status)
        link.post("api/like", ["id": t.id, "status": status])
    }
}

func clock(_ s: Double) -> String {
    guard s.isFinite, s >= 0 else { return "0:00" }
    let t = Int(s.rounded(.down))
    return t >= 3600 ? String(format: "%d:%02d:%02d", t / 3600, t / 60 % 60, t % 60) : String(format: "%d:%02d", t / 60, t % 60)
}

struct Artwork: View {
    let image: NSImage?
    let size: CGFloat
    var radius: CGFloat = 10
    var body: some View {
        ZStack {
            if let img = image {
                Image(nsImage: img).resizable().interpolation(.high).aspectRatio(contentMode: .fill)
            } else {
                LinearGradient(colors: [Color(red: 0.25, green: 0.16, blue: 0.45), Color(red: 0.08, green: 0.06, blue: 0.18)],
                               startPoint: .topLeading, endPoint: .bottomTrailing)
                Image(systemName: "music.note").font(.system(size: size * 0.3, weight: .light)).foregroundColor(.white.opacity(0.55))
            }
        }
        .frame(width: size, height: size)
        .clipShape(RoundedRectangle(cornerRadius: radius, style: .continuous))
        .shadow(color: .black.opacity(0.25), radius: size > 150 ? 8 : 3, y: 2)
    }
}

/// Hover = soft round highlight, like the system's own media controls.
struct RoundButton: ButtonStyle {
    var pad: CGFloat = 6
    func makeBody(configuration: Configuration) -> some View { Inner(configuration: configuration, pad: pad) }
    struct Inner: View {
        let configuration: Configuration
        let pad: CGFloat
        @StateObject private var h = Flag()
        var body: some View {
            configuration.label
                .padding(pad)
                .background(Circle().fill(Color.primary.opacity(configuration.isPressed ? 0.18 : h.on ? 0.09 : 0)))
                .contentShape(Circle())
                .onHover { h.on = $0 }
        }
    }
}

struct PlayButton: View {
    @ObservedObject var p: Player
    let c: Controls
    let size: CGFloat
    var body: some View {
        Button(action: c.toggle) {
            ZStack {
                Circle().fill(Color.primary)
                if p.loading && !p.paused {
                    ProgressView().controlSize(.small).colorInvert()
                } else {
                    Image(systemName: p.paused ? "play.fill" : "pause.fill")
                        .font(.system(size: size * 0.4, weight: .bold))
                        .foregroundColor(Color(nsColor: .windowBackgroundColor))
                        .offset(x: p.paused ? size * 0.04 : 0)   // a triangle looks centred a hair to the right
                }
            }
            .frame(width: size, height: size)
            .contentShape(Circle())
        }
        .buttonStyle(.plain)
        .help(p.paused ? "Play" : "Pause")
    }
}

// View-local state without @State: in this SDK @State is a macro whose plugin ships only with Xcode,
// and the helper is built with the Command Line Tools alone.
final class Flag: ObservableObject { @Published var on = false }
final class ScrubState: ObservableObject {
    @Published var drag: Double?
    @Published var hover = false
}

struct Scrubber: View {
    @ObservedObject var p: Player
    let c: Controls
    var interval: Double = 0.5
    var showTimes = true
    @StateObject private var st = ScrubState()

    var body: some View {
        TimelineView(.animation(minimumInterval: interval, paused: p.paused || p.loading || st.drag != nil)) { (ctx: TimelineViewDefaultContext) in
            bar(cur: st.drag.map { $0 * p.dur } ?? p.position(at: ctx.date))
        }
    }

    func bar(cur: Double) -> some View {
        let frac = p.dur > 0 ? min(1, max(0, cur / p.dur)) : 0
        let active = st.hover || st.drag != nil
        return VStack(spacing: 3) {
            GeometryReader { g in
                ZStack(alignment: .leading) {
                    Capsule().fill(Color.primary.opacity(0.16))
                    Capsule().fill(Color.primary.opacity(active ? 0.95 : 0.75))
                        .frame(width: max(0, g.size.width * frac))
                }
                .frame(height: active ? 5 : 3)
                .frame(maxHeight: .infinity)
                .contentShape(Rectangle())
                .onHover { st.hover = $0 }
                .gesture(DragGesture(minimumDistance: 0)
                    .onChanged { v in st.drag = min(1, max(0, v.location.x / max(1, g.size.width))) }
                    .onEnded { v in
                        let f = min(1, max(0, v.location.x / max(1, g.size.width)))
                        if p.dur > 0 { c.seek(f * p.dur) }
                        st.drag = nil
                    })
            }
            .frame(height: 10)
            if showTimes {
                HStack {
                    Text(clock(cur))
                    Spacer()
                    Text(clock(p.dur))
                }
                .font(.system(size: 10).monospacedDigit())
                .foregroundColor(.secondary)
            }
        }
    }
}

struct LikeButton: View {
    @ObservedObject var p: Player
    let c: Controls
    var size: CGFloat = 15
    var body: some View {
        let liked = p.track?.like == "LIKE"
        Button(action: c.like) {
            Image(systemName: liked ? "heart.fill" : "heart")
                .font(.system(size: size, weight: .medium))
                .foregroundColor(liked ? Color(red: 0.95, green: 0.33, blue: 0.5) : .secondary)
                .frame(width: size + 6, height: size + 6)
        }
        .buttonStyle(RoundButton(pad: 4))
        .help(liked ? "Remove from Liked music" : "Like")
        .disabled(p.track == nil || !p.authed)
        .opacity(p.authed ? 1 : 0)
    }
}

struct TransportRow: View {
    @ObservedObject var p: Player
    let c: Controls
    var play: CGFloat = 42
    var skip: CGFloat = 17
    var spacing: CGFloat = 22
    var body: some View {
        HStack(spacing: spacing) {
            Button(action: c.prev) {
                Image(systemName: "backward.fill").font(.system(size: skip)).frame(width: skip + 8, height: skip + 8)
            }.buttonStyle(RoundButton()).help("Previous")
            PlayButton(p: p, c: c, size: play)
            Button(action: c.next) {
                Image(systemName: "forward.fill").font(.system(size: skip)).frame(width: skip + 8, height: skip + 8)
            }.buttonStyle(RoundButton()).help("Next")
        }
        .foregroundColor(.primary)
        .disabled(p.track == nil)
    }
}

func headline(_ p: Player) -> (String, String) {
    if let t = p.track { return (t.title, t.artist) }
    return p.connected ? ("Nothing playing", "Pick something in Nocturne") : ("Nocturne isn't running", "Open it to start listening")
}

// ---------------------------------------------------------------- menu-bar panel
struct PanelView: View {
    @ObservedObject var p: Player
    @ObservedObject var c: Controls

    var body: some View {
        let (title, sub) = headline(p)
        VStack(spacing: 12) {
            Artwork(image: p.art, size: 268, radius: 12)
                .onTapGesture { c.openApp() }
                .help("Open Nocturne")
            HStack(alignment: .center, spacing: 8) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(title).font(.system(size: 15, weight: .semibold)).lineLimit(1)
                    Text(sub).font(.system(size: 12.5)).foregroundColor(.secondary).lineLimit(1)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .help(p.track.map { "\($0.title) — \($0.artist)" } ?? "")
                LikeButton(p: p, c: c)
            }
            if p.track != nil {
                Scrubber(p: p, c: c, interval: 0.5)
            }
            TransportRow(p: p, c: c)
            Divider().padding(.top, 2)
            HStack {
                Button(action: c.openApp) {
                    Label("Open Nocturne", systemImage: "macwindow").font(.system(size: 12.5))
                }
                .buttonStyle(RoundRect())
                Spacer()
                Menu {
                    Toggle("Player on desktop", isOn: Binding(get: { c.deskShown }, set: { c.setDesk($0) }))
                    Divider()
                    Button("Quit Nocturne", action: c.quitApp)
                } label: {
                    Image(systemName: "ellipsis.circle").font(.system(size: 14))
                }
                .menuStyle(.borderlessButton)
                .menuIndicator(.hidden)
                .fixedSize()
                .help("More")
            }
        }
        .padding(EdgeInsets(top: 16, leading: 16, bottom: 10, trailing: 16))
        .frame(width: 300)
    }
}

struct RoundRect: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View { Inner(configuration: configuration) }
    struct Inner: View {
        let configuration: Configuration
        @StateObject private var h = Flag()
        var body: some View {
            configuration.label
                .padding(.horizontal, 8).padding(.vertical, 5)
                .background(RoundedRectangle(cornerRadius: 6, style: .continuous)
                    .fill(Color.primary.opacity(configuration.isPressed ? 0.16 : h.on ? 0.08 : 0)))
                .contentShape(Rectangle())
                .onHover { h.on = $0 }
        }
    }
}

// ---------------------------------------------------------------- desktop player (widget-sized)
struct DeskView: View {
    @ObservedObject var p: Player
    @ObservedObject var c: Controls
    var drag: (DragGesture.Value?) -> Void

    var body: some View {
        let (title, sub) = headline(p)
        HStack(spacing: 14) {
            Artwork(image: p.art, size: 112, radius: 10)
                .onTapGesture(count: 2) { c.openApp() }
            VStack(alignment: .leading, spacing: 0) {
                HStack(alignment: .top, spacing: 4) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(title).font(.system(size: 13.5, weight: .semibold)).lineLimit(1)
                        Text(sub).font(.system(size: 11.5)).foregroundColor(.secondary).lineLimit(1)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    LikeButton(p: p, c: c, size: 12)
                }
                Spacer(minLength: 6)
                if p.track != nil { Scrubber(p: p, c: c, interval: 1, showTimes: false) }
                Spacer(minLength: 6)
                TransportRow(p: p, c: c, play: 32, skip: 13, spacing: 14)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            .frame(maxHeight: .infinity)
        }
        .padding(14)
        .frame(width: 344, height: 140)
        .contentShape(Rectangle())
        .gesture(DragGesture(minimumDistance: 3).onChanged { drag($0) }.onEnded { _ in drag(nil) })
        .contextMenu {
            Button(c.deskOnTop ? "Keep on desktop (behind windows)" : "Keep on top of windows") { c.setDeskOnTop(!c.deskOnTop) }
            Button("Open Nocturne", action: c.openApp)
            Divider()
            Button("Hide desktop player") { c.setDesk(false) }
        }
    }
}
