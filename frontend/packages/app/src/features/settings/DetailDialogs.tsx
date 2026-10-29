import { profileKeySchema, profileValueSchema, type ProfileVisibility } from "@agent-desktop/client";
import { Button, Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, FormField, Input, SegmentedControl, Textarea } from "@agent-desktop/ui";
import { useState } from "react";
import { errorCode } from "../../data/model-providers";

export const VISIBILITY_HELP =
  "Only me: your agents use it only when working just for you. Shared: also when they serve other people (group chats, Slack).";

/** The one private/shared control every entry uses. */
export function VisibilityField({ value, onChange }: { value: ProfileVisibility | undefined; onChange: (value: ProfileVisibility) => void }) {
  return (
    <FormField label="Who can use this" description={VISIBILITY_HELP} raw>
      <SegmentedControl
        fill
        aria-label="Who can use this"
        value={value ?? "private"}
        onValueChange={(next) => onChange(next === "shared" ? "shared" : "private")}
        items={[
          { value: "private", label: "Only me" },
          { value: "shared", label: "Shared" },
        ]}
      />
    </FormField>
  );
}

export interface EntryDraft {
  key: string;
  value: string;
  visibility: ProfileVisibility;
}

/** Add or edit one detail. `onSave` rejects with the server error, which the dialog shows. */
export function EntryDialog({
  entry,
  onSave,
  onClose,
}: {
  entry: EntryDraft | undefined;
  onSave: (draft: EntryDraft) => Promise<unknown>;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState<EntryDraft>(entry ?? { key: "", value: "", visibility: "private" });
  const [errors, setErrors] = useState<{ key?: string; value?: string }>({});
  const [failure, setFailure] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const submit = async () => {
    const key = profileKeySchema.safeParse(draft.key);
    const value = profileValueSchema.safeParse(draft.value);
    if (!key.success || !value.success) {
      setErrors({
        ...(key.success ? {} : { key: draft.key.trim() === "" ? "Required" : "Use 60 characters or fewer" }),
        ...(value.success ? {} : { value: draft.value.trim() === "" ? "Required" : "Use 2000 characters or fewer" }),
      });
      return;
    }
    setErrors({});
    setFailure(null);
    setPending(true);
    try {
      await onSave({ key: key.data, value: value.data, visibility: draft.visibility });
      onClose();
    } catch (error) {
      setFailure(errorCode(error).message ?? "Could not save. Try again.");
      setPending(false);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{entry ? "Edit detail" : "Add detail"}</DialogTitle>
        </DialogHeader>
        <form
          className="flex max-h-[70vh] min-w-0 flex-col gap-4 overflow-y-auto scrollbar-thin p-0.5"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <FormField label="Name" required error={errors.key}>
            <Input
              value={draft.key}
              maxLength={60}
              placeholder="Work email, Home address, KrisFlyer number…"
              autoFocus={!entry}
              onChange={(event) => setDraft({ ...draft, key: event.currentTarget.value })}
            />
          </FormField>
          <FormField label="Value" required error={errors.value}>
            <Textarea
              value={draft.value}
              rows={4}
              maxLength={2000}
              placeholder="An address can span several lines"
              onChange={(event) => setDraft({ ...draft, value: event.currentTarget.value })}
            />
          </FormField>
          <VisibilityField value={draft.visibility} onChange={(visibility) => setDraft({ ...draft, visibility })} />
          {failure && (
            <p role="alert" className="text-sm text-danger">
              {failure}
            </p>
          )}
          <DialogFooter>
            <Button variant="ghost" type="button" onClick={onClose}>
              Cancel
            </Button>
            <Button variant="primary" type="submit" disabled={pending}>
              {pending ? "Saving…" : "Save"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
