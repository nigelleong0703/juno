/**
 * The gateway forwards only the routes in AGENTD_ROUTES (an allowlist), so a route agentd serves but the table lacks answers 404 to the
 * app (a batch once shipped the People and memory-item routes without it). The owner's Memory and People routes are the ones the app calls
 * for its two segments: every route agentd registers in those files must be in the table, with the same method and path. The Apps
 * routes (agentd's apps.ts) are checked the same way, and so are the two the gateway answers first for a work or custom app (its own
 * routes/apps.ts): for a chat app they fall through to agentd, so they must be in the table too.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { AGENTD_ROUTES } from '../routes/agentd-routes.js';

/** agentd's route files that serve the owner's Memory, People and Apps segments. */
const OWNER_ROUTE_FILES = ['memory.ts', 'people.ts', 'apps.ts', 'documents.ts'];
const REGISTRATION = /app\.(get|post|put|patch|delete)\(\s*'(\/v1[^']*)'/g;

function registeredAt(path: string): string[] {
  const source = readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8');
  return [...source.matchAll(REGISTRATION)].map((match) => `${(match[1] ?? '').toUpperCase()} ${match[2] ?? ''}`);
}

const registeredIn = (file: string): string[] => registeredAt('../../../agentd/src/routes/' + file);

describe('AGENTD_ROUTES', () => {
  const forwarded = new Set(AGENTD_ROUTES.map((route) => `${route.method} ${route.path}`));

  it.each(OWNER_ROUTE_FILES)('forwards every /v1 route that agentd registers in %s', (file) => {
    const registered = registeredIn(file);
    expect(registered.length).toBeGreaterThan(0);
    expect(registered.filter((route) => !forwarded.has(route))).toEqual([]);
  });

  it('forwards the Apps routes the gateway answers first, for the chat apps that are not its own', () => {
    const answeredFirst = registeredAt('../routes/apps.ts');
    expect(answeredFirst).toEqual(['POST /v1/apps/custom/probe', 'POST /v1/apps/:id/install', 'DELETE /v1/apps/:id/installations/:installationId']);
    // The probe of a custom server is the gateway's alone (it owns the outbound guard); agentd has no such route.
    expect(answeredFirst.filter((route) => !forwarded.has(route))).toEqual(['POST /v1/apps/custom/probe']);
  });

  it('keeps no route of the per-agent channel connect or the connector pages, which the Apps routes replaced', () => {
    const gone = [...forwarded].filter((route) => /\/agents\/:id\/channels|\/v1\/connectors|\/v1\/connections/.test(route));
    expect(gone).toEqual([]);
  });

  it('lists each method and path once', () => {
    expect(forwarded.size).toBe(AGENTD_ROUTES.length);
  });
});
