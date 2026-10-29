import type { Request, Run, Step } from "@agent-desktop/client";

/**
 * A step in words (port of the iPhone's StepText.swift `stepLine`). The agent's tools arrive as
 * `verb: "Executed", target: "<tool name>"`; this turns them into one readable sentence. Returns null for
 * steps not worth showing: the backend marks plumbing steps `internal`, and the client keeps no list of tool names.
 */

const clip = (text: string, max: number): string => {
  const one = text.replace(/\n/g, " ").trim();
  return one.length > max ? `${one.slice(0, max).trim()}…` : one;
};

function toolOf(step: Step): string {
  if (step.verb === "Read") return "web_fetch";
  if (step.verb === "Looked up") return "web_search";
  if (step.verb === "Asked a helper") return "child_spawn";
  return step.target;
}

function argsOf(step: Step): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(step.input?.summary ?? "");
    if (parsed && typeof parsed === "object") return parsed as Record<string, unknown>;
  } catch {
    // not JSON: fall back to the structured input below
  }
  const fallback: Record<string, unknown> = {};
  if (step.input?.url) fallback.url = step.input.url;
  if (step.input?.text) fallback.text = step.input.text;
  return fallback;
}

const outputOf = (step: Step): string => step.output?.summary ?? step.output?.text ?? "";
const str = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);

function hostOf(url: string): string | undefined {
  try {
    return new URL(url).host.replace(/^www\./, "") || undefined;
  } catch {
    return undefined;
  }
}

function searchQuery(url: string): string | undefined {
  try {
    const parsed = new URL(url);
    const search = /(bing\.|google\.|duckduckgo\.)/.test(parsed.host);
    if (!search || !(parsed.pathname.startsWith("/search") || parsed.host.includes("duckduckgo"))) return undefined;
    return parsed.searchParams.get("q")?.replace(/\+/g, " ") || undefined;
  } catch {
    return undefined;
  }
}

function clickedLabel(output: string): string | undefined {
  if (!output.startsWith('Clicked "')) return undefined;
  const end = output.indexOf('"', 9);
  return end > 9 ? output.slice(9, end) : undefined;
}

function refLabel(ref: string | undefined, output: string): string | undefined {
  if (!ref) return undefined;
  const at = output.indexOf(`- ${ref} [`);
  if (at < 0) return undefined;
  const line = output.slice(at + ref.length + 4).split("\n")[0] ?? "";
  const close = line.indexOf("]");
  return close < 0 ? undefined : line.slice(close + 1).trim() || undefined;
}

function pageTitle(output: string): string | undefined {
  const first = output.split("\n").find((line) => line.length > 0) ?? "";
  let title: string | undefined;
  if (first.startsWith("Title:")) title = first.slice(6);
  else if (first.startsWith("Navigated tab")) {
    const from = first.indexOf(" to ");
    const to = first.lastIndexOf(" (http");
    if (from >= 0 && to > from) title = first.slice(from + 4, to);
  }
  const clean = title?.trim();
  return clean ? clip(clean, 80) : undefined;
}

const humanize = (tool: string): string => {
  const words = tool.replace(/[_.-]/g, " ");
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : "Did something";
};

/** "Not clicked: ..." is the purchase gate asking for approval, not a failure. */
export function isRefusedPurchase(step: Step): boolean {
  return step.status === "failed" && outputOf(step).startsWith("Not clicked:");
}

/** The page a step touched: the call's url, else the "URL:" line of a web read. */
export function stepUrl(step: Step): string | undefined {
  const fromArgs = str(argsOf(step).url);
  if (fromArgs) return fromArgs;
  return step.output?.summary?.split("\n").find((line) => line.startsWith("URL: "))?.slice(5);
}

/** The muted host under a page step ("Opened <title>" over "example.com"). */
export function stepDomain(step: Step): string | undefined {
  const tool = toolOf(step);
  if (!["web_fetch", "browser.navigate", "browser.new_tab"].includes(tool)) return undefined;
  const url = str(argsOf(step).url) ?? step.input?.url ?? "";
  if (searchQuery(url) !== undefined) return hostOf(url);
  return pageTitle(outputOf(step)) ? hostOf(url) : undefined;
}

