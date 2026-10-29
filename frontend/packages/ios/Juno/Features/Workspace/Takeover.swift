import SwiftUI
import UIKit
import UniformTypeIdentifiers

/// Full-screen take-over (Muse's "you're in control" view): dark, the title and the page name at the top with a
/// check that hands control back, the live screen right under it, and a floating bar just above the keyboard
/// (keyboard, trackpad/touch, copy, paste) with a red Stop on its left. The keyboard comes up on entry.
/// Needs a live server (a control ticket).
struct TakeoverView: View {
    @Environment(World.self) private var world
    @Environment(\.dismiss) private var dismiss
    var agentId: String
    /// The take-over request this opens for: its focus rectangle is zoomed to, and a text field brings the keyboard up.
    var request: AgentRequest? = nil

    @State private var control = ScreenControl()
    @State private var liveURL: URL?
    @State private var connected = false
    @State private var dials = 0
    @State private var keyboardOn: Bool
    /// Direct touch (tap where you touch) instead of the trackpad. Remembered once chosen; until then iPad touches
    /// directly and iPhone uses the trackpad.
    @AppStorage("takeover.directTouch") private var directTouch = false
    @State private var clipboardNote: String?
    /// The remote's clipboard text from the page's cut-text: the fallback only when the computer cannot answer the clipboard read.
    @State private var remoteCutText: String?
    /// A file copied on the computer, offered to Save or Share.
    @State private var copiedFile: CopiedFile?
    @State private var refresh: Task<Void, Never>?

    init(agentId: String, request: AgentRequest? = nil) {
        self.agentId = agentId
        self.request = request
        _directTouch = AppStorage(wrappedValue: UIDevice.current.userInterfaceIdiom == .pad, "takeover.directTouch")
        // With a focused element the keyboard comes up only for a text field; a plain take-over keeps it up.
        _keyboardOn = State(initialValue: request?.payload?.focus == nil || Self.isTextRole(request?.payload?.focus?.role))
    }

    static func isTextRole(_ role: String?) -> Bool {
        guard let role = role?.lowercased() else { return false }
        return ["textbox", "searchbox", "combobox", "textfield", "text field", "input", "textarea", "password", "spinbutton"].contains(role)
    }

    /// The focus rectangle in framebuffer pixels.
    private var focusRect: CGRect? {
        guard let r = request?.payload?.focus?.rect, let w = r.width, let h = r.height, w > 0, h > 0 else { return nil }
        return CGRect(x: r.x ?? 0, y: r.y ?? 0, width: w, height: h)
    }

    /// Tap targets, refreshed a moment after each click (the page changes under the finger).
    private func scheduleElements(after delay: Duration = .milliseconds(700)) {
        refresh?.cancel()
        refresh = Task { @MainActor in
            try? await Task.sleep(for: delay)
            guard !Task.isCancelled else { return }
            await world.loadElements(agentId)
        }
    }

