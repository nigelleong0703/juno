import type { AppProblem, Request, ResolveRequestInput } from "@agent-desktop/client";
import {
  ActionCardButtons,
  ActionCardChip,
  ActionCardGuidance,
  ActionCardHeader,
  ActionCardNotice,
  ActionCardPreview,
  ActionCardTextRow,
  ActionCardTile,
} from "@agent-desktop/ui";
import { Check, ChevronRight, CircleHelp, CreditCard, Lock, Mail, Monitor, Plug, ShieldAlert, ShoppingCart, Terminal } from "lucide-react";
import { useState, type ReactNode } from "react";
import { useApps } from "../../data/apps";
import { useRequestPreview } from "../../data/tasks";
import { appProblem, sourceNote } from "../../lib/apps";
import { t } from "../../lib/i18n";
import { BrandIcon } from "../BrandIcon";
import { AppAction } from "../connect/AppAction";
import { MacConnect } from "../connect/MacConnect";
import { DecisionBody } from "./DecisionCard";
import { DraftPreview, useDraftEditor } from "./DraftPreview";
import { UiDoc } from "../uidoc/UiDoc";
import { EncryptionNote } from "./SecureInputDialog";
import { ScreenSnapshot } from "./ScreenSnapshot";
import { approvalKind, initials, isCommandApproval } from "./summary";

/** What every kind body needs. `readOnly` is the expanded history view: same facts, no buttons. */
export interface CardBodyProps {
  request: Request;
  agentName: string;
  readOnly: boolean;
  disabled: boolean;
  /** Per-field reasons of a refused answer (400 `error.fields`). */
  errors?: Record<string, string>;
  onResolve: (decision: ResolveRequestInput) => void;
  /** The card sits in a direct chat with its agent. */
  inDirectChat?: boolean;
}

const Disc = ({ children }: { children: ReactNode }) => (
  <div className="grid size-10 place-items-center rounded-full bg-white text-sm font-semibold shadow-[0_0_0_1px_rgba(20,20,20,.07)] dark:bg-[#181818] dark:shadow-[0_0_0_1px_rgba(252,252,252,.07)] [&_svg]:size-5">
    {children}
  </div>
);

const Chev = () => <ChevronRight className="size-5 shrink-0 text-foreground/50" />;
const sentence = (text: string) => (/[.!?]$/u.test(text) ? text : `${text}.`);
const lower = (text: string) => text.charAt(0).toLowerCase() + text.slice(1);

