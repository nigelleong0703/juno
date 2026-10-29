import { useEffect, useSyncExternalStore } from "react";

const WIDE = "(min-width: 1024px)";

/** The desktop layout: list and detail side by side. Below this the pages keep the phone-style single column. */
export function useWideLayout(): boolean {
  return useSyncExternalStore(
    (notify) => {
      if (typeof window.matchMedia !== "function") return () => undefined;
      const list = window.matchMedia(WIDE);
      list.addEventListener("change", notify);
      return () => list.removeEventListener("change", notify);
    },
    () => typeof window.matchMedia === "function" && window.matchMedia(WIDE).matches,
  );
}

function typingOrModal(target: EventTarget | null): boolean {
  if (target instanceof HTMLElement) {
    const tag = target.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target.isContentEditable) return true;
  }
  return Boolean(document.querySelector('[role="dialog"], [role="menu"], [role="listbox"]'));
}

/**
 * Keyboard for a list + detail view: ↑/↓ move the selection through `ids` (starting from the first), Esc clears it.
 * Inactive while typing or while a dialog or menu is open.
 */
export function useSplitSelection(ids: string[], selectedId: string | undefined, onSelect: (id: string | undefined) => void, active = true): void {
  useEffect(() => {
    if (!active) return;
    function onKeyDown(event: KeyboardEvent) {
      if (event.metaKey || event.ctrlKey || event.altKey || typingOrModal(event.target)) return;
      if (event.key === "Escape" && selectedId) {
        onSelect(undefined);
        return;
      }
      if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
      const at = selectedId ? ids.indexOf(selectedId) : -1;
      const next = ids[event.key === "ArrowDown" ? Math.min(at + 1, ids.length - 1) : Math.max(at - 1, 0)];
      if (!next || next === selectedId) return;
      event.preventDefault();
      onSelect(next);
      document.querySelector(`[data-split-id="${CSS.escape(next)}"]`)?.scrollIntoView({ block: "nearest" });
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [active, ids, selectedId, onSelect]);
}
