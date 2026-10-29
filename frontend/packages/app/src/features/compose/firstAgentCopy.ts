/**
 * Scoped copy for the /new first-agent onboarding (UX1). Kept next to the compose
 * feature so shared i18n stays untouched; names are the user's own, no template
 * capability claims.
 */
export const FIRST_AGENT_COPY = {
  firstAgentTitle: 'Create your first agent',
  firstAgentBody: 'Give your agent a name to start a conversation.',
  firstAgentNameLabel: 'Agent name',
  firstAgentNamePlaceholder: 'e.g. Juno',
  firstAgentCreate: 'Create agent',
  firstAgentCreating: 'Creating…',
  firstAgentNameRequired: 'Give your agent a name first.',
  firstAgentCreateFailed: "Couldn't create that agent. Your name is kept — try again.",
  firstAgentSendFailed: "Couldn't start that chat. Your draft is kept — try again.",
  /** Explicit group mode on the same /new page (Grok-style: pick members, create). */
  newGroupChat: 'New group chat',
  newGroupHint: 'Pick 2–6 agents, then create the group. It opens right away — no first message required.',
  groupSelected: 'selected',
  groupTooFew: 'Pick at least 2 agents to create a group.',
  groupTooMany: 'Groups hold up to 6 agents — remove one to add another.',
  createGroup: 'Create group',
  creatingGroup: 'Creating…',
  groupCreateFailed: "Couldn't create that group. Your picks are kept — try again.",
  backToChats: 'Back',
  /** Animated platform introduction (UI102): Vomu definition + 3 scenes. */
  introEyebrow: 'Welcome to Juno',
  introPlatformLine:
    'Juno is a home for persistent AI assistants — agents that keep their name, memory and conversations, so you can chat with them like teammates.',
  introScene1Title: 'Chat with your assistants',
  introScene1Body:
    'Give each agent a name and talk to it in its own conversation. It remembers what matters across chats.',
  introScene2Title: 'Team up with @mentions',
  introScene2Body:
    'Pull several agents into one group chat. Mention an agent by name when you want it to answer; unmentioned agents stay quiet.',
  introScene3Title: 'Computer, files and routines',
  introScene3Body:
    'Keep shared files with your chats, schedule routines, and connect a computer for browsing and screen work.',
  introScene3Note:
    'Computer tools are available when a computer is connected.',
  introSkip: 'Skip intro',
  introBack: 'Back',
  introNext: 'Next',
  introStart: 'Name your first agent',
  introStep: 'Step',
  introOf: 'of',
  introGoToScene: 'Show scene',
  introComputer: 'Computer',
  introFiles: 'Files',
  introRoutines: 'Routines',
} as const;