export function stepLine(step: Step, run: readonly Step[] = []): string | null {
  const tool = toolOf(step);
  if (step.internal === true) return null;
  const args = argsOf(step);
  const out = outputOf(step);
  // File and shell calls say which computer they ran on when it was the owner's Mac; the sandbox keeps today's wording.
  const where = args.on === "mac" ? " on your Mac" : "";
  if (isRefusedPurchase(step)) return "Waiting for your approval to place the order";

  switch (tool) {
    case "web_search":
      return `Searched for “${clip(str(args.query) ?? step.target, 60)}”`;
    case "web_fetch":
    case "browser.navigate":
    case "browser.new_tab": {
      const url = str(args.url) ?? step.input?.url ?? "";
      const query = searchQuery(url);
      if (query) return `Searched for “${clip(query, 60)}”`;
      const title = pageTitle(out);
      const page = title ?? hostOf(url) ?? (step.verb === "Read" ? step.target : undefined);
      // A fetch only reads the page's text; "Opened" would suggest the agent's browser, which the user can watch.
      if (tool === "web_fetch") return `Read ${page ?? "a page"}`;
      return `Opened ${page ?? "a page"} in the browser`;
    }
    case "browser.click": {
      const ref = str(args.ref);
      const label =
        clickedLabel(out) ??
        refLabel(ref, out) ??
        [...run]
          .reverse()
          .filter((earlier) => earlier.index < step.index)
          .map((earlier) => refLabel(ref, earlier.output?.summary ?? ""))
          .find((found) => found !== undefined);
      return label ? `Clicked ${clip(label, 50)}` : "Clicked on the page";
    }
    case "computer.click":
    case "computer.double_click":
    case "computer.right_click": {
      const label = clickedLabel(out);
      return label ? `Clicked ${clip(label, 50)}` : "Clicked on the page";
    }
    case "browser.type":
    case "computer.type": {
      const text = str(args.text) ?? "";
      return text ? `Typed “${clip(text, 40)}”` : "Typed some text";
    }
    case "browser.fill": {
      const count = Array.isArray(args.fields) ? args.fields.length : 0;
      return count > 1 ? `Filled in ${count} fields` : "Filled in a field";
    }
    case "computer.scroll":
      return "Scrolled the page";
    case "computer.key":
      return `Pressed ${str(args.key) ?? "a key"}`;
    case "browser.tabs":
      return "Checked the open tabs";
    case "browser.dialog":
      return "Answered a page dialog";
    case "child_spawn": {
      const what = (step.verb === "Asked a helper" ? step.target : undefined) || str(args.title) || str(args.prompt) || "";
      return what ? `Asked a helper to ${clip(what, 60)}` : "Asked a helper for a hand";
    }
    case "request_secure_input": {
      const labels = (Array.isArray(args.fields) ? args.fields : [])
        .map((field) => str((field as { label?: unknown } | null)?.label))
        .filter((label): label is string => Boolean(label));
      return labels.length ? `Asked you for ${labels.join(", ")}` : "Asked you for details";
    }
    case "request_takeover":
      return "Asked you to take over the screen";
    case "shell.run":
    case "shell.start": {
      const command = str(args.command) ?? step.input?.command ?? "";
      return `${command ? `Ran ${clip(command, 40)}` : "Ran a command"}${where}`;
    }
    case "files.read":
    case "files.write":
    case "files.edit": {
      const name = (str(args.path) ?? "").split("/").pop();
      const verb = tool === "files.read" ? "Read" : tool === "files.write" ? "Wrote" : "Edited";
      return `${name ? `${verb} ${name}` : `${verb} a file`}${where}`;
    }
    case "computer_copy": {
      const name = (str(args.path) ?? str(args.toPath) ?? "").split("/").pop();
      const side = (key: string) => (args[key] === "mac" ? "your Mac" : "the sandbox");
      return `Copied ${name || "a file"} from ${side("from")} to ${side("to")}`;
    }
    default:
      return humanize(tool);
  }
}

const PROGRESSIVE: Record<string, string> = {
  Clicked: "Clicking", Opened: "Opening", Searched: "Searching", Typed: "Typing", Filled: "Filling",
  Scrolled: "Scrolling", Pressed: "Pressing", Ran: "Running", Read: "Reading", Wrote: "Writing",
  Edited: "Editing", Copied: "Copying", Checked: "Checking", Answered: "Answering", Asked: "Asking", Looked: "Looking",
};

/** "Clicked X" becomes "Clicking X"; a line that starts with another word stays as it is. */
export function progressive(line: string): string {
  const first = line.split(" ", 1)[0] ?? "";
  const ing = PROGRESSIVE[first];
  return ing ? ing + line.slice(first.length) : line;
}

/** The latest readable step as a sentence for work in progress ("Clicking Sign in"), else undefined. */
export function latestStepText(steps: readonly Step[]): string | undefined {
  for (let i = steps.length - 1; i >= 0; i--) {
    const step = steps[i] as Step;
    const line = stepLine(step, steps);
    if (line !== null) return step.status === "running" ? progressive(line) : line;
  }
  return undefined;
}

/**
 * A task's progress line. The server writes the newest step as "<verb> <target>" ("Executed browser.click");
 * this says it in the step list's words, never the raw tool name. Lines that are already words pass through.
 */
export function progressText(progress: string): string {
  const tool = /^Executed (\S+)$/.exec(progress.trim())?.[1];
  if (tool === undefined) return progress;
  const line = stepLine({ verb: "Executed", target: tool } as Step);
  return line === null ? "Working…" : progressive(line);
}

