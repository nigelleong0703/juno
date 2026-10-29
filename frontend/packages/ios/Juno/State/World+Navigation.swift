import Foundation
import SwiftUI
import UIKit

extension World {
    /// The one way to open a chat from anywhere: selects the Chat tab, closes drawer and sheets, prefills a draft.
    func openChat(_ conversationId: String?, draft: String? = nil) {
        guard let conversationId else { return }
        prepareChat(conversationId, draft: draft)
        currentConversationId = conversationId
        tab = "chat"
    }

    /// Prepares a conversation while the caller's navigation stack owns its presentation.
    func prepareChat(_ conversationId: String, draft: String? = nil) {
        sidebarOpen = false
        if let draft { drafts[conversationId] = draft }
        sheet = nil
        loadItems(conversationId)
        // Read on the server too: a local reset came back on the next refetch (the web posts mark-read the same way).
        markConversationRead(conversationId)
    }
}

extension World {
    /// Recent chats as the sidebar and search list them: the owner's own chats. Platform groups and strangers' DMs
    /// are not "recents" — they live under the Chats tab's Groups filter.
    var recentConversations: [Conversation] {
        sortedConversations.filter { ($0.kind == "direct" || $0.kind == "room") && !$0.isChannelChat }
    }

    func title(of c: Conversation) -> String {
        if let t = c.title, !t.isEmpty { return t }
        let names = (c.agentIds ?? []).compactMap { agent($0)?.name }
        return names.isEmpty ? "Untitled chat" : names.joined(separator: ", ")
    }

    /// A sidebar agent row: its direct chat (which closes the drawer), else its page, zooming out of the sidebar row.
    func openFromSidebar(_ agent: Agent) {
        if let chat = directConversation(for: agent.id) { openChat(chat.id) } else { openAgentPage(agent.id, from: "sidebar-\(agent.id)") }
    }
}
