/**
 * The platform's own notes in `/juno/docs/` (BACKEND §5.1): written with the backend version, read-only to the agent and the
 * user. Memory and goals; the context points the agent at them.
 */
import { HOME_DISPLAY } from './paths.js';

const MEMORY_DOC = `# How memory works

You remember the user through files in ${HOME_DISPLAY}. Other agents of the same user read the same memory, and each of them reads a note without knowing which agent wrote it unless the note says so. You do not edit these files: the memory items behind them change only through \`memory_note\` and the background jobs, and the files are rewritten from them.

- \`MEMORY.md\`: a short curated sheet of what is true about the user for a long time (facts, preferences, commitments). It is in your context in full. You cannot edit it: a background job keeps it, and the user can edit it in the app.
- \`memory/bank/circumstances.md\`, \`experiences.md\`, \`preferences.md\` and \`people/<name>.md\`: the detail behind the sheet, written by the same job. Search them with the \`memory_search\` tool.
- Today's notes from all of the user's agents are in your Memory section ("Notes from today"). The older daily logs in \`memory/<YYYY-MM-DD>/\` are an archive and are no longer written.

## Writing notes with memory_note

When the user tells you something that stays true beyond this conversation (who they are, their work, the people in their life, an ongoing situation, how they want things done, a commitment), call \`memory_note\` with:

- \`about\`: \`user\` for the person you are helping, otherwise the other person's name as they call them;
- \`kind\`: \`fact\`, \`circumstance\` (where they live and work, family, health, money), \`preference\` (how they want things), \`experience\` (something that happened) or \`commitment\`;
- \`topic\`: where it belongs on their memory page: \`identity\`, \`health\`, \`work\`, \`plans\`, \`preferences\`, \`people\`, \`agents\`, \`home\` or \`other\`;
- \`text\`: one short line, complete on its own. One note per fact.

Word the line so a reader who does not know who wrote it still knows who it is about. About the person you are helping leave the subject out, in their own register: "Wants to build muscle and cut sugar", "Wants New agent (agt-1c0c…) as a diet planner". About anyone else begin with their name: "Priya manages Tom". A note with "I", "me", "my", "you" or "your" in it is refused: another agent or a background job will read it later and "me" would mean the wrong agent. If the same thing is already remembered, that item is updated instead of a second one being added. The tool keeps the note with you as its author, and every agent sees it marked with its writer ("Notes from today"). Do not note one-off requests, venting or chit-chat. A sub-task you started cannot write notes.

Once a chat goes quiet, a background digest reads what the user actually said there, keeps what is solid, and updates the sheet and the bank. A note goes into the memory at once, marked with you as its writer, and it is your own inference: the digest takes things only from what the user actually said, so a note is never recorded as the user's words. You do not need to copy things into MEMORY.md yourself.

Who you are to the user ("you are my diet planner") is not a memory note: it is about you, not about them. Keep it in your persona with \`agent_update\`.

## Looking things up

- \`memory_search\` finds lines by meaning and by words. Use it before saying you do not know something about the user.
- \`memory_explain\` shows why a line is in memory: the claim, the user's exact words and the message they came from. Use it when the user asks "how do you know that?".
- \`person_lookup\` shows one person: what they recently said that may be repeated here, and, when you are alone with the user, their accounts and how they connect to other people (manager, colleague, client and so on). Look up the next person to follow a chain, e.g. "what did Priya's manager say last?": look up Priya, then her manager.

## Forgetting

You cannot delete memory. When the user asks you to forget something, tell them to open the memory page in the app and remove it there; that removes the lines and keeps them from coming back.
`;

const GOALS_DOC = `# How goals work

A goal is something long-running you keep for the user: a plan with steps, tracked in their Goals tab. The platform wakes you on a schedule so goals move forward after the app is closed. You create and update goals with \`goal_update\`. When the user states something they want to work on over time, record it with \`goal_update\` in that same turn. Progress the user makes with you in conversation (practice, coaching, learning) is recorded on its goal by the background digest after the chat goes quiet, so do not call \`goal_update\` for that progress.

## Planning

When a goal is created you get one run to plan it. Write 3 to 7 concrete milestones, in the order they should happen, each \`{title, status: "todo"}\` with a \`due\` time when the goal has a deadline. Then set \`nextCheckAt\` to when you will take the first step. Pass the full milestone list every time you update it. Do not message the user about the plan unless you cannot continue without an answer.

## Check-ins

At \`nextCheckAt\` you are woken with a goal check-in (the goal, its milestones and the latest timeline entries). Each one:

1. Do ONE concrete step with your normal tools (research, draft, prepare, check). Do not only re-plan.
2. Record it with \`goal_update\`: update the summary (one line: where it stands now), the milestone statuses (todo, doing, done, blocked), \`note\` (one line: what you did) and \`nextCheckAt\`.
3. Pick \`nextCheckAt\` by how fast things move: at least 1 hour and at most 7 days ahead; a day is the default. Nothing to wait for means a longer gap.
4. Set the goal \`done\` when every milestone is finished. A paused or finished goal is never checked.

## When to message the user, and when to stay silent

Message the user (your final reply) only when:

- something really changed (a result, a blocker, a milestone finished that they care about);
- you need a decision or approval to go on;
- a milestone is due within 24 hours (the platform sends you a reminder run for this; you must message).

Otherwise stay silent: record progress in the goal timeline and end the check-in the quiet way its wake text describes. "Nothing new" and "still working on it" are never worth a message, and never a reply either. When the user presses "Check now" they asked, so answer in a line or two.

Once a day a background job also writes a one-line briefing per active goal into the timeline; that is not a message and you do not need to do anything for it.
`;

export function platformDocs(): Map<string, string> {
  return new Map([['docs/memory.md', MEMORY_DOC], ['docs/goals.md', GOALS_DOC]]);
}
