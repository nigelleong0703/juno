import { Newspaper } from "lucide-react";
import { useState } from "react";
import { useNavigate } from "react-router";
import type { FeedRefItem as FeedRefData } from "../../lib/items";
import { t } from "../../lib/i18n";

/** "Posted to Feed": a compact card for a post the agent put on the Feed; it opens the Feed on that post. */
export function FeedRefItem({ item }: { item: FeedRefData }) {
  const navigate = useNavigate();
  const [broken, setBroken] = useState(false);
  return (
    <button
      type="button"
      onClick={() => navigate(`/feed?post=${encodeURIComponent(item.feedPostId)}`)}
      className="flex w-full max-w-[460px] items-center gap-3 rounded-[20px] border border-foreground/10 bg-white p-2.5 text-left focus-ring dark:bg-[#181818]"
    >
      {item.imageUrl && !broken ? (
        <img src={item.imageUrl} alt="" loading="lazy" referrerPolicy="no-referrer" onError={() => setBroken(true)} className="size-14 shrink-0 rounded-xl bg-foreground/5 object-cover" />
      ) : (
        <span className="grid size-14 shrink-0 place-items-center rounded-xl bg-[#f4f4f4] text-foreground/50 dark:bg-[#242424]">
          <Newspaper className="size-6" />
        </span>
      )}
      <span className="min-w-0 flex-1">
        <span className="line-clamp-2 block text-sm font-medium leading-5">{item.title}</span>
        {item.summary ? <span className="line-clamp-2 block text-[13px] leading-[18px] text-foreground/70">{item.summary}</span> : null}
        <span className="block text-[13px] leading-[18px] text-foreground/60">{t("feed.postedToFeed")}</span>
      </span>
    </button>
  );
}
