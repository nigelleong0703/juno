import type { Request } from "@agent-desktop/client";
import type { RequestItem } from "../../lib/items";
import { cn } from "@agent-desktop/ui";
import { useRequest } from "../../data/queries";
import { LiveRequestCard } from "../request/LiveRequestCard";

export interface RequestItemProps {
  item: RequestItem;
  onOpenSignin?: (request: Request) => void;
  className?: string;
}

/** A request embedded in the transcript, full width up to the iPhone's 560px card (no avatar beside it). */
export function RequestItem({ item, onOpenSignin, className }: RequestItemProps) {
  const { data: request } = useRequest(item.requestId);
  if (!request) return null;
  return (
    <div className={cn("py-1", className)}>
      <LiveRequestCard className="max-w-[560px]" request={request} onOpenSignin={onOpenSignin} />
    </div>
  );
}
