import type { Step } from "@agent-desktop/client";
import { useRequestPreview } from "../../data/tasks";
import { stepExcerpt, stepUrl } from "../../lib/stepLine";

/** Grid 0fr to 1fr open/close, the same motion as the request rows. */
export function Reveal({ open, children }: { open: boolean; children: React.ReactNode }) {
  return (
    <div
      data-open={open ? "true" : undefined}
      className="grid grid-rows-[0fr] transition-[grid-template-rows] duration-200 motion-reduce:transition-none data-[open=true]:grid-rows-[1fr]"
    >
      <div className="min-h-0 overflow-hidden" aria-hidden={!open} inert={!open}>
        {children}
      </div>
    </div>
  );
}

/** What a step did, expanded: the page link, a readable excerpt, the screenshot. */
export function StepDetail({ step }: { step: Step }) {
  const url = stepUrl(step);
  const excerpt = stepExcerpt(step);
  const { data: image } = useRequestPreview(step.screenshotRef);
  return (
    <div className="flex flex-col gap-2 pb-2.5">
      {url ? (
        <a href={url} target="_blank" rel="noreferrer noopener" className="line-clamp-2 break-all text-xs text-accent hover:underline">
          {url}
        </a>
      ) : null}
      {excerpt ? <p className="text-sm text-fg-muted">{excerpt}</p> : null}
      {image ? <img src={image} alt="" className="w-full rounded-lg border border-border" /> : null}
    </div>
  );
}
