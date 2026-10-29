import Foundation

/// The official AG-UI payload fields are open JSON in the generated contract. Encode a typed product value once at
/// that boundary instead of hand-building and silently dropping newly added fields.
func encodedJSONValue<T: Encodable>(_ value: T) -> JSONValue {
    guard let data = try? JSONEncoder().encode(value),
          let json = try? JSONDecoder().decode(JSONValue.self, from: data) else { return .null }
    return json
}

// Flat, lenient models for the server's JSON.
// Only `id` is required; everything else is optional so one field change never blanks the app.

struct Avatar: Codable, Hashable {
    var shape: String?
    var color: Int?
    var eyes: String?
    var accessory: String?
    var thumbs: [String: String]?
    /// The agent's animated character (web characters/); nil: AvatarView picks one from the agent id.
    var character: String?
}

struct Agent: Codable, Identifiable, Hashable {
    var id: String
    /// May also use the owner's Mac next to its sandbox (Agent.macAccess).
    var macAccess: Bool?
    var name: String?
    var handle: String?
    var title: String?
    /// The user who created the agent; only they can edit its identity files.
    var createdBy: String?
    var status: String?
    /// Set while the owner has paused the agent; the pause button follows it, not `status`.
    var pausedAt: Date?
    var section: String?
    var lastActivity: String?
    var lastActivityAt: Date?
    var unreadCount: Int?
    var needsYou: Int?
    var avatar: Avatar?
    var skillIds: [String]?
    var pluginIds: [String]?
    /// Suggested from the first messages in its chat (BACKEND §10.11); the user confirms or dismisses it.
    var roleSuggestion: RoleSuggestion?
    var roleSuggestionDismissedAt: Date?
    var permissionTiers: Contract.PermissionTiers?
}

struct RoleSuggestion: Codable, Hashable {
    var title: String
    var description: String?
    var createdAt: Date?
}

struct Member: Codable, Identifiable, Hashable {
    var id: String
    var name: String?
}

struct Conversation: Codable, Identifiable, Hashable {
    var id: String
    var kind: String?
    var title: String?
    var agentIds: [String]?
    var memberIds: [String]?
    var unreadCount: Int?
    var needsYou: Int?
    var pinned: Bool?
    var muted: Bool?
    var lastMessagePreview: String?
    var lastItemAt: Date?
    /// Where the conversation came from when it is a messaging-platform chat (Telegram, Slack, ...); nil for in-app chats.
    var channel: ConversationChannel?
}

struct ConversationChannel: Codable, Hashable {
    var kind: String?
    var channelId: String?
}

extension Conversation {
    /// A chat that lives on a messaging platform and is not the owner's own conversation: a group / channel, or a
    /// stranger's direct message (titled "Name · Slack"). The owner's platform DMs are the in-app chat, so these stay
    /// out of the main list and under Groups. Same rule as the web sidebar (chatEntries.ts).
    var isChannelChat: Bool { channel != nil && (kind != "direct" || !(title ?? "").isEmpty) }
}

struct Todo: Codable, Identifiable, Hashable {
    var id: String
    var text: String?
    var status: String?
    var note: String?
}

/// A file sent with a message (POST /v1/uploads returns it; the message carries it as is).
struct Attachment: Codable, Hashable, Identifiable {
    var id: String
    var name: String
    var kind: String?
    var mimeType: String?
    var sizeBytes: Int?
    var url: String?
}

struct Citation: Codable, Hashable {
    var title: String?
    var url: String?
}

/// A tagged recipient in a message (public-contracts mentionSchema). "@all" / "@everyone" are agent mentions with that alias as id.
struct Mention: Codable, Hashable {
    var kind: String
    var id: String
    var label: String
}

/// One entry in a conversation's message stream; `type` picks which optional fields are set.
struct Item: Codable, Identifiable, Hashable {
    var id: String
    var conversationId: String?
    var at: Date?
    var type: String?
    // user_message
    var authorId: String?
    var text: String?
    var attachments: [Attachment]?
    var mentions: [Mention]?
    /// The platform chat a user message arrived from (Slack, Telegram, ...); nil when typed in the app.
    var source: Contract.ChannelOrigin?
    /// Who wrote it when it came from a messaging platform; a `stranger` is anyone but the owner.
    var channelSender: Contract.Item.ChannelSender?
    /// The agent's emoji on the message, set after it read it.
    var reaction: String?
    // agent_message
    var agentId: String?
    var markdown: String?
    /// Where an agent reply was also sent (a platform chat); nil for replies that stayed in the app.
    var replyTo: Contract.ChannelOrigin?
    var citations: [Citation]?
    /// Structured card under the lead-in (`markdown`), see UiDoc.
    var ui: UiDoc?
    // run / plan
    var runId: String?
    var todos: [Todo]?
    // request / artifact / routine
    var requestId: String?
    var artifactId: String?
    var routineId: String?
    var change: String?
    // handoff (agentId is the agent handing off; both are optional on older items)
    var toAgentId: String?
    var direction: String?
    var durationMs: Int?
    // system
    var level: String?
    var action: SystemAction?
    // role_suggestion (agentId + the suggestion as it was made; its state comes from the agent)
    var title: String?
    var description: String?
    var suggestionAt: Date?
    // feed_ref (agentId + the post it put on the Feed; `title` is the post's)
    var feedPostId: String?
    var imageUrl: String?
    var summary: String?
}

