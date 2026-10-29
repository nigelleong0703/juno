import type { Meta, StoryObj } from "@storybook/react-vite";
import { SplitView } from "./SplitView";

const meta = { title: "Patterns/SplitView", component: SplitView } satisfies Meta<typeof SplitView>;
export default meta;

export const Empty: StoryObj<typeof SplitView> = {
  render: () => (
    <div className="flex h-72 border border-border">
      <SplitView list={<div className="p-3 text-sm">List</div>} placeholder="Select an item" />
    </div>
  ),
};
