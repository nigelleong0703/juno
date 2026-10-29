/**
 * Putting an uploaded file on the user's computer (BACKEND §10.8): `/juno/uploads/<library id>/<name>`, readable by every
 * agent of the user and changeable by none (§7.9), so the agent can open it with its own tools. Also reads the text of a
 * PDF or DOCX there, with the platform skill tools, so a small document can be shown in the message itself.
 */
import { createHash } from 'node:crypto';
import type { HomeComputer, HomeTextFormat } from '../../ports/computer/index.js';
import { HOME_ROOT } from '../home/paths.js';

/** The home calls the placement needs, and whose agent id picks the owner's computer. */
export interface AttachmentPlacement {
  agentId: string;
  home: Pick<HomeComputer, 'putFile' | 'extractText'>;
}

/** Copying a 10 MiB file onto a computer that has to wake up first can take a while; a dead computer must not stall the wake for long. */
const PUT_TIMEOUT_MS = 90_000;
const EXTRACT_TIMEOUT_MS = 60_000;
const MAX_NAME_CHARS = 120;

const readableName = (name: string): string => {
  const cleaned = [...name].map((char) => (char.charCodeAt(0) < 32 || '/\\'.includes(char) ? '_' : char)).join('').trim().replace(/^\.+/, '');
  if (cleaned === '') return 'file';
  if (cleaned.length <= MAX_NAME_CHARS) return cleaned;
  const dot = cleaned.lastIndexOf('.');
  const extension = dot > 0 && cleaned.length - dot <= 12 ? cleaned.slice(dot) : '';
  return cleaned.slice(0, MAX_NAME_CHARS - extension.length) + extension;
};

/** Home-relative path of the copy: no path separators in the name, a library id that is always a single safe path part. */
export const uploadPath = (id: string, name: string): string => `uploads/${id.replace(/[^A-Za-z0-9._-]/g, '_')}/${readableName(name)}`;
export const uploadDisplayPath = (relative: string): string => `${HOME_ROOT}/${relative}`;

/** The path of the copy, or undefined when it could not be put there (no computer, computer down, write refused). */
export async function placeOnComputer(place: AttachmentPlacement, id: string, name: string, bytes: Buffer): Promise<string | undefined> {
  const path = uploadPath(id, name);
  try {
    const stored = await place.home.putFile(place.agentId, path, bytes, AbortSignal.timeout(PUT_TIMEOUT_MS));
    return stored.hash === createHash('sha256').update(bytes).digest('hex') ? path : undefined;
  } catch {
    return undefined;
  }
}

/** PDF by its signature; DOCX (a zip) by its name or mime, since a zip alone says nothing. */
export function documentFormat(bytes: Buffer, name: string, mimeType: string): HomeTextFormat | undefined {
  if (bytes.subarray(0, 5).toString('latin1') === '%PDF-') return 'pdf';
  const zip = bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;
  const docx = name.toLowerCase().endsWith('.docx') || mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  return zip && docx ? 'docx' : undefined;
}

const PAGE_MARKER = /^--- page \d+$/;

/** The document's text when the computer could read it all and there is some beyond the page markers; undefined otherwise. */
export async function documentText(place: AttachmentPlacement, path: string, format: HomeTextFormat): Promise<string | undefined> {
  try {
    const { text, truncated } = await place.home.extractText(place.agentId, path, format, AbortSignal.timeout(EXTRACT_TIMEOUT_MS));
    if (truncated || text.split('\n').every((line) => line.trim() === '' || PAGE_MARKER.test(line.trim()))) return undefined;
    return text;
  } catch {
    return undefined;
  }
}

export const humanSize = (bytes: number): string =>
  bytes < 1024 ? `${String(bytes)} B` : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
