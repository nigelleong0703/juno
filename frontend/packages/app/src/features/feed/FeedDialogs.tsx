import type { FeedbackInput, FeedPost } from "@agent-desktop/client";
import { Button, Dialog, DialogContent, DialogDescription, DialogTitle, Input } from "@agent-desktop/ui";
import { useMemo, useState } from "react";
import { ChatRow } from "../../components/agent/ChatRow";
import { useAgents, useConversations } from "../../data/queries";
import { t } from "../../lib/i18n";
import { buildAgentIndex, buildChatEntries } from "../../shell/sidebar/chatEntries";
import { ShowMore, useCapped } from "../agents/card/parts";

const REASONS = ["topic", "frequency", "known", "source"] as const;
const NOTE_MAX = 200;

/** "Forward to": any chat (search filters), picked to send the post there. */
export function FeedForwardDialog({ onPick, onClose }: { onPick: (conversationId: string) => void; onClose: () => void }) {
  const { data: agents } = useAgents();
  const { data: conversations } = useConversations();
  const [search, setSearch] = useState("");
  const agentById = useMemo(() => buildAgentIndex(agents), [agents]);
  const entries = useMemo(
    () => buildChatEntries(conversations, agentById, search, t("chat.untitled")).filter((entry) => entry.conversation.kind !== "peer"),
    [conversations, agentById, search],
  );
  const capped = useCapped(entries);

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="flex max-h-[80vh] max-w-md flex-col gap-3">
        <DialogTitle>{t("feed.forwardTo")}</DialogTitle>
        <DialogDescription className="sr-only">{t("feed.forwardTo")}</DialogDescription>
        <Input value={search} onChange={(event) => setSearch(event.target.value)} placeholder={t("feed.searchChats")} aria-label={t("feed.searchChats")} />
        <div className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto">
          {entries.length === 0 ? <p className="py-6 text-center text-sm text-fg-muted">{t("feed.noChats")}</p> : null}
          {capped.shown.map((entry) => (
            <ChatRow
              key={entry.conversation.id}
              conversation={entry.conversation}
              agents={entry.agents}
              onOpen={() => {
                onPick(entry.conversation.id);
                onClose();
              }}
            />
          ))}
          <ShowMore hidden={capped.hidden} onClick={capped.showMore} />
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** "Why isn't this for you?": a reason sends "less" with it; "Something else…" asks for a few words (at most 200). */
export function FeedReasonDialog({ post, onSubmit, onClose }: { post: FeedPost; onSubmit: (input: FeedbackInput) => void; onClose: () => void }) {
  const [other, setOther] = useState(false);
  const [note, setNote] = useState("");
  const choose = (input: FeedbackInput) => {
    onSubmit(input);
    onClose();
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-sm gap-3" aria-label={post.title}>
        <DialogTitle>{t("feed.reasonTitle")}</DialogTitle>
        <DialogDescription className="sr-only">{post.title}</DialogDescription>
        {other ? (
          <>
            <Input autoFocus maxLength={NOTE_MAX} value={note} onChange={(event) => setNote(event.target.value)} placeholder={t("feed.reasonNote")} aria-label={t("feed.reasonNote")} />
            <Button className="self-end rounded-full" onClick={() => choose({ signal: "less", reason: "other", ...(note.trim() ? { note: note.trim() } : {}) })}>
              {t("feed.reasonDone")}
            </Button>
          </>
        ) : (
          <div className="flex flex-col gap-1">
            {REASONS.map((reason) => (
              <Button key={reason} variant="ghost" className="justify-start rounded-lg" onClick={() => choose({ signal: "less", reason })}>
                {t(`feed.reason.${reason}`)}
              </Button>
            ))}
            <Button variant="ghost" className="justify-start rounded-lg" onClick={() => setOther(true)}>
              {t("feed.reason.other")}
            </Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