struct SystemAction: Codable, Hashable {
    var label: String?
    var command: String?
}

struct StepOutput: Codable, Hashable {
    var summary: String?
    var text: String?
}

struct StepInput: Codable, Hashable {
    var summary: String?
    var command: String?
    var url: String?
    var text: String?
}

struct Step: Codable, Identifiable, Hashable {
    var id: String
    var index: Int?
    var kind: String?
    var verb: String?
    var target: String?
    var input: StepInput?
    var output: StepOutput?
    var status: String?
    var startedAt: Date?
    var durationMs: Int?
    var screenshotRef: String?
    var title: String?
    var detail: String?
    /// Plumbing the backend marks (finding a tool or skill, the agent's own bookkeeping, reading back an observation): left out of
    /// the activity list. Absent = a step the person should see.
    var `internal`: Bool?
}

struct RunUsage: Codable, Hashable {
    var costUsd: Double?
    var steps: Int?
}

struct Run: Codable, Identifiable, Hashable {
    var id: String
    var agentId: String?
    var conversationId: String?
    var title: String?
    var status: String?
    var kind: String?
    var steps: [Step]?
    var usage: RunUsage?
    var startedAt: Date?
    var finishedAt: Date?
    var durationMs: Int?
    var triggerLabel: String?
    var error: String?
    var parentRunId: String?
    var childRunIds: [String]?
    var summary: String?
    /// True once the agent (not the owner's raw message) named the run; until then `title` is what the owner said.
    var titleGenerated: Bool?
}

struct Plan: Codable, Identifiable, Hashable {
    var id: String
    var conversationId: String?
    var runId: String?
    var title: String?
    var todos: [Todo]?
}

struct Draft: Codable, Hashable {
    var subject: String?
    var body: String?
}

struct QuestionField: Codable, Identifiable, Hashable {
    var id: String
    var prompt: String?
    var kind: String?
    var options: [String]?
    var required: Bool?
    var answer: String?
    // secure_input fields: what to ask for, which page element it fills, and whether it landed
    var label: String?
    var ref: String?
    /// The vault entry (SecureVault id) the agent says fits this field
    var vaultId: String?
    var status: String?
    // typed question fields (all optional so older servers and regenerated contracts still decode)
    var placeholder: String?
    var help: String?
    var min: FieldBound?
    var max: FieldBound?
    var step: FieldBound?
    var maxLength: Int?
}

/// A bound that the server sends as a number (number fields) or an ISO string (date / time fields).
enum FieldBound: Codable, Hashable {
    case number(Double)
    case text(String)

    init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if let n = try? c.decode(Double.self) { self = .number(n) }
        else { self = .text((try? c.decode(String.self)) ?? "") }
    }
    func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        switch self { case .number(let n): try c.encode(n); case .text(let s): try c.encode(s) }
    }
    var number: Double? {
        switch self { case .number(let n): n; case .text(let s): Double(s.trimmingCharacters(in: .whitespaces)) }
    }
    var string: String? {
        switch self { case .number: nil; case .text(let s): s.isEmpty ? nil : s }
    }
}

