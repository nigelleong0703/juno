import type { Agent, ComposerPayload, Conversation } from "@agent-desktop/client";
import { useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { useNavigate } from "react-router";
import { useClient } from "../../data/ClientProvider";
import { errorCode } from "../../data/model-providers";
import { t } from "../../lib/i18n";
import { useUiStore, type ComposeRecipient } from "../../store/ui";
import {
  findDirectFor,
  GROUP_MAX,
  GROUP_MIN,
  memberNamesTitle,
  newRequestId,
  type Busy,
  type RetryKind,
} from "./composeModel";
import { FIRST_AGENT_COPY } from "./firstAgentCopy";
import { useStartConversation } from "./useStartConversation";

interface ComposeEntryParams {
  conversations: Conversation[] | undefined;
  agentById: Map<string, Agent>;
}

export interface ComposeEntryActions {
  busy: Busy;
  error: string | null;
  retryKind: RetryKind;
  firstAgentName: string;
  setFirstAgentName: (value: string) => void;
  setError: (message: string) => void;
  creatingAgent: boolean;
  pending: boolean;
  sendFailed: boolean;
  goTo: (conversationId: string) => void;
  clearStatus: () => void;
  openDirect: (agentId: string) => Promise<void>;
  createAgentThenOpen: (name?: string) => Promise<void>;
  createGroup: (selectedIds: string[], firstMessage?: ComposerPayload) => Promise<void>;
  handleComposerSend: (selectedIds: string[], payload: ComposerPayload) => void;
  retryError: (selectedIds: string[]) => void;
}

/**
 * The network half of the new-message draft: opening or creating the 1:1 / room a
 * pick lands on, plus the create-agent card. Owns busy/error/retry status and the
 * stable per-intent requestIds, so a retry after an ambiguous POST reuses the
 * thread instead of duplicating it. The picker owns selection and passes it to the
 * actions that need it (group create, send, retry).
 */
export function useComposeEntry({
  conversations,
  agentById,
}: ComposeEntryParams): ComposeEntryActions {
  const navigate = useNavigate();
  const client = useClient();
  const qc = useQueryClient();
  const start = useStartConversation();

  const [busy, setBusy] = useState<Busy>(null);
  const [error, setError] = useState<string | null>(null);
  const [retryKind, setRetryKind] = useState<RetryKind>(null);
  const [firstAgentName, setFirstAgentName] = useState("");
  const [creatingAgent, setCreatingAgent] = useState(false);

  const directRetryId = useRef<string | null>(null);
  const roomRequestIds = useRef(new Map<string, string>());
  const directRequestIds = useRef(new Map<string, string>());
  const createAttempt = useRef<{ name?: string; agentId?: string; requestId: string } | null>(null);
  const lastIntent = useRef<{ recipients: ComposeRecipient[]; payload: ComposerPayload } | null>(
    null,
  );

  const goTo = (conversationId: string) => navigate("/c/" + conversationId);

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ["agents"] });
    void qc.invalidateQueries({ queryKey: ["conversations"] });
  };

  const clearStatus = () => {
    setError(null);
    setRetryKind(null);
  };

  /** Open an existing 1:1, creating it only when the lookup finds nothing. */
  const openDirect = async (agentId: string) => {
    if (busy !== null) return;
    setBusy("open");
    setError(null);
    setRetryKind(null);
    try {
      const listed = await client.conversations.list({ agentId, kind: "direct" });
      const direct = findDirectFor(conversations, agentId) ?? findDirectFor(listed.items, agentId);
      if (direct !== undefined) {
        refresh();
        goTo(direct.id);
        return;
      }
      // Stable per-agent requestId: a retry after an ambiguous POST resolves to
      // the same thread instead of opening a duplicate private chat.
      let requestId = directRequestIds.current.get(agentId);
      if (requestId === undefined) {
        requestId = newRequestId();
        directRequestIds.current.set(agentId, requestId);
      }
      const created = await client.conversations.create({
        kind: "direct",
        memberAgentIds: [agentId],
        requestId,
      });
      directRequestIds.current.delete(agentId);
      refresh();
      goTo(created.id);
    } catch {
      setError(FIRST_AGENT_COPY.firstAgentSendFailed);
      // The picker stays open on failure with an actionable retry: the lookup
      // runs again first, so a retry after a partial create reuses the thread.
      directRetryId.current = agentId;
      setRetryKind("open-direct");
    } finally {
      setBusy(null);
    }
  };

  /**
   * Create one agent and open its chat immediately — no first message required.
   * A brand-new agent cannot have a chat yet, so the direct create is exact:
   * one agent call plus one conversation call. The attempt retains the created
   * agent and a stable direct requestId, so a retry after an ambiguous POST
   * failure resolves to the same thread instead of duplicating either.
   * An omitted name is the blank "New agent" row: the server names it. A given
   * name must not be blank; a name the owner already uses comes back 409 and its
   * message is shown, so the name can be changed.
   */
  const createAgentThenOpen = async (name?: string) => {
    if (busy !== null || creatingAgent) return;
    const trimmed = name?.trim();
    if (trimmed === "") {
      setError(FIRST_AGENT_COPY.firstAgentNameRequired);
      return;
    }
    setError(null);
    setRetryKind(null);
    if (createAttempt.current === null || createAttempt.current.name !== trimmed) {
      createAttempt.current = { name: trimmed, requestId: newRequestId() };
    }
    const attempt = createAttempt.current;
    setCreatingAgent(true);
    try {
      let agentId = attempt.agentId;
      if (agentId === undefined) {
        const agent = await client.agents.create(trimmed === undefined ? {} : { name: trimmed });
        agentId = agent.id;
        attempt.agentId = agentId;
        void qc.invalidateQueries({ queryKey: ["agents"] });
      }
      const conversation = await client.conversations.create({
        kind: "direct",
        memberAgentIds: [agentId],
        requestId: attempt.requestId,
      });
      createAttempt.current = null;
      setRetryKind(null);
      void qc.invalidateQueries({ queryKey: ["conversations"] });
      // An inspiration starter with no agent yet: its text waits in the new agent's composer.
      const { starterText, setStarterText, setComposerPrefill } = useUiStore.getState();
      if (starterText) {
        setComposerPrefill({ conversationId: conversation.id, text: starterText });
        setStarterText(null);
      }
      goTo(conversation.id);
    } catch (err) {
      const { code, message } = errorCode(err);
      if (code === "AGENT_NAME_TAKEN") {
        // The name is the user's to change; a retry with the same name would fail again.
        setError(message ?? FIRST_AGENT_COPY.firstAgentCreateFailed);
        return;
      }
      setError(FIRST_AGENT_COPY.firstAgentCreateFailed);
      setRetryKind("create-agent");
    } finally {
      setCreatingAgent(false);
    }
  };

  /** Open the selected members as a room. A first message is optional. */
  const createGroup = async (selectedIds: string[], firstMessage?: ComposerPayload) => {
    if (busy !== null) return;
    if (selectedIds.length < GROUP_MIN) {
      setError(FIRST_AGENT_COPY.groupTooFew);
      return;
    }
    if (selectedIds.length > GROUP_MAX) {
      setError(FIRST_AGENT_COPY.groupTooMany);
      return;
    }
    setBusy("group");
    setError(null);
    setRetryKind(null);
    try {
      const key = [...selectedIds].sort().join(",");
      let requestId = roomRequestIds.current.get(key);
      if (requestId === undefined) {
        requestId = newRequestId();
        roomRequestIds.current.set(key, requestId);
      }
      // User-created groups default to mention (GH2 group UX) so plain kickoff
      // text wakes nobody until someone is @mentioned. (Replaces open_floor.)
      const MENTION = "mention";
      const roomExtras = { roomMode: MENTION };
      // The room carries its members' actual display names (verified in CX runtime).
      const title = memberNamesTitle(selectedIds, agentById);
      const conversation = await client.conversations.create({
        kind: "room",
        memberAgentIds: [...selectedIds],
        ...(title === "" ? {} : { title }),
        requestId,
        ...(firstMessage === undefined ? {} : { firstMessage }),
        ...roomExtras,
      });
      roomRequestIds.current.delete(key);
      refresh();
      goTo(conversation.id);
    } catch {
      setError(FIRST_AGENT_COPY.groupCreateFailed);
      setRetryKind("create-group");
    } finally {
      setBusy(null);
    }
  };

  /** The shared composer's submit: open the picked group with this first message. */
  const handleComposerSend = (selectedIds: string[], payload: ComposerPayload) => {
    if (busy !== null || start.isPending) return;
    setError(null);
    setRetryKind(null);
    const recipients: ComposeRecipient[] = [];
    for (const id of selectedIds) {
      recipients.push({
        key: id,
        kind: "agent",
        agentId: id,
        name: agentById.get(id)?.name ?? t("compose.newAgentName"),
      });
    }
    if (recipients.length === 0) return;
    lastIntent.current = { recipients, payload };
    start.mutate(
      { recipients, payload },
      {
        onSuccess: (conversationId) => goTo(conversationId),
        onError: () => setRetryKind("send"),
      },
    );
  };

  const retryLast = () => {
    const intent = lastIntent.current;
    if (intent === null || start.isPending) return;
    start.mutate(intent, {
      onSuccess: (conversationId) => goTo(conversationId),
      onError: () => setRetryKind("send"),
    });
  };

  const retryError = (selectedIds: string[]) => {
    if (retryKind === "open-direct" && directRetryId.current !== null) {
      const agentId = directRetryId.current;
      directRetryId.current = null;
      void openDirect(agentId);
      return;
    }
    if (retryKind === "send") {
      retryLast();
      return;
    }
    if (retryKind === "create-group") {
      void createGroup(selectedIds);
      return;
    }
    if (retryKind === "create-agent" && createAttempt.current !== null) {
      void createAgentThenOpen(createAttempt.current.name);
    }
  };

  const sendFailed = start.isError && lastIntent.current !== null;

  return {
    busy,
    error,
    retryKind,
    firstAgentName,
    setFirstAgentName,
    setError,
    creatingAgent,
    pending: start.isPending,
    sendFailed,
    goTo,
    clearStatus,
    openDirect,
    createAgentThenOpen,
    createGroup,
    handleComposerSend,
    retryError,
  };
}
