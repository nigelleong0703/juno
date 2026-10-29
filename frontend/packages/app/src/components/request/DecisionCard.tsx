import { ActionCardButtons, ActionCardGuidance, ActionCardHeader, ActionCardNotice, ActionCardPreview, Badge, Button, cn } from "@agent-desktop/ui";
import { AppWindow } from "lucide-react";
import { useState } from "react";
import { t } from "../../lib/i18n";
import { UiDoc } from "../uidoc/UiDoc";
import type { CardBodyProps } from "./cards";
import { allowKindLabel, badgeCategories, categoryLabel, factsOf, type Fact } from "./decision";
import { AllowKindDialog, ChangeItDialog } from "./DecisionDialogs";
import { DraftPreview, type useDraftEditor } from "./DraftPreview";
import { PlatformIcon } from "./PlatformIcon";
import { useChatName } from "./useChatName";

const CHIPS = 3;
const TARGETS = 5;

function FactChip({ fact }: { fact: Fact }) {
  return (
    <span className={cn("inline-flex max-w-full items-baseline gap-1.5 rounded-full bg-[#f4f4f4] px-3 py-1 text-[13px] leading-5 dark:bg-[#242424]", fact.declared && "text-foreground/50")}>
      <span className="truncate">{fact.text}</span>
      {fact.declared ? <span className="shrink-0 text-[11px] text-foreground/40">{t("decision.fact.agentSays")}</span> : null}
    </span>
  );
}

/** An app on the owner's Mac has no icon the page can load, so every one shows the same app glyph. */
function AppGlyph() {
  return (
    <span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-bg-subtle text-fg-muted" aria-hidden>
      <AppWindow className="size-5" />
    </span>
  );
}

/**
 * An approval is a decision beyond the agent's authority: where it lands (the platform's own icon), the sentence, up to
 * two kinds of decision, the three heaviest consequences, what you are shown, why, and what happens if you say no. Then
 * Allow once, Allow this kind (when the server offers it), Change it (a note back to the agent) and Deny.
 */
