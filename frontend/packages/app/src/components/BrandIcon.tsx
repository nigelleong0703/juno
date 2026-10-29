import { cn } from "@agent-desktop/ui";
import { Calendar, CircleDot, Contact, CreditCard, Dumbbell, FileText, Folder, Laptop, LayoutGrid, ListChecks, Mail, MapPin, Music, NotebookText, Plug, Table2, Video, Zap, type LucideIcon } from "lucide-react";
import { useState } from "react";
import { useServerConnection } from "./ServerConnection";

/** Generic symbols for a connector without a brand icon, by the catalog's `icon` key. */
const SYMBOLS: Record<string, LucideIcon> = {
  mail: Mail,
  calendar: Calendar,
  folder: Folder,
  doc: FileText,
  table: Table2,
  notebook: NotebookText,
  issues: CircleDot,
  tasks: ListChecks,
  jira: LayoutGrid,
  payments: CreditCard,
  automation: Zap,
  fitness: Dumbbell,
  contacts: Contact,
  map: MapPin,
  video: Video,
  music: Music,
  laptop: Laptop,
};

/**
 * A brand icon in a rounded tile, served by the backend (one copy for every client): `iconUrl` from the catalog, else
 * `/v1/brand-icons/<id>.png` for a catalog id or channel kind (the route resolves ids), resolved against the connected
 * server. While it loads or when the server has none it shows `symbol` (the catalog's `icon` key), else `fallback`, else a plug.
 */
export function BrandIcon({ id, iconUrl, symbol, fallback, className }: { id?: string; iconUrl?: string; symbol?: string; fallback?: LucideIcon; className?: string }) {
  const { serverUrl } = useServerConnection();
  const path = iconUrl ?? (id ? `/v1/brand-icons/${id}.png` : undefined);
  const [failed, setFailed] = useState<string>();
  const [loaded, setLoaded] = useState<string>();
  const src = path && failed !== path ? new URL(path, serverUrl).href : undefined;
  const Symbol = (symbol && SYMBOLS[symbol]) || fallback || Plug;
  return (
    <span className={cn("relative flex size-9 shrink-0 items-center justify-center rounded-md bg-bg-subtle text-fg-muted", className)}>
      {path !== undefined && loaded === path ? null : <Symbol className="size-[45%]" aria-hidden />}
      {src ? (
        <img
          src={src}
          alt=""
          className={cn("size-[55%]", loaded === path ? "" : "absolute opacity-0")}
          draggable={false}
          onLoad={() => setLoaded(path)}
          onError={() => setFailed(path)}
        />
      ) : null}
    </span>
  );
}
