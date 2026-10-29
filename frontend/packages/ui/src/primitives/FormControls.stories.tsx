import type { StoryObj } from "@storybook/react-vite";
import {
  Checkbox,
  Input,
  Label,
  RadioGroup,
  RadioGroupItem,
  SegmentedControl,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Switch,
  Textarea,
} from "./index";
import { Combobox } from "./Combobox";

const meta = {
  title: "Primitives/Form controls",
  parameters: { layout: "centered" },
};

export default meta;
type Story = StoryObj;

export const Inputs: Story = {
  render: () => (
    <div className="flex w-96 flex-col gap-4">
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="agent-name">Agent name</Label>
        <Input id="agent-name" placeholder="Juno" />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="instructions">Instructions</Label>
        <Textarea id="instructions" rows={3} placeholder="Keep replies short and ask before sending." />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label>Model</Label>
        <Select defaultValue="juno">
          <SelectTrigger>
            <SelectValue placeholder="Choose a model" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="juno">Juno 1.4</SelectItem>
            <SelectItem value="juno-mini">Juno Mini</SelectItem>
          </SelectContent>
        </Select>
      </div>
      <div className="flex flex-col gap-1.5">
        <Label>Workspace</Label>
        <Combobox
          options={[
            { value: "inbox", label: "Inbox" },
            { value: "calendar", label: "Calendar" },
            { value: "invoices", label: "Invoices" },
          ]}
          placeholder="Search workspaces"
          onValueChange={() => {}}
        />
      </div>
    </div>
  ),
};

export const Toggles: Story = {
  render: () => (
    <div className="flex w-96 flex-col gap-6">
      <div className="flex items-center justify-between">
        <Label htmlFor="always-on">Always on</Label>
        <Switch id="always-on" defaultChecked />
      </div>
      <div className="flex items-center gap-2">
        <Checkbox id="approvals" defaultChecked />
        <Label htmlFor="approvals">Ask before sending email</Label>
      </div>
      <RadioGroup defaultValue="balanced" className="flex flex-col gap-2">
        <div className="flex items-center gap-2">
          <RadioGroupItem value="fast" id="fast" />
          <Label htmlFor="fast">Fast</Label>
        </div>
        <div className="flex items-center gap-2">
          <RadioGroupItem value="balanced" id="balanced" />
          <Label htmlFor="balanced">Balanced</Label>
        </div>
        <div className="flex items-center gap-2">
          <RadioGroupItem value="thorough" id="thorough" />
          <Label htmlFor="thorough">Thorough</Label>
        </div>
      </RadioGroup>
      <SegmentedControl
        aria-label="Range"
        value="week"
        items={[
          { value: "day", label: "Day" },
          { value: "week", label: "Week" },
          { value: "month", label: "Month" },
        ]}
      />
    </div>
  ),
};
