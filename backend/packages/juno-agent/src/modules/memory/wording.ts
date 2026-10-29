/**
 * How a memory item is worded and sorted (BACKEND §5.4 "Nightly tidy"): the rules the chat digest, memory_note and the nightly tidy
 * share, so an item reads the same whoever wrote it. An agent reads items later without knowing who wrote them, so each one is a short
 * self-contained statement whose subject is clear: no subject for the person being helped, a name for anyone else.
 */
import { z } from 'zod';
import { ITEM_TOPICS, type ItemTopic } from '@agent-desktop/memory-graph/memory';

export const topicSchema = z.enum(ITEM_TOPICS);

/** The wording rules, as one paragraph for a prompt. */
export const WORDING_RULES =
  'Write each item as one short, self-contained statement in the language the person writes in. About the person being helped, leave the subject out and write in their own register: ' +
  '"Wants to build muscle and cut sugar", "Prefers warm, normal-length replies", "Lives in Leiden". Never begin with "User", "The user" or "You" ' +
  '(other assistants read these lines, and "You" would read as the assistant itself). About anyone else, begin with their name: "Priya manages Tom", "Lily loves sushi". ' +
  'Never write "I", "me" or "my" without saying whose they are.';

const TOPIC_MEANING: Record<ItemTopic, string> = {
  identity: 'who they are: name, age, origin, languages, background, beliefs',
  health: 'body and wellbeing: food, fitness, sleep, medical',
  work: 'job, business, projects, clients, studies, money from work',
  plans: 'things they intend or promised to do: trips, goals, dates, commitments',
  preferences: 'tastes and how they want things done, including how assistants should talk to them',
  people: 'family, friends, colleagues and how they relate to them',
  agents: 'what they want from their assistants or how the assistants work for them',
  home: 'where they live, household, belongings, routines at home',
  other: 'anything that fits none of the above',
};

/** The topic list with its meaning, for a prompt. */
export const TOPIC_RULES = 'Topic, one of: ' + ITEM_TOPICS.map((topic) => `${topic} (${TOPIC_MEANING[topic]})`).join('; ') + '.';

/** Item text that starts the old way: "User wants…", "The user's…", "You…", "用户…". */
export const OLD_WORDING = /^\s*(?:(?:the\s+)?user\b|you(?:['’]re|r)?\b|用户|你)/i;

/** Text compared with another: lower case, letters and numbers only, single spaces. */
export const normalizeText = (text: string): string => text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
