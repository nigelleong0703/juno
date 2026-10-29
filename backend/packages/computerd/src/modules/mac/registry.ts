/**
 * The Macs that joined as computers (My Mac): one per owner, in a small JSON file next to the computer bindings. The link
 * id is random and its token derives from it (the hub's `tokenFor`), so pairing again gives a new id and the old token stops
 * working; removing the record is the whole of "revoke". Written atomically, like the other computerd state.
 */
import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export interface MacLink {
  /** The link id the Mac's daemon dials with (`mac-` + 24 hex). */
  id: string;
  /** What the owner sees ("Robin's MacBook Pro"). */
  name: string;
  pairedAt: string;
}

export interface MacRegistry {
  /** Pair (or pair again): replaces any earlier Mac of this owner, whose token stops working. */
  pair(owner: string, name: string): MacLink;
  get(owner: string): MacLink | undefined;
  revoke(owner: string): MacLink | undefined;
  /** The owner a paired Mac's link id belongs to. */
  ownerOf(linkId: string): string | undefined;
  /** True for a Mac link id nobody is paired with any more. */
  withdrawn(linkId: string): boolean;
}

export const MAC_LINK_PREFIX = 'mac-';

/** A Mac must declare what it can do when it connects (`createLinkHub({ requireDeclaration })`). */
export const isMacLink = (linkId: string): boolean => linkId.startsWith(MAC_LINK_PREFIX);

export function createMacRegistry(file: string): MacRegistry {
  let links = new Map<string, MacLink>(Object.entries(read(file)));
  const save = () => {
    mkdirSync(dirname(file), { recursive: true });
    const temp = `${file}.${process.pid}.tmp`;
    writeFileSync(temp, JSON.stringify(Object.fromEntries(links), null, 2), { mode: 0o600 });
    renameSync(temp, file);
  };
  return {
    pair(owner, name) {
      const link: MacLink = { id: MAC_LINK_PREFIX + randomBytes(12).toString('hex'), name: name.trim().slice(0, 80) || 'My Mac', pairedAt: new Date().toISOString() };
      links = new Map(links).set(owner, link);
      save();
      return link;
    },
    get: (owner) => links.get(owner),
    revoke(owner) {
      const link = links.get(owner);
      if (!link) return undefined;
      links = new Map(links);
      links.delete(owner);
      save();
      return link;
    },
    ownerOf: (linkId) => [...links].find(([, link]) => link.id === linkId)?.[0],
    withdrawn: (linkId) => isMacLink(linkId) &&![...links.values()].some((link) => link.id === linkId),
  };
}

function read(file: string): Record<string, MacLink> {
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, MacLink>) : {};
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw new Error(`could not read the Mac registry ${file}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
}