export function DecisionBody({ request, agentName, readOnly, disabled, onResolve, editor, screenshot }: CardBodyProps & { editor: ReturnType<typeof useDraftEditor>; screenshot?: string }) {
  const payload = request.payload;
  const [factsOpen, setFactsOpen] = useState(false);
  const [targetsOpen, setTargetsOpen] = useState(false);
  const [changing, setChanging] = useState(false);
  const [allowing, setAllowing] = useState(false);
  const chatName = useChatName();
  if (payload.kind !== "approval" || !payload.brief) return null;
  const { brief, delegationOffer } = payload;
  const facts = factsOf(brief);
  const targets = brief.facts.targets ?? [];
  const approve = (extra: object = {}) => onResolve({ action: "approve", ...(editor.edited === undefined ? {} : { editedDraft: editor.edited }), ...extra });
  const why = brief.why ?? payload.why;
  const macApp = payload.macApp;

  return (
    <>
      <ActionCardHeader
        leading={macApp ? <AppGlyph /> : <PlatformIcon platform={brief.platform} category={brief.primary} className="size-10" />}
        above={<p className="truncate text-xs text-foreground/50">{brief.platform.name}</p>}
        below={
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            {badgeCategories(brief).map((category) => (
              <Badge key={category} variant="secondary" className="px-2 py-0 text-[11px] font-normal text-foreground/60">
                {categoryLabel(category)}
              </Badge>
            ))}
          </div>
        }
      >
        {brief.sentence}
      </ActionCardHeader>
      <ActionCardNotice notice={payload.notice} />

      {facts.length > 0 ? (
        <div className="mx-1 mt-3 flex flex-wrap gap-1.5">
          {(factsOpen ? facts : facts.slice(0, CHIPS)).map((fact) => (
            <FactChip key={fact.id} fact={fact} />
          ))}
          {facts.length > CHIPS ? (
            <button type="button" onClick={() => setFactsOpen((open) => !open)} className="rounded-full px-2 py-1 text-[13px] text-foreground/50 hover:bg-muted focus-ring">
              {factsOpen ? t("decision.lessFacts") : t("decision.moreFacts", { count: facts.length - CHIPS })}
            </button>
          ) : null}
        </div>
      ) : null}

      {payload.ui ? <UiDoc className="mt-4" doc={payload.ui} /> : null}
      {payload.draft ? <DraftPreview className="mt-3" subject={payload.draft.subject} editor={editor} readOnly={readOnly} /> : null}
      {!payload.ui && screenshot ? (
        <ActionCardPreview className="aspect-[327/193]">
          <img src={screenshot} alt="" className="size-full object-cover object-top" />
        </ActionCardPreview>
      ) : null}
      {targets.length > 0 ? (
        <ul className="mx-1 mt-3 flex flex-col gap-1 text-[13px] leading-[18px] text-foreground/70">
          {(targetsOpen ? targets : targets.slice(0, TARGETS)).map((target, index) => (
            <li key={`${target.label}-${index}`} className="truncate">
              {target.label}
              {target.count && target.count > 1 ? ` × ${target.count}` : ""}
            </li>
          ))}
          {targets.length > TARGETS && !targetsOpen ? (
            <li>
              <button type="button" onClick={() => setTargetsOpen(true)} className="text-foreground/50 underline">
                {t("decision.targetsMore", { count: targets.length })}
              </button>
            </li>
          ) : null}
        </ul>
      ) : null}

      {why ? <ActionCardGuidance>{why}</ActionCardGuidance> : null}
      {brief.ifDenied ? <p className="mx-1 mt-1.5 text-[13px] leading-[18px] text-foreground/45">{t("decision.ifDenied", { text: brief.ifDenied })}</p> : null}
      {readOnly && request.decision?.note ? <p className="mx-1 mt-1.5 text-[13px] leading-[18px] text-foreground/60">{request.decision.note}</p> : null}

      {readOnly ? null : macApp ? (
        // An app on the owner's Mac: Allow once / Always allow (kept per app) / Don't allow. Bringing it to the front is one tap, never remembered.
        <>
          <ActionCardButtons
            secondary={{ label: t("decision.macApp.deny"), disabled, onClick: () => onResolve({ action: "deny" }) }}
            primary={{ label: macApp.purpose === "foreground" ? t("decision.macApp.allow") : t("decision.allowOnce"), disabled, onClick: () => onResolve({ action: "approve" }) }}
          />
          {macApp.purpose === "use" ? (
            <div className="mt-1 flex justify-center">
              <Button variant="ghost" size="sm" disabled={disabled} onClick={() => onResolve({ action: "approve", scope: "app" })}>
                {t("decision.macApp.always")}
              </Button>
            </div>
          ) : null}
        </>
      ) : (
        <>
          <ActionCardButtons
            secondary={{ label: t("decision.deny"), disabled, onClick: () => onResolve({ action: "deny" }) }}
            primary={{ label: t("decision.allowOnce"), disabled, onClick: () => approve({ scope: "once" }) }}
          />
          <div className="mt-1 flex flex-wrap justify-center gap-1">
            {delegationOffer?.delegable ? (
              <Button variant="ghost" size="sm" className="h-auto max-w-full py-1.5 whitespace-normal" disabled={disabled} onClick={() => setAllowing(true)}>
                {allowKindLabel(delegationOffer.suggested, chatName)}
              </Button>
            ) : null}
            <Button variant="ghost" size="sm" disabled={disabled} onClick={() => setChanging(true)}>
              {t("decision.changeIt")}
            </Button>
          </div>
          <ChangeItDialog open={changing} agentName={agentName} disabled={disabled} onOpenChange={setChanging} onSend={(decision) => { setChanging(false); onResolve(decision); }} />
          {delegationOffer?.delegable ? (
            <AllowKindDialog
              open={allowing}
              agentName={agentName}
              suggested={delegationOffer.suggested}
              disabled={disabled}
              onOpenChange={setAllowing}
              onConfirm={(delegations) => { setAllowing(false); approve({ scope: "delegate", delegations }); }}
            />
          ) : null}
        </>
      )}
    </>
  );
}
