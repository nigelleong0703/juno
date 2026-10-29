/**
 * request_secure_input / request_takeover: the two ways an agent on its computer gets the user's hands
 * without a full screen take-over by default (BACKEND 8.7).
 *
 * - Secure input: the page needs a password, card details or a one-time code. The request names the
 *   page fields (snapshot refs) and carries the sandbox's public key; the user types the values in a native
 *   form, encrypts them to that key, and agentd passes the ciphertext to the sandbox, which types them into
 *   those fields (`POST /v1/requests/:id/secure-input`, BACKEND 8.7). The values never pass through this run:
 *   the run resumes with only which fields were filled.
 * - Take-over: the agent is stuck (a captcha, an odd sign-in check). The request carries the stuck
 *   element's rect in screen pixels so a client can zoom to it; it resolves when the user hands control
 *   back (approved) or declines (denied).
 */
import { z } from 'zod';
import { secureInputFieldKindSchema, type ComputerPayload } from '@agent-desktop/public-contracts';
import type { Store, Tool, ToolContext, ToolResult } from '../../../contracts/index.js';
import { isChildRun } from '../../tasks/childDelivery.js';
import { ComputerError, isComputerError, type BrowserResult } from '../computer/contract.js';
import type { ComputerClientProvider } from '../computer/client.js';
import { computerFailure, ON_PROPERTY, ON_SCHEMA } from '../computer/shared.js';
import { readVaultEntries } from '../../secure-vault/index.js';
import { classifyFieldClasses, classifySecureField } from './secureInputClassify.js';
import { runBrowser } from './computerBrowserActions.js';
import { raiseUserRequest, userRequest } from './userRequest.js';

const CHILD_REFUSAL = 'Error: a child task cannot ask the user for help. Record the missing input as a blocked todo and report it in your final result.';

const secureInputSchema = z.object({
  reason: z.string().trim().min(1).max(300),
  fields: z
    .array(z.object({ label: z.string().trim().min(1).max(80), kind: secureInputFieldKindSchema.optional(), ref: z.string().min(1), vaultId: z.string().min(1).optional() }))
    .min(1)
    .max(8),
  on: ON_SCHEMA,
});

const takeoverSchema = z.object({ reason: z.string().trim().min(1).max(300), ref: z.string().min(1).optional(), on: ON_SCHEMA });

type BoundsPage = Extract<BrowserResult, { action: 'bounds' }>;

/** Where the refs are on screen; this also proves each ref is current (a stale one fails here, not at fill time). */
async function boundsOf(provider: ComputerClientProvider | undefined, ctx: ToolContext, refs: string[]): Promise<BoundsPage> {
  const page = await runBrowser(provider, ctx, { action: 'bounds', refs });
  if (page.action !== 'bounds') throw new ComputerError('failed', `browser bounds returned a ${page.action} result`);
  return page;
}

type AttrsPage = Extract<BrowserResult, { action: 'attrs' }>;

/** What the page says about each control; undefined when it cannot be read (the label and the model's kind decide). */
async function attrsOf(provider: ComputerClientProvider | undefined, ctx: ToolContext, refs: string[]): Promise<AttrsPage | undefined> {
  try {
    const page = await runBrowser(provider, ctx, { action: 'attrs', refs });
    return page.action === 'attrs' ? page : undefined;
  } catch (error) {
    if (ctx.signal.aborted) throw error;
    return undefined;
  }
}

function hostOf(url: string): string {
  try {
    return new URL(url).host || url;
  } catch {
    return url;
  }
}

async function refuseChild(store: Store, ctx: ToolContext): Promise<ToolResult | null> {
  if (!isChildRun(await store.get('runs', ctx.runId))) return null;
  return { content: [{ type: 'text', text: CHILD_REFUSAL }], isError: true };
}

