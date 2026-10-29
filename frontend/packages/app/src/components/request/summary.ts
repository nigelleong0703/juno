import type { Request, RequestOutcome } from "@agent-desktop/client";
import { t } from "../../lib/i18n";
import { answerSummary } from "../uidoc/answers";
import { briefOf, outcomeLabel } from "./decision";

export type SendKind = "purchase" | "send" | "other";

/** What an approval is about, from its payload alone (the backend sends no separate "type"). */
export function approvalKind(request: Request): SendKind {
  const payload = request.payload;
  if (payload.kind !== "approval") return "other";
  if (payload.purchase) return "purchase";
  if (payload.draft || payload.recipient) return "send";
  return "other";
}

/** A command approval: the card says "Run command" and its button "Run once". */
export function isCommandApproval(request: Request): boolean {
  const payload = request.payload;
  return payload.kind === "approval" && (payload.app === "Computer" || /^(run|execute|delete|remove|install)/i.test(payload.action));
}

/** First character, for the initials disc. */
export const initials = (name: string): string =>
  name
    .split(/[\s@.]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part.charAt(0).toUpperCase())
    .join("");

export interface ResolvedSummary {
  tone: "success" | "danger" | "neutral";
  title: string;
  detail?: string;
}

const OUTCOME_TONE: Record<RequestOutcome, ResolvedSummary["tone"]> = {
  allowed_once: "success",
  allowed_rule: "success",
  denied: "danger",
  revised: "neutral",
  timed_out: "neutral",
  cancelled: "neutral",
  handed_back: "success",
};

/** The one-line outcome of a decided request: "Approved · Order placed · S$2,399", "Sent · Email to Mei Lin". */
export function resolvedSummary(request: Request): ResolvedSummary {
  const { payload, status } = request;
  const { decision } = request;
  // The agent withdrew its own request in chat: show the user's words, not an outcome.
  if (decision?.reason === "cancelled" && decision.by && decision.by === request.agentId && decision.note) {
    return { tone: "neutral", title: t("request.sum.withdrawn", { note: decision.note }) };
  }
  const brief = briefOf(request);
  if (brief && request.outcome) return { tone: OUTCOME_TONE[request.outcome], title: outcomeLabel(request.outcome), detail: brief.sentence };
  if (status === "expired") return { tone: "neutral", title: t("request.sum.expired"), detail: request.title };
  const denied = status === "denied";
  switch (payload.kind) {
    case "approval": {
      const kind = approvalKind(request);
      if (denied) return { tone: "danger", title: t("request.sum.denied"), detail: request.title };
      if (kind === "purchase") {
        return { tone: "success", title: t("request.sum.approved"), detail: t("request.sum.orderAt", { merchant: payload.purchase?.merchant ?? payload.site ?? "" }) };
      }
      if (kind === "send") {
        const to = payload.recipient ?? payload.target;
        return { tone: "success", title: t("request.sum.sent"), detail: to ? t("request.sum.toRecipient", { to }) : payload.draft?.subject };
      }
      if (isCommandApproval(request)) return { tone: "success", title: t("request.sum.ranOnce"), detail: payload.target ?? request.title };
      return { tone: "success", title: t("request.sum.approved"), detail: request.title };
    }
    case "question": {
      if (denied) return { tone: "neutral", title: t("request.sum.skipped"), detail: request.title };
      return { tone: "success", title: t("request.sum.answered"), detail: answerSummary(payload.ui, payload.answers) || request.title };
    }
    case "secure_input":
      return denied
        ? { tone: "danger", title: t("request.sum.cancelled"), detail: payload.site }
        : { tone: "success", title: t("request.sum.enteredSecurely"), detail: payload.site };
    case "computer":
      return denied
        ? { tone: "neutral", title: t("request.sum.skipped"), detail: payload.reason }
        : { tone: "success", title: t("request.sum.handedBack"), detail: payload.site ?? payload.reason };
    case "signin":
      return denied
        ? { tone: "danger", title: t("request.sum.denied"), detail: payload.site }
        : { tone: "success", title: t("request.sum.signedIn"), detail: payload.site };
    case "connect":
      return denied
        ? { tone: "neutral", title: t("request.sum.notNow"), detail: payload.label }
        : { tone: "success", title: t("request.sum.connected"), detail: payload.label };
    case "admin":
      return denied
        ? { tone: "danger", title: t("request.sum.denied"), detail: payload.app }
        : { tone: "success", title: t("request.sum.approved"), detail: payload.app };
  }
}
