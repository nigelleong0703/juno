import type { AuditEntry, RuleBehavior, RuleScope } from "@agent-desktop/client";
import {
  Button,
  Combobox,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  EmptyState,
  ErrorState,
  IconButton,
  Input,
  LoadingState,
  PageHeader,
  RelativeTime,
  ScrollArea,
  SearchField,
  SegmentedControl,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Switch,
  cn,
  toast,
} from "@agent-desktop/ui";
import { Download, Lock, Plus, Trash2 } from "lucide-react";
import { useMemo, useState } from "react";
import { useClient } from "../../data/ClientProvider";
import { useAudit, useRoutines, useRules } from "../../data/queries";
import { useCreateRule, useDeleteRule, useUpdateRule } from "../../data/rules";
import { downloadCsv, startedByLine } from "../../lib/auditInitiator";
import { t } from "../../lib/i18n";

/** The four levels (§4.7), in the words the owner uses. */
const BEHAVIORS: { value: RuleBehavior; label: string }[] = [
  { value: "auto", label: "Act without asking" },
  { value: "on_command", label: "Act when I say so" },
  { value: "ask", label: "Ask first" },
  { value: "handoff", label: "Hand off to me" },
];

/**
 * Every scope a stored rule can have, for labelling. Only `action` (matched by tool name) and
 * `recipient` (only "act without asking") are enforced by the backend, so the New rule dialog
 * offers just those; older `app` / `site` rules still show up here so they can be deleted (P-11).
 */
const SCOPES: { value: RuleScope; label: string }[] = [
  { value: "app", label: "App" },
  { value: "action", label: "Action" },
  { value: "recipient", label: "Recipient" },
  { value: "site", label: "Site" },
];

const NEW_RULE_SCOPES = SCOPES.filter((entry) => entry.value === "action" || entry.value === "recipient");

const SUBJECT_PLACEHOLDER: Partial<Record<RuleScope, string>> = {
  action: "Tool name, e.g. browser.click",
  recipient: "Address, e.g. ana@example.com",
};

const BEHAVIOR_LABEL: Record<RuleBehavior, string> = {
  auto: "Act without asking",
  on_command: "Act when I say so",
  ask: "Ask first",
  handoff: "Hand off to me",
};

const DECISION_LABEL: Record<AuditEntry["decision"], string> = {
  auto_allowed: "Acted on its own",
  asked: "Asked first",
  approved: "You approved",
  denied: "You denied",
  revised: "You sent it back",
  timed_out: "Timed out",
  handed_off: "Handed off",
};

type Tab = "rules" | "activity";

/**
 * Auto-review rules (§4.7): the built-in guardrails, your own rules and the four behaviours, and
 * the audit log. Agent-drafted suggestions are hidden: nothing drafts them yet (P-11). Secondary
 * page (修订 v0.3).
 */