/// Request payload, flattened across approval / question / signin / admin.
struct RequestPayload: Codable, Hashable {
    var kind: String?
    var action: String?
    var target: String?
    var app: String?
    var site: String?
    var recipient: String?
    var why: String?
    /// A short line under the summary (an approval's privacy reminder); the card shows nothing without it.
    var notice: String?
    var draft: Draft?
    /// question: the card; approval: the checkout card built by the server
    var ui: UiDoc?
    var answers: [String: String]?
    /// secure_input
    var fields: [QuestionField]?
    var url: String?
    var reason: String?
    var requester: String?
    var details: String?
    // purchase approvals: what is being bought, and a screenshot of the page (library item)
    var purchase: Contract.ApprovalPurchase?
    var preview: Contract.RequestPayload.Preview?
    // computer (take-over) requests: the element the agent needs the user's hands on, in screen pixels
    var focus: Contract.RequestPayload.Focus?
    var screenId: String?
    var previewAt: Date?
    // secure_input: the sandbox key the values are sealed to
    var encryption: Contract.SecureInputEncryption?
    // connect: the apps the task needs (app ids, and `mac`), what is wrong with each (`not_added`, `not_enabled`, `expired`), their human name, and the routine waiting
    var appIds: [String]?
    var problems: [String: String]?
    var label: String?
    var routineId: String?
    // approval: the decision brief (what, why, consequences, platform) and what "Allow this kind" would delegate
    var brief: Contract.DecisionBrief?
    var delegationOffer: Contract.DelegationOffer?
    // approval: an agent wants to use (or bring to the front) an app on the owner's Mac
    var macApp: Contract.ApprovalPayload.MacApp?
}

struct AgentRequest: Codable, Identifiable, Hashable {
    var id: String
    var resolvedAt: Date?
    var kind: String?
    var status: String?
    var title: String?
    var summary: String?
    var agentId: String?
    var conversationId: String?
    var runId: String?
    var createdAt: Date?
    var payload: RequestPayload?
    /// Server-derived result of a decided request (`Contract.RequestOutcome`); the client only words it.
    var outcome: String?
    var triggeringRuleId: String?
    var decision: Contract.RequestDecision?
}

struct LibraryItem: Codable, Identifiable, Hashable {
    var id: String
    var name: String?
    var kind: String?
    var mimeType: String?
    var sizeBytes: Int?
    var createdByAgentId: String?
    var conversationId: String?
    var folder: String?
    var pinned: Bool?
    var createdAt: Date?
    /// "agent" (made by an agent) or "upload"; "private" or "team".
    var source: String?
    var shared: String?
    // published artifacts (artifact_publish): how to show it, the newest version, every version
    var render: String?
    var version: Int?
    var versions: [Contract.ArtifactVersion]?
    /// `render == "app"` only: the Space this card opens.
    var spaceId: String?
}

struct RoutineTrigger: Codable, Hashable {
    var kind: String?
    var human: String?
    /// Schedule triggers: the 5-field cron and the timezone it is written in (`CronSchedule`).
    var cron: String?
    var tz: String?
    var endDate: String?
}

struct Routine: Codable, Identifiable, Hashable {
    var id: String
    var agentId: String?
    var name: String?
    var instructions: String?
    var trigger: RoutineTrigger?
    var enabled: Bool?
    var status: String?
    /// While `status` is `needs_setup`: the apps or capabilities it waits on (`label` names them; `options` are catalog ids).
    var missing: [Contract.RoutineMissing]?
    var lastRunAt: Date?
    var nextRunAt: Date?
    var lastRunStatus: String?
    /// Recent runs (the wire's `runs`; `runs` is already the on/off flag in `Routine.runs`).
    var history: [Contract.RoutineRun]?

    enum CodingKeys: String, CodingKey {
        case id, agentId, name, instructions, trigger, enabled, status, missing, lastRunAt, nextRunAt, lastRunStatus
        case history = "runs"
    }
}

/// A skill is its definition plus the active version the agent loads (public-contracts 0.61.0). Its text is the active
/// version's; `name` and `description` read through so the lists stay short.
struct Skill: Codable, Identifiable, Hashable {
    var id: String
    var scope: String?
    var agentId: String?
    var active: SkillVersion?
    var createdAt: Date?

    var name: String? { active?.name }
    var description: String? { active?.description }
    /// A tool this skill uses changed: it does not load until the owner turns it on again or rolls back.
    var needsReview: Bool { active?.status == "review" }
}

/// One immutable version of a skill. Edits make a new version; activate and rollback only move the active pointer.
struct SkillVersion: Codable, Identifiable, Hashable {
    var id: String
    var skillId: String?
    var version: Int?
    /// candidate | active | review | retired
    var status: String?
    var name: String?
    var description: String?
    var instructions: String?
    var deps: [Contract.SkillDep]?
    var origin: String?
    var used: Int?
    var lastUsedAt: Date?
    var createdAt: Date?
}

struct Rule: Codable, Identifiable, Hashable {
    var id: String
    var description: String?
    var scope: String?
    var behavior: String?
    var source: String?
    var enabled: Bool?
    var subject: String?
    var agentId: String?
    var createdAt: Date?
    /// scope `delegation`: what the agent may decide alone, within which limits.
    var delegation: Contract.Rule.Delegation?
    var expiresAt: Date?
    var lastUsedAt: Date?
    var useCount: Int?
}

