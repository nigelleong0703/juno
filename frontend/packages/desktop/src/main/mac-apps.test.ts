import { describe, expect, it } from "vitest";
import { createMacDesktop } from "./mac-desktop";
import { MAC_APPS_PERMISSION, runMacApp, type MacAppsExec } from "./mac-apps";

const fake = (reply: unknown | (() => never)) => {
  const calls: string[][] = [];
  const exec: MacAppsExec = (_file, args) => {
    calls.push(args);
    return typeof reply === "function" ? Promise.reject((reply as () => never)()) : Promise.resolve({ stdout: JSON.stringify(reply) });
  };
  return { exec, calls };
};

describe("mac apps", () => {
  it("passes arguments as JSON in argv and never puts them in the script", async () => {
    const { exec, calls } = fake({ ok: true });
    const subject = 'x"); do shell script "rm -rf ~"; ("';
    expect(await runMacApp("mail_send", { to: ["a@b.test"], subject, body: "hi" }, exec)).toBe("Sent to a@b.test");
    const args = calls[0] ?? [];
    expect(args.slice(0, 3)).toEqual(["-l", "JavaScript", "-e"]);
    expect(args[3]).not.toContain("rm -rf");
    expect(JSON.parse(args[4] ?? "")).toEqual({ to: ["a@b.test"], cc: [], subject, body: "hi" });
  });

  it("shapes mail, calendar and reminders as plain text", async () => {
    expect(await runMacApp("mail_search", { query: "budget" }, fake([{ id: "Work|INBOX|7", subject: "Budget", sender: "Ann", date: "d", read: false }]).exec)).toBe("d  [unread] Budget\n  from Ann\n  id: Work|INBOX|7");
    const read = await runMacApp("mail_read", { id: "Work|INBOX|7" }, fake({ subject: "S", sender: "Ann", to: ["me@x.test"], cc: [], date: "d", body: "z".repeat(9000) }).exec);
    expect(read).toContain("Subject: S\nFrom: Ann\nTo: me@x.test\nDate: d");
    expect(read.endsWith("[truncated]")).toBe(true);
    expect(await runMacApp("calendar_list_events", { from: "2026-10-21", to: "2026-10-22" }, fake([{ title: "Standup", start: "s", end: "e", allDay: false, location: "Room 1", calendar: "Work" }]).exec)).toBe("s to e  Standup [Work] at Room 1");
    expect(await runMacApp("reminders_list", {}, fake([{ id: "r1", title: "Pay rent", due: null, done: false, list: "Home" }]).exec)).toBe("Pay rent [Home]\n  id: r1");
    expect(await runMacApp("reminders_complete", { id: "r1" }, fake({ title: "Pay rent" }).exec)).toBe('Completed "Pay rent"');
  });

  it("shapes notes as plain text and passes note text only as JSON", async () => {
    expect(await runMacApp("notes_search", { query: "plan" }, fake([{ id: "x-coredata://n1", title: "Plan", folder: "Notes", modified: "m" }]).exec)).toBe("m  Plan [Notes]\n  id: x-coredata://n1");
    const read = await runMacApp("notes_read", { id: "n1" }, fake({ title: "Plan", folder: "Notes", modified: "m", body: "z".repeat(9000) }).exec);
    expect(read.startsWith("Title: Plan\nFolder: Notes")).toBe(true);
    expect(read.endsWith("[truncated]")).toBe(true);
    const { exec, calls } = fake({ title: "T", folder: "Notes" });
    expect(await runMacApp("notes_create", { title: "T", body: "a<b>\"); x" }, exec)).toBe('Created note "T" in Notes');
    expect(calls[0]?.[3]).not.toContain("a<b>");
    expect(await runMacApp("notes_append", { id: "n1", text: "more" }, fake({ title: "Plan" }).exec)).toBe('Appended to "Plan"');
  });

  it("refuses unknown tools and bad arguments, and maps permission and timeout errors", async () => {
    const { exec } = fake([]);
    await expect(runMacApp("shell", {}, exec)).rejects.toThrow("unsupported");
    await expect(runMacApp("calendar_create_event", { title: "t", start: "nope", end: "x" }, exec)).rejects.toThrow("not an ISO");
    const denied = fake(() => { throw Object.assign(new Error("failed"), { stderr: "Not authorized to send Apple events to Mail. (-1743)" }); });
    await expect(runMacApp("mail_search", { query: "x" }, denied.exec)).rejects.toThrow(MAC_APPS_PERMISSION);
    const slow = fake(() => { throw Object.assign(new Error("t"), { killed: true, signal: "SIGTERM" }); });
    await expect(runMacApp("reminders_list", {}, slow.exec)).rejects.toThrow("permission prompt");
  });

  it("is served by the desktop host as the mac_apps action", async () => {
    const desktop = createMacDesktop({ folder: "/tmp", helperPath: "/nope", browser: async () => ({}), appsExec: fake({ title: "Call", list: "Home" }).exec });
    const signal = new AbortController().signal;
    expect(await desktop.handle({ agentId: "agent_a", action: "mac_apps", input: { tool: "reminders_create", args: { title: "Call" } } }, signal)).toEqual({ text: 'Added "Call" to Home' });
    await expect(desktop.handle({ agentId: "agent_a", action: "mac_apps", input: { tool: "nope", args: {} } }, signal)).rejects.toMatchObject({ code: "mac_apps_failed" });
  });
});
