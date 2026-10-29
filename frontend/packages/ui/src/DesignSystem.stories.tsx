import type { Meta, StoryObj } from "@storybook/react-vite";
import type { ReactNode } from "react";
import { Moon, Plus, Settings, Sun } from "lucide-react";
import { Button } from "./components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "./components/ui/card";
import { DropdownMenu, DropdownMenuTrigger } from "./components/ui/dropdown-menu";
import { Input } from "./components/ui/input";
import { Label } from "./components/ui/label";
import { Spinner } from "./components/ui/spinner";
import { Reasoning, ReasoningContent, ReasoningTrigger } from "./ai/reasoning";
import { Shimmer } from "./ai/shimmer";
import { LoadingState } from "./patterns/LoadingState";
import { StatusPill } from "./patterns/StatusPill";
import { AccountAvatar } from "../../app/src/components/agent/AccountAvatar";
import { AccountMenu } from "../../app/src/components/agent/AccountMenu";
import { AgentAvatar } from "../../app/src/components/agent/AgentAvatar";
import { Composer } from "../../app/src/components/conversation/Composer";
import { ConversationView } from "../../app/src/components/conversation/ConversationView";
import { Transcript } from "../../app/src/components/conversation/Transcript";
import { directThread, galleryState, primaryAgent, roomThread, waitingRun } from "./design-gallery/fixtures";
import { GalleryChatRows, GalleryProviders, GallerySection, MissingNote, StateTag, noop } from "./design-gallery/support";

