/** One `## <agent name>（<agentId>）` section at the end of a people page: that agent's own dealings with the person. */
export interface AgentSection {
  heading: string;
  text: string;
  /** 1-based line of the heading in the whole file. */
  startLine: number;
}

const AGENT_HEADING = /^## .*（[^）]*）\s*$/;

/** A people page: the shared body (editable) and the per-agent sections (read-only). `body + sections` rebuilds the file. */
export function splitPersonPage(text: string): { body: string; sections: AgentSection[] } {
  const lines = text.split("\n");
  const starts = lines.flatMap((line, i) => (AGENT_HEADING.test(line) ? [i] : []));
  if (starts.length === 0) return { body: text, sections: [] };
  const first = starts[0] ?? lines.length;
  const sections = starts.map((start, n) => {
    const end = starts[n + 1] ?? lines.length;
    return { heading: (lines[start] ?? "").replace(/^##\s*/, "").trim(), text: lines.slice(start, end).join("\n").trimEnd(), startLine: start + 1 };
  });
  return { body: lines.slice(0, first).join("\n").trimEnd() + "\n", sections };
}

/** Put an edited body back in front of the untouched agent sections. */
export function joinPersonPage(body: string, sections: AgentSection[]): string {
  const head = body.trimEnd() + "\n";
  return sections.length === 0 ? head : head + "\n" + sections.map((s) => s.text).join("\n\n") + "\n";
}

/** The page title: its first heading, else the file name. */
export function personName(path: string, content: string): string {
  const heading = /^#\s+(.+)$/m.exec(content)?.[1]?.trim();
  return heading ?? (path.split("/").pop() ?? path).replace(/\.md$/, "");
}

/** A daily log path `memory/<date>/<agentId>.md` as its date and agent id. */
export function parseDailyPath(path: string): { date: string; agentId: string } | undefined {
  const m = /^memory\/(\d{4}-\d{2}-\d{2})\/([^/]+)\.md$/.exec(path);
  return m === null ? undefined : { date: m[1] ?? "", agentId: m[2] ?? "" };
}
