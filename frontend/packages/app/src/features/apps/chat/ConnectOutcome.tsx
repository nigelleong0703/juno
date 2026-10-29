import type { InstallAppResponse } from "@agent-desktop/client";
import { Button } from "@agent-desktop/ui";
import { Check, ExternalLink } from "lucide-react";
import { QrCode } from "../../../components/channel/QrCode";
import { channelPlatformName } from "../../../components/channel/platforms";
import { usePlatform } from "../../../data/ClientProvider";
import { useApp } from "../../../data/apps";

/** A link to open here, with its QR for the phone when the link is meant to be opened there. */
export function LinkAction({ url, label, qr }: { url: string; label: string; qr?: boolean }) {
  const { openExternal } = usePlatform();
  return (
    <div className="flex flex-wrap items-center gap-3">
      <Button variant="primary" size="sm" onClick={() => openExternal(url)}>
        <ExternalLink className="size-3.5" />
        {label}
      </Button>
      {qr ? (
        <div className="flex items-center gap-2 text-xs text-fg-muted">
          <QrCode value={url} label={`QR code: ${label}`} size={112} />
          <span>or scan with your phone</span>
        </div>
      ) : null}
    </div>
  );
}

function Connected({ label }: { label?: string | undefined }) {
  return (
    <p className="flex items-center gap-1.5 text-sm font-medium text-success">
      <Check className="size-4" />
      Connected{label ? `: ${label}` : ""}
    </p>
  );
}

/** What a platform's link is for, in the button's words. */
function linkLabel(kind: string): string {
  if (kind === "telegram") return "Create the bot in Telegram";
  if (kind === "feishu") return "Open to approve";
  if (kind === "discord") return "Add to Discord";
  return "Add to Slack";
}

/**
 * What an install answered with. Added already: the new workspace or bot. Still being made (a Telegram bot, a Feishu app, a Slack
 * app): the link to finish it, polled through the app until it is connected, failed or expired. The shared Slack app and Discord bot
 * answer with a link only: it is done when a new workspace appears.
 */
export function ConnectOutcome({ kind, response, startCount, onRestart }: { kind: string; response: InstallAppResponse; startCount: number; onRestart: () => void }) {
  const polling = response.installation === null;
  const { data: app } = useApp(kind, polling);
  const pending = response.pending ? (app?.pending.find((entry) => entry.id === response.pending?.id) ?? response.pending) : null;
  const url = pending?.openUrl ?? response.openUrl ?? undefined;

  const installation = response.installation ?? (pending === null && app && app.installations.length > startCount ? app.installations[app.installations.length - 1] : undefined);
  if (installation || pending?.status === "connected") {
    return (
      <div className="space-y-3">
        <Connected label={installation?.label} />
        {response.installation && url ? <LinkAction url={url} label={`Open in ${channelPlatformName(kind)}`} qr /> : null}
        <p className="text-sm text-fg-muted">
          {kind === "slack" || kind === "discord" ? "Now switch on the agents that should be there." : "Message your bot to start."}
        </p>
      </div>
    );
  }
  if (pending && (pending.status === "failed" || pending.status === "expired")) {
    return (
      <div className="space-y-2">
        <p role="alert" className="text-sm text-danger">
          {pending.status === "expired" ? "This link expired." : (pending.error ?? "Couldn't create it.")}
        </p>
        <Button variant="secondary" size="sm" onClick={onRestart}>
          Start again
        </Button>
      </div>
    );
  }
  return (
    <div className="space-y-3">
      {url ? <LinkAction url={url} label={linkLabel(kind)} qr={kind === "telegram" || kind === "feishu"} /> : null}
      <p className="text-xs text-fg-muted">Waiting for you to finish there. This page updates by itself.</p>
    </div>
  );
}
