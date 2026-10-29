import SwiftUI

// Letting an agent decide a kind of thing alone, within limits: the editable limit fields of one category, the
// sheet behind "Allow this kind…" on a decision card, and the "Change it…" note sheet.

/// The limits a category has, and only those: money for spending, replies and a daily count for speaking, accept-only
/// for committing, a daily count for public posts. Edits a binding; the caller saves it.
struct DelegationLimitFields: View {
    var category: String?
    @Binding var limits: Contract.DelegationLimits

    private var currency: String { limits.perPurchase?.currency ?? limits.perMonth?.currency ?? "USD" }

    /// Spending needs an amount per purchase; the rest are valid as they are.
    static func isValid(_ category: String?, _ limits: Contract.DelegationLimits) -> Bool {
        category != "spending" || (limits.perPurchase?.amount.flatMap { Decimal(string: $0) } ?? 0) > 0
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            switch category {
            case "spending":
                JunoFormField(label: "Each purchase (\(currency))") { amountField($limits.perPurchase, id: "limit-purchase") }
                JunoFormField(label: "Each month (\(currency))", optional: true) { amountField($limits.perMonth, id: "limit-month") }
                switchRow("Allow subscriptions", isOn: Binding(get: { limits.allowRecurring ?? false }, set: { limits.allowRecurring = $0 }), id: "limit-recurring")
            case "speaking":
                switchRow("Replies only", isOn: Binding(get: { limits.replyOnly ?? false }, set: { limits.replyOnly = $0 }), id: "limit-reply")
                perDay
            case "committing":
                switchRow("Accept invitations only", isOn: Binding(get: { limits.acceptOnly ?? false }, set: { limits.acceptOnly = $0 }), id: "limit-accept")
            case "public":
                perDay
            default:
                EmptyView()
            }
        }
    }

    private func amountField(_ limit: Binding<Contract.MoneyLimit?>, id: String) -> some View {
        TextField("0.00", text: Binding(
            get: { limit.wrappedValue?.amount ?? "" },
            set: { text in
                let clean = text.filter { $0.isNumber || $0 == "." }
                limit.wrappedValue = clean.isEmpty ? nil : Contract.MoneyLimit(amount: clean, currency: currency)
            }))
            .keyboardType(.decimalPad).accessibilityIdentifier(id).inputField()
    }

    private func switchRow(_ title: String, isOn: Binding<Bool>, id: String) -> some View {
        Toggle(title, isOn: isOn).tint(Theme.success).accessibilityIdentifier(id).inputField()
    }

    private var perDay: some View {
        let count = Binding(get: { limits.maxPerDay ?? 10 }, set: { limits.maxPerDay = $0 })
        return Stepper("Up to \(count.wrappedValue) a day", value: count, in: 1...200).accessibilityIdentifier("limit-per-day").inputField()
    }
}

/// "Allow this kind…": the limits the server suggests, editable, then approve this request and create the delegation.
struct DelegateSheet: View {
    @Environment(World.self) private var world
    @Environment(\.dismiss) private var dismiss
    var request: AgentRequest
    @State private var drafts: [Contract.DelegationDraft] = []

    var body: some View {
        let name = world.agent(request.agentId)?.name ?? "Your agent"
        let valid = !drafts.isEmpty && drafts.allSatisfy { DelegationLimitFields.isValid($0.category, $0.limits ?? .init()) }
        JunoSheet(icon: "checkmark.shield", title: "Allow this kind",
                  guidance: "\(name) decides this on its own within these limits, and asks you about anything else. You can change or revoke it in Permissions.",
                  primary: "Allow", primaryEnabled: valid, long: true, id: "delegate",
                  onPrimary: { world.resolve(request.id, decision: "approved", scope: "delegate", delegations: drafts); dismiss() },
                  onCancel: { dismiss() }) {
            ForEach(drafts.indices, id: \.self) { i in
                VStack(alignment: .leading, spacing: 14) {
                    HStack(alignment: .firstTextBaseline, spacing: 8) {
                        Image(systemName: DecisionWords.symbol(drafts[i].category)).text(.md).foregroundStyle(Theme.fgMuted)
                        // Sharing has no limits to set, so its heading says what it allows: "Always allow files from #work in #general".
                        Text(drafts[i].category == "sharing" ? drafts[i].sharingSentence(chatName: world.chatName) : DecisionWords.name(drafts[i].category))
                            .text(.md, .semibold).foregroundStyle(Theme.fg).fixedSize(horizontal: false, vertical: true)
                    }
                    DelegationLimitFields(category: drafts[i].category, limits: Binding(
                        get: { drafts[i].limits ?? .init() }, set: { drafts[i].limits = $0 }))
                }
            }
        }
        .onAppear { drafts = request.payload?.delegationOffer?.suggested ?? [] }
    }
}

/// "Change it…": tell the agent what to change; the request is sent back as a denial with the note.
struct ReviseSheet: View {
    @Environment(World.self) private var world
    @Environment(\.dismiss) private var dismiss
    var request: AgentRequest
    @State private var note = ""

    var body: some View {
        let name = world.agent(request.agentId)?.name ?? "Your agent"
        JunoSheet(icon: "arrow.uturn.backward", title: "Change it", guidance: "\(name) won't do this as asked and tries again with your note.",
                  primary: "Send back", primaryEnabled: !note.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, id: "revise",
                  onPrimary: { world.resolve(request.id, decision: "denied", note: note, reason: "revise"); dismiss() },
                  onCancel: { dismiss() }) {
            JunoFormField(label: "What should change?") {
                TextField("For example: only the small one, or ask Mei first", text: $note, axis: .vertical)
                    .lineLimit(3...8).padding(.vertical, 12).accessibilityIdentifier("revise-note").inputField()
            }
        }
    }
}
