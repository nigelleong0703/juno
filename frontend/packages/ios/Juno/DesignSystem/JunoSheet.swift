import SwiftUI

// The sheet design language: every sheet that collects input is a `JunoSheet` (the request card's header, a scrolling
// body of `JunoFormField`s on the canvas, a pinned action bar) so the cards, the sheets and the web dialog read alike.
// Pure layout: no app state, the callers pass strings, bindings and actions.

/// Scaffold for an input sheet, on iOS 26's own sheet chrome: the system Liquid Glass sheet (no custom background),
/// the title centred in the navigation bar like every system sheet, a glass close (xmark) on the left and a
/// prominent glass confirm (checkmark) on the right, disabled until the form is valid. The body scrolls: guidance,
/// an optional note, then the `JunoFormField`s. Medium/large detents; long forms open at large.
/// Nothing to save (a sheet that only shows something and offers actions inside its body): leave `primary` out and there is
/// no confirm, only the close; add `fitsContent` and the sheet is as tall as its content instead of half a screen.
struct JunoSheet<Content: View>: View {
    var icon: String
    var title: String
    var guidance: String?
    var note: String?
    var noteIcon = "lock"
    /// The confirm's label; empty means a close-only sheet with no confirm.
    var primary = ""
    var primaryEnabled = true
    var loading = false
    var cancel = "Cancel"
    var long = false
    /// One detent as tall as the content (a short, read-only sheet).
    var fitsContent = false
    var id = "sheet"
    var onPrimary: () -> Void = {}
    var onCancel: () -> Void
    @ViewBuilder var content: Content

    var body: some View {
        if fitsContent {
            sheet.modifier(JunoFittedPresentation())
        } else {
            sheet.junoSheetPresentation(long: long)
        }
    }

    private var sheet: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    if let guidance, !guidance.isEmpty {
                        Text(guidance).text(.base).foregroundStyle(Theme.fgMuted).fixedSize(horizontal: false, vertical: true)
                    }
                    if let note { JunoNote(text: note, icon: noteIcon) }
                    content
                }
                .padding(.top, 8)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(GeometryReader { Color.clear.preference(key: JunoSheetContentHeight.self, value: $0.size.height) })
            }
            .scrollDismissesKeyboard(.interactively)
            .scrollBounceBehavior(.basedOnSize)
            .pageHeader(title)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(role: .close, action: onCancel) { Label(cancel, systemImage: "xmark") }
                        .disabled(loading)
                        .accessibilityIdentifier("\(id)-cancel")
                }
                if !primary.isEmpty {
                    ToolbarItem(placement: .confirmationAction) {
                        Button(role: .confirm, action: onPrimary) {
                            if loading { ProgressView() } else { Label(primary, systemImage: "checkmark") }
                        }
                        .buttonStyle(.glassProminent)
                        .tint(Theme.primary)
                        .disabled(!primaryEnabled || loading)
                        .accessibilityLabel(primary)
                        .accessibilityIdentifier("\(id)-submit")
                    }
                }
            }
        }
        .tint(Theme.fg)
    }
}

/// The height of a sheet's body, reported up to `JunoFittedPresentation`.
private struct JunoSheetContentHeight: PreferenceKey {
    static let defaultValue: CGFloat = 0
    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) { value = max(value, nextValue()) }
}

/// One detent as tall as the sheet's body plus its bar and the bottom margin (`JunoSheet` with `fitsContent`).
private struct JunoFittedPresentation: ViewModifier {
    /// The inline bar (title and close) and a little slack.
    private static let bar: CGFloat = 64
    @State private var height: CGFloat = 0

    func body(content: Content) -> some View {
        content
            .onPreferenceChange(JunoSheetContentHeight.self) { height = $0 }
            .junoSheetMargins()
            .presentationDetents([.height(height > 0 ? height + Self.bar + JunoSheetMetrics.bottom : 280)])
            .presentationDragIndicator(.visible)
    }
}

private struct JunoSheetPresentation: ViewModifier {
    var long: Bool
    @State private var detent: PresentationDetent

    init(long: Bool) {
        self.long = long
        // A short, glanceable sheet opens at medium (iOS 26's floating Liquid Glass sheet) and can be dragged to large.
        // A long one (a page or form that does not fit half a screen) opens at large only.
        _detent = State(initialValue: long ? .large : .medium)
    }

    func body(content: Content) -> some View {
        // No background or corner override: the system draws the Liquid Glass sheet (floating at medium, full at large).
        content
            .junoSheetMargins()
            .presentationDetents(long ? [.large] : [.medium, .large], selection: $detent)
            .presentationDragIndicator(.visible)
    }
}

