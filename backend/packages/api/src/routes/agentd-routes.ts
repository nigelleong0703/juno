/**
 * The exact public /v1 surface the gateway forwards to the private agentd.
 *
 * This is an allowlist, not a prefix proxy: only these method+path pairs ever reach the private
 * service. Anything else - an unknown path, or a known path with an unlisted method - is answered
 * by the API as 404 without an upstream call. Both services keep their own ownership: the app's
 * settings/integrations/library/activity routes live in the API and are deliberately absent here.
 */
export type AgentdRouteMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export interface AgentdRoute {
  method: AgentdRouteMethod;
  path: string;
}

export const AGENTD_ROUTES: readonly AgentdRoute[] = [
  // Server-Sent Events (registered directly on the agentd app).
  { method: 'GET', path: '/v1/events' },
  // Starting cursor for snapshot-then-stream (BACKEND §10.3): plain JSON, not SSE.
  { method: 'GET', path: '/v1/events/cursor' },

  // Delete the caller's own account and all its data (body {"confirm": true}); the session is closed first, the rest is a resumable job (BACKEND §5.2c).
  { method: 'DELETE', path: '/v1/account' },

  // Agents
  { method: 'GET', path: '/v1/agents' },
  { method: 'POST', path: '/v1/agents' },
  { method: 'GET', path: '/v1/agents/:id' },
  // The task tree (0.69): the owner's tasks across agents, the tree under one root run, and one agent's tasks; its todo plans (`tasks` before 0.3).
  { method: 'GET', path: '/v1/tasks' },
  { method: 'GET', path: '/v1/tasks/:id/tree' },
  { method: 'GET', path: '/v1/agents/:id/tasks' },
  { method: 'GET', path: '/v1/agents/:id/plans' },
  { method: 'POST', path: '/v1/tasks/:id/stop' },
  // The user's configured completion evidence for one task (PH10).
  { method: 'PATCH', path: '/v1/agents/:id/tasks/checks' },
  { method: 'PATCH', path: '/v1/agents/:id' },
  { method: 'DELETE', path: '/v1/agents/:id' },
  // Apps (BACKEND 10.18): the Apps page and what each agent may use. `install` and the installation `DELETE` of a work or custom app
  // are answered by the gateway first (it owns the OAuth callback, routes/apps.ts); a chat app's install reaches agentd through these.
  { method: 'GET', path: '/v1/apps' },
  { method: 'GET', path: '/v1/apps/:id' },
  { method: 'POST', path: '/v1/apps/:id/install' },
  { method: 'DELETE', path: '/v1/apps/:id/installations/:installationId' },
  // The owner has looked at the tools an app added or changed since they last did.
  { method: 'POST', path: '/v1/apps/:id/tools/review' },
  // A chat app: one agent in one workspace.
  { method: 'PUT', path: '/v1/apps/:id/installations/:installationId/agents/:agentId' },
  // A work or custom app: on or off for one agent, and its Actions policy.
  { method: 'PUT', path: '/v1/agents/:agentId/apps/:appId' },
  { method: 'POST', path: '/v1/agents/:id/wake' },
  { method: 'POST', path: '/v1/agents/:id/pause' },
  { method: 'POST', path: '/v1/agents/:id/resume' },
  { method: 'POST', path: '/v1/agents/:id/stop' },
  { method: 'POST', path: '/v1/agents/:id/role-suggestion/accept' },
  { method: 'POST', path: '/v1/agents/:id/role-suggestion/dismiss' },

  // Models (catalog + runtime live in agentd; the gateway only forwards)
  { method: 'GET', path: '/v1/models' },

  // Conversations and items
  { method: 'GET', path: '/v1/conversations' },
  { method: 'POST', path: '/v1/conversations' },
  { method: 'GET', path: '/v1/conversations/:id' },
  { method: 'PATCH', path: '/v1/conversations/:id' },
  { method: 'DELETE', path: '/v1/conversations/:id' },
  { method: 'GET', path: '/v1/conversations/:id/items' },
  // Standard AG-UI run entry: RunAgentInput starts a turn or carries resume entries for interrupts.
  { method: 'POST', path: '/v1/conversations/:id/runs' },
  { method: 'POST', path: '/v1/conversations/:id/typing' },
  { method: 'POST', path: '/v1/conversations/:id/mark-read' },
  { method: 'GET', path: '/v1/items' },
  { method: 'GET', path: '/v1/items/:id' },

  // Runs and requests
  { method: 'GET', path: '/v1/runs' },
  { method: 'GET', path: '/v1/runs/:id' },
  { method: 'POST', path: '/v1/runs/:id/stop' },
  { method: 'POST', path: '/v1/runs/:id/seen' },
  { method: 'GET', path: '/v1/runs/:id/steps' },
  { method: 'GET', path: '/v1/requests' },
  { method: 'GET', path: '/v1/requests/:id' },
  { method: 'POST', path: '/v1/requests/:id/resolve' },
  // Values for a secure_input request (encrypted to the sandbox's key): forwarded as-is, never logged by the gateway.
  { method: 'POST', path: '/v1/requests/:id/secure-input' },
  // Documents (0.70, BACKEND 5.11a): the owner's side of draft -> review -> approve, and the chat about one document.
  { method: 'POST', path: '/v1/documents' },
  { method: 'GET', path: '/v1/documents/:id' },
  { method: 'GET', path: '/v1/documents/:id/versions/:v/content' },
  { method: 'GET', path: '/v1/documents/:id/draft' },
  { method: 'PUT', path: '/v1/documents/:id/draft' },
  { method: 'POST', path: '/v1/documents/:id/draft/approve' },
  { method: 'POST', path: '/v1/documents/:id/draft/decline' },
  { method: 'POST', path: '/v1/documents/:id/conversations' },
  // Names of the owner's vault fields (never values), so the agent can map form fields to them.
  { method: 'GET', path: '/v1/secure-vault/keys' },
  { method: 'PUT', path: '/v1/secure-vault/keys' },
  // The account profile (non-secret details the agent fills in itself).
  { method: 'GET', path: '/v1/profile' },
  { method: 'PUT', path: '/v1/profile' },

  // Routines
  { method: 'GET', path: '/v1/routines' },
  { method: 'POST', path: '/v1/routines' },
  { method: 'GET', path: '/v1/routines/:id' },
  { method: 'PATCH', path: '/v1/routines/:id' },
  { method: 'POST', path: '/v1/routines/:id/toggle' },
  // Check a monitor now (the agent-made watches in the routine list).
  { method: 'POST', path: '/v1/routines/:id/check' },
  { method: 'DELETE', path: '/v1/routines/:id' },
  { method: 'GET', path: '/v1/routines/:id/runs' },

  // Rules
  { method: 'GET', path: '/v1/rules' },
  { method: 'POST', path: '/v1/rules' },
  { method: 'PATCH', path: '/v1/rules/:id' },
  { method: 'DELETE', path: '/v1/rules/:id' },
  { method: 'POST', path: '/v1/rules/:id/accept' },
  { method: 'POST', path: '/v1/rules/:id/reject' },
  { method: 'GET', path: '/v1/delegations' },
  { method: 'POST', path: '/v1/delegations' },
  { method: 'PATCH', path: '/v1/delegations/:id' },
  { method: 'DELETE', path: '/v1/delegations/:id' },

  // What the agents learned about the user: claims, forgetting, search (BACKEND §5.5)
  { method: 'GET', path: '/v1/memory/claims' },
  { method: 'POST', path: '/v1/memory/forget' },
  { method: 'GET', path: '/v1/memory/search' },
  // Memory items and the review queue (Team · Memory)
  { method: 'GET', path: '/v1/memory/items' },
  // The Memory page's sections: topics with their second-person summaries.
  { method: 'GET', path: '/v1/memory/topics' },
  { method: 'PATCH', path: '/v1/memory/items/:id' },
  { method: 'DELETE', path: '/v1/memory/items/:id' },
  { method: 'GET', path: '/v1/memory/review' },
  { method: 'POST', path: '/v1/memory/review/:id' },
  // People, their accounts and relations (Team · People). `possible-matches` before `:id`.
  { method: 'GET', path: '/v1/people' },
  { method: 'GET', path: '/v1/people/possible-matches' },
  { method: 'POST', path: '/v1/people/:id/link' },
  { method: 'PATCH', path: '/v1/people/:id' },
  { method: 'POST', path: '/v1/accounts/:id/unlink' },
  { method: 'POST', path: '/v1/relations/:id/confirm' },
  { method: 'DELETE', path: '/v1/relations/:id' },

  // The user's /juno home files (BACKEND §5.5)
  { method: 'GET', path: '/v1/home' },
  { method: 'PUT', path: '/v1/home/*' },
  { method: 'DELETE', path: '/v1/home/*' },

  // Goals and ideas
  { method: 'GET', path: '/v1/goals' },
  { method: 'POST', path: '/v1/goals' },
  { method: 'GET', path: '/v1/goals/:id' },
  { method: 'PATCH', path: '/v1/goals/:id' },
  { method: 'POST', path: '/v1/goals/:id/check' },
  { method: 'DELETE', path: '/v1/goals/:id' },
  { method: 'GET', path: '/v1/feed' },
  { method: 'POST', path: '/v1/feed/:id/like' },
  { method: 'POST', path: '/v1/feed/:id/feedback' },
  { method: 'GET', path: '/v1/today' },
  { method: 'GET', path: '/v1/meals' },
  { method: 'GET', path: '/v1/calendar' },
  { method: 'PATCH', path: '/v1/calendar/:id' },
  { method: 'DELETE', path: '/v1/calendar/:id' },
  { method: 'GET', path: '/v1/agents/:id/calendar' },
  // Composer dictation: the raw recording in, its text out (agentd routes/transcriptions.ts).
  { method: 'POST', path: '/v1/transcriptions' },
  // Spoken replies (Kokoro sidecar): text in, per-sentence audio urls out (agentd routes/speech.ts).
  { method: 'POST', path: '/v1/speech' },
  { method: 'GET', path: '/v1/speech/:id' },
  { method: 'GET', path: '/v1/ideas' },
  { method: 'POST', path: '/v1/ideas/:id/accept' },
  { method: 'POST', path: '/v1/ideas/:id/dismiss' },
  { method: 'POST', path: '/v1/inspiration/:id/dismiss' },
  // What the owner tells the agent about its unprompted messages: feedback buttons and their rules (BACKEND §5.10)
  { method: 'POST', path: '/v1/proactive/feedback' },
  { method: 'GET', path: '/v1/proactive/rules' },
  { method: 'PATCH', path: '/v1/proactive/rules/:id' },
  { method: 'DELETE', path: '/v1/proactive/rules/:id' },

  // Push notifications: the iOS device registers its APNs token (owner-scoped in agentd)
  { method: 'POST', path: '/v1/devices' },
  { method: 'DELETE', path: '/v1/devices/:token' },

  // The iPhone app as a device while it is open: it declares its EventKit abilities and answers `device.call` events (BACKEND 7.13)
  { method: 'PUT', path: '/v1/phone/declaration' },
  { method: 'DELETE', path: '/v1/phone/declaration' },
  { method: 'POST', path: '/v1/phone/calls/:callId/result' },

  // Skills (versioned: an edit is a new version; activate and rollback move the active pointer)
  { method: 'GET', path: '/v1/skills' },
  { method: 'POST', path: '/v1/skills' },
  { method: 'GET', path: '/v1/skills/:id' },
  { method: 'PUT', path: '/v1/skills/:id' },
  { method: 'GET', path: '/v1/skills/:id/versions' },
  { method: 'POST', path: '/v1/skills/:id/versions/:v/activate' },
  { method: 'POST', path: '/v1/skills/:id/rollback' },

  // Computers and screens (forwarded; the private service answers 404 without computerd)
  { method: 'GET', path: '/v1/computers' },
  // The owner's Mac as a computer (My Mac): status, pair, revoke. Before `:id`, which would read `my-mac` as an id.
  { method: 'GET', path: '/v1/computers/my-mac' },
  { method: 'POST', path: '/v1/computers/my-mac' },
  { method: 'DELETE', path: '/v1/computers/my-mac' },
  { method: 'POST', path: '/v1/computers/my-mac/stop' },
  // Apps agents may use on the Mac for good ("Always allow" on the approval card), and taking one back.
  { method: 'GET', path: '/v1/mac/apps' },
  { method: 'DELETE', path: '/v1/mac/apps/:app' },
  { method: 'GET', path: '/v1/computers/:id' },
  { method: 'POST', path: '/v1/computers/ensure' },
  { method: 'POST', path: '/v1/computers/:id/pause' },
  { method: 'POST', path: '/v1/computers/:id/resume' },
  { method: 'GET', path: '/v1/computers/:id/screens' },
  { method: 'GET', path: '/v1/computers/:id/agents/:agentId/screen' },
  { method: 'POST', path: '/v1/computers/:id/screens' },
  { method: 'POST', path: '/v1/screens/:id/take-over' },
  { method: 'GET', path: '/v1/screens/:id/elements' },
  { method: 'POST', path: '/v1/screens/:id/return-control' },
  { method: 'GET', path: '/v1/screens/:id/screenshot' },
  { method: 'POST', path: '/v1/screens/:id/stream' },
  // The computer clipboard (M-CLIP): image or files to the computer, and what the computer copied back.
  { method: 'POST', path: '/v1/screens/:id/clipboard' },
  { method: 'GET', path: '/v1/screens/:id/clipboard' },
];