    var body: some View {
        let user = world.computer?.controller == "user"
        let name = world.agent(agentId)?.name ?? "Agent"
        let live = world.api != nil && liveURL != nil && connected
        NavigationStack {
            VStack(spacing: 0) {
                screen(user: user)
                Spacer(minLength: 0)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(Color.black.ignoresSafeArea())
            .navigationBarTitleDisplayMode(.inline)
            .toolbarBackgroundVisibility(.hidden, for: .navigationBar)
            .toolbar {
                ToolbarItem(placement: .principal) {
                    VStack(spacing: 1) {
                        Text(user ? "You're in control" : "Taking control…").text(.md, .semibold).foregroundStyle(.white)
                        // No browser tab title in the computer state yet: the agent's name stands in.
                        Text(name).text(.xs).foregroundStyle(.white.opacity(0.55))
                    }
                }
                ToolbarItem(placement: .topBarLeading) {
                    if let request, request.status == "pending" {
                        Button("Can't help") { cantHelp(request) }.accessibilityIdentifier("takeover-cant-help")
                    }
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Hand back", systemImage: "checkmark") { handBack() }
                        .accessibilityLabel("Hand control back to \(name)")
                }
            }
            .safeAreaInset(edge: .bottom, spacing: 0) { controlBar(live: live) }
        }
        .overlay(alignment: .center) {
            if let clipboardNote {
                Text(clipboardNote).text(.xs, .medium).foregroundStyle(.white)
                    .padding(.horizontal, 12).padding(.vertical, 6)
                    .background(.black.opacity(0.7), in: .capsule)
                    .transition(.opacity)
            }
        }
        .background(KeyCatcher(active: keyboardOn && live, onText: { control.text($0) }, onKey: { control.key($0) },
                               onHide: { keyboardOn = false }, onPaste: { pasteFromDevice() })
            .frame(width: 0, height: 0))
        // Dark only inside the cover: preferredColorScheme would also darken the sheet underneath and stick after dismissal.
        .environment(\.colorScheme, .dark)
        // The one take-over screen may rotate (bigger picture), like the full-screen computer.
        .allowsLandscape()
        // Taking over: wait until the server has switched the screen to the user, then dial a control ticket (one
        // asked for earlier is view-only and drops every click). A dropped stream re-dials.
        .task(id: dials) {
            guard world.api != nil else { return }
            for attempt in 0..<3 {
                await world.takeOver(agentId)
                if let url = await world.streamURL(agentId, control: true) { liveURL = url; return }
                try? await Task.sleep(for: .milliseconds(400 * (attempt + 1)))
            }
        }
        .animation(.default, value: clipboardNote)
        // Tap targets need the user in control: ask once the control stream is up.
        .task(id: liveURL) { if liveURL != nil, directTouch { scheduleElements(after: .milliseconds(300)) } }
        .onChange(of: directTouch) { _, on in if on { scheduleElements(after: .milliseconds(100)) } }
        .sheet(item: $copiedFile) { file in
            VStack(spacing: 16) {
                Text(file.name).text(.md, .semibold)
                ShareLink(item: file.url) { Label("Save or share", systemImage: "square.and.arrow.up") }
                    .buttonStyle(.borderedProminent)
            }
            .padding(24)
            .presentationDetents([.height(200)])
        }
    }

    /// Red Stop on the left, a dark capsule with keyboard, trackpad/touch mode, copy and paste next to it.
    private func controlBar(live: Bool) -> some View {
        HStack(spacing: 14) {
            Button {
                if let run = world.activeRuns(of: agentId).first { world.stopRun(run.id) }
            } label: {
                Circle().fill(Theme.danger).frame(width: 18, height: 18)
            }
            .buttonStyle(.glass).buttonBorderShape(.circle).controlSize(.large)
            .accessibilityLabel("Stop")
            .disabled(world.activeRuns(of: agentId).isEmpty)
            HStack(spacing: 4) {
                barButton(keyboardOn ? "Hide keyboard" : "Keyboard", "keyboard", on: keyboardOn, enabled: true) { keyboardOn.toggle() }
                barButton(directTouch ? "Touch mode, switch to trackpad" : "Trackpad mode, switch to touch",
                          directTouch ? "hand.tap" : "cursorarrow", on: directTouch, enabled: live) {
                    directTouch.toggle()
                    flash(directTouch ? "Touch: tap where you want to click" : "Trackpad: drag to move the cursor, tap to click")
                }
                transferButton("Copy from computer", "doc.on.doc", enabled: live) { copyFromComputer() }
                transferButton("Paste to computer", "doc.on.clipboard", enabled: live) { pasteFromDevice() }
            }
            .padding(5)
            .glassEffect(.regular, in: .capsule)
        }
        .padding(.horizontal, 16).padding(.vertical, 8)
    }

    private func barButton(_ label: String, _ symbol: String, on: Bool, enabled: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            barIcon(symbol, on: on, enabled: enabled)
        }
        .buttonStyle(.plain)
        .accessibilityLabel(label)
        .disabled(!enabled)
    }

    /// The icon of one control in the bar (the same size and tint for a tap button and for the copy and paste ones).
    private func barIcon(_ symbol: String, on: Bool, enabled: Bool) -> some View {
        Image(systemName: symbol).font(.system(size: 16)).foregroundStyle(.white.opacity(enabled ? 1 : 0.4))
            .frame(width: 44, height: 36).background(on ? Color.white.opacity(0.2) : .clear, in: .capsule)
    }