export function RulesPage() {
  const [tab, setTab] = useState<Tab>("rules");
  const [query, setQuery] = useState("");
  const [creating, setCreating] = useState(false);
  const [scope, setScope] = useState<"all" | "unattended">("all");
  const [exporting, setExporting] = useState(false);
  const client = useClient();

  const { data: rules, isLoading, isError, refetch } = useRules();
  const { data: routines } = useRoutines();
  const auditPages = useAudit(scope === "unattended" ? { unattended: true } : undefined);
  const { isLoading: auditLoading, isError: auditError, refetch: refetchAudit } = auditPages;
  const audit = auditPages.data?.pages.flatMap((page) => page.items);
  const routineName = (id: string) => routines?.find((routine) => routine.id === id)?.name;

  const exportCsv = async () => {
    setExporting(true);
    try {
      downloadCsv("juno-activity.csv", await client.audit.exportCsv(scope === "unattended" ? { unattended: true } : undefined));
    } catch {
      toast.error(t("audit.exportFailed"));
    } finally {
      setExporting(false);
    }
  };
  const update = useUpdateRule();
  const remove = useDeleteRule();

  const builtin = (rules ?? []).filter((rule) => rule.source === "builtin");
  const custom = (rules ?? []).filter(
    (rule) => (rule.source === "user" || rule.source === "team") && rule.scope !== "delegation",
  );

  const filteredCustom = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return custom;
    return custom.filter(
      (rule) =>
        rule.description.toLowerCase().includes(needle) ||
        (rule.subject ?? "").toLowerCase().includes(needle),
    );
  }, [custom, query]);

  return (
    <div className="flex h-full min-h-0 flex-col bg-bg">
      <PageHeader
        title={t("rules.title")}
        subtitle={rules ? `${custom.length} of your rules` : undefined}
        tabs={
          <SegmentedControl
            value={tab}
            onValueChange={(value) => setTab(value as Tab)}
            items={[
              { value: "rules", label: "Rules" },
              { value: "activity", label: "Activity" },
            ]}
          />
        }
        actions={
          tab === "rules" ? (
            <Button variant="primary" size="sm" onClick={() => setCreating(true)}>
              <Plus className="size-3.5" />
              New rule
            </Button>
          ) : (
            <Button variant="outline" size="sm" disabled={exporting} onClick={() => void exportCsv()}>
              <Download className="size-3.5" />
              {t("audit.export")}
            </Button>
          )
        }
      />

      {tab === "activity" && (
        <div className="mx-auto flex w-full max-w-4xl items-center gap-2 px-5 py-3">
          <SegmentedControl
            value={scope}
            onValueChange={(value) => setScope(value as "all" | "unattended")}
            items={[
              { value: "all", label: t("audit.filterAll") },
              { value: "unattended", label: t("audit.filterUnattended") },
            ]}
          />
        </div>
      )}

      {tab === "rules" && (
        <div className="mx-auto flex w-full max-w-4xl items-center gap-2 px-5 py-3">
          <SearchField
            className="w-64"
            size="sm"
            value={query}
            onValueChange={setQuery}
            placeholder="Search your rules…"
          />
        </div>
      )}

      <ScrollArea className="min-h-0 flex-1">
        <div className="mx-auto w-full max-w-4xl px-5 pb-10">
          {tab === "rules" && (
            isLoading ? (
              <LoadingState label={t("common.loading")} />
            ) : isError ? (
              <ErrorState title={t("common.error")} onRetry={() => void refetch()} />
            ) : (
              <div className="space-y-8 pt-1">
                <section>
                  <h2 className="flex items-center gap-1.5 px-2 text-sm font-medium text-fg">
                    <Lock className="size-3.5 text-fg-subtle" />
                    Built-in guardrails
                  </h2>
                  <p className="px-2 text-xs text-fg-subtle">
                    Always on. They keep agents inside your workspace and can’t be turned off.
                  </p>
                  <ul className="mt-2">
                    {builtin.map((rule) => (
                      <li key={rule.id} className="flex items-center gap-3 rounded-md px-2 py-2.5">
                        <Lock className="size-3.5 shrink-0 text-fg-subtle" />
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-sm text-fg">{rule.description}</div>
                          <div className="text-xs text-fg-subtle">
                            {SCOPES.find((scope) => scope.value === rule.scope)?.label}
                            {rule.subject ? ` · ${rule.subject}` : ""}
                          </div>
                        </div>
                        <span className="shrink-0 text-xs text-fg-muted">
                          {BEHAVIOR_LABEL[rule.behavior]}
                        </span>
                      </li>
                    ))}
                  </ul>
                </section>

                <section>
                  <h2 className="px-2 text-sm font-medium text-fg">Your rules</h2>
                  {filteredCustom.length === 0 ? (
                    <p className="px-2 text-sm text-fg-subtle">
                      {t("rules.emptyHint")}
                    </p>
                  ) : (
                    <ul className="mt-2">
                      {filteredCustom.map((rule) => (
                        <li
                          key={rule.id}
                          className="group flex items-center gap-3 rounded-md px-2 py-2.5 transition-colors hover:bg-accent/40"
                        >
                          <div className="min-w-0 flex-1">
                            <div className="truncate text-sm text-fg">{rule.description}</div>
                            <div className="text-xs text-fg-subtle">
                              {SCOPES.find((scope) => scope.value === rule.scope)?.label}
                              {rule.subject ? ` · ${rule.subject}` : ""}
                            </div>
                          </div>
                          <Select
                            value={rule.behavior}
                            onValueChange={(value) =>
                              update.mutate({ id: rule.id, patch: { behavior: value as RuleBehavior } })
                            }
                          >
                            <SelectTrigger className="h-8 w-44 shrink-0 text-sm">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              {BEHAVIORS.map((behavior) => (
                                <SelectItem key={behavior.value} value={behavior.value}>
                                  {behavior.label}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                          <Switch
                            checked={rule.enabled}
                            onCheckedChange={(checked) =>
                              update.mutate({ id: rule.id, patch: { enabled: checked } })
                            }
                            aria-label="Rule enabled"
                          />
                          <IconButton
                            label="Delete rule"
                            variant="ghost"
                            size="sm"
                            className="opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
                            onClick={() =>
                              remove.mutate(rule.id, {
                                onSuccess: () => toast("Rule deleted"),
                              })
                            }
                          >
                            <Trash2 className="size-3.5" />
                          </IconButton>
                        </li>
                      ))}
                    </ul>
                  )}
                </section>
              </div>
            )
          )}

          {tab === "activity" &&
            (auditLoading ? (
              <LoadingState label={t("common.loading")} />
            ) : auditError ? (
              <ErrorState title={t("common.error")} onRetry={() => void refetchAudit()} />
            ) : (audit ?? []).length === 0 ? (
              scope === "unattended" ? (
                <EmptyState title={t("audit.emptyUnattended")} description={t("audit.emptyUnattendedHint")} />
              ) : (
                <EmptyState
                  title="Nothing reviewed yet"
                  description="Every decision an agent makes under a rule shows up here."
                />
              )
            ) : (
              <ul className="pt-1">
                {(audit ?? []).map((entry) => (
                  <li key={entry.id} className="flex items-start gap-3 rounded-md px-2 py-2.5">
                    <span
                      className={cn(
                        "mt-1.5 size-1.5 shrink-0 rounded-full",
                        entry.decision === "denied"
                          ? "bg-danger"
                          : entry.decision === "auto_allowed" || entry.decision === "approved"
                            ? "bg-success"
                            : "bg-warning",
                      )}
                    />
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm text-fg">{entry.action}</div>
                      <div className="text-xs text-fg-subtle">{entry.reason}</div>
                      <div className="text-xs text-fg-subtle">
                        {startedByLine(entry.initiator, entry.initiator.type === "routine" ? routineName(entry.initiator.routineId) : undefined)}
                      </div>
                    </div>
                    <div className="shrink-0 text-right">
                      <div className="text-xs text-fg-muted">{DECISION_LABEL[entry.decision]}</div>
                      <RelativeTime date={entry.at} className="text-xs text-fg-subtle" />
                    </div>
                  </li>
                ))}
                {auditPages.hasNextPage && (
                  <li className="flex justify-center pt-2">
                    <Button variant="ghost" size="sm" disabled={auditPages.isFetchingNextPage} onClick={() => void auditPages.fetchNextPage()}>
                      {t("common.showMore")}
                    </Button>
                  </li>
                )}
              </ul>
            ))}
        </div>
      </ScrollArea>

      <NewRuleDialog open={creating} onOpenChange={setCreating} />
    </div>
  );
}

function NewRuleDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const create = useCreateRule();
  const [description, setDescription] = useState("");
  const [scope, setScope] = useState<RuleScope>("action");
  const [subject, setSubject] = useState("");
  const [behavior, setBehavior] = useState<RuleBehavior>("ask");

  // A recipient rule only ever relaxes (the backend reads it as "act without asking" for that address).
  const behaviors = scope === "recipient" ? BEHAVIORS.filter((entry) => entry.value === "auto") : BEHAVIORS;

  const reset = () => {
    setDescription("");
    setScope("action");
    setSubject("");
    setBehavior("ask");
  };

  const submit = () => {
    if (!description.trim() || !subject.trim()) return;
    create.mutate(
      {
        description: description.trim(),
        scope,
        behavior,
        enabled: true,
        subject: subject.trim(),
      },
      {
        onSuccess: () => {
          toast("Rule added", { description: description.trim() });
          reset();
          onOpenChange(false);
        },
      },
    );
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
          <DialogTitle>New rule</DialogTitle>
          <DialogDescription>
            Decide how agents handle one kind of decision before it reaches you.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <label className="block">
            <span className="mb-1.5 block text-sm text-fg-muted">Rule</span>
            <Input
              autoFocus
              value={description}
              onChange={(event) => setDescription(event.currentTarget.value)}
              placeholder="e.g. Don’t email anyone outside the team"
            />
          </label>

          <div className="flex gap-3">
            <label className="block flex-1">
              <span className="mb-1.5 block text-sm text-fg-muted">Applies to</span>
              <Select
                value={scope}
                onValueChange={(value) => {
                  setScope(value as RuleScope);
                  if (value === "recipient") setBehavior("auto");
                }}
              >
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {NEW_RULE_SCOPES.map((entry) => (
                    <SelectItem key={entry.value} value={entry.value}>
                      {entry.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </label>
            <label className="block flex-1">
              <span className="mb-1.5 block text-sm text-fg-muted">Subject</span>
              <Input
                value={subject}
                onChange={(event) => setSubject(event.currentTarget.value)}
                placeholder={SUBJECT_PLACEHOLDER[scope]}
              />
            </label>
          </div>

          <div>
            <span className="mb-1.5 block text-sm text-fg-muted">When it matches</span>
            <Combobox
              className="h-9 w-full text-sm"
              value={behavior}
              onValueChange={(value) => setBehavior(value as RuleBehavior)}
              placeholder="Pick a behaviour"
              options={behaviors.map((entry) => ({ value: entry.value, label: entry.label }))}
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
            {t("common.cancel")}
          </Button>
          <Button
            variant="primary"
            size="sm"
            disabled={!description.trim() || !subject.trim() || create.isPending}
            onClick={submit}
          >
            Add rule
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
