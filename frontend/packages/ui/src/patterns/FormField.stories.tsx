import type { Meta, StoryObj } from "@storybook/react-vite";
import { Input, Textarea } from "../primitives";
import { FormField } from "./FormField";

const meta = {
  title: "Patterns/FormField",
  component: FormField,
  parameters: { layout: "centered" },
} satisfies Meta<typeof FormField>;

export default meta;
type Story = StoryObj<typeof FormField>;

export const Default: Story = {
  render: () => (
    <div className="w-96">
      <FormField label="Agent name" description="Shown in the sidebar and mentions.">
        <Input placeholder="Juno" />
      </FormField>
    </div>
  ),
};

export const WithError: Story = {
  render: () => (
    <div className="w-96">
      <FormField label="Agent name" error="That name is already taken." required>
        <Input defaultValue="Juno" />
      </FormField>
    </div>
  ),
};

export const TextareaField: Story = {
  render: () => (
    <div className="w-96">
      <FormField label="Instructions" description="Tell Juno how to behave.">
        <Textarea placeholder="Keep replies short and always ask before sending." rows={4} />
      </FormField>
    </div>
  ),
};
