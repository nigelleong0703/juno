/**
 * `computer_copy` (BACKEND §7.11): move a file or a folder between an agent's sandbox and the owner's Mac. computerd holds both
 * computers, reads from one side and writes to the other, and the bytes never pass through the model. What may be read or
 * written is decided where the bytes are touched: the sandbox side acts as the agent's own Linux user, the Mac's daemon refuses
 * anything outside its shared folders. Whether the owner is asked first is the tool policy's job (it sees the same paths).
 */
import { ComputerdError, failed, notAllowed, type ComputerProvider, type TransferSide } from '@agent-desktop/sandbox-adapters';
import type { E2bBinding } from '@agent-desktop/contracts';
import type { MacComputer } from '../mac/mac-computer.js';

/** Largest file or folder archive one copy moves. */
export const MAX_COPY_BYTES = 32 * 1024 * 1024;

export type CopySide = 'sandbox' | 'mac';

export interface CopyRequest {
  from: CopySide;
  to: CopySide;
  path: string;
  toPath: string;
}

export interface CopyResult {
  toPath: string;
  bytes: number;
  kind: 'file' | 'folder';
}

export async function copyBetweenComputers(
  deps: { provider: ComputerProvider; binding: E2bBinding; mac?: MacComputer },
  agentId: string,
  request: CopyRequest,
  signal: AbortSignal,
): Promise<CopyResult> {
  if (request.from === request.to) throw failed('from and to are the same computer');
  const onSide = <T>(side: CopySide, fn: (transfer: TransferSide) => Promise<T>): Promise<T> => {
    if (side === 'sandbox') return deps.provider.withTransfer(deps.binding, agentId, signal, fn);
    if (!deps.mac) throw notAllowed('My Mac is not available on this deployment');
    return deps.mac.withTransfer(signal, fn);
  };
  const where = (side: CopySide) => (side === 'mac' ? 'your Mac' : 'the sandbox');
  const payload = await onSide(request.from, async (side) => {
    const kind = await side.kindOf(request.path, signal);
    if (kind === 'missing') throw new ComputerdError('failed', `${request.path} does not exist on ${where(request.from)}`);
    const bytes = kind === 'file' ? await side.readFile(request.path, signal) : await side.readFolder(request.path, signal);
    return { kind, bytes };
  });
  if (payload.bytes.length > MAX_COPY_BYTES) {
    throw failed(`${request.path} is larger than ${MAX_COPY_BYTES / 1024 / 1024} MiB, the most one copy moves${payload.kind === 'folder' ? ' (a folder is packed first)' : ''}; copy a smaller part`);
  }
  await onSide(request.to, (side) => (payload.kind === 'file' ? side.writeFile(request.toPath, payload.bytes, signal) : side.writeFolder(request.toPath, payload.bytes, signal)));
  return { toPath: request.toPath, bytes: payload.bytes.length, kind: payload.kind };
}
