import type { CreateSkillInput, Id, UpdateSkillInput } from "@agent-desktop/client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useClient } from "./ClientProvider";

/** Create a skill (version 1, active). */
export function useCreateSkill() {
  const client = useClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateSkillInput) => client.skills.create(input),
    onSettled: () => void qc.invalidateQueries({ queryKey: ["skills"] }),
  });
}

/** Edit a skill: the new text becomes a new active version (the previous one stays for rollback). */
export function useUpdateSkill() {
  const client = useClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, input }: { id: Id; input: UpdateSkillInput }) => client.skills.update(id, input),
    onSettled: () => void qc.invalidateQueries({ queryKey: ["skills"] }),
  });
}

/** A skill's versions, newest first. */
export function useSkillVersions(id: Id) {
  const client = useClient();
  return useQuery({
    queryKey: ["skills", id, "versions"],
    queryFn: () => client.skills.versions(id),
  });
}

/** Turn a version on: the agent loads it from now on. Used for "Turn on" when a tool the skill uses changed. */
export function useActivateSkillVersion() {
  const client = useClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, version }: { id: Id; version: number }) => client.skills.activate(id, version),
    onSettled: () => void qc.invalidateQueries({ queryKey: ["skills"] }),
  });
}

/** Move the active pointer back to the previous version. The server answers 409 when there is none. */
export function useRollbackSkill() {
  const client = useClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: Id) => client.skills.rollback(id),
    onSettled: () => void qc.invalidateQueries({ queryKey: ["skills"] }),
  });
}

export interface SkillAssignmentUpdate {
  agentId: Id;
  skillIds: Id[];
}

export interface SkillAssignmentResult {
  updated: string[];
  failed: Array<{ agentId: string; message: string }>;
}

/**
 * Assign a skill to (or remove it from) several agents in one batch. Every update settles together
 * with Promise.allSettled, so a single pending Save reflects the whole batch and a partial failure
 * is reported instead of being lost. Scoped to the authenticated owner by the client.
 */
export function useAssignSkills() {
  const client = useClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (updates: SkillAssignmentUpdate[]): Promise<SkillAssignmentResult> => {
      const settled = await Promise.allSettled(
        updates.map((update) => client.agents.update(update.agentId, { skillIds: update.skillIds })),
      );
      const updated: string[] = [];
      const failed: Array<{ agentId: string; message: string }> = [];
      settled.forEach((outcome, index) => {
        const agentId = updates[index]?.agentId ?? "";
        if (outcome.status === "fulfilled") updated.push(agentId);
        else {
          failed.push({
            agentId,
            message: outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason),
          });
        }
      });
      return { updated, failed };
    },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: ["agents"] });
      void qc.invalidateQueries({ queryKey: ["skills"] });
    },
  });
}
