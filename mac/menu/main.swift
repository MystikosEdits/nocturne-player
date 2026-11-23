// Nocturne's macOS menu-bar helper: the icon at the top of the screen (click = now-playing panel,
// right-click = menu), the optional desktop player, and (when built with an Apple-issued signing
// identity) the containing app of the WidgetKit widget. The engine starts it with
//   NocturneMenu --port 8737 --engine-pid <pid> [--app <Nocturne.app>]
// and it quits on its own when that engine process ends.
import AppKit
import SwiftUI
import WidgetKit

func arg(_ name: String) -> String? {
    let a = CommandLine.arguments
    guard let i = a.firstIndex(of: name), i + 1 < a.count else { return nil }
    return a[i + 1]
}

func say(_ s: String) {
    FileHandle.standardError.write("\(Date()) \(s)\n".data(using: .utf8)!)
}

/// Lets clicks reach the buttons of a window that isn't key (the desktop player never takes focus).
final class FirstClickHostingView<V: View>: NSHostingView<V> {
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
}

final class DeskPanel: NSPanel {
    override var canBecomeKey: Bool { true }      // so the right-click menu and buttons behave
    override var canBecomeMain: Bool { false }
}

final class AppDelegate: NSObject, NSApplicationDelegate {
    let port = Int(arg("--port") ?? "") ?? 8737
    let enginePid = Int32(arg("--engine-pid") ?? "")
    let appPath = arg("--app")
    let player = Player()
    lazy var link = EngineLink(port: port, player: player)
    lazy var controls = Controls(player: player, link: link)
    var item: NSStatusItem!
    let popover = NSPopover()
    var desk: DeskPanel?
    var dragStart: (mouse: NSPoint, origin: NSPoint)?
    var engineWatch: DispatchSourceProcess?
    let hasWidget = FileManager.default.fileExists(atPath: Bundle.main.bundlePath + "/Contents/PlugIns/NowPlaying.appex")
    var widgetReload: DispatchWorkItem?
    let defaults = UserDefaults.standard

    func applicationWillFinishLaunching(_ n: Notification) {
        NSAppleEventManager.shared().setEventHandler(self, andSelector: #selector(handleURL(_:reply:)),
                                                     forEventClass: AEEventClass(kInternetEventClass),
                                                     andEventID: AEEventID(kAEGetURL))
    }

    func applicationDidFinishLaunching(_ n: Notification) {
        if let dir = arg("--snapshot") {          // offscreen render for checking the layout, then quit
            link.connect()
            DispatchQueue.main.asyncAfter(deadline: .now() + 4) { [self] in
                // the size the live popover will get (same controller setup as the menu-bar panel)
                let hc = NSHostingController(rootView: PanelView(p: player, c: controls))
                if #available(macOS 13.0, *) { hc.sizingOptions = [] }
                hc.view.layoutSubtreeIfNeeded()
                say("panel size \(panelSize(hc)) (old fittingSize way: \(hc.view.fittingSize))")
                runSnapshot(dir: dir, player: player, controls: controls)
                exit(0)
            }
            return
        }
        watchEngine()
        item = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
        if let b = item.button {
            b.image = menuIcon()
            b.imagePosition = .imageOnly
            b.target = self
            b.action = #selector(clicked(_:))
            b.sendAction(on: [.leftMouseUp, .rightMouseUp])
            b.toolTip = "Nocturne"
        }
        item.autosaveName = "NocturneMenu"
        popover.behavior = .transient
        popover.animates = true
        // FIXED SIZE: the hosting controller must not resize the popover while it is open (a growing NSWindow keeps
        // its bottom edge, so the panel crept up under the menu bar: Grant's screenshot, Nov 22). Measured once below.
        let hc = NSHostingController(rootView: PanelView(p: player, c: controls))
        if #available(macOS 13.0, *) { hc.sizingOptions = [] }
        popover.contentViewController = hc

        controls.openApp = { [weak self] in self?.openApp() }
        controls.quitApp = { [weak self] in self?.quitAll() }
        controls.setDesk = { [weak self] on in self?.showDesk(on) }
        controls.setDeskOnTop = { [weak self] on in self?.deskOnTop(on) }
        controls.deskOnTop = defaults.bool(forKey: "deskOnTop")
        player.onChange = { [weak self] in self?.changed() }
        link.connect()
        if defaults.bool(forKey: "deskShown") { showDesk(true) }
        // a monitor unplugged / resolution changed: pull the desktop player back onto a screen
        NotificationCenter.default.addObserver(forName: NSApplication.didChangeScreenParametersNotification, object: nil,
                                               queue: .main) { [weak self] _ in
            self?.snapDeskOnScreen()
        }
        say("menu helper up (port \(port), engine pid \(enginePid.map(String.init) ?? "-"), widget \(hasWidget))")
    }

    // ---------------- engine lifetime
    func watchEngine() {
        guard let pid = enginePid else { return }
        if kill(pid, 0) != 0 && errno == ESRCH { exit(0) }
        let src = DispatchSource.makeProcessSource(identifier: pid, eventMask: .exit, queue: .main)
        src.setEventHandler { exit(0) }
        src.resume()
        engineWatch = src
    }

