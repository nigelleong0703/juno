import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import { SearchField } from "./SearchField";

const meta = {
  title: "Patterns/SearchField",
  component: SearchField,
  parameters: { layout: "centered" },
} satisfies Meta<typeof SearchField>;

export default meta;
type Story = StoryObj<typeof SearchField>;

function EmptyDemo() {
  const [value, setValue] = useState("");
  return (
    <div className="w-72">
      <SearchField value={value} onValueChange={setValue} />
    </div>
  );
}

export const Empty: Story = {
  render: () => <EmptyDemo />,
};

function WithPlaceholderDemo() {
  const [value, setValue] = useState("");
  return (
    <div className="w-72">
      <SearchField
        value={value}
        onValueChange={setValue}
        placeholder="Search agents by name..."
      />
    </div>
  );
}

export const WithPlaceholder: Story = {
  render: () => <WithPlaceholderDemo />,
};

function WithValueDemo() {
  const [value, setValue] = useState("Juno");
  return (
    <div className="w-72">
      <SearchField value={value} onValueChange={setValue} />
    </div>
  );
}

export const WithValue: Story = {
  render: () => <WithValueDemo />,
};

function WithShortcutDemo() {
  const [value, setValue] = useState("");
  return (
    <div className="w-72">
      <SearchField
        value={value}
        onValueChange={setValue}
        placeholder="Search tasks..."
        shortcut={<span>⌘K</span>}
      />
    </div>
  );
}

export const WithShortcut: Story = {
  render: () => <WithShortcutDemo />,
};

function SmallDemo() {
  const [value, setValue] = useState("");
  return (
    <div className="w-64">
      <SearchField value={value} onValueChange={setValue} size="sm" />
    </div>
  );
}

export const Small: Story = {
  render: () => <SmallDemo />,
};

function LargeDemo() {
  const [value, setValue] = useState("");
  return (
    <div className="w-96">
      <SearchField
        value={value}
        onValueChange={setValue}
        placeholder="Find agents, tasks, or files..."
      />
    </div>
  );
}

export const Large: Story = {
  render: () => <LargeDemo />,
};
