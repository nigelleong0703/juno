import type { Agent, Request } from "@agent-desktop/client";
import type { ReactNode } from "react";
import {
  Button,
  cn,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Spinner,
} from "@agent-desktop/ui";
import {
  ArrowLeft,
  Play,
  RefreshCw,
  Settings,
  Users,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useComputerRuntime } from "../../data/my-mac";
import { useResolveRequest } from "../../data/mutations";
import { useAgent, useAgents, useComputers, useConversation, usePendingRequests } from "../../data/queries";
import {
  resolveAgentScreen,
  useAgentScreen,
  useEnsureComputer,
  useEnsureScreen,
  useComputerScreens,
  useScreenControl,
  useScreenStreamTicket,
  useSelectedScreenAgent,
} from "../../data/screens";
import { dragRegion, noDragRegion } from "../../lib/drag";
import { useUiStore } from "../../store/ui";
import { ComputerView } from "./ComputerView";
import { MacRow, SandboxRuntimeNotice } from "./MacRow";
import { MembersPanel } from "./panels/MembersPanel";
import { TasksPanel } from "./panels/TasksPanel";
import { tc } from "./i18n";
import { deriveScreenMode, resolveScreenPresence } from "./modes";
import { ScreenPlaceholder } from "./ScreenPlaceholder";
import { SelectScreenMenu } from "./SelectScreenMenu";
import type { LiveScreenTarget } from "./types";
import { useComputerState, resolveAgentComputer } from "./useScreenState";
import { useScreenClipboard } from "./useScreenClipboard";
import { PILL, POPOVER_RADIUS, roundedSurface } from "./surface";

export interface ComputerPaneProps {
  /** The agent whose conversation the pane belongs to. */
  agentId: string;
  /** The conversation shown beside the pane (enables the Members tab for group chats). */
  conversationId?: string;
  className?: string;
  /**
   * Optional tabs (Computer / Chat files) rendered inside the existing 52px header's left
   * span in both the empty and live branches. The shell owns the tab state; the pane only
   * hosts the strip so the group screen picker and drag regions stay untouched.
   */
  headerTabs?: ReactNode;
  /**
   * Screen only (planned agent pane, MUSE-PARITY step 7): the screen exactly as in production,
   * without the pane header and ongoing tasks, which the host owns.
   */
  bare?: boolean;
  /** Controlled screen choice for a group chat when the host owns the member switcher. */
  screenAgentId?: string;
}

/**
 * The right-hand Computer pane (§修订 v0.3). Hosts the live screen plus the agent's context
 * (Overview / Routines / Files / Members) and the machine controls. E1 renders it as
 * `<ComputerPane agentId={…} conversationId={…} />`.
 */
