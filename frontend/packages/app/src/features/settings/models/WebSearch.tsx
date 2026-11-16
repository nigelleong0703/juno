import type { ModelSettings } from "@agent-desktop/client";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@agent-desktop/ui";
import { useUpdateSettings } from "../../../data/mutations";
import { Group, Row } from "../SettingsGroup";
import { providerErrorMessage } from "./errors";

const OPTIONS = [
  { value: "auto", label: "Auto" },
  { value: "juno", label: "Always Juno search" },
] as const;

/** Settings > Models: where web search comes from. Absent counts as auto. */
export function WebSearch({ models }: { models: ModelSettings | undefined }) {
  const save = useUpdateSettings();
  return (
    <Group title="Web search" description="Agents use the model's built-in search when it has one, and Juno's search otherwise.">
      <Row label="Web search">
        <Select
          value={models?.webSearch ?? "auto"}
          disabled={save.isPending}
          onValueChange={(next) => save.mutate({ models: { webSearch: next === "juno" ? "juno" : "auto" } })}
        >
          <SelectTrigger size="sm" aria-label="Web search" className="w-64">
            <SelectValue />
          </SelectTrigger>
          <SelectContent position="popper" align="end">
            {OPTIONS.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Row>
      {save.isError && (
        <p role="alert" className="px-2.5 pb-2 text-xs text-danger">
          {providerErrorMessage(save.error)}
        </p>
      )}
    </Group>
  );
}
