// `NocturneMenu --port N --snapshot DIR`: render the panel and the desktop player offscreen to PNGs
// (dark + light) and quit. Screen capture is off-limits over ssh, this isn't: it's how the layout gets
// checked without looking at the Mac's screen.
import AppKit
import SwiftUI

func renderPNG<V: View>(_ view: V, appearance: NSAppearance.Name, background: NSColor, radius: CGFloat, to path: String) {
    let host = NSHostingView(rootView: view)
    host.appearance = NSAppearance(named: appearance)
    let size = host.fittingSize
    let win = NSWindow(contentRect: NSRect(origin: NSPoint(x: -5000, y: -5000), size: size), styleMask: .borderless,
                       backing: .buffered, defer: false)
    win.appearance = NSAppearance(named: appearance)
    let box = NSView(frame: NSRect(origin: .zero, size: size))
    box.wantsLayer = true
    box.appearance = NSAppearance(named: appearance)
    box.layer?.backgroundColor = background.cgColor
    box.layer?.cornerRadius = radius
    host.frame = box.bounds
    box.addSubview(host)
    win.contentView = box
    box.layoutSubtreeIfNeeded()
    RunLoop.main.run(until: Date().addingTimeInterval(0.6))
    guard let rep = box.bitmapImageRepForCachingDisplay(in: box.bounds) else { return }
    box.cacheDisplay(in: box.bounds, to: rep)
    try? rep.representation(using: .png, properties: [:])?.write(to: URL(fileURLWithPath: path))
    say("snapshot \(path) \(Int(size.width))x\(Int(size.height))")
}

func runSnapshot(dir: String, player: Player, controls: Controls) {
    try? FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
    let dark = NSColor(calibratedRed: 0.17, green: 0.17, blue: 0.19, alpha: 1)
    let light = NSColor(calibratedRed: 0.93, green: 0.93, blue: 0.94, alpha: 1)
    for (name, look, bg) in [("dark", NSAppearance.Name.darkAqua, dark), ("light", NSAppearance.Name.aqua, light)] {
        renderPNG(PanelView(p: player, c: controls), appearance: look, background: bg, radius: 10, to: "\(dir)/panel-\(name).png")
        renderPNG(DeskView(p: player, c: controls, drag: { _ in }), appearance: look, background: bg, radius: 20,
                  to: "\(dir)/desk-\(name).png")
    }
}
