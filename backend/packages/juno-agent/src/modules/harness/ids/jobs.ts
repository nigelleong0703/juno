/** Placement S: background-job and auxiliary prompts (nightly, tidy, topics, digest, ideas, briefing, compaction, run aux). */
export const JOB_IDS = [
  'job.nightly.dream',
  'job.nightly.alignment',
  'job.tidy.system',
  'job.topics.system',
  'job.digest.system',
  'job.ideas.system',
  'job.ideas.notice_wake',
  'job.briefing.system',
  'compaction.handoff',
  'compaction.topics_by_date',
  'compaction.prefix_summary',
  'compaction.merge_earlier',
  'compaction.earlier_turns',
  'aux.role_suggestion',
  'aux.step_lines',
] as const;
