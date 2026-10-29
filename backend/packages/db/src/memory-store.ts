/**
 * In-memory Store for tests and dev (when DATABASE_URL is empty).
 *
 * The single implementation lives in juno-agent (its behavioral suite owns it), so the two can never
 * drift; db re-exports it as the Store adapter used by `createStore`.
 */
export { createMemoryStore } from 'juno-agent/testing/store';
export { createMemoryBlobStore } from 'juno-agent/testing/blobs';
