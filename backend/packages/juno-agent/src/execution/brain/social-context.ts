// Social context facade: backend-owned runtime identity, validated
// conversation members, the owner's agent directory, and the waking event.
// Rendered on every build, delivered as a context note only when it changed (context-notes.ts);
// the wake (kind/origin) rides in the note's run-start line, never here. Member and
// directory rendering is isolation-first: non-members
// see no member details at all, and unknown ownership closes the
// directory instead of opening it. Relationship details additionally require
// session provenance: a valid session key and a wake bound to this
// agent/conversation/session whose owner matches the resolved owner.
// Private conversation titles require principal access too.
import type { Doc, Store, WakeEvent } from '../../contracts/index.js';
import { harnessText } from '../../modules/harness/loader.js';
import { meaningfulRole, quoteId, quoteLabel } from './social-format.js';
import { appendConversationLines, conversationPrincipalAccess } from './social-conversation.js';
import { appendProvenanceNote, authorizeRelationshipOwner, describeProvenance, resolveOwner } from './social-provenance.js';
import { readString, readStringArray, safeGet } from './social-read.js';
import { teamSection } from './social-roster.js';

export { meaningfulRole, quoteLabel } from './social-format.js';
export type { Provenance } from './social-provenance.js';
export type { ReadResult } from './social-read.js';

export interface SocialContextInput {
  agentId: string;
  conversationId: string;
  sessionKey: string;
  wake: WakeEvent[];
}

export async function buildSocialContext(store: Store, input: SocialContextInput): Promise<string> {
  const lines: string[] = [harnessText('social.session_header')];
  const expectedKey = input.agentId + ':' + input.conversationId;
  if (input.sessionKey === expectedKey) {
    lines.push(harnessText('social.session_ok', { sessionKey: quoteId(input.sessionKey) }));
  } else {
    lines.push(harnessText('social.session_mismatch', {
      sessionKey: quoteId(input.sessionKey), agentId: quoteId(input.agentId), conversationId: quoteId(input.conversationId), expectedKey: quoteId(expectedKey),
    }));
  }
  const agent = await safeGet(store, 'agents', input.agentId);
  if (agent.status === 'missing') {
    lines.push(harnessText('social.agent_missing', { agentId: quoteId(input.agentId) }));
  } else if (agent.status === 'error') {
    lines.push(harnessText('social.agent_unreadable', { agentId: quoteId(input.agentId) }));
  } else {
    const role = meaningfulRole(readString(agent.doc, 'title'));
    const name = quoteLabel(readString(agent.doc, 'name'));
    lines.push(role === undefined ? harnessText('social.you_are', { name }) : harnessText('social.you_are_role', { name, role: quoteLabel(role) }));
    lines.push(harnessText('social.routing', { agentId: quoteId(input.agentId) }));
  }
  const agentDoc = agent.status === 'ok' ? agent.doc : undefined;
  const provenance = describeProvenance(input, expectedKey);
  const owner = resolveOwner(agentDoc, input.wake);
  const relationshipOwner = authorizeRelationshipOwner(owner.ownerId, provenance);
  if (owner.derived && owner.ownerId !== undefined && relationshipOwner !== undefined) {
    lines.push(harnessText('social.owner_derived', { ownerId: quoteId(owner.ownerId) }));
  }
  appendProvenanceNote(lines, owner.ownerId, provenance);
  await appendConversationLines(store, lines, input.agentId, input.conversationId, relationshipOwner, provenance.principal);
  lines.push(harnessText('social.directory_data'));
  return lines.join('\n');
}

/**
 * The team section (its own context section, BACKEND 6.1a): the owner's other agents, authorized the same way as the session's
 * relationship lines. `ownerOnly` is the run's audience (profileAudience): only an owner-only run sees ids and what each teammate handles.
 */
export async function buildTeamSection(store: Store, input: SocialContextInput & { ownerOnly: boolean }): Promise<string> {
  const expectedKey = input.agentId + ':' + input.conversationId;
  const agent = await safeGet(store, 'agents', input.agentId);
  const agentDoc = agent.status === 'ok' ? agent.doc : undefined;
  const provenance = describeProvenance(input, expectedKey);
  const relationshipOwner = authorizeRelationshipOwner(resolveOwner(agentDoc, input.wake).ownerId, provenance);
  return teamSection(store, input.agentId, relationshipOwner, input.ownerOnly);
}

/**
 * The conversation record, when this run may see it: the same rule as the Conversation lines above (valid session key, a wake bound
 * to this agent and conversation, a listed member, principal access), so "Where you are" never shows more than the Session section.
 */
export async function readVisibleConversation(store: Store, input: SocialContextInput): Promise<Doc<'conversations'> | undefined> {
  const expectedKey = input.agentId + ':' + input.conversationId;
  const agent = await safeGet(store, 'agents', input.agentId);
  if (agent.status !== 'ok') return undefined;
  const provenance = describeProvenance(input, expectedKey);
  const selfOwner = authorizeRelationshipOwner(resolveOwner(agent.doc, input.wake).ownerId, provenance);
  const conversation = await safeGet(store, 'conversations', input.conversationId);
  if (selfOwner === undefined || conversation.status !== 'ok') return undefined;
  const doc = conversation.doc;
  if (!(readStringArray(doc, 'agentIds') ?? []).includes(input.agentId)) return undefined;
  return conversationPrincipalAccess(doc, selfOwner, provenance.principal, readStringArray(doc, 'memberIds') ?? []) ? doc : undefined;
}

// Authoritative current identity. Rendered last so it sits closest to the conversation, so a
// conflicting earlier identity claim (transcript, compaction, or peer text) resolves to the
// current display name without discarding legitimate past work. The display name comes only
// from the current record; the stored title renders only as a configured role, and a handle
// never stands in for the name.
export function currentIdentityLines(agent: { name?: string; title?: string } | undefined, agentId: string): string[] {
  const lines = [harnessText('social.identity_header')];
  if (agent === undefined) {
    lines.push(harnessText('social.identity_no_record', { agentId: quoteId(agentId) }));
    return lines;
  }
  lines.push(harnessText('social.identity_name', { name: quoteLabel(agent.name) }));
  const role = meaningfulRole(agent.title);
  if (role !== undefined) lines.push(harnessText('social.identity_role', { role: quoteLabel(role) }));
  lines.push(harnessText('social.identity_rules'));
  return lines;
}
