import { createContext, useContext } from 'react';
import { getServerSettings } from '../lib/settingsStore';

/**
 * The server this session is actually connected to, plus the real connect-screen flow.
 * AccountGate provides it; outside the gate (tests, standalone fixtures) the hook falls
 * back to this device's stored server with no switch action.
 */
export interface ServerConnection {
  serverUrl: string;
  onChangeServer: (() => void) | null;
}

export const ServerConnectionContext = createContext<ServerConnection | null>(null);

export function useServerConnection(): ServerConnection {
  const ctx = useContext(ServerConnectionContext);
  if (ctx) return ctx;
  return { serverUrl: getServerSettings().serverUrl, onChangeServer: null };
}
