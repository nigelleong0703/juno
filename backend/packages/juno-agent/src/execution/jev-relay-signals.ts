// Active tool-call signals for the private native relay. A channel may have overlapping calls, so
// shared run signals are reference-counted until every overlapping call finishes.
const active = new Map<string, Map<AbortSignal, number>>();

function key(ownerId: string, agentId: string): string {
  return ownerId + '|' + agentId;
}

export function addJevRelaySignal(ownerId: string, agentId: string, signal: AbortSignal | undefined): void {
  if (signal === undefined) return;
  const id = key(ownerId, agentId);
  const signals = active.get(id) ?? new Map<AbortSignal, number>();
  signals.set(signal, (signals.get(signal) ?? 0) + 1);
  active.set(id, signals);
}

export function removeJevRelaySignal(ownerId: string, agentId: string, signal: AbortSignal | undefined): void {
  if (signal === undefined) return;
  const id = key(ownerId, agentId);
  const signals = active.get(id);
  if (signals === undefined) return;
  const count = signals.get(signal) ?? 0;
  if (count > 1) signals.set(signal, count - 1);
  else signals.delete(signal);
  if (signals.size === 0) active.delete(id);
}

export function getJevRelaySignal(ownerId: string, agentId: string): AbortSignal | undefined {
  const signals = [...(active.get(key(ownerId, agentId))?.keys() ?? [])];
  if (signals.length === 0) return undefined;
  if (signals.length === 1) return signals[0];
  return AbortSignal.any(signals);
}
