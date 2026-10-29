import { type Computer, type ComputerState } from "@agent-desktop/client";
import { useMemo } from "react";

/**
 * Computer state for the Computer pane (E2). The mock/real backend streams `computer.state` events
 * (computer-level state + controller), and `data/liveSync.ts` folds those straight into the cached
 * `Computer`.
 */
export interface ComputerStateInfo {
  /** The computer for this agent. */
  computer: Computer;
  /** Effective state: the computer's live state. */
  state: ComputerState;
  /**
   * True when an `agentId` was given but no computer matches (a brand-new agent).
   * The caller should show the asleep state.
   */
  missing: boolean;
}

/** Pure resolution of a computer's state from a live computer snapshot. */
export function resolveComputerState(
  computer: Computer | undefined,
): ComputerStateInfo | undefined {
  if (!computer) return undefined;
  return {
    computer,
    state: computer.state,
    missing: false,
  };
}

/**
 * Resolve the sandbox computer an agent uses: the one whose `agentIds` include the agent. A shared computer's `agentIds` can
 * stay empty, so one with none listed also counts; matching on agentIds alone showed "no virtual computer" for agents with a
 * live screen. (The owner's Mac is not a computer record here: see `Agent.macAccess`.)
 */
export function resolveAgentComputer(computers: Computer[] | undefined, agentId: string | undefined): Computer | undefined {
  if (!computers || computers.length === 0 || !agentId) return undefined;
  return computers.find((c) => c.agentIds.includes(agentId)) ?? computers.find((c) => c.agentIds.length === 0);
}

/**
 * Reactive computer state. Because the computer object comes from the query cache that `liveSync`
 * keeps warm from `computer.state` events, this re-renders whenever the stream reports a change.
 */
export function useComputerState(computer: Computer | undefined): ComputerStateInfo | undefined {
  return useMemo(
    () => resolveComputerState(computer),
    [computer],
  );
}