/** Approval: purchase (screenshot, saved card, total), send (recipient + draft) or a generic guard. */
export function ApprovalBody(props: CardBodyProps) {
  const { request, agentName, readOnly, disabled, onResolve } = props;
  const payload = request.payload;
  const editor = useDraftEditor(payload.kind === "approval" ? payload.draft?.body : undefined);
  const preview = useRequestPreview(payload.kind === "approval" ? payload.preview?.libraryId : undefined);
  if (payload.kind !== "approval") return null;
  if (payload.brief) return <DecisionBody {...props} editor={editor} screenshot={preview.data} />;
  const kind = approvalKind(request);
  const deny = { label: t("request.deny"), disabled, onClick: () => onResolve({ action: "deny" }) };

  if (kind === "purchase" && payload.purchase) {
    const purchase = payload.purchase;
    return (
      <>
        <ActionCardHeader icon={ShoppingCart}>{t("request.hd.purchase", { agent: agentName, merchant: purchase.merchant })}</ActionCardHeader>
        <ActionCardNotice notice={payload.notice} />
        <ActionCardGuidance>{payload.why}</ActionCardGuidance>
        {payload.ui ? (
          <UiDoc className="mt-4" doc={payload.ui} />
        ) : (
          <>
            <ActionCardPreview className="aspect-[327/193]" chip={<ActionCardChip>{purchase.merchant}</ActionCardChip>}>
              {preview.data ? (
                <img src={preview.data} alt={t("request.previewAlt", { merchant: purchase.merchant })} className="size-full object-cover object-top" />
              ) : (
                <div className="grid size-full place-items-center text-sm text-foreground/50">{purchase.merchant}</div>
              )}
            </ActionCardPreview>
            {purchase.paymentMethod ? (
              <ActionCardTile leading={<CreditCard className="size-6" />} title={purchase.paymentMethod} subtitle={t("request.savedCard")} />
            ) : null}
            {purchase.items.length > 0 ? (
              <ul className="mt-3 flex flex-col gap-1 px-1 text-[13px] leading-[18px] text-foreground/70">
                {purchase.items.slice(0, 4).map((item, index) => (
                  <li key={`${item.name}-${index}`} className="flex justify-between gap-3">
                    <span className="truncate">{item.quantity && item.quantity > 1 ? `${item.quantity} × ` : ""}{item.name}</span>
                    {item.price ? <span className="shrink-0">{item.price}</span> : null}
                  </li>
                ))}
                {purchase.items.length > 4 ? <li>{t("request.moreItems", { count: purchase.items.length - 4 })}</li> : null}
              </ul>
            ) : null}
            {purchase.total ? <ActionCardTextRow label={t("request.estimatedTotal")} value={purchase.total} /> : null}
          </>
        )}
        {readOnly ? null : <ActionCardButtons secondary={deny} primary={{ label: t("request.allow"), disabled, onClick: () => onResolve({ action: "approve" }) }} />}
      </>
    );
  }

  if (kind === "send") {
    const to = payload.recipient ?? payload.target ?? "";
    return (
      <>
        <ActionCardHeader icon={Mail}>{t("request.hd.send", { agent: agentName, verb: t(/mail/iu.test(payload.action) ? "request.verbEmail" : "request.verbMessage"), to })}</ActionCardHeader>
        <ActionCardNotice notice={payload.notice} />
        <ActionCardGuidance>{payload.why}</ActionCardGuidance>
        <ActionCardTile className="mt-4" leading={<Disc>{initials(to) || <Mail />}</Disc>} title={to} subtitle={payload.app} trailing={<Chev />} />
        {payload.draft ? <DraftPreview className="mt-3" subject={payload.draft.subject} editor={editor} readOnly={readOnly} /> : null}
        {readOnly ? null : (
          <ActionCardButtons
            secondary={deny}
            primary={{
              label: t("request.sendNow"),
              disabled,
              onClick: () => onResolve({ action: "approve", ...(editor.edited === undefined ? {} : { editedDraft: editor.edited }) }),
            }}
          />
        )}
      </>
    );
  }

  const isCommand = isCommandApproval(request);
  return (
    <>
      <ActionCardHeader icon={ShieldAlert}>{isCommand ? t("request.hd.command", { agent: agentName }) : t("request.hd.generic", { agent: agentName, action: lower(payload.action) })}</ActionCardHeader>
      <ActionCardNotice notice={payload.notice} />
      <ActionCardGuidance>{payload.why}</ActionCardGuidance>
      {payload.target ? (
        <ActionCardTile
          className="mt-4 items-start py-3.5"
          leading={isCommand ? <Terminal className="mt-0.5 size-[22px]" /> : undefined}
          title={payload.target}
          mono={isCommand}
          subtitle={[payload.app, payload.site].filter(Boolean).join(" · ") || undefined}
        />
      ) : null}
      {readOnly ? null : <ActionCardButtons secondary={deny} primary={{ label: isCommand ? t("request.runOnce") : t("request.allow"), disabled, onClick: () => onResolve({ action: "approve" }) }} />}
    </>
  );
}

/** A question (BACKEND 8.7.1): the doc's blocks, then its one interactive block (choices or fields) answers it. */
export function QuestionBody({ request, inDirectChat, readOnly, disabled, errors, onResolve }: CardBodyProps) {
  if (request.payload.kind !== "question") return null;
  // In a direct chat the card is the agent talking: its own title, no "Question ·" label.
  const quietTitle = inDirectChat === true;
  const { ui, answers } = request.payload;
  return (
    <>
      <ActionCardHeader icon={CircleHelp}>{quietTitle ? (ui.title ?? request.title) : t("request.hd.question", { text: ui.title ?? request.title })}</ActionCardHeader>
      <UiDoc className="mt-4" doc={ui} answering={{ answers, readOnly, disabled, errors, onAnswer: (given) => onResolve({ action: "answer", answers: given }) }} />
    </>
  );
}

/** Secure input: a lock tile naming what is needed; "Enter securely" opens the form dialog. */
export function SecureInputBody({ request, agentName, readOnly, disabled, onResolve, onOpenSecure }: CardBodyProps & { onOpenSecure: () => void }) {
  if (request.payload.kind !== "secure_input") return null;
  const { fields, site, reason } = request.payload;
  const names = fields.map((field) => field.label).join(", ");
  return (
    <>
      <ActionCardHeader icon={Lock}>{t("request.hd.secure", { agent: agentName, what: lower(names) })}</ActionCardHeader>
      <ActionCardGuidance>{sentence(reason)}</ActionCardGuidance>
      <EncryptionNote className="mx-1 mt-1.5" />
      <ActionCardTile className="mt-4" leading={<Disc><Lock /></Disc>} title={names} subtitle={t("request.forSite", { site })} />
      {readOnly ? null : (
        <ActionCardButtons
          secondary={{ label: t("request.cancel"), disabled, onClick: () => onResolve({ action: "deny" }) }}
          primary={{ label: t("request.enterSecurely"), disabled, onClick: onOpenSecure }}
        />
      )}
    </>
  );
}

