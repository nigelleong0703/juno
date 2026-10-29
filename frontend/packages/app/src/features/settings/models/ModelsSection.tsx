import type { ModelProvider } from "@agent-desktop/client";
import { Button, EmptyState } from "@agent-desktop/ui";
import { Plus } from "lucide-react";
import { useState } from "react";
import { useModelProviders, useSettings } from "../../../data/queries";
import { t } from "../../../lib/i18n";
import { Group } from "../SettingsGroup";
import { AddProviderDialog } from "./AddProviderDialog";
import { BackgroundModels } from "./BackgroundModels";
import { ChatGPTSignInDialog } from "./ChatGPTSignInDialog";
import { DefaultModel, draftFromModels, type ModelDraft } from "./DefaultModel";
import { ProviderList } from "./ProviderList";
import { TierModels } from "./TierModels";
import { WebSearch } from "./WebSearch";

function Retry({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="flex items-center gap-3 text-sm text-fg-muted">
      <span>{t("common.error")}</span>
      <button type="button" className="text-accent-link underline-offset-2 hover:underline" onClick={onRetry}>
        {t("common.retry")}
      </button>
    </div>
  );
}

/** Settings > Models: the owner's providers, then the default model drawn from them. */
export function ModelsSection() {
  const settingsQuery = useSettings();
  const providersQuery = useModelProviders();
  const [dialog, setDialog] = useState<"add" | "chatgpt" | null>(null);
  const [draft, setDraft] = useState<ModelDraft | undefined>(undefined);

  // With no saved choice and no platform default, a single keyed provider is the only sensible pick.
  if (draft === undefined && settingsQuery.data !== undefined && providersQuery.data !== undefined) {
    const initial = draftFromModels(settingsQuery.data.models);
    const keyed = providersQuery.data.providers.filter((row) => row.hasKey && row.kind !== "systemone");
    const only = !providersQuery.data.platformDefault && initial.providerId === "" && keyed.length === 1 ? keyed[0] : undefined;
    setDraft(only === undefined ? initial : { ...initial, providerId: only.id });
  }

  if (settingsQuery.isLoading || providersQuery.isLoading) {
    return <p className="text-sm text-fg-muted">{t("common.loading")}</p>;
  }
  if (!settingsQuery.data || !providersQuery.data || draft === undefined) {
    return (
      <Retry
        onRetry={() => {
          void settingsQuery.refetch();
          void providersQuery.refetch();
        }}
      />
    );
  }

  const { providers, platformDefault } = providersQuery.data;
  const served = draftFromModels(settingsQuery.data.models);
  const hasDefault = providers.some((row) => row.id === draft.providerId && row.hasKey);

  // A first provider becomes the default picker's choice (not saved until the owner picks a model).
  const onAdded = (provider: ModelProvider) => {
    if (!hasDefault) setDraft({ ...draft, providerId: provider.id, defaultModel: "" });
  };
  const addButton = (variant: "primary" | "secondary") => (
    <Button variant={variant} size="sm" onClick={() => setDialog("add")}>
      <Plus className="size-4" />
      {t("models.add")}
    </Button>
  );

  return (
    <>
      <Group
        title={t("models.providers")}
        description={t("settings.modelsHint")}
        action={providers.length > 0 ? addButton("secondary") : undefined}
      >
        {providers.length === 0 ? (
          <EmptyState
            title={t("models.empty.title")}
            description={platformDefault ? t("models.empty.bodyPlatform") : t("models.empty.body")}
            action={addButton("primary")}
          />
        ) : (
          <ProviderList
            providers={providers}
            defaultProviderId={settingsQuery.data.models?.providerId}
            onSignInAgain={() => setDialog("chatgpt")}
          />
        )}
      </Group>
      <DefaultModel
        providers={providers}
        platformDefault={platformDefault}
        served={served}
        draft={draft}
        onDraft={(update) => setDraft((current) => (current ? update(current) : current))}
      />
      <TierModels
        providers={providers}
        platformDefault={platformDefault}
        models={settingsQuery.data.models}
        effective={settingsQuery.data.effectiveTiers}
      />
      <BackgroundModels
        providers={providers}
        models={settingsQuery.data.models}
        effectiveSystemOne={settingsQuery.data.effectiveSystemOneModel}
      />
      <WebSearch models={settingsQuery.data.models} />
      {dialog === "add" && (
        <AddProviderDialog onClose={() => setDialog(null)} onAdded={onAdded} onChatGPT={() => setDialog("chatgpt")} />
      )}
      {dialog === "chatgpt" && <ChatGPTSignInDialog onClose={() => setDialog(null)} onConnected={onAdded} />}
    </>
  );
}
