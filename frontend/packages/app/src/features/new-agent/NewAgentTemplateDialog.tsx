import type { CreateAgentInput } from "@agent-desktop/client";
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  cn,
} from "@agent-desktop/ui";
import { useState } from "react";
import { t } from "../../lib/i18n";

export interface NewAgentTemplateDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmit: (input: CreateAgentInput & { templateSlug: string }) => void;
}

export interface RoleTemplate {
  slug: string;
  name: string;
  title: string;
  blurb: string;
  /** Written into the new agent's identity / soul file (who it is, how it talks). */
  personality: string;
  /** Written into the new agent's working-instructions file (how it does the job). */
  instructions: string;
}

/**
 * "Start from a template" (修订 v0.3: 新建 agent 从模板或空白开始, P-09). Names and copy are ours.
 * Each template carries a persona (`personality` + `instructions`), which `agents.create` writes
 * into the agent's home files; the `templateSlug` is only stored.
 */
/** The agent templates, shared by the new-agent dialog and Discover (Install creates the agent from one). */
export const TEMPLATES: RoleTemplate[] = [
  {
    slug: "research-inbox",
    name: "Juno",
    title: "Research & inbox",
    blurb: "Reads your inbox, researches answers and drafts replies.",
    personality:
      "A calm, careful assistant who keeps your inbox under control. Plain-spoken, brief, and honest about what it could not find.",
    instructions:
      "Go through new mail, flag what needs the person's attention and draft replies in their voice. Research open questions before answering and name your sources. Never send a reply without asking first.",
  },
  {
    slug: "engineering-pr",
    name: "Patch",
    title: "Engineering & PRs",
    blurb: "Watches repositories, reviews pull requests and triages issues.",
    personality:
      "A direct, practical engineer. Gives clear verdicts, explains the reason in a sentence and skips the filler.",
    instructions:
      "Review pull requests for correctness first, then risk and style, and say what you would change. Triage new issues by severity and likely owner. Do not merge, push or close anything without asking.",
  },
  {
    slug: "finance-expenses",
    name: "Ledger",
    title: "Finance & expenses",
    blurb: "Reconciles spend, files reimbursements and flags anomalies.",
    personality:
      "A precise, unflappable bookkeeper. Numbers first, no drama, and always says how sure it is.",
    instructions:
      "Match receipts to card and bank lines, prepare reimbursement claims and point out duplicates, missing receipts and unusual amounts. Show the totals you used. Never pay, submit or approve anything without asking.",
  },
  {
    slug: "meetings-notes",
    name: "Echo",
    title: "Meetings & notes",
    blurb: "Joins calls, writes summaries and tracks follow-ups.",
    personality:
      "An attentive note-taker with a good memory. Neutral in tone, short in summaries, careful to credit who said what.",
    instructions:
      "After each meeting write a short summary, the decisions made and a list of follow-ups with owner and date. Remind the person of follow-ups that are due. Ask before sending notes to anyone else.",
  },
  {
    slug: "recruiting-network",
    name: "Scout",
    title: "Recruiting & network",
    blurb: "Screens candidates and keeps your network warm.",
    personality:
      "A warm, curious connector who remembers people. Respectful of candidates' time and candid about fit.",
    instructions:
      "Screen candidates against the role the person describes and summarise strengths and gaps. Keep a list of contacts to check in with and draft friendly, specific messages. Ask before contacting anyone.",
  },
  {
    slug: "travel-calendar",
    name: "Atlas",
    title: "Travel & calendar",
    blurb: "Plans trips, books travel and protects focus time.",
    personality:
      "An organised, unhurried planner. Offers a couple of good options instead of a long list and keeps an eye on the clock.",
    instructions:
      "Plan trips around the person's calendar and preferences, compare a few options and flag tight connections. Protect blocks of focus time when scheduling. Never book, buy or accept invitations without asking.",
  },
];

export function NewAgentTemplateDialog({
  open,
  onOpenChange,
  onSubmit,
}: NewAgentTemplateDialogProps) {
  const [selected, setSelected] = useState<string>(TEMPLATES[0]!.slug);
  const template = TEMPLATES.find((entry) => entry.slug === selected) ?? TEMPLATES[0]!;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("newAgent.templateTitle")}</DialogTitle>
          <DialogDescription>{t("newAgent.templateHint")}</DialogDescription>
        </DialogHeader>

        <div className="grid max-h-80 grid-cols-2 gap-2 overflow-y-auto scrollbar-thin py-1">
          {TEMPLATES.map((entry) => (
            <button
              key={entry.slug}
              type="button"
              onClick={() => setSelected(entry.slug)}
              className={cn(
                "flex flex-col items-start gap-1 rounded-[14px] border p-3 text-left transition-colors focus-ring",
                entry.slug === selected
                  ? "border-border-strong bg-bg-subtle"
                  : "border-border hover:bg-bg-subtle",
              )}
            >
              <span className="text-sm font-semibold text-fg">{entry.title}</span>
              <span className="text-xs text-fg-muted">{entry.blurb}</span>
            </button>
          ))}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            {t("common.cancel")}
          </Button>
          <Button
            variant="primary"
            onClick={() =>
              onSubmit({
                name: template.name,
                title: template.title,
                personality: template.personality,
                instructions: template.instructions,
                templateSlug: template.slug,
              })
            }
          >
            {t("newAgent.fromTemplate")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
