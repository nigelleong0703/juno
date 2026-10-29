import type { Meta, StoryObj } from "@storybook/react-vite";
import { SecretField } from "./SecretField";

const meta = {
  title: "Patterns/SecretField",
  component: SecretField,
  parameters: { layout: "centered" },
} satisfies Meta<typeof SecretField>;

export default meta;
type Story = StoryObj<typeof SecretField>;

export const Empty: Story = {
  args: {},
  render: () => (
    <div className="w-80">
      <SecretField
        label="API Secret"
        placeholder="Enter your API secret"
      />
    </div>
  ),
};

export const Filled: Story = {
  args: {},
  render: () => (
    <div className="w-80">
      <SecretField
        label="API Secret"
        onChange={(value) => console.log("Secret changed:", value)}
      />
    </div>
  ),
};

export const ExistingValue: Story = {
  args: {},
  render: () => (
    <div className="w-80">
      <SecretField
        label="API Secret"
        hasStoredValue={true}
        onClear={() => console.log("Secret cleared")}
      />
    </div>
  ),
};

export const Disabled: Story = {
  args: {},
  render: () => (
    <div className="w-80">
      <SecretField
        label="API Secret"
        disabled={true}
        placeholder="This field is disabled"
      />
    </div>
  ),
};

export const WithStoredValueAndInput: Story = {
  args: {},
  render: () => (
    <div className="w-80">
      <SecretField
        label="API Secret"
        hasStoredValue={true}
        placeholder="Enter new value to replace"
        onClear={() => console.log("Secret cleared")}
      />
    </div>
  ),
};
