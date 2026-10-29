// A turn whose approvals are answered by a callback instead of by the loop.
// The callback decides; the SDK sends the decision and the run carries on.
//   JUNO_BASE_URL=... JUNO_TOKEN=... JUNO_AGENT_ID=... node examples/approval.ts
import { createJuno, type Request } from '@juno/sdk';

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Set ${name} first`);
  return value;
}

/** Stand-in for asking the owner: approve only a send to the address in JUNO_APPROVED_TARGET, deny the rest. */
async function askOwner(request: Request): Promise<{ action: 'approve' | 'deny' }> {
  const payload = request.payload;
  const target = payload.kind === 'approval' ? (payload.target ?? '') : '';
  console.log(`\n[approval] ${request.title} -> ${target || '(no target)'}`);
  return { action: target !== '' && target === process.env.JUNO_APPROVED_TARGET ? 'approve' : 'deny' };
}

const juno = createJuno({ baseUrl: requireEnv('JUNO_BASE_URL'), token: requireEnv('JUNO_TOKEN') });
const chat = await juno.chat({ agentId: requireEnv('JUNO_AGENT_ID') });

for await (const event of chat.send('Email the weekly summary to the team.', { onApproval: askOwner })) {
  if (event.type === 'text-delta') process.stdout.write(event.text);
  if (event.type === 'done') console.log(`\n[run ${event.run.status}]`);
}

await juno.close();