const meta = {
  title: "DesignSystem/Gallery",
  parameters: { layout: "fullscreen" },
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

function GalleryPage({ children }: { children: ReactNode }) {
  return <div className="min-h-screen bg-bg text-fg">{children}</div>;
}


/**
 * Token source mapping and role contracts. Swatches read the real semantic
 * variables; role cards are the production components, not replicas. Hover
 * states on this page are live pointer states, never staged classes.
 */
export const TokensAndRoles: Story = {
  render: () => (
    <GalleryPage>
      <GallerySection
        title="Tokens and roles"
        note="Layer 1 semantic variables from packages/ui/src/theme/tokens.css. Components must only use this layer, never the raw palette in theme/palette.css. Pill, circle and card below are the production components."
      >
        <div className="flex flex-wrap gap-2">
          <span className="rounded-md bg-background px-3 py-2 text-sm text-fg">background</span>
          <span className="rounded-md bg-sidebar px-3 py-2 text-sm text-fg">sidebar #141414</span>
          <span className="rounded-md bg-card px-3 py-2 text-sm text-fg">card</span>
          <span className="rounded-md bg-popover px-3 py-2 text-sm text-fg">popover</span>
          <span className="rounded-md bg-muted px-3 py-2 text-sm text-fg-muted">muted</span>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <StatusPill tone="success" label="success" />
          <StatusPill tone="warning" label="warning" />
          <StatusPill tone="danger" label="danger" />
          <StatusPill tone="info" label="info" />
          <StatusPill tone="accent" label="accent" />
          <StatusPill tone="neutral" label="neutral" />
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <span className="size-8 rounded-full" style={{ background: "var(--color-agent-1)" }} />
          <span className="size-8 rounded-full" style={{ background: "var(--color-agent-3)" }} />
          <span className="size-8 rounded-full" style={{ background: "var(--color-agent-6)" }} />
          <span className="text-xs text-fg-muted">Agent colours 1 to 10 carry the only chromatic meaning; everything else stays neutral.</span>
        </div>
        <div className="mt-4 grid max-w-4xl gap-3 md:grid-cols-3">
          <Card>
            <CardHeader>
              <CardTitle>Pill role</CardTitle>
            </CardHeader>
            <CardContent>
              <Button>Send</Button>
              <p className="mt-2 text-xs text-fg-muted">Primary actions and the composer send control are full pills. Hover only shifts the fill; geometry never changes.</p>
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>Circle role</CardTitle>
            </CardHeader>
            <CardContent>
              <AccountAvatar initials="NI" />
              <p className="mt-2 text-xs text-fg-muted">Presence is a neutral circle with no rectangular hover tile.</p>
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>Card role</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-xs text-fg-muted">Cards and rows keep radius 10 to 16. One shared card radius must not flatten every role.</p>
            </CardContent>
          </Card>
        </div>
        <p className="mt-3 max-w-3xl text-xs text-fg-muted">
          <StateTag kind="live">live</StateTag> Hover every control on this page: focus rings, ghost hovers and menu highlights are the production pseudo-states.
        </p>
      </GallerySection>
    </GalleryPage>
  ),
};


/** Real Button variants, sizes and disabled. Hover and focus-visible are live. */
export const ButtonStates: Story = {
  render: () => (
    <GalleryPage>
      <GallerySection
        title="Button states"
        note="Actual shared Button. Default, hover, focus-visible, pressed and disabled come from buttonVariants. Tab through them to see the real ring."
      >
        <div className="flex flex-wrap items-center gap-2">
          <Button>Default</Button>
          <Button variant="secondary">Secondary</Button>
          <Button variant="outline">Outline</Button>
          <Button variant="ghost">Ghost</Button>
          <Button variant="destructive">Destructive</Button>
          <Button variant="link">Link</Button>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Button size="xs">Extra small</Button>
          <Button size="sm">Small</Button>
          <Button size="lg">Large</Button>
          <Button size="icon" aria-label="Add">
            <Plus />
          </Button>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Button disabled>Disabled</Button>
          <Button disabled variant="outline">
            Disabled outline
          </Button>
          <Button disabled>
            <Spinner className="size-4" />
            Generating
          </Button>
        </div>
        <p className="mt-3 max-w-3xl text-xs text-fg-muted">
          <StateTag kind="live">live</StateTag> Pressed scale and the focus ring are production behaviour.
          The spinner button is a real composition for generating states; Button has no loading prop.
        </p>
      </GallerySection>
    </GalleryPage>
  ),
};

/** Real Input: default, focused, invalid and disabled. */
export const InputStates: Story = {
  render: () => (
    <GalleryPage>
      <GallerySection
        title="Input states"
        note="Actual shared Input. The error ring derives from aria-invalid, never from a custom error class."
      >
        <div className="grid max-w-xl gap-4">
          <div className="grid gap-1.5">
            <Label htmlFor="ds-input-default">Default</Label>
            <Input id="ds-input-default" placeholder="Type to see the real focus ring" />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="ds-input-error">Invalid</Label>
            <Input id="ds-input-error" defaultValue="not-an-email" aria-invalid="true" />
            <p className="text-xs text-danger">Error text is a sibling; the ring comes from aria-invalid.</p>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="ds-input-disabled">Disabled</Label>
            <Input id="ds-input-disabled" placeholder="Disabled" disabled />
          </div>
        </div>
        <p className="mt-3 max-w-3xl text-xs text-fg-muted">
          <StateTag kind="live">live</StateTag> Focus the fields with pointer or Tab; the ring is the production focus-visible style.
        </p>
      </GallerySection>
    </GalleryPage>
  ),
};


/** Actual app AccountMenu inside the real DropdownMenu, forced open via defaultOpen. */
export const CompactMenu: Story = {
  render: () => (
    <GalleryPage>
      <GallerySection
        title="Compact account menu"
        note="AccountMenu is the production component: Settings, the theme switcher in a submenu, then Sign out. The secondary destinations live in the chat list's Toolbox now, and the collapse shortcut is not listed. Keyboard travel is live Radix behaviour: focus the trigger, open it, and drive arrows, Escape and focus return yourself."
      >
        <div className="flex min-h-64 items-start gap-6">
          <DropdownMenu defaultOpen>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="sm">Account</Button>
            </DropdownMenuTrigger>
            <AccountMenu
              user={{ name: "Robin", initials: "N", email: "robin@example.com" }}
              primary={[{ key: "settings", label: "Settings", icon: <Settings className="size-4" />, onSelect: noop }]}
              themeLabel="Theme"
              theme="dark"
              themeOptions={[
                { value: "light", label: "Light", icon: <Sun className="size-4" /> },
                { value: "dark", label: "Dark", icon: <Moon className="size-4" /> },
              ]}
              onThemeChange={noop}
            />
          </DropdownMenu>
          <div className="max-w-sm text-xs text-fg-muted">
            <p><StateTag kind="forced">forced open</StateTag> The menu is open through defaultOpen, which is real Radix state, not a CSS replica.</p>
            <p className="mt-2"><StateTag kind="live">live</StateTag> Hover items for the real highlight; open the Theme submenu with the pointer or arrow keys.</p>
          </div>
        </div>
      </GallerySection>
    </GalleryPage>
  ),
};


/** Real sidebar presence: production ChatRow rows, AccountAvatar and AgentAvatar states. */
function PresenceDemo() {
  const state = galleryState();
  const thread = directThread(state);
  const agent = thread === undefined ? undefined : primaryAgent(state, thread.conversation);
  return (
    <div className="grid gap-6">
      <div>
        <p className="mb-2 text-sm font-medium text-fg">Live chat rows (production ChatRow, production data; first row selected via the real active prop)</p>
        <GalleryProviders>
          <GalleryChatRows count={4} />
        </GalleryProviders>
      </div>
      <div className="flex flex-wrap items-center gap-6">
        <div className="flex items-center gap-3">
          <AccountAvatar initials="NI" />
          <p className="text-xs text-fg-muted">Sidebar footer presence at rest: neutral circle, no tile.</p>
        </div>
        {agent === undefined ? null : (
          <div className="flex items-center gap-3">
            <AgentAvatar agentId={agent.id} avatar={agent.avatar} status="working" size="lg" label={agent.name} />
            <p className="text-xs text-fg-muted">Working: the only avatar status dot (green).</p>
          </div>
        )}
        {agent === undefined ? null : (
          <div className="flex items-center gap-3">
            <AgentAvatar agentId={agent.id} avatar={agent.avatar} status="idle" size="lg" label={agent.name} />
            <p className="text-xs text-fg-muted">Idle: no dot. Idle and offline dots stay hidden by design.</p>
          </div>
        )}
      </div>
      <div className="max-w-3xl text-xs text-fg-muted">
        <p><StateTag kind="live">live</StateTag> Red unread dots appear only where the seeded data has unread or needs-you rows; hover the rows for the real highlight.</p>
        <MissingNote owner="Hypatia">No typing indicator exists: while an agent types, ChatRow shows no dot and no preview change. Working, approval-waiting and tool-running states never appear in the row.</MissingNote>
      </div>
    </div>
  );
}

export const SidebarPresence: Story = {
  render: () => (
    <GalleryPage>
      <GallerySection
        title="Sidebar presence"
        note="ChatRow railDot draws one red dot per avatar for unread or needs-you only. The dot is its own button that opens the computer, separate from the row that selects the chat."
      >
        <PresenceDemo />
      </GallerySection>
    </GalleryPage>
  ),
};


/** Real Composer in idle, generating and waiting. Typing is live-only: no prefill prop exists. */
function ComposerDemo() {
  const state = galleryState();
  const thread = directThread(state);
  if (thread === undefined) return <LoadingState label="No fixture thread" />;
  const agent = primaryAgent(state, thread.conversation);
  const agents = agent === undefined ? [] : [agent];
  return (
    <div className="grid max-w-2xl gap-6">
      <div>
        <p className="mb-1 text-sm font-medium text-fg">Idle <StateTag kind="live">live</StateTag></p>
        <Composer agents={agents} primaryAgent={agent} onSend={noop} />
      </div>
      <div>
        <p className="mb-1 text-sm font-medium text-fg">Generating (running plus stop handler) <StateTag kind="forced">forced</StateTag></p>
        <Composer agents={agents} primaryAgent={agent} running onSend={noop} onStop={noop} />
        <p className="mt-1 text-xs text-fg-muted">The Stop square renders only for a live run with a stop handler, matching the run convention.</p>
      </div>
      <div>
        <p className="mb-1 text-sm font-medium text-fg">Waiting (send in flight) <StateTag kind="forced">forced</StateTag></p>
        <Composer agents={agents} primaryAgent={agent} disabled onSend={noop} />
        <p className="mt-1 text-xs text-fg-muted">Disabled while sending: the send control cannot fire with an empty or locked box.</p>
      </div>
      <MissingNote owner="Hypatia">Typing and draft prefill have no props (Composer owns its value in useState), so they cannot be staged. Type in the idle box for the real thing. ConversationView never passes onStop, so its composer never shows Stop; cancellation there lives on the run work block.</MissingNote>
    </div>
  );
}

export const ComposerStates: Story = {
  render: () => (
    <GalleryPage>
      <GallerySection
        title="Composer states"
        note="Production Composer with seeded agents. The pill, fade, single-line field and mic/send controls are the shipped layout."
      >
        <ComposerDemo />
      </GallerySection>
    </GalleryPage>
  ),
};


/** Real transcript motion: history load, new arrival, generating, run work blocks. */
function MotionDemo() {
  const state = galleryState();
  const thread = directThread(state);
  const room = roomThread(state);
  if (thread === undefined) return <LoadingState label="No fixture thread" />;
  const byId = (id: string) => thread.agents.find((a) => a.id === id);
  const history = thread.items.slice(0, 6);
  const arrived = thread.items.slice(0, 7);
  const primaryName = primaryAgent(state, thread.conversation)?.name;
  return (
    <div className="grid gap-8">
      <div>
        <p className="mb-1 text-sm font-medium text-fg">History loaded <StateTag kind="live">live</StateTag></p>
        <p className="mb-2 max-w-3xl text-xs text-fg-muted">Production Transcript on the real Conversation shell: initial is instant, so opening a thread never animates the history. Resize is instant too; smooth motion is reserved for new messages.</p>
        <div className="h-80 overflow-hidden rounded-lg border border-border">
          <Transcript items={history} agentById={byId} primaryAgentName={primaryName} />
        </div>
      </div>
      <div>
        <p className="mb-1 text-sm font-medium text-fg">New message arrived (one item later) <StateTag kind="forced">forced</StateTag></p>
        <p className="mb-2 max-w-3xl text-xs text-fg-muted">Same thread one item later: the end state a live append settles into. The smooth scroll that carries a reader here fires on append and cannot be staged in a static story.</p>
        <div className="h-80 overflow-hidden rounded-lg border border-border">
          <Transcript items={arrived} agentById={byId} primaryAgentName={primaryName} />
        </div>
      </div>
      <div>
        <p className="mb-1 text-sm font-medium text-fg">Model generating <StateTag kind="live">live</StateTag></p>
        <div className="max-w-2xl rounded-lg border border-border p-3">
          <Reasoning isStreaming>
            <ReasoningTrigger />
            <ReasoningContent>Checking the inbox and drafting replies.</ReasoningContent>
          </Reasoning>
        </div>
        <p className="mt-1 max-w-3xl text-xs text-fg-muted">Production Reasoning with isStreaming: the Thinking shimmer is the real generating indicator.</p>
      </div>
      <div>
        <p className="mb-1 text-sm font-medium text-fg">Awaiting reply after send <StateTag kind="forced">forced</StateTag></p>
        <p className="mb-2 max-w-3xl text-xs text-fg-muted">Production Transcript with showAwaiting: the typing-dots bubble in agent-bubble language, mounted only in the post-send window and replaced atomically by the first assistant text. Never a typewriter; never shown for tool or wait states.</p>
        <div className="h-80 overflow-hidden rounded-lg border border-border">
          <Transcript items={history} showAwaiting agentById={byId} primaryAgentName={primaryName} />
        </div>
      </div>
      {room === undefined ? null : (
        <div>
          <p className="mb-1 text-sm font-medium text-fg">Room authorship</p>
          <div className="h-80 overflow-hidden rounded-lg border border-border">
            <Transcript items={room.items.slice(0, 6)} showAuthors primaryAgentName={primaryName} />
          </div>
        </div>
      )}
      <div className="max-w-3xl text-xs text-fg-muted">
        <MissingNote owner="Hypatia">Outgoing message enter animation: Message carries no enter animation classes today, so a sent bubble appears without motion. First-token streaming has no staged visual distinct from the generating shimmer.</MissingNote>
        <p className="mt-2 max-w-3xl text-xs text-fg-muted"><StateTag kind="forced">forced</StateTag> Typing is covered above through the production awaiting-reply bubble; no fixture stands in for it.</p>
      </div>
    </div>
  );
}

export const TranscriptMotion: Story = {
  render: () => (
    <GalleryPage>
      <GallerySection
        title="Transcript motion"
        note="Outgoing, typing and incoming bubble coverage requested by the owner. Everything below is a production component with seeded data; staged motion is labelled, never faked."
      >
        <GalleryProviders>
          <MotionDemo />
        </GalleryProviders>
      </GallerySection>
    </GalleryPage>
  ),
};


/** Real conversation screen in live, waiting, loading, items-loading, error and empty states. */
function ScreenDemo() {
  const state = galleryState();
  const thread = directThread(state);
  if (thread === undefined) return <LoadingState label="No fixture thread" />;
  const agent = primaryAgent(state, thread.conversation);
  const run = waitingRun(state, thread.conversation.id);
  const frame = "h-[520px] overflow-hidden rounded-lg border border-border";
  const base = {
    agents: thread.agents,
    primaryAgent: agent,
    isLoading: false,
    isError: false,
    computerPanelOpen: false,
    onRetry: noop,
    onSend: noop,
    onToggleComputerPanel: noop,
    onOpenAgentSettings: noop,
    onOpenRoutines: noop,
    onTogglePin: noop,
    onOpenCitation: noop,
  };
  return (
    <div className="grid gap-8">
      <div>
        <p className="mb-1 text-sm font-medium text-fg">Live <StateTag kind="live">live</StateTag></p>
        <div className={frame}>
          <ConversationView conversation={thread.conversation} items={thread.items} {...base} />
        </div>
      </div>
      <div>
        <p className="mb-1 text-sm font-medium text-fg">Waiting on a run <StateTag kind="forced">forced</StateTag></p>
        <div className={frame}>
          <ConversationView conversation={thread.conversation} items={thread.items} runningRuns={run === undefined ? [] : [run]} {...base} />
        </div>
        <p className="mt-1 max-w-3xl text-xs text-fg-muted">runningRuns carries a real running run for this conversation; the header stays title-only while the composer and work block reflect the run.</p>
      </div>
      <div className="grid gap-6 md:grid-cols-2">
        <div>
          <p className="mb-1 text-sm font-medium text-fg">Loading</p>
          <div className={frame}>
            <ConversationView {...base} isLoading />
          </div>
        </div>
        <div>
          <p className="mb-1 text-sm font-medium text-fg">Items loading</p>
          <div className={frame}>
            <ConversationView conversation={thread.conversation} itemsLoading {...base} />
          </div>
        </div>
        <div>
          <p className="mb-1 text-sm font-medium text-fg">Error with retry</p>
          <div className={frame}>
            <ConversationView {...base} isError />
          </div>
        </div>
        <div>
          <p className="mb-1 text-sm font-medium text-fg">Empty thread</p>
          <div className={frame}>
            <ConversationView conversation={thread.conversation} items={[]} {...base} />
          </div>
        </div>
      </div>
    </div>
  );
}

export const ScreenStates: Story = {
  render: () => (
    <GalleryPage>
      <GallerySection
        title="Conversation screen states"
        note="Production ConversationView driven only by props. Loading, error, empty and items-loading are first-class branches, not overlays."
      >
        <GalleryProviders>
          <ScreenDemo />
        </GalleryProviders>
      </GallerySection>
    </GalleryPage>
  ),
};


/** Reduced motion: the three production guards plus the one live gap. Nothing is emulated. */
export const ReducedMotion: Story = {
  render: () => (
    <GalleryPage>
      <GallerySection
        title="Reduced motion"
        note="This story cannot flip the OS media query, so it documents the real guards and shows the one component that ignores them. No animation is replicated in fixtures."
      >
        <div className="grid max-w-3xl gap-3 text-sm text-fg-muted">
          <p><span className="font-medium text-fg">Guard 1, theme:</span> theme/base.css collapses every CSS animation and transition to 0.01ms under prefers-reduced-motion.</p>
          <p><span className="font-medium text-fg">Guard 2, shell:</span> styles/app.css drops the shell-grid and collapse-rows transitions under reduced motion; AppShell beginAnimation skips the animation flag entirely.</p>
          <p><span className="font-medium text-fg">Guard 3, transcript:</span> Transcript already mounts history with initial instant and resize instant, keeping the reader anchored; smooth motion is reserved for new messages.</p>
        </div>
        <div className="mt-4 max-w-2xl rounded-lg border border-border p-3">
          <p className="mb-2 text-sm font-medium text-fg">Live shimmer under any motion setting</p>
          <Shimmer duration={1}>Thinking...</Shimmer>
        </div>
        <MissingNote owner="Hypatia">TextShimmer runs on motion/react with an infinite repeat and no reduced-motion guard, so the CSS kill-switch does not reach it. Either gate the shimmer on useReducedMotion or swap it for static text under reduced motion.</MissingNote>
      </GallerySection>
    </GalleryPage>
  ),
};

/** Authoritative coverage map: what the gallery shows, what is missing, and who owns it. */
export const Coverage: Story = {
  render: () => (
    <GalleryPage>
      <GallerySection
        title="Coverage map"
        note="Every row names a real component or a real gap. Gaps are owned, never faked: Hypatia owns shell, chat and transcript motion; Lovelace owns the computer pane; Meitner owns AccountMenu."
      >
        <div className="grid max-w-4xl gap-2 text-sm">
          <p><StateTag kind="live">live</StateTag> <span className="text-fg">Tokens, Button, Input, menu highlight and keyboard, ChatRow rows, avatar dots, composer send/stop, transcript history, Reasoning shimmer, conversation live/loading/error/empty.</span></p>
          <p><StateTag kind="forced">forced</StateTag> <span className="text-fg">Menu open via defaultOpen, composer generating/waiting via running/disabled, waiting screen via runningRuns, new-arrival end state via a longer item slice.</span></p>
          <p><StateTag kind="missing">missing</StateTag> <span className="text-fg">Outgoing bubble enter animation, peer typing indicator, first-token visual distinct from the shimmer, Shimmer reduced-motion guard.</span></p>
        </div>
        <div className="mt-4 max-w-4xl text-xs text-fg-muted">
          <p>Files: packages/ui/src/DesignSystem.stories.tsx, packages/ui/src/design-gallery/fixtures.ts, packages/ui/src/design-gallery/support.tsx, .data/ds1-design-contract.md.</p>
          <p className="mt-1">Fixtures are the seeded mock world (buildWorld, seed 1, fixed clock) plus a paused mock client; no screenshot, replica component or staged class stands in for production behaviour.</p>
        </div>
      </GallerySection>
    </GalleryPage>
  ),
};
