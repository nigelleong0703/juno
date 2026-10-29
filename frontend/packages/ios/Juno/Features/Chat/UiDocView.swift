import SwiftUI

// Juno UI blocks (BACKEND 8.7.1) drawn natively: the one renderer for question cards, the checkout card and agent
// messages. Web twin: components/uidoc/UiDoc.tsx. One view per block type; lists are capped with "Show N more"; a doc
// this app cannot draw shows the server-written `text`, never nothing. It is a plain VStack (no lazy containers, no
// async size changes) so the chat list can measure the hosting row exactly before it appears.

/// How a question card answers: the doc's one interactive block calls `onAnswer`.
struct UiDocAnswering {
    /// A decided question: the recorded answers show in place of inputs.
    var recorded: [String: String]?
    var errors: [String: String] = [:]
    var busy = false
    /// Fields in the transcript would fight the list's row height and the keyboard: show "Answer" and open the form in a sheet.
    var openForm: (() -> Void)?
    var onAnswer: ([String: String]) -> Void
}

struct UiDocView: View {
    var doc: UiDoc
    var showTitle = false
    var answering: UiDocAnswering?

    private static let itemCap = 5
    private static let rowCap = 6

    var body: some View {
        if !doc.isRenderable {
            Text(doc.text ?? "").text(.base).foregroundStyle(Theme.fg).fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: .infinity, alignment: .leading).accessibilityIdentifier("ui-fallback")
        } else {
            VStack(alignment: .leading, spacing: 12) {
                if showTitle, let title = doc.title { Text(title).text(.md, .semibold).foregroundStyle(Theme.fg) }
                ForEach(Array(doc.blocks.enumerated()), id: \.offset) { _, block in
                    UiBlockView(block: block, nested: false, answering: answering)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }
}

struct UiBlockView: View {
    @Environment(World.self) private var world
    var block: UiBlock
    var nested: Bool
    var answering: UiDocAnswering?

    var body: some View {
        switch block {
        case .text(let text):
            Text(text).text(.base).foregroundStyle(Theme.fg).fixedSize(horizontal: false, vertical: true)
        case .facts(let rows): UiTile(nested: nested) { UiFactsList(rows: rows) }
        case .items(let rows, let total): UiTile(nested: nested) { UiItemsList(rows: rows, total: total) }
        case .table(let columns, let rows): UiTile(nested: nested) { UiTable(columns: columns, rows: rows) }
        case .notice(let tone, let text): UiNotice(tone: tone, text: text)
        case .link(let url, let title, let subtitle): UiLink(url: url, title: title, subtitle: subtitle)
        case .image(let id, let caption): UiImage(libraryId: id, caption: caption)
        case .group(let title, let inner):
            VStack(alignment: .leading, spacing: 10) {
                if let title { Text(title).text(.md, .semibold).foregroundStyle(Theme.fg) }
                ForEach(Array(inner.enumerated()), id: \.offset) { _, child in UiBlockView(block: child, nested: true, answering: nil) }
            }
            .padding(.horizontal, 14).padding(.vertical, 12)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Theme.tile, in: .rect(cornerRadius: Radius.tile))
        case .choices(let choices):
            if let answering { UiChoicesView(block: choices, answering: answering) }
        case .fields(let fields):
            if let answering {
                if let open = answering.openForm, answering.recorded == nil {
                    CardPrimaryButton(title: "Answer", enabled: !answering.busy, id: "question-answer", action: open)
                } else {
                    UiFieldsForm(block: fields, answering: answering)
                }
            }
        case .replies, .unknown: EmptyView()
        }
    }
}

/// The grey rounded surface top-level display blocks sit on (a group is the surface itself, so inside it there is none).
private struct UiTile<Content: View>: View {
    var nested: Bool
    @ViewBuilder var content: Content
    var body: some View {
        if nested { content } else {
            content.padding(.horizontal, 14).padding(.vertical, 12).frame(maxWidth: .infinity, alignment: .leading)
                .background(Theme.tile, in: .rect(cornerRadius: Radius.tile))
        }
    }
}

private struct UiShowMore: View {
    var hidden: Int
    var action: () -> Void
    var body: some View {
        Button(action: action) { Text("Show \(hidden) more").text(.sm, .medium).foregroundStyle(Theme.fgMuted) }
            .buttonStyle(.plain).padding(.top, 2).accessibilityIdentifier("ui-show-more")
    }
}

/// Label on the left (muted), value on the right; `emphasis` makes a value semibold.
private struct UiFactsList: View {
    var rows: [UiFact]
    var body: some View {
        VStack(spacing: 6) {
            ForEach(Array(rows.enumerated()), id: \.offset) { _, row in
                HStack(alignment: .firstTextBaseline, spacing: 16) {
                    Text(row.label).text(.base).foregroundStyle(Theme.fgMuted).fixedSize(horizontal: false, vertical: true)
                    Spacer(minLength: 0)
                    Text(row.value).text(.base, row.emphasis ? .semibold : .regular).foregroundStyle(Theme.fg)
                        .multilineTextAlignment(.trailing).fixedSize(horizontal: false, vertical: true)
                }
            }
        }
    }
}

private struct UiItemsList: View {
    var rows: [UiItemRow]
    var total: UiFact?
    @State private var all = false
    @Environment(\.rowResized) private var rowResized
    var body: some View {
        let shown = all ? rows : Array(rows.prefix(5))
        VStack(alignment: .leading, spacing: 10) {
            ForEach(Array(shown.enumerated()), id: \.offset) { _, row in
                HStack(spacing: 12) {
                    if let url = row.imageUrl {
                        // A fixed frame either way: the picture arrives after the row is measured.
                        RemoteImage(url: url, maxSide: 80) { phase in
                            if let image = phase.image {
                                image.resizable().scaledToFill()
                            } else {
                                Theme.requestCard
                            }
                        }
                        .frame(width: 40, height: 40).clipShape(.rect(cornerRadius: 8))
                    }
                    VStack(alignment: .leading, spacing: 1) {
                        Text(row.name).text(.base).foregroundStyle(Theme.fg).lineLimit(2)
                        if let detail = row.detail { Text(detail).text(.sm).foregroundStyle(Theme.fgMuted).lineLimit(1) }
                    }
                    Spacer(minLength: 8)
                    if let q = row.quantity, q > 1 { Text("×\(q)").text(.base).foregroundStyle(Theme.fgMuted) }
                    if let price = row.price { Text(price).text(.base).foregroundStyle(Theme.fg) }
                }
            }
            if rows.count > shown.count { UiShowMore(hidden: rows.count - shown.count) { withAnimation(.snappy(duration: 0.2)) { all = true } } }
            if let total {
                Divider().overlay(Theme.border)
                HStack { Text(total.label).text(.md); Spacer(); Text(total.value).text(.md, .semibold) }.foregroundStyle(Theme.fg)
            }
        }
    }
}

/// Columns side by side, scrolling sideways when they do not fit a phone.
private struct UiTable: View {
    var columns: [String]
    var rows: [[String]]
    @State private var all = false
    var body: some View {
        let shown = all ? rows : Array(rows.prefix(6))
        VStack(alignment: .leading, spacing: 8) {
            ScrollView(.horizontal, showsIndicators: false) {
                Grid(alignment: .leading, horizontalSpacing: 18, verticalSpacing: 8) {
                    GridRow { ForEach(Array(columns.enumerated()), id: \.offset) { _, c in Text(c).text(.sm, .medium).foregroundStyle(Theme.fgMuted) } }
                    ForEach(Array(shown.enumerated()), id: \.offset) { _, row in
                        Divider().overlay(Theme.border).gridCellUnsizedAxes(.horizontal)
                        GridRow { ForEach(Array(row.enumerated()), id: \.offset) { _, cell in Text(cell).text(.sm).foregroundStyle(Theme.fg).lineLimit(1) } }
                    }
                }
            }
            if rows.count > shown.count { UiShowMore(hidden: rows.count - shown.count) { withAnimation(.snappy(duration: 0.2)) { all = true } } }
        }
    }
}

/// Tinted by tone: warning and success take the status colours, info is neutral grey (no blue anywhere).
private struct UiNotice: View {
    var tone: String
    var text: String
    var body: some View {
        let (symbol, color): (String, Color) = switch tone {
        case "warning": ("exclamationmark.triangle.fill", Theme.warning)
        case "success": ("checkmark.circle.fill", Theme.success)
        default: ("info.circle.fill", Theme.fgSubtle)
        }
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: symbol).text(.md).foregroundStyle(color)
            Text(text).text(.base).foregroundStyle(Theme.fg).fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 14).padding(.vertical, 12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(color.opacity(0.14), in: .rect(cornerRadius: Radius.tile))
        .accessibilityElement(children: .combine)
    }
}

