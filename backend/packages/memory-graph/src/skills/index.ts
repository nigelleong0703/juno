/** Versioned skills (migration 0049): definitions, immutable versions, the dependency recheck and the write-time checks. Platform skills (0051): seeded versions, line-operation patches, canary. */
export * from './types.js';
export { createSkillsService, depsFromInput, MAX_DEPS, MAX_SELECTED_IDS, type SkillsService } from './service.js';
export { canonicalJson, schemaHash, toolHashes } from './hash.js';
export { findSkillProblem, redactPersonal, validateSkillText, MAX_SKILL_NAME_CHARS, MAX_SKILL_DESCRIPTION_CHARS, MAX_SKILL_INSTRUCTION_CHARS } from './validate.js';
export * from './evolve.js';
export { applyLineOps, findInjectedContent, opHash, parseLineOp, planLineOps, type LineOp, type LinePlan, type RejectedOp } from './patch.js';
export {
  createPlatformSkillsService, parsePlatformSkillFile,
  type CandidateDecision, type CandidateReview, type PlatformSkillFile, type PlatformSkillsService, type PlatformSkillVersion, type SkillReader, type SourceGate, type PlatformStatus,
  type ResolvedPlatformSkill, type SeedReport, type SkillMetrics, type VersionMetrics,
} from './platform.js';
export { platformSkillsDir, readPlatformSkillFiles, seedPlatformSkills } from './platform-files.js';
