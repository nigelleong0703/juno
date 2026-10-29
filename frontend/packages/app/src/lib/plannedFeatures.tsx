import { createContext, useContext } from "react";

/**
 * Prototype-only data (MUSE-PARITY step 7). The agent card, the agent pane and the agent page are
 * the production design now and read live queries (goals, runs, audit, routines, memories, requests),
 * so production passes no provider and nothing here is needed to render them. The prototype
 * (`packages/prototype`) passes its mock world through `<App planned>`; this context only carries
 * what the backend cannot serve.
 */
/** Muse splits goals into concrete watches ("tracking") and longer aims ("goal"). Not read by the app any more (live: `useGoals`); kept for the prototype's iOS fixture export. */
export interface PlannedGoal {
  id: string;
  agentId: string;
  kind: "tracking" | "goal";
  title: string;
  /** One line on where it stands, e.g. "First practice is Sep 17 – 10 days out". */
  summary: string;
}

export interface PlannedFeatures {
  /** @deprecated Not read by the app; goals come from the live `useGoals` hook. */
  goals: PlannedGoal[];
  /** Prototype-only fallback for the one-line "what it is doing now" per agent id; `agent.doing` (live) wins. */
  doing: Record<string, string>;
}

const PlannedFeaturesContext = createContext<PlannedFeatures | null>(null);

export const PlannedFeaturesProvider = PlannedFeaturesContext.Provider;

/** Null in production; the prototype's mock data otherwise. Only the `doing` fallback reads it. */
export function usePlannedFeatures(): PlannedFeatures | null {
  return useContext(PlannedFeaturesContext);
}
