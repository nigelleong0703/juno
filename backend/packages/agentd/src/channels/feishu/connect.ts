/**
 * Feishu / Lark connector: Juno creates the app with the official scan-to-create flow (`{mode:'register'}`, register.ts); the owner
 * confirms in Feishu / Lark and the app id and secret reach this server directly. Nobody pastes an App ID or secret.
 * The long connection that receives messages is the runner in ws.ts; nothing to set up or undo on the platform side.
 */
import type { ChannelConnector } from '../connect.js';
import { connectFeishuRegister } from './register.js';

export const feishuConnector: ChannelConnector = {
  async connect(ctx) {
    const mode = typeof ctx.body === 'object' && ctx.body !== null ? (ctx.body as Record<string, unknown>)['mode'] : undefined;
    if (mode !== 'register') return { ok: false, status: 400, code: 'UNSUPPORTED_CONNECT_MODE', message: "Feishu apps are created by scanning: send {mode:'register'}" };
    return connectFeishuRegister(ctx);
  },

  async disconnect() {
    // Nothing platform-side: the runner drops the long connection when the row is gone.
  },
};
