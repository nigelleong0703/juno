/** Owner model providers: list, add, update and remove a provider with the owner's own key (keys write-only). */
import type { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import {
  completeChatGPTLoginInputSchema,
  createModelProviderInputSchema,
  updateModelProviderInputSchema,
} from '@agent-desktop/public-contracts';
import { NotFoundError } from '@agent-desktop/contracts';
import { requestOwner } from '../owner.js';
import { cancelChatGPTLogin, ChatGPTLoginError, completeChatGPTLogin, readChatGPTLoginStatus, startChatGPTLogin } from '@agent-desktop/contracts/chatgpt-login';
import { toPublicModelProvider } from '@agent-desktop/contracts/model-providers';
import { createModelProvidersModule, ModelProviderConfigError, type ModelProviderCatalogClient } from '../modules/model-providers.js';
import type { Store } from '@agent-desktop/contracts';

export interface ModelProviderRoutesDeps {
  store: Store;
  providerClient: ModelProviderCatalogClient;
  /** Whether the platform default endpoint is configured (a run can start without an owner provider). */
  platformDefault: boolean;
  /** Transport for the ChatGPT token exchange; absent uses the global fetch. Injected in tests. */
  oauthFetch?: typeof fetch;
}

/** The server never catches the OAuth redirect: the owner pastes the redirect address back. `automatic` stays in the contract as false. */
const AUTOMATIC = false;

const loginErrorStatus = (error: ChatGPTLoginError): 404 | 400 => (error.code === 'NOT_FOUND' ? 404 : 400);

export function registerModelProviderRoutes(app: Hono, deps: ModelProviderRoutesDeps): void {
  // Owner-scoped store only: refusing an unscoped store is the rule for owner data (see app-repository).
  const scopedStore = (ownerId: string): Store => {
    if (typeof deps.store.forOwner !== 'function') throw new Error('Store.forOwner is required: refusing unscoped app data access');
    return deps.store.forOwner(ownerId);
  };
  const module = (ownerId: string) => createModelProvidersModule(scopedStore(ownerId), ownerId, deps.providerClient);

  // ChatGPT subscription sign-in. The owner opens the URL, then pastes the redirect URL back (manual path).
  app.post('/v1/model-providers/chatgpt/login', async (c) => {
    const ownerId = requestOwner(c);
    const { authorizationUrl, loginId } = await startChatGPTLogin({ store: scopedStore(ownerId), ownerId });
    return c.json({ authorizationUrl, loginId, automatic: AUTOMATIC });
  });

  app.get('/v1/model-providers/chatgpt/login/:id', async (c) => {
    const ownerId = requestOwner(c);
    try {
      return c.json(await readChatGPTLoginStatus({ store: scopedStore(ownerId), ownerId, loginId: c.req.param('id') }));
    } catch (error) {
      if (error instanceof ChatGPTLoginError) return c.json({ error: { code: error.code, message: error.message } }, loginErrorStatus(error));
      throw error;
    }
  });

  app.delete('/v1/model-providers/chatgpt/login/:id', async (c) => {
    const ownerId = requestOwner(c);
    try {
      await cancelChatGPTLogin({ store: scopedStore(ownerId), ownerId, loginId: c.req.param('id') });
    } catch (error) {
      if (error instanceof ChatGPTLoginError) return c.json({ error: { code: error.code, message: error.message } }, loginErrorStatus(error));
      throw error;
    }
    return c.body(null, 204);
  });

  app.post('/v1/model-providers/chatgpt/complete', zValidator('json', completeChatGPTLoginInputSchema), async (c) => {
    const ownerId = requestOwner(c);
    const input = c.req.valid('json');
    try {
      const record = await completeChatGPTLogin({
        store: scopedStore(ownerId),
        ownerId,
        loginId: input.loginId,
        callbackUrl: input.callbackUrl,
        ...(deps.oauthFetch ? { fetchFn: deps.oauthFetch } : {}),
      });
      return c.json(toPublicModelProvider(record));
    } catch (error) {
      // OpenAI wants a second authorization with the issued client: the client opens it and pastes that callback.
      if (error instanceof ChatGPTLoginError && error.code === 'REAUTHORIZE' && error.next !== undefined) {
        return c.json({ error: { code: error.code, message: error.message, fields: { loginId: error.next.loginId, authorizationUrl: error.next.authorizationUrl, automatic: String(AUTOMATIC) } } }, 409);
      }
      if (error instanceof ChatGPTLoginError) return c.json({ error: { code: error.code, message: error.message } }, loginErrorStatus(error));
      throw error;
    }
  });

  app.get('/v1/model-providers/builtin', async (c) => {
    const ownerId = requestOwner(c);
    return c.json({ items: await deps.providerClient.builtinProviders(ownerId) });
  });

  app.get('/v1/model-providers', async (c) => {
    return c.json(await module(requestOwner(c)).list(deps.platformDefault));
  });

  app.post('/v1/model-providers', zValidator('json', createModelProviderInputSchema), async (c) => {
    try {
      const ownerId = requestOwner(c);
      const created = await module(ownerId).create(c.req.valid('json'));
      return c.json(created, 201);
    } catch (error) {
      if (error instanceof ModelProviderConfigError) return c.json({ error: { code: error.code, message: error.message } }, 400);
      throw error;
    }
  });

  app.patch('/v1/model-providers/:id', zValidator('json', updateModelProviderInputSchema), async (c) => {
    try {
      return c.json(await module(requestOwner(c)).update(c.req.param('id'), c.req.valid('json')));
    } catch (error) {
      if (error instanceof ModelProviderConfigError) return c.json({ error: { code: error.code, message: error.message } }, 400);
      if (error instanceof NotFoundError) return c.json({ error: { code: 'NOT_FOUND', message: 'Model provider not found' } }, 404);
      throw error;
    }
  });

  app.delete('/v1/model-providers/:id', async (c) => {
    try {
      await module(requestOwner(c)).remove(c.req.param('id'));
      return c.body(null, 204);
    } catch (error) {
      if (error instanceof NotFoundError) return c.json({ error: { code: 'NOT_FOUND', message: 'Model provider not found' } }, 404);
      throw error;
    }
  });

  app.get('/v1/model-providers/:id/models', async (c) => {
    const result = await deps.providerClient.providerModels(requestOwner(c), c.req.param('id'));
    if (result.kind === 'not-found') return c.json({ error: { code: 'NOT_FOUND', message: 'Model provider not found' } }, 404);
    if (result.kind === 'unavailable') return c.json({ error: { code: 'MODEL_CATALOG_UNAVAILABLE', message: 'Model catalog is unavailable' } }, 503);
    return c.json(result.catalog);
  });
}
