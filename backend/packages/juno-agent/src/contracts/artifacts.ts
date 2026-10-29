/**
 * Private tool-output artifacts (PH9). When a tool result is too large to deliver in full, the
 * redacted text is retained HERE — an owner/agent-scoped store collection, never the prompt
 * transcript — and the model gets a bounded notice with a reference it can page through
 * `output_read`. Nothing in this shape is user-facing: it is internal storage only.
 */
export interface OutputArtifact {
  id: string;
  /** The authenticated owner the artifact belongs to; reads require an exact match. */
  ownerId: string;
  /** The agent whose tool produced it; reads require an exact match. */
  agentId: string;
  runId: string;
  /** The step that produced it: makes capture idempotent, so a replay reuses one artifact. */
  stepId: string;
  tool: string;
  /** Redacted text, capped at the hard limit. */
  text: string;
  chars: number;
  bytes: number;
  /** Characters the tool produced before the hard cap; > chars means the artifact is capped. */
  originalChars: number;
  sha256: string;
  truncated: boolean;
  createdAt: string;
  expiresAt: string;
}
