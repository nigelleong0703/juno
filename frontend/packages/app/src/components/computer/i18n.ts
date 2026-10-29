import { t as baseT } from "../../lib/i18n";

/**
 * Computer-specific copy (E2). The shared catalog lives in `lib/i18n.ts` (E1); these keys are
 * additive and namespaced under `computer.*` so they can be lifted into the shared catalog later
 * without collisions. `tc()` resolves locally first, then falls back to the shared catalog so
 * existing keys (`computer.takeOver`, …) keep working.
 */
const local: Record<string, string> = {
  "computer.header.title": "Computer",
  "computer.header.usedBy": "{name} is using it",
  "computer.step.label": "step {step}",

  "computer.state.running": "Running",
  "computer.state.working": "Working",
  "computer.state.asleep": "Asleep",
  "computer.state.paused": "Paused",
  "computer.state.needsYou": "Needs you",

  "computer.tab.computer": "Computer",
  "computer.tab.overview": "Overview",
  "computer.tab.routines": "Routines",
  "computer.tab.files": "Files",
  "computer.tab.members": "Members",


  "computer.clipboard.copy": "Copy",
  "computer.clipboard.paste": "Paste",
  "computer.clipboard.copied": "Copied from the computer",
  "computer.clipboard.nothingCopied": "Nothing selected to copy",
  "computer.clipboard.nothingToPaste": "Nothing to paste on this device",
  "computer.clipboard.denied": "Clipboard access was blocked",
  "computer.clipboard.nothingOnComputer": "Nothing selected on the computer — select something there first",
  "computer.clipboard.copiedImage": "Image copied from the computer",
  "computer.clipboard.savedFile": "Saved to {path}",
  "computer.clipboard.needControl": "Take over the computer first to copy or paste",
  "computer.clipboard.tooLarge": "That is larger than the 10 MB limit",
  "computer.clipboard.tooManyFiles": "Paste at most {max} files at a time",
  "computer.clipboard.failed": "The clipboard could not be moved. Try again.",
  "computer.mode.watch.banner": "Watching · {name} is working",
  "computer.mode.control.banner": "You have control · {name} is waiting",
  "computer.mode.teach.banner": "{name} is watching and learning {time}",
  "computer.mode.teach.stop": "Stop teaching",
  "computer.mode.signin.title": "Sign-in needed",
  // Never claims the model is paused: a pending sign-in request alone cannot prove that. It
  // names the external site (app login is not the site login) and keeps the explicit action.
  "computer.mode.signin.body": "{name} needs a browser sign-in for {site} to continue.",
  "computer.mode.signin.done": "I’ve signed in",
  "computer.mode.needsYou.title": "Needs you",
  "computer.mode.needsYou.body": "{name} is waiting for you before it continues.",
  "computer.mode.needsYou.skip": "Skip this step",
  "computer.mode.needsYou.continue": "I’m done, continue",
  "computer.mode.asleep.title": "The computer is asleep",
  "computer.mode.asleep.body": "It wakes when it’s needed.",

  "computer.action.popout": "Pop out",
  "computer.action.fullscreen": "Full screen",
  "computer.action.exitFullscreen": "Exit full screen",
  "computer.action.newWindow": "Separate window",
  "computer.action.more": "More",
  "computer.action.settings": "Settings",
  "computer.action.agentSettings": "Agent settings",
  "computer.action.back": "Back",
  "computer.action.advanced": "Advanced",
  "computer.control.agentHasControl": "{name} has control",
  "computer.control.youHaveControl": "You have control",
  "computer.control.returnToAgent": "Return to agent",
  "computer.action.teach": "Teach a task",
  "computer.action.reboot": "Reboot",
  "computer.action.reloadView": "Reload view",
  "computer.action.reset": "Reset",
  "computer.action.close": "Close",

  "computer.overview.currentTask": "Current task",
  "computer.overview.noTask": "No task is running right now.",
  "computer.overview.recentRuns": "Recent runs",
  "computer.overview.noRuns": "No recent runs.",

  "computer.tasks.title": "Ongoing tasks",
  "computer.tasks.empty": "No ongoing tasks.",
  "computer.tasks.loading": "Loading tasks…",
  "computer.tasks.error": "Could not load tasks.",
  "computer.tasks.status.pending": "Pending",
  "computer.tasks.status.inProgress": "In progress",
  "computer.tasks.status.blocked": "Blocked",

  "computer.routines.empty": "No routines yet.",
  "computer.routines.hint": "Routines run on a schedule, an event, or a webhook.",
  "computer.routines.askAgent": "Ask {name} in chat to set up a routine.",
  "computer.routines.unscopedHint":
    "Some routines deliver to chat without choosing this conversation, so they stay out of this list. Ask {name} in chat to deliver them here.",
  "computer.routines.nextRun": "Next run",
  "computer.routines.lastResult": "Last result",

  "computer.files.empty": "No files yet.",
  "computer.files.hint": "Files this agent reads and writes land here.",
  "computer.files.open": "Open files",

  "computer.members.empty": "No members yet.",
  "computer.members.agents": "Agents",
  "computer.members.people": "People",
  "computer.members.you": "You",

  "computer.preview.title": "{name}’s screen",
  "computer.preview.open": "Open",
  "computer.preview.watching": "Live",

  "computer.stream.connecting": "Connecting…",
  "computer.stream.reconnect": "Reconnect",
  "computer.screen.none.title": "No screen yet",
  "computer.screen.none.body": "{name} has no display on this computer yet.",
  "computer.screen.starting": "Starting {name}’s screen…",
  "computer.screen.error.title": "Screen unavailable",
  "computer.screen.error.body": "{name}’s display could not be reached.",
  "computer.screen.retry": "Retry",
  "computer.screen.start": "Start screen",
  "computer.screen.pick": "Screen",
  "computer.screen.pickMember": "Show {name}’s screen",
  "computer.error.body": "Could not reach the server.",
  "computer.ensure": "Set up computer",
  "computer.mac.title": "Your Mac",
  "computer.mac.online": "Connected",
  "computer.mac.stopped": "Stopped · resume on your Mac",
  "computer.mac.offline": "Offline",
  "computer.mac.offlineHint": "Open Juno on your Mac to reconnect.",
  "computer.mac.unpaired": "Not connected",
  "computer.mac.folder": "Works in {folder}",
  "computer.sandbox.noneTitle": "No sandbox on this Mac",
  "computer.sandbox.install": "Install Apple container",
  "computer.sandbox.missing": "The sandbox image isn't downloaded yet. It downloads the first time you set up the computer.",
  "computer.sandbox.pulling": "Downloading the sandbox image…",
  "computer.ensure.pending": "Setting up the computer…",
};

function interpolate(template: string, vars?: Record<string, string | number>): string {
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    name in vars ? String(vars[name]) : match,
  );
}

/** Translate a computer string: local catalog first, then the shared catalog. */
export function tc(key: string, vars?: Record<string, string | number>): string {
  const template = local[key];
  if (template !== undefined) return interpolate(template, vars);
  return baseT(key, vars);
}

/** Keys defined locally (handy for tests). */
export const computerMessageKeys = Object.keys(local);
