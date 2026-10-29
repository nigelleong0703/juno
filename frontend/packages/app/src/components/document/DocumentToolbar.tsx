import type { EditorCommand, EditorState } from "@agent-desktop/doc-editor";
import { Button, IconButton, Input, Popover, PopoverContent, PopoverTrigger, cn } from "@agent-desktop/ui";
import {
  Bold,
  Code,
  CodeXml,
  Heading1,
  Heading2,
  Italic,
  Link as LinkIcon,
  List,
  ListChecks,
  ListOrdered,
  Quote,
  Redo2,
  Strikethrough,
  Table,
  Undo2,
  type LucideIcon,
} from "lucide-react";
import { useState, type FormEvent } from "react";

interface ToolbarItem {
  command: EditorCommand;
  label: string;
  icon: LucideIcon;
}

const GROUPS: ToolbarItem[][] = [
  [
    { command: "undo", label: "Undo", icon: Undo2 },
    { command: "redo", label: "Redo", icon: Redo2 },
  ],
  [
    { command: "heading1", label: "Heading 1", icon: Heading1 },
    { command: "heading2", label: "Heading 2", icon: Heading2 },
  ],
  [
    { command: "bold", label: "Bold", icon: Bold },
    { command: "italic", label: "Italic", icon: Italic },
    { command: "strike", label: "Strikethrough", icon: Strikethrough },
    { command: "code", label: "Inline code", icon: Code },
  ],
  [
    { command: "bulletList", label: "Bulleted list", icon: List },
    { command: "orderedList", label: "Numbered list", icon: ListOrdered },
    { command: "taskList", label: "Task list", icon: ListChecks },
    { command: "blockquote", label: "Quote", icon: Quote },
    { command: "codeBlock", label: "Code block", icon: CodeXml },
    { command: "table", label: "Table", icon: Table },
  ],
];

export interface DocumentToolbarProps {
  state: EditorState;
  disabled?: boolean;
  onCommand: (command: EditorCommand, argument?: string) => void;
}

/** The formatting row above the rich editor: catalog icon buttons, one group per kind of change. Scrolls sideways on a phone. */
export function DocumentToolbar({ state, disabled = false, onCommand }: DocumentToolbarProps) {
  return (
    <div role="toolbar" aria-label="Formatting" className="flex shrink-0 items-center gap-3 overflow-x-auto border-b border-border px-3 py-1.5">
      {GROUPS.map((group, index) => (
        <div key={index} className="flex shrink-0 items-center gap-0.5">
          {group.map(({ command, label, icon: Icon }) => (
            <IconButton
              key={command}
              label={label}
              size="sm"
              disabled={disabled || ((command === "undo" || command === "redo") && state[command] === false)}
              aria-pressed={command === "undo" || command === "redo" ? undefined : Boolean(state[command])}
              className={cn(state[command] && command !== "undo" && command !== "redo" && "bg-interactive-selected")}
              onClick={() => onCommand(command)}
            >
              <Icon className="size-4" />
            </IconButton>
          ))}
        </div>
      ))}
      <LinkButton active={Boolean(state.link)} disabled={disabled} onApply={(url) => onCommand("link", url)} />
    </div>
  );
}

/** The link button asks for the address in a small popover (an empty address removes the link). */
function LinkButton({ active, disabled, onApply }: { active: boolean; disabled: boolean; onApply: (url: string) => void }) {
  const [open, setOpen] = useState(false);
  const [url, setUrl] = useState("");
  const submit = (event: FormEvent) => {
    event.preventDefault();
    onApply(url.trim());
    setOpen(false);
  };
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <IconButton label="Link" size="sm" disabled={disabled} aria-pressed={active} className={cn(active && "bg-interactive-selected")}>
          <LinkIcon className="size-4" />
        </IconButton>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-72">
        <form onSubmit={submit} className="flex items-center gap-2">
          <Input aria-label="Link address" placeholder="https://" value={url} onChange={(event) => setUrl(event.target.value)} autoFocus />
          <Button type="submit" size="sm">
            {url.trim() ? "Apply" : "Remove"}
          </Button>
        </form>
      </PopoverContent>
    </Popover>
  );
}
