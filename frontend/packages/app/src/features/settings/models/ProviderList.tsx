import type { ModelProvider } from "@agent-desktop/client";
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  IconButton,
  ListRow,
  RelativeTime,
  SearchField,
  StatusPill,
} from "@agent-desktop/ui";
import { MoreHorizontal } from "lucide-react";
import { useState } from "react";
import { useBuiltinProviders } from "../../../data/queries";
import { t } from "../../../lib/i18n";
import { EditProviderDialog, RemoveProviderDialog } from "./ProviderDialogs";

/** Visible rows before "Show N more", and the size past which a filter field appears. */
const VISIBLE_ROWS = 5;
const FILTER_FROM = 6;

type Action = { kind: "key" | "rename" | "remove"; provider: ModelProvider };

function hostOf(baseUrl: string | undefined): string {
  try {
    return new URL(baseUrl ?? "").host;
  } catch {
    return baseUrl ?? "";
  }
}

export function ProviderList({
  providers,
  defaultProviderId,
  onSignInAgain,
}: {
  providers: ModelProvider[];
  defaultProviderId: string | null | undefined;
  onSignInAgain: () => void;
}) {
  const builtin = useBuiltinProviders();
  const [filter, setFilter] = useState("");
  const [expanded, setExpanded] = useState(false);
  const [action, setAction] = useState<Action | null>(null);
  const needle = filter.trim().toLowerCase();
  const matches = needle === "" ? providers : providers.filter((row) => row.name.toLowerCase().includes(needle));
  const shown = expanded ? matches : matches.slice(0, VISIBLE_ROWS);

  const typeLine = (provider: ModelProvider): string => {
    if (provider.auth === "chatgpt") return t("models.type.chatgpt");
    if (provider.kind === "systemone") {
      return t("models.type.systemOne", { host: hostOf(provider.baseUrl), count: provider.models?.length ?? 0 });
    }
    if (provider.kind === "custom") return t("models.type.custom", { host: hostOf(provider.baseUrl) });
    const catalog = builtin.data?.find((row) => row.id === provider.providerId)?.name ?? provider.providerId ?? "";
    return `${catalog} · ${t("models.type.apiKey")}`;
  };

  return (
    <div className="space-y-1">
      {providers.length >= FILTER_FROM && (
        <SearchField size="sm" value={filter} onValueChange={setFilter} placeholder={t("models.filter")} className="px-1 pb-1" />
      )}
      {matches.length === 0 && <p className="px-2.5 py-2 text-sm text-fg-muted">{t("models.noMatch")}</p>}
      {shown.map((provider) => (
        <ListRow
          key={provider.id}
          title={provider.name}
          description={
            <>
              {typeLine(provider)}
              {provider.auth === "chatgpt" ? (
                provider.accessExpiresAt && (
                  <>
                    {" · "}
                    {t("models.accessExpires")} <RelativeTime date={provider.accessExpiresAt} />
                  </>
                )
              ) : (
                <> · {provider.hasKey ? t("models.keySaved") : t("models.noKey")}</>
              )}
            </>
          }
          meta={
            provider.auth === "chatgpt" ? (
              provider.status === "reauth_required" ? (
                <StatusPill size="sm" tone="warning" label={t("models.reauth")} />
              ) : (
                <StatusPill size="sm" tone="success" label={t("models.connected")} />
              )
            ) : undefined
          }
          trailing={
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <IconButton label={t("models.actions", { name: provider.name })} size="sm">
                  <MoreHorizontal className="size-4" />
                </IconButton>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {provider.auth === "chatgpt" ? (
                  <DropdownMenuItem onSelect={onSignInAgain}>{t("models.signInAgain")}</DropdownMenuItem>
                ) : (
                  <DropdownMenuItem onSelect={() => setAction({ kind: "key", provider })}>
                    {t("models.replaceKey")}
                  </DropdownMenuItem>
                )}
                <DropdownMenuItem onSelect={() => setAction({ kind: "rename", provider })}>{t("models.rename")}</DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem variant="destructive" onSelect={() => setAction({ kind: "remove", provider })}>
                  {t("models.remove")}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          }
        />
      ))}
      {matches.length > VISIBLE_ROWS && (
        <Button variant="ghost" size="sm" onClick={() => setExpanded((open) => !open)}>
          {expanded ? t("models.showLess") : t("models.showMore", { count: matches.length - VISIBLE_ROWS })}
        </Button>
      )}
      {action && action.kind !== "remove" && (
        <EditProviderDialog provider={action.provider} mode={action.kind} onClose={() => setAction(null)} />
      )}
      {action?.kind === "remove" && (
        <RemoveProviderDialog
          provider={action.provider}
          isDefault={action.provider.id === defaultProviderId}
          onClose={() => setAction(null)}
        />
      )}
    </div>
  );
}