/** What the owner is being asked for, as the end of "Needs you — …". */
export function needText(request: Request): string {
  const payload = request.payload;
  switch (payload.kind) {
    case "question":
      return payload.ui.title || payload.ui.text?.split("\n")[0] || "an answer";
    case "secure_input": {
      const kinds = payload.fields.map((field) => field.kind);
      const noun = kinds.some((kind) => kind.startsWith("card"))
        ? "card details"
        : kinds.every((kind) => kind === "password")
          ? "password"
          : kinds.every((kind) => kind === "otp")
            ? "code"
            : "details";
      return `your ${noun}`;
    }
    case "computer":
      return "your help on screen";
    case "signin":
      return "you to sign in";
    case "connect":
      return `you to connect ${payload.label}`;
    case "approval":
      if (payload.brief) return payload.brief.sentence;
      if (payload.purchase) return "approval to place the order";
      return `approval to ${payload.action.replace(/[_.]/g, " ").toLowerCase()}`;
    default:
      return "approval to use a tool";
  }
}

/** The pill's sentence for a running run: a waiting request wins, else the latest readable step. */
export function runStatusText(run: Run | undefined, waiting: Request | undefined): string {
  if (waiting) return `Needs you — ${needText(waiting)}`;
  const line = latestStepText(run?.steps ?? []);
  return line === undefined ? "Working…" : `${line}…`;
}

/**
 * The steps that get a row. A step that reads the same as the one before (a page read then opened,
 * three clicks with no label) shows once.
 */
export function visibleSteps(steps: readonly Step[]): Step[] {
  const shown: Step[] = [];
  let last: string | null = null;
  for (const step of steps) {
    const line = stepLine(step, steps);
    if (line === null || line === last) continue;
    last = line;
    shown.push(step);
  }
  return shown;
}

const NOISE = ["Snapshot of tab", "(Fetched as text", "(Untrusted", "Page content below", "[image]", "Captured screen", "Title:", "URL:", "Navigated tab", "Clicked "];

/** A short readable excerpt of what the tool returned: page snapshots, refs and fetch boilerplate stripped. */
export function stepExcerpt(step: Step): string | undefined {
  const raw = outputOf(step);
  if (!raw || isRefusedPurchase(step)) return undefined;
  const text = raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !/^[-#\s]*e\d+ \[/.test(line) && !line.startsWith("## ") && !NOISE.some((prefix) => line.startsWith(prefix)))
    .join(" ")
    .replace("...[truncated]", "");
  return text ? clip(text, 280) : undefined;
}

/** A run error in words (port of the iPhone's Fmt.runError): out-of-credit and key problems get a sentence. */
export function runErrorText(raw: string): string {
  if (raw.includes("(402)") || /insufficient/i.test(raw)) return "The model service is out of credit. Pick another model in Settings or top it up.";
  if (raw.includes("(401)") || raw.includes("(403)")) return "The model service rejected the key. Check the model settings.";
  if (raw.includes("(429)")) return "The model service is busy (rate limited). Try again in a moment.";
  const line = raw.split("\n")[0] ?? raw;
  return (line.split("{")[0] ?? line).trim().replace(/^:+|:+$/g, "").trim();
}

/** "8s", "8m" (seconds dropped past a minute), "1h 5m": the iPhone's Fmt.duration. */
export function runDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${Math.max(s, 1)}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

export function runElapsedMs(run: Run): number | undefined {
  if (run.durationMs !== undefined) return run.durationMs;
  return run.finishedAt ? Math.max(0, Date.parse(run.finishedAt) - Date.parse(run.startedAt)) : undefined;
}

/**
 * The Activity card's title: the run's own title, else the first line of the message that started it (clipped).
 * A run the backend has not titled yet carries the placeholder "Task", which never shows.
 */
export function activityTitle(runTitle: string | undefined, trigger: string | undefined): string | undefined {
  const firstLine = (text: string | undefined) => text?.split("\n").find((line) => line.trim() !== "")?.trim();
  const own = firstLine(runTitle);
  if (own && own.toLowerCase() !== "task") return own;
  const line = firstLine(trigger);
  return line === undefined ? undefined : clip(line, 60);
}

/** A top-level task that ended badly: the one run that gets its own row in the transcript. */
export function isFailedRunRow(run: Run | undefined): run is Run {
  return run !== undefined && run.parentRunId === undefined && (run.status === "failed" || run.status === "stopped");
}

export type StepIconKey = "search" | "globe" | "click" | "keyboard" | "scroll" | "terminal" | "lock" | "hourglass" | "check";

/** Which glyph a step row wears (the iPhone's stepSymbol). */
export function stepIconKey(step: Step): StepIconKey {
  if (isRefusedPurchase(step)) return "hourglass";
  switch (toolOf(step)) {
    case "web_search":
      return "search";
    case "web_fetch":
    case "browser.navigate":
    case "browser.new_tab":
    case "browser.tabs":
      return searchQuery(stepUrl(step) ?? "") !== undefined ? "search" : "globe";
    case "browser.click":
    case "computer.click":
    case "computer.double_click":
    case "computer.right_click":
      return "click";
    case "browser.type":
    case "browser.fill":
    case "computer.type":
    case "computer.key":
      return "keyboard";
    case "computer.scroll":
      return "scroll";
    case "shell.run":
    case "shell.start":
      return "terminal";
    case "request_secure_input":
      return "lock";
    default:
      return "check";
  }
}
