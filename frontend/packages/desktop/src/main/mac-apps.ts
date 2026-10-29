/**
 * Mail, Calendar, Reminders and Notes on this Mac for the agent (link action `mac_apps`): JXA programs run with
 * `osascript -l JavaScript`. Every program is a fixed constant; the agent's arguments reach it only as JSON in
 * argv[0], never inside the source. Any account added in macOS Internet Accounts works. Results are plain text.
 */
import { execFile } from "node:child_process";

export type MacAppsExec = (file: string, args: string[], options: { timeout: number; maxBuffer: number }) => Promise<{ stdout: string }>;

const defaultExec: MacAppsExec = (file, args, options) =>
  new Promise((resolve, reject) => {
    execFile(file, args, options, (error, stdout) => (error === null ? resolve({ stdout }) : reject(error)));
  });

const program = (body: string): string => `function run(argv) {
  const a = JSON.parse(argv[0]);
  const iso = (d) => {
    if (!d) return null;
    const p = (n) => String(Math.abs(n)).padStart(2, '0');
    const o = -d.getTimezoneOffset();
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + 'T' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds()) + (o < 0 ? '-' : '+') + p(Math.trunc(o / 60)) + ':' + p(o % 60);
  };
  ${body}
}`;

const MAIL_SEARCH = program(`
  const Mail = Application('Mail');
  const boxes = a.mailbox ? Mail.accounts().flatMap((acc) => acc.mailboxes().filter((b) => b.name() === a.mailbox)) : [Mail.inbox];
  const out = [];
  for (const box of boxes) {
    const q = a.query;
    const found = box.messages.whose({ _or: [{ subject: { _contains: q } }, { sender: { _contains: q } }] })();
    for (const m of found.slice(0, a.limit)) {
      out.push({ id: m.mailbox().account().name() + '|' + m.mailbox().name() + '|' + m.id(), subject: m.subject(), sender: m.sender(), date: iso(m.dateReceived()), read: m.readStatus() });
    }
  }
  out.sort((x, y) => (x.date < y.date ? 1 : -1));
  return JSON.stringify(out.slice(0, a.limit));`);

const MAIL_READ = program(`
  const Mail = Application('Mail');
  const [account, mailbox, n] = a.id.split('|');
  const m = Mail.accounts.byName(account).mailboxes.byName(mailbox).messages.byId(Number(n));
  return JSON.stringify({ subject: m.subject(), sender: m.sender(), to: m.toRecipients().map((r) => r.address()), cc: m.ccRecipients().map((r) => r.address()), date: iso(m.dateReceived()), body: m.content() });`);

const COMPOSE = (finish: string): string => program(`
  const Mail = Application('Mail');
  const m = Mail.OutgoingMessage({ subject: a.subject, content: a.body, visible: false });
  Mail.outgoingMessages.push(m);
  for (const address of a.to) m.toRecipients.push(Mail.Recipient({ address }));
  for (const address of a.cc) m.ccRecipients.push(Mail.Recipient({ address }));
  ${finish}
  return JSON.stringify({ ok: true });`);

const MAIL_CREATE_DRAFT = COMPOSE('m.save();');
const MAIL_SEND = COMPOSE('m.send();');

const CALENDAR_LIST_EVENTS = program(`
  const Cal = Application('Calendar');
  const from = new Date(a.from);
  const to = new Date(a.to);
  const out = [];
  for (const c of Cal.calendars().filter((x) => !a.calendar || x.name() === a.calendar)) {
    for (const e of c.events.whose({ _and: [{ startDate: { '>=': from } }, { startDate: { '<': to } }] })()) {
      out.push({ id: e.uid(), title: e.summary(), start: iso(e.startDate()), end: iso(e.endDate()), allDay: e.alldayEvent(), location: e.location(), calendar: c.name() });
    }
  }
  out.sort((x, y) => (x.start < y.start ? -1 : 1));
  return JSON.stringify(out.slice(0, a.limit));`);

