import { cn } from "@agent-desktop/ui";
import { Bird, Gamepad2, Hash, Send, type LucideIcon } from "lucide-react";
import { BrandIcon } from "../BrandIcon";

/** The messaging platforms an agent can be connected to, with the icon and name every screen shows for them. */
export const CHANNEL_PLATFORMS: Record<string, { name: string; icon: LucideIcon }> = {
  telegram: { name: "Telegram", icon: Send },
  slack: { name: "Slack", icon: Hash },
  discord: { name: "Discord", icon: Gamepad2 },
  feishu: { name: "Feishu / Lark", icon: Bird },
};

export function channelPlatformName(kind: string): string {
  return CHANNEL_PLATFORMS[kind]?.name ?? kind;
}

/** A conversation's origin: the platform icon and name in a small pill (chat header, conversation list). */
export function ChannelBadge({ kind, iconOnly = false, className }: { kind: string; iconOnly?: boolean; className?: string }) {
  const Icon = CHANNEL_PLATFORMS[kind]?.icon ?? Hash;
  const name = channelPlatformName(kind);
  return (
    <span
      title={name}
      aria-label={iconOnly ? `Chat on ${name}` : undefined}
      className={cn("inline-flex shrink-0 items-center gap-1 rounded-full bg-bg-subtle px-1.5 py-0.5 text-[11px] text-fg-muted", className)}
    >
      <Icon className="size-3" aria-hidden />
      {iconOnly ? null : name}
    </span>
  );
}

/** The platform's official logo (served by the backend) in the rounded tile the connectors use. */
export function ChannelIcon({ kind, className }: { kind: string; className?: string }) {
  return <BrandIcon id={kind} fallback={CHANNEL_PLATFORMS[kind]?.icon ?? Hash} className={className} />;
}

/** Under a message: which platform it came from ("via Slack") or is sent to ("sent to Slack"). Subtle secondary text. */
export function ChannelMarker({ kind, direction, className }: { kind: string; direction: "from" | "to"; className?: string }) {
  const Icon = CHANNEL_PLATFORMS[kind]?.icon ?? Hash;
  return (
    <span data-slot="channel-marker" className={cn("inline-flex items-center gap-1 text-[11px] text-fg-subtle", className)}>
      <Icon className="size-3" aria-hidden />
      {direction === "from" ? "via" : "sent to"} {channelPlatformName(kind)}
    </span>
  );
}
