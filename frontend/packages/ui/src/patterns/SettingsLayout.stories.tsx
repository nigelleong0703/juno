import type { Meta, StoryObj } from "@storybook/react-vite";
import {
  Bell,
  Bot,
  Command,
  Lock,
  Palette,
  PanelLeft,
  User,
  Workflow,
} from "lucide-react";
import { useState, type ReactNode } from "react";
import { Button } from "../primitives";
import { Input } from "../primitives";
import { Kbd } from "../primitives";
import { SegmentedControl } from "../primitives";
import { Switch } from "../primitives";
import { SettingsLayout } from "./SettingsLayout";
import { SettingsSection } from "./SettingsSection";

const meta = {
  title: "Patterns/SettingsLayout",
  component: SettingsLayout,
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof SettingsLayout>;

export default meta;
type Story = StoryObj<typeof SettingsLayout>;

const sections = [
  { id: "workspace", label: "Workspace", icon: <Workflow className="size-4" /> },
  { id: "agents", label: "Agents", icon: <Bot className="size-4" /> },
  { id: "notifications", label: "Notifications", icon: <Bell className="size-4" /> },
  { id: "appearance", label: "Appearance", icon: <Palette className="size-4" /> },
  { id: "shortcuts", label: "Shortcuts", icon: <Command className="size-4" /> },
  { id: "account", label: "Account", icon: <User className="size-4" /> },
  { id: "security", label: "Security", icon: <Lock className="size-4" /> },
];

function Row({
  label,
  description,
  control,
}: {
  label: string;
  description?: string;
  control: ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-6">
      <div className="flex flex-col gap-0.5">
        <span className="text-sm font-medium text-fg">{label}</span>
        {description && (
          <span className="text-xs text-fg-muted">{description}</span>
        )}
      </div>
      <div className="shrink-0">{control}</div>
    </div>
  );
}

function WorkspaceSection() {
  const [name, setName] = useState("Acme Platform");
  const [slug, setSlug] = useState("acme-platform");
  const [autoJoin, setAutoJoin] = useState(true);

  return (
    <SettingsSection
      title="Workspace"
      description="How this workspace shows up to everyone using the desktop app."
      footer={
        <>
          <Button variant="secondary">Cancel</Button>
          <Button variant="primary">Save changes</Button>
        </>
      }
    >
      <div className="flex flex-col gap-5">
        <div className="flex flex-col gap-1.5">
          <label htmlFor="workspace-name" className="text-sm font-medium text-fg">
            Workspace name
          </label>
          <Input
            id="workspace-name"
            value={name}
            onChange={(event) => setName(event.currentTarget.value)}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <label htmlFor="workspace-slug" className="text-sm font-medium text-fg">
            Workspace URL
          </label>
          <Input
            id="workspace-slug"
            value={slug}
            onChange={(event) => setSlug(event.currentTarget.value)}
          />
          <span className="text-xs text-fg-muted">
            Agents reference runs as acme-platform/&lt;run-id&gt;.
          </span>
        </div>
        <Row
          label="Let teammates join with the domain"
          description="Anyone with an @acme.dev address joins without an invite."
          control={
            <Switch checked={autoJoin} onCheckedChange={setAutoJoin} />
          }
        />
      </div>
    </SettingsSection>
  );
}

function AgentsSection() {
  const [defaultModel, setDefaultModel] = useState("sonnet");
  const [autoApprove, setAutoApprove] = useState(false);
  const [budget, setBudget] = useState("40");

  return (
    <div className="flex flex-col gap-6">
      <SettingsSection
        title="Defaults for new agents"
        description="Applied when you create an agent without overriding anything."
      >
        <div className="flex flex-col gap-5">
          <Row
            label="Default model"
            description="Used for planning and code edits."
            control={
              <SegmentedControl
                value={defaultModel}
                onValueChange={setDefaultModel}
                items={[
                  { value: "haiku", label: "Haiku" },
                  { value: "sonnet", label: "Sonnet" },
                  { value: "opus", label: "Opus" },
                ]}
              />
            }
          />
          <Row
            label="Auto-approve file edits"
            description="Skip the review step for changes inside the workspace."
            control={
              <Switch checked={autoApprove} onCheckedChange={setAutoApprove} />
            }
          />
          <div className="flex flex-col gap-1.5">
            <label htmlFor="agent-budget" className="text-sm font-medium text-fg">
              Monthly run budget (USD)
            </label>
            <Input
              id="agent-budget"
              type="number"
              value={budget}
              onChange={(event) => setBudget(event.currentTarget.value)}
              className="max-w-32"
            />
          </div>
        </div>
      </SettingsSection>
      <SettingsSection
        title="Runners"
        description="Where agent work executes."
      >
        <Row
          label="Local sandbox"
          description="Runs on this machine and stops when the app quits."
          control={<Switch checked disabled />}
        />
        <Row
          label="Shared runner pool"
          description="3 runners online, last job 4 minutes ago."
          control={<Switch />}
        />
      </SettingsSection>
    </div>
  );
}

function NotificationsSection() {
  const [runs, setRuns] = useState(true);
  const [failures, setFailures] = useState(true);
  const [digest, setDigest] = useState(false);

  return (
    <SettingsSection
      title="Notifications"
      description="Choose what reaches you while the app is running in the background."
    >
      <div className="flex flex-col gap-5">
        <Row
          label="Run finished"
          description="Juno finished a run and is waiting for review."
          control={<Switch checked={runs} onCheckedChange={setRuns} />}
        />
        <Row
          label="Run failed"
          description="A step errored out or hit the budget limit."
          control={<Switch checked={failures} onCheckedChange={setFailures} />}
        />
        <Row
          label="Daily digest"
          description="One summary at 9:00 with every run from the day before."
          control={<Switch checked={digest} onCheckedChange={setDigest} />}
        />
      </div>
    </SettingsSection>
  );
}

function AppearanceSection() {
  const [density, setDensity] = useState("comfortable");
  const [reducedMotion, setReducedMotion] = useState(false);
  const [sidebar, setSidebar] = useState(true);

  return (
    <SettingsSection title="Appearance">
      <div className="flex flex-col gap-5">
        <Row
          label="Interface density"
          description="Controls row heights across lists and tables."
          control={
            <SegmentedControl
              value={density}
              onValueChange={setDensity}
              items={[
                { value: "compact", label: "Compact" },
                { value: "comfortable", label: "Comfortable" },
                { value: "spacious", label: "Spacious" },
              ]}
            />
          }
        />
        <Row
          label="Reduce motion"
          description="Turn off animated transitions and spinners."
          control={
            <Switch
              checked={reducedMotion}
              onCheckedChange={setReducedMotion}
            />
          }
        />
        <Row
          label="Show sidebar"
          description="Keep the agent list pinned next to the run view."
          control={<Switch checked={sidebar} onCheckedChange={setSidebar} />}
        />
      </div>
    </SettingsSection>
  );
}

function ShortcutsSection() {
  const [holdToSend, setHoldToSend] = useState(false);

  return (
    <SettingsSection
      title="Shortcuts"
      description="Keyboard shortcuts are active everywhere except inside text fields."
    >
      <div className="flex flex-col gap-3">
        <Row label="Open the command menu" control={<Kbd>⌘K</Kbd>} />
        <Row label="New agent" control={<Kbd>⌘N</Kbd>} />
        <Row label="Toggle sidebar" control={<Kbd>⌘B</Kbd>} />
        <Row
          label="Hold ⌘ to send"
          description="Sending a prompt while reviewing a diff submits immediately."
          control={<Switch checked={holdToSend} onCheckedChange={setHoldToSend} />}
        />
      </div>
    </SettingsSection>
  );
}

function AccountSection() {
  const [name, setName] = useState("Avery Chen");
  const [email, setEmail] = useState("avery@acme.dev");

  return (
    <div className="flex flex-col gap-6">
      <SettingsSection
        title="Account"
        description="Details shown next to your runs and comments."
      >
        <div className="flex flex-col gap-5">
          <div className="flex flex-col gap-1.5">
            <label htmlFor="account-name" className="text-sm font-medium text-fg">
              Display name
            </label>
            <Input
              id="account-name"
              value={name}
              onChange={(event) => setName(event.currentTarget.value)}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <label htmlFor="account-email" className="text-sm font-medium text-fg">
              Email
            </label>
            <Input
              id="account-email"
              type="email"
              value={email}
              onChange={(event) => setEmail(event.currentTarget.value)}
            />
          </div>
        </div>
      </SettingsSection>
      <SettingsSection title="Avatar">
        <div className="flex items-center gap-4">
          <div className="flex size-12 items-center justify-center rounded-full bg-accent-subtle text-sm font-medium text-accent">
            AC
          </div>
          <div className="flex flex-col gap-0.5">
            <span className="text-sm text-fg">
              Square images work best, at least 128×128.
            </span>
            <span className="text-xs text-fg-muted">PNG or JPG, up to 2 MB.</span>
          </div>
          <div className="ml-auto flex items-center gap-2">
            <Button variant="ghost">Remove</Button>
            <Button variant="secondary">Upload image</Button>
          </div>
        </div>
      </SettingsSection>
    </div>
  );
}

function SecuritySection() {
  const [twoFactor, setTwoFactor] = useState(true);
  const [trusted, setTrusted] = useState(true);

  return (
    <div className="flex flex-col gap-6">
      <SettingsSection
        title="Security"
        description="Protects the credentials agents use in this workspace."
      >
        <div className="flex flex-col gap-5">
          <Row
            label="Require two-factor authentication"
            description="Applies to every member of acme-platform."
            control={<Switch checked={twoFactor} onCheckedChange={setTwoFactor} />}
          />
          <Row
            label="Trust this device for 30 days"
            description="Skip the second factor on this Mac."
            control={<Switch checked={trusted} onCheckedChange={setTrusted} />}
          />
          <Row
            label="Rotate agent credentials"
            description="Last rotated 12 days ago by Avery Chen."
            control={<Button variant="secondary">Rotate now</Button>}
          />
        </div>
      </SettingsSection>
      <SettingsSection
        title="Sessions"
        description="Devices signed in to this account."
      >
        <div className="flex flex-col gap-3 text-sm">
          <div className="flex items-center justify-between gap-4">
            <span className="text-fg">MacBook Pro · San Francisco</span>
            <span className="text-fg-muted">Active now</span>
          </div>
          <div className="flex items-center justify-between gap-4">
            <span className="text-fg">Studio Mac mini · San Francisco</span>
            <span className="text-fg-muted">2 days ago</span>
          </div>
        </div>
      </SettingsSection>
    </div>
  );
}

function SectionFor({ id }: { id: string }) {
  if (id === "agents") return <AgentsSection />;
  if (id === "notifications") return <NotificationsSection />;
  if (id === "appearance") return <AppearanceSection />;
  if (id === "shortcuts") return <ShortcutsSection />;
  if (id === "account") return <AccountSection />;
  if (id === "security") return <SecuritySection />;
  return <WorkspaceSection />;
}

function SettingsDemo({ start = "workspace" }: { start?: string }) {
  const [active, setActive] = useState(start);
  return (
    <SettingsLayout sections={sections} activeId={active} onSelect={setActive}>
      <SectionFor id={active} />
    </SettingsLayout>
  );
}

export const Basic: Story = {
  render: () => <SettingsDemo />,
};

export const WithMultipleSections: Story = {
  render: () => <SettingsDemo start="agents" />,
};

export const Narrow: Story = {
  render: () => (
    <div className="mx-auto h-[640px] w-96 overflow-hidden border border-border">
      <SettingsDemo start="appearance" />
    </div>
  ),
};

export const PanelSidebar: Story = {
  render: () => (
    <div className="flex h-[640px] overflow-hidden border border-border">
      <div className="w-56 shrink-0 border-r border-border bg-bg-subtle p-3">
        <div className="flex items-center gap-2 px-1 text-sm font-medium text-fg">
          <PanelLeft className="size-4" />
          Settings
        </div>
      </div>
      <div className="min-w-0 flex-1">
        <SettingsDemo start="security" />
      </div>
    </div>
  ),
};