    /// The picture, full width under the title (aspect-fit, top-aligned); a dark rounded placeholder until there is one.
    @ViewBuilder private func screen(user: Bool) -> some View {
        let shot = world.screenshots[agentId]
        let ratio = shot.map { $0.size.width / max($0.size.height, 1) } ?? 1364.0 / 1024.0
        ZStack {
            Rectangle().fill(Color(white: 0.12))
            if let shot { Image(uiImage: shot).resizable().scaledToFit().opacity(world.api != nil && !connected ? 0.55 : 1) }
            if let liveURL {
                if !connected { ProgressView().tint(.white) }
                LiveScreen(url: liveURL, viewOnly: false, control: control, onState: { state in
                    if state == "connected" { connected = true }
                    else { connected = false; if dials < 3 { dials += 1 } }  // a ticket that keeps failing stops after 3 re-dials
                }, onClipboard: { text in
                    remoteCutText = text
                })
                .opacity(connected ? 1 : 0)
                .allowsHitTesting(false)
                if connected {
                    let found = world.screenElements[agentId]
                    PointerSurface(control: control, direct: directTouch, focus: focusRect,
                                   elements: directTouch ? (found?.elements ?? []).compactMap { e in
                                       guard let r = e.rect, let w = r.width, let h = r.height else { return nil }
                                       return CGRect(x: r.x ?? 0, y: r.y ?? 0, width: w, height: h)
                                   } : [],
                                   elementsSize: CGSize(width: found?.width ?? 0, height: found?.height ?? 0),
                                   onClick: { if directTouch { scheduleElements() } })
                }
            } else {
                ProgressView().tint(.white)
            }
        }
        .aspectRatio(ratio, contentMode: .fit)
        .frame(maxWidth: .infinity)
    }

    /// Lower the keyboard first so it doesn't ride down with the cover, then hand back and close.
    private func handBack() {
        let hadKeyboard = keyboardOn
        keyboardOn = false
        if let request { world.returnControl(request) } else { world.setController("agent", agentId: agentId) }
        Task { @MainActor in
            if hadKeyboard { try? await Task.sleep(for: .milliseconds(280)) }
            dismiss()
        }
    }

    /// The user can't do what the agent asked: tell it so (deny) and give the screen back.
    private func cantHelp(_ request: AgentRequest) {
        world.resolve(request.id, decision: "denied")
        keyboardOn = false
        world.setController("agent", agentId: agentId)
        dismiss()
    }

    /// Copy from computer: Ctrl+C there, then what its clipboard holds comes here. Text goes to this phone's pasteboard, an
    /// image goes as an image, a file is offered to Save or Share. The remote's cut-text answers only when the computer cannot
    /// (an older computer without the side channel); a take-over refusal and a too-large item are named, never retried as text.
    private func copyFromComputer() {
        remoteCutText = nil
        control.copy()
        Task { @MainActor in
            try? await Task.sleep(for: .milliseconds(350))
            do {
                let copied = try await world.copyComputerClipboard(agentId)
                switch copied.kind ?? "" {
                case "text":
                    UIPasteboard.general.string = copied.text ?? ""
                    flash("Copied from the computer")
                case "image":
                    guard let data = Data(base64Encoded: copied.contentBase64 ?? ""), let image = UIImage(data: data) else { flash(Self.copyFailed); return }
                    UIPasteboard.general.image = image
                    flash("Image copied from the computer")
                case "file":
                    guard let data = Data(base64Encoded: copied.contentBase64 ?? ""), let url = Self.stage(data, named: copied.name ?? "file") else { flash(Self.copyFailed); return }
                    copiedFile = CopiedFile(name: url.lastPathComponent, url: url)
                default:
                    flash("Nothing selected on the computer — select something there first")
                }
            } catch {
                let status = Self.status(of: error)
                if let text = remoteCutText, status != 409, status != 413 {
                    UIPasteboard.general.string = text
                    flash("Copied from the computer")
                } else {
                    flash(Self.message(for: error))
                }
            }
        }
    }

    /// Paste to computer: files on this phone's pasteboard go into the computer's Downloads; an image goes onto its clipboard
    /// and Ctrl+V pastes it; text keeps the VNC path (the remote clipboard is set, then Ctrl+V).
    private func pasteFromDevice() {
        Task { @MainActor in
            switch await devicePaste() {
            case .text(let text):
                control.paste(text)
            case .nothing:
                flash("Nothing to paste on this device")
            case .tooLarge:
                flash("That is larger than the 10 MB limit")
            case .send(let input):
                do {
                    let result = try await world.pasteComputerClipboard(agentId, input)
                    if result.kind == "image" {
                        control.pressPaste()
                        flash("Image pasted to the computer")
                    } else {
                        flash("Saved to " + (result.saved ?? []).compactMap(\.path).joined(separator: ", "))
                    }
                } catch {
                    flash(Self.message(for: error))
                }
            }
        }
    }

