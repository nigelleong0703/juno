import type { Meta, StoryObj } from "@storybook/react-vite";
import { Button } from "../primitives";
import { Input } from "../primitives";
import { SettingsSection } from "./SettingsSection";

const meta = {
  title: "Patterns/SettingsSection",
  component: SettingsSection,
  parameters: { layout: "centered" },
} satisfies Meta<typeof SettingsSection>;

export default meta;
type Story = StoryObj<typeof SettingsSection>;

export const Basic: Story = {
  args: {},
  render: () => (
    <div className="w-96">
      <SettingsSection
        title="General settings"
        description="Basic configuration for your agent"
      >
        <div className="space-y-3">
          <div>
            <label className="text-sm font-medium text-fg">Agent name</label>
            <Input placeholder="e.g., Task Runner" className="mt-1" />
          </div>
        </div>
      </SettingsSection>
    </div>
  ),
};

export const WithFooter: Story = {
  args: {},
  render: () => (
    <div className="w-96">
      <SettingsSection
        title="Dangerous actions"
        description="Actions that cannot be undone"
        footer="Last backup: 2 days ago"
      >
        <div>
          <Button variant="danger">Reset to defaults</Button>
        </div>
      </SettingsSection>
    </div>
  ),
};

export const MultipleFields: Story = {
  args: {},
  render: () => (
    <div className="w-96">
      <SettingsSection
        title="Agent configuration"
        description="Configure how your agent behaves"
      >
        <div className="space-y-4">
          <div>
            <label className="text-sm font-medium text-fg">Agent name</label>
            <Input
              placeholder="e.g., Task Runner"
              className="mt-1"
              defaultValue="Juno"
            />
          </div>
          <div>
            <label className="text-sm font-medium text-fg">
              Maximum concurrent tasks
            </label>
            <Input type="number" defaultValue="5" className="mt-1" />
          </div>
          <div className="flex items-center gap-2">
            <input
              type="checkbox"
              id="autostart"
              defaultChecked
              className="rounded border-border"
            />
            <label htmlFor="autostart" className="text-sm text-fg">
              Auto-start on boot
            </label>
          </div>
        </div>
      </SettingsSection>
    </div>
  ),
};

export const NoDescription: Story = {
  args: {},
  render: () => (
    <div className="w-96">
      <SettingsSection title="Privacy">
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <input type="checkbox" id="telemetry" defaultChecked />
            <label htmlFor="telemetry" className="text-sm text-fg">
              Allow usage telemetry
            </label>
          </div>
          <div className="flex items-center gap-2">
            <input type="checkbox" id="analytics" />
            <label htmlFor="analytics" className="text-sm text-fg">
              Send crash reports
            </label>
          </div>
        </div>
      </SettingsSection>
    </div>
  ),
};
