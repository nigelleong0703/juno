import type { Agent, Conversation } from "@agent-desktop/client";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { useUiStore } from "../../store/ui";
import {
  composeRows,
  GROUP_MAX,
  GROUP_MIN,
  matchingAgents,
  matchingGroups,
  type Row,
} from "./composeModel";
import { FIRST_AGENT_COPY } from "./firstAgentCopy";
import type { ComposeEntryActions } from "./useComposeEntry";

interface ComposePickerParams {
  agents: Agent[] | undefined;
  agentsLoading: boolean;
  agentById: Map<string, Agent>;
  conversations: Conversation[] | undefined;
  entry: ComposeEntryActions;
}

/**
 * The picker half of the new-message draft: the "To" query, the open dropdown and
 * its keyboard, group-mode membership (2–6) and the derived rows the list renders.
 * Entry actions arrive from useComposeEntry; selection lives here and is read back
 * by the root for the group actions and the shared composer.
 */
export function useComposePicker({
  agents,
  agentsLoading,
  agentById,
  conversations,
  entry,
}: ComposePickerParams) {
  const navigate = useNavigate();
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(true);
  const [cursor, setCursor] = useState(0);
  const [groupMode, setGroupMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);
  const seeded = useRef(false);

  // The seed below runs once; it reads the opener through a ref so the effect
  // itself needs no unstable dependency, while still calling the latest one.
  const openDirectRef = useRef(entry.openDirect);
  useEffect(() => {
    openDirectRef.current = entry.openDirect;
  }, [entry.openDirect]);

  // A mention "Message" action for an agent without a chat lands here with the
  // recipient pre-seeded: one agent opens its 1:1 at once, several become a group.
  useEffect(() => {
    if (seeded.current) return;
    seeded.current = true;
    const seeds = useUiStore.getState().composeRecipients;
    if (seeds.length === 0) return;
    const ids = seeds.flatMap((seed) => (seed.agentId ? [seed.agentId] : []));
    useUiStore.getState().clearCompose();
    if (ids.length <= 1 && ids[0] !== undefined) {
      void openDirectRef.current(ids[0]);
      return;
    }
    if (ids.length > 1) {
      setGroupMode(true);
      setSelectedIds(ids.slice(0, GROUP_MAX));
    }
  }, []);

  const showFirstAgent = !agentsLoading && (agents ?? []).length === 0;

  useLayoutEffect(() => {
    if (showFirstAgent) return;
    if (open) inputRef.current?.focus();
  }, [showFirstAgent, open, groupMode]);

  const needle = query.trim().toLowerCase();
  const matching = matchingAgents(agents ?? [], selectedIds, needle);
  const groups = matchingGroups(conversations ?? [], agentById, needle);
  const rows: Row[] = composeRows(groupMode, matching, groups);
  const safeCursor = rows.length === 0 ? 0 : Math.min(cursor, rows.length - 1);

  const selectedAgents = selectedIds.flatMap((id) => {
    const agent = agentById.get(id);
    return agent ? [agent] : [];
  });
  const canCreateGroup =
    groupMode && selectedIds.length >= GROUP_MIN && selectedIds.length <= GROUP_MAX;

  const onQueryChange = (value: string) => {
    setQuery(value);
    setCursor(0);
    setOpen(true);
  };

  const onFocusInput = () => setOpen(true);

  const toggleMember = (agentId: string) => {
    entry.clearStatus();
    setSelectedIds((prev) => {
      if (prev.includes(agentId)) return prev.filter((id) => id !== agentId);
      if (prev.length >= GROUP_MAX) {
        entry.setError(FIRST_AGENT_COPY.groupTooMany);
        return prev;
      }
      return [...prev, agentId];
    });
  };

  const choose = (index: number) => {
    const row = rows[index];
    if (row === undefined || entry.busy !== null || entry.creatingAgent) return;
    if (row.kind === "create") {
      void entry.createAgentThenOpen();
      return;
    }
    if (row.kind === "group-entry") {
      setGroupMode(true);
      setQuery("");
      setCursor(0);
      setOpen(true);
      return;
    }
    if (row.kind === "group") {
      entry.goTo(row.conversation.id);
      return;
    }
    if (groupMode) {
      toggleMember(row.agent.id);
      return;
    }
    void entry.openDirect(row.agent.id);
  };

  const exitGroupMode = () => {
    setGroupMode(false);
    setSelectedIds([]);
    setQuery("");
    setCursor(0);
    setOpen(true);
    entry.clearStatus();
  };

  const onEscape = () => {
    if (groupMode) {
      exitGroupMode();
      return;
    }
    if (open) {
      setOpen(false);
      return;
    }
    void navigate(-1);
  };

  const onMoveCursor = (direction: 1 | -1) => {
    setCursor((current) =>
      direction === 1 ? Math.min(current + 1, rows.length - 1) : Math.max(current - 1, 0),
    );
  };

  const onEnter = () => {
    if (open) choose(safeCursor);
  };

  return {
    query,
    open,
    groupMode,
    selectedIds,
    selectedAgents,
    rows,
    safeCursor,
    showFirstAgent,
    canCreateGroup,
    inputRef,
    onQueryChange,
    onFocusInput,
    toggleMember,
    choose,
    exitGroupMode,
    onEscape,
    onMoveCursor,
    onEnter,
    onHoverRow: setCursor,
  };
}