export function createRequestSecureInputTool(opts: { store: Store; computer?: ComputerClientProvider }): Tool {
  return {
    name: 'request_secure_input',
    description: '',
    parameters: {
      type: 'object',
      properties: {
        reason: { type: 'string', description: '' },
        fields: {
          type: 'array',
          minItems: 1,
          maxItems: 8,
          items: {
            type: 'object',
            properties: {
              label: { type: 'string', description: '' },
              kind: { enum: secureInputFieldKindSchema.options, description: '' },
              ref: { type: 'string', description: '' },
              vaultId: { type: 'string', description: '' },
            },
            required: ['label', 'ref'],
            additionalProperties: false,
          },
        },
        ...ON_PROPERTY,
      },
      required: ['reason', 'fields'],
      additionalProperties: false,
    },
    replay: 'never',
    sideEffect: true,
    async execute(args: unknown, ctx: ToolContext): Promise<ToolResult> {
      const parsed = secureInputSchema.parse(args);
      const refused = await refuseChild(opts.store, ctx);
      if (refused) return refused;
      if (parsed.on === 'mac') {
        return {
          content: [{ type: 'text', text: 'Secure input is not available for Chrome on your Mac in this version. Complete the secret field directly in Chrome on the Mac, then tell the agent to continue. Nothing was sent to the sandbox.' }],
          isError: true,
          details: { code: 'unavailable', computer: 'mac' },
        };
      }
      const refs = parsed.fields.map((field) => field.ref);
      if (new Set(refs).size !== refs.length) return { content: [{ type: 'text', text: 'Error: each field needs its own ref.' }], isError: true };
      let page: BoundsPage;
      try {
        page = await boundsOf(opts.computer, ctx, refs);
      } catch (error) {
        return computerFailure(error, ctx.signal);
      }
      // The sandbox's own public key: the client encrypts to it, only the computer can open what it sends back.
      let encryption: Extract<BrowserResult, { action: 'secure_key' }>;
      try {
        const key = await runBrowser(opts.computer, ctx, { action: 'secure_key' });
        if (key.action !== 'secure_key') throw new ComputerError('failed', `browser secure_key returned a ${key.action} result`);
        encryption = key;
      } catch (error) {
        if (ctx.signal.aborted) throw error;
        return { content: [{ type: 'text', text: `Error: secure input is not available on this computer yet (it cannot offer an encryption key: ${error instanceof Error ? error.message : String(error)}). Do not ask for the value in chat; tell the user the computer needs an update.` }], isError: true };
      }
      const vault = new Set((await readVaultEntries(ctx.store, ctx.ownerId)).map((entry) => entry.id));
      const site = hostOf(page.url);
      // The kinds and limits come from the page's own attributes; the model's kind is only a fallback.
      const attrs = await attrsOf(opts.computer, ctx, refs);
      const classes = await classifyFieldClasses(parsed.fields.map((field) => ({ attrs: attrs?.fields.find((entry) => entry.ref === field.ref), label: field.label })), ctx.systemOne, ctx.signal);
      const profileFields = parsed.fields.filter((_, index) => classes[index] === 'profile');
      if (profileFields.length > 0) {
        return {
          content: [{ type: 'text', text: 'Error: ' + profileFields.map((field) => `${field.label} is profile data — fill it yourself from the user's details, or ask the user and save it with profile_update`).join('; ') + '. Nothing was asked; call request_secure_input again with only the secret fields (passwords, card details, one-time codes, ID numbers), if any.' }],
          isError: true,
        };
      }
      const fields = parsed.fields.map((field, index) => ({
        id: `f${index + 1}`,
        label: field.label,
        ref: field.ref,
        ...(field.vaultId !== undefined && vault.has(field.vaultId) ? { vaultId: field.vaultId } : {}),
        ...classifySecureField(attrs?.fields.find((entry) => entry.ref === field.ref), field.label, field.kind),
      }));
      const request = userRequest(ctx, {
        kind: 'secure_input',
        title: `Enter details for ${site}`.slice(0, 120),
        summary: parsed.reason.slice(0, 100),
        payload: { kind: 'secure_input', site, url: page.url, reason: parsed.reason, fields, encryption: { alg: encryption.alg, keyId: encryption.keyId, publicKey: encryption.publicKey } },
      });
      const labels = fields.map((field) => field.label).join(', ');
      return raiseUserRequest(opts.store, ctx, request, `Asked the user for ${labels} on ${site}. The values are encrypted on their device, go straight into the page and are never shown to you; you will learn which fields were filled. A field showing (filled securely) in a snapshot is already filled: do not ask for it again.`);
    },
  };
}

export function createRequestTakeoverTool(opts: { store: Store; computer?: ComputerClientProvider }): Tool {
  return {
    name: 'request_takeover',
    description: '',
    parameters: {
      type: 'object',
      properties: {
        reason: { type: 'string', description: '' },
        ref: { type: 'string', description: '' },
        ...ON_PROPERTY,
      },
      required: ['reason'],
      additionalProperties: false,
    },
    replay: 'never',
    sideEffect: true,
    async execute(args: unknown, ctx: ToolContext): Promise<ToolResult> {
      const parsed = takeoverSchema.parse(args);
      const refused = await refuseChild(opts.store, ctx);
      if (refused) return refused;
      if (parsed.on === 'mac') {
        return {
          content: [{ type: 'text', text: 'Native Mac takeover is not available from this tool yet. Complete the step directly on the Mac, then ask the agent to continue; nothing was requested from the sandbox.' }],
          isError: true,
          details: { code: 'unavailable', computer: 'mac' },
        };
      }
      let payload: ComputerPayload = { kind: 'computer', reason: parsed.reason };
      if (parsed.ref !== undefined) {
        let page: BoundsPage | undefined;
        try {
          page = await boundsOf(opts.computer, ctx, [parsed.ref]);
        } catch (error) {
          // Focus is optional; a replaced/non-layout node must not prevent full-screen help.
          // Transport, permission and cancellation failures still take their original path.
          const lostFocus = isComputerError(error) && error.code === 'failed'
            && /node is detached from document|node does not have a layout object|unknown or stale ref|element has no clickable box/i.test(error.message);
          if (ctx.signal.aborted || !lostFocus) return computerFailure(error, ctx.signal);
        }
        if (page !== undefined) {
          const element = page.elements[0];
          payload = {
            ...payload,
            url: page.url,
            site: hostOf(page.url),
            previewAt: new Date().toISOString(),
            ...(element === undefined ? {} : { focus: { rect: element.rect, label: element.name, role: element.role, ref: parsed.ref } }),
          };
        }
      }
      const request = userRequest(ctx, { kind: 'computer', title: 'Your help is needed on the screen', summary: parsed.reason.slice(0, 100), payload });
      return raiseUserRequest(opts.store, ctx, request, 'Asked the user to take over the screen. You resume when they hand control back or decline.');
    },
  };
}