    // ---------------- status item
    func menuIcon() -> NSImage {
        let img = Bundle.main.image(forResource: "menubar") ?? NSImage(systemSymbolName: "music.note", accessibilityDescription: "Nocturne")!
        img.size = NSSize(width: 18, height: 18)
        return img
    }

    @objc func clicked(_ sender: NSStatusBarButton) {
        let ev = NSApp.currentEvent
        if ev?.type == .rightMouseUp || ev?.modifierFlags.contains(.control) == true {
            popover.performClose(nil)
            let menu = buildMenu()
            item.menu = menu                     // shown under the icon, then detached again so
            item.button?.performClick(nil)       // a left click keeps opening the panel
            item.menu = nil
        } else {
            togglePopover()
        }
    }

    /// The panel's real size, asked from SwiftUI. (With sizingOptions = [] the hosting VIEW's fittingSize no longer
    /// reflects the SwiftUI content: it came out too short and the panel was cropped top and bottom, Nov 22.)
    func panelSize(_ hc: NSHostingController<PanelView>) -> NSSize {
        let fit = hc.sizeThatFits(in: NSSize(width: 300, height: 4000))
        guard fit.width > 100, fit.height > 200, fit.height < 2000 else { return NSSize(width: 300, height: 486) }
        return NSSize(width: ceil(fit.width), height: ceil(fit.height))
    }

    func togglePopover() {
        if popover.isShown { popover.performClose(nil); return }
        guard item != nil, let b = item.button else { return }
        // size it to its content BEFORE it opens; it never changes size while open
        if let hc = popover.contentViewController as? NSHostingController<PanelView> {
            popover.contentSize = panelSize(hc)
        }
        NSApp.activate(ignoringOtherApps: true)
        popover.show(relativeTo: b.bounds, of: b, preferredEdge: .minY)
        popover.contentViewController?.view.window?.makeKey()
    }