struct AuditEntry: Codable, Identifiable, Hashable {
    var id: String
    var at: Date?
    var actor: String?
    var agentId: String?
    var action: String?
    var target: String?
    var decision: String?
    var reason: String?
    var runId: String?
    /// Who started the work: the root origin of the run the entry belongs to (see `startedByLine`).
    var initiator: Contract.RunOrigin?
    var unattended: Bool?
}

struct Computer: Codable, Identifiable, Hashable {
    var id: String
    var name: String?
    var state: String?
    var controller: String?
    var activeAgentId: String?
    var os: String?
    var resolution: String?
}

struct UsageWeek: Codable, Hashable {
    var costUsd: Double?
    var limitUsd: Double?
    var percent: Double?
}

struct UsageByAgent: Codable, Hashable {
    var agentId: String?
    var runs: Int?
    var costUsd: Double?
}

struct Usage: Codable, Hashable {
    var week: UsageWeek?
    var byAgent: [UsageByAgent]?
}

/// One line in a goal's timeline (GET /v1/goals/:id). Newest first on the server.
struct GoalActivity: Codable, Hashable {
    var at: Date?
    var actor: String?
    var kind: String?
    var text: String?
    var runId: String?
    var milestoneId: String?
}

/// One step of the plan the goal's agent writes (3 to 7).
struct GoalMilestone: Codable, Identifiable, Hashable {
    var id: String
    var title: String?
    /// todo | doing | done | blocked
    var status: String?
    var due: Date?
}

struct PlannedGoal: Codable, Identifiable, Hashable {
    var id: String
    var status: String?
    var agentId: String?
    var kind: String?
    var title: String?
    var summary: String?
    /// health | relationships | finance | career | interests | productivity | other
    var category: String?
    var activity: [GoalActivity]?
    var milestones: [GoalMilestone]?
    /// When the agent checks in next (active goals) and when it last did.
    var nextCheckAt: Date?
    var lastCheckedAt: Date?
}

/// A post on the agent's feed (动态): news or progress that needs no action from the user.
struct FeedPost: Codable, Identifiable, Hashable {
    var id: String
    var agentId: String?
    var title: String?
    /// One or two sentences: what the card shows.
    var summary: String?
    /// The longer markdown write-up, shown in the post's detail.
    var body: String?
    /// Display-only blocks (dates, prices, specs), shown in the post's detail.
    var ui: UiDoc?
    var imageUrl: String?
    /// Alt text for the picture and the line under it in the post.
    var imageCaption: String?
    var sourceUrl: String?
    /// The routine that posted it, and the owner's "more / less like this".
    var routineId: String?
    var feedback: String?
    var liked: Bool?
    var createdAt: Date?
    var updatedAt: Date?

    /// There is more to read than the card shows.
    var hasDetail: Bool { !(body ?? "").isEmpty || ui != nil }

    /// What the card shows: the summary, or (posts stored before contracts 0.16 have none) the start of the body as plain text.
    var cardSummary: String? {
        if let summary, !summary.isEmpty { return summary }
        guard let body, !body.isEmpty else { return nil }
        var text = body
        for (pattern, template) in [(#"```[\s\S]*?```"#, " "), (#"!?\[([^\]]*)\]\([^)]*\)"#, "$1"), (#"(?m)^\s*(#{1,6}|>|[-*•·‣])\s+"#, ""), (#"[*_`~]+"#, ""), (#"\s+"#, " ")] {
            text = text.replacingOccurrences(of: pattern, with: template, options: .regularExpression)
        }
        text = text.trimmingCharacters(in: .whitespaces)
        return text.isEmpty ? nil : String(text.prefix(240))
    }
}

struct PlannedIdea: Codable, Identifiable, Hashable {
    var id: String
    var status: String?
    var agentId: String?
    var text: String?
    var prompt: String?
    /// One sentence naming what the idea rests on (daily ideas).
    var why: String?
    /// Work prepared up front: a draft file under `drafts/` in the user's home.
    var prepared: Prepared?
    /// Set once accepted: the conversation the agent was started in.
    var conversationId: String?
    /// What the idea is about, as the server keys it for "less"/"never" rules; `outcome` is how the person answered it.
    var key: String?
    var outcome: String?

    struct Prepared: Codable, Hashable {
        var kind: String?
        var ref: String?
        var label: String?
    }
}

/// One thing the person told Juno about what is worth interrupting them for (GET /v1/proactive/rules).
struct ProactiveRule: Codable, Identifiable, Hashable {
    var id: String
    /// "tell", "dont", "less" or "where".
    var kind: String
    var scope: String
    var strength: String?
    var text: String
    var source: String
    /// YYYY-MM-DD.
    var date: String
    var review: String?
    var dueForReview: Bool
}
