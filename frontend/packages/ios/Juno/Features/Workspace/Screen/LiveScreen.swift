import SwiftUI
import WebKit

/// Talks to the noVNC page in a `LiveScreen` web view. The page exposes `window.juno` (see `page`); this class
/// only serialises calls, so every argument is passed as JSON and nothing is spliced into the script as text.
@MainActor
final class ScreenControl {
    weak var web: WKWebView?

    private func call(_ fn: String, _ args: [Any] = []) {
        guard let web, let data = try? JSONSerialization.data(withJSONObject: args),
              let json = String(data: data, encoding: .utf8) else { return }
        web.evaluateJavaScript("window.juno && window.juno.\(fn).apply(null, \(json))")
    }

    /// Typed text, as key presses on the remote computer (characters outside Latin-1 use the Unicode keysym range).
    func text(_ value: String) { call("text", [value]) }
    /// One key press by X11 keysym (0xFF0D Return, 0xFF08 Backspace, 0xFF09 Tab, 0xFF1B Escape).
    func key(_ keysym: Int) { call("key", [keysym]) }
    /// Ctrl+C on the remote; the copied text comes back on the `clipboard` message.
    func copy() { call("copy") }
    /// Puts text on the remote clipboard, then Ctrl+V into the focused field.
    func paste(_ value: String) { call("paste", [value]) }
    /// Ctrl+V on the remote alone: an image or files already put on its clipboard through the side channel.
    func pressPaste() { call("pressPaste") }
    /// Pointer state on the remote, in framebuffer pixels; `buttons` is the RFB mask (1 left, 2 middle, 4 right).
    func pointer(_ at: CGPoint, buttons: Int) { call("pointer", [at.x, at.y, buttons]) }
    /// One wheel notch (RFB button bit 3 up, 4 down, 5 left, 6 right) at that position.
    func wheel(_ at: CGPoint, bit: Int) { call("wheel", [at.x, at.y, bit]) }
    /// Zoom and pan of the picture, and the cursor drawn in page points (touch has no hover cursor of its own).
    func view(zoom: CGFloat, offset: CGPoint, cursor: CGPoint, showCursor: Bool) {
        call("view", [zoom, offset.x, offset.y, cursor.x, cursor.y, showCursor])
    }
    /// Set by the touch surface: the remote size, where the page drew it, and the page size.
    var onLayout: ((CGSize, CGRect, CGSize) -> Void)?
    fileprivate func layoutChanged(_ json: String) {
        guard let d = json.data(using: .utf8), let a = (try? JSONSerialization.jsonObject(with: d)) as? [Double], a.count == 8 else { return }
        onLayout?(CGSize(width: a[0], height: a[1]), CGRect(x: a[2], y: a[3], width: a[4], height: a[5]), CGSize(width: a[6], height: a[7]))
    }
    /// Asks the page to report its layout again (when a touch surface attaches after the stream is up).
    func requestLayout() { call("layout") }
}

/// The agent's live screen: the web app's noVNC client (bundled by tools/build-novnc.mjs) in a WKWebView,
/// dialled to the signed `/v1/screens/:id/vnc` ticket. Touches are not handled by the page: `PointerSurface` sits on
/// top and drives the mouse through `ScreenControl` (noVNC's own touch gestures only scroll and tap, no cursor).
struct LiveScreen: UIViewRepresentable {
    var url: URL
    var viewOnly: Bool
    var control: ScreenControl? = nil
    var onState: (String) -> Void
    /// Text the remote computer put on its clipboard (after Copy).
    var onClipboard: (String) -> Void = { _ in }

    func makeCoordinator() -> Coordinator { Coordinator(onState: onState, onClipboard: onClipboard) }

    func makeUIView(context: Context) -> WKWebView {
        let config = WKWebViewConfiguration()
        config.userContentController.add(context.coordinator, name: "state")
        config.userContentController.add(context.coordinator, name: "clipboard")
        config.userContentController.add(context.coordinator, name: "layout")
        let web = WKWebView(frame: .zero, configuration: config)
        web.isOpaque = false
        web.backgroundColor = .black
        web.scrollView.isScrollEnabled = false
        web.scrollView.contentInsetAdjustmentBehavior = .never
        web.loadHTMLString(Self.page(url: url, viewOnly: viewOnly), baseURL: Self.base(for: url))
        context.coordinator.loaded = (url, viewOnly)
        context.coordinator.control = control
        control?.web = web
        return web
    }

    func updateUIView(_ web: WKWebView, context: Context) {
        context.coordinator.onState = onState
        context.coordinator.onClipboard = onClipboard
        context.coordinator.control = control
        control?.web = web
        guard context.coordinator.loaded?.0 != url || context.coordinator.loaded?.1 != viewOnly else { return }
        context.coordinator.loaded = (url, viewOnly)
        web.loadHTMLString(Self.page(url: url, viewOnly: viewOnly), baseURL: Self.base(for: url))
    }

    static func dismantleUIView(_ web: WKWebView, coordinator: Coordinator) {
        web.evaluateJavaScript("window.rfb && window.rfb.disconnect()")
        web.configuration.userContentController.removeScriptMessageHandler(forName: "state")
        web.configuration.userContentController.removeScriptMessageHandler(forName: "clipboard")
    }

