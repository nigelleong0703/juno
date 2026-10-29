import { useCallback, useEffect, useSyncExternalStore } from 'react';
import { useTheme, type Theme } from '@agent-desktop/ui';
import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import { useSettings } from '../data/queries';
import { useClient } from '../data/ClientProvider';
import { qk } from '../data/keys';

function asTheme(value: unknown): Theme | undefined {
  if (value === 'dark' || value === 'light' || value === 'system') return value;
  return undefined;
}

interface ThemeWriteState {
  optimistic: Theme | null;
  saving: boolean;
  queued: { choice: Theme; rollback: Theme } | null;
  failed: boolean;
  listeners: Set<() => void>;
  revision: number;
}

/**
 * Theme-write state is scoped to the session's QueryClient, never module-global: every
 * sign-in mints a fresh QueryClient, so a pending write or queued choice from a previous
 * account can neither block nor leak into the next session.
 */
const writeStates = new WeakMap<QueryClient, ThemeWriteState>();

function writeStateFor(qc: QueryClient): ThemeWriteState {
  const found = writeStates.get(qc);
  if (found) return found;
  const fresh: ThemeWriteState = {
    optimistic: null,
    saving: false,
    queued: null,
    failed: false,
    listeners: new Set(),
    revision: 0,
  };
  writeStates.set(qc, fresh);
  return fresh;
}

function notify(state: ThemeWriteState): void {
  state.revision += 1;
  for (const listener of state.listeners) listener();
}

/**
 * Theme with the account settings as the persisted source and the locally stored theme
 * as the instant fallback. The local theme paints first; once the account settings load,
 * a stored server theme takes over.
 *
 * Saving is optimistic but honest: the choice applies immediately in every consumer of
 * the session, the server PATCH runs behind it, and a failure rolls the local theme back
 * and reports through `saveFailed` in every consumer. Writes serialize per session, so
 * responses cannot land out of order; the optimistic choice clears only when the latest
 * write is confirmed and the server has converged — never merely because the stale
 * server value happens to equal it mid-flight.
 *
 * Callers must disable theme selection until `persisted` is true: choosing before the
 * settings load would apply locally with nowhere to persist, silently discarding the
 * choice. The writer and its promise chain are session-scoped and outlive any single
 * consumer, so unmounting mid-flight cannot wedge the queue.
 */
export function usePersistedTheme(): {
  theme: Theme;
  setPersistedTheme: (next: Theme) => void;
  persisted: boolean;
  saveFailed: boolean;
} {
  const { theme, setTheme } = useTheme();
  const qc = useQueryClient();
  const { data: settings } = useSettings();
  const client = useClient();
  const state = writeStateFor(qc);

  const subscribe = useCallback(
    (onChange: () => void): (() => void) => {
      state.listeners.add(onChange);
      return () => {
        state.listeners.delete(onChange);
      };
    },
    [state],
  );
  const getRevision = useCallback((): number => state.revision, [state]);
  useSyncExternalStore(subscribe, getRevision);
  const optimistic = state.optimistic;
  const saveFailed = state.failed;

  const serverTheme = asTheme(settings?.appearance?.theme);

  useEffect(() => {
    if (optimistic !== null) {
      if (!state.saving && !state.queued && serverTheme === optimistic) {
        state.optimistic = null;
        notify(state);
      }
      return;
    }
    if (serverTheme && serverTheme !== theme) setTheme(serverTheme);
  }, [optimistic, state, serverTheme, theme, setTheme]);

  const send = (choice: Theme, fallback: Theme): void => {
    state.saving = true;
    notify(state);
    void client.settings
      .update({ appearance: { theme: choice } })
      .then(
        (returned) => {
          qc.setQueryData(qk.settings(), returned);
          void qc.invalidateQueries({ queryKey: ["settings"] });
          const queued = state.queued;
          state.queued = null;
          if (queued && queued.choice !== choice) {
            send(queued.choice, asTheme(returned.appearance?.theme) ?? queued.rollback);
            return;
          }
          state.saving = false;
          notify(state);
        },
        () => {
          const queued = state.queued;
          state.queued = null;
          if (queued && queued.choice !== choice) {
            send(queued.choice, queued.rollback);
            return;
          }
          state.saving = false;
          state.optimistic = null;
          state.failed = true;
          notify(state);
          setTheme(fallback);
          void qc.invalidateQueries({ queryKey: ["settings"] });
        },
      );
  };

  const setPersistedTheme = (next: Theme) => {
    if (!settings) return;
    const rollback = serverTheme ?? theme;
    state.failed = false;
    setTheme(next);
    state.optimistic = next;
    notify(state);
    if (state.saving) {
      state.queued = { choice: next, rollback };
      notify(state);
      return;
    }
    send(next, rollback);
  };

  return { theme: optimistic ?? serverTheme ?? theme, setPersistedTheme, persisted: Boolean(settings), saveFailed };
}
