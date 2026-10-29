/**
 * Replies travel as plain text: the backend has no reply field, so the quoted message leads the
 * body as "> " lines followed by a blank line. Same format as the iPhone app (ChatElements.swift
 * `Quote`), so both clients render each other's replies.
 */
const EXCERPT_MAX = 140;

/** Splits a leading block of ">" lines off a message. */
export function splitQuote(text: string): { quote?: string; body: string } {
  const lines = text.split("\n");
  const quoted: string[] = [];
  let index = 0;
  while (index < lines.length && lines[index]!.startsWith(">")) {
    quoted.push(lines[index]!.slice(1).replace(/^ +/, ""));
    index++;
  }
  if (quoted.length === 0) return { body: text };
  while (index < lines.length && lines[index]!.trim() === "") index++;
  return { quote: quoted.join("\n"), body: lines.slice(index).join("\n") };
}

/** "> first ~140 characters\n\n" for the message being replied to (its own quote is dropped). */
export function quotePrefix(source: string): string {
  const body = splitQuote(source).body;
  const cut = body.length > EXCERPT_MAX ? `${body.slice(0, EXCERPT_MAX)}…` : body;
  return `${cut.split("\n").map((line) => `> ${line}`).join("\n")}\n\n`;
}
