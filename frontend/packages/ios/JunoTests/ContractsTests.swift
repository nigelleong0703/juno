import XCTest
@testable import Juno

// The generated Contract.* types (scripts/gen/swift-contracts.mjs) decode wire-shaped payloads through the app's isoDecoder.

final class ContractsTests: XCTestCase {
    func testModelProviderListDecodes() throws {
        let json = """
        {"providers":[
          {"id":"mp_1","name":"OpenAI","kind":"builtin","providerId":"openai","hasKey":true,"auth":"chatgpt",
           "status":"reauth_required","accessExpiresAt":"2026-10-13T08:00:00.123Z"},
          {"id":"mp_2","name":"Local","kind":"custom","baseUrl":"http://localhost:11434/v1","wire":"openai-completions","hasKey":false,
           "status":"some_future_status"}
         ],"platformDefault":false,"usable":true}
        """
        let list = try isoDecoder.decode(Contract.ModelProviderList.self, from: Data(json.utf8))
        XCTAssertEqual(list.usable, true)
        XCTAssertEqual(list.providers?.map(\.id), ["mp_1", "mp_2"])
        let chatgpt = try XCTUnwrap(list.providers?.first)
        XCTAssertEqual(chatgpt.auth.flatMap(Contract.ModelProviderAuth.init(rawValue:)), .chatgpt)
        XCTAssertEqual(chatgpt.status.flatMap(Contract.ModelProviderStatus.init(rawValue:)), .reauthRequired)
        XCTAssertNotNil(chatgpt.accessExpiresAt)
        // A value the app does not know yet still decodes (enums stay String on the wire types).
        XCTAssertEqual(list.providers?.last?.status, "some_future_status")
        XCTAssertEqual(list.providers?.last?.wire.flatMap(Contract.ModelWire.init(rawValue:)), .openaiCompletions)
    }

    func testSystemOneProviderAndCheapModelDecode() throws {
        let provider = try isoDecoder.decode(ModelProvider.self, from: Data(#"{"id":"s1","name":"TypeSafe","kind":"systemone","baseUrl":"https://api.typesafe.ai","models":["jev-latest"],"hasKey":true}"#.utf8))
        XCTAssertTrue(provider.isSystemOne)
        XCTAssertEqual(provider.models, ["jev-latest"])
        let catalog = try isoDecoder.decode(ProviderCatalog.self, from: Data(#"{"defaultModel":"a","items":[{"id":"a","name":"A","supportsImages":true,"cheap":true}]}"#.utf8))
        XCTAssertEqual(catalog.items.first?.cheap, true)
    }

    func testItemVariantsDecodeIntoOneFlatType() throws {
        let json = """
        [
          {"id":"it_1","conversationId":"c_1","at":"2026-10-13T08:00:00Z","type":"user_message","authorId":"u_1","text":"hi",
           "attachments":[{"id":"f_1","name":"a.png","kind":"image","mimeType":"image/png","sizeBytes":12}],
           "mentions":[{"kind":"agent","id":"ag_1","label":"Juno"}]},
          {"id":"it_2","conversationId":"c_1","at":"2026-10-13T08:00:01.5Z","type":"agent_message","agentId":"ag_1","runId":"r_1",
           "markdown":"**done**","citations":[]},
          {"id":"it_3","conversationId":"c_1","at":"2026-10-13T08:00:02Z","type":"system","level":"warning","text":"slow"}
        ]
        """
        let items = try isoDecoder.decode([Contract.Item].self, from: Data(json.utf8))
        XCTAssertEqual(items.compactMap { $0.type.flatMap(Contract.Item.TypeValue.init(rawValue:)) }, [.userMessage, .agentMessage, .system])
        XCTAssertEqual(items[0].attachments?.first?.sizeBytes, 12)
        XCTAssertEqual(items[0].mentions?.first?.label, "Juno")
        XCTAssertEqual(items[1].markdown, "**done**")
        XCTAssertEqual(items[2].level, "warning")
        XCTAssertNotNil(items[1].at)
    }

    func testAuditEntryDecodesItsInitiatorAndSaysWhoStartedIt() throws {
        let json = """
        {"id":"aud_1","at":"2026-10-29T08:00:00.000Z","actor":"agent","action":"tool.policy","decision":"asked","reason":"r","unattended":true,
         "initiator":{"type":"routine","routineId":"rt_1","occurrenceAt":"2026-10-29T08:00:00.000Z"}}
        """
        let entry = try isoDecoder.decode(AuditEntry.self, from: Data(json.utf8))
        XCTAssertEqual(entry.unattended, true)
        let initiator = try XCTUnwrap(entry.initiator)
        XCTAssertEqual(initiator.startedByLine(routineName: "Daily digest"), "Started by a routine \u{00B7} Daily digest")
        XCTAssertEqual(initiator.startedByLine(routineName: nil), "Started by a routine")
        let stranger = Contract.RunOrigin(type: "channel", conversationId: "c", channel: "telegram", speaker: "stranger")
        XCTAssertEqual(stranger.startedByLine(routineName: nil), "Started by a stranger on Telegram")
        XCTAssertEqual(Contract.RunOrigin(type: "owner_message", conversationId: "c").startedByLine(routineName: nil), "Started by you")
        XCTAssertEqual(Contract.RunOrigin(type: "system", wakeKind: "task_done").startedByLine(routineName: nil), "Started by the system \u{00B7} task done")
    }

    func testStepKeepsFreeFormDataAsJSON() throws {
        let json = """
        {"id":"s_1","runId":"r_1","index":0,"kind":"tool","verb":"Ran","status":"done",
         "input":{"command":"ls","data":{"args":["-la"],"timeout":30,"dry":false,"cwd":null}}}
        """
        let step = try isoDecoder.decode(Contract.Step.self, from: Data(json.utf8))
        XCTAssertEqual(step.input?.command, "ls")
        XCTAssertEqual(step.input?.data, .object(["args": .array([.string("-la")]), "timeout": .number(30), "dry": .bool(false), "cwd": .null]))
    }
}
