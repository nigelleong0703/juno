// One chat turn with an agent, printed as it streams.
// Build the package first (pnpm --filter @juno/sdk build), then run:
//   JUNO_BASE_URL=... JUNO_TOKEN=... JUNO_AGENT_ID=... node examples/chat-turn.ts
import { createJuno } from '@juno/sdk';

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Set ${name} first`);
  return value;
}

const juno = createJuno({ baseUrl: requireEnv('JUNO_BASE_URL'), token: requireEnv('JUNO_TOKEN') });
const chat = await juno.chat({ agentId: requireEnv('JUNO_AGENT_ID') });

for await (const event of chat.send('What can you help me with today?')) {
  switch (event.type) {
    case 'text-delta':
      process.stdout.write(event.text);
      break;
    case 'message':
      console.log(`\n[${event.item.type}]`);
      break;
    case 'tool':
      console.log(`\n[tool ${event.name}: ${event.status}]`);
      break;
    case 'request':
      console.log(`\n[waiting on you: ${event.request.title}]`);
      break;
    case 'done':
      console.log(`\n[run ${event.run.status}]`);
      break;
  }
}

await juno.close();
