import { ErrorState, ListRow, LoadingState, PageHeader, ScrollArea, SearchField, Tabs, TabsContent, TabsList, TabsTrigger } from "@agent-desktop/ui";
import { useEffect, useState } from "react";
import { useMemorySearch } from "../../data/memories";
import { t } from "../../lib/i18n";
import { ShowMore, useCapped } from "../agents/card/parts";
import { ClaimsPanel } from "./ClaimsPanel";
import { BankPanel, DailyPanel, MemoryFilePanel, PeoplePanel, StylePanel, type Focus } from "./MemoryPanels";
import { parseDailyPath } from "./personPage";

const TABS = ["memory", "about", "people", "daily", "style", "claims"] as const;
type TabId = (typeof TABS)[number];

/** The tab that shows a memory file. */
function tabOf(path: string): TabId {
  if (path === "MEMORY.md") return "memory";
  if (path.startsWith("memory/bank/")) return "about";
  if (path.startsWith("people/")) return "people";
  if (path === "ALIGNMENT_SYNTHESIS.md") return "style";
  return parseDailyPath(path) === undefined ? "memory" : "daily";
}

/** The label of the view a memory item is shown in (`MemorySearchHit.file`). */
const FILE_LABEL: Record<string, string> = {
  memory: "memories.tab.memory",
  "bank:circumstances": "memories.bank.circumstances",
  "bank:experiences": "memories.bank.experiences",
  "bank:preferences": "memories.bank.preferences",
  person: "memories.tab.people",
};

/** The file a memory item opens in: MEMORY.md or a bank file. A person page has no path in the hit, so it opens nothing. */
function focusOf(file: string): Focus | undefined {
  if (file === "memory") return { path: "MEMORY.md" };
  if (file.startsWith("bank:")) return { path: `memory/bank/${file.slice("bank:".length)}.md` };
  return undefined;
}

function SearchResults({ query, onOpen }: { query: string; onOpen: (focus: Focus) => void }) {
  const { data, isLoading, isError, refetch } = useMemorySearch(query);
  const capped = useCapped(data ?? []);
  if (isLoading) return <LoadingState label={t("common.loading")} />;
  if (isError) return <ErrorState title={t("common.error")} onRetry={() => void refetch()} />;
  if (data?.length === 0) return <p className="py-2 text-sm text-fg-muted">{t("memories.searchEmpty")}</p>;
  return (
    <div className="space-y-1">
      {capped.shown.map((hit) => {
        const focus = focusOf(hit.file);
        const label = FILE_LABEL[hit.file];
        return (
          <ListRow
            key={hit.id}
            title={<span className="line-clamp-2 whitespace-normal">{hit.text}</span>}
            meta={label === undefined ? hit.file : t(label)}
            onClick={focus === undefined ? undefined : () => onOpen(focus)}
          />
        );
      })}
      <ShowMore hidden={capped.hidden} onClick={capped.showMore} />
    </div>
  );
}

/**
 * Memory, the way Muse shows it: the files the agents keep about you, readable and editable (MEMORY.md,
 * the About-you bank, people pages), the read-only daily notes and learned reply style, and the claims
 * behind them with the words that back each one and a way to forget.
 */
export function MemoriesPage() {
  const [tab, setTab] = useState<TabId>("memory");
  const [focus, setFocus] = useState<Focus | undefined>(undefined);
  const [person, setPerson] = useState<string | undefined>(undefined);
  const [text, setText] = useState("");
  const [query, setQuery] = useState("");

  useEffect(() => {
    const id = setTimeout(() => setQuery(text.trim()), 300);
    return () => clearTimeout(id);
  }, [text]);

  const open = (target: Focus) => {
    setFocus(target);
    setTab(tabOf(target.path));
    setPerson(target.path.startsWith("people/") ? target.path : undefined);
    setText("");
    setQuery("");
  };

  return (
    <div className="flex h-full min-h-0 flex-col bg-bg">
      <PageHeader title={t("memories.title")} subtitle={t("memories.subtitle")} />
      <div className="mx-auto w-full max-w-4xl px-5 py-3">
        <SearchField className="w-72" size="sm" value={text} onValueChange={setText} placeholder={t("memories.searchPlaceholder")} />
      </div>
      <ScrollArea className="min-h-0 flex-1">
        <div className="mx-auto w-full max-w-4xl px-5 pb-10">
          {query.length > 0 ? (
            <SearchResults query={query} onOpen={open} />
          ) : (
            <Tabs
              value={tab}
              onValueChange={(value) => {
                setTab(value as TabId);
                setFocus(undefined);
              }}
            >
              <div className="overflow-x-auto">
                <TabsList>
                  {TABS.map((id) => (
                    <TabsTrigger key={id} value={id}>
                      {t(`memories.tab.${id}`)}
                    </TabsTrigger>
                  ))}
                </TabsList>
              </div>
              <TabsContent value="memory" className="pt-4"><MemoryFilePanel focus={focus} /></TabsContent>
              <TabsContent value="about" className="pt-4"><BankPanel focus={focus} /></TabsContent>
              <TabsContent value="people" className="pt-4"><PeoplePanel focus={focus} open={person} onOpen={setPerson} /></TabsContent>
              <TabsContent value="daily" className="pt-4"><DailyPanel focus={focus} /></TabsContent>
              <TabsContent value="style" className="pt-4"><StylePanel focus={focus} /></TabsContent>
              <TabsContent value="claims" className="pt-4"><ClaimsPanel /></TabsContent>
            </Tabs>
          )}
        </div>
      </ScrollArea>
    </div>
  );
}
