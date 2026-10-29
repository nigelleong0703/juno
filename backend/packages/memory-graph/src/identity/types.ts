/** Shapes of the identity graph (migration 0043): people, and the accounts they speak from. Rows are mapped to these in repo.ts; nothing here touches a database. */

export const ACCOUNT_PLATFORMS = ['telegram', 'slack', 'discord', 'feishu', 'email', 'meet', 'app'] as const;
export type AccountPlatform = (typeof ACCOUNT_PLATFORMS)[number];

export interface Person {
  id: string;
  ownerId: string;
  name: string;
  /** The owner themself: one per owner, and a link never deletes it. */
  isOwner: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface AccountInput {
  platform: AccountPlatform;
  /** Slack team, Discord guild or Feishu tenant; '' when the platform has none (Telegram, email, ...). */
  workspace?: string;
  /** The platform's id for the account (a Telegram user id, a Slack user id, an email address). */
  externalId: string;
  /** The display name the platform shows now; refreshed on every sighting. */
  name?: string | null;
  /** The chat (group or room title) the account was last seen in; refreshed when given, kept otherwise. */
  lastChat?: string | null;
}

export interface Account {
  id: string;
  ownerId: string;
  platform: AccountPlatform;
  workspace: string;
  externalId: string;
  name: string | null;
  /** The person this account belongs to; null while no person has been made for it (see upsertAccount). */
  personId: string | null;
  /** The chat the account was last seen in ('' when none was recorded). */
  lastChat: string;
  firstSeen: string;
  lastSeen: string;
}

export type IdentityErrorCode = 'invalid' | 'not_found';

/** A refused identity operation. `code` says why: bad input, or nothing matched in this owner. */
export class IdentityError extends Error {
  readonly code: IdentityErrorCode;

  constructor(code: IdentityErrorCode, message: string) {
    super(message);
    this.name = 'IdentityError';
    this.code = code;
  }
}
