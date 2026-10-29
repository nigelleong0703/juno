/** Request schemas for computerd's internal API. Every call also carries \`x-agent-id\`. */
import { z } from 'zod';
import { MAX_INSTALL_PACKAGES, PACKAGE_NAME, browserInputSchema, meetInputSchema } from '@agent-desktop/sandbox-adapters';

export const agentHeaderSchema = z.string().min(1);

export const clickSchema = z.object({
  x: z.number().finite(),
  y: z.number().finite(),
  button: z.enum(['left', 'right', 'middle']).optional(),
});

export const typeSchema = z.object({ text: z.string() });
export const keySchema = z.object({ key: z.string().min(1) });
export const scrollSchema = z.object({ deltaY: z.number().finite(), deltaX: z.number().finite().optional() });
export const navigateSchema = z.object({ url: z.string().min(1) });
export const shellSchema = z.object({
  command: z.string().min(1),
  timeoutMs: z.number().int().positive().max(600_000).optional(),
  cwd: z.string().min(1).optional(),
});
export const fileReadSchema = z.object({ path: z.string().min(1) });
export const fileWriteSchema = z.object({ path: z.string().min(1), content: z.string() });

export const installPackagesSchema = z.object({
  packages: z.array(z.string().regex(PACKAGE_NAME)).min(1).max(MAX_INSTALL_PACKAGES),
  reason: z.string().trim().min(1).max(300),
});

/** Async process control. A handle is opaque data from the model and is validated again in the seam. */
export const processStartSchema = z.object({
  command: z.string().min(1),
  cwd: z.string().min(1).optional(),
  timeoutMs: z.number().int().positive().max(3_600_000).optional(),
});
export const processReadSchema = z.object({
  handle: z.string().min(1).max(64),
  cursor: z.number().int().min(0).optional(),
  stderrCursor: z.number().int().min(0).optional(),
  maxBytes: z.number().int().positive().max(1_048_576).optional(),
});
/** Input is bounded: a single write is at most 64 KiB, so one call cannot grow the sandbox unbounded. */
export const processWriteSchema = z.object({ handle: z.string().min(1).max(64), data: z.string().max(65_536) });
export const processStopSchema = z.object({ handle: z.string().min(1).max(64) });
/** Trusted Jev MCP stdio. Start carries no command: the entrypoint is fixed server-side. */
export const jevMcpStartSchema = z.object({}).strict();
export const jevMcpReadSchema = processReadSchema;
export const jevMcpWriteSchema = processWriteSchema;
export const jevMcpStopSchema = processStopSchema;

/** One typed browser action on the agent's own display; the agent id comes from `x-agent-id`. */
export const browserActionSchema = browserInputSchema;
/** One Google Meet action (join, state, chat_read, chat_send, audio_read, leave) on the agent's own display. */
export const meetActionSchema = meetInputSchema;

/**
 * Working an app on the owner's Mac through cua-driver. The app is a bundle id or an exact name; the Mac's daemon checks the
 * steps again (only action tools, no retargeting). `act` steps are `{ tool, args }` plus optional wait_for / expect / timeout_ms.
 */
const macAppField = z.string().trim().min(1).max(160);
export const macSnapshotSchema = z.object({ app: macAppField, query: z.string().max(200).optional(), screenshot: z.boolean().optional() }).strict();
export const macActSchema = z.object({
  app: macAppField,
  steps: z.array(z.object({
    tool: z.string().min(1).max(40),
    args: z.record(z.string(), z.unknown()).optional(),
    wait_for: z.record(z.string(), z.unknown()).optional(),
    expect: z.array(z.record(z.string(), z.unknown())).max(4).optional(),
    timeout_ms: z.number().int().min(0).max(10_000).optional(),
  }).strict()).min(1).max(32),
  foreground: z.boolean().optional(),
}).strict();
export const macVerifySchema = z.object({ app: macAppField, expect: z.array(z.record(z.string(), z.unknown())).min(1).max(8) }).strict();
/** What the Mac answers to the three: a bounded text, a small picture sometimes, and whether the app wants to be in front. */
export const macDesktopResultSchema = z.object({
  ok: z.boolean(),
  text: z.string().max(20_000),
  needsForeground: z.boolean().optional(),
  image: z.object({ mimeType: z.string().min(1), data: z.string().min(1) }).optional(),
});

/** Start is bounded long enough for a meeting; stop names the recording the host returned. */
export const macAudioSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('start'), maxDurationSeconds: z.number().int().positive().max(3_600).optional() }).strict(),
  z.object({ action: z.literal('stop'), recordingId: z.string().min(1).max(128) }).strict(),
]);

export const macAudioResultSchema = z.object({
  recordingId: z.string().min(1).max(128),
  path: z.string().min(1),
  state: z.enum(['recording', 'stopped']),
});

/** Mail, Calendar and Reminders on the owner's Mac (the desktop app runs them); the tool names are the whole allow-list. */
export const MAC_APP_TOOLS = ['mail_search', 'mail_read', 'mail_create_draft', 'mail_send', 'calendar_list_events', 'calendar_create_event', 'reminders_list', 'reminders_create', 'reminders_complete', 'notes_search', 'notes_read', 'notes_create', 'notes_append'] as const;
export const macAppsSchema = z.object({ tool: z.enum(MAC_APP_TOOLS), args: z.record(z.string(), z.unknown()) }).strict();
export const macAppsResultSchema = z.object({ text: z.string() });

/** The user's `/juno` home (BACKEND §5.2); paths are validated again where they reach the shell. */
export const homeSnapshotRequestSchema = z.object({ agentId: z.string().min(1) });
export const homePathSchema = z.object({ path: z.string().min(1) });
export const homeWriteSchema = z.object({ path: z.string().min(1), content: z.string(), expectedHash: z.string().min(1).optional() });
/** An uploaded file (at most 10 MiB, so about 14 MB of base64) put into the home as bytes. */
export const homePutFileSchema = z.object({ path: z.string().min(1), contentBase64: z.string().max(14 * 1024 * 1024).regex(/^[A-Za-z0-9+/]*={0,2}$/) });
export const homeExtractTextSchema = z.object({ path: z.string().min(1), format: z.enum(['pdf', 'docx']) });
export const homeDeleteSchema = z.object({ path: z.string().min(1), expectedHash: z.string().min(1).optional() });
