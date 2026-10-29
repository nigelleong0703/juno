// A refused call to an app's tool, with the access state that refused it (BACKEND 10.18.1). The message is the one sentence the model gets:
// what is wrong, who fixes it, and that retrying will not help.
import { accessSentence, type AppAccess } from '../apps/agent-apps.js';
import { McpConnectionError } from './client.js';

export class AppAccessError extends McpConnectionError {
  constructor(readonly access: AppAccess, appName: string, toolName?: string, cardable = true) {
    super(accessSentence(access, appName, toolName, cardable) ?? `${appName} is not available.`);
    this.name = 'AppAccessError';
  }
}
