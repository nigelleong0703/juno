import type { ModelProvider } from "@agent-desktop/client";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
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
} from "@agent-desktop/ui";
import { useState } from "react";
import { useDeleteProvider, useUpdateProvider } from "../../../data/model-providers";
import { t } from "../../../lib/i18n";
import { providerErrorMessage } from "./errors";

/** Replace the saved key, or rename: one small form over `PATCH /model-providers/:id`. */
export function EditProviderDialog({
  provider,
  mode,
  onClose,
}: {
  provider: ModelProvider;
  mode: "key" | "rename";
  onClose: () => void;
}) {
  const update = useUpdateProvider();
  const [value, setValue] = useState(mode === "rename" ? provider.name : "");
  const trimmed = value.trim();
  const canSave = trimmed !== "" && (mode === "key" || trimmed !== provider.name) && !update.isPending;
  const submit = () => {
    if (!canSave) return;
    const patch = mode === "key" ? { apiKey: value } : { name: trimmed };
    update.mutate(
      { id: provider.id, patch },
      {
        onSuccess: () => {
          setValue("");
          onClose();
        },
      },
    );
  };
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            {mode === "key" ? t("models.replaceKeyTitle", { name: provider.name }) : t("models.renameTitle")}
          </DialogTitle>
          {mode === "key" && <DialogDescription>{t("models.replaceKeyHint")}</DialogDescription>}
        </DialogHeader>
        <form
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          {mode === "key" ? (
            <SecretField label={t("models.apiKey")} value={value} onChange={setValue} />
          ) : (
            <FormField label={t("models.name")}>
              <Input autoFocus maxLength={80} value={value} onChange={(event) => setValue(event.currentTarget.value)} />
            </FormField>
          )}
          {update.isError && (
            <p role="alert" className="text-sm text-danger">
              {providerErrorMessage(update.error)}
            </p>
          )}
          <DialogFooter>
            <Button variant="ghost" type="button" onClick={onClose}>
              {t("models.cancel")}
            </Button>
            <Button variant="primary" type="submit" disabled={!canSave}>
              {t("models.save")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function RemoveProviderDialog({
  provider,
  isDefault,
  onClose,
}: {
  provider: ModelProvider;
  isDefault: boolean;
  onClose: () => void;
}) {
  const remove = useDeleteProvider();
  return (
    <AlertDialog open onOpenChange={(open) => !open && onClose()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t("models.removeTitle", { name: provider.name })}</AlertDialogTitle>
          <AlertDialogDescription>
            {t("models.removeBody")} {isDefault ? t("models.removeDefault") : ""}
          </AlertDialogDescription>
        </AlertDialogHeader>
        {remove.isError && (
          <p role="alert" className="text-sm text-danger">
            {providerErrorMessage(remove.error)}
          </p>
        )}
        <AlertDialogFooter>
          <AlertDialogCancel>{t("models.cancel")}</AlertDialogCancel>
          <AlertDialogAction
            disabled={remove.isPending}
            onClick={(event) => {
              event.preventDefault();
              remove.mutate(provider.id, { onSuccess: onClose });
            }}
          >
            {t("models.removeConfirm")}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
