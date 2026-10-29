import type { ModelSettings } from "@agent-desktop/client";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@agent-desktop/ui";
import { useUpdateSettings } from "../../../data/mutations";
import { Group, Row } from "../SettingsGroup";
import { providerErrorMessage } from "./errors";

const OPTIONS = [
  { value: "auto", label: "Use the model's own search when available" },
  { value: "juno", label: "Always use Juno search" },
] as const;

/** Settings > Models: where web search comes from. Absent counts as auto. */
export function WebSearch({ models }: { models: ModelSettings | undefined }) {
  const save = useUpdateSettings();
  return (
    <Group title="Web search" description="Models from OpenAI and Anthropic can search the web themselves. Juno search works with every model.">
      <Row label="Search source">
        <Select
          value={models?.webSearch ?? "auto"}
          disabled={save.isPending}
          onValueChange={(next) => save.mutate({ models: { webSearch: next === "juno" ? "juno" : "auto" } })}
        >
          <SelectTrigger size="sm" aria-label="Search source" className="w-64">
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
