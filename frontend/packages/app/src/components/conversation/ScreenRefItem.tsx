import { ActionCard, ActionCardChip, ActionCardPreview, Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@agent-desktop/ui";
import { Monitor } from "lucide-react";
import { useState } from "react";
import { useAgent, useRun } from "../../data/queries";
import { useRequestPreview } from "../../data/tasks";
import { t } from "../../lib/i18n";
import type { ScreenRefItem as ScreenRefData } from "../../lib/items";
import { useUiStore } from "../../store/ui";
import { AgentAvatar } from "../agent/AgentAvatar";

/** The page host, or null when `url` is missing or not a URL. */
function hostOf(url: string | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).host || null;
  } catch {
    return null;
  }
}

/** A run still working: queued or running. Anything else (finished, failed, stopped, waiting on the person) means its screen is not being driven now. */
const LIVE_STATUSES = ["queued", "running"];

/**
 * "<agent>'s screen": the card the harness adds on the agent's first browser navigation. It shows the latest picture of that
 * screen (the server refreshes `previewLibraryId` as the run browses): "Live" with the current page while the run works, "Ended"
 * with the last page after. Tapping while live opens the live Computer pane; after it ended it opens the last frame.
 */
export function ScreenRefItem({ item }: { item: ScreenRefData }) {
  const { data: agent } = useAgent(item.agentId);
  const { data: run } = useRun(item.runId);
  const frame = useRequestPreview(item.previewLibraryId);
  const setComputerPanelOpen = useUiStore((state) => state.setComputerPanelOpen);
  const [viewing, setViewing] = useState(false);
  const live = run !== undefined && LIVE_STATUSES.includes(run.status);
  const page = item.title || hostOf(item.url);
  const subtitle = page ? t(live ? "screenRef.livePage" : "screenRef.endedPage", { page }) : t(live ? "request.live" : "screenRef.ended");
  const name = t("screenRef.title", { name: agent?.name ?? "" }).trim();
  return (
    <>
      <button
        type="button"
        onClick={() => (live ? setComputerPanelOpen(true) : setViewing(true))}
        className="block w-full max-w-[460px] text-left focus-ring"
      >
        <ActionCard className="px-2.5 pb-2.5 pt-2.5">
          <span className="flex items-center gap-3">
            <span className="grid size-11 shrink-0 place-items-center">
              <AgentAvatar agentId={item.agentId} avatar={agent?.avatar} size={36} flat />
            </span>
            <span className="min-w-0 flex-1">
              <span className="line-clamp-1 block text-sm font-medium leading-5">{name}</span>
              <span className="line-clamp-1 block text-[13px] leading-[18px] text-foreground/60">{subtitle}</span>
            </span>
          </span>
          <ActionCardPreview
            className="aspect-[16/10]"
            chip={
              <ActionCardChip>
                {live ? <span className="size-[7px] rounded-full bg-success" /> : null}
                {t(live ? "request.live" : "screenRef.ended")}
              </ActionCardChip>
            }
          >
            {frame.data ? (
              <img src={frame.data} alt="" className="size-full object-cover object-top" />
            ) : (
              <span className="flex size-full items-center justify-center text-foreground/40">
                <Monitor className="size-7" strokeWidth={1.5} />
              </span>
            )}
          </ActionCardPreview>
        </ActionCard>
      </button>
      <Dialog open={viewing} onOpenChange={setViewing}>
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle>{name}</DialogTitle>
            <DialogDescription>{subtitle}</DialogDescription>
          </DialogHeader>
          {frame.data ? <img src={frame.data} alt="" className="w-full rounded-xl" /> : <p className="text-sm text-foreground/60">{t("screenRef.noFrame")}</p>}
        </DialogContent>
      </Dialog>
    </>
  );
}
