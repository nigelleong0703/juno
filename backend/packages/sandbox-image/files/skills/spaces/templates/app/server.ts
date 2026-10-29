import { readFileSync } from 'node:fs';
import { desc } from 'drizzle-orm';
import { Hono } from 'hono';
import { serveStatic } from 'hono/bun';
import { db } from './db';
import { notes } from './schema';

const app = new Hono();

// API: add routes under /api. The built client in dist/ is served for everything else.
app.get('/api/notes', (c) => c.json(db.select().from(notes).orderBy(desc(notes.id)).all()));
app.post('/api/notes', async (c) => {
  const body = await c.req.json<{ text?: string }>();
  const text = body.text?.trim();
  if (!text) return c.json({ error: 'text is required' }, 400);
  const [row] = db.insert(notes).values({ text, createdAt: new Date().toISOString() }).returning().all();
  return c.json(row, 201);
});

app.use('*', serveStatic({ root: './dist' }));
app.get('*', serveStatic({ path: './dist/index.html' }));

// The platform gives this app one port (PORT, or .juno-port); listen on loopback only: the gateway is the way in.
const port = Number(process.env.PORT ?? readFileSync('.juno-port', 'utf8').trim());
Bun.serve({ hostname: '127.0.0.1', port, fetch: app.fetch });
console.log(`listening on http://127.0.0.1:${port}`);
