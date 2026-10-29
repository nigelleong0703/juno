import SwiftUI


/// Run failures arrive only as text; every message a provider setting fixes names "Settings > Models".
func isModelSetupError(_ message: String?) -> Bool {
    message?.range(of: #"settings\s*>\s*models"#, options: [.regularExpression, .caseInsensitive]) != nil
}

/// Specific copy for the backend's provider error codes; anything else gets one generic line.
func providerErrorMessage(_ error: Error) -> String {
    guard case let APIError.api(_, code, _) = error else { return "Couldn't save. Check the details and try again." }
    switch code {
    case "UNKNOWN_PROVIDER": return "That provider isn't available. Pick one from the list."
    case "UNKNOWN_MODEL": return "That model isn't in the provider's list. Pick another."
    case "UNSUPPORTED_EFFORT": return "That model doesn't offer this thinking level. Pick another level."
    case "MODEL_URL_BLOCKED": return "That address points to a private or local network, which can't be reached from the server. Use a public https address."
    case "BUILTIN_ENDPOINT_FIXED": return "A built-in provider's address can't be changed."
    case "NOT_FOUND": return "That provider no longer exists. Refresh and try again."
    case "MODEL_CATALOG_UNAVAILABLE": return "The provider's model list isn't available right now. Check the key and try again."
    default: return "Couldn't save. Check the details and try again."
    }
}

/// The error codes for which a ChatGPT login is already spent and a new one must be started.
func chatGPTLoginFailure(_ error: Error) -> String? {
    guard case let APIError.api(status, code, _) = error, status == 400 || status == 404 else { return nil }
    switch code {
    case "CALLBACK_INVALID": return "The address wasn't the full one from the browser."
    case "STATE_MISMATCH": return "The address came from a different sign-in."
    case "LOGIN_EXPIRED": return "The sign-in link expired."
    case "LOGIN_INVALID": return "That sign-in was already used."
    case "NOT_FOUND": return "That sign-in was not found."
    default: return nil
    }
}

// MARK: - Guidance

/// A quiet capsule above the composer (and on the first-agent form), like the web's ModelProviderNotice. It shows the
/// newest top-level run's failure when a provider setting fixes it (such a run posts nothing to the transcript), and
/// otherwise a prompt while the account cannot run an agent at all.
struct ModelProviderNotice: View {
    @Environment(World.self) private var world
    var conversationId: String?

    private var failure: String? {
        guard let conversationId else { return nil }
        let newest = world.runs.filter { $0.conversationId == conversationId && $0.parentRunId == nil }
            .max { ($0.startedAt ?? .distantPast) < ($1.startedAt ?? .distantPast) }
        return newest?.status == "failed" && isModelSetupError(newest?.error) ? newest?.error : nil
    }

    var body: some View {
        if failure != nil || world.modelProviders?.usable == false {
            HStack(spacing: 8) {
                Image(systemName: "exclamationmark.circle").font(.system(size: 13))
                Text(failure ?? "Add a model provider so your agents can reply")
                    .text(.sm).lineLimit(2).multilineTextAlignment(.leading)
                    .frame(maxWidth: .infinity, alignment: .leading)
                OpenModelSettingsButton(title: failure == nil ? "Add provider" : "Open model settings")
            }
            .foregroundStyle(failure == nil ? Theme.fgMuted : Theme.danger)
            .padding(.leading, 12).padding(.trailing, 6).padding(.vertical, 4)
            .background(failure == nil ? Theme.muted : Theme.danger.opacity(0.1), in: .rect(cornerRadius: Radius.lg))
            .overlay(RoundedRectangle(cornerRadius: Radius.lg).stroke(failure == nil ? Theme.border : Theme.danger.opacity(0.4), lineWidth: 1))
            .padding(.horizontal, 16)
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier("model-provider-notice")
        }
    }
}

/// Opens Settings → Models through the root sheet (`world.sheet = .models`), from wherever it sits.
struct OpenModelSettingsButton: View {
    @Environment(World.self) private var world
    var title: String
    var body: some View {
        Button(title) { world.sheet = .models }
            .buttonStyle(WebButton(variant: .ghost, size: .xs))
            .accessibilityIdentifier("open-model-settings")
    }
}
