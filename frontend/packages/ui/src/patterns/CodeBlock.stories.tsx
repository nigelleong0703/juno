import type { Meta, StoryObj } from "@storybook/react-vite";
import { CodeBlock } from "./CodeBlock";

const meta = {
  title: "Patterns/CodeBlock",
  component: CodeBlock,
  parameters: { layout: "centered" },
} satisfies Meta<typeof CodeBlock>;

export default meta;
type Story = StoryObj<typeof CodeBlock>;

const typescriptCode = `interface Agent {
  id: string;
  name: string;
  status: "online" | "offline";
  tasks: number;
}

function getAgent(id: string): Agent {
  return {
    id,
    name: "Juno",
    status: "online",
    tasks: 12,
  };
}`;

const jsonCode = `{
  "agents": [
    {
      "id": "juno-001",
      "name": "Juno",
      "status": "online",
      "tasks": 12
    },
    {
      "id": "patch-002",
      "name": "Patch",
      "status": "offline",
      "tasks": 8
    }
  ]
}`;

const pythonCode = `def calculate_stats(agents: list[Agent]) -> dict:
    """Calculate statistics for agents."""
    total_tasks = sum(agent.tasks for agent in agents)
    avg_tasks = total_tasks / len(agents) if agents else 0

    return {
        "total_tasks": total_tasks,
        "avg_tasks": avg_tasks,
        "online": sum(1 for a in agents if a.status == "online"),
    }`;

export const TypeScript: Story = {
  args: {
    code: typescriptCode,
    language: "typescript",
    filename: "agent.ts",
  },
};

export const JSON: Story = {
  args: {
    code: jsonCode,
    language: "json",
    filename: "agents.json",
  },
};

export const Python: Story = {
  args: {
    code: pythonCode,
    language: "python",
    filename: "stats.py",
  },
};

export const PlainText: Story = {
  args: {
    code: "This is plain text without syntax highlighting.",
    language: "text",
  },
};

export const NoFilename: Story = {
  args: {
    code: typescriptCode,
    language: "typescript",
  },
};

export const Wrapped: Story = {
  args: {
    code: "const veryLongLineOfCodeThatShouldWrapWhenTheWrapPropertyIsEnabledToMakeItMoreReadableInSmallContainers = 'example';",
    language: "typescript",
    wrap: true,
  },
};