    private enum DevicePaste {
        case text(String)
        case send(Contract.ScreenClipboardPaste)
        case nothing
        case tooLarge
    }

    /// What this phone's pasteboard holds for the computer: files first (a copied file can carry a thumbnail image too),
    /// then an image (PNG, or JPEG when the PNG is over the limit), then text. Files together stay under the upload limit.
    private func devicePaste() async -> DevicePaste {
        let board = UIPasteboard.general
        let limit = 10 * 1024 * 1024
        var files: [(name: String, data: Data)] = []
        for provider in board.itemProviders where files.count < 10 {
            guard let type = Self.fileType(of: provider), let data = await Self.load(provider, type: type.identifier) else { continue }
            files.append((name: Self.fileName(provider, type: type), data: data))
        }
        if !files.isEmpty {
            if files.reduce(0, { $0 + $1.data.count }) > limit { return .tooLarge }
            let items = files.map { Contract.ScreenClipboardPaste.File(name: $0.name, contentBase64: $0.data.base64EncodedString()) }
            return .send(Contract.ScreenClipboardPaste(kind: "files", files: items))
        }
        if board.hasImages {
            guard let image = board.image else { return .nothing }
            if let png = image.pngData(), png.count <= limit {
                return .send(Contract.ScreenClipboardPaste(kind: "image", mimeType: "image/png", contentBase64: png.base64EncodedString()))
            }
            if let jpeg = image.jpegData(compressionQuality: 0.85), jpeg.count <= limit {
                return .send(Contract.ScreenClipboardPaste(kind: "image", mimeType: "image/jpeg", contentBase64: jpeg.base64EncodedString()))
            }
            return .tooLarge
        }
        if let text = board.string, !text.isEmpty { return .text(text) }
        return .nothing
    }

    /// A content type of the item that is a file: data, not text, an image, a link or a folder.
    private static func fileType(of provider: NSItemProvider) -> UTType? {
        provider.registeredTypeIdentifiers.compactMap { UTType($0) }.first { type in
            type.conforms(to: .data) && !type.conforms(to: .text) && !type.conforms(to: .image) && !type.conforms(to: .url) && !type.conforms(to: .folder)
        }
    }

    private static func load(_ provider: NSItemProvider, type: String) async -> Data? {
        await withCheckedContinuation { (continuation: CheckedContinuation<Data?, Never>) in
            _ = provider.loadDataRepresentation(forTypeIdentifier: type) { data, _ in continuation.resume(returning: data) }
        }
    }

    /// The suggested name of a file item, with an extension from its type when the name has none.
    private static func fileName(_ provider: NSItemProvider, type: UTType) -> String {
        var name = provider.suggestedName ?? "file"
        if (name as NSString).pathExtension.isEmpty, let ext = type.preferredFilenameExtension { name += "." + ext }
        return name
    }

    /// A copied file, written under a fresh folder so Share can offer it with its own name.
    private static func stage(_ data: Data, named name: String) -> URL? {
        let base = (name as NSString).lastPathComponent
        let safe = base.isEmpty || base.hasPrefix(".") ? "file" : base
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
        do {
            try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
            let url = folder.appendingPathComponent(safe)
            try data.write(to: url)
            return url
        } catch {
            return nil
        }
    }

    static let copyFailed = "The clipboard could not be moved. Try again."

    /// The HTTP status of a refused call, when the error carries one.
    private static func status(of error: Error) -> Int? {
        if case APIError.api(let status, _, _) = error { return status }
        if case APIError.http(let status, _) = error { return status }
        return nil
    }

    /// What a failed clipboard call says: the take-over rule and the size limit are named, anything else is a retry.
    private static func message(for error: Error) -> String {
        switch status(of: error) {
        case 409: return "Take over the computer first to copy or paste"
        case 413: return "That is larger than the 10 MB limit"
        default: return copyFailed
        }
    }

    /// Copy and paste to and from the computer: a tap runs the action, a long press names it (the bar has no room for words).
    private func transferButton(_ label: String, _ symbol: String, enabled: Bool, action: @escaping () -> Void) -> some View {
        barIcon(symbol, on: false, enabled: enabled)
            .contentShape(.rect)
            .onTapGesture { if enabled { action() } }
            .onLongPressGesture(minimumDuration: 0.5) { flash(label) }
            .accessibilityLabel(label)
            .accessibilityAddTraits(.isButton)
            .accessibilityAction { if enabled { action() } }
    }

