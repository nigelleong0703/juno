import { useCallback } from "react";
import { useLocation, useNavigate } from "react-router";

/** The route of one item's full-screen viewer. Every entry point (Library, chat cards, the computer's Files) opens this. */
export function artifactPath(id: string): string {
  return `/library/${encodeURIComponent(id)}`;
}

/**
 * Opens an item in the full-screen viewer and closes it again: the browser back returns to where the person was,
 * and a viewer opened on a fresh page (no history entry to go back to) closes to the Library.
 */
export function useOpenArtifact() {
  const navigate = useNavigate();
  const location = useLocation();
  const open = useCallback((id: string) => navigate(artifactPath(id)), [navigate]);
  const close = useCallback(() => {
    if (location.key === "default") navigate("/library", { replace: true });
    else navigate(-1);
  }, [location.key, navigate]);
  return { open, close };
}
