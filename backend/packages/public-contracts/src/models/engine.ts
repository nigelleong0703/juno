import { z } from 'zod';
import { isoDateTimeSchema } from './common.js';

export const PI_ENGINE_ID = 'pi';

export const engineIdSchema = z.string().min(1);
export type EngineId = z.infer<typeof engineIdSchema>;

export const engineCapabilitiesSchema = z.object({
  tools: z.boolean(),
  approvals: z.boolean(),
  steering: z.boolean(),
  deltas: z.boolean(),
});
export type EngineCapabilities = z.infer<typeof engineCapabilitiesSchema>;

export const engineCatalogEntrySchema = z.object({
  id: engineIdSchema,
  name: z.string().min(1),
  version: z.string().min(1),
  available: z.boolean(),
  reason: z.string().optional(),
  capabilities: engineCapabilitiesSchema,
});
export type EngineCatalogEntry = z.infer<typeof engineCatalogEntrySchema>;

export const engineCatalogSchema = z.array(engineCatalogEntrySchema);
export type EngineCatalog = z.infer<typeof engineCatalogSchema>;

export const agentEngineSchema = z.object({
  id: engineIdSchema,
  revision: z.string().min(1),
  updatedAt: isoDateTimeSchema,
});
export type AgentEngine = z.infer<typeof agentEngineSchema>;

export const runEngineSnapshotSchema = z.object({
  id: engineIdSchema,
  version: z.string().min(1),
  revision: z.string().optional(),
});
export type RunEngineSnapshot = z.infer<typeof runEngineSnapshotSchema>;

export const DEFAULT_ENGINE_CATALOG: EngineCatalog = [
  {
    id: PI_ENGINE_ID,
    name: 'Current engine',
    version: '1',
    available: true,
    capabilities: { tools: true, approvals: true, steering: true, deltas: true },
  },
];

export function findCatalogEntry(catalog: EngineCatalog, id: string): EngineCatalogEntry | undefined {
  return catalog.find((entry) => entry.id === id);
}
