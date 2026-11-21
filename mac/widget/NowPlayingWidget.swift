// Nocturne "Now Playing" widget (small + medium). Built and embedded ONLY when mac/build.sh finds an
// Apple-issued signing identity (Apple Development / Developer ID): macOS's widget daemon (chronod)
// refuses widgets from ad-hoc or self-signed apps ("Ignoring restricted or unknown extension",
// tested Nov 21 2026 on macOS 27). Buttons are links into the menu helper (nocturne-menu://...),
// which forwards them to the engine; the helper reloads the timeline when the song changes.
import SwiftUI
import WidgetKit

struct NowEntry: TimelineEntry {
    let date: Date
    let title: String
    let artist: String
    let paused: Bool
    let running: Bool
    let art: NSImage?
}

struct NowProvider: TimelineProvider {
    func placeholder(in context: Context) -> NowEntry {
        NowEntry(date: .now, title: "Song title", artist: "Artist", paused: true, running: true, art: nil)
    }

    func getSnapshot(in context: Context, completion: @escaping (NowEntry) -> Void) {
        if context.isPreview { completion(placeholder(in: context)); return }
        fetch(completion)
    }

    func getTimeline(in context: Context, completion: @escaping (Timeline<NowEntry>) -> Void) {
        fetch { e in completion(Timeline(entries: [e], policy: .never)) }
    }

    private func fetch(_ done: @escaping (NowEntry) -> Void) {
        var req = URLRequest(url: URL(string: "http://127.0.0.1:8737/api/state")!)
        req.timeoutInterval = 3
        URLSession.shared.dataTask(with: req) { data, _, _ in
            guard let d = data, let s = try? JSONSerialization.jsonObject(with: d) as? [String: Any] else {
                done(NowEntry(date: .now, title: "Nocturne", artist: "Not running", paused: true, running: false, art: nil)); return
            }
            let t = s["track"] as? [String: Any]
            let paused = s["paused"] as? Bool ?? true
            guard let t = t else {
                done(NowEntry(date: .now, title: "Nothing playing", artist: "Nocturne", paused: true, running: true, art: nil)); return
            }
            let title = t["title"] as? String ?? ""
            let artist = t["artist"] as? String ?? ""
            var src = t["thumb"] as? String ?? ""
            if let r = src.range(of: "=(w\\d+-h\\d+|s\\d+)[^/?#]*$", options: .regularExpression) {
                src = src.replacingCharacters(in: r, with: "=w300-h300-l90-rj")
            }
            guard let url = URL(string: src), !src.isEmpty else {
                done(NowEntry(date: .now, title: title, artist: artist, paused: paused, running: true, art: nil)); return
            }
            URLSession.shared.dataTask(with: url) { img, _, _ in
                done(NowEntry(date: .now, title: title, artist: artist, paused: paused, running: true,
                              art: img.flatMap { NSImage(data: $0) }))
            }.resume()
        }.resume()
    }
}

struct ArtView: View {
    let art: NSImage?
    var body: some View {
        if let a = art {
            Image(nsImage: a).resizable().aspectRatio(contentMode: .fill)
        } else {
            LinearGradient(colors: [Color(red: 0.25, green: 0.16, blue: 0.45), Color(red: 0.08, green: 0.06, blue: 0.18)],
                           startPoint: .topLeading, endPoint: .bottomTrailing)
                .overlay(Image(systemName: "music.note").font(.largeTitle).foregroundColor(.white.opacity(0.5)))
        }
    }
}

struct SmallView: View {
    let e: NowEntry
    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Spacer()
            Text(e.title).font(.system(size: 13, weight: .semibold)).lineLimit(2)
            HStack {
                Text(e.artist).font(.system(size: 11)).opacity(0.8).lineLimit(1)
                Spacer(minLength: 4)
                Image(systemName: e.paused ? "play.fill" : "pause.fill").font(.system(size: 12, weight: .bold))
            }
        }
        .foregroundColor(.white)
        .shadow(color: .black.opacity(0.6), radius: 3)
        .widgetURL(URL(string: e.running ? "nocturne-menu://toggle" : "nocturne-menu://open"))
    }
}

struct MediumView: View {
    let e: NowEntry
    var body: some View {
        HStack(spacing: 14) {
            ArtView(art: e.art).frame(width: 128, height: 128).clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
            VStack(alignment: .leading, spacing: 3) {
                Text(e.title).font(.system(size: 14, weight: .semibold)).lineLimit(2)
                Text(e.artist).font(.system(size: 12)).foregroundColor(.secondary).lineLimit(1)
                Spacer()
                HStack(spacing: 22) {
                    Link(destination: URL(string: "nocturne-menu://prev")!) { Image(systemName: "backward.fill") }
                    Link(destination: URL(string: "nocturne-menu://toggle")!) {
                        Image(systemName: e.paused ? "play.fill" : "pause.fill").font(.system(size: 20))
                    }
                    Link(destination: URL(string: "nocturne-menu://next")!) { Image(systemName: "forward.fill") }
                }
                .font(.system(size: 15))
            }
            Spacer(minLength: 0)
        }
        .widgetURL(URL(string: "nocturne-menu://open"))
    }
}

struct NowPlayingWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "NocturneNowPlaying", provider: NowProvider()) { e in
            Family(e: e)
        }
        .configurationDisplayName("Now Playing")
        .description("What Nocturne is playing, with play/pause and skip.")
        .supportedFamilies([.systemSmall, .systemMedium])
    }
}

struct Family: View {
    @Environment(\.widgetFamily) var family
    let e: NowEntry
    var body: some View {
        if family == .systemSmall {
            SmallView(e: e).containerBackground(for: .widget) {
                ArtView(art: e.art).overlay(LinearGradient(colors: [.clear, .black.opacity(0.65)], startPoint: .center, endPoint: .bottom))
            }
        } else {
            MediumView(e: e).containerBackground(.fill.tertiary, for: .widget)
        }
    }
}

@main
struct NocturneWidgets: WidgetBundle {
    var body: some Widget { NowPlayingWidget() }
}
