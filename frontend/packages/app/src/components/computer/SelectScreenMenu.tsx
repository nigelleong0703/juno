import type { Agent } from "@agent-desktop/client";
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@agent-desktop/ui";
import { MonitorPlay } from "lucide-react";
import { AgentAvatar } from "../agent/AgentAvatar";
import { tc } from "./i18n";
import { PILL, roundedSurface, POPOVER_RADIUS } from "./surface";

export interface SelectScreenMenuProps {
  /** Members whose displays can be shown (in a group chat). */
  members: Agent[];
  /** The member currently shown. */
  value: string;
  onValueChange: (agentId: string) => void;
  className?: string;
}

/**
 * "…"-free member screen selector (BACKEND §7.1: one display per agent). In a group chat the pane
 * shows one member's screen; this menu switches whose. It is inert for a single-member chat.
 */
export function SelectScreenMenu({ members, value, onValueChange, className }: SelectScreenMenuProps) {
  if (members.length < 2) return null;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon-sm"
          className={PILL}
          aria-label={tc("computer.screen.pick")}
          title={tc("computer.screen.pick")}
        >
          <MonitorPlay className="size-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className={className} style={roundedSurface(POPOVER_RADIUS)}>
        <DropdownMenuLabel>{tc("computer.screen.pick")}</DropdownMenuLabel>
        <DropdownMenuRadioGroup value={value} onValueChange={onValueChange}>
          {members.map((member) => (
            <DropdownMenuRadioItem key={member.id} value={member.id} className="gap-2">
              <AgentAvatar agentId={member.id} avatar={member.avatar} status={member.status} size="sm" flat />
              <span className="min-w-0 flex-1 truncate">
                {tc("computer.screen.pickMember", { name: member.name })}
              </span>
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
