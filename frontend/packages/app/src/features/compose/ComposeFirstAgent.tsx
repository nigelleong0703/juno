import { Button } from "@agent-desktop/ui";
import { useState, type ReactNode } from "react";
import { JunoBean } from "../../components/brand/JunoBean";
import { FIRST_AGENT_COPY } from "./firstAgentCopy";
import { PlatformIntro } from "./PlatformIntro";

interface ComposeFirstAgentProps {
  name: string;
  onNameChange: (value: string) => void;
  creating: boolean;
  onCreate: () => void;
  error?: string | null;
  /** Shown under the create button (the model-provider setup notice). */
  notice?: ReactNode;
}

/**
 * First-agent onboarding for an account with no agents yet (UI102): the
 * animated platform introduction comes first, then the existing name entry
 * with its create action. Same props as before — the intro collects no data
 * and creates nothing; skip and start both land on the naming form.
 * Borderless by design — no modal surface and no model controls.
 */
export function ComposeFirstAgent({
  name,
  onNameChange,
  creating,
  onCreate,
  error,
  notice,
}: ComposeFirstAgentProps) {
  const [showIntro, setShowIntro] = useState(true);

  if (showIntro) {
    return (
      <div
        data-slot="first-agent-onboarding"
        className="flex w-full max-w-xs flex-col items-center px-4 py-6"
      >
        <PlatformIntro onComplete={() => setShowIntro(false)} />
      </div>
    );
  }

  return (
    <div
      data-slot="first-agent-onboarding"
      className="flex w-full max-w-xs flex-col items-center px-4 py-6 text-center"
    >
      <JunoBean height={56} label={FIRST_AGENT_COPY.firstAgentTitle} />
      <p className="mt-3 text-base font-semibold text-fg">{FIRST_AGENT_COPY.firstAgentTitle}</p>
      <p className="mt-1 text-sm text-fg-muted">{FIRST_AGENT_COPY.firstAgentBody}</p>
      <label htmlFor="first-agent-name" className="mt-4 self-stretch text-left text-sm text-fg-muted">
        {FIRST_AGENT_COPY.firstAgentNameLabel}
      </label>
      <input
        id="first-agent-name"
        value={name}
        onChange={(event) => onNameChange(event.currentTarget.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            onCreate();
          }
        }}
        placeholder={FIRST_AGENT_COPY.firstAgentNamePlaceholder}
        disabled={creating}
        aria-label={FIRST_AGENT_COPY.firstAgentNameLabel}
        className="mt-1 w-full rounded-xl border border-border bg-input-background px-3 py-2 text-sm text-fg outline-none placeholder:text-fg-subtle"
      />
      {error ? (
        <p role="alert" className="mt-2 w-full text-sm text-fg-muted">
          {error}
        </p>
      ) : null}
      <Button
        variant="primary"
        onClick={onCreate}
        disabled={creating}
        className="mt-3 w-full"
      >
        {creating ? FIRST_AGENT_COPY.firstAgentCreating : FIRST_AGENT_COPY.firstAgentCreate}
      </Button>
      {notice}
    </div>
  );
}
