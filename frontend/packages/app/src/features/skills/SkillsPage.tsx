import type { CreateSkillInput, Skill } from "@agent-desktop/client";
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  EmptyState,
  ErrorState,
  Input,
  LoadingState,
  PageHeader,
  ScrollArea,
  SearchField,
  StatusPill,
  Textarea,
  toast,
} from "@agent-desktop/ui";
import { PenLine, Plus } from "lucide-react";
import { useMemo, useState } from "react";
import { AgentAvatar } from "../../components/agent/AgentAvatar";
import { useCreateSkill } from "../../data/skills";
import { useAgents, useSkillsPage } from "../../data/queries";
import { t } from "../../lib/i18n";
import { SkillAgentAssignment } from "./SkillAgentAssignment";
import { SkillDetailSheet, Field } from "./SkillDetailSheet";
import { needsReview, skillDescription, skillName } from "./skillModel";

/**
 * Skills (§4.9): packaged instructions an agent can load — written by hand. A row opens the skill's detail (its version,
 * history and rollback). A secondary page (修订 v0.3).
 */
export function SkillsPage() {
  const [query, setQuery] = useState("");
  const [creating, setCreating] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);

  const { data, isLoading, isError, refetch, hasNextPage, fetchNextPage, isFetchingNextPage } = useSkillsPage();
  const skills = useMemo(() => data?.pages.flatMap((page) => page.items) ?? [], [data]);
  const { data: agents } = useAgents();
  // The sheet reads the live row, so a save, turn-on or rollback shows up without reopening it.
  const opened = skills.find((skill) => skill.id === openId);

  const items = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return (skills ?? []).filter((skill) => {
      if (!needle) return true;
      return (
        skillName(skill).toLowerCase().includes(needle) ||
        skillDescription(skill).toLowerCase().includes(needle)
      );
    });
  }, [skills, query]);

  const agentsFor = (skill: Skill) =>
    (agents ?? []).filter((agent) => agent.skillIds.includes(skill.id));

  return (
    <div className="flex h-full min-h-0 flex-col bg-bg">
      <PageHeader
        title={t("skills.title")}
        subtitle={skills ? `${skills.length} skills` : undefined}
        actions={
          <Button variant="primary" size="sm" onClick={() => setCreating(true)}>
            <Plus className="size-3.5" />
            New skill
          </Button>
        }
      />

      <div className="mx-auto flex w-full max-w-4xl items-center gap-2 px-5 py-3">
        <SearchField
          className="w-72"
          size="sm"
          value={query}
          onValueChange={setQuery}
          placeholder="Search skills…"
        />
      </div>

      <ScrollArea className="min-h-0 flex-1">
        <div className="mx-auto w-full max-w-4xl px-5 pb-8">
          {isLoading ? (
            <LoadingState label={t("common.loading")} />
          ) : isError ? (
            <ErrorState title={t("common.error")} onRetry={() => void refetch()} />
          ) : items.length === 0 ? (
            <EmptyState
              title={t("skills.empty")}
              description={t("skills.emptyHint")}
              action={
                <Button variant="secondary" size="sm" onClick={() => setCreating(true)}>
                  New skill
                </Button>
              }
            />
          ) : (
            <ul>
              {items.map((skill) => {
                const users = agentsFor(skill);
                return (
                  <li
                    key={skill.id}
                    className="flex items-start gap-3 rounded-md px-2 py-3 transition-colors hover:bg-accent/40"
                  >
                    <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-md bg-bg-subtle text-fg-muted">
                      <PenLine className="size-3.5" />
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          className="truncate text-left text-sm font-medium text-fg hover:underline"
                          onClick={() => setOpenId(skill.id)}
                        >
                          {skillName(skill)}
                        </button>
                        {skill.active && <span className="shrink-0 text-xs text-fg-muted">v{skill.active.version}</span>}
                        {needsReview(skill) && <StatusPill tone="warning" size="sm" label="Needs review" />}
                      </div>
                      <p className="mt-0.5 line-clamp-2 text-sm text-fg-muted">{skillDescription(skill)}</p>
                    </div>
                    <div className="flex shrink-0 items-center gap-3">
                      <SkillAgentAssignment skill={skill} agents={agents ?? []} />
                      {users.length > 0 && (
                        <span className="flex items-center -space-x-1.5">
                          {users.slice(0, 3).map((agent) => (
                            <span
                              key={agent.id}
                              className="rounded-full ring-2 ring-bg"
                              title={agent.name}
                            >
                              <AgentAvatar agentId={agent.id} avatar={agent.avatar} size="xs" />
                            </span>
                          ))}
                        </span>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
          {hasNextPage && (
            <div className="flex justify-center py-4">
              <Button
                variant="secondary"
                size="sm"
                onClick={() => void fetchNextPage()}
                disabled={isFetchingNextPage}
              >
                {isFetchingNextPage ? "Loading…" : "Load more skills"}
              </Button>
            </div>
          )}
        </div>
      </ScrollArea>

      <SkillDetailSheet skill={opened} onClose={() => setOpenId(null)} />
      <NewSkillDialog open={creating} onOpenChange={setCreating} />
    </div>
  );
}

function NewSkillDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const create = useCreateSkill();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [instructions, setInstructions] = useState("");

  const reset = () => {
    setName("");
    setDescription("");
    setInstructions("");
    create.reset();
  };

  const canSubmit = name.trim().length > 0 && !create.isPending;

  const submit = () => {
    if (!canSubmit) return;
    const input: CreateSkillInput = {
      name: name.trim(),
      description: description.trim(),
      instructions: instructions.trim(),
      deps: [],
    };
    create.mutate(input, {
      onSuccess: () => {
        toast("Skill created", { description: `${input.name} is ready for your agents.` });
        reset();
        onOpenChange(false);
      },
    });
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) reset();
        onOpenChange(next);
      }}
    >
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>New skill</DialogTitle>
          <DialogDescription>
            A skill is a set of instructions an agent can load when a task calls for it.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <Field label="Name">
            <Input
              autoFocus
              value={name}
              onChange={(event) => setName(event.currentTarget.value)}
              placeholder="e.g. Weekly competitor scan"
            />
          </Field>
          <Field label="Description">
            <Input
              value={description}
              onChange={(event) => setDescription(event.currentTarget.value)}
              placeholder="One line your agents read before loading it"
            />
          </Field>
          <Field label="Instructions">
            <Textarea
              rows={5}
              value={instructions}
              onChange={(event) => setInstructions(event.currentTarget.value)}
              placeholder="What to do, in order. Mention anything that always needs a check."
            />
          </Field>
        </div>

        {create.isError && (
          <p role="alert" className="text-sm text-danger">
            {create.error instanceof Error ? create.error.message : "Could not create the skill."}
          </p>
        )}

        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
            {t("common.cancel")}
          </Button>
          <Button variant="primary" size="sm" disabled={!canSubmit} onClick={submit}>
            Create skill
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