private struct UiLink: View {
    var url: URL
    var title: String
    var subtitle: String?
    var body: some View {
        Link(destination: url) {
            HStack(spacing: 12) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(title).text(.base, .medium).foregroundStyle(Theme.fg).lineLimit(1)
                    if let subtitle { Text(subtitle).text(.sm).foregroundStyle(Theme.fgMuted).lineLimit(1) }
                }
                Spacer(minLength: 8)
                Image(systemName: "arrow.up.right").text(.sm, .semibold).foregroundStyle(Theme.fgSubtle)
            }
            .padding(.horizontal, 14).padding(.vertical, 12)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Theme.tile, in: .rect(cornerRadius: Radius.tile))
        }
    }
}

/// A library image, loaded through the authenticated download; the frame is fixed so the row never grows when it arrives.
private struct UiImage: View {
    @Environment(World.self) private var world
    var libraryId: String
    var caption: String?
    @State private var image: UIImage?
    @State private var viewing = false
    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            CardPreview(image: image) { EmptyView() }
                .contentShape(.rect).onTapGesture { if image != nil { viewing = true } }
            if let caption { Text(caption).text(.sm).foregroundStyle(Theme.fgMuted).padding(.horizontal, 2) }
        }
        .task { image = await world.previewImage(libraryId) }
        .sheet(isPresented: $viewing) { ImageViewer(image: image) }
    }
}

