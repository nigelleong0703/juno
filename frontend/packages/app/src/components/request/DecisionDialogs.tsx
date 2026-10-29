import type { DelegationDraft, ResolveRequestInput } from "@agent-desktop/client";
import { Button, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, Textarea } from "@agent-desktop/ui";
import { useState } from "react";
import { useApps } from "../../data/apps";
import { t } from "../../lib/i18n";
import { categoryLabel, delegationKey, isDelegableCategory, platformOfKey, sharingOffer } from "./decision";
import { LimitsFields, limitsValid } from "./LimitsFields";
import { useChatName } from "./useChatName";

/** "Change it…": a note that goes back to the agent with the refusal, so it tries again differently. */
export function ChangeItDialog({ open, agentName, disabled, onOpenChange, onSend }: { open: boolean; agentName: string; disabled: boolean; onOpenChange: (open: boolean) => void; onSend: (decision: ResolveRequestInput) => void }) {
  const [note, setNote] = useState("");
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t("decision.change.title")}</DialogTitle>
          <DialogDescription>{t("decision.change.guidance", { agent: agentName })}</DialogDescription>
        </DialogHeader>
        <Textarea value={note} onChange={(event) => setNote(event.currentTarget.value)} placeholder={t("decision.change.placeholder")} aria-label={t("decision.change.title")} className="min-h-24" />
        <DialogFooter>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            {t("common.cancel")}
          </Button>
          <Button disabled={disabled || note.trim() === ""} onClick={() => onSend({ action: "deny", reason: "revise", note: note.trim() })}>
            {t("decision.change.send")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** "Allow this kind…": the limits the server suggested, editable; confirming allows this one and creates the rules. */
export function AllowKindDialog({
  open,
  agentName,
  suggested,
  disabled,
  onOpenChange,
  onConfirm,
}: {
  open: boolean;
  agentName: string;
  suggested: DelegationDraft[];
  disabled: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: (delegations: DelegationDraft[]) => void;
}) {
  const { data: connectors } = useApps();
  const chatName = useChatName();
  const [drafts, setDrafts] = useState(suggested);
  const valid = drafts.every((draft) => !isDelegableCategory(draft.category) || limitsValid(draft.category, draft.limits));
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t("decision.kind.title")}</DialogTitle>
          <DialogDescription>{t("decision.kind.guidance", { agent: agentName })}</DialogDescription>
        </DialogHeader>
        {drafts.map((draft, index) =>
          isDelegableCategory(draft.category) ? (
            <section key={`${draft.category}-${delegationKey(draft.platform)}`} className="flex flex-col gap-3">
              <h4 className="text-sm font-semibold text-fg">
                {draft.category === "sharing"
                  ? sharingOffer(draft, chatName)
                  : t("decision.kind.onPlatform", { category: categoryLabel(draft.category), platform: platformOfKey(delegationKey(draft.platform), connectors).name })}
              </h4>
              <LimitsFields category={draft.category} limits={draft.limits} onChange={(limits) => setDrafts((all) => all.map((entry, at) => (at === index ? { ...entry, limits } : entry)))} />
            </section>
          ) : null,
        )}
        <DialogFooter>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            {t("common.cancel")}
          </Button>
          <Button disabled={disabled || !valid} onClick={() => onConfirm(drafts)}>
            {t("decision.kind.confirm")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
