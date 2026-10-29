import type { Agent } from "@agent-desktop/client";
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
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Section,
  toast,
} from "@agent-desktop/ui";
import { useState } from "react";
import { useHomeFile } from "../../../data/home";
import { useForgetMemory } from "../../../data/memories";
import { t } from "../../../lib/i18n";
import { parseReplyStyle, replyStyleFor, type ReplyRule } from "./replyStyle";

/** Rules shown before "Show N more". */
const RULE_LIMIT = 6;

/** Memory's dotted-underlined phrase. */
const PHRASE = "cursor-pointer text-left underline decoration-fg/35 decoration-dotted underline-offset-[5px] hover:decoration-fg/60 focus-ring";

/**
 * What the platform learned about how the user likes to be answered (ALIGNMENT_SYNTHESIS.md), as a short list of plain
 * sentences under one muted line ("Learned from your conversations · updated 24 Oct 2026"). A rule that rests on a claim is a
 * dotted-underlined phrase; a tap opens it with "Forget this" (after a confirm), which retracts the claim and reloads the file.
 */
export function LearnedReplyStyle({ agent }: { agent: Agent }) {
  const { file, isPending } = useHomeFile("ALIGNMENT_SYNTHESIS.md");
  const [all, setAll] = useState(false);
  const [open, setOpen] = useState<ReplyRule | undefined>(undefined);
  if (isPending) return null;
  const style = parseReplyStyle(replyStyleFor(file?.content ?? "", agent.id));
  const shown = all ? style.rules : style.rules.slice(0, RULE_LIMIT);
  const hidden = style.rules.length - shown.length;
  const updated = style.updated?.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
  return (
    <Section title={t("agentCard.replyStyle")} className="gap-2" contentClassName="flex flex-col items-start gap-3">
      {style.rules.length === 0 ? (
        <p className="text-sm text-fg-muted">{t("agentCard.replyStyleEmpty", { name: agent.name })}</p>
      ) : (
        <>
          <p className="text-[13px] text-fg-subtle">{updated ? t("agentCard.replyStyleSource", { date: updated }) : t("agentCard.replyStyleSourceUndated")}</p>
          <ul className="flex flex-col gap-3">
            {shown.map((rule, index) => (
              <li key={`${rule.claimId ?? "plain"}-${index}`} className="text-[15px] leading-snug text-fg">
                {rule.claimId ? (
                  <button type="button" onClick={() => setOpen(rule)} className={PHRASE}>
                    {rule.text}
                  </button>
                ) : (
                  rule.text
                )}
              </li>
            ))}
          </ul>
          {hidden > 0 ? (
            <button type="button" onClick={() => setAll(true)} className="text-sm font-medium text-fg-muted focus-ring">
              {t("agentCard.replyStyleMore", { count: hidden })}
            </button>
          ) : null}
        </>
      )}
      {open?.claimId ? <RuleDialog rule={open} claimId={open.claimId} onClose={() => setOpen(undefined)} /> : null}
    </Section>
  );
}

/** One rule: its sentence and "Forget this", which asks first. */
function RuleDialog({ rule, claimId, onClose }: { rule: ReplyRule; claimId: string; onClose: () => void }) {
  const forget = useForgetMemory();
  const [asking, setAsking] = useState(false);
  return (
    <Dialog open onOpenChange={(next) => !next && onClose()}>
      <DialogContent aria-describedby={undefined} className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>{t("agentCard.replyStyle")}</DialogTitle>
          <DialogDescription className="text-base text-fg">{rule.text}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="destructive" onClick={() => setAsking(true)}>
            {t("agentCard.replyStyleForget")}
          </Button>
        </DialogFooter>
        <AlertDialog open={asking} onOpenChange={setAsking}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>{t("agentCard.replyStyleForgetTitle")}</AlertDialogTitle>
              <AlertDialogDescription>{t("agentCard.replyStyleForgetBody")}</AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
              <AlertDialogAction
                onClick={() => {
                  forget.mutate([claimId], { onError: () => toast.error(t("common.error")) });
                  onClose();
                }}
              >
                {t("agentCard.replyStyleForget")}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </DialogContent>
    </Dialog>
  );
}
