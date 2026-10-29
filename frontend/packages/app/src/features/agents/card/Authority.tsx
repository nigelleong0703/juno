import type { Agent, DelegableCategory, Rule } from "@agent-desktop/client";
import { Button, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, Section } from "@agent-desktop/ui";
import { ChevronRight, Lock } from "lucide-react";
import { useState } from "react";
import { useApps } from "../../../data/apps";
import { useDelegations, useRevokeDelegation, useUpdateDelegation } from "../../../data/delegations";
import { categoryLabel, DELEGABLE_CATEGORIES, expiresText, isDelegableCategory, limitsSummary, platformOfKey, usageLine } from "../../../components/request/decision";
import { LimitsFields, limitsValid } from "../../../components/request/LimitsFields";
import { PlatformIcon } from "../../../components/request/PlatformIcon";
import { useChatName } from "../../../components/request/useChatName";
import { t } from "../../../lib/i18n";

/** The kinds of decision that are asked every time, whatever any rule says. */
const ALWAYS_ASK = ["irreversible", "sensitive", "setup", "choice"] as const;
const RULES_SHOWN = 3;

/** One delegation's limits, editable; Save keeps them, Revoke makes the next call ask again. */
function EditDelegationDialog({ rule, platform, onClose }: { rule: Rule; platform: string; onClose: () => void }) {
  const update = useUpdateDelegation();
  const revoke = useRevokeDelegation();
  const chatName = useChatName();
  const category = rule.delegation?.category;
  const [limits, setLimits] = useState(rule.delegation?.limits ?? {});
  if (!category || !isDelegableCategory(category)) return null;
  const busy = update.isPending || revoke.isPending;
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t("decision.auth.editTitle", { category: categoryLabel(category) })}</DialogTitle>
          <DialogDescription>{limitsSummary(category, rule.delegation?.limits ?? {}, platform, chatName)}</DialogDescription>
        </DialogHeader>
        <LimitsFields category={category} limits={limits} onChange={setLimits} />
        <DialogFooter>
          <Button variant="destructive" disabled={busy} onClick={() => revoke.mutate(rule.id, { onSuccess: onClose })}>
            {t("decision.auth.revoke")}
          </Button>
          {category === "sharing" ? null : (
            <Button disabled={busy || !limitsValid(category, limits)} onClick={() => update.mutate({ id: rule.id, patch: { limits } }, { onSuccess: onClose })}>
              {t("decision.auth.save")}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function DelegationRow({ rule, category, onEdit }: { rule: Rule; category: DelegableCategory; onEdit: (rule: Rule) => void }) {
  const { data: connectors } = useApps();
  const chatName = useChatName();
  const platform = platformOfKey(rule.delegation?.platformKey ?? "juno", connectors, chatName);
  const usage = usageLine(rule);
  const summary = limitsSummary(category, rule.delegation?.limits ?? {}, platform.name, chatName);
  const expires = category === "sharing" ? expiresText(rule) : undefined;
  return (
    <button type="button" onClick={() => onEdit(rule)} aria-label={t("decision.auth.edit")} className="mt-2 flex w-full items-center gap-3 rounded-lg text-left focus-ring">
      <PlatformIcon platform={platform} category={category} className="size-8" />
      <span className="min-w-0 flex-1">
        <span className="block text-sm text-fg">{expires ? `${summary} · ${expires}` : summary}</span>
        {usage ? <span className="block text-xs text-fg-subtle">{usage}</span> : null}
      </span>
      <ChevronRight className="size-4 shrink-0 text-fg-subtle" />
    </button>
  );
}

/** One kind's rules, the first few; "Show all" opens the rest (sharing makes one rule per chat). */
function CategoryRules({ rules, category, onEdit }: { rules: Rule[]; category: DelegableCategory; onEdit: (rule: Rule) => void }) {
  const [all, setAll] = useState(false);
  return (
    <>
      {(all ? rules : rules.slice(0, RULES_SHOWN)).map((rule) => (
        <DelegationRow key={rule.id} rule={rule} category={category} onEdit={onEdit} />
      ))}
      {rules.length > RULES_SHOWN ? (
        <button type="button" onClick={() => setAll((open) => !open)} className="mt-2 rounded text-sm text-fg-muted hover:text-fg focus-ring">
          {all ? t("common.showLess") : t("decision.auth.showAll", { count: rules.length })}
        </button>
      ) : null}
    </>
  );
}

/**
 * "What <agent> can decide alone": one row per kind of decision an agent can be trusted with (Ask me, or the rules with
 * their limits, tap to edit or revoke), then the kinds that are always asked. Rules are made from "Allow this kind" on a card.
 */
export function Authority({ agent, editable }: { agent: Agent; editable: boolean }) {
  const { data: rules } = useDelegations(agent.id);
  const { data: connectors } = useApps();
  const chatName = useChatName();
  const [editing, setEditing] = useState<Rule | null>(null);
  return (
    <Section title={t("decision.auth.title", { agent: agent.name })} contentClassName="flex flex-col gap-3">
      <div className="divide-y divide-border rounded-xl bg-muted px-4">
        {DELEGABLE_CATEGORIES.map((category) => {
          const mine = (rules ?? []).filter((rule) => rule.delegation?.category === category);
          return (
            <div key={category} className="py-3">
              <div className="flex min-h-6 items-center justify-between gap-3">
                <span className="text-sm text-fg">{categoryLabel(category)}</span>
                {mine.length === 0 ? <span className="text-sm text-fg-muted">{t("decision.auth.ask")}</span> : null}
              </div>
              <CategoryRules rules={mine} category={category} onEdit={(entry) => editable && setEditing(entry)} />
            </div>
          );
        })}
      </div>
      <div className="divide-y divide-border rounded-xl bg-muted px-4 text-fg-muted">
        {ALWAYS_ASK.map((category) => (
          <div key={category} className="flex min-h-11 items-center justify-between gap-3">
            <span className="flex items-center gap-2 text-sm">
              <Lock className="size-3.5" />
              {categoryLabel(category)}
            </span>
            <span className="text-sm">{t("decision.auth.alwaysAsks")}</span>
          </div>
        ))}
      </div>
      {editing ? <EditDelegationDialog rule={editing} platform={platformOfKey(editing.delegation?.platformKey ?? "juno", connectors, chatName).name} onClose={() => setEditing(null)} /> : null}
    </Section>
  );
}
