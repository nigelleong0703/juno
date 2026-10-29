import type { AgentHomeFile } from "@agent-desktop/client";
import type { ReactNode } from "react";
import { Button, Collapsible, CollapsibleContent, CollapsibleTrigger, ErrorState, ListRow, LoadingState } from "@agent-desktop/ui";
import { ChevronLeft } from "lucide-react";
import { useMemo } from "react";
import { useHomeFile, useHomeFiles } from "../../data/home";
import { useAgents } from "../../data/queries";
import { t } from "../../lib/i18n";
import { ShowMore, useCapped } from "../agents/card/parts";
import { MemoryFileEditor, ReadOnlyText } from "./MemoryFileEditor";
import { joinPersonPage, parseDailyPath, personName, splitPersonPage } from "./personPage";

/** Where a search hit (or a click) points: a file and, optionally, a line in it. */
export interface Focus {
  path: string;
  line?: number | undefined;
}

type FocusProps = { focus?: Focus | undefined };
const lineIn = (focus: Focus | undefined, path: string) => (focus?.path === path ? focus.line : undefined);

/** A home query's loading and error states, then the files. */
function Loaded({ query, children }: { query: { isPending: boolean; isError: boolean; refetch: () => unknown }; children: ReactNode }) {
  if (query.isPending) return <LoadingState label={t("common.loading")} />;
  if (query.isError) return <ErrorState title={t("common.error")} onRetry={() => void query.refetch()} />;
  return <>{children}</>;
}

/** MEMORY.md: the short sheet of facts, preferences and commitments the agents read first. */
export function MemoryFilePanel({ focus }: FocusProps) {
  const query = useHomeFile("MEMORY.md");
  return (
    <Loaded query={query}>
      <p className="mb-2 text-sm text-fg-muted">{t("memories.memoryHint")}</p>
      <p className="mb-2 border-l-2 border-border pl-3 text-xs italic text-fg-muted">{t("fileNote.memory")}</p>
      <MemoryFileEditor path="MEMORY.md" file={query.file} focusLine={lineIn(focus, "MEMORY.md")} placeholder={t("memories.memoryPlaceholder")} />
    </Loaded>
  );
}

const BANK = [
  { file: "circumstances", title: "memories.bank.circumstances" },
  { file: "experiences", title: "memories.bank.experiences" },
  { file: "preferences", title: "memories.bank.preferences" },
] as const;

/** About you: the three bank files (circumstances, experiences, preferences), each editable. */
export function BankPanel({ focus }: FocusProps) {
  const query = useHomeFiles("memory/bank/");
  return (
    <Loaded query={query}>
      <div className="space-y-6">
        {BANK.map(({ file, title }) => {
          const path = `memory/bank/${file}.md`;
          return (
            <section key={file} className="space-y-2">
              <h2 className="text-sm font-semibold text-fg">{t(title)}</h2>
              <MemoryFileEditor path={path} file={query.data?.find((f) => f.path === path)} focusLine={lineIn(focus, path)} />
            </section>
          );
        })}
      </div>
    </Loaded>
  );
}

/** One person: the shared body is editable, each agent's own section sits under it read-only. */
function PersonPage({ file, focus, onBack }: { file: AgentHomeFile; focus?: Focus | undefined; onBack: () => void }) {
  const { body, sections } = useMemo(() => splitPersonPage(file.content), [file.content]);
  const bodyLines = body.split("\n").length - 1;
  const line = lineIn(focus, file.path);
  return (
    <div className="space-y-4">
      <Button variant="ghost" size="sm" onClick={onBack}>
        <ChevronLeft className="size-3.5" />
        {t("common.back")}
      </Button>
      <MemoryFileEditor
        path={file.path}
        file={file}
        value={body}
        merge={(edited) => joinPersonPage(edited, sections)}
        focusLine={line !== undefined && line <= bodyLines ? line : undefined}
      />
      {sections.map((section) => (
        <section key={section.heading} className="space-y-1 rounded-md bg-surface px-3 py-2.5">
          <h3 className="text-sm font-medium text-fg">{section.heading}</h3>
          <p className="text-xs text-fg-subtle">{t("memories.agentSectionHint")}</p>
          <ReadOnlyText text={section.text.split("\n").slice(1).join("\n").trim()} firstLine={section.startLine + 1} markLine={line} />
        </section>
      ))}
    </div>
  );
}

