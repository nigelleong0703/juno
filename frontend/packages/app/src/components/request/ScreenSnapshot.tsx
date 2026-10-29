import type { ScreenRect } from "@agent-desktop/client";
import { useQuery } from "@tanstack/react-query";
import { Monitor } from "lucide-react";
import { useState } from "react";
import { useClient } from "../../data/ClientProvider";

/**
 * A still of an agent's screen for a card preview, with the element the agent is stuck on outlined
 * (`focus` is in framebuffer pixels, so it scales with the picture). With no still available the
 * preview stays a quiet placeholder rather than inventing a picture.
 */
export function ScreenSnapshot({ screenId, focus, fallback }: { screenId?: string; focus?: ScreenRect; fallback?: string }) {
  const client = useClient();
  const [broken, setBroken] = useState(false);
  const shot = useQuery({
    queryKey: ["screenSnapshot", screenId ?? ""],
    queryFn: () => client.computers.screenshot(screenId as string),
    enabled: Boolean(screenId),
    staleTime: 30_000,
    retry: false,
  });
  const data = shot.data;
  if (!data || broken) {
    return (
      <div className="flex aspect-[327/193] w-full flex-col items-center justify-center gap-2 text-sm text-foreground/50">
        <Monitor className="size-7" strokeWidth={1.5} />
        {fallback ? <span>{fallback}</span> : null}
      </div>
    );
  }
  const box = data.width && data.height && focus ? { left: (focus.x / data.width) * 100, top: (focus.y / data.height) * 100, width: (focus.width / data.width) * 100, height: (focus.height / data.height) * 100 } : null;
  return (
    <div className="relative">
      <img src={`data:${data.mimeType};base64,${data.data}`} alt="" onError={() => setBroken(true)} className="block w-full" />
      {box ? (
        <span
          data-testid="focus-outline"
          className="absolute rounded-md ring-2 ring-foreground"
          style={{ left: `${box.left}%`, top: `${box.top}%`, width: `${box.width}%`, height: `${box.height}%` }}
        />
      ) : null}
    </div>
  );
}