const CALENDAR_CREATE_EVENT = program(`
  const Cal = Application('Calendar');
  const c = a.calendar ? Cal.calendars.byName(a.calendar) : Cal.calendars().find((x) => x.writable());
  const e = Cal.Event({ summary: a.title, startDate: new Date(a.start), endDate: new Date(a.end), location: a.location || '', description: a.notes || '' });
  c.events.push(e);
  return JSON.stringify({ title: a.title, calendar: c.name() });`);

const REMINDERS_LIST = program(`
  const Rem = Application('Reminders');
  const out = [];
  for (const l of Rem.lists().filter((x) => !a.list || x.name() === a.list)) {
    const items = a.includeCompleted ? l.reminders() : l.reminders.whose({ completed: false })();
    for (const r of items) out.push({ id: r.id(), title: r.name(), due: iso(r.dueDate()), done: r.completed(), notes: r.body(), list: l.name() });
  }
  return JSON.stringify(out.slice(0, a.limit));`);

const REMINDERS_CREATE = program(`
  const Rem = Application('Reminders');
  const l = a.list ? Rem.lists.byName(a.list) : Rem.defaultList();
  const props = { name: a.title, body: a.notes || '' };
  if (a.due) props.dueDate = new Date(a.due);
  l.reminders.push(Rem.Reminder(props));
  return JSON.stringify({ title: a.title, list: l.name() });`);

const REMINDERS_COMPLETE = program(`
  const r = Application('Reminders').reminders.byId(a.id);
  r.completed = true;
  return JSON.stringify({ title: r.name() });`);

const NOTES_SEARCH = program(`
  const Notes = Application('Notes');
  const q = a.query.toLowerCase();
  const out = [];
  for (const n of Notes.notes()) {
    const name = n.name();
    if (!name.toLowerCase().includes(q)) continue;
    out.push({ id: n.id(), title: name, folder: n.container().name(), modified: iso(n.modificationDate()) });
  }
  out.sort((x, y) => (x.modified < y.modified ? 1 : -1));
  return JSON.stringify(out.slice(0, a.limit));`);

const NOTES_READ = program(`
  const n = Application('Notes').notes.byId(a.id);
  return JSON.stringify({ title: n.name(), folder: n.container().name(), modified: iso(n.modificationDate()), body: n.plaintext() });`);

const NOTES_CREATE = program(`
  const Notes = Application('Notes');
  const esc = (t) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const html = '<div><h1>' + esc(a.title) + '</h1></div>' + a.body.split('\\n').map((l) => '<div>' + (l === '' ? '<br>' : esc(l)) + '</div>').join('');
  const f = a.folder ? Notes.folders.byName(a.folder) : Notes.defaultAccount().folders[0];
  const n = Notes.Note({ body: html });
  f.notes.push(n);
  return JSON.stringify({ title: a.title, folder: f.name() });`);

const NOTES_APPEND = program(`
  const n = Application('Notes').notes.byId(a.id);
  const esc = (t) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  n.body = n.body() + a.text.split('\\n').map((l) => '<div>' + (l === '' ? '<br>' : esc(l)) + '</div>').join('');
  return JSON.stringify({ title: n.name() });`);

export const MAC_APPS_PERMISSION = "Juno needs permission to control Mail/Calendar/Reminders/Notes. Allow it in System Settings → Privacy & Security → Automation.";
const BODY_CAP = 8000;

const text = (value: unknown): string | undefined => (typeof value === "string" && value.trim() !== "" ? value.trim() : undefined);
const need = (value: unknown, name: string): string => {
  const found = text(value);
  if (found === undefined) throw new Error(`Missing ${name}`);
  return found;
};
const limitOf = (value: unknown, fallback: number, max: number): number =>
  typeof value === "number" && Number.isFinite(value) ? Math.min(max, Math.max(1, Math.trunc(value))) : fallback;
