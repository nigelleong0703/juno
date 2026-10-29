import { z } from 'zod';

const priceField = z.number().refine((value) => Number.isFinite(value) && value >= 0, {
  message: 'price must be a finite number >= 0',
});

export const modelPricingSchema = z.object({
  input: priceField,
  output: priceField,
  cacheRead: priceField,
  cacheWrite: priceField,
});

export type ModelPricing = z.infer<typeof modelPricingSchema>;

const pricingEntrySchema = z.object({
  baseUrl: z.string().min(1),
  modelId: z.string().min(1),
  input: priceField,
  output: priceField,
  cacheRead: priceField,
  cacheWrite: priceField,
});

export type PricedModel = z.infer<typeof pricingEntrySchema>;

export type PricingTable = ReadonlyArray<PricedModel>;

const tableArraySchema = z.array(pricingEntrySchema);
const tableWrappedSchema = z.object({ entries: z.array(pricingEntrySchema) });

export function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '');
}

function parseJsonText(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error('MODEL_PRICING_JSON is not valid JSON');
  }
}

function freezeTable(entries: PricedModel[]): PricingTable {
  const seen = new Set<string>();
  const frozen: PricedModel[] = [];
  for (const entry of entries) {
    const key = normalizeBaseUrl(entry.baseUrl) + '\0' + entry.modelId;
    if (seen.has(key)) throw new Error('Duplicate pricing for ' + entry.modelId + ' at ' + entry.baseUrl);
    seen.add(key);
    frozen.push({ ...entry, baseUrl: normalizeBaseUrl(entry.baseUrl) });
  }
  return Object.freeze(frozen);
}

export function parsePricingTable(raw: unknown): PricingTable {
  if (raw === undefined || raw === null) return [];
  if (typeof raw === 'string' && raw.trim().length === 0) return [];
  const parsed = typeof raw === 'string' ? parseJsonText(raw) : raw;
  const asArray = tableArraySchema.safeParse(parsed);
  if (asArray.success) return freezeTable(asArray.data);
  const wrapped = tableWrappedSchema.safeParse(parsed);
  if (wrapped.success) return freezeTable(wrapped.data.entries);
  throw new Error('MODEL_PRICING_JSON must be a JSON array or {"entries": [...]} of {baseUrl, modelId, input, output, cacheRead, cacheWrite}');
}

export function readPricingFromEnv(env: NodeJS.ProcessEnv = process.env): PricingTable {
  return parsePricingTable(env['MODEL_PRICING_JSON']);
}

export function pricingFor(table: PricingTable, baseUrl: string, modelId: string): ModelPricing | undefined {
  const key = normalizeBaseUrl(baseUrl) + '\0' + modelId;
  for (const entry of table) {
    if (normalizeBaseUrl(entry.baseUrl) + '\0' + entry.modelId === key) {
      return { input: entry.input, output: entry.output, cacheRead: entry.cacheRead, cacheWrite: entry.cacheWrite };
    }
  }
  return undefined;
}

export function isFreePricing(pricing: ModelPricing): boolean {
  return pricing.input === 0 && pricing.output === 0 && pricing.cacheRead === 0 && pricing.cacheWrite === 0;
}

/** Zod extension owning the frozen pricing field on run snapshots; absent stays unknown. */
export const pricedSnapshotExtension = z.object({ pricing: modelPricingSchema.optional() });

/**
 * Pricing fragment frozen onto a new run snapshot for one exact endpoint/model.
 * Reads the runtime-canonical pricing JSON (config wins over env, resolved once in
 * runtime.ts); a malformed document throws loudly instead of running on unknown cost,
 * while a missing entry simply leaves the run unknown (never free, never invented).
 */
export function snapshotPricingFragment(
  configJson: string | undefined,
  baseUrl: string,
  modelId: string,
): { pricing?: ModelPricing } {
  const found = pricingFor(parsePricingTable(configJson), baseUrl, modelId);
  return found === undefined ? {} : { pricing: found };
}
