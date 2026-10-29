import Foundation

extension Contract.RunOrigin {
    /// The "who started it" line under an activity row. Same words on the web and Android apps. A routine shows its name when the
    /// routines list has it; a system wake shows what woke the agent (`label`, else the wake kind in plain words), and nothing for an
    /// entry no run belongs to.
    func startedByLine(routineName: String?) -> String {
        switch type {
        case "owner_message": return "Started by you"
        case "channel":
            let platform = ChannelPlatform(kind: channel)?.name ?? channel ?? "a chat"
            switch speaker {
            case "owner": return "Started by you on \(platform)"
            case "member": return "Started by a member on \(platform)"
            default: return "Started by a stranger on \(platform)"
            }
        case "routine": return routineName.map { "Started by a routine \u{00B7} \($0)" } ?? "Started by a routine"
        case "parent_run": return "Started by an agent task"
        default:
            let what = label ?? (wakeKind == "system" || wakeKind == nil ? nil : wakeKind?.replacingOccurrences(of: "_", with: " "))
            return what.map { "Started by the system \u{00B7} \($0)" } ?? "Started by the system"
        }
    }
}

/// The audit decision in the words the Rules Activity list uses (same as the web page).
func auditDecisionLabel(_ decision: String?) -> String {
    switch decision {
    case "auto_allowed": "Acted on its own"
    case "asked": "Asked first"
    case "approved": "You approved"
    case "denied": "You denied"
    case "revised": "You sent it back"
    case "timed_out": "Timed out"
    case "handed_off": "Handed off"
    default: decision ?? ""
    }
}
