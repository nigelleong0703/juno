import type { Agent } from "@agent-desktop/client";
import { Combobox } from "@agent-desktop/ui";
import { useMemo } from "react";

export interface AgentPickerProps {
  agents: Agent[];
  value?: string;
  onValueChange: (agentId: string) => void;
  placeholder?: string;
  className?: string;
}

/** Choose an agent (based on ui Combobox). Options show the role as the description. */
export function AgentPicker({ agents, value, onValueChange, placeholder, className }: AgentPickerProps) {
  const options = useMemo(
    () =>
      agents.map((agent) => ({
        value: agent.id,
        label: `${agent.name} · @${agent.handle}`,
        description: agent.title,
      })),
    [agents],
  );

  return (
    <Combobox
      className={className}
      options={options}
      value={value}
      onValueChange={onValueChange}
      placeholder={placeholder ?? "Choose an agent…"}
    />
  );
}
