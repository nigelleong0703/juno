/**
 * Testing stubs for Brain and ToolRegistry (until packages/brain and packages/tools land).
 * Deterministic behavior for integration tests.
 */

import type {
  Brain,
  BrainContext,
  Tool,
  ToolRegistry,
  ToolResult,
  AssistantTurn,
} from '../../../contracts/index.js';

/** Scripted model: returns predetermined responses for testing. */
export class ScriptedModel implements Brain {
  async buildContext(): Promise<BrainContext> {
    return { sessionKey: 'test', agentId: 'test' };
  }

  async step(_ctx: BrainContext, _tools: Tool[]): Promise<AssistantTurn> {
    // Always say "done" and make one deterministic tool call
    return {
      text: 'Task completed',
      toolCalls: [{ id: 'tool_1', name: 'send_message', arguments: { text: 'Hello' } }],
      usage: { inputTokens: 10, outputTokens: 10, costUsd: 0.01 },
      stopReason: 'tool_calls',
    };
  }

  shouldCompact(): boolean {
    return false;
  }

  async compact(ctx: BrainContext): Promise<BrainContext> {
    return ctx;
  }
}

/** Fake tool registry for testing. */
export class FakeToolRegistry implements ToolRegistry {
  private tools: Map<string, Tool> = new Map([
    [
      'send_message',
      {
        name: 'send_message',
        description: 'Send a message to the user',
        parameters: { type: 'object', properties: { text: { type: 'string' } } },
        replay: 'never',
        sideEffect: true,
        async execute(_args: { text?: string }): Promise<ToolResult> {
          return {
            content: [{ type: 'text', text: 'Message sent' }],
          };
        },
      },
    ],
    [
      'wait_for_user',
      {
        name: 'wait_for_user',
        description: 'Wait for user input',
        parameters: { type: 'object', properties: {} },
        replay: 'safe',
        sideEffect: false,
        async execute(_args: unknown): Promise<ToolResult> {
          return {
            content: [{ type: 'text', text: 'Waiting...' }],
            suspend: { reason: 'user' },
          };
        },
      },
    ],
  ]);

  async forAgent(_agentId: string): Promise<Tool[]> {
    return Array.from(this.tools.values());
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }
}

/** In-memory fake computer provider for testing. */
export class FakeComputerProvider {
  async screenshot(_agentId: string): Promise<{ data: string; mimeType: string }> {
    return {
      data: 'fake-screenshot-base64',
      mimeType: 'image/png',
    };
  }

  async click(_agentId: string, _x: number, _y: number): Promise<void> {
    // No-op
  }

  async type(_agentId: string, _text: string): Promise<void> {
    // No-op
  }
}
