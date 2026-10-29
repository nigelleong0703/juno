import { cjk } from "@streamdown/cjk";
import { code } from "@streamdown/code";
import { Streamdown } from "streamdown";
import { cn } from "@/lib/utils";

export interface MarkdownProps {
  /** Markdown content. */
  children: string;
  className?: string;
  /** Disable embedded media when displaying authenticated document previews. */
  allowMedia?: boolean;
}

const streamdownPlugins = { cjk, code };

/**
 * Markdown renderer backed by Streamdown, with the CJK and code plugins so
 * Chinese prose and fenced code blocks render correctly.
 */
export function Markdown({ children, className, allowMedia = true }: MarkdownProps) {
  return (
    <div
      data-slot="markdown"
      className={cn(
        "text-sm leading-relaxed text-foreground",
        "[&_a]:text-foreground [&_a]:underline [&_a]:underline-offset-2",
        "[&_code]:font-mono [&_h1]:mt-4 [&_h1]:mb-2 [&_h1]:text-xl [&_h1]:font-semibold",
        "[&_h2]:mt-3 [&_h2]:mb-2 [&_h2]:text-lg [&_h2]:font-semibold",
        "[&_h3]:mt-2 [&_h3]:mb-1 [&_h3]:text-base [&_h3]:font-semibold",
        "[&_li]:my-1 [&_ol]:my-2 [&_ol]:list-decimal [&_ol]:pl-5",
        "[&_p]:my-2 [&_table]:my-2 [&_table]:w-full [&_ul]:my-2 [&_ul]:list-disc [&_ul]:pl-5",
        className,
      )}
    >
      <Streamdown plugins={streamdownPlugins} disallowedElements={allowMedia ? undefined : ["img", "video", "audio", "iframe", "object", "embed"]}>{children}</Streamdown>
    </div>
  );
}