// MARK: - Interactive blocks

/// Options as full-width buttons. One choice answers on tap; several toggle and send with Submit.
private struct UiChoicesView: View {
    var block: UiChoices
    var answering: UiDocAnswering
    @State private var picked: [String] = []

    var body: some View {
        let recorded = answering.recorded.map { UiAnswers.decodeChoice($0[block.id], multiple: block.multiple) }
        let selected = recorded ?? picked
        VStack(alignment: .leading, spacing: 8) {
            ForEach(block.options) { option in
                let on = selected.contains(option.id)
                Button { tap(option) } label: { optionLabel(option, on: on) }
                    .buttonStyle(.plain)
                    .disabled(recorded != nil || answering.busy)
                    .accessibilityIdentifier("choice-\(option.id)")
                    .accessibilityAddTraits(on ? .isSelected : [])
            }
            if let message = answering.errors[block.id] { Text(message).text(.sm).foregroundStyle(Theme.danger) }
            if block.multiple, recorded == nil {
                CardPrimaryButton(title: "Submit", enabled: !picked.isEmpty, loading: answering.busy, id: "question-submit") {
                    answering.onAnswer([block.id: UiAnswers.encodeChoice(block.options.map(\.id).filter(picked.contains))])
                }
            }
        }
    }

    private func tap(_ option: UiChoiceOption) {
        if block.multiple { picked = picked.contains(option.id) ? picked.filter { $0 != option.id } : picked + [option.id] }
        else { picked = [option.id]; answering.onAnswer([block.id: option.id]) }
    }

