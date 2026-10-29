import type { ComputerRuntime, MacPairing, MacStatus } from "@agent-desktop/client";
import { useEffect, useState } from "react";
import type { MyMacLinkState, PlatformMyMac } from "../platform/adapter";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useClient } from "./ClientProvider";
import { qk } from "./keys";

/** How often the app re-asks whether the Mac's link is up: the picker and Settings both show "offline" from it. */
const MAC_POLL_MS = 15_000;

/** The owner's Mac as a computer (My Mac): paired or not, online or not. */
export function useMyMac() {
  const client = useClient();
  return useQuery({ queryKey: qk.myMac(), queryFn: () => client.computers.myMac(), refetchInterval: MAC_POLL_MS });
}

/** Where the sandbox runs on this install and whether its image is ready; re-asked every few seconds while the image downloads. */
export function useComputerRuntime() {
  const client = useClient();
  return useQuery({
    queryKey: qk.computerRuntime(),
    queryFn: () => client.computers.runtime(),
    refetchInterval: (query) => ((query.state.data as ComputerRuntime | undefined)?.image.state === "pulling" ? 3000 : false),
  });
}

/** The apps the owner let agents use on their Mac for good. */
export function useMacApps() {
  const client = useClient();
  return useQuery({ queryKey: qk.macApps(), queryFn: () => client.macApps() });
}

/** Take one app back; the server answers with the updated list, which replaces the cached one. */
export function useRevokeMacApp() {
  const client = useClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (app: string) => client.revokeMacApp(app),
    onSuccess: (list) => qc.setQueryData(qk.macApps(), list),
    onSettled: () => void qc.invalidateQueries({ queryKey: qk.macApps() }),
  });
}

/** The state the agent's Computer choice reads: what may be picked and what to say next to it. */
export function macChoice(status: MacStatus | undefined): "unpaired" | "offline" | "online" {
  if (!status?.paired) return "unpaired";
  return status.online ? "online" : "offline";
}

/** Pair this Mac: the server issues the link address and token (returned once); the caller hands them to the desktop shell. */
export function usePairMyMac() {
  const client = useClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (name: string | undefined): Promise<MacPairing> => client.computers.pairMyMac(name === undefined ? {} : { name }),
    onSettled: () => void qc.invalidateQueries({ queryKey: qk.myMac() }),
  });
}

/**
 * Stop all agent access to the Mac from here (`POST /v1/computers/my-mac/stop`): the Mac cancels what is running. There is no remote
 * Resume; the Mac's own Resume (desktop app) is the only way back, and `MacStatus.stopped` says it is waiting for that.
 */
export function useStopMyMac() {
  const client = useClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => client.computers.stopMyMac(),
    onSuccess: (status) => qc.setQueryData(qk.myMac(), status),
    onSettled: () => void qc.invalidateQueries({ queryKey: qk.myMac() }),
  });
}

/** Revoke the Mac's token on the server; agents set to My Mac then report it offline. */
export function useUnpairMyMac() {
  const client = useClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => client.computers.unpairMyMac(),
    onSettled: () => void qc.invalidateQueries({ queryKey: qk.myMac() }),
  });
}

/** The desktop shell's own view of the link (running commands, Stop), kept in step through its change events. */
export function useLinkState(mac: PlatformMyMac | undefined): MyMacLinkState | undefined {
  const [state, setState] = useState<MyMacLinkState | undefined>(undefined);
  useEffect(() => {
    if (!mac) return undefined;
    let live = true;
    void mac.state().then((next) => live && setState(next), () => undefined);
    const off = mac.onState((next) => live && setState(next));
    return () => {
      live = false;
      off();
    };
  }, [mac]);
  return state;
}

