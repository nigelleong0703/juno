import type { ModelProvider, ModelSettings, UpdateSettingsInput } from "@agent-desktop/client";
import { Button, Combobox, Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@agent-desktop/ui";
import { useProviderModels } from "../../../data/queries";
import { useUpdateSettings } from "../../../data/mutations";
import { errorCode } from "../../../data/model-providers";
import { t } from "../../../lib/i18n";
import { Group, Row } from "../SettingsGroup";
import { providerErrorMessage } from "./errors";

/** The adapter's built-in temperature, kept when the account sets none. */
const ADAPTER_DEFAULT_TEMPERATURE = 0.7;

/** Editable text for the account-wide model choice; an empty field means "provider default". */
export interface ModelDraft {
  providerId: string;
  defaultModel: string;
  temperature: string;
  maxOutputTokens: string;
}

function optionalNumber(value: number | null | undefined): string {
  return value === null || value === undefined ? "" : String(value);
}

export function draftFromModels(models: ModelSettings | undefined): ModelDraft {
  return {
    providerId: models?.providerId ?? "",
    defaultModel: models?.defaultModel ?? "",
    temperature: optionalNumber(models?.temperature),
    maxOutputTokens: optionalNumber(models?.maxOutputTokens),
  };
}

function withinRange(value: string, min: number, max: number): boolean {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= min && parsed <= max;
}

function isPositiveWholeNumber(value: string): boolean {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0;
}

/** The validated patch, or null when a typed value is unusable so Save stays disabled. */
function modelsPatch(draft: ModelDraft): NonNullable<UpdateSettingsInput["models"]> | null {
  const temperature = draft.temperature.trim();
  const outputLimit = draft.maxOutputTokens.trim();
  if (temperature !== "" && !withinRange(temperature, 0, 2)) return null;
  if (outputLimit !== "" && !isPositiveWholeNumber(outputLimit)) return null;
  if (draft.providerId !== "" && draft.defaultModel === "") return null;
  return {
    providerId: draft.providerId === "" ? null : draft.providerId,
    defaultModel: draft.providerId === "" ? null : draft.defaultModel,
    temperature: temperature === "" ? null : Number(temperature),
    maxOutputTokens: outputLimit === "" ? null : Number(outputLimit),
  };
}

/** Radix Select cannot carry an empty value, so "no choice" travels as this sentinel. */
const NONE = "__none";
const CONTROL = "h-8 rounded-md bg-bg-subtle px-2 text-sm text-fg ring-1 ring-border";

/**
 * Default model: provider (only ones with a key), then a searchable model from that provider's
 * own catalog, then the runtime controls.
 */
export function DefaultModel({
  providers,
  platformDefault,
  served,
  draft,
  onDraft,
}: {
  providers: ModelProvider[];
  platformDefault: boolean;
  served: ModelDraft;
  draft: ModelDraft;
  onDraft: (update: (current: ModelDraft) => ModelDraft) => void;
}) {
  const save = useUpdateSettings();
  const usable = providers.filter((row) => row.hasKey && row.kind !== "systemone");
  const known = usable.some((row) => row.id === draft.providerId);
  // A saved provider that no longer exists reads as "nothing chosen" instead of a dangling id.
  const stale = served.providerId !== "" && !providers.some((row) => row.id === served.providerId);
  const providerId = known ? draft.providerId : "";
  const modelId = known ? draft.defaultModel : "";
  const catalog = useProviderModels(providerId === "" ? undefined : providerId);
  const items = catalog.data?.items ?? [];
  const patch = modelsPatch({ ...draft, providerId, defaultModel: modelId });
  const dirty = JSON.stringify(draft) !== JSON.stringify(served);

  const field = (key: keyof ModelDraft, value: string) => onDraft((current) => ({ ...current, [key]: value }));
  const options = items.map((item) => ({
    value: item.id,
    label: item.name,
    description: item.supportsImages ? t("models.default.images") : undefined,
  }));
  if (modelId !== "" && !items.some((item) => item.id === modelId) && catalog.isSuccess) {
    options.unshift({ value: modelId, label: modelId, description: undefined });
  }

  const onSave = () => {
    if (patch === null) return;
    save.mutate({ models: patch }, { onSuccess: () => onDraft(() => draft) });
  };
  const onClear = () =>
    save.mutate(
      { models: { providerId: null, defaultModel: null, temperature: null, maxOutputTokens: null } },
      { onSuccess: () => onDraft(() => draftFromModels(undefined)) },
    );
  const saveError = save.isError ? (errorCode(save.error).code === "UNKNOWN_PROVIDER" ? providerErrorMessage(save.error) : t("common.error")) : null;

  return (
    <Group title={t("settings.defaultModel")} description={t("models.default.hint")}>
      {stale && <p className="px-2.5 py-2 text-xs text-warning">{t("models.default.stale")}</p>}
      {usable.length === 0 && !platformDefault && (
        <p className="px-2.5 py-2 text-sm text-fg-muted">{t("models.default.noProviders")}</p>
      )}
      {(usable.length > 0 || platformDefault) && (
        <>
          <Row label={t("models.default.provider")}>
            <Select
              disabled={save.isPending}
              value={providerId || NONE}
              onValueChange={(next) => {
                const value = next === NONE ? "" : next;
                // A new provider means a new catalog, so the old model no longer applies.
                onDraft((current) => ({ ...current, providerId: value, defaultModel: "" }));
              }}
            >
              <SelectTrigger size="sm" aria-label={t("models.default.provider")} className="w-64">
                <SelectValue />
              </SelectTrigger>
              <SelectContent position="popper" align="end">
                <SelectItem value={NONE}>
                  {platformDefault ? t("models.default.servicePlatform") : t("models.default.chooseProvider")}
                </SelectItem>
                {usable.map((row) => (
                  <SelectItem key={row.id} value={row.id}>
                    {row.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Row>
          {providerId !== "" && (
            <Row label={t("settings.defaultModel")}>
              <div className="w-64">
                {catalog.isLoading ? (
                  <span className="text-sm text-fg-muted">{t("models.default.loadingModels")}</span>
                ) : catalog.isError ? (
                  <span className="flex items-center gap-2 text-xs text-fg-muted">
                    {errorCode(catalog.error).code === "MODEL_CATALOG_UNAVAILABLE"
                      ? t("models.default.catalogDown")
                      : t("common.error")}
                    <Button variant="ghost" size="sm" onClick={() => void catalog.refetch()}>
                      {t("common.retry")}
                    </Button>
                  </span>
                ) : (
                  <Combobox
                    options={options}
                    value={modelId}
                    onValueChange={(value) => onDraft((current) => ({ ...current, defaultModel: value }))}
                    placeholder={t("models.default.chooseModel")}
                    searchPlaceholder={t("models.default.searchModels")}
                    emptyMessage={t("models.default.noModels")}
                    disabled={save.isPending}
                  />
                )}
              </div>
            </Row>
          )}
          <Row
            label={t("settings.temperature")}
            description={t("settings.temperatureHint", { value: ADAPTER_DEFAULT_TEMPERATURE })}
          >
            <input
              aria-label={t("settings.temperature")}
              type="number"
              min={0}
              max={2}
              step={0.1}
              placeholder={t("settings.providerDefault")}
              className={`${CONTROL} w-64`}
              disabled={save.isPending}
              value={draft.temperature}
              onChange={(event) => field("temperature", event.currentTarget.value)}
            />
          </Row>
          <Row label={t("settings.maxOutputTokens")} description={t("settings.maxOutputTokensHint")}>
            <input
              aria-label={t("settings.maxOutputTokens")}
              type="number"
              min={1}
              step={1}
              placeholder={t("settings.providerDefault")}
              className={`${CONTROL} w-64`}
              disabled={save.isPending}
              value={draft.maxOutputTokens}
              onChange={(event) => field("maxOutputTokens", event.currentTarget.value)}
            />
          </Row>
          {patch === null && modelId !== "" && <p className="px-2.5 pb-2 text-xs text-danger">{t("settings.runtimeInvalid")}</p>}
          <div className="flex items-center justify-between gap-4 px-2.5 py-2">
            <p className="text-xs text-fg-subtle">{t("settings.modelsNote")}</p>
            <span className="flex shrink-0 items-center gap-2">
              {(save.isPending || save.isSuccess) && (
                <span className="text-xs text-fg-subtle">{save.isPending ? t("settings.saving") : t("settings.saved")}</span>
              )}
              {served.defaultModel !== "" && (
                <Button variant="ghost" size="sm" disabled={save.isPending} onClick={onClear}>
                  {t("models.default.clear")}
                </Button>
              )}
              <Button variant="primary" size="sm" disabled={!dirty || save.isPending || patch === null} onClick={onSave}>
                {t("common.save")}
              </Button>
            </span>
          </div>
          {saveError && (
            <p className="px-2.5 pb-2 text-xs text-danger">
              <span>{saveError} </span>
              <button type="button" className="text-accent-link underline-offset-2 hover:underline" onClick={onSave}>
                {t("common.retry")}
              </button>
            </p>
          )}
        </>
      )}
    </Group>
  );
}
