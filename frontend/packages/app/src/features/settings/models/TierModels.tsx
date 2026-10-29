import {
  reasoningEffortSchema,
  tierNames,
  type EffectiveTier,
  type EffectiveTiers,
  type ModelProvider,
  type ModelSettings,
  type TierName,
  type TierRow,
  type Tiers,
} from "@agent-desktop/client";
import {
  Button,
  Combobox,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  type ComboboxOption,
} from "@agent-desktop/ui";
import { useQueries } from "@tanstack/react-query";
import { ChevronRight } from "lucide-react";
import { useState } from "react";
import { useClient } from "../../../data/ClientProvider";
import { qk } from "../../../data/keys";
import { useUpdateSettings } from "../../../data/mutations";
import { errorCode } from "../../../data/model-providers";
import { t } from "../../../lib/i18n";
import { Group, Row } from "../SettingsGroup";

/** "Default" in both pickers; Radix Select and Combobox cannot carry an empty option any other way. */
const DEFAULT = "";
const EFFORT_DEFAULT = "__default";
/** Provider and model ids joined for a Combobox value; the platform default endpoint has an empty provider. */
const encode = (providerId: string | null | undefined, modelId: string) => `${providerId ?? ""}\n${modelId}`;

interface Choices {
  options: ComboboxOption[];
  names: Map<string, string>;
  efforts: Map<string, readonly string[]>;
  loading: boolean;
}

/** Every model the owner can pick: their providers' catalogs and, when there is one, the platform default's. */
function useChoices(providers: ModelProvider[], platformDefault: boolean): Choices {
  const client = useClient();
  const eligible = providers.filter((row) => row.hasKey && row.kind !== "systemone");
  const catalogs = useQueries({
    queries: [
      ...(platformDefault
        ? [{ queryKey: qk.platformModels(), queryFn: () => client.settings.models(), retry: false }]
        : []),
      ...eligible.map((row) => ({
        queryKey: qk.providerModels(row.id),
        queryFn: () => client.modelProviders.models(row.id),
        retry: false,
      })),
    ],
  });
  const sources = [...(platformDefault ? [{ id: "", name: t("models.tiers.platform") }] : []), ...eligible];
  const options: ComboboxOption[] = [{ value: DEFAULT, label: t("models.tiers.default") }];
  const names = new Map<string, string>();
  const efforts = new Map<string, readonly string[]>();
  sources.forEach((source, index) => {
    for (const item of catalogs[index]?.data?.items ?? []) {
      const value = encode(source.id, item.id);
      options.push({ value, label: item.name, description: source.name });
      names.set(value, item.name);
      efforts.set(value, item.reasoningEfforts ?? []);
    }
  });
  return { options, names, efforts, loading: catalogs.some((query) => query.isLoading) };
}

function effortLabel(effort: EffectiveTier["effort"]): string | null {
  if (effort === null) return null;
  return effort === "none" ? t("models.tiers.noThinking") : effort;
}

function tierErrorMessage(error: unknown): string {
  const { code, status } = errorCode(error);
  if (status !== undefined && status >= 500) return t("models.error.server");
  const key = `models.tiers.error.${code}`;
  const specific = code === undefined ? key : t(key);
  return specific !== key ? specific : t("models.error.generic");
}

/** The tier's saved row as the two picker values. */
function draftFromRow(row: TierRow | undefined) {
  return { model: row?.modelId ? encode(row.providerId, row.modelId) : DEFAULT, effort: row?.effort ?? "" };
}