/// How far a sheet's scrolling content stays from the sides and under its last row: the floating glass sheet has
/// large rounded corners that clip anything closer.
enum JunoSheetMetrics {
    static let side: CGFloat = 24
    static let bottom: CGFloat = 40
}

extension View {
    /// The corner-safe margins alone, for a sheet that sets its own detents. Reach every ScrollView / List / Form inside.
    func junoSheetMargins() -> some View {
        contentMargins(.horizontal, JunoSheetMetrics.side, for: .scrollContent)
            .contentMargins(.bottom, JunoSheetMetrics.bottom, for: .scrollContent)
            .scrollEdgeEffectStyle(.soft, for: .bottom)
    }

    /// Detents medium + large (opening at medium, the glass one), or large only when `long`; drag indicator, system glass sheet.
    /// A sheet's header is always the inline bar (centred title, close button), never a large title.
    func junoSheetPresentation(long: Bool = false) -> some View { modifier(JunoSheetPresentation(long: long)) }
}

/// The reassurance row under a sheet's header ("Typed straight into demoblaze.com. Juno never sees it…").
struct JunoNote: View {
    var text: String
    var icon = "lock"
    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 10) {
            Image(systemName: icon).text(.sm).foregroundStyle(Theme.fgMuted)
            Text(text).text(.sm).foregroundStyle(Theme.fgMuted).fixedSize(horizontal: false, vertical: true)
        }
        .padding(.horizontal, 14).padding(.vertical, 12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Theme.tile, in: .rect(cornerRadius: Radius.lg))
    }
}

/// A failure line at the top of a sheet's body (server rejection, "you still have control of the screen").
struct JunoMessage<Action: View>: View {
    var text: String
    var id: String?
    @ViewBuilder var action: Action
    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(text).text(.sm).foregroundStyle(Theme.danger).fixedSize(horizontal: false, vertical: true)
                .accessibilityIdentifier(id ?? "sheet-message")
            action
        }
        .padding(.horizontal, 14).padding(.vertical, 12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Theme.tile, in: .rect(cornerRadius: Radius.lg))
        .overlay(RoundedRectangle(cornerRadius: Radius.lg).strokeBorder(Theme.danger.opacity(0.4), lineWidth: 0.5))
    }
}

extension JunoMessage where Action == EmptyView {
    init(text: String, id: String? = nil) { self.init(text: text, id: id, action: { EmptyView() }) }
}

// MARK: - Fields

/// A labelled field: label (required is the default and unmarked, as on the web), an "Optional" marker when it is,
/// the input, then help or the error underneath (and an optional character counter).
struct JunoFormField<Input: View>: View {
    /// Agents often write "(optional)" into the prompt; the marker already says it.
    static func withoutOptionalSuffix(_ label: String) -> String {
        label.replacingOccurrences(of: #"\s*[(（]\s*(optional|可选|选填)\s*[)）]\s*$"#, with: "", options: [.regularExpression, .caseInsensitive])
    }

    var label: String
    var optional = false
    var help: String?
    var error: String?
    var counter: (count: Int, limit: Int)?
    @ViewBuilder var input: Input

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                Text(optional ? Self.withoutOptionalSuffix(label) : label).text(.sm, .medium).foregroundStyle(Theme.fg)
                    .fixedSize(horizontal: false, vertical: true)
                if optional { Text("Optional").text(.xs).foregroundStyle(Theme.fgSubtle) }
            }
            input
            VStack(alignment: .leading, spacing: 4) {
                if let error { Text(error).text(.xs).foregroundStyle(Theme.danger) }
                else if let help, !help.isEmpty { Text(help).text(.xs).foregroundStyle(Theme.fgMuted) }
                if let counter, counter.limit > 0, counter.count * 5 >= counter.limit * 4 {
                    Text("\(counter.count)/\(counter.limit)").text(.xs)
                        .foregroundStyle(counter.count >= counter.limit ? Theme.danger : Theme.fgSubtle).monospacedDigit()
                }
            }
            .fixedSize(horizontal: false, vertical: true)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// Field chrome around a value + chevron (pickers, dates).
private struct JunoFieldLabel: View {
    var text: String
    var placeholder: Bool
    var symbol = "chevron.up.chevron.down"
    var body: some View {
        HStack {
            Text(text).foregroundStyle(placeholder ? Theme.fgSubtle : Theme.fg).lineLimit(1)
            Spacer(minLength: 8)
            Image(systemName: symbol).text(.sm).foregroundStyle(Theme.fgSubtle)
        }
        .inputField()
        .contentShape(.rect)
    }
}

/// Value (or placeholder) + chevron in field chrome. With `options` it opens a `Menu`; with `action` it is a plain
/// button for a pushed searchable list (countries).
struct JunoPickerRow: View {
    var value: String
    var placeholder = "Select"
    var options: [String] = []
    /// Offered first in the menu when set ("None"); chooses "".
    var noneLabel: String?
    var id: String?
    private var action: (() -> Void)?
    private var onSelect: (String) -> Void = { _ in }