/** People: one page per person in the user's life; open one to read or edit it. */
export function PeoplePanel({ focus, open, onOpen }: FocusProps & { open: string | undefined; onOpen: (path: string | undefined) => void }) {
  const query = useHomeFiles("people/");
  const people = useMemo(
    () => (query.data ?? []).map((file) => ({ file, name: personName(file.path, file.content) })).sort((a, b) => a.name.localeCompare(b.name)),
    [query.data],
  );
  const capped = useCapped(people);
  const current = open === undefined ? undefined : query.data?.find((f) => f.path === open);
  return (
    <Loaded query={query}>
      {current !== undefined ? (
        <PersonPage key={current.path} file={current} focus={focus} onBack={() => onOpen(undefined)} />
      ) : people.length === 0 ? (
        <p className="py-2 text-sm text-fg-muted">{t("memories.peopleEmpty")}</p>
      ) : (
        <div className="space-y-1">
          <p className="pb-1 text-sm text-fg-muted">{t("memories.peopleHint")}</p>
          {capped.shown.map(({ file, name }) => (
            <ListRow key={file.path} title={name} onClick={() => onOpen(file.path)} />
          ))}
          <ShowMore hidden={capped.hidden} onClick={capped.showMore} />
        </div>
      )}
    </Loaded>
  );
}

/** Daily notes: what each agent wrote down during the day, newest day first, read-only. */
export function DailyPanel({ focus }: FocusProps) {
  const query = useHomeFiles("memory/");
  const { data: agents } = useAgents();
  const days = useMemo(() => {
    const byDate = new Map<string, { file: AgentHomeFile; agentId: string }[]>();
    for (const file of query.data ?? []) {
      const parsed = parseDailyPath(file.path);
      if (parsed !== undefined) byDate.set(parsed.date, [...(byDate.get(parsed.date) ?? []), { file, agentId: parsed.agentId }]);
    }
    return [...byDate.entries()].sort(([a], [b]) => b.localeCompare(a));
  }, [query.data]);
  const capped = useCapped(days, 7);
  const focusDate = focus === undefined ? undefined : parseDailyPath(focus.path)?.date;
  return (
    <Loaded query={query}>
      {days.length === 0 ? (
        <p className="py-2 text-sm text-fg-muted">{t("memories.dailyEmpty")}</p>
      ) : (
        <div className="space-y-1">
          <p className="pb-1 text-sm text-fg-muted">{t("memories.dailyHint")}</p>
          {capped.shown.map(([date, entries], index) => (
            <Collapsible key={date} defaultOpen={focusDate === undefined ? index === 0 : focusDate === date}>
              <CollapsibleTrigger>{date}</CollapsibleTrigger>
              <CollapsibleContent className="space-y-3 px-3 pb-2">
                {entries.map(({ file, agentId }) => (
                  <div key={file.path} className="space-y-1">
                    <h3 className="text-xs font-medium text-fg-muted">{agents?.find((a) => a.id === agentId)?.name ?? agentId}</h3>
                    <ReadOnlyText text={file.content.trim()} markLine={lineIn(focus, file.path)} />
                  </div>
                ))}
              </CollapsibleContent>
            </Collapsible>
          ))}
          <ShowMore hidden={capped.hidden} onClick={capped.showMore} />
        </div>
      )}
    </Loaded>
  );
}

/** Learned reply style: ALIGNMENT_SYNTHESIS.md, read-only. */
export function StylePanel({ focus }: FocusProps) {
  const query = useHomeFile("ALIGNMENT_SYNTHESIS.md");
  return (
    <Loaded query={query}>
      <p className="mb-2 text-sm text-fg-muted">{t("agentCard.replyStyleHint")}</p>
      {query.file === undefined || query.file.content.trim() === "" ? (
        <p className="py-2 text-sm text-fg-muted">{t("memories.styleEmpty")}</p>
      ) : (
        <ReadOnlyText text={query.file.content.trim()} markLine={lineIn(focus, "ALIGNMENT_SYNTHESIS.md")} />
      )}
    </Loaded>
  );
}
