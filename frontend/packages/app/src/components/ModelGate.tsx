import type { Agent, ModelProvider } from "@agent-desktop/client";
import { Button, Combobox } from "@agent-desktop/ui";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { qk } from "../data/keys";
import { openAppConversation } from "../App";
import { useAuthIdentity } from "../auth/AuthContext";
import { useClient, usePlatform } from "../data/ClientProvider";
import { useUpdateSettings } from "../data/mutations";
import { errorCode } from "../data/model-providers";
import { useAgents, useConversations, useModelProviders, useProviderModels } from "../data/queries";
import { AddProviderDialog } from "../features/settings/models/AddProviderDialog";
import { ChatGPTSignInDialog } from "../features/settings/models/ChatGPTSignInDialog";
import { providerErrorMessage } from "../features/settings/models/errors";
import { useUiStore } from "../store/ui";
import { DragStrip } from "./DragStrip";
import { SCREEN_TITLE } from "./onboarding/Onboarding";
import { CHARACTER_TINT, agentCharacter } from "../lib/avatars";
import { AgentAvatar } from "./agent/AgentAvatar";
import { t } from "../lib/i18n";

/**
 * First-run gate: an account with no usable model (agents only run on the owner's own provider) sees this instead
 * of the app, with no way to dismiss it: first connect a provider, then choose its model. Once a model is chosen
 * it opens the default agent's chat.
 */
export function ModelGate({ children }: { children: ReactNode }) {
  const client = useClient();
  const platform = usePlatform();
  const providers = useModelProviders();
  const gated = providers.data?.usable === false;
  const wasGated = useRef(false);
  useEffect(() => {
    if (gated) { wasGated.current = true; return; }
    if (!wasGated.current || providers.data?.usable !== true) return;
    wasGated.current = false;
    void client.conversations.list().then((page) => {
      const direct = page.items.find((c) => c.kind === "direct");
      if (direct) openAppConversation(direct.id);
    }, () => { /* the index still works */ });
  }, [gated, providers.data?.usable, client]);
  // The gate is a full-window screen: the desktop shell hides its top row (and sidebar toggle) while it shows.
  const setOpen = useUiStore((state) => state.setModelGateOpen);
  useEffect(() => { setOpen(gated); return () => setOpen(false); }, [gated, setOpen]);
  return gated ? <>{platform.isDesktop ? <DragStrip /> : null}<ConnectModel /></> : <>{children}</>;
}

/** The gate fills its parent: the window on web, the desktop shell's content area (below its top row) on the desktop. */
const gateMain = (desktop: boolean) =>
  `flex w-full flex-1 flex-col items-center bg-background px-6 py-8 text-fg${desktop ? " min-h-0" : " min-h-screen"}`;

/** The agent large on its soft character wash, like the onboarding pages. */
function GateHero({ agent }: { agent: Agent }) {
  return (
    <div className="relative flex h-[200px] w-full items-center justify-center" aria-hidden>
      <div className="onb-wash" style={{ "--wash": CHARACTER_TINT[agentCharacter(agent.id, agent.avatar)] } as CSSProperties} />
      <div className="onb-bob"><AgentAvatar agentId={agent.id} avatar={agent.avatar} size={112} /></div>
    </div>
  );
}

function ConnectModel() {
  const platform = usePlatform();
  const [dialog, setDialog] = useState<"key" | "chatgpt" | null>(null);
  const identity = useAuthIdentity();
  const direct = useConversations().data?.find((c) => c.kind === "direct");
  const agent = useAgents().data?.find((a) => a.id === direct?.agentIds[0]);
  const app = t("app.name");
  const keyed = useModelProviders().data?.providers.filter((row) => row.hasKey && row.kind !== "systemone") ?? [];
  if (keyed.length > 0) return <ChooseModel providers={keyed} agentName={agent?.name} avatar={agent && <GateHero agent={agent} />} />;
  return (
    <main className={gateMain(platform.isDesktop)}>
      <div className="flex w-full max-w-[560px] flex-1 flex-col items-center justify-center gap-3 text-center">
        {agent && <GateHero agent={agent} />}
        <h1 className={`${SCREEN_TITLE} text-balance`}>{t("models.gate.title", { name: agent?.name ?? "your agent" })}</h1>
        <p className="max-w-[420px] text-balance text-base leading-relaxed text-fg-muted">{t("models.gate.body", { app })}</p>
        <div className="mt-5 flex w-full max-w-[360px] flex-col gap-2">
          <Button variant="primary" size="lg" className="w-full" onClick={() => setDialog("chatgpt")}>{t("models.gate.chatgpt")}</Button>
          <Button variant="secondary" size="lg" className="w-full" onClick={() => setDialog("key")}>{t("models.gate.apiKey")}</Button>
        </div>
      </div>
      {identity?.mode === "account" && (
        <Button variant="ghost" size="sm" onClick={identity.signOut}>{t("models.gate.logOut")}</Button>
      )}
      {dialog === "key" && (
        <AddProviderDialog firstRun onClose={() => setDialog(null)} onAdded={() => {}} onChatGPT={() => setDialog("chatgpt")} />
      )}
      {dialog === "chatgpt" && <ChatGPTSignInDialog onClose={() => setDialog(null)} onConnected={() => {}} />}
    </main>
  );
}

