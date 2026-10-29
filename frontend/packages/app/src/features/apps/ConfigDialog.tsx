import type { App, InstallAppResponse } from "@agent-desktop/client";
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
  SecretField,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Switch,
} from "@agent-desktop/ui";
import { useState } from "react";
import { BrandIcon } from "../../components/BrandIcon";
import { useInstallApp } from "../../data/apps";
import { t } from "../../lib/i18n";
import { userConfigValues } from "../../lib/apps";

export interface ConfigDialogProps {
  app: Pick<App, "id" | "name" | "icon" | "blurb" | "userConfig">;
  /** Sign in again to this account (or replace its values) instead of adding another. */
  connectionId?: string;
  onClose: () => void;
  onDone: (response: InstallAppResponse) => void;
}

/**
 * The values an app asks for when it is added (an API key, a workspace URL), generated from its `userConfig`: a secret is a
 * write-only secure field, an option list is a menu, a flag is a switch. The server's answer (a missing or invalid value) shows
 * under the form.
 */
export function ConfigDialog({ app, connectionId, onClose, onDone }: ConfigDialogProps) {
  const install = useInstallApp();
  const [draft, setDraft] = useState<Record<string, string | boolean>>({});
  const [error, setError] = useState<string | null>(null);
  const { values, missing } = userConfigValues(app.userConfig, draft);

  const submit = () => {
    setError(null);
    install.mutate(
      { appId: app.id, input: { userConfig: values, ...(connectionId ? { connectionId } : {}) } },
      {
        onSuccess: onDone,
        onError: (e) => setError(e instanceof Error && e.message ? e.message : t("apps.addFailed")),
      },
    );
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <div className="flex items-center gap-3">
            <BrandIcon id={app.id} symbol={app.icon} className="size-10" />
            <div className="min-w-0">
              <DialogTitle>{t("apps.connectTo", { name: app.name })}</DialogTitle>
              <DialogDescription>{app.blurb}</DialogDescription>
            </div>
          </div>
        </DialogHeader>
        <form
          className="space-y-3"
          onSubmit={(event) => {
            event.preventDefault();
            if (missing === null && !install.isPending) submit();
          }}
        >
          {app.userConfig.map((field) => {
            const label = field.required ? field.title : `${field.title} (${t("apps.optional")})`;
            const value = draft[field.key];
            const set = (next: string | boolean) => setDraft((current) => ({ ...current, [field.key]: next }));
            if (field.sensitive) {
              return (
                <div key={field.key} className="space-y-1">
                  <SecretField label={label} value={typeof value === "string" ? value : ""} onChange={set} />
                  {field.description ? <p className="text-xs text-fg-muted">{field.description}</p> : null}
                </div>
              );
            }
            if (field.type === "boolean") {
              return (
                <FormField key={field.key} label={label} description={field.description}>
                  <Switch aria-label={field.title} checked={value === true || (value === undefined && field.default === true)} onCheckedChange={set} />
                </FormField>
              );
            }
            if (field.options && field.options.length > 0) {
              return (
                <FormField key={field.key} label={label} description={field.description}>
                  <Select value={typeof value === "string" ? value : String(field.default ?? "")} onValueChange={set}>
                    <SelectTrigger aria-label={field.title}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {field.options.map((option) => (
                        <SelectItem key={option} value={option}>
                          {option}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </FormField>
              );
            }
            return (
              <FormField key={field.key} label={label} description={field.description}>
                <Input
                  type={field.type === "number" ? "number" : "text"}
                  autoComplete="off"
                  value={typeof value === "string" ? value : String(field.default ?? "")}
                  onChange={(event) => set(event.target.value)}
                />
              </FormField>
            );
          })}
          {error ? (
            <p role="alert" className="text-sm text-danger">
              {error}
            </p>
          ) : null}
          <DialogFooter>
            <Button type="button" variant="ghost" size="sm" onClick={onClose}>
              {t("common.cancel")}
            </Button>
            <Button type="submit" variant="primary" size="sm" disabled={install.isPending || missing !== null}>
              {t("apps.connect")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
