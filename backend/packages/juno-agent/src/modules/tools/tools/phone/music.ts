/**
 * Music on the iPhone (the system music player: the Music app plays, so it keeps playing when Juno is closed). What is playing is
 * a read. Starting something (Apple Music when MusicKit is set up for the build, else the owner's own library) and pause / resume /
 * next / previous change things, but playing music on one's own phone is low-stakes and reversible, so they run without asking
 * (`changes`, no `decision`): they are never replayed, and they are not approvals.
 */
import { z } from 'zod';
import type { PhoneToolDef } from './def.js';

export const MUSIC_DEFS: readonly PhoneToolDef[] = [
  {
    name: 'phone_music_now_playing', call: 'music.now_playing',
    description: '',
    properties: {}, schema: z.object({}).strict(),
  },
  {
    name: 'phone_music_play', call: 'music.play', changes: true,
    description: '',
    properties: { query: { type: 'string', description: '' }, kind: { type: 'string', enum: ['song', 'album', 'playlist'], description: '' } },
    required: ['query'], schema: z.object({ query: z.string().trim().min(2).max(200), kind: z.enum(['song', 'album', 'playlist']).optional() }).strict(),
  },
  {
    name: 'phone_music_control', call: 'music.transport', changes: true,
    description: '',
    properties: { action: { type: 'string', enum: ['pause', 'resume', 'next', 'previous'], description: '' } },
    required: ['action'], schema: z.object({ action: z.enum(['pause', 'resume', 'next', 'previous']) }).strict(),
  },
];
