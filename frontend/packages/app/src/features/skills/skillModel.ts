import type { Skill, SkillDepInput, SkillVersion } from "@agent-desktop/client";

/** The text shown for a skill is its active version's; a skill with an empty pointer has no text. */
export function skillName(skill: Skill): string {
  return skill.active?.name ?? "Untitled skill";
}

export function skillDescription(skill: Skill): string {
  return skill.active?.description ?? "";
}

/** A tool this skill uses changed its schema: the skill does not load until the owner turns it on again or rolls back. */
export function needsReview(skill: Skill): boolean {
  return skill.active?.status === "review";
}

export const REVIEW_NOTICE = "A tool this skill uses changed. Review and turn it back on.";

/** The stable code of a refused request (for example SKILL_INVALID or SKILL_NO_PREVIOUS_VERSION), when the error has one. */
export function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error && typeof error.code === "string" ? error.code : undefined;
}

/** The deps as written back on an edit: a tool is named only (the server pins its hash), a connector keeps its catalog id. */
export function depsAsInput(version: SkillVersion | null): SkillDepInput[] {
  return (version?.deps ?? []).map((dep) =>
    dep.type === "tool" ? { type: "tool", name: dep.name } : { type: "connector", catalogId: dep.catalogId },
  );
}
