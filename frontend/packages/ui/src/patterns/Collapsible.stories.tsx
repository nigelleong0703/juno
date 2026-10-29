import type { Meta, StoryObj } from "@storybook/react-vite";
import { Collapsible, CollapsibleTrigger, CollapsibleContent } from "./Collapsible";

const meta = {
  title: "Patterns/Collapsible",
  component: Collapsible,
  parameters: { layout: "centered" },
} satisfies Meta<typeof Collapsible>;

export default meta;
type Story = StoryObj<typeof Collapsible>;

export const Default: Story = {
  render: () => (
    <div className="w-[400px]">
      <Collapsible>
        <CollapsibleTrigger>Advanced Settings</CollapsibleTrigger>
        <CollapsibleContent>
          <div className="space-y-3">
            <div>
              <label className="text-sm font-medium text-fg">Theme</label>
              <select className="w-full mt-1 px-2 py-1 rounded-sm border border-border bg-surface text-fg">
                <option>Light</option>
                <option>Dark</option>
                <option>Auto</option>
              </select>
            </div>
            <div>
              <label className="text-sm font-medium text-fg">Cache</label>
              <select className="w-full mt-1 px-2 py-1 rounded-sm border border-border bg-surface text-fg">
                <option>Enabled</option>
                <option>Disabled</option>
              </select>
            </div>
          </div>
        </CollapsibleContent>
      </Collapsible>
    </div>
  ),
};

export const Multiple: Story = {
  render: () => (
    <div className="w-[400px] space-y-2">
      <Collapsible>
        <CollapsibleTrigger>General Settings</CollapsibleTrigger>
        <CollapsibleContent>
          <div className="space-y-2">
            <p className="text-sm text-fg-muted">Configure general options for your account.</p>
          </div>
        </CollapsibleContent>
      </Collapsible>

      <Collapsible>
        <CollapsibleTrigger>Privacy & Security</CollapsibleTrigger>
        <CollapsibleContent>
          <div className="space-y-2">
            <p className="text-sm text-fg-muted">Manage your privacy and security settings.</p>
          </div>
        </CollapsibleContent>
      </Collapsible>

      <Collapsible>
        <CollapsibleTrigger>Notifications</CollapsibleTrigger>
        <CollapsibleContent>
          <div className="space-y-2">
            <p className="text-sm text-fg-muted">Choose what notifications you want to receive.</p>
          </div>
        </CollapsibleContent>
      </Collapsible>
    </div>
  ),
};

export const Nested: Story = {
  render: () => (
    <div className="w-[400px]">
      <Collapsible>
        <CollapsibleTrigger>Settings</CollapsibleTrigger>
        <CollapsibleContent>
          <div className="space-y-2 pl-4 border-l border-border">
            <Collapsible>
              <CollapsibleTrigger>Display</CollapsibleTrigger>
              <CollapsibleContent>
                <p className="text-sm text-fg-muted">Display preferences</p>
              </CollapsibleContent>
            </Collapsible>

            <Collapsible>
              <CollapsibleTrigger>Behavior</CollapsibleTrigger>
              <CollapsibleContent>
                <p className="text-sm text-fg-muted">Application behavior</p>
              </CollapsibleContent>
            </Collapsible>
          </div>
        </CollapsibleContent>
      </Collapsible>
    </div>
  ),
};

export const WithContent: Story = {
  render: () => (
    <div className="w-[400px]">
      <Collapsible>
        <CollapsibleTrigger>Juno Agent Details</CollapsibleTrigger>
        <CollapsibleContent>
          <div className="space-y-3">
            <div>
              <p className="text-xs font-medium text-fg-muted uppercase">Status</p>
              <p className="text-sm text-fg">Online</p>
            </div>
            <div>
              <p className="text-xs font-medium text-fg-muted uppercase">Tasks Completed</p>
              <p className="text-sm text-fg">156</p>
            </div>
            <div>
              <p className="text-xs font-medium text-fg-muted uppercase">Success Rate</p>
              <p className="text-sm text-fg">98.2%</p>
            </div>
          </div>
        </CollapsibleContent>
      </Collapsible>
    </div>
  ),
};
