import type { Agent, UpdateAgentInput } from "@agent-desktop/client";
import { Button, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, FormField, Input } from "@agent-desktop/ui";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import type { FormEvent } from "react";
import { AgentAvatar } from "../../components/agent/AgentAvatar";
import { qk } from "../../data/keys";
import { useClient } from "../../data/ClientProvider";
import { agentCharacter } from "../../lib/avatars";
import { t } from "../../lib/i18n";
import { AvatarCharacterPicker } from "./AvatarCharacterPicker";

/**
 * The iPhone's "Edit agent" sheet (AgentEditSheet): a large avatar preview with the name, the character picker, Name and
 * an optional Role, saved together with one `agents.update` that carries only what changed. No optimistic cache write:
 * a failed save, or a server that strips the avatar, leaves the draft on screen and never shows a false success.
 */
function AgentProfileForm({ agent, readOnly, onDone }: { agent: Agent; readOnly: boolean; onDone: () => void }) {
  const client = useClient();
  const qc = useQueryClient();
  const baselineCharacter = agentCharacter(agent.id, agent.avatar);
  const [name, setName] = useState(agent.name);
  const [title, setTitle] = useState(agent.title);
  const [character, setCharacter] = useState(baselineCharacter);
  const [echoError, setEchoError] = useState(false);

  const trimmedName = name.trim();
  const dirty = trimmedName !== agent.name || title.trim() !== agent.title || character !== baselineCharacter;
  const nameError = trimmedName.length === 0 ? t("agentEdit.nameRequired") : undefined;

  const update = useMutation({
    mutationFn: async () => {
      const patch: UpdateAgentInput = {};
      if (trimmedName !== agent.name) patch.name = trimmedName;
      if (title.trim() !== agent.title) patch.title = title.trim();
      if (character !== baselineCharacter) patch.avatar = { ...agent.avatar, character };
      return { updated: await client.agents.update(agent.id, patch), patch };
    },
    onSuccess: ({ updated, patch }) => {
      if (patch.avatar && updated.avatar?.character !== patch.avatar.character) {
        setEchoError(true);
        return;
      }
      qc.setQueryData(qk.agent(agent.id), updated);
      onDone();
    },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: ["agent"] });
      void qc.invalidateQueries({ queryKey: ["agents"] });
    },
  });

  const canSave = !readOnly && dirty && nameError === undefined && !update.isPending;
  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canSave) return;
    setEchoError(false);
    update.mutate();
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-4">
      <div className="flex flex-col items-center gap-2">
        <AgentAvatar agentId={agent.id} avatar={{ ...agent.avatar, character }} size={96} />
        <p className="max-w-full truncate text-base font-semibold text-fg">{trimmedName || t("agentEdit.fallbackName")}</p>
      </div>
      <AvatarCharacterPicker value={character} onChange={setCharacter} disabled={readOnly || update.isPending} />
      <FormField label={t("agentEdit.name")} error={nameError}>
        <Input value={name} disabled={readOnly || update.isPending} onChange={(event) => setName(event.target.value)} />
      </FormField>
      <FormField label={t("agentEdit.role")} description={t("agentEdit.roleHint")}>
        <Input value={title} disabled={readOnly || update.isPending} onChange={(event) => setTitle(event.target.value)} />
      </FormField>
      {readOnly ? <p className="text-xs text-fg-muted">{t("agentEdit.readOnly")}</p> : null}
      {update.isError || echoError ? (
        <p role="alert" className="text-sm text-danger">
          {t("agentEdit.failed")}
        </p>
      ) : null}
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onDone}>
          {t("common.cancel")}
        </Button>
        <Button type="submit" disabled={!canSave}>
          {update.isPending ? t("agentEdit.saving") : t("common.save")}
        </Button>
      </DialogFooter>
    </form>
  );
}

/** The header pencil's dialog; the form mounts per open, so every open starts from the agent as it is now. */
export function AgentEditDialog({ agent, open, onOpenChange, readOnly }: { agent: Agent; open: boolean; onOpenChange: (open: boolean) => void; readOnly: boolean }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[calc(100vh-2rem)] overflow-y-auto sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t("agentCard.edit")}</DialogTitle>
          <DialogDescription className="sr-only">{t("agentEdit.description")}</DialogDescription>
        </DialogHeader>
        <AgentProfileForm agent={agent} readOnly={readOnly} onDone={() => onOpenChange(false)} />
      </DialogContent>
    </Dialog>
  );
}
