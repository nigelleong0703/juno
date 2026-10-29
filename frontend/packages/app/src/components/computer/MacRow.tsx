import type { ComputerRuntime } from "@agent-desktop/client";
import { cn } from "@agent-desktop/ui";
import { Laptop } from "lucide-react";
import { usePlatform } from "../../data/ClientProvider";
import { macChoice, useLinkState, useMyMac } from "../../data/my-mac";
import { tc } from "./i18n";

const INSTALL_URL = "https://github.com/apple/container/releases";

/** A compact line for the owner's Mac next to the sandbox screen: its state and the folder agents work in. */
export function MacRow({ className }: { className?: string }) {
  const status = useMyMac().data;
  const choice = status?.stopped ? "stopped" : macChoice(status);
  const folder = useLinkState(usePlatform().myMac)?.folder ?? "~/Juno";
  return (
    <div data-slot="mac-row" className={cn("flex items-center gap-3 rounded-xl bg-muted px-4 py-3", className)}>
      <Laptop className="size-4 shrink-0 text-fg-muted" />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-fg">{tc("computer.mac.title")}</p>
        <p className="truncate font-mono text-xs text-fg-muted">{tc("computer.mac.folder", { folder })}</p>
        {choice === "offline" ? <p className="text-xs text-fg-muted">{tc("computer.mac.offlineHint")}</p> : null}
      </div>
      <span className={cn("shrink-0 text-xs", choice === "online" ? "text-success" : "text-fg-muted")}>{tc(`computer.mac.${choice}`)}</span>
    </div>
  );
}

/** What the sandbox area says when there is no sandbox to start: how to install one, or how far its image download is. */
export function SandboxRuntimeNotice({ runtime }: { runtime: ComputerRuntime }) {
  if (runtime.kind === "none") {
    return (
      <>
        <p className="text-sm font-medium text-fg">{tc("computer.sandbox.noneTitle")}</p>
        {runtime.installHint ? <p className="text-sm text-fg-muted">{runtime.installHint}</p> : null}
        <a href={INSTALL_URL} target="_blank" rel="noreferrer" className="text-sm font-medium text-accent underline underline-offset-2">
          {tc("computer.sandbox.install")}
        </a>
      </>
    );
  }
  if (runtime.image.state === "pulling") {
    const percent = runtime.image.progress === undefined ? undefined : Math.round(runtime.image.progress * 100);
    return (
      <div className="flex w-full max-w-64 flex-col items-center gap-2">
        <p className="text-sm text-fg-muted">{tc("computer.sandbox.pulling")}</p>
        <div role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent} className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
          <div className="h-full rounded-full bg-accent transition-[width]" style={{ width: `${percent ?? 8}%` }} />
        </div>
        {percent === undefined ? null : <p className="text-xs text-fg-muted">{percent}%</p>}
      </div>
    );
  }
  if (runtime.image.state === "missing") return <p className="text-sm text-fg-muted">{tc("computer.sandbox.missing")}</p>;
  return null;
}
