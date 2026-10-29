/** Upstream model entry fields: parsing and mapping gateway metadata into catalog items. */
import { z } from 'zod';
import { reasoningEffortSchema, type ModelCatalogItem, type ReasoningEffort } from '@agent-desktop/public-contracts';


// Lenient upstream entry: only the fields the catalog needs are read, everything else ignored.
const capabilitiesSchema = z
  .object({
    context_length: z.number().optional(),
    input_modalities: z.array(z.string()).optional(),
    output_modalities: z.array(z.string()).optional(),
    supports_vision: z.boolean().optional(),
    supports_tool_use: z.boolean().optional(),
    supports_reasoning: z.boolean().optional(),
    supports_web_search: z.boolean().optional(),
    reasoning_effort: z.union([z.string(), z.array(z.string())]).optional(),
  })
  .passthrough();

export const catalogEntrySchema = z
  .object({
    id: z.string().optional(),
    name: z.string().optional(),
    input_modalities: z.array(z.string()).optional(),
    output_modalities: z.array(z.string()).optional(),
    supports_vision: z.boolean().optional(),
    supports_tool_use: z.boolean().optional(),
    supports_reasoning: z.boolean().optional(),
    supports_web_search: z.boolean().optional(),
    reasoning_effort: z.union([z.string(), z.array(z.string())]).optional(),
    context_length: z.number().optional(),
    capabilities: capabilitiesSchema.optional(),
    architecture: z
      .object({
        input_modalities: z.array(z.string()).optional(),
        output_modalities: z.array(z.string()).optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

export const catalogResponseSchema = z.object({ data: z.array(z.unknown()) }).passthrough();

type CatalogEntry = z.infer<typeof catalogEntrySchema>;


function inputModalityLists(entry: CatalogEntry): string[][] {
  const candidates = [entry.input_modalities, entry.capabilities?.input_modalities, entry.architecture?.input_modalities];
  return candidates.filter((list): list is string[] => Array.isArray(list));
}

function outputModalityLists(entry: CatalogEntry): string[][] {
  const candidates = [entry.output_modalities, entry.capabilities?.output_modalities, entry.architecture?.output_modalities];
  return candidates.filter((list): list is string[] => Array.isArray(list));
}

/** Explicit upstream vision only: a vision flag or an image modality. Unknown stays text-only. */
function entrySupportsVision(entry: CatalogEntry): boolean {
  if (entry.supports_vision === true || entry.capabilities?.supports_vision === true) return true;
  return inputModalityLists(entry).some((list) => list.includes('image'));
}

/**
 * Offered reasoning levels restricted to the ones pi-ai can actually send: only published lists
 * count (a lone selected-effort string names the current level, never the set), extra levels
 * such as ultra are dropped, empty means none offered, and undefined means nothing was said.
 */
function entryReasoningEfforts(entry: CatalogEntry): ReasoningEffort[] | undefined {
  const published = publishedEfforts(entry);
  if (published.size > 0) return reasoningEffortSchema.options.filter((level) => published.has(level));
  const described = entry.supports_reasoning === false || entry.capabilities?.supports_reasoning === false;
  return described ? [] : undefined;
}

function publishedEfforts(entry: CatalogEntry): Set<string> {
  const lists = [entry.reasoning_effort, entry.capabilities?.reasoning_effort];
  return new Set(lists.flatMap((list) => (Array.isArray(list) ? list : [])));
}

/**
 * Measured effort lists for gateway models whose catalog entry publishes none (2026-10: Muse Spark has no `none`,
 * the Luna models have no `minimal`). Measured against the real API, so they win over a gateway's published list.
 */
const MEASURED_EFFORTS: ReadonlyArray<{ matches: (model: string) => boolean; efforts: ReasoningEffort[]; noReasoning: boolean }> = [
  { matches: (model) => model.startsWith('muse-spark-'), efforts: ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'], noReasoning: false },
  { matches: (model) => model.startsWith('gpt-') && model.endsWith('-luna'), efforts: ['low', 'medium', 'high', 'xhigh', 'max'], noReasoning: true },
];

/** The measured entry for a catalog id, with or without a `provider/` prefix. */
export function measuredEfforts(id: string): (typeof MEASURED_EFFORTS)[number] | undefined {
  const model = id.slice(id.lastIndexOf('/') + 1);
  return MEASURED_EFFORTS.find((known) => known.matches(model));
}

/**
 * Explicitly unsupported models are hidden: an upstream supports_tool_use:false, or a
 * published output modality list with no text output. Unknown metadata never hides a model.
 */
function entryUnsupported(entry: CatalogEntry): boolean {
  if (entry.supports_tool_use === false || entry.capabilities?.supports_tool_use === false) return true;
  const lists = outputModalityLists(entry);
  return lists.length > 0 && !lists.some((list) => list.includes('text'));
}

export function toCatalogItem(entry: CatalogEntry, env: { modelId: string; supportsImages: boolean }): ModelCatalogItem | undefined {
  if (!entry.id) return undefined;
  if (entryUnsupported(entry)) return undefined;
  // The env flag is authoritative only for the current default; every other model reports
  // exactly what upstream published, defaulting to text-only when it publishes nothing.
  const supportsImages = entry.id === env.modelId ? env.supportsImages : entrySupportsVision(entry);
  // A measured model's levels come from calling the real API; a gateway's own list can be incomplete (OCX lists
  // low..xhigh for Muse Spark, which also takes minimal and max), so the measurement wins where it exists.
  const measured = measuredEfforts(entry.id);
  const reasoningEfforts = measured?.efforts ?? entryReasoningEfforts(entry);
  const noReasoning = measured === undefined ? publishedEfforts(entry).has('none') : measured.noReasoning;
  return {
    id: entry.id,
    name: entry.name ?? entry.id,
    supportsImages,
    ...(reasoningEfforts === undefined ? {} : { reasoningEfforts }),
    ...(noReasoning ? { noReasoning: true as const } : {}),
    // Explicit upstream claim only: the gateway runs the provider's search tool for this model.
    ...(entry.supports_web_search === true || entry.capabilities?.supports_web_search === true ? { nativeWebSearch: true as const } : {}),
  };
}