    func buildMenu() -> NSMenu {
        let m = NSMenu()
        if let t = player.track {
            let head = NSMenuItem(title: "\(t.title) — \(t.artist)", action: nil, keyEquivalent: "")
            head.isEnabled = false
            m.addItem(head)
            m.addItem(.separator())
            m.addItem(withTitle: player.paused ? "Play" : "Pause", action: #selector(menuToggle), keyEquivalent: "")
            m.addItem(withTitle: "Next", action: #selector(menuNext), keyEquivalent: "")
            m.addItem(withTitle: "Previous", action: #selector(menuPrev), keyEquivalent: "")
            m.addItem(.separator())
        }
        m.addItem(withTitle: "Open Nocturne", action: #selector(menuOpen), keyEquivalent: "")
        let d = m.addItem(withTitle: "Player on Desktop", action: #selector(menuDesk), keyEquivalent: "")
        d.state = controls.deskShown ? .on : .off
        m.addItem(.separator())
        m.addItem(withTitle: "Quit Nocturne", action: #selector(menuQuit), keyEquivalent: "")
        for i in m.items { i.target = self }
        return m
    }

    @objc func menuToggle() { controls.toggle() }
    @objc func menuNext() { controls.next() }
    @objc func menuPrev() { controls.prev() }
    @objc func menuOpen() { openApp() }
    @objc func menuDesk() { showDesk(!controls.deskShown) }
    @objc func menuQuit() { quitAll() }

    func changed() {
        if let t = player.track {
            item?.button?.toolTip = "\(t.title) — \(t.artist)\(player.paused ? " (paused)" : "")"
        } else {
            item?.button?.toolTip = "Nocturne"
        }
        if hasWidget {
            widgetReload?.cancel()
            let w = DispatchWorkItem { WidgetCenter.shared.reloadAllTimelines() }
            widgetReload = w
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.8, execute: w)   // art/title settle first
        }
    }

    // ---------------- actions
    func openApp() {
        popover.performClose(nil)
        link.post("api/window/open", [:]) { [weak self] ok in
            if !ok { self?.launchApp(background: false) }
        }
    }

    func launchApp(background: Bool) {
        let path = appPath ?? URL(fileURLWithPath: Bundle.main.bundlePath).deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent().path      // .../Nocturne.app/Contents/Helpers/<me>
        guard path.hasSuffix(".app") else { return }
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/usr/bin/open")
        p.arguments = background ? [path, "--args", "--background"] : [path]
        try? p.run()
    }

    func quitAll() {
        popover.performClose(nil)
        link.post("api/quit", [:]) { _ in }
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { exit(0) }
    }

    @objc func handleURL(_ e: NSAppleEventDescriptor, reply: NSAppleEventDescriptor) {
        // nocturne-menu://toggle|next|prev|open|panel (the widget's buttons)
        guard let s = e.paramDescriptor(forKeyword: keyDirectObject)?.stringValue, let u = URL(string: s) else { return }
        if enginePid == nil && arg("--snapshot") == nil {
            // cold-launched by a link (widget) while Nocturne wasn't running: start Nocturne (its engine starts its
            // own helper) and leave, instead of living on as a second, orphaned menu-bar icon
            launchApp(background: !["open", "panel"].contains(u.host ?? "open"))
            DispatchQueue.main.asyncAfter(deadline: .now() + 1) { exit(0) }
            return
        }
        switch u.host ?? "" {
        case "toggle": controls.toggle()
        case "next": controls.next()
        case "prev": controls.prev()
        case "panel": togglePopover()
        default: player.connected ? openApp() : launchApp(background: false)
        }
    }

    // ---------------- desktop player
    func showDesk(_ on: Bool) {
        controls.deskShown = on
        defaults.set(on, forKey: "deskShown")
        if !on { desk?.orderOut(nil); desk = nil; return }
        if desk != nil { return }
        let size = NSSize(width: 344, height: 140)
        let panel = DeskPanel(contentRect: NSRect(origin: .zero, size: size),
                              styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = true
        panel.isReleasedWhenClosed = false
        panel.hidesOnDeactivate = false
        panel.becomesKeyOnlyIfNeeded = true
        panel.collectionBehavior = [.canJoinAllSpaces, .stationary, .ignoresCycle, .fullScreenNone]
        let fx = NSVisualEffectView(frame: NSRect(origin: .zero, size: size))
        fx.material = .hudWindow
        fx.blendingMode = .behindWindow
        fx.state = .active
        fx.wantsLayer = true
        fx.layer?.cornerRadius = 20
        fx.layer?.cornerCurve = .continuous
        fx.layer?.masksToBounds = true
        let host = FirstClickHostingView(rootView: DeskView(p: player, c: controls, drag: { [weak self] v in self?.deskDrag(v) }))
        host.frame = fx.bounds
        host.autoresizingMask = [.width, .height]
        fx.addSubview(host)
        panel.contentView = fx
        panel.setFrameOrigin(savedDeskOrigin(size))
        desk = panel
        deskOnTop(controls.deskOnTop)
        panel.orderFrontRegardless()
    }

    func deskOnTop(_ on: Bool) {
        controls.deskOnTop = on
        defaults.set(on, forKey: "deskOnTop")
        // like a widget: just above the desktop icons, under every window; or floating over them
        desk?.level = on ? .floating : NSWindow.Level(rawValue: Int(CGWindowLevelForKey(.desktopIconWindow)) + 1)
        desk?.orderFrontRegardless()
    }

    func savedDeskOrigin(_ size: NSSize, ignoreSaved: Bool = false) -> NSPoint {
        if !ignoreSaved, let s = defaults.string(forKey: "deskOrigin") {
            return fullyOnScreen(NSRect(origin: NSPointFromString(s), size: size))
        }
        guard let screen = NSScreen.main ?? NSScreen.screens.first else { return .zero }   // no screen attached
        let v = screen.visibleFrame
        return fullyOnScreen(NSRect(x: v.maxX - size.width - 24, y: v.maxY - size.height - 24, width: size.width, height: size.height))
    }

    /// The origin that puts `r` WHOLLY inside the visible area (not under the menu bar or the Dock) of the screen holding
    /// most of it. Grant, Nov 22: "the widget on mac open halfway off the screen" (overlapping at all used to count).
    func fullyOnScreen(_ r: NSRect) -> NSPoint {
        let screens = NSScreen.screens
        guard !screens.isEmpty else { return r.origin }
        func area(_ s: NSScreen) -> CGFloat { let i = s.visibleFrame.intersection(r); return i.isNull ? 0 : i.width * i.height }
        let best = screens.max(by: { area($0) < area($1) }).flatMap { area($0) > 0 ? $0 : nil } ?? NSScreen.main ?? screens[0]
        let v = best.visibleFrame.insetBy(dx: 8, dy: 8)
        return NSPoint(x: min(max(r.minX, v.minX), max(v.minX, v.maxX - r.width)),
                       y: min(max(r.minY, v.minY), max(v.minY, v.maxY - r.height)))
    }

    func snapDeskOnScreen() {
        guard let d = desk else { return }
        let p = fullyOnScreen(d.frame)
        if p != d.frame.origin {
            d.setFrame(NSRect(origin: p, size: d.frame.size), display: true, animate: true)
            defaults.set(NSStringFromPoint(p), forKey: "deskOrigin")
        }
    }

    func deskDrag(_ v: DragGesture.Value?) {
        guard let panel = desk else { return }
        guard v != nil else {
            if dragStart != nil {
                defaults.set(NSStringFromPoint(panel.frame.origin), forKey: "deskOrigin")
                snapDeskOnScreen()          // dropped partly off the screen: slide it back in
            }
            dragStart = nil
            return
        }
        let mouse = NSEvent.mouseLocation
        if dragStart == nil { dragStart = (mouse, panel.frame.origin) }
        if let s = dragStart {
            panel.setFrameOrigin(NSPoint(x: s.origin.x + mouse.x - s.mouse.x, y: s.origin.y + mouse.y - s.mouse.y))
        }
    }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.accessory)
app.run()