    final class Coordinator: NSObject, WKScriptMessageHandler {
        var onState: (String) -> Void
        var onClipboard: (String) -> Void
        var loaded: (URL, Bool)?
        var control: ScreenControl?
        init(onState: @escaping (String) -> Void, onClipboard: @escaping (String) -> Void) {
            self.onState = onState
            self.onClipboard = onClipboard
        }
        func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
            guard let s = message.body as? String else { return }
            switch message.name {
            case "clipboard": onClipboard(s)
            case "layout": control?.layoutChanged(s)
            default: onState(s)
            }
        }
    }

    /// The page's origin must match the socket's security: an https page may not open ws:// (mixed content),
    /// which is what a LAN or local server (http://…:8787) hands out. wss:// tickets keep the https origin.
    private static func base(for url: URL) -> URL? {
        URL(string: url.scheme == "wss" ? "https://juno.local/" : "http://juno.local/")
    }

    private static let novnc: String = {
        guard let url = Bundle.main.url(forResource: "novnc", withExtension: "js"),
              let js = try? String(contentsOf: url, encoding: .utf8) else { return "" }
        return js
    }()

    private static func page(url: URL, viewOnly: Bool) -> String {
        let target = String(data: (try? JSONEncoder().encode(url.absoluteString)) ?? Data(), encoding: .utf8) ?? "\"\""
        return """
        <!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no">
        <style>html,body,#z,#s{margin:0;width:100%;height:100%;background:#000;overflow:hidden;touch-action:none}
        #z{transform-origin:0 0}
        #c{position:absolute;left:0;top:0;width:22px;height:30px;margin:0;pointer-events:none;display:none;transform-origin:0 0;filter:drop-shadow(0 1px 2px rgba(0,0,0,.7))}</style></head>
        <body><div id="z"><div id="s"></div>
        <svg id="c" viewBox="0 0 22 30"><path d="M2 2 L2 24 L8 18.5 L12.5 28 L16 26.5 L11.7 17.3 L19.5 17 Z" fill="#fff" stroke="#000" stroke-width="1.6" stroke-linejoin="round"/></svg></div>
        <script type="module">\(novnc)
        const post = (s) => window.webkit.messageHandlers.state.postMessage(s);
        try {
          const rfb = new window.RFB(document.getElementById('s'), \(target), { shared: true, wsProtocols: ['binary'] });
          rfb.viewOnly = \(viewOnly);
          rfb.scaleViewport = true;
          rfb.resizeSession = false;
          rfb.background = '#000';
          rfb.addEventListener('connect', () => post('connected'));
          rfb.addEventListener('disconnect', (e) => post(e.detail && e.detail.clean ? 'closed' : 'dropped'));
          rfb.addEventListener('securityfailure', () => post('dropped'));
          rfb.addEventListener('clipboard', (e) => window.webkit.messageHandlers.clipboard.postMessage(e.detail.text));
          window.rfb = rfb;
          // Keyboard, clipboard and pointer-mode helpers called from Swift (ScreenControl).
          const ctrlChord = (keysym, code) => {
            rfb.sendKey(0xFFE3, 'ControlLeft', true);
            rfb.sendKey(keysym, code);
            rfb.sendKey(0xFFE3, 'ControlLeft', false);
          };
          // Pointer input comes from PointerSurface in framebuffer pixels. _sendMouse takes canvas pixels and divides by
          // the display scale again, so scale first (the +.25 keeps float error from truncating to the pixel before).
          const disp = rfb._display;
          const mouse = (fx, fy, mask) => rfb._sendMouse((Math.round(fx) + 0.25) * disp.scale, (Math.round(fy) + 0.25) * disp.scale, mask);
          const zoomEl = document.getElementById('z'), cur = document.getElementById('c');
          let view = { z: 1, x: 0, y: 0 }, cursor = { x: 0, y: 0, show: false };
          const paint = () => {
            zoomEl.style.transform = `translate(${view.x}px,${view.y}px) scale(${view.z})`;
            cur.style.display = cursor.show ? 'block' : 'none';
            cur.style.transform = `translate(${cursor.x}px,${cursor.y}px) scale(${1 / view.z})`;
          };
          // Where the canvas sits at zoom 1 (undo the current transform), for the touch surface's maths.
          const layout = () => {
            const cv = rfb._canvas, r = cv.getBoundingClientRect();
            if (!cv.width || !r.width) return;
            window.webkit.messageHandlers.layout.postMessage(JSON.stringify([cv.width, cv.height,
              (r.left - view.x) / view.z, (r.top - view.y) / view.z, r.width / view.z, r.height / view.z, innerWidth, innerHeight]));
          };
          rfb.addEventListener('connect', () => setTimeout(layout, 50));
          rfb.addEventListener('desktopsize', () => setTimeout(layout, 50));
          addEventListener('resize', () => setTimeout(layout, 50));
          window.juno = {
            text(s) { for (const ch of s) { const cp = ch.codePointAt(0); rfb.sendKey(cp < 0x100 ? cp : 0x01000000 + cp, null); } },
            key(keysym) { rfb.sendKey(keysym, null); },
            copy() { ctrlChord(0x63, 'KeyC'); },
            paste(s) { rfb.clipboardPasteFrom(s); ctrlChord(0x76, 'KeyV'); },
            pressPaste() { ctrlChord(0x76, 'KeyV'); },
            pointer(fx, fy, buttons) { mouse(fx, fy, buttons); },
            wheel(fx, fy, bit) { mouse(fx, fy, 1 << bit); mouse(fx, fy, 0); },
            view(z, x, y, cx, cy, show) { view = { z, x, y }; cursor = { x: cx, y: cy, show }; paint(); },
            layout
          };
        } catch (e) { post('dropped'); }
        </script></body></html>
        """
    }
}
