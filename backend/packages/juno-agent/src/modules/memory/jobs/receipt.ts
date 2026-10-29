/** `self_improvement/<date>-<job>.md`: what a background job read and changed (BACKEND §5.1). Written by code, not by the model. */
import type { HomeDeps } from '../../home/service.js';
import { localDate, localTime } from '../../home/paths.js';
import { editHomeFile } from '../files.js';

export async function appendReceipt(
  deps: HomeDeps,
  input: { ownerId: string; agentId: string; job: 'digest' | 'dream'; now: Date; timeZone?: string; lines: string[] },
): Promise<void> {
  const date = localDate(input.now, input.timeZone);
  const section = '## ' + localTime(input.now, input.timeZone) + '\n' + input.lines.map((line) => '- ' + line.replace(/\s+/g, ' ')).join('\n') + '\n';
  await editHomeFile(deps, { ownerId: input.ownerId, agentId: input.agentId, path: 'self_improvement/' + date + '-' + input.job + '.md' }, (content) =>
    (content.length === 0 ? '# ' + (input.job === 'digest' ? 'Chat digest' : 'Nightly dream') + ', ' + date + '\n\n' : content.replace(/\n*$/, '\n\n')) + section);
}
