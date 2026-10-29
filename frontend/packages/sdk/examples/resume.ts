// Resume a conversation by id: a later process picks up the same chat and reads its reply.
// Pass the id a previous run printed (or one from the app) as JUNO_CONVERSATION_ID.
//   JUNO_BASE_URL=... JUNO_TOKEN=... JUNO_CONVERSATION_ID=... node examples/resume.ts
import { createJuno } from '@juno/sdk';

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Set ${name} first`);
  return value;
}

const juno = createJuno({ baseUrl: requireEnv('JUNO_BASE_URL'), token: requireEnv('JUNO_TOKEN') });
const chat = await juno.chat({ conversationId: requireEnv('JUNO_CONVERSATION_ID') });
console.log(`resumed conversation ${chat.id}: ${chat.conversation.title ?? 'direct chat'}`);

for await (const event of chat.send('Where did we leave off?')) {
  if (event.type === 'text-delta') process.stdout.write(event.text);
  if (event.type === 'done') console.log(`\n[run ${event.run.status}]`);
}

await juno.close();