function TierDialog({
  tier,
  choices,
  effective,
  models,
  onClose,
}: {
  tier: TierName;
  choices: Choices;
  effective: EffectiveTier | null | undefined;
  models: ModelSettings | undefined;
  onClose: () => void;
}) {
  const save = useUpdateSettings();
  const saved = models?.tiers?.[tier];
  const [draft, setDraft] = useState(() => draftFromRow(saved));
  // A row left on Default runs the model shown as its current value, so its levels are that model's.
  const levelsOf = draft.model !== DEFAULT ? draft.model : tier === "fast" || !effective ? null : encode(effective.providerId, effective.modelId);
  const offered = levelsOf === null ? [] : (choices.efforts.get(levelsOf) ?? []);
  const needsModel = tier === "fast" && draft.model === DEFAULT;
  const effortDisabled = save.isPending || needsModel || offered.length === 0;
  const hint = needsModel ? t("models.tiers.effortNeedsModel") : offered.length === 0 && !choices.loading ? t("models.tiers.noEfforts") : null;

  const submit = (row: TierRow) => {
    const next: Tiers = { ...(models?.tiers ?? {}) };
    if (Object.keys(row).length === 0) delete next[tier];
    else next[tier] = row;
    // PATCH replaces `tiers` whole, so every row that stays is sent along with this one.
    save.mutate({ models: { tiers: Object.keys(next).length === 0 ? null : next } }, { onSuccess: onClose });
  };
  const onSave = () => {
    const row: TierRow = {};
    if (draft.model !== DEFAULT) {
      const [providerId, modelId] = draft.model.split("\n");
      if (providerId) row.providerId = providerId;
      if (modelId) row.modelId = modelId;
    }
    const effort = reasoningEffortSchema.safeParse(draft.effort);
    if (effort.success && !effortDisabled) row.effort = effort.data;
    submit(row);
  };
  // The saved model may have left its catalog; keep it visible so the owner sees what is set.
  const options =
    draft.model !== DEFAULT && !choices.options.some((option) => option.value === draft.model)
      ? [...choices.options, { value: draft.model, label: saved?.modelId ?? draft.model, description: undefined }]
      : choices.options;

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t(`models.tiers.${tier}`)}</DialogTitle>
          <DialogDescription>{t(`models.tiers.${tier}Hint`)}</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1">
            <div className="text-xs text-fg-muted">{t("models.tiers.model")}</div>
            <Combobox
              options={options}
              value={draft.model}
              onValueChange={(model) => setDraft({ model, effort: "" })}
              placeholder={t("models.default.chooseModel")}
              searchPlaceholder={t("models.default.searchModels")}
              emptyMessage={t("models.default.noModels")}
              disabled={save.isPending || choices.loading}
            />
          </div>
          <div className="space-y-1">
            <div className="text-xs text-fg-muted">{t("models.tiers.effort")}</div>
            <Select
              disabled={effortDisabled}
              value={draft.effort || EFFORT_DEFAULT}
              onValueChange={(next) => setDraft({ ...draft, effort: next === EFFORT_DEFAULT ? "" : next })}
            >
              <SelectTrigger size="sm" aria-label={t("models.tiers.effort")} className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent position="popper" align="end">
                <SelectItem value={EFFORT_DEFAULT}>{t("models.tiers.default")}</SelectItem>
                {offered.map((level) => (
                  <SelectItem key={level} value={level}>
                    {level}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {hint && <p className="text-xs text-fg-subtle">{hint}</p>}
          </div>
          {save.isError && (
            <p role="alert" className="text-xs text-danger">
              {tierErrorMessage(save.error)}
            </p>
          )}
        </div>
        <DialogFooter>
          <Button variant="ghost" disabled={save.isPending || saved === undefined} onClick={() => submit({})}>
            {t("models.tiers.reset")}
          </Button>
          <Button variant="secondary" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button variant="primary" disabled={save.isPending || choices.loading} onClick={onSave}>
            {t("common.save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Settings > Models: what each kind of job runs on. Each row shows the model and thinking level it resolves to now
 * and opens a small editor; saving sends the whole `tiers` object because the server replaces it.
 */
export function TierModels({
  providers,
  platformDefault,
  models,
  effective,
}: {
  providers: ModelProvider[];
  platformDefault: boolean;
  models: ModelSettings | undefined;
  effective: EffectiveTiers | null | undefined;
}) {
  const choices = useChoices(providers, platformDefault);
  const [editing, setEditing] = useState<TierName | null>(null);
  return (
    <Group title={t("models.tiers.title")} description={t("models.tiers.hint")}>
      {tierNames.map((tier) => {
        const row = effective?.[tier];
        const model = row ? (choices.names.get(encode(row.providerId, row.modelId)) ?? row.modelId) : t("models.tiers.none");
        // The level stays readable however long the model name is: only the name is truncated.
        const effort = row ? effortLabel(row.effort) : null;
        return (
          <Row key={tier} label={t(`models.tiers.${tier}`)} description={t(`models.tiers.${tier}Hint`)}>
            <Button variant="ghost" size="sm" aria-label={t("models.tiers.edit", { name: t(`models.tiers.${tier}`) })} onClick={() => setEditing(tier)}>
              <span className="max-w-48 truncate">{model}</span>
              {effort && <span className="shrink-0">{` · ${effort}`}</span>}
              {row?.source === "default" && <span className="text-fg-subtle">{t("models.tiers.default")}</span>}
              <ChevronRight className="size-4 text-fg-subtle" />
            </Button>
          </Row>
        );
      })}
      {editing !== null && (
        <TierDialog
          tier={editing}
          choices={choices}
          effective={effective?.[editing]}
          models={models}
          onClose={() => setEditing(null)}
        />
      )}
    </Group>
  );
}
