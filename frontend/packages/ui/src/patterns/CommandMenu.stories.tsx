import type { Meta, StoryObj } from "@storybook/react-vite";
import {
  BookOpen,
  Code2,
  Copy,
  FileText,
  Plus,
  Settings,
  Trash2,
} from "lucide-react";
import { useState } from "react";
import { Button } from "../primitives";
import { CommandMenu } from "./CommandMenu";

const meta = {
  title: "Patterns/CommandMenu",
  component: CommandMenu,
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof CommandMenu>;

export default meta;
type Story = StoryObj<typeof CommandMenu>;

const commandGroups = [
  {
    heading: "Actions",
    items: [
      {
        id: "new-agent",
        label: "New agent",
        keywords: ["create", "add"],
        icon: <Plus className="size-4" />,
        shortcut: "⌘N",
      },
      {
        id: "new-task",
        label: "New task",
        keywords: ["create", "add"],
        icon: <Plus className="size-4" />,
        shortcut: "⌘T",
      },
    ],
  },
  {
    heading: "Agents",
    items: [
      {
        id: "agent-juno",
        label: "Juno (task runner)",
        keywords: ["agent", "juno"],
      },
      {
        id: "agent-patch",
        label: "Patch (file editor)",
        keywords: ["agent", "patch"],
      },
      {
        id: "agent-echo",
        label: "Echo (logger)",
        keywords: ["agent", "echo"],
      },
    ],
  },
  {
    heading: "Help",
    items: [
      {
        id: "docs",
        label: "Documentation",
        keywords: ["help", "docs"],
        icon: <BookOpen className="size-4" />,
        shortcut: "?",
      },
      {
        id: "settings",
        label: "Settings",
        keywords: ["config"],
        icon: <Settings className="size-4" />,
        shortcut: "⌘,",
      },
    ],
  },
];

function OpenDemo() {
  const [open, setOpen] = useState(true);

  return (
    <div>
      <CommandMenu
        open={open}
        onOpenChange={setOpen}
        groups={commandGroups}
        placeholder="Search agents or commands…"
      />
      <div className="p-8 text-center text-fg">
        <p className="mb-4">Command menu is open above</p>
        <Button
          onClick={() => setOpen(!open)}
        >
          {open ? "Close" : "Open"} Menu
        </Button>
      </div>
    </div>
  );
}

export const Open: Story = {
  args: {},
  render: () => <OpenDemo />,
};

function FilteringDemo() {
  const [open, setOpen] = useState(true);

  return (
    <div>
      <CommandMenu
        open={open}
        onOpenChange={setOpen}
        groups={commandGroups}
        placeholder="Try typing 'agent' or 'new'…"
      />
      <div className="p-8 text-center text-fg">
        <p className="mb-4">Try filtering by typing in the command menu</p>
        <Button onClick={() => setOpen(!open)}>
          {open ? "Close" : "Open"} Menu
        </Button>
      </div>
    </div>
  );
}

export const Filtering: Story = {
  args: {},
  render: () => <FilteringDemo />,
};

function LoadingDemo() {
  const [open, setOpen] = useState(true);

  return (
    <div>
      <CommandMenu
        open={open}
        onOpenChange={setOpen}
        loading={true}
        groups={[]}
        placeholder="Loading commands…"
      />
      <div className="p-8 text-center text-fg">
        <p className="mb-4">Command menu is loading</p>
        <Button onClick={() => setOpen(!open)}>
          {open ? "Close" : "Open"} Menu
        </Button>
      </div>
    </div>
  );
}

export const Loading: Story = {
  args: {},
  render: () => <LoadingDemo />,
};

function EmptyDemo() {
  const [open, setOpen] = useState(true);

  return (
    <div>
      <CommandMenu
        open={open}
        onOpenChange={setOpen}
        groups={[]}
        emptyMessage="No commands found. Try a different search."
      />
      <div className="p-8 text-center text-fg">
        <p className="mb-4">No results to display</p>
        <Button onClick={() => setOpen(!open)}>
          {open ? "Close" : "Open"} Menu
        </Button>
      </div>
    </div>
  );
}

export const Empty: Story = {
  args: {},
  render: () => <EmptyDemo />,
};

function WithIconsDemo() {
  const [open, setOpen] = useState(true);

  const groupsWithIcons = [
    {
      heading: "File Operations",
      items: [
        {
          id: "copy",
          label: "Copy",
          icon: <Copy className="size-4" />,
          shortcut: "⌘C",
        },
        {
          id: "delete",
          label: "Delete",
          icon: <Trash2 className="size-4" />,
          shortcut: "⌘D",
        },
      ],
    },
    {
      heading: "Code",
      items: [
        {
          id: "format",
          label: "Format code",
          icon: <Code2 className="size-4" />,
          shortcut: "⌘⇧F",
        },
        {
          id: "docs-gen",
          label: "Generate documentation",
          icon: <FileText className="size-4" />,
          shortcut: "⌘⇧D",
        },
      ],
    },
  ];

  return (
    <div>
      <CommandMenu
        open={open}
        onOpenChange={setOpen}
        groups={groupsWithIcons}
      />
      <div className="p-8 text-center text-fg">
        <p className="mb-4">Command menu with icons</p>
        <Button onClick={() => setOpen(!open)}>
          {open ? "Close" : "Open"} Menu
        </Button>
      </div>
    </div>
  );
}

export const WithIcons: Story = {
  args: {},
  render: () => <WithIconsDemo />,
};

function WithShortcutsDemo() {
  const [open, setOpen] = useState(true);

  return (
    <div>
      <CommandMenu
        open={open}
        onOpenChange={setOpen}
        groups={commandGroups}
        placeholder="Type a command (e.g., ⌘N for new agent)…"
      />
      <div className="p-8 text-center text-fg">
        <p className="mb-4">Commands show their keyboard shortcuts</p>
        <Button onClick={() => setOpen(!open)}>
          {open ? "Close" : "Open"} Menu
        </Button>
      </div>
    </div>
  );
}

export const WithShortcuts: Story = {
  args: {},
  render: () => <WithShortcutsDemo />,
};