const SHOWN_MODELS = 5;

/** Step two of the gate: a provider is connected, now pick the model the agents run on. */
function ChooseModel({ providers, agentName, avatar }: { providers: ModelProvider[]; agentName?: string; avatar: ReactNode }) {
  const platform = usePlatform();
  const identity = useAuthIdentity();
  const qc = useQueryClient();
  const save = useUpdateSettings();
  const [providerId, setProviderId] = useState(providers[0]?.id ?? "");
  const [picked, setPicked] = useState<string | null>(null);
  const [all, setAll] = useState(false);
  const catalog = useProviderModels(providerId);
  const items = catalog.data?.items ?? [];
  // Nothing is preselected: the owner picks the model. A pick from the full list stays visible at the top.
  const modelId = picked ?? "";
  const head = picked ? [picked] : [];
  const rows = [
    ...head.flatMap((id) => items.filter((item) => item.id === id)),
    ...items.filter((item) => !head.includes(item.id)),
  ].slice(0, SHOWN_MODELS);
  const onContinue = () =>
    save.mutate(
      { models: { providerId, defaultModel: modelId } },
      { onSuccess: () => void qc.invalidateQueries({ queryKey: qk.modelProviders() }) },
    );
  const saveError = save.isError ? (errorCode(save.error).code === "UNKNOWN_PROVIDER" ? providerErrorMessage(save.error) : t("common.error")) : null;
  return (
    <main className={gateMain(platform.isDesktop)}>
      <div className="flex w-full max-w-[560px] flex-1 flex-col items-center justify-center gap-3 text-center">
        {avatar}
        <h1 className={`${SCREEN_TITLE} text-balance`}>{t("models.gate.pickTitle", { name: agentName ?? "your agent" })}</h1>
        <p className="max-w-[420px] text-balance text-base leading-relaxed text-fg-muted">{t("models.gate.pickBody")}</p>
        <div className="mt-5 flex w-full max-w-[360px] flex-col gap-2 text-left">
          {providers.length > 1 && (
            <select
              aria-label={t("models.default.provider")}
              className="h-9 rounded-md border border-border bg-background px-2 text-sm"
              disabled={save.isPending}
              value={providerId}
              onChange={(event) => { setProviderId(event.currentTarget.value); setPicked(null); setAll(false); }}
            >
              {providers.map((row) => <option key={row.id} value={row.id}>{row.name}</option>)}
            </select>
          )}
          {catalog.isLoading ? (
            <p className="py-4 text-center text-sm text-fg-muted">{t("models.default.loadingModels")}</p>
          ) : catalog.isError ? (
            <p className="flex items-center justify-center gap-2 py-4 text-sm text-fg-muted">
              {errorCode(catalog.error).code === "MODEL_CATALOG_UNAVAILABLE" ? t("models.default.catalogDown") : t("common.error")}
              <Button variant="ghost" size="sm" onClick={() => void catalog.refetch()}>{t("common.retry")}</Button>
            </p>
          ) : all ? (
            <Combobox
              options={items.map((item) => ({ value: item.id, label: item.name, description: item.supportsImages ? t("models.default.images") : undefined }))}
              value={modelId}
              onValueChange={(value) => { setPicked(value); setAll(false); }}
              placeholder={t("models.default.chooseModel")}
              searchPlaceholder={t("models.default.searchModels")}
              emptyMessage={t("models.default.noModels")}
            />
          ) : (
            <>
              {rows.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  disabled={save.isPending}
                  onClick={() => setPicked(item.id)}
                  className={`flex items-center justify-between rounded-md border px-3 py-2 text-left text-sm ${item.id === modelId ? "border-fg bg-muted" : "border-border"}`}
                >
                  <span className="min-w-0">
                    <span className="block truncate">{item.name}</span>
                    {item.supportsImages && <span className="block text-xs text-fg-muted">{t("models.default.images")}</span>}
                  </span>
                  <span className="ml-2 flex shrink-0 items-center gap-2 text-xs text-fg-muted">
                    {item.id === modelId && <span aria-hidden>✓</span>}
                  </span>
                </button>
              ))}
              {items.length > rows.length && (
                <Button variant="ghost" size="sm" onClick={() => setAll(true)}>{t("models.gate.showAll")}</Button>
              )}
            </>
          )}
          {saveError && <p className="text-sm text-danger">{saveError}</p>}
          <Button variant="primary" size="lg" className="mt-2 w-full" disabled={modelId === "" || save.isPending} onClick={onContinue}>
            {t("models.gate.continue")}
          </Button>
        </div>
      </div>
      {identity?.mode === "account" && (
        <Button variant="ghost" size="sm" onClick={identity.signOut}>{t("models.gate.logOut")}</Button>
      )}
    </main>
  );
}
