import type { Meta, StoryObj } from "@storybook/react-vite";
import { FileIcon } from "./FileIcon";

const meta = {
  title: "Patterns/FileIcon",
  component: FileIcon,
  parameters: { layout: "centered" },
} satisfies Meta<typeof FileIcon>;

export default meta;
type Story = StoryObj<typeof FileIcon>;

const files = [
  "runbook.md",
  "invoices-2026-q3.csv",
  "juno-walkthrough.mp4",
  "voice-note.m4a",
  "release.tar.gz",
  "theme.css",
  "screenshot.png",
  "contract.pdf",
  "notes.txt",
  "archive.zip",
];

export const Gallery: Story = {
  render: () => (
    <div className="grid grid-cols-2 gap-x-8 gap-y-3">
      {files.map((name) => (
        <div key={name} className="flex items-center gap-2 text-sm">
          <FileIcon name={name} size={18} />
          <span className="text-foreground">{name}</span>
        </div>
      ))}
    </div>
  ),
};

export const Sizes: Story = {
  render: () => (
    <div className="flex items-center gap-4">
      {[14, 16, 20, 28, 40].map((size) => (
        <FileIcon key={size} name="runbook.md" size={size} />
      ))}
    </div>
  ),
};