    private func optionLabel(_ option: UiChoiceOption, on: Bool) -> some View {
        let primary = option.style == "primary" && !(on && block.multiple)
        let ink: Color = primary ? Theme.primaryFg : option.style == "destructive" ? Theme.danger : Theme.fg
        return HStack(spacing: 10) {
            VStack(alignment: .leading, spacing: 2) {
                Text(option.label).text(.lg, on ? .semibold : .regular).foregroundStyle(ink).multilineTextAlignment(.leading)
                if let d = option.description { Text(d).text(.sm).foregroundStyle(primary ? ink.opacity(0.7) : Theme.fgMuted).multilineTextAlignment(.leading) }
            }
            Spacer(minLength: 0)
            if on { Image(systemName: "checkmark").text(.base, .bold).foregroundStyle(ink) }
        }
        .padding(.horizontal, 16).padding(.vertical, 12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(primary ? Theme.primary : Theme.tile, in: .rect(cornerRadius: Radius.tile))
        .overlay(RoundedRectangle(cornerRadius: Radius.tile).strokeBorder(on && !primary ? Theme.fg : .clear, lineWidth: 1.5))
        .contentShape(.rect(cornerRadius: Radius.tile))
    }
}

/// A small form (text / number / date / select) checked with the contract's rules; server reasons show per field.
struct UiFieldsForm: View {
    var block: UiFields
    var answering: UiDocAnswering
    @State private var values: [String: String] = [:]
    @State private var shown = false
    @State private var serverErrors: [String: String] = [:]

    var body: some View {
        let recorded = answering.recorded
        let problems = UiAnswers.problems(block, values)
        VStack(alignment: .leading, spacing: 16) {
            ForEach(block.fields) { field in
                let error = serverErrors[field.id] ?? (shown ? problems[field.id] : nil)
                JunoFormField(label: field.label, optional: !field.required, error: error) { input(field, readOnly: recorded != nil) }
            }
            if recorded == nil {
                CardPrimaryButton(title: "Submit", enabled: true, loading: answering.busy, id: "question-submit") {
                    if problems.isEmpty { answering.onAnswer(UiAnswers.payload(block, values)) } else { shown = true }
                }
            }
        }
        .onAppear { if let recorded { values = recorded } }
        .onChange(of: answering.errors) { _, new in serverErrors = new }
    }

    private func binding(_ field: UiField) -> Binding<String> {
        Binding(get: { values[field.id] ?? "" }, set: { values[field.id] = $0; serverErrors[field.id] = nil })
    }

    @ViewBuilder private func input(_ field: UiField, readOnly: Bool) -> some View {
        let placeholder = field.placeholder ?? ""
        switch field.kind {
        case "select":
            JunoPickerRow(value: values[field.id] ?? "", placeholder: placeholder.isEmpty ? "Select" : placeholder, options: field.options,
                          id: "ui-field-\(field.id)") { values[field.id] = $0; serverErrors[field.id] = nil }
                .disabled(readOnly)
        case "date":
            JunoDateRow(date: UiAnswers.parseDate(values[field.id] ?? ""), components: .date, range: .distantPast ... .distantFuture,
                        optional: !field.required, placeholder: placeholder.isEmpty ? "Pick a date" : placeholder,
                        display: { UiAnswers.formatDate($0) }, id: "ui-field-\(field.id)", setId: "ui-set-\(field.id)") { new in
                values[field.id] = new.map(UiAnswers.formatDate) ?? ""
                serverErrors[field.id] = nil
            }
            .disabled(readOnly)
        default:
            TextField(placeholder, text: binding(field))
                .keyboardType(field.kind == "number" ? .numbersAndPunctuation : .default)
                .disabled(readOnly)
                .accessibilityIdentifier("ui-field-\(field.id)")
                .inputField()
        }
    }
}
