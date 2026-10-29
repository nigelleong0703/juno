import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";

export type Theme = "dark" | "light" | "system";
export type ResolvedTheme = "dark" | "light";

const STORAGE_KEY = "agent-desktop-theme";

type ThemeContextValue = {
  /** The user's choice, including `"system"`. */
  theme: Theme;
  /** The theme actually painted right now. */
  resolvedTheme: ResolvedTheme;
  setTheme: (theme: Theme) => void;
};

const ThemeContext = createContext<ThemeContextValue | null>(null);

function readSystemTheme(): ResolvedTheme {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return "dark";
  }
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

/** Subscribe to OS colour-scheme changes; used through `useSyncExternalStore`. */
function subscribeSystemTheme(onStoreChange: () => void): () => void {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return () => {};
  }
  const media = window.matchMedia("(prefers-color-scheme: dark)");
  media.addEventListener("change", onStoreChange);
  return () => media.removeEventListener("change", onStoreChange);
}

export type ThemeProviderProps = {
  children: ReactNode;
  /** Theme used when nothing is stored yet. Dark is the product default. */
  defaultTheme?: Theme;
  /** localStorage key; override when embedding in a host with its own theme store. */
  storageKey?: string;
};

export function ThemeProvider({
  children,
  defaultTheme = "dark",
  storageKey = STORAGE_KEY,
}: ThemeProviderProps) {
  const [theme, setThemeState] = useState<Theme>(() => {
    if (typeof window === "undefined") return defaultTheme;
    try {
      const stored = window.localStorage.getItem(storageKey);
      if (stored === "dark" || stored === "light" || stored === "system") return stored;
    } catch {
      /* localStorage unavailable (private mode) — fall through */
    }
    return defaultTheme;
  });

  // OS preference is external state: read it through the store subscription instead of
  // mirroring it into React state from an effect (which would cascade renders).
  const systemTheme = useSyncExternalStore<ResolvedTheme>(
    subscribeSystemTheme,
    readSystemTheme,
    () => "dark",
  );

  const resolvedTheme: ResolvedTheme = theme === "system" ? systemTheme : theme;

  useEffect(() => {
    // `theme` (not `resolvedTheme`) is written so the CSS `[data-theme="system"]`
    // media-query block stays in charge of the system case.
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  const setTheme = useCallback(
    (next: Theme) => {
      setThemeState(next);
      try {
        window.localStorage.setItem(storageKey, next);
      } catch {
        /* ignore persistence failures */
      }
    },
    [storageKey],
  );

  const value = useMemo<ThemeContextValue>(
    () => ({ theme, resolvedTheme, setTheme }),
    [theme, resolvedTheme, setTheme],
  );

  return <ThemeContext value={value}>{children}</ThemeContext>;
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (ctx === null) {
    throw new Error("useTheme must be used within a <ThemeProvider>");
  }
  return ctx;
}

/**
 * Like `useTheme`, but returns `null` instead of throwing when there is no
 * provider above. Used by components that must also render standalone
 * (e.g. the sonner `<Toaster/>` inside a Storybook story).
 */
export function useThemeOptional(): ThemeContextValue | null {
  return useContext(ThemeContext);
}
