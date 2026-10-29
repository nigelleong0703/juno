/** `agentdesktop://plugins?tab=connectors&status=connected` -> the hash route `#/plugins?tab=connectors&status=connected`. */
export function hashForDeepLink(url: string): string {
  return `#/${url.replace(/^agentdesktop:\/\//, "").replace(/\/+$/, "")}`;
}

/** Tray / notification "Open" for a pending request: its conversation, or Home when it has none. */
export function hashForRequest(conversationId: string | undefined): string {
  return conversationId ? `#/c/${encodeURIComponent(conversationId)}` : "#/";
}