const addresses = (value: unknown, name: string, required: boolean): string[] => {
  const all = Array.isArray(value) ? value.filter((v): v is string => typeof v === "string" && v.trim() !== "").map((v) => v.trim()) : [];
  if (required && all.length === 0) throw new Error(`Missing ${name}`);
  return all;
};
const when = (value: unknown, name: string): string => {
  const found = need(value, name);
  if (Number.isNaN(new Date(found).getTime())) throw new Error(`${name} is not an ISO 8601 date: ${found}`);
  return found;
};
const rows = (value: unknown): Record<string, unknown>[] => (Array.isArray(value) ? value.filter((v): v is Record<string, unknown> => typeof v === "object" && v !== null) : []);
const record = (value: unknown): Record<string, unknown> => (typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {});

type Args = Record<string, unknown>;
type Run = (osa: (script: string, payload: Args) => Promise<unknown>, args: Args) => Promise<string>;

/** The tool names the backend allows (computerd routes-mac.ts); each validates its arguments, runs one fixed program and shapes text. */
const TOOLS: Record<string, Run> = {
  async mail_search(osa, args) {
    const found = rows(await osa(MAIL_SEARCH, { query: need(args["query"], "query"), mailbox: text(args["mailbox"]) ?? "", limit: limitOf(args["limit"], 10, 25) }));
    return found.length === 0 ? "No matching messages" : found.map((m) => `${String(m["date"])}  ${m["read"] === true ? "" : "[unread] "}${String(m["subject"])}\n  from ${String(m["sender"])}\n  id: ${String(m["id"])}`).join("\n");
  },
  async mail_read(osa, args) {
    const m = record(await osa(MAIL_READ, { id: need(args["id"], "id") }));
    const body = String(m["body"] ?? "");
    const cc = Array.isArray(m["cc"]) && m["cc"].length > 0 ? `\nCc: ${m["cc"].join(", ")}` : "";
    return `Subject: ${String(m["subject"])}\nFrom: ${String(m["sender"])}\nTo: ${Array.isArray(m["to"]) ? m["to"].join(", ") : ""}${cc}\nDate: ${String(m["date"])}\n\n${body.length > BODY_CAP ? `${body.slice(0, BODY_CAP)}\n[truncated]` : body}`;
  },
  async mail_create_draft(osa, args) {
    const to = addresses(args["to"], "to", true);
    await osa(MAIL_CREATE_DRAFT, { to, cc: addresses(args["cc"], "cc", false), subject: need(args["subject"], "subject"), body: String(args["body"] ?? "") });
    return `Draft saved for ${to.join(", ")}`;
  },
  async mail_send(osa, args) {
    const to = addresses(args["to"], "to", true);
    await osa(MAIL_SEND, { to, cc: addresses(args["cc"], "cc", false), subject: need(args["subject"], "subject"), body: String(args["body"] ?? "") });
    return `Sent to ${to.join(", ")}`;
  },
  async calendar_list_events(osa, args) {
    const found = rows(await osa(CALENDAR_LIST_EVENTS, { from: when(args["from"], "from"), to: when(args["to"], "to"), calendar: text(args["calendar"]) ?? "", limit: limitOf(args["limit"], 20, 50) }));
    return found.length === 0 ? "No events in that range" : found.map((e) => `${String(e["start"])} to ${String(e["end"])}${e["allDay"] === true ? " (all day)" : ""}  ${String(e["title"])} [${String(e["calendar"])}]${text(e["location"]) === undefined ? "" : ` at ${String(e["location"])}`}`).join("\n");
  },
  async calendar_create_event(osa, args) {
    const done = record(await osa(CALENDAR_CREATE_EVENT, { title: need(args["title"], "title"), start: when(args["start"], "start"), end: when(args["end"], "end"), calendar: text(args["calendar"]) ?? "", location: text(args["location"]) ?? "", notes: text(args["notes"]) ?? "" }));
    return `Added "${String(done["title"])}" to ${String(done["calendar"])}`;
  },
  async reminders_list(osa, args) {
    const found = rows(await osa(REMINDERS_LIST, { list: text(args["list"]) ?? "", includeCompleted: args["includeCompleted"] === true, limit: limitOf(args["limit"], 20, 50) }));
    return found.length === 0 ? "No reminders" : found.map((r) => `${r["done"] === true ? "[done] " : ""}${String(r["title"])} [${String(r["list"])}]${r["due"] === null ? "" : ` due ${String(r["due"])}`}\n  id: ${String(r["id"])}`).join("\n");
  },
  async reminders_create(osa, args) {
    const done = record(await osa(REMINDERS_CREATE, { title: need(args["title"], "title"), list: text(args["list"]) ?? "", due: args["due"] === undefined ? "" : when(args["due"], "due"), notes: text(args["notes"]) ?? "" }));
    return `Added "${String(done["title"])}" to ${String(done["list"])}`;
  },
  async reminders_complete(osa, args) {
    return `Completed "${String(record(await osa(REMINDERS_COMPLETE, { id: need(args["id"], "id") }))["title"])}"`;
  },
  async notes_search(osa, args) {
    const found = rows(await osa(NOTES_SEARCH, { query: need(args["query"], "query"), limit: limitOf(args["limit"], 10, 20) }));
    return found.length === 0 ? "No matching notes" : found.map((n) => `${String(n["modified"])}  ${String(n["title"])} [${String(n["folder"])}]\n  id: ${String(n["id"])}`).join("\n");
  },
  async notes_read(osa, args) {
    const n = record(await osa(NOTES_READ, { id: need(args["id"], "id") }));
    const body = String(n["body"] ?? "");
    return `Title: ${String(n["title"])}\nFolder: ${String(n["folder"])}\nModified: ${String(n["modified"])}\n\n${body.length > BODY_CAP ? `${body.slice(0, BODY_CAP)}\n[truncated]` : body}`;
  },
  async notes_create(osa, args) {
    const done = record(await osa(NOTES_CREATE, { title: need(args["title"], "title"), body: String(args["body"] ?? ""), folder: text(args["folder"]) ?? "" }));
    return `Created note "${String(done["title"])}" in ${String(done["folder"])}`;
  },
  async notes_append(osa, args) {
    return `Appended to "${String(record(await osa(NOTES_APPEND, { id: need(args["id"], "id"), text: need(args["text"], "text") }))["title"])}"`;
  },
};

