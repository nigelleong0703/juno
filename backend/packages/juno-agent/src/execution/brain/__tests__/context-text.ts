/** The model-visible context facts: the frozen system message plus every appended `<context_update>` note. */
export function contextText(ctx: { messages: Array<{ role: string; content: unknown }> }): string {
  return ctx.messages
    .filter((message) => message.role === 'system' || (message.role === 'user' && typeof message.content === 'string' && message.content.startsWith('<context_update>')))
    .map((message) => (typeof message.content === 'string' ? message.content : JSON.stringify(message.content)))
    .join('\n\n');
}

/** The conversation itself: messages minus the context notes (and the system message). */
export function withoutNotes<T extends { role: string; content: unknown }>(messages: T[]): T[] {
  return messages.filter((message) => message.role !== 'system' && !(message.role === 'user' && typeof message.content === 'string' && message.content.startsWith('<context_update>')));
}