export function ComputerPane({
  agentId: conversationAgentId,
  conversationId,
  className,
  headerTabs,
  bare = false,
  screenAgentId: controlledScreenAgentId,
}: ComputerPaneProps) {
  const navigate = useNavigateSafe();
  const runtimeQuery = useComputerRuntime();
  const setComputerPanelOpen = useUiStore((s) => s.setComputerPanelOpen);

  /**
   * Owner decision 2026-10-05 (BACKEND §7.1): agents share ONE VM but each agent gets its OWN X
   * display. The pane shows the screen of the agent selected in the member selector, defaulting to
   * whoever is currently driving the machine (`activeAgentId`).
   */
  const agentId = conversationAgentId;
  const [selectedScreenAgentId, setSelectedScreenAgentId] = useState<string | undefined>(undefined);
  const { data: agent } = useAgent(agentId);
  const {
    data: computers,
    isLoading: computersLoading,
    isError: computersError,
    refetch: refetchComputers,
  } = useComputers();
  const computer = useMemo(() => resolveAgentComputer(computers, agentId), [computers, agentId]);
  const screenAgentId = useSelectedScreenAgent(computer, agentId, controlledScreenAgentId ?? selectedScreenAgentId);
  const { data: screenAgent } = useAgent(screenAgentId);
  const { data: conversation } = useConversation(conversationId);
  const { data: allAgents } = useAgents();
  const { data: pending } = usePendingRequests();
  const { takeOver: takeOverScreen, returnControl: returnControlScreen } = useScreenControl();
  const ensureComputer = useEnsureComputer();
  const ensureScreen = useEnsureScreen();
  const resolveRequest = useResolveRequest();

  // SC1: the computers list carries no screens, so the embedded record alone leaves the pane
  // screenless (no ticket, eternal "Start screen") while the server has a live display. Query
  // the agent's screen and the computer's screen list directly; embedded data is fallback only.
  // Full query handles (not just data): a schema rejection or transport failure must surface
  // as an error card with retry, never as a misleading "no display".
  const screenQuery = useAgentScreen(computer?.id, screenAgentId);
  const screensQuery = useComputerScreens(computer?.id);
  const fetchedScreen = screenQuery.data;
  const fetchedScreens = screensQuery.data;
  const screenQueryError = screenQuery.error ?? screensQuery.error;
  const agentScreen = fetchedScreen ?? resolveAgentScreen(computer, screenAgentId);
  const screenClipboard = useScreenClipboard(agentScreen?.id);
  const embeddedScreens = computer?.screens ?? [];
  const listedScreens = fetchedScreens ?? embeddedScreens;
  // Take over the screen the user is actually looking at; that is whose display they interact with.
  // Control follows the viewed screen, including an explicit group-chat pick: gating on
  // the conversation agent would deny input on another member display after taking it over.
  const userControlsViewedScreen = agentScreen?.controller === "user";
  const control = userControlsViewedScreen;
  const streamTicket = useScreenStreamTicket(
    !agentScreen || agentScreen.state !== "live" ? undefined : agentScreen.id,
    control,
  );
  const liveStreamError = Boolean(computer) && (streamTicket.isError || agentScreen?.state === "error");

  const paneRef = useRef<HTMLDivElement>(null);
  // Reference-first composition: the default view is the screen preview plus ongoing
  // tasks. Members stays reachable through the settings menu as a secondary
  // drill-down view; Chat files and Routines live beside the pane, not inside it.
  const [detail, setDetail] = useState<"members" | null>(null);

  const agentsById = useMemo(() => {
    const map: Record<string, Agent | undefined> = {};
    for (const entry of allAgents ?? []) map[entry.id] = entry;
    return map;
  }, [allAgents]);

  const agentPending = useMemo(
    () => (pending ?? []).filter((request) => request.agentId === agentId),
    [pending, agentId],
  );
  const signinRequest = agentPending.find((r) => r.kind === "signin");
  const needsYouRequest = agentPending.find((r) => r.kind === "approval" || r.kind === "question" || r.kind === "computer");
  const focusRect = needsYouRequest?.payload.kind === "computer" ? needsYouRequest.payload.focus?.rect : undefined;

  const computerState = useComputerState(computer);
  // A brand-new agent with no computer yet reads as asleep.
  const screenMissing = !computerState;

  const mode = computer
    ? deriveScreenMode({
        computerState: screenMissing ? "asleep" : computer.state,
        userInControl: control,
        // A pending external sign-in never gates the computer: it cannot prove the model
        // paused, and viewing, starting and taking over stay available. The request renders
        // as a contextual card under the screen instead.
        signinPending: false,
        needsYouPending: Boolean(needsYouRequest),
        // No user-facing teaching entry exists (no backend recording/replay): the local
        // timer alone must never claim supported learning, so this stays false.
        teaching: false,
      })
    : "watch";

  // The screen must match the current state: a missing/asleep screen shows the asleep state,
  // otherwise the agent's own page (from its latest step). A pending external sign-in never
  // overrides the picture: app login is not the site login, and the request alone proves
  // nothing about the model, so viewing, starting and taking over stay available.
  // Only a real, server-signed ticket ever produces a fragment buffer URL; the renderer holds no
  // password. No ready screen draws a truthful placeholder instead.
  const target = streamTicket.data ? { url: streamTicket.data.url } : null;

  // Takeover/return flips the ticket query key with the control flag, so the fresh
  // ticket is briefly missing while the old session is still drawable. Hold the last
  // ticket for the SAME screen under a translucent overlay instead of flashing an
  // empty frame. The hold is keyed by screen id: a newly selected agent never
  // inherits the previous screen.
  const ticketUrl = streamTicket.data?.url;
  const [heldTicket, setHeldTicket] = useState<{ screenId: string; url: string } | null>(null);
  useEffect(() => {
    if (agentScreen && ticketUrl) setHeldTicket({ screenId: agentScreen.id, url: ticketUrl });
  }, [agentScreen, ticketUrl]);
  const heldForSameScreen =
    agentScreen && heldTicket?.screenId === agentScreen.id ? heldTicket : null;
  const displayTarget = target ?? (heldForSameScreen ? { url: heldForSameScreen.url } : null);
  const controlPending = takeOverScreen.isPending || returnControlScreen.isPending;
  const ticketGap = !target && heldForSameScreen !== null;
  const transitioning = controlPending || ticketGap;

  // The honest presence of the screen being viewed (never another agent's): with no drawable
  // target the pane shows this placeholder instead of any invented picture.
  const presence = resolveScreenPresence(agentScreen);
  const requestScreen = () => {
    if (!agentScreen || agentScreen.state === "error") {
      void ensureComputer.mutate(agentId);
      return;
    }
    void ensureScreen.mutate({ computerId: computer?.id ?? "", agentId: screenAgentId });
  };
  // The start action reports its own truth: pending disables the button, a failed allocation
  // surfaces the server message instead of failing silently.
  const startPending = ensureComputer.isPending || ensureScreen.isPending;
  const startError =
    ensureComputer.error instanceof Error
      ? ensureComputer.error.message
      : ensureScreen.error instanceof Error
        ? ensureScreen.error.message
        : null;

  // RF1: a visible Reconnect must not re-dial the expired signed ticket. Re-read the screen (and
  // re-allocate this agent's display on the SAME computer when the server dropped it), then take a
  // fresh ticket under the CURRENT controller/control mode. The owner triggers this once per click
  // — never a poll — so a paused VM is not kept awake. The group-chat screen selection is read as
  // is, never overridden locally.
  const refreshStreamTarget = useCallback(async (): Promise<LiveScreenTarget> => {
    const [screenResult, screensResult] = await Promise.all([
      screenQuery.refetch({ throwOnError: true }),
      screensQuery.refetch({ throwOnError: true }),
    ]);
    const screen =
      screenResult.data ?? screensResult.data?.find((s) => s.agentId === screenAgentId) ?? null;
    if (computer && (!screen || screen.state === "error")) {
      await ensureScreen.mutateAsync({ computerId: computer.id, agentId: screenAgentId });
    }
    const ticket = await streamTicket.refetch({ throwOnError: true });
    if (!ticket.data) throw new Error("The stream ticket could not be refreshed.");
    return { url: ticket.data.url };
  }, [screenQuery, screensQuery, streamTicket, ensureScreen, computer, screenAgentId]);

  // Explicit external site for a genuine sign-in request (payload always carries it); the
  // banner names the site instead of claiming the model paused.
  const signinSite =
    signinRequest?.payload.kind === "signin" ? signinRequest.payload.site : undefined;
  const screenPlaceholder =
    !target ? (
      <ScreenPlaceholder
        presence={
          screenQueryError || liveStreamError
            ? "error"
            : streamTicket.isLoading
              ? "starting"
              : presence
        }
        agentName={screenAgent?.name}
        onStart={requestScreen}
        startPending={startPending}
        startError={startError}
        onRetry={() => {
          void screenQuery.refetch();
          void screensQuery.refetch();
          void streamTicket.refetch();
        }}
      />
    ) : undefined;

  const isGroup = conversation?.kind === "room";
  // Group chats let the user switch which member's display the pane shows.
  const screenMemberIds = useMemo(() => {
    const ids = conversation?.agentIds ?? [];
    const withScreens = new Set(listedScreens.map((s) => s.agentId));
    const candidates = Array.from(new Set([...ids, computer?.activeAgentId ?? ""].filter(Boolean)));
      return candidates.filter((id) => withScreens.has(id) || id === agentId);
  }, [conversation?.agentIds, listedScreens, computer?.activeAgentId, agentId]);

  if (!computer) {
    // A brand-new agent has no machine yet. Keep the same header (settings + close) so the
    // surface never removes access while the machine is missing. Routines live in the tab
    // beside Chat files, which needs no machine. The body reports the real allocation state:
    // the button is disabled and labelled while pending, a failure shows the server message
    // with an actionable retry, and no code path ever paints a fabricated "connected" machine.
    const runtime = runtimeQuery.data;
    const sandboxNotice = runtime && (runtime.kind === "none" || runtime.image.state === "pulling") ? runtime : undefined;
    const startPending = ensureComputer.isPending;
    const startError =
      ensureComputer.error instanceof Error
        ? ensureComputer.error.message
        : computersError
          ? tc("computer.error.body")
          : null;
    const setup = () => void ensureComputer.mutate(agentId);
    // A failed ensure may already have created the machine row before the display allocation
    // failed. Re-check first: when the machine now exists, finish by allocating this agent's
    // display instead of re-creating the machine.
    const retry = async () => {
      const result = await refetchComputers();
      const existing = resolveAgentComputer(result.data, agentId);
      if (existing) {
        void ensureScreen.mutate({ computerId: existing.id, agentId });
        return;
      }
      setup();
    };
    return (
      <div ref={paneRef} className={cn("flex h-full min-h-0 flex-col bg-panel", className)}>
        {/* No-computer header: explicit native drag region like the conversation header
            (same 52px token row, same px-3 insets). Only the settings/close controls opt
            out; the blank spacer keeps inheriting the drag so the window still moves. */}
        {bare ? null : <div
          style={dragRegion}
          data-slot="computer-header"
          className="flex h-[var(--shell-header-height)] shrink-0 select-none items-center gap-2 px-3"
        >
          <span className="flex min-w-0 flex-1 items-center">
            {headerTabs ? (
              <span style={noDragRegion} className="flex items-center">
                {headerTabs}
              </span>
            ) : null}
          </span>
          <div style={noDragRegion} className="flex shrink-0 items-center gap-1.5">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon-sm" className={PILL} aria-label={tc("computer.action.settings")}>
                  <Settings className="size-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-56" style={roundedSurface(POPOVER_RADIUS)}>
                <DropdownMenuItem onSelect={() => navigate(`/agents/${agentId}/settings`)} className="gap-2">
                  <Settings className="size-3.5" />
                  {tc("computer.action.agentSettings")}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
            <Button
              variant="ghost"
              size="icon-sm"
              className={PILL}
              aria-label={tc("computer.action.close")}
              onClick={() => setComputerPanelOpen(false)}
            >
              <X className="size-4" />
            </Button>
          </div>
        </div>}
        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="flex flex-col items-center justify-center gap-3 px-6 py-8 text-center">
            {sandboxNotice ? (
              <SandboxRuntimeNotice runtime={sandboxNotice} />
            ) : computersLoading ? (
              <>
                <Spinner className="size-4 text-fg-muted" />
                <p className="text-sm text-fg-muted">{tc("computer.ensure.pending")}</p>
              </>
            ) : (
              <>
                {runtime?.image.state === "missing" ? <SandboxRuntimeNotice runtime={runtime} /> : null}
                {startError && !startPending ? (
                  <p role="alert" className="text-sm text-danger">
                    {startError}
                  </p>
                ) : runtime?.image.state === "missing" ? null : (
                  <p className="text-sm text-fg-muted">{tc("computer.noComputerHint")}</p>
                )}
                <Button
                  variant="secondary"
                  size="sm"
                  className={cn("gap-1.5", PILL)}
                  onClick={startError ? () => void retry() : setup}
                  disabled={startPending}
                >
                  {startPending ? <Spinner className="size-3.5" /> : startError ? <RefreshCw className="size-3.5" /> : <Play className="size-3.5" />}
                  {startPending
                    ? tc("computer.ensure.pending")
                    : startError
                      ? tc("computer.screen.retry")
                      : tc("computer.ensure")}
                </Button>
              </>
            )}
          </div>
          {agent?.macAccess ? <MacRow className="mx-3 mb-3" /> : null}
        </div>
      </div>
    );
  }

  const resolve = (request: Request | undefined, action: "approve" | "deny") => {
    if (request) resolveRequest.mutate({ id: request.id, decision: { action } });
  };

  const screenName = screenAgent?.name ?? agent?.name;
  const detailTitle = detail === "members" ? tc("computer.tab.members") : null;

  return (
    <div ref={paneRef} className={cn("flex h-full min-h-0 flex-col bg-panel", className)}>
      {/* Header: one shared-header-height row. Group chats keep the screen switcher on the left;
          otherwise the row is intentionally bare: Take over/Return + settings + close only. */}
      {/* Live header: explicit native drag region like the conversation header (same 52px
          token row, same px-3 insets). Only the switcher and the settings/close controls
          opt out; the blank spacer keeps inheriting the drag so the window still moves. */}
      {bare ? null : <div
        style={dragRegion}
        data-slot="computer-header"
        className="flex h-[var(--shell-header-height)] shrink-0 select-none items-center gap-2 px-3"
      >
        <span className="flex min-w-0 flex-1 items-center">
          {headerTabs ? (
            <span style={noDragRegion} className="flex items-center">
              {headerTabs}
            </span>
          ) : null}
          {isGroup && (
            <span style={noDragRegion} className="flex items-center">
              <SelectScreenMenu
                members={screenMemberIds
                  .map((id) => agentsById[id])
                  .filter((a): a is Agent => Boolean(a))}
                value={screenAgentId}
                onValueChange={setSelectedScreenAgentId}
              />
            </span>
          )}
        </span>
        <div style={noDragRegion} className="flex shrink-0 items-center gap-1.5">
          {/* Take over/Return drive the real stream ticket and controller: only a live screen
              can be taken over, so a missing or starting display never presents an enabled
              control as if it were live. */}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                className={PILL}
                aria-label={tc("computer.action.settings")}
              >
                <Settings className="size-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-56" style={roundedSurface(POPOVER_RADIUS)}>
              {/* Owner GH4: the settings menu stays lean — group members plus agent
                  settings only. Chat files live beside the pane, and the Advanced
                  maintenance entries are intentionally gone. */}
              {isGroup && (
                <>
                  <DropdownMenuItem onSelect={() => setDetail("members")} className="gap-2">
                    <Users className="size-3.5" />
                    {tc("computer.tab.members")}
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                </>
              )}
              <DropdownMenuItem
                onSelect={() => navigate(`/agents/${agentId}/settings`)}
                className="gap-2"
              >
                <Settings className="size-3.5" />
                {tc("computer.action.agentSettings")}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <Button
            variant="ghost"
            size="icon-sm"
            className={PILL}
            aria-label={tc("computer.action.close")}
            onClick={() => setComputerPanelOpen(false)}
          >
            <X className="size-4" />
          </Button>
        </div>
      </div>}

      <div className={bare ? undefined : "min-h-0 flex-1 overflow-y-auto"}>
        {detail ? (
          <div>
            <div className="flex shrink-0 items-center gap-1 px-3 pt-2">
              <Button
                variant="ghost"
                size="sm"
                className={cn("gap-1.5", PILL)}
                onClick={() => setDetail(null)}
              >
                <ArrowLeft className="size-3.5" />
                {tc("computer.action.back")}
              </Button>
              <span className="text-sm font-medium text-fg">{detailTitle}</span>
            </div>
            {detail === "members" && isGroup && (
              <MembersPanel
                agents={(conversation?.agentIds ?? []).map((id) => agentsById[id]).filter((a): a is Agent => Boolean(a))}
                memberIds={conversation?.memberIds ?? []}
              />
            )}
          </div>
        ) : (
          <div data-layout="computer-reference-layout">
            <ComputerView
              computer={computer}
              agent={agent}
              screenKey={agentScreen?.id}
              mode={mode}
              // Authoritative input: the user's screen lease plus a live display, matching the
              // stream ticket below. A pending-request banner (needs-you) never gates the keyboard;
              // a group member's screen, a missing display, or a non-live lifecycle stays readonly.
              // Input stays off while the handover overlay is up: keystrokes must never land
              // on the stale ticket the held frame is still showing.
              inputEnabled={control && agentScreen?.state === "live" && !transitioning}
              target={displayTarget}
              transitioning={transitioning}
              onReconnect={refreshStreamTarget}
              clipboard={screenClipboard}
              onSigninDone={() => resolve(signinRequest, "approve")}
              onSkipStep={() => resolve(needsYouRequest, "deny")}
              onContinue={() => resolve(needsYouRequest, "approve")}
              siteName={signinSite}
              empty={screenPlaceholder}
              focusRect={focusRect}
              userInControl={control}
              // Reference control form: one neutral pill carrying the status plus the handover
              // action. It shares the screen frame's stage so the connected shape can weld it to
              // the frame edge while the user holds the lease. It stays disabled until the viewed
              // screen is actually live, so a missing display never reads as controllable.
              controlFooter={
                agentScreen && screenName ? (
                  <div
                    style={roundedSurface(POPOVER_RADIUS)}
                    className="flex items-center gap-2 border border-border bg-bg py-1 pl-3 pr-1 shadow-md"
                  >
                    <span className="truncate text-sm text-fg-muted">
                      {control
                        ? tc("computer.control.youHaveControl")
                        : tc("computer.control.agentHasControl", { name: screenName })}
                    </span>
                    {control ? (
                      <Button
                        variant="secondary"
                        size="sm"
                        className={cn("shrink-0 gap-1.5", PILL)}
                        disabled={agentScreen.state !== "live"}
                        onClick={() => returnControlScreen.mutate(agentScreen)}
                      >
                        {tc("computer.control.returnToAgent")}
                      </Button>
                    ) : (
                      <Button
                        variant="secondary"
                        size="sm"
                        className={cn("shrink-0 gap-1.5", PILL)}
                        disabled={agentScreen.state !== "live"}
                        onClick={() => takeOverScreen.mutate(agentScreen)}
                      >
                        {tc("computer.takeOver")}
                      </Button>
                    )}
                  </div>
                ) : undefined
              }
              className="shrink-0"
            />
            {agent?.macAccess ? <MacRow className="mx-3 mb-3" /> : null}
            {/* Tasks follow the viewed display: in a group chat looking at another
                member frame, their runs show — never the conversation agent own. */}
            {bare ? null : <TasksPanel agentId={screenAgentId} />}
          </div>
        )}
      </div>
    </div>
  );
}

/** Navigate if a router is mounted; the dev harness renders the pane without one. */
function useNavigateSafe(): (to: string) => void {
  return (to: string) => {
    if (typeof window !== "undefined") window.location.hash = `#${to}`;
  };
}
