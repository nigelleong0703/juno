import { useEffect, useState, type ReactNode } from "react";
import { createMockClient } from "@agent-desktop/test-fixtures";
import type { GalleryAgent, GalleryConversation, GalleryItem, GalleryRun } from "./fixtures";
import { ClientProvider } from "../../../app/src/data/ClientProvider";
import { useAgents, useConversations } from "../../../app/src/data/queries";
import { ChatRow } from "../../../app/src/components/agent/ChatRow";
import { LoadingState } from "@/patterns/LoadingState";
import { cn } from "@/lib/utils";
import { GALLERY_NOW } from "./fixtures";

/** Paused production mock client (seed 1, fixed clock): live data, no simulation drift. */
export const galleryClient = createMockClient({ seed: 1, clock: () => GALLERY_NOW, latencyMs: 0 });
galleryClient.pause();

/** Real ClientProvider around the paused mock client for hook-backed components. */
export function GalleryProviders({ children }: { children: ReactNode }) {
  return <ClientProvider client={galleryClient}>{children}</ClientProvider>;
}

/** Intentionally empty callback for gallery actions. */
export function noop(): void {}

export interface GallerySelection {
  agents: GalleryAgent[];
  conversations: GalleryConversation[];
  runs: GalleryRun[];
  items: Map<string, GalleryItem[]>;
}

/** Loads workspace data once from the paused mock client. Null while loading. */
export function useGallerySelection(): GallerySelection | null {
  const [selection, setSelection] = useState<GallerySelection | null>(null);
  useEffect(() => {
    let live = true;
    void (async () => {
      const [agents, conversations, runs] = await Promise.all([
        galleryClient.agents.list().then((result) => result.items),
        galleryClient.conversations.list().then((result) => result.items),
        galleryClient.runs.list().then((result) => result.items),
      ]);
      const targets = conversations.slice(0, 6);
      const entries = await Promise.all(
        targets.map(async (conversation) => {
          const items = await galleryClient.conversations.items(conversation.id).then((result) => result.items);
          return [conversation.id, items] as const;
        }),
      );
      if (live) setSelection({ agents, conversations, runs, items: new Map(entries) });
    })();
    return () => {
      live = false;
    };
  }, []);
  return selection;
}

/** First rows of the real sidebar list, with real data behind them. */
export function GalleryChatRows({ count = 4 }: { count?: number }) {
  const { data: conversations } = useConversations();
  const { data: agents } = useAgents();
  if (conversations === undefined || agents === undefined) return <LoadingState label="Loading chats" />;
  return (
    <div className="w-80 rounded-lg border border-border bg-card p-1">
      {conversations.slice(0, count).map((conversation: GalleryConversation, index: number) => {
        const rowAgents = conversation.agentIds.flatMap((id) => agents.find((a) => a.id === id) ?? []);
        return (
          <ChatRow
            key={conversation.id}
            conversation={conversation}
            agents={rowAgents}
            active={index === 0}
            onOpen={noop}
            onOpenComputer={noop}
          />
        );
      })}
    </div>
  );
}

export function GallerySection({
  title,
  note,
  children,
}: {
  title: string;
  note?: string;
  children: ReactNode;
}) {
  return (
    <section className="border-b border-border-subtle px-6 py-8">
      <h2 className="text-lg font-semibold text-fg">{title}</h2>
      {note === undefined ? null : <p className="mt-1 max-w-3xl text-sm text-fg-muted">{note}</p>}
      <div className="mt-4">{children}</div>
    </section>
  );
}

export type StateTagKind = "live" | "forced" | "missing";

/**
 * Provenance tag. live = real interactive state, hover it yourself. forced =
 * opened/set through the real prop (defaultOpen, running) rather than CSS fakery.
 * missing = no component exists; owned elsewhere, never faked here.
 */
export function StateTag({ kind, children }: { kind: StateTagKind; children: ReactNode }) {
  return (
    <span
      data-state-tag={kind}
      className={cn(
        "inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium",
        kind === "live" && "bg-success/15 text-success",
        kind === "forced" && "bg-info/15 text-info",
        kind === "missing" && "bg-warning/15 text-warning",
      )}
    >
      {children}
    </span>
  );
}

export function MissingNote({ owner, children }: { owner: string; children: ReactNode }) {
  return (
    <p className="mt-2 max-w-3xl text-xs text-fg-muted">
      <StateTag kind="missing">missing</StateTag> {children} Owner: {owner}.
    </p>
  );
}
