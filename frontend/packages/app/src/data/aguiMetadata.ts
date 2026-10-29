import type { AgentEvent, JunoEventMetadata } from "@agent-desktop/client";

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function junoRecordOf(metadata: unknown): Record<string, unknown> | undefined {
  if (!isRecord(metadata)) return undefined;
  return isRecord(metadata["juno"]) ? metadata["juno"] : undefined;
}

function optionalString(value: Record<string, unknown>, key: string): boolean {
  return value[key] === undefined || typeof value[key] === "string";
}

function optionalNumber(value: Record<string, unknown>, key: string): boolean {
  return value[key] === undefined || (typeof value[key] === "number" && Number.isFinite(value[key]));
}

function optionalBoolean(value: Record<string, unknown>, key: string): boolean {
  return value[key] === undefined || typeof value[key] === "boolean";
}

export function isJunoMetadata(value: unknown): value is JunoEventMetadata {
  if (!isRecord(value)) return false;
  return ["agentId", "conversationId", "runId", "attemptId", "requestId", "stepId", "runStatus"].every((key) => optionalString(value, key)) &&
    ["generationId", "seq"].every((key) => optionalNumber(value, key)) && optionalBoolean(value, "truncated");
}

export function junoOf(event: AgentEvent): JunoEventMetadata | undefined {
  if (!("metadata" in event)) return undefined;
  const juno = junoRecordOf(event.metadata);
  return isJunoMetadata(juno) ? juno : undefined;
}

export function atOf(timestamp: number | undefined): string {
  return new Date(timestamp ?? Date.now()).toISOString();
}
