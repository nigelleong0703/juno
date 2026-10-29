import type { DelegableCategory, DelegationLimits } from "@agent-desktop/client";
import { FormField, Input, Label, Switch } from "@agent-desktop/ui";
import { useState } from "react";
import { t } from "../../lib/i18n";

const AMOUNT = /^\d+(\.\d{1,6})?$/;

/** Whether the limits of a delegation are complete: spending needs both amounts as numbers. */
export function limitsValid(category: DelegableCategory, limits: DelegationLimits): boolean {
  if (category !== "spending") return true;
  return AMOUNT.test(limits.perPurchase?.amount ?? "") && AMOUNT.test(limits.perMonth?.amount ?? "");
}

function Toggle({ label, checked, onChange }: { label: string; checked: boolean; onChange: (checked: boolean) => void }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <Label className="text-sm text-fg">{label}</Label>
      <Switch checked={checked} onCheckedChange={onChange} aria-label={label} />
    </div>
  );
}

/** The limits of one delegation, only the fields its kind of decision has (none for sharing: its chats are fixed, revoke to end it). The owner edits what the server suggested. */
export function LimitsFields({ category, limits, onChange }: { category: DelegableCategory; limits: DelegationLimits; onChange: (limits: DelegationLimits) => void }) {
  const [recipients, setRecipients] = useState((limits.recipients ?? []).join(", "));
  const patch = (next: Partial<DelegationLimits>) => onChange({ ...limits, ...next });
  const currency = limits.perPurchase?.currency ?? limits.perMonth?.currency ?? "USD";
  const money = (key: "perPurchase" | "perMonth", label: string) => (
    <FormField label={`${label} (${currency})`} error={limits[key]?.amount && !AMOUNT.test(limits[key].amount) ? t("decision.limit.amountInvalid") : undefined}>
      <Input inputMode="decimal" value={limits[key]?.amount ?? ""} onChange={(event) => patch({ [key]: { amount: event.currentTarget.value, currency } })} />
    </FormField>
  );
  const perDay = (
    <FormField label={t("decision.limit.maxPerDay")}>
      <Input
        inputMode="numeric"
        value={limits.maxPerDay ?? ""}
        onChange={(event) => {
          const count = Number.parseInt(event.currentTarget.value.replace(/\D/g, ""), 10);
          patch({ maxPerDay: Number.isFinite(count) ? Math.min(500, Math.max(1, count)) : undefined });
        }}
      />
    </FormField>
  );
  if (category === "sharing") return null;
  return (
    <div className="flex flex-col gap-3">
      {category === "spending" ? (
        <>
          {money("perPurchase", t("decision.limit.perPurchase"))}
          {money("perMonth", t("decision.limit.perMonth"))}
          <Toggle label={t("decision.limit.allowRecurring")} checked={limits.allowRecurring === true} onChange={(allowRecurring) => patch({ allowRecurring })} />
        </>
      ) : null}
      {category === "speaking" ? (
        <>
          <Toggle label={t("decision.limit.replyOnly")} checked={limits.replyOnly === true} onChange={(replyOnly) => patch({ replyOnly })} />
          <FormField label={t("decision.limit.recipients")}>
            <Input
              value={recipients}
              onChange={(event) => {
                setRecipients(event.currentTarget.value);
                const list = event.currentTarget.value.split(",").map((entry) => entry.trim()).filter(Boolean);
                patch({ recipients: list.length > 0 ? list : undefined });
              }}
            />
          </FormField>
          {perDay}
        </>
      ) : null}
      {category === "committing" ? <Toggle label={t("decision.limit.acceptOnly")} checked={limits.acceptOnly === true} onChange={(acceptOnly) => patch({ acceptOnly })} /> : null}
      {category === "public" ? perDay : null}
    </div>
  );
}