export interface ComputerControl {
  inControl: boolean;
  busy: boolean;
  screenId?: string;
  onTakeOver: () => void;
  onReturnControl: () => void;
}

/** Take over: the agent is stuck on something only the user can do on its screen. */
export function ComputerBody({ request, agentName, readOnly, disabled, onResolve, control }: CardBodyProps & { control?: ComputerControl }) {
  if (request.payload.kind !== "computer") return null;
  const { reason, site, focus } = request.payload;
  const inControl = control?.inControl === true;
  return (
    <>
      <ActionCardHeader icon={Monitor}>{inControl ? t("request.inControl") : t("request.hd.computer", { agent: agentName })}</ActionCardHeader>
      <ActionCardGuidance>{inControl ? t("request.inControlGuidance", { agent: agentName }) : (focus?.label ? `${sentence(reason)} (${focus.label})` : reason)}</ActionCardGuidance>
      <ActionCardPreview className="aspect-[327/193]" chip={<ActionCardChip><span className="size-[7px] rounded-full bg-[#00c972]" />{inControl ? t("request.you") : t("request.live")}</ActionCardChip>}>
        <ScreenSnapshot screenId={control?.screenId ?? request.payload.screenId} focus={focus?.rect} fallback={site} />
      </ActionCardPreview>
      {readOnly ? null : inControl ? (
        <ActionCardButtons className="mt-3" primary={{ label: t("request.returnControl"), disabled: disabled || control?.busy, onClick: () => { control?.onReturnControl(); onResolve({ action: "approve" }); } }} />
      ) : (
        <ActionCardButtons
          className="mt-3"
          secondary={{ label: t("request.cantHelp"), disabled, onClick: () => onResolve({ action: "deny" }) }}
          primary={{ label: t("request.takeOver"), disabled: disabled || control?.busy, onClick: () => control?.onTakeOver() }}
        />
      )}
    </>
  );
}

/** Sign-in and admin access share one shape: who/where, why, and an approve / deny pair. */
export function SigninAdminBody({ request, agentName, readOnly, disabled, onResolve, onOpenSignin }: CardBodyProps & { onOpenSignin: () => void }) {
  const payload = request.payload;
  if (payload.kind !== "signin" && payload.kind !== "admin") return null;
  const signin = payload.kind === "signin";
  const where = signin ? payload.site : payload.app;
  const why = payload.reason;
  return (
    <>
      <ActionCardHeader icon={signin ? Monitor : ShieldAlert}>
        {signin ? t("request.hd.signin", { agent: agentName, site: where }) : t("request.hd.admin", { agent: agentName, app: where })}
      </ActionCardHeader>
      {why ? <ActionCardGuidance>{why}</ActionCardGuidance> : null}
      <ActionCardTile className="mt-4" title={where} subtitle={signin ? payload.url : payload.requester} />
      {payload.kind === "admin" && payload.details ? <ActionCardGuidance>{payload.details}</ActionCardGuidance> : null}
      {readOnly ? null : (
        <ActionCardButtons
          secondary={{ label: t("request.deny"), disabled, onClick: () => onResolve({ action: "deny" }) }}
          primary={{ label: signin ? t("request.openSignin") : t("request.allow"), disabled, onClick: () => (signin ? onOpenSignin() : onResolve({ action: "approve" })) }}
        />
      )}
    </>
  );
}

/** One app that would satisfy a `connect` request: its icon and name, and its Connect button. */
function ConnectTile({ appId, problem, agentId, agentName, disabled }: { appId: string; problem: AppProblem | undefined; agentId: string; agentName: string; disabled: boolean }) {
  const { data: apps } = useApps();
  const app = apps?.find((entry) => entry.id === appId);
  if (appId === "mac") return <MacConnect agentId={agentId} agentName={agentName} resolved={false} disabled={disabled} />;
  return (
    <ActionCardTile
      className="mt-2"
      leading={<BrandIcon id={appId} symbol={app?.icon} className="size-10 rounded-full" />}
      title={app?.name ?? appId}
      {...(app && sourceNote(app) ? { subtitle: sourceNote(app) } : {})}
      trailing={<AppAction appId={appId} agentId={agentId} problem={problem} size="sm" disabled={disabled} />}
    />
  );
}

