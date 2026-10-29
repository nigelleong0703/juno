import { useState } from "react";
import { useNavigate } from "react-router";
import { TaskCard } from "../features/agents/card/TaskCard";
import { ConversationContainer } from "../features/conversation/ConversationContainer";
import { usePlatform } from "../data/ClientProvider";

export interface ConversationPageProps {
  conversationId: string;
}

/**
 * The Conversation template (ARCHITECTURE §5.5): the whole of §4.3 — header, transcript and
 * composer — with routing wired in. Direct chats and rooms render through it;
 * only the `conversationId` differs. Every way into a piece of work (footer, working pill, failed row, child run)
 * opens the one TaskCard.
 */
export function ConversationPage({ conversationId }: ConversationPageProps) {
  const navigate = useNavigate();
  const platform = usePlatform();
  const [openRunId, setOpenRunId] = useState<string | null>(null);

  return (
    <>
      <ConversationContainer
        conversationId={conversationId}
        onOpenRun={setOpenRunId}
        onOpenRoutine={(routineId) => navigate(`/automations/${routineId}`)}
        onOpenSignin={(request) => {
          if (request.payload.kind === "signin") platform.openExternal(request.payload.url);
        }}
      />
      <TaskCard runId={openRunId} onClose={() => setOpenRunId(null)} />
    </>
  );
}
