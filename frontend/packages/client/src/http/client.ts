/**
 * HTTP ApiClient: composes the shared transport, the per-domain endpoint modules and the SSE
 * event stream into one ApiClient & EventSource.
 */

import { z } from 'zod';
import type { ApiClient } from '../contracts.js';
import type { EventResetSource, EventSource } from '../contracts.js';
import { createSettingsApi, createUsageApi } from './account.js';
import { createProfileApi } from './profile.js';
import { createAgentsApi } from './agents.js';
import { createAgentCalendarApi, createDelegationsApi, createRoutinesApi, createRulesApi } from './automation.js';
import { createComputersApi } from './computers.js';
import { createConversationsApi, createItemsApi } from './conversations.js';
import { createRequestsApi, createRunsApi, createTasksApi } from './execution.js';
import { createAppsApi } from './apps.js';
import { createPluginsApi } from './integrations.js';
import { createSkillsApi } from './knowledge.js';
import { createMemoryApi } from './memory.js';
import { createMemoryItemsApi, createPeopleApi } from './people.js';
import { createModelProvidersApi } from './model-providers.js';
import { createArtifactsApi } from './artifacts.js';
import { createDocumentsApi } from './documents.js';
import { createSpacesApi } from './spaces.js';
import { createAuditApi, createLibraryApi } from './library.js';
import { createFeedApi, createInspirationApi } from './feed.js';
import { createHomeApi } from './home.js';
import { createGoalsApi, createIdeasApi, createMealsApi, createProactiveApi } from './planning.js';
import { macAppsResponseSchema } from '../contracts.js';
import { createEventStream } from './sse.js';
import type { HttpClientOptions } from './transport.js';
import type { HttpTransport } from './transport.js';
import { createTransport } from './transport.js';

export type { HttpClientOptions, HttpError } from './transport.js';
export type { ModelCatalog } from '../contracts.js';

const transcriptionSchema = z.object({ text: z.string() });
const eventCursorSchema =z.object({ after: z.number().int().nonnegative() });

/** `GET /v1/events/cursor` as a resolved promise: the cursor, or null when the request fails. */
function fetchEventCursor(http: HttpTransport): Promise<number | null> {
  const request = http.request('/v1/events/cursor', 'GET', undefined, eventCursorSchema).then(
    (data) => data.after,
    () => null,
  );
  // A hung cursor request must not hold the stream back for the life of the client.
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), EVENT_CURSOR_TIMEOUT_MS);
  });
  return Promise.race([request, timeout]).finally(() => clearTimeout(timer));
}

const EVENT_CURSOR_TIMEOUT_MS = 5000;

export function createHttpClient(opts: HttpClientOptions): ApiClient & EventSource & EventResetSource {
  const http = createTransport(opts);

  // The starting cursor is requested when the live stream is first subscribed, which is the app's first
  // mount-time effect: the GET leaves before the snapshot queries it must precede. Memoized; it never
  // rejects (failure means "replay from 0"), and no request is made by clients that never subscribe.
  let cursor: Promise<number | null> | null = null;
  const startCursor = (): Promise<number | null> => (cursor ??= fetchEventCursor(http));

  // --- EventSource: one shared SSE connection over fetch ---
  const events = createEventStream({
    url: new URL('/v1/events', opts.baseUrl).toString(),
    getToken: opts.getToken ?? (() => ''),
    fetch: opts.fetch ?? globalThis.fetch,
    initialCursor: startCursor,
    ...(opts.onReset ? { onReset: opts.onReset } : {}),
    ...(opts.clientKind ? { clientKind: opts.clientKind } : {}),
  });

  return {
    agents: createAgentsApi(http),
    computers: createComputersApi(http),
    conversations: createConversationsApi(http),
    items: createItemsApi(http),
    runs: createRunsApi(http),
    requests: createRequestsApi(http),
    tasks: createTasksApi(http),
    routines: createRoutinesApi(http),
    calendar: createAgentCalendarApi(http),
    rules: createRulesApi(http),
    delegations: createDelegationsApi(http),
    audit: createAuditApi(http),
    memory: createMemoryApi(http),
    people: createPeopleApi(http),
    memoryItems: createMemoryItemsApi(http),
    goals: createGoalsApi(http),
    ideas: createIdeasApi(http),
    proactive: createProactiveApi(http),
    feed: createFeedApi(http),
    inspiration: createInspirationApi(http),
    home: createHomeApi(http),
    skills: createSkillsApi(http),
    plugins: createPluginsApi(http),
    apps: createAppsApi(http),
    meals: createMealsApi(http),
    library: createLibraryApi(http),
    artifacts: createArtifactsApi(http),
    documents: createDocumentsApi(http),
    spaces: createSpacesApi(http),
    usage: createUsageApi(http),
    settings: createSettingsApi(http),
    modelProviders: createModelProvidersApi(http),
    profile: createProfileApi(http),
    transcribe: (audio) => http.request('/v1/transcriptions', 'POST', audio, transcriptionSchema).then((r) => r.text),
    macApps: () => http.request('/v1/mac/apps', 'GET', undefined, macAppsResponseSchema),
    revokeMacApp: (app) => http.request(`/v1/mac/apps/${encodeURIComponent(app)}`, 'DELETE', undefined, macAppsResponseSchema),
    subscribe: (handler) => {
      // Kick the cursor request before the stream's async connect path, so it is in flight first.
      startCursor();
      return events.subscribe(handler);
    },
    subscribeReset: events.subscribeReset,
    isConnected: events.isConnected,
    subscribeConnection: events.subscribeConnection,
  };
}
