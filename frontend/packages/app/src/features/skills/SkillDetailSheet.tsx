import type { Skill, SkillVersion } from "@agent-desktop/client";
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
  Input,
  RelativeTime,
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  StatusPill,
  Textarea,
  toast,
  type StatusTone,
} from "@agent-desktop/ui";
import type { ReactNode } from "react";
import { useState } from "react";
import { useActivateSkillVersion, useRollbackSkill, useSkillVersions, useUpdateSkill } from "../../data/skills";
import { REVIEW_NOTICE, depsAsInput, errorCode, needsReview, skillDescription, skillName } from "./skillModel";

/** History rows shown before "Show all". */
const HISTORY_LIMIT = 5;

const STATUS: Record<SkillVersion["status"], { label: string; tone: StatusTone }> = {
  active: { label: "Active", tone: "success" },
  review: { label: "Needs review", tone: "warning" },
  candidate: { label: "Candidate", tone: "info" },
  retired: { label: "Earlier", tone: "neutral" },
};

/**
 * One skill's detail as a side sheet: its active version, the review notice when a tool it uses changed, an edit form that
 * saves a new version, the version history and rollback. Opened from a row on the Skills page.
 */
export function SkillDetailSheet({ skill, onClose }: { skill: Skill | undefined; onClose: () => void }) {
  return (
    <Sheet open={Boolean(skill)} onOpenChange={(open) => !open && onClose()}>
      <SheetContent side="right" className="w-full gap-0 overflow-y-auto sm:max-w-md">
        {skill && <SkillDetail key={skill.id} skill={skill} />}
      </SheetContent>
    </Sheet>
  );
}

function SkillDetail({ skill }: { skill: Skill }) {
  const active = skill.active;
  const [name, setName] = useState(active?.name ?? "");
  const [description, setDescription] = useState(active?.description ?? "");
  const [instructions, setInstructions] = useState(active?.instructions ?? "");
  const [showAll, setShowAll] = useState(false);
  const [confirmRollback, setConfirmRollback] = useState(false);

  const update = useUpdateSkill();
  const activate = useActivateSkillVersion();
  const rollback = useRollbackSkill();
  const versions = useSkillVersions(skill.id);
  const history = versions.data ?? [];
  const shownHistory = showAll ? history : history.slice(0, HISTORY_LIMIT);
  const review = needsReview(skill);
  const canSave = name.trim().length > 0 && instructions.trim().length > 0 && !update.isPending;

  const save = () => {
    if (!canSave) return;
    update.mutate(
      {
        id: skill.id,
        input: {
          name: name.trim(),
          description: description.trim(),
          instructions: instructions.trim(),
          // An edit replaces the deps it is sent with, so the current ones are written back as they are.
          deps: depsAsInput(active ?? null),
        },
      },
      {
        onSuccess: (saved) => {
          toast("Skill saved", { description: `${name.trim()} is now version ${saved.active?.version ?? ""}.` });
        },
      },
    );
  };

  const turnOn = () => {
    if (!active) return;
    activate.mutate(
      { id: skill.id, version: active.version },
      {
        onSuccess: () => toast("Skill turned on", { description: `${skillName(skill)} can be loaded again.` }),
        onError: () => toast.error("Could not turn the skill on."),
      },
    );
  };

  return (
    <>
      <SheetHeader className="border-b border-border">
        <div className="flex items-center gap-2">
          <SheetTitle className="truncate">{skillName(skill)}</SheetTitle>
          {active && <span className="shrink-0 text-xs text-fg-muted">v{active.version}</span>}
          {review && <StatusPill tone="warning" size="sm" label="Needs review" />}
        </div>
        <SheetDescription>{skillDescription(skill) || "No description yet."}</SheetDescription>
      </SheetHeader>

      <div className="flex flex-col gap-6 p-4">
        {review && active && (
          <div role="status" className="flex flex-col gap-2 rounded-md border border-warning/40 bg-warning/10 p-3">
            <p className="text-sm text-fg">{REVIEW_NOTICE}</p>
            <Button variant="primary" size="sm" className="self-start" onClick={turnOn} disabled={activate.isPending}>
              Turn on
            </Button>
          </div>
        )}

        <form
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            save();
          }}
        >
          <Field label="Name">
            <Input value={name} onChange={(event) => setName(event.currentTarget.value)} />
          </Field>
          <Field label="Description">
            <Input value={description} onChange={(event) => setDescription(event.currentTarget.value)} />
          </Field>
          <Field label="Instructions">
            <Textarea rows={6} value={instructions} onChange={(event) => setInstructions(event.currentTarget.value)} />
          </Field>
          {update.isError && (
            <p role="alert" className="text-sm text-danger">
              {errorCode(update.error) === "SKILL_INVALID" && update.error instanceof Error
                ? update.error.message
                : "Could not save the skill."}
            </p>
          )}
          <div className="flex justify-end">
            <Button type="submit" variant="primary" size="sm" disabled={!canSave}>
              {update.isPending ? "Saving…" : "Save as new version"}
            </Button>
          </div>
        </form>

        <section aria-label="History" className="flex flex-col gap-2">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-medium text-fg">History</h3>
            <Button
              variant="ghost"
              size="sm"
              disabled={!active || rollback.isPending}
              onClick={() => setConfirmRollback(true)}
            >
              Roll back
            </Button>
          </div>
          {rollback.isError && (
            <p role="alert" className="text-sm text-danger">
              {errorCode(rollback.error) === "SKILL_NO_PREVIOUS_VERSION"
                ? "There is no earlier version to roll back to."
                : "Could not roll back the skill."}
            </p>
          )}
          {versions.isLoading ? (
            <p className="text-sm text-fg-muted">Loading…</p>
          ) : (
            <ul className="flex flex-col divide-y divide-border">
              {shownHistory.map((version) => (
                <VersionRow key={version.id} version={version} />
              ))}
            </ul>
          )}
          {!showAll && history.length > HISTORY_LIMIT && (
            <Button variant="ghost" size="sm" className="self-start" onClick={() => setShowAll(true)}>
              Show all
            </Button>
          )}
        </section>
      </div>

      <AlertDialog open={confirmRollback} onOpenChange={setConfirmRollback}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Roll back “{skillName(skill)}”?</AlertDialogTitle>
            <AlertDialogDescription>
              Agents will load the previous version of this skill. The newer version stays in the history.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() =>
                rollback.mutate(skill.id, {
                  onSuccess: (rolled) => toast("Skill rolled back", { description: `Now on version ${rolled.active?.version ?? ""}.` }),
                })
              }
            >
              Roll back
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

function VersionRow({ version }: { version: SkillVersion }) {
  const status = STATUS[version.status];
  return (
    <li className="flex items-center gap-3 py-2 text-sm">
      <span className="w-12 shrink-0 font-medium text-fg">v{version.version}</span>
      <RelativeTime date={version.createdAt} className="min-w-0 flex-1 truncate text-fg-muted" />
      <StatusPill tone={status.tone} size="sm" label={status.label} />
    </li>
  );
}

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-sm text-fg-muted">{label}</span>
      {children}
    </label>
  );
}
