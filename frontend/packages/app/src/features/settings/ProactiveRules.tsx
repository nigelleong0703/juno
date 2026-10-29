import type { ProactiveRule } from "@agent-desktop/client";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogTitle,
  Button,
  EmptyState,
  toast,
} from "@agent-desktop/ui";
import { useState } from "react";
import { useDeleteProactiveRule, useKeepProactiveRule } from "../../data/mutations";
import { useProactiveRules } from "../../data/queries";
import { t } from "../../lib/i18n";
import { ShowMore, useCapped } from "../agents/card/parts";
import { Group } from "./SettingsGroup";

/** Rules per group before "Show more". */
const GROUP_LIMIT = 5;

/** The groups, in the order the owner reads them: what is off, what is reduced, what is wanted, how. */
const GROUPS: { kind: ProactiveRule["kind"]; titleKey: string }[] = [
  { kind: "dont", titleKey: "proactive.dont" },
  { kind: "less", titleKey: "proactive.less" },
  { kind: "tell", titleKey: "proactive.tell" },
  { kind: "where", titleKey: "proactive.where" },
];

/** "What's worth interrupting me for": the owner's proactive rules, grouped, each removable; soft rules past their review date ask to be kept or removed. */
export function ProactiveRulesSection() {
  const { data: rules } = useProactiveRules();
  const [removing, setRemoving] = useState<ProactiveRule | null>(null);
  const deleteRule = useDeleteProactiveRule();

  const confirmRemove = () => {
    if (!removing) return;
    deleteRule.mutate(removing.id, { onError: () => toast.error(t("common.error")) });
    setRemoving(null);
  };

  if (!rules) return null;
  if (rules.length === 0) return <EmptyState title={t("proactive.empty")} />;
  return (
    <>
      {GROUPS.map(({ kind, titleKey }) => (
        <RuleGroup key={kind} title={t(titleKey)} rules={rules.filter((rule) => rule.kind === kind)} onRemove={setRemoving} />
      ))}
      <AlertDialog open={removing !== null} onOpenChange={(open) => !open && setRemoving(null)}>
        <AlertDialogContent>
          <AlertDialogTitle>{t("proactive.removeTitle")}</AlertDialogTitle>
          <AlertDialogDescription>{removing ? `${removing.text}. ${t("proactive.removeBody")}` : ""}</AlertDialogDescription>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
            <AlertDialogAction onClick={confirmRemove}>{t("proactive.remove")}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

function RuleGroup({ title, rules, onRemove }: { title: string; rules: ProactiveRule[]; onRemove: (rule: ProactiveRule) => void }) {
  const capped = useCapped(rules, GROUP_LIMIT);
  if (rules.length === 0) return null;
  return (
    <Group title={title}>
      {capped.shown.map((rule) => (
        <RuleRow key={rule.id} rule={rule} onRemove={() => onRemove(rule)} />
      ))}
      <ShowMore hidden={capped.hidden} onClick={capped.showMore} />
    </Group>
  );
}

/** "23 Oct 2026" from the owner's local YYYY-MM-DD. */
const dayLabel = (date: string): string =>
  new Date(`${date}T00:00:00`).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });

function RuleRow({ rule, onRemove }: { rule: ProactiveRule; onRemove: () => void }) {
  const keep = useKeepProactiveRule();
  return (
    <div className="flex items-center justify-between gap-3 rounded-xl px-2.5 py-2">
      <div className="min-w-0">
        <div className="flex items-center gap-2 text-sm text-fg">
          <span className="min-w-0 break-words">{rule.text}</span>
          {rule.dueForReview ? <span className="shrink-0 rounded-full bg-warning/15 px-2 py-0.5 text-[11px] font-medium text-warning">{t("proactive.review")}</span> : null}
        </div>
        <div className="break-words text-xs text-fg-subtle">
          {t("proactive.source", { source: rule.source, date: dayLabel(rule.date) })}
          {rule.review && !rule.dueForReview ? ` · ${t("proactive.reviewOn", { date: dayLabel(rule.review) })}` : null}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-1">
        {rule.dueForReview ? (
          <Button
            size="xs"
            variant="ghost"
            disabled={keep.isPending}
            onClick={() => keep.mutate(rule.id, { onError: () => toast.error(t("common.error")) })}
          >
            {t("proactive.keep")}
          </Button>
        ) : null}
        <Button size="xs" variant="ghost" aria-label={`${t("proactive.remove")}: ${rule.text}`} onClick={onRemove}>
          {t("proactive.remove")}
        </Button>
      </div>
    </div>
  );
}