/** Rows shown before "Show N more" on the light connect offer. */
const OFFER_ROWS = 4;

/** One app of the light connect offer: logo, name, one muted line, and a small Connect pill (a check once connected). */
function ConnectOfferRow({ appId, problem, request, agentName, readOnly, disabled }: { appId: string; problem: AppProblem | undefined; request: Request; agentName: string; readOnly: boolean; disabled: boolean }) {
  const { data: apps } = useApps();
  const app = apps?.find((entry) => entry.id === appId);
  if (appId === "mac") return <MacConnect agentId={request.agentId} agentName={agentName} resolved={request.status === "approved"} disabled={disabled || readOnly} />;
  // The card's reason can be stale once the person fixes it; the live list says when the agent can use the app now.
  // The list cannot show a missing permission (the account reads as connected), so a card that says `scope_missing` stays until the server resolves it.
  const ready = apps !== undefined && appProblem(app, request.agentId) === null && problem !== "scope_missing";
  return (
    <div className="flex items-center gap-3 py-1.5">
      <BrandIcon id={appId} symbol={app?.icon} className="size-8 shrink-0 rounded-full" />
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium text-fg">{app?.name ?? appId}</div>
        {app && (sourceNote(app) ?? app.blurb) ? <div className="truncate text-xs text-fg-muted">{sourceNote(app) ?? app.blurb}</div> : null}
      </div>
      {ready ? (
        <span className="flex shrink-0 items-center gap-1 text-xs text-fg-muted">
          <Check aria-hidden className="size-3.5" />
          {t("connect.ready")}
        </span>
      ) : readOnly ? null : (
        <AppAction appId={appId} agentId={request.agentId} problem={problem} size="xs" disabled={disabled} />
      )}
    </div>
  );
}

/** The connect offer an agent makes in chat (no routine): a light list of apps, nothing to dismiss or approve. */
function ConnectOffer({ request, agentName, readOnly, disabled }: Pick<CardBodyProps, "request" | "agentName" | "readOnly" | "disabled">) {
  const [expanded, setExpanded] = useState(false);
  if (request.payload.kind !== "connect") return null;
  const { appIds, problems } = request.payload;
  const shown = expanded ? appIds : appIds.slice(0, OFFER_ROWS);
  return (
    <>
      <div className="px-1 text-sm font-medium text-fg">{request.title}</div>
      <div className="mt-1 px-1">
        {shown.map((id) => <ConnectOfferRow key={id} appId={id} problem={problems?.[id]} request={request} agentName={agentName} readOnly={readOnly} disabled={disabled} />)}
      </div>
      {appIds.length > OFFER_ROWS ? (
        <button type="button" onClick={() => setExpanded((open) => !open)} className="mt-1 px-1 text-xs text-fg-muted hover:text-fg focus-ring">
          {expanded ? t("models.showLess") : t("models.showMore", { count: appIds.length - OFFER_ROWS })}
        </button>
      ) : null}
    </>
  );
}

/**
 * Connect: a routine cannot run until the owner connects an app. One tile with a Connect button per app that would do
 * (any one is enough); "Not now" dismisses it. The server resolves the card itself once a listed app is connected.
 * Without a routine (the agent offering apps in chat) it is the light `ConnectOffer` instead.
 */
export function ConnectBody({ request, agentName, readOnly, disabled, onResolve }: CardBodyProps) {
  if (request.payload.kind !== "connect") return null;
  const { appIds, problems, label, routineId } = request.payload;
  if (!routineId) return <ConnectOffer request={request} agentName={agentName} readOnly={readOnly} disabled={disabled} />;
  return (
    <>
      <ActionCardHeader icon={Plug}>{t("request.hd.connect", { agent: agentName, label })}</ActionCardHeader>
      <ActionCardGuidance>{t("request.connectGuidance")}</ActionCardGuidance>
      {readOnly ? null : (
        <>
          <div className="mt-2">{appIds.map((id) => <ConnectTile key={id} appId={id} problem={problems?.[id]} agentId={request.agentId} agentName={agentName} disabled={disabled} />)}</div>
          <ActionCardButtons secondary={{ label: t("request.notNow"), disabled, onClick: () => onResolve({ action: "deny" }) }} />
        </>
      )}
    </>
  );
}
