import type { EffectiveSystemOneModel, ModelProvider, ModelSettings } from "@agent-desktop/client";
import { Combobox, type ComboboxOption } from "@agent-desktop/ui";
import { useQueries } from "@tanstack/react-query";
import { useClient } from "../../../data/ClientProvider";
import { qk } from "../../../data/keys";
import { useUpdateSettings } from "../../../data/mutations";
import { t } from "../../../lib/i18n";
import { Group, Row } from "../SettingsGroup";
import { providerErrorMessage } from "./errors";

const AUTO = "";
/** Provider and model ids joined for a Combobox value; neither can contain a newline. */
const encode = (providerId: string, modelId: string) => `${providerId}\n${modelId}`;

/** Every model of the owner's System One providers. */
function useChoices(providers: ModelProvider[]) {
  const client = useClient();
  const eligible = providers.filter((row) => row.hasKey && row.kind === "systemone");
  const catalogs = useQueries({
    queries: eligible.map((row) => ({
      queryKey: qk.providerModels(row.id),
      queryFn: () => client.modelProviders.models(row.id),
      retry: false,
    })),
  });
  const options: ComboboxOption[] = [{ value: AUTO, label: t("models.background.auto") }];
  eligible.forEach((row, index) => {
    for (const item of catalogs[index]?.data?.items ?? []) {
      options.push({ value: encode(row.id, item.id), label: item.name, description: row.name });
    }
  });
  return { options, loading: catalogs.some((query) => query.isLoading), empty: eligible.length === 0 };
}

function autoLine(effective: EffectiveSystemOneModel | null | undefined, options: ComboboxOption[]): string {
  if (!effective) return t("models.background.none");
  const named = options.find((option) => option.value === encode(effective.providerId ?? "", effective.modelId))?.label;
  return t(`models.background.source.${effective.source}`, { model: named ?? effective.modelId });
}

/**
 * Settings > Models: the System One model. It picks from the owner's own System One providers, or stays Auto,
 * which shows the model the server would use right now and why.
 */
export function BackgroundModels({
  providers,
  models,
  effectiveSystemOne,
}: {
  providers: ModelProvider[];
  models: ModelSettings | undefined;
  effectiveSystemOne: EffectiveSystemOneModel | null | undefined;
}) {
  const save = useUpdateSettings();
  const { options, loading, empty } = useChoices(providers);
  const chosen = models?.systemOneModel;
  const value = chosen ? encode(chosen.providerId, chosen.modelId) : AUTO;
  const label = t("models.background.systemOne");
  const stale = chosen && !options.some((option) => option.value === value) && !loading;
  // The picked model stays visible even when its catalog is still loading or no longer lists it.
  const shown = chosen && !options.some((option) => option.value === value) ? [...options, { value, label: chosen.modelId, description: undefined }] : options;
  return (
    <Group title={t("models.background.title")} description={t("models.background.hint")}>
      <Row label={label} description={`${chosen ? "" : `${autoLine(effectiveSystemOne, options)}. `}${t("models.background.systemOneHint")}`}>
        <div className="w-64">
          {empty && <p className="mb-1 text-xs text-fg-subtle">{t("models.background.noSystemOne")}</p>}
          <Combobox
            options={shown}
            value={value}
            onValueChange={(next) => {
              const [providerId, modelId] = next.split("\n");
              save.mutate({ models: { systemOneModel: next === AUTO || !providerId || !modelId ? null : { providerId, modelId } } });
            }}
            placeholder={label}
            searchPlaceholder={t("models.default.searchModels")}
            emptyMessage={t("models.default.noModels")}
            disabled={save.isPending || loading}
          />
          {stale && <p className="mt-1 text-xs text-warning">{t("models.background.stale")}</p>}
        </div>
      </Row>
      {save.isError && (
        <p role="alert" className="px-2.5 pb-2 text-xs text-danger">
          {providerErrorMessage(save.error)}
        </p>
      )}
    </Group>
  );
}
