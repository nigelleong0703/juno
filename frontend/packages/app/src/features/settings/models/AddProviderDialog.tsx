import {
  createModelProviderInputSchema,
  type BuiltinModelProvider,
  type CreateModelProviderInput,
  type CustomModelWire,
  type ModelProvider,
} from "@agent-desktop/client";
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  FormField,
  Input,
  ListRow,
  SearchField,
  SecretField,
  SegmentedControl,
} from "@agent-desktop/ui";
import { ChevronRight, Server, ShieldCheck } from "lucide-react";
import { useState } from "react";
import { useCreateProvider } from "../../../data/model-providers";
import { useBuiltinProviders } from "../../../data/queries";
import { t } from "../../../lib/i18n";
import { providerErrorMessage } from "./errors";

/** Shown first; the other built-ins sit behind search or "show all" (OpenCode /connect, Raycast). */
const POPULAR = ["openai", "anthropic", "openrouter", "google", "deepseek", "opencode-go"];

type Step = { kind: "pick" } | { kind: "key"; builtin: BuiltinModelProvider } | { kind: "custom" } | { kind: "systemone" };

export function AddProviderDialog({
  onClose,
  onAdded,
  onChatGPT,
  firstRun = false,
}: {
  onClose: () => void;
  onAdded: (provider: ModelProvider) => void;
  onChatGPT: () => void;
  /** First-run gate: popular providers first; the custom endpoint rows wait behind "Show all". */
  firstRun?: boolean;
}) {
  const [step, setStep] = useState<Step>({ kind: "pick" });
  const title =
    step.kind === "key"
      ? t("models.keyTitle", { name: step.builtin.name })
      : step.kind === "custom"
        ? t("models.customTitle")
        : step.kind === "systemone"
          ? t("models.systemOneTitle")
          : t("models.addTitle");
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {step.kind === "pick" && <DialogDescription>{t("models.providersHint")}</DialogDescription>}
        </DialogHeader>
        {step.kind === "pick" ? (
          <ProviderPicker
            firstRun={firstRun}
            onBuiltin={(builtin) => setStep({ kind: "key", builtin })}
            onCustom={() => setStep({ kind: "custom" })}
            onSystemOne={() => setStep({ kind: "systemone" })}
          />
        ) : (
          <ProviderForm
            builtin={step.kind === "key" ? step.builtin : undefined}
            systemOne={step.kind === "systemone"}
            onBack={() => setStep({ kind: "pick" })}
            onAdded={(provider) => {
              onAdded(provider);
              onClose();
            }}
            onChatGPT={onChatGPT}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

function ProviderPicker({
  firstRun,
  onBuiltin,
  onCustom,
  onSystemOne,
}: {
  firstRun: boolean;
  onBuiltin: (provider: BuiltinModelProvider) => void;
  onCustom: () => void;
  onSystemOne: () => void;
}) {
  const builtin = useBuiltinProviders();
  const [query, setQuery] = useState("");
  const [showAll, setShowAll] = useState(false);
  const all = builtin.data ?? [];
  const needle = query.trim().toLowerCase();
  const popular = POPULAR.flatMap((id) => all.find((row) => row.id === id) ?? []);
  const rest = all.filter((row) => !popular.includes(row));
  const visible =
    needle !== ""
      ? all.filter((row) => row.name.toLowerCase().includes(needle) || row.id.includes(needle))
      : showAll || popular.length === 0
        ? [...popular, ...rest]
        : popular;
  return (
    <div className="flex min-w-0 flex-col gap-3">
      {(!firstRun || showAll || needle !== "") && <>
      <ListRow
        leading={<Server className="size-4 text-fg-muted" />}
        title={t("models.custom")}
        description={t("models.customHint")}
        trailing={<ChevronRight className="size-4 text-fg-subtle" />}
        onClick={onCustom}
      />
      <ListRow
        leading={<ShieldCheck className="size-4 text-fg-muted" />}
        title={t("models.systemOne")}
        description={t("models.systemOneHint")}
        trailing={<ChevronRight className="size-4 text-fg-subtle" />}
        onClick={onSystemOne}
      />
      </>}
      <SearchField
        value={query}
        onValueChange={setQuery}
        placeholder={t("models.searchProviders")}
      />
      {builtin.isLoading ? (
        <p className="text-sm text-fg-muted">{t("common.loading")}</p>
      ) : builtin.isError ? (
        <button type="button" className="text-left text-sm text-fg-muted underline" onClick={() => void builtin.refetch()}>
          {t("common.error")} · {t("common.retry")}
        </button>
      ) : (
        <div className="max-h-64 overflow-y-auto scrollbar-thin">
          {visible.length === 0 && <p className="px-2 py-2 text-sm text-fg-muted">{t("models.noMatch")}</p>}
          {visible.map((row) => (
            <ListRow
              key={row.id}
              dense
              title={row.name}
              meta={t("models.modelCount", { count: row.modelCount })}
              onClick={() => onBuiltin(row)}
            />
          ))}
          {needle === "" && !showAll && rest.length > 0 && popular.length > 0 && (
            <Button variant="ghost" size="sm" className="mt-1" onClick={() => setShowAll(true)}>
              {t("models.showAllProviders", { count: all.length })}
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

/** Step two: the key for a built-in provider, or name + endpoint + protocol + key for a custom one. */
function ProviderForm({
  builtin,
  systemOne,
  onBack,
  onAdded,
  onChatGPT,
}: {
  builtin?: BuiltinModelProvider;
  systemOne: boolean;
  onBack: () => void;
  onAdded: (provider: ModelProvider) => void;
  onChatGPT: () => void;
}) {
  const create = useCreateProvider();
  const [name, setName] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [wire, setWire] = useState<CustomModelWire>("openai-completions");
  const [modelIds, setModelIds] = useState("");
  const [apiKey, setApiKey] = useState("");
  const input: CreateModelProviderInput = builtin
    ? { kind: "builtin", providerId: builtin.id, apiKey }
    : systemOne
      ? { kind: "systemone", name, baseUrl, models: modelIds.split(",").map((id) => id.trim()).filter(Boolean), apiKey }
      : { kind: "custom", name, baseUrl, wire, apiKey };
  const parsed = createModelProviderInputSchema.safeParse(input);
  const urlInvalid =
    builtin === undefined &&
    baseUrl.trim() !== "" &&
    !parsed.success &&
    parsed.error.issues.some((issue) => issue.path[0] === "baseUrl");

  const submit = () => {
    if (!parsed.success) return;
    create.mutate(parsed.data, {
      onSuccess: (provider) => {
        setApiKey("");
        onAdded(provider);
      },
    });
  };

  return (
    <form
      className="flex min-w-0 flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      {builtin === undefined && (
        <>
          <FormField label={t("models.name")}>
            <Input autoFocus value={name} maxLength={80} onChange={(event) => setName(event.currentTarget.value)} />
          </FormField>
          <FormField
            label={t("models.baseUrl")}
            description={systemOne ? undefined : t("models.baseUrlHint")}
            error={urlInvalid ? t("models.baseUrlInvalid") : undefined}
          >
            <Input
              value={baseUrl}
              placeholder={systemOne ? "https://api.typesafe.ai" : "https://api.example.com/v1"}
              spellCheck={false}
              onChange={(event) => setBaseUrl(event.currentTarget.value)}
            />
          </FormField>
          {systemOne ? (
            <FormField label={t("models.systemOneModels")} description={t("models.systemOneModelsHint")}>
              <Input value={modelIds} placeholder="jev-latest" spellCheck={false} onChange={(event) => setModelIds(event.currentTarget.value)} />
            </FormField>
          ) : (
            <FormField label={t("models.protocol")} raw>
              <SegmentedControl
                fill
                aria-label={t("models.protocol")}
                value={wire}
                onValueChange={(value) => setWire(value === "openai-responses" ? "openai-responses" : "openai-completions")}
                items={[
                  { value: "openai-completions", label: t("models.protocol.completions") },
                  { value: "openai-responses", label: t("models.protocol.responses") },
                ]}
              />
            </FormField>
          )}
        </>
      )}
      <div className="flex flex-col gap-1.5">
        <SecretField label={t("models.apiKey")} value={apiKey} onChange={setApiKey} />
        <p className="text-xs text-fg-subtle">{t("models.apiKeyHint")}</p>
      </div>
      {builtin?.id === "openai" && (
        <div className="flex items-center justify-between gap-3 rounded-md bg-bg-subtle px-2.5 py-2">
          <span className="text-xs text-fg-muted">{t("models.useChatGPTHint")}</span>
          <Button variant="secondary" size="sm" type="button" onClick={onChatGPT}>
            {t("models.useChatGPT")}
          </Button>
        </div>
      )}
      {create.isError && (
        <p role="alert" className="text-sm text-danger">
          {providerErrorMessage(create.error)}
        </p>
      )}
      <DialogFooter>
        <Button variant="ghost" type="button" onClick={onBack}>
          {t("models.back")}
        </Button>
        <Button variant="primary" type="submit" disabled={!parsed.success || create.isPending}>
          {t("models.connect")}
        </Button>
      </DialogFooter>
    </form>
  );
}
