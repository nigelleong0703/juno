import type { ProfileEntry, ProfileVisibility } from "@agent-desktop/client";
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  IconButton,
  ListRow,
} from "@agent-desktop/ui";
import { ChevronDown, MoreHorizontal, Plus } from "lucide-react";
import { useState } from "react";
import { errorCode } from "../../data/model-providers";
import { useProfile, useSaveProfile } from "../../data/profile";
import { useAgents } from "../../data/queries";
import { EntryDialog, type EntryDraft } from "./DetailDialogs";
import { Group } from "./SettingsGroup";

/** Rows shown before "Show N more". */
const VISIBLE_ROWS = 8;

const EMPTY = "Nothing yet. Juno adds details here as it learns them, or add one yourself.";

function oneLine(value: string): string {
  return value
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .join(", ");
}

function sourceLine(entry: ProfileEntry, agentName: string | undefined): string {
  if (entry.source.by === "user") return "Added by you";
  const day = new Date(entry.source.at).toLocaleDateString("en", { month: "short", day: "numeric" });
  return `Learned by ${agentName ?? "your agent"} · ${day}`;
}

export function YourDetailsSection() {
  const profile = useProfile();
  const save = useSaveProfile();
  const agents = useAgents();
  const [expanded, setExpanded] = useState(false);
  const [editing, setEditing] = useState<{ id: string | null } | null>(null);
  const [error, setError] = useState<string | null>(null);
  if (profile.isPending) return null;
  if (profile.isError) {
    return (
      <p className="text-sm text-fg-muted">
        Could not load your details.{" "}
        <button type="button" className="underline" onClick={() => void profile.refetch()}>
          Retry
        </button>
      </p>
    );
  }
  const entries = profile.data.entries;
  const shown = expanded ? entries : entries.slice(0, VISIBLE_ROWS);
  const agentName = (id: string | undefined) => agents.data?.find((agent) => agent.id === id)?.name;

  /** `PUT` replaces the list, so every edit sends all the entries. */
  const write = (next: Array<Pick<ProfileEntry, "id" | "key" | "value" | "visibility">>) =>
    save.mutateAsync({ entries: next.map(({ id, key, value, visibility }) => ({ id, key, value, visibility })) });
  const attempt = async (next: Array<Pick<ProfileEntry, "id" | "key" | "value" | "visibility">>) => {
    setError(null);
    try {
      await write(next);
    } catch (failure) {
      setError(errorCode(failure).message ?? "Could not save. Try again.");
    }
  };
  const setVisibility = (id: string, visibility: ProfileVisibility) =>
    void attempt(entries.map((entry) => (entry.id === id ? { ...entry, visibility } : entry)));
  const submit = (id: string | null, draft: EntryDraft) =>
    write(id === null ? [...entries, { id: crypto.randomUUID(), ...draft }] : entries.map((entry) => (entry.id === id ? { ...entry, ...draft } : entry)));
  const current = editing?.id == null ? undefined : entries.find((entry) => entry.id === editing.id);

  return (
    <div className="space-y-6">
      <header className="space-y-1">
        <p className="text-xs text-fg-muted">
          Details your agents fill into forms for you, so you do not retype them. They add what they learn here, and you can edit or remove anything.
          Passwords and card details never go here.
        </p>
      </header>
      <Group
        action={
          <Button variant="secondary" size="sm" onClick={() => setEditing({ id: null })}>
            <Plus className="size-3.5" /> Add
          </Button>
        }
      >
        {entries.length === 0 && <p className="px-2.5 py-2 text-sm text-fg-muted">{EMPTY}</p>}
        {shown.map((entry) => (
          <ListRow
            key={entry.id}
            title={entry.key}
            description={
              <span className="block min-w-0">
                <span className="block truncate">{oneLine(entry.value)}</span>
                <span className="block truncate text-xs text-fg-subtle">{sourceLine(entry, agentName(entry.source.agentId))}</span>
              </span>
            }
            onClick={() => setEditing({ id: entry.id })}
            meta={
              <span onClick={(event) => event.stopPropagation()} onKeyDown={(event) => event.stopPropagation()}>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="ghost" size="sm" aria-label={`Who can use ${entry.key}`}>
                      {entry.visibility === "shared" ? "Shared" : "Only me"}
                      <ChevronDown className="size-3" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuRadioGroup value={entry.visibility} onValueChange={(next) => setVisibility(entry.id, next === "shared" ? "shared" : "private")}>
                      <DropdownMenuRadioItem value="private">Only me</DropdownMenuRadioItem>
                      <DropdownMenuRadioItem value="shared">Shared</DropdownMenuRadioItem>
                    </DropdownMenuRadioGroup>
                  </DropdownMenuContent>
                </DropdownMenu>
              </span>
            }
            trailing={
              <span onClick={(event) => event.stopPropagation()} onKeyDown={(event) => event.stopPropagation()}>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <IconButton label={`Actions for ${entry.key}`} size="sm">
                      <MoreHorizontal className="size-4" />
                    </IconButton>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem onSelect={() => setEditing({ id: entry.id })}>Edit</DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem variant="destructive" onSelect={() => void attempt(entries.filter((row) => row.id !== entry.id))}>
                      Delete
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </span>
            }
          />
        ))}
        {entries.length > VISIBLE_ROWS && (
          <Button variant="ghost" size="sm" onClick={() => setExpanded((open) => !open)}>
            {expanded ? "Show less" : `Show ${entries.length - VISIBLE_ROWS} more`}
          </Button>
        )}
        {error && (
          <p role="alert" className="px-2.5 py-2 text-sm text-danger">
            {error}
          </p>
        )}
      </Group>
      {editing && (
        <EntryDialog
          key={editing.id ?? "new"}
          entry={current}
          onSave={(draft) => submit(editing.id, draft)}
          onClose={() => setEditing(null)}
        />
      )}
    </div>
  );
}