    /// A menu of `options`.
    init(value: String, placeholder: String = "Select", options: [String], noneLabel: String? = nil, id: String? = nil,
         onSelect: @escaping (String) -> Void) {
        self.value = value; self.placeholder = placeholder; self.options = options; self.noneLabel = noneLabel
        self.id = id; self.onSelect = onSelect
    }

    /// A button that opens something else (a searchable list).
    init(value: String, placeholder: String = "Select", id: String? = nil, action: @escaping () -> Void) {
        self.value = value; self.placeholder = placeholder; self.id = id; self.action = action
    }

    var body: some View {
        Group {
            if let action {
                Button(action: action) { label.contentShape(.rect) }.buttonStyle(.plain)
            } else {
                Menu {
                    if let noneLabel { Button(noneLabel) { onSelect("") } }
                    ForEach(options, id: \.self) { option in
                        Button { onSelect(option) } label: {
                            if option == value { Label(option, systemImage: "checkmark") } else { Text(option) }
                        }
                    }
                } label: { label }
                .tint(Theme.fg)
            }
        }
        .accessibilityIdentifier(id ?? "picker-row")
    }

    private var label: some View {
        JunoFieldLabel(text: value.isEmpty ? placeholder : value, placeholder: value.isEmpty,
                       symbol: action == nil ? "chevron.up.chevron.down" : "chevron.right")
    }
}

/// A date / time field: shows the value in field chrome; tapping expands a picker inline with Set / Clear.
struct JunoDateRow: View {
    var date: Date?
    var components: DatePickerComponents
    var range: ClosedRange<Date>
    var optional = false
    var placeholder = "Not set"
    var display: (Date) -> String
    var id: String?
    var setId: String?
    var onChange: (Date?) -> Void
    @State private var open = false
    @State private var draft = Date()

    var body: some View {
        VStack(spacing: 10) {
            Button { toggle() } label: {
                JunoFieldLabel(text: date.map(display) ?? placeholder, placeholder: date == nil, symbol: open ? "chevron.up" : "chevron.down")
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier(id ?? "date-row")
            if open {
                VStack(spacing: 8) {
                    let picker = DatePicker("", selection: Binding(get: { draft }, set: { draft = $0; if date != nil { onChange($0) } }),
                                            in: range, displayedComponents: components).labelsHidden()
                    if components == .hourAndMinute { picker.datePickerStyle(.wheel) } else { picker.datePickerStyle(.graphical) }
                    HStack(spacing: 8) {
                        if optional, date != nil {
                            Button("Clear") { onChange(nil); open = false }.buttonStyle(WebButton(variant: .secondary, size: .regular))
                        }
                        Spacer()
                        Button(date == nil ? "Set" : "Done") { if date == nil { onChange(draft) }; open = false }
                            .buttonStyle(WebButton(variant: .primary, size: .regular))
                            .accessibilityIdentifier(setId ?? "date-set")
                    }
                }
                .padding(12)
                .background(Theme.inputBg, in: .rect(cornerRadius: Radius.lg))
                .overlay(RoundedRectangle(cornerRadius: Radius.lg).strokeBorder(Theme.border, lineWidth: 1))
            }
        }
    }

    private func toggle() {
        if !open { draft = min(max(date ?? Date(), range.lowerBound), range.upperBound) }
        withAnimation(.snappy(duration: 0.2)) { open.toggle() }
    }
}

/// One choice in a list (choice / multi_choice): field chrome with a check on the right when picked.
struct JunoCheckRow: View {
    var title: String
    var selected: Bool
    var id: String?
    var action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack {
                Text(title).foregroundStyle(Theme.fg).multilineTextAlignment(.leading)
                Spacer(minLength: 8)
                if selected { Image(systemName: "checkmark").text(.base, .semibold).foregroundStyle(Theme.fg) }
            }
            .inputField()
            .overlay(RoundedRectangle(cornerRadius: Radius.lg).strokeBorder(selected ? Theme.fg : .clear, lineWidth: 1.5))
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(selected ? .isSelected : [])
        .accessibilityIdentifier(id ?? "check-row")
    }
}