/** What a failed osascript run means for the agent. */
function failure(error: unknown): Error {
  const failed = error as { killed?: boolean; signal?: string; stderr?: string; message?: string };
  const detail = `${failed.stderr ?? ""} ${failed.message ?? ""}`;
  if (/-1743|-1744|not authori[sz]ed|not allowed/i.test(detail)) return new Error(MAC_APPS_PERMISSION);
  if (failed.killed === true || failed.signal === "SIGTERM") return new Error("The Mac did not answer within 20 seconds; the app may be waiting for a permission prompt on screen.");
  const short = detail.replace(/\s+/g, " ").trim();
  return new Error(`The Mac call failed${short === "" ? "" : `: ${short.slice(0, 300)}`}`);
}

export async function runMacApp(tool: unknown, args: unknown, exec: MacAppsExec = defaultExec): Promise<string> {
  const run = typeof tool === "string" && Object.hasOwn(TOOLS, tool) ? TOOLS[tool] : undefined;
  if (run === undefined) throw new Error(`unsupported Mac app tool: ${String(tool)}`);
  const osa = async (script: string, payload: Args): Promise<unknown> => {
    let stdout: string;
    try {
      ({ stdout } = await exec("osascript", ["-l", "JavaScript", "-e", script, JSON.stringify(payload)], { timeout: 20_000, maxBuffer: 1_000_000 }));
    } catch (error) {
      throw failure(error);
    }
    return JSON.parse(stdout.trim() === "" ? "null" : stdout) as unknown;
  };
  return run(osa, typeof args === "object" && args !== null ? (args as Args) : {});
}
