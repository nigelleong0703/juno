import { type Agent, type PermissionTiers } from "@agent-desktop/client";
import { Button, Collapsible, CollapsibleContent, CollapsibleTrigger, Input, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, Section, Switch } from "@agent-desktop/ui";
import { ShieldCheck } from "lucide-react";
import { useEffect, useState } from "react";
import { useAuthIdentity } from "../../../auth/AuthContext";
import { useUpdateAgent } from "../../../data/mutations";
import { macChoice, useMyMac } from "../../../data/my-mac";
import { useRequests, useRules } from "../../../data/queries";
import { useDeleteRule } from "../../../data/rules";
import { LiveRequestCard } from "../../../components/request/LiveRequestCard";
import { formatAgo } from "../../../lib/format";
import { t } from "../../../lib/i18n";
import { canEditAgent } from "../canEditAgent";
import { Authority } from "./Authority";
import { DecisionHistory } from "./DecisionHistory";
import { ShowMore, useCapped } from "./parts";

type Option = { value: string; label: string; disabled?: boolean };

/** One tier: its name on the left, the choices as a compact muted menu on the right. */
function TierRow({ label, value, options, disabled, onChange }: { label: string; value: string; options: Option[]; disabled: boolean; onChange: (value: string) => void }) {
  return (
    <div className="flex min-h-12 items-center justify-between gap-3">
      <span className="text-sm text-fg">{label}</span>
      <Select value={value} disabled={disabled} onValueChange={onChange}>
        <SelectTrigger size="sm" aria-label={label} className="h-8 border-0 bg-transparent px-2 text-fg-muted shadow-none hover:bg-transparent">
          <SelectValue />
        </SelectTrigger>
        <SelectContent position="popper" align="end">
          {options.map((option) => (
            <SelectItem key={option.value} value={option.value} disabled={option.disabled === true}>
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

/** The platform default for sub-tasks at once (an agent with no `maxSubTasks` uses it). */
const DEFAULT_MAX_SUB_TASKS = 4;

/** How many sub-tasks the agent may run at once. Saved on blur or Enter; empty means the default. */
function SubTaskLimit({ agent, disabled }: { agent: Agent; disabled: boolean }) {
  const update = useUpdateAgent();
  const stored = agent.maxSubTasks?.toString() ?? "";
  const [draft, setDraft] = useState(stored);
  const [invalid, setInvalid] = useState(false);
  useEffect(() => {
    setDraft(stored);
    setInvalid(false);
  }, [stored]);
  const save = () => {
    const trimmed = draft.trim();
    const value = trimmed === "" ? DEFAULT_MAX_SUB_TASKS : Number(trimmed);
    if (!Number.isInteger(value) || value < 1) {
      setInvalid(true);
      return;
    }
    setInvalid(false);
    if (value !== agent.maxSubTasks) update.mutate({ id: agent.id, patch: { maxSubTasks: value } });
  };
  return (
    <div className="py-1">
      <div className="flex min-h-12 items-center justify-between gap-3">
        <span className="text-sm text-fg">{t("agentCard.maxSubTasks")}</span>
        <Input
          type="number"
          min={1}
          step={1}
          inputMode="numeric"
          aria-label={t("agentCard.maxSubTasks")}
          placeholder={String(DEFAULT_MAX_SUB_TASKS)}
          className="h-8 w-20 text-right"
          value={draft}
          disabled={disabled}
          onChange={(event) => setDraft(event.currentTarget.value)}
          onBlur={save}
          onKeyDown={(event) => {
            if (event.key === "Enter") save();
          }}
        />
      </div>
      <p className="text-xs text-fg-muted">{invalid ? t("agentCard.maxSubTasks.invalid") : t("agentCard.maxSubTasks.hint")}</p>
    </div>
  );
}

/**
 * The two tiers that are not decisions, saved on the agent (`permissionTiers`, merged key by key), like the iPhone's
 * TierSettings. "Loose" browsing is not offered, and "Reaching out" is On/Off over the stored level (On keeps a level
 * other than off, else goes to normal). Purchases and sending are decisions now: see the authority table.
 */
function TierSettings({ agent, disabled }: { agent: Agent; disabled: boolean }) {
  const update = useUpdateAgent();
  const tiers = agent.permissionTiers;
  const set = (key: keyof PermissionTiers) => (value: string) => update.mutate({ id: agent.id, patch: { permissionTiers: { [key]: value } as PermissionTiers } });
  const reachOut = tiers?.reachOut ?? "normal";
  const mac = macChoice(useMyMac().data);
  // Needs a paired Mac to turn this on.
  const macAccess = agent.macAccess;
  const blocked = !macAccess && mac === "unpaired";
  return (
    <div className="divide-y divide-border rounded-xl bg-muted px-4">
      <div className="py-3">
        <div className="flex min-h-6 items-center justify-between gap-3">
          <span className="text-sm text-fg">{t("agentCard.macAccess")}</span>
          <Switch
            aria-label={t("agentCard.macAccess")}
            checked={macAccess}
            disabled={disabled || blocked}
            onCheckedChange={(next) => update.mutate({ id: agent.id, patch: { macAccess: next } })}
          />
        </div>
        <p className="mt-1 text-xs text-fg-muted">{t("agentCard.macAccess.hint")}</p>
        {blocked ? <p className="mt-1 text-xs text-fg-muted">{t("agentCard.macAccess.unpaired")}</p> : null}
        {macAccess && mac === "offline" ? <p className="mt-1 text-xs text-warning">{t("agentCard.macAccess.offline")}</p> : null}
      </div>
      <TierRow
        label={t("perm.tier.browsing")}
        value={tiers?.browsing === "strict" ? "strict" : "normal"}
        options={[
          { value: "strict", label: t("agentCard.perm.strict") },
          { value: "normal", label: t("agentCard.perm.normal") },
        ]}
        disabled={disabled}
        onChange={set("browsing")}
      />
      <TierRow
        label={t("perm.tier.reachOut")}
        value={reachOut === "off" ? "off" : "on"}
        options={[
          { value: "on", label: t("agentCard.perm.on") },
          { value: "off", label: t("agentCard.perm.off") },
        ]}
        disabled={disabled}
        onChange={(next) => set("reachOut")(next === "off" ? "off" : reachOut === "off" ? "normal" : reachOut)}
      />
      <SubTaskLimit agent={agent} disabled={disabled} />
    </div>
  );
}

/**
 * Permissions, after the iPhone's ApprovalsTab (backend §8.8, §8.1): what the agent can decide alone (and what it always
 * asks), what waits on you (only when something does), the history of decisions, then browsing and reaching out and the
 * older per-tool rules (read-only, revoke only). Only the owner can change limits, tiers or revoke.
 */
export function PermissionsTab({ agent }: { agent: Agent }) {
  const identity = useAuthIdentity();
  const ownerId = identity?.mode === "account" ? identity.user.id : undefined;
  const editable = canEditAgent(agent, ownerId);
  const { data: waiting } = useRequests({ agentId: agent.id, status: "pending" });
  const { data: rules } = useRules({ agentId: agent.id });
  const revoke = useDeleteRule();
  const waitingCapped = useCapped(waiting ?? [], 3);
  const olderRules = (rules ?? []).filter((rule) => rule.scope !== "delegation");
  const olderCapped = useCapped(olderRules, 5);
  return (
    <div className="space-y-5 px-2">
      <Authority agent={agent} editable={editable} />

      {waitingCapped.shown.length ? (
        <Section title={t("perm.waiting")} contentClassName="flex flex-col gap-3">
          {waitingCapped.shown.map((request) => (
            <LiveRequestCard key={request.id} request={request} />
          ))}
          <ShowMore hidden={waitingCapped.hidden} onClick={waitingCapped.showMore} />
        </Section>
      ) : null}

      <DecisionHistory agentId={agent.id} />

      <Section title={t("decision.history.bottomTitle")} contentClassName="flex flex-col gap-3.5">
        <TierSettings agent={agent} disabled={!editable} />
      </Section>

      {olderRules.length ? (
        <Collapsible>
          <CollapsibleTrigger>{t("decision.history.olderRules")}</CollapsibleTrigger>
          <CollapsibleContent className="flex flex-col gap-3.5 px-3 pt-2">
            {olderCapped.shown.map((rule) => (
              <div key={rule.id} className="flex items-center gap-3">
                <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-muted text-fg-muted">
                  <ShieldCheck className="size-4" />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-semibold text-fg">{rule.description}</p>
                  <p className="text-xs text-fg-subtle">{t("perm.allowedAgo", { ago: formatAgo(rule.createdAt) })}</p>
                </div>
                {editable ? (
                  <Button variant="secondary" size="sm" aria-label={t("perm.revokeLabel", { text: rule.description })} disabled={revoke.isPending} onClick={() => revoke.mutate(rule.id)}>
                    {t("perm.revoke")}
                  </Button>
                ) : null}
              </div>
            ))}
            <ShowMore hidden={olderCapped.hidden} onClick={olderCapped.showMore} />
          </CollapsibleContent>
        </Collapsible>
      ) : null}
    </div>
  );
}
