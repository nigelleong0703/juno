import type { Meta, StoryObj } from "@storybook/react-vite";
import { Markdown } from "./Markdown";

const meta = {
  title: "Patterns/Markdown",
  component: Markdown,
  parameters: { layout: "centered" },
} satisfies Meta<typeof Markdown>;

export default meta;
type Story = StoryObj<typeof Markdown>;

const withHeadings = `# Agent Documentation

## Overview

This is a paragraph about the agent system. It supports **bold text** and *italic text*.

### Getting Started

1. Install the package
2. Configure your agents
3. Deploy to production

## Features

- Create multiple agents
- Monitor performance
- Integrate with existing systems`;

const withCodeBlock = `# Code Example

Below is a TypeScript example:

\`\`\`typescript
interface Agent {
  id: string;
  name: string;
}

const agent: Agent = {
  id: "1",
  name: "Juno",
};
\`\`\`

Use inline code like \`const x = 42\` in your text.`;

const withTable = `# Task Management

| Task | Status | Assignee | Priority |
|------|--------|----------|----------|
| Review mockups | Completed | Juno | High |
| Fix bug | In Progress | Patch | High |
| Update docs | Pending | Ledger | Medium |
| Optimize DB | In Progress | Echo | Medium |`;

const withLists = `# Lists Example

## Unordered List

- First item
- Second item with **bold**
- Third item with [run log](https://docs.acme.dev/runs)

## Ordered List

1. First step
2. Second step
   - Nested item
   - Another nested
3. Third step`;

const withBlockquote = `# Blockquote Example

> This is a blockquote with important information.
> It can span multiple lines and contain **formatting**.

Regular text continues here.

> Another blockquote with a [run log](https://docs.acme.dev/runs)`;

export const WithHeadings: Story = {
  args: {
    children: withHeadings,
  },
};

export const WithCodeBlock: Story = {
  args: {
    children: withCodeBlock,
  },
};

export const WithTable: Story = {
  args: {
    children: withTable,
  },
};

export const WithLists: Story = {
  args: {
    children: withLists,
  },
};

export const WithBlockquote: Story = {
  args: {
    children: withBlockquote,
  },
};

export const ComplexExample: Story = {
  args: {
    children: `# Juno Agent Guide

## Introduction

Juno is a high-performance **autonomous agent** designed for complex task management. It features:

- Real-time monitoring
- Advanced scheduling
- Multi-threading support

### Quick Start

Follow these steps to get started:

1. Install the Juno package
2. Configure your environment
3. Create your first agent

\`\`\`typescript
import { Agent } from "@acme/agent";

const juno = new Agent({
  name: "Juno",
  capabilities: ["task_management", "monitoring"],
});

await juno.initialize();
\`\`\`

> **Tip:** Always configure agents before deploying to production.

## Features Comparison

| Feature | Juno | Patch | Ledger |
|---------|------|-------|--------|
| Real-time | ✓ | ✓ | - |
| Monitoring | ✓ | - | ✓ |
| Scheduling | ✓ | ✓ | ✓ |
| Cost | Low | Low | Medium |

For more information, visit our [documentation](https://docs.acme.dev).`,
  },
};