    private func flash(_ note: String) {
        clipboardNote = note
        Task { @MainActor in
            try? await Task.sleep(for: .seconds(1.6))
            if clipboardNote == note { clipboardNote = nil }
        }
    }
}

/// A file copied on the computer, held in a temporary folder until the user saves or shares it.
struct CopiedFile: Identifiable {
    let id = UUID()
    let name: String
    let url: URL
}

/// An invisible first responder that turns the iOS keyboard into key presses on the remote computer.
/// Committed text only: IME composition (CJK pinyin etc.) is not forwarded until it commits.
struct KeyCatcher: UIViewRepresentable {
    var active: Bool
    var onText: (String) -> Void
    var onKey: (Int) -> Void
    var onHide: () -> Void = {}
    var onPaste: () -> Void = {}

    func makeUIView(context: Context) -> KeyInputView {
        let view = KeyInputView()
        view.onText = onText
        view.onKey = onKey
        view.onHide = onHide
        view.onPaste = onPaste
        return view
    }

    func updateUIView(_ view: KeyInputView, context: Context) {
        view.onText = onText
        view.onKey = onKey
        view.onHide = onHide
        view.onPaste = onPaste
        if active, !view.isFirstResponder { view.becomeFirstResponder() }
        if !active, view.isFirstResponder { view.resignFirstResponder() }
    }
}

/// Plain text traits: no autocorrect, smart punctuation or capitals, so typed characters reach the remote as typed.
final class KeyInputView: UIView, UIKeyInput {
    var onText: (String) -> Void = { _ in }
    var onKey: (Int) -> Void = { _ in }
    var onHide: () -> Void = {}
    var onPaste: () -> Void = {}

    override var canBecomeFirstResponder: Bool { true }

    /// Rides on top of the iOS keyboard (the floating control bar sits above it): hide the keyboard,
    /// the keys a phone keyboard lacks (Esc, Tab, arrows) and Paste.
    private lazy var accessory: UIToolbar = {
        let bar = UIToolbar(frame: CGRect(x: 0, y: 0, width: 320, height: 44))
        func key(_ title: String, _ image: String?, _ keysym: Int) -> UIBarButtonItem {
            let action = UIAction { [weak self] _ in self?.onKey(keysym) }
            let item = image.map { UIBarButtonItem(image: UIImage(systemName: $0), primaryAction: action) }
                ?? UIBarButtonItem(title: title, primaryAction: action)
            item.accessibilityLabel = title
            return item
        }
        let hide = UIBarButtonItem(image: UIImage(systemName: "keyboard.chevron.compact.down"),
                                   primaryAction: UIAction { [weak self] _ in self?.onHide() })
        hide.accessibilityLabel = "Hide keyboard"
        let paste = UIBarButtonItem(image: UIImage(systemName: "doc.on.clipboard"),
                                    primaryAction: UIAction { [weak self] _ in self?.onPaste() })
        paste.accessibilityLabel = "Paste"
        // Few enough items to fit a phone width (Liquid Glass groups would otherwise clip the ends).
        bar.items = [
            key("Esc", nil, 0xFF1B), key("Tab", nil, 0xFF09),
            key("Left", "arrow.left", 0xFF51), key("Right", "arrow.right", 0xFF53),
            .flexibleSpace(), paste, hide,
        ]
        bar.sizeToFit()
        return bar
    }()
    override var inputAccessoryView: UIView? { accessory }

    var hasText: Bool { true }
    var autocorrectionType: UITextAutocorrectionType = .no
    var autocapitalizationType: UITextAutocapitalizationType = .none
    var spellCheckingType: UITextSpellCheckingType = .no
    var smartQuotesType: UITextSmartQuotesType = .no
    var smartDashesType: UITextSmartDashesType = .no
    var smartInsertDeleteType: UITextSmartInsertDeleteType = .no
    var keyboardType: UIKeyboardType = .default
    var returnKeyType: UIReturnKeyType = .default

    func insertText(_ text: String) {
        var run = ""
        for ch in text {
            switch ch {
            case "\n", "\r":
                if !run.isEmpty { onText(run); run = "" }
                onKey(0xFF0D)
            case "\t":
                if !run.isEmpty { onText(run); run = "" }
                onKey(0xFF09)
            default: run.append(ch)
            }
        }
        if !run.isEmpty { onText(run) }
    }

    func deleteBackward() { onKey(0xFF08) }
}
