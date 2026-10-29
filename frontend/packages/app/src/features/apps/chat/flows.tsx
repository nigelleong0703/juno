import type { ConnectChannelInput, InstallAppResponse } from "@agent-desktop/client";
import { Button, SegmentedControl } from "@agent-desktop/ui";
import { useState } from "react";
import { usePlatform } from "../../../data/ClientProvider";
import { useInstallApp } from "../../../data/apps";
import { ConnectOutcome } from "./ConnectOutcome";

export type ChatKind = "telegram" | "slack" | "discord" | "feishu";

function messageOf(error: unknown): string {
  return error instanceof Error && error.message ? error.message : "Couldn't connect";
}

type FlowProps = {
  /** Required for Telegram and Feishu (one bot / app per agent); the shared Slack app and Discord bot take none. */
  agentId?: string;
  /** How many workspaces the app has now, to tell when a new one appears. */
  startCount: number;
};

const QUICK_BLURB: Record<ChatKind, string> = {
  telegram: "Juno makes a Telegram bot for this agent. You confirm it once in Telegram.",
  slack: "Add the Juno app to your Slack workspace. Then switch on the agents that should be there; each gets its own name people can @-mention.",
  discord: "Add the Juno bot to your Discord server. Then switch on the agents that should be there; each gets its own role people can @-mention.",
  feishu: "Juno creates the app. You approve it once by opening a link or scanning a QR code.",
};

/** The one path for every platform: a Connect button. The link it answers with opens here, and the page waits until it is done. */
export function QuickConnect({ kind, agentId, startCount }: FlowProps & { kind: ChatKind }) {
  const { openExternal } = usePlatform();
  const install = useInstallApp();
  const [domain, setDomain] = useState<"feishu" | "lark">("feishu");
  const [response, setResponse] = useState<InstallAppResponse | null>(null);
  if (response) return <ConnectOutcome kind={kind} response={response} startCount={startCount} onRestart={() => setResponse(null)} />;
  const body: ConnectChannelInput = kind === "telegram" ? { mode: "managed" } : kind === "feishu" ? { mode: "register", domain } : { mode: "oauth" };
  const needsAgent = (kind === "telegram" || kind === "feishu") && !agentId;
  return (
    <div className="space-y-3">
      {kind === "feishu" ? (
        <SegmentedControl
          fill
          aria-label="Feishu or Lark"
          value={domain}
          onValueChange={(value) => setDomain(value === "lark" ? "lark" : "feishu")}
          items={[
            { value: "feishu", label: "Feishu" },
            { value: "lark", label: "Lark" },
          ]}
        />
      ) : null}
      <p className="text-sm text-fg-muted">{QUICK_BLURB[kind]}</p>
      {install.isError ? (
        <p role="alert" className="text-sm text-danger">
          {messageOf(install.error)}
        </p>
      ) : null}
      <Button
        variant="primary"
        size="sm"
        disabled={install.isPending || needsAgent}
        onClick={() =>
          install.mutate(
            { appId: kind, input: { ...body, ...(agentId ? { agentId } : {}) } },
            {
              onSuccess: (answer) => {
                setResponse(answer);
                if (answer.openUrl) openExternal(answer.openUrl);
              },
            },
          )
        }
      >
        Connect
      </Button>
    </div>
  );
}
