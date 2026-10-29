import SwiftUI

/// The form for a `fields` question. The chat card shows the doc's blocks and an Answer button; typing happens here, in a
/// scrolling sheet, because inputs inside a transcript cell fight its precomputed height and the keyboard. Server
/// reasons (400 `error.fields`) show under their fields and the sheet stays open.
struct QuestionSheet: View {
    @Environment(World.self) private var world
    @Environment(\.dismiss) private var dismiss
    var requestId: String

    @State private var errors: [String: String] = [:]
    @State private var message: String?
    @State private var busy = false

    var body: some View {
        let request = world.request(requestId)
        let doc = request?.payload?.ui
        let name = world.agent(request?.agentId)?.name ?? "Your agent"
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    if let message { JunoMessage(text: message, id: "question-message") }
                    if let doc {
                        UiDocView(doc: doc, answering: UiDocAnswering(recorded: nil, errors: errors, busy: busy, openForm: nil) { answers in
                            Task { await submit(answers) }
                        })
                    }
                }
                .padding(.top, 8)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .scrollDismissesKeyboard(.interactively)
            .scrollBounceBehavior(.basedOnSize)
            .pageHeader(doc?.headline ?? request?.title ?? "\(name) has a question")
            .toolbar { CloseButton(identifier: "question-cancel") }
        }
        .tint(Theme.fg)
        .junoSheetPresentation(long: true)
    }

    private func submit(_ answers: [String: String]) async {
        busy = true; message = nil
        defer { busy = false }
        do { try await world.answerQuestion(requestId, answers: answers); dismiss() }
        catch APIError.fields(let text, let found) { errors = found; message = text.isEmpty ? "Some answers need fixing." : text }
        catch { message = "Could not send. Try again." }
    }
}
