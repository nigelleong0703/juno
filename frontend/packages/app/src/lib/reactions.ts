import { create } from "zustand";
import { persist } from "zustand/middleware";

/** The emoji a message offers, same set and order as the iPhone app (`reactionChoices`). */
export const REACTIONS = ["👍", "❤️", "😂", "😮", "😢", "🙏"] as const;

interface ReactionsState {
  /** My reaction per item id. The server has no reactions API, so they live on this device only. */
  byItem: Record<string, string>;
  /** Sets the reaction, or takes it back when it is already the current one. */
  toggle: (itemId: string, emoji: string) => void;
}

export const useReactions = create<ReactionsState>()(
  persist(
    (set) => ({
      byItem: {},
      toggle: (itemId, emoji) =>
        set((state) => {
          const { [itemId]: current, ...rest } = state.byItem;
          return { byItem: current === emoji ? rest : { ...rest, [itemId]: emoji } };
        }),
    }),
    { name: "juno.reactions" },
  ),
);
