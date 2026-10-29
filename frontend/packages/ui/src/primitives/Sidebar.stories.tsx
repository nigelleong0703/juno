import type { StoryObj } from "@storybook/react-vite";
import { Plus, Search, Settings } from "lucide-react";
import {
  IconButton,
  ScrollArea,
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarTrigger,
} from "./index";
import { ListRow } from "@/patterns/ListRow";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { StatusPill } from "@/patterns/StatusPill";

const meta = {
  title: "Primitives/Sidebar",
  parameters: { layout: "fullscreen" },
};

export default meta;
type Story = StoryObj;

interface Chat {
  name: string;
  color: string;
  soft: string;
  preview: string;
  time: string;
  unread?: number;
  needsYou?: boolean;
}

const CHATS: Chat[] = [
  { name: "Juno", color: "var(--agent-1)", soft: "var(--color-agent-1-soft)", preview: "Triaged 42 messages and flagged 6 for you.", time: "2m", unread: 3 },
  { name: "Patch", color: "var(--agent-3)", soft: "var(--color-agent-3-soft)", preview: "Opened a PR to fix the flaky checkout test.", time: "18m" },
  { name: "Ledger", color: "var(--agent-6)", soft: "var(--color-agent-6-soft)", preview: "Reconciled August invoices; 2 need approval.", time: "1h", needsYou: true },
  { name: "Echo", color: "var(--agent-4)", soft: "var(--color-agent-4-soft)", preview: "Drafted replies to the Acme thread.", time: "3h" },
  { name: "Scout", color: "var(--agent-7)", soft: "var(--color-agent-7-soft)", preview: "Found 12 leads matching your brief.", time: "Yesterday" },
  { name: "Atlas", color: "var(--agent-2)", soft: "var(--color-agent-2-soft)", preview: "Weekly planning doc is ready to review.", time: "Yesterday" },
  { name: "Design crew", color: "var(--agent-5)", soft: "var(--color-agent-5-soft)", preview: "Juno: posted the new onboarding flow.", time: "Mon", unread: 1 },
  { name: "Ops crew", color: "var(--agent-9)", soft: "var(--color-agent-9-soft)", preview: "Ledger: two invoices still need approval.", time: "Sun" },
];

function ChatListPanel() {
  return (
    <SidebarProvider className="h-[640px] w-full">
      <Sidebar collapsible="none" className="w-[280px] border-r border-sidebar-border">
        <SidebarHeader className="gap-2 px-3 py-3">
          <div className="flex items-center justify-between">
            <span className="text-sm font-semibold text-sidebar-foreground">Agents</span>
            <IconButton label="New agent" size="sm" variant="ghost">
              <Plus />
            </IconButton>
          </div>
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <input
              placeholder="Search agents"
              className="h-8 w-full rounded-md border border-input bg-input-background pl-8 pr-2 text-sm outline-none placeholder:text-muted-foreground"
            />
          </div>
        </SidebarHeader>
        <SidebarContent>
          <SidebarGroup className="p-0">
            <SidebarGroupLabel>Chats</SidebarGroupLabel>
            <SidebarGroupContent>
              {CHATS.map((chat, index) => (
                <ListRow
                  key={chat.name}
                  selected={index === 0}
                  leading={
                    <Avatar style={{ width: 40, height: 40 }}>
                      <AvatarFallback className="font-medium" style={{ background: chat.soft, color: chat.color }}>
                        {chat.name[0]}
                      </AvatarFallback>
                    </Avatar>
                  }
                  title={chat.name}
                  description={chat.preview}
                  meta={chat.time}
                  unread={chat.unread}
                  trailing={chat.needsYou ? <StatusPill tone="warning" label="Needs you" size="sm" /> : undefined}
                  onClick={() => {}}
                />
              ))}
            </SidebarGroupContent>
          </SidebarGroup>
        </SidebarContent>
        <SidebarFooter className="p-2">
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton>
                <Settings />
                <span>Settings</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarFooter>
      </Sidebar>
      <SidebarInset className="bg-background">
        <div className="flex h-12 items-center gap-2 border-b border-border px-3">
          <SidebarTrigger />
          <span className="text-sm font-medium text-foreground">Juno</span>
        </div>
        <ScrollArea className="flex-1 p-6">
          <p className="max-w-md text-sm text-muted-foreground">
            Juno triaged 42 messages this morning and flagged 6 that need your call.
          </p>
        </ScrollArea>
      </SidebarInset>
    </SidebarProvider>
  );
}

export const ChatList: Story = {
  name: "Chat list",
  render: () => <ChatListPanel />,
};

export const Header: Story = {
  render: () => (
    <SidebarProvider>
      <div className="flex w-full items-center gap-3 border-b border-border bg-sidebar p-3">
        <SidebarTrigger />
        <span className="text-sm font-medium text-foreground">Agents</span>
      </div>
    </SidebarProvider>
  ),
};
