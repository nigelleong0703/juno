import type { UiBlock, UiDoc as UiDocData } from "@agent-desktop/client";
import { ActionCardTextRow, cn } from "@agent-desktop/ui";
import { AlertTriangle, CheckCircle2, ExternalLink, Info } from "lucide-react";
import { useState, type ReactNode } from "react";
import { useRequestPreview } from "../../data/tasks";
import { t } from "../../lib/i18n";
import { isRenderable } from "./answers";
import { ChoicesBlock, FieldsBlock } from "./UiDocInput";

/** Rows shown before "Show N more" (items up to 20, tables up to 20). */
const ITEM_CAP = 5;
const ROW_CAP = 6;

/** How a question card answers: the interactive block of the doc calls `onAnswer`. */
export interface UiDocAnswering {
  /** Recorded answers of a decided question; with `readOnly` they show in place of inputs. */
  answers?: Record<string, string>;
  readOnly?: boolean;
  disabled?: boolean;
  /** Server reasons keyed by field id (400 `error.fields`). */
  errors?: Record<string, string>;
  onAnswer: (answers: Record<string, string>) => void;
}

type LeafBlock = Exclude<UiBlock, { type: "group" | "choices" | "fields" | "replies" }>;

const Tile = ({ nested, children }: { nested: boolean; children: ReactNode }) =>
  nested ? <div>{children}</div> : <div className="rounded-[20px] bg-[#f4f4f4] px-4 py-3 dark:bg-[#242424]">{children}</div>;

function ShowMore({ hidden, onClick }: { hidden: number; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className="mt-2 text-[13px] text-foreground/60 underline focus-ring">
      {t("models.showMore", { count: hidden })}
    </button>
  );
}

function FactsBlock({ block, nested }: { block: Extract<UiBlock, { type: "facts" }>; nested: boolean }) {
  return (
    <Tile nested={nested}>
      <dl className="flex flex-col gap-1.5">
        {block.rows.map((row, index) => (
          <div key={`${row.label}-${index}`} className="flex items-baseline justify-between gap-4 text-sm leading-5">
            <dt className="shrink-0 text-foreground/60">{row.label}</dt>
            <dd className={cn("min-w-0 text-right", row.emphasis === true && "font-semibold")}>{row.value}</dd>
          </div>
        ))}
      </dl>
    </Tile>
  );
}

function ItemsBlock({ block, nested }: { block: Extract<UiBlock, { type: "items" }>; nested: boolean }) {
  const [all, setAll] = useState(false);
  const rows = all ? block.rows : block.rows.slice(0, ITEM_CAP);
  return (
    <Tile nested={nested}>
      <ul className="flex flex-col gap-2.5">
        {rows.map((row, index) => (
          <li key={`${row.name}-${index}`} className="flex items-center gap-3 text-sm leading-5">
            {row.imageUrl ? <img src={row.imageUrl} alt="" referrerPolicy="no-referrer" loading="lazy" className="size-10 shrink-0 rounded-lg bg-foreground/5 object-cover" /> : null}
            <div className="min-w-0 flex-1">
              <div className="line-clamp-2">{row.name}</div>
              {row.detail ? <div className="truncate text-[13px] text-foreground/60">{row.detail}</div> : null}
            </div>
            {row.quantity && row.quantity > 1 ? <span className="shrink-0 text-foreground/60">×{row.quantity}</span> : null}
            {row.price ? <span className="shrink-0">{row.price}</span> : null}
          </li>
        ))}
      </ul>
      {block.rows.length > ITEM_CAP && !all ? <ShowMore hidden={block.rows.length - ITEM_CAP} onClick={() => setAll(true)} /> : null}
      {block.total ? (
        <div className="mt-2 border-t border-foreground/10 pt-0.5">
          <ActionCardTextRow label={block.total.label} value={block.total.value} />
        </div>
      ) : null}
    </Tile>
  );
}

function TableBlock({ block, nested }: { block: Extract<UiBlock, { type: "table" }>; nested: boolean }) {
  const [all, setAll] = useState(false);
  const rows = all ? block.rows : block.rows.slice(0, ROW_CAP);
  return (
    <Tile nested={nested}>
      <div className="-mx-1 overflow-x-auto px-1">
        <table className="w-full min-w-max border-collapse text-left text-[13px] leading-5">
          <thead>
            <tr>
              {block.columns.map((column, index) => (
                <th key={`${column}-${index}`} scope="col" className="whitespace-nowrap py-1 pr-4 font-medium text-foreground/60 last:pr-0">{column}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, rowIndex) => (
              <tr key={rowIndex} className="border-t border-foreground/10">
                {row.map((cell, cellIndex) => (
                  <td key={cellIndex} className="whitespace-nowrap py-1.5 pr-4 last:pr-0">{cell}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {block.rows.length > ROW_CAP && !all ? <ShowMore hidden={block.rows.length - ROW_CAP} onClick={() => setAll(true)} /> : null}
    </Tile>
  );
}

const TONES = {
  info: { icon: Info, box: "bg-info-subtle", color: "text-foreground/70" },
  warning: { icon: AlertTriangle, box: "bg-warning-subtle", color: "text-warning" },
  success: { icon: CheckCircle2, box: "bg-success-subtle", color: "text-success" },
} as const;

function NoticeBlock({ block }: { block: Extract<UiBlock, { type: "notice" }> }) {
  const tone = TONES[block.tone];
  const Icon = tone.icon;
  return (
    <div role={block.tone === "warning" ? "alert" : "note"} className={cn("flex items-start gap-2.5 rounded-[20px] px-4 py-3 text-sm leading-5", tone.box)}>
      <Icon className={cn("mt-0.5 size-[18px] shrink-0", tone.color)} />
      <span className="min-w-0">{block.text}</span>
    </div>
  );
}

function LinkBlock({ block }: { block: Extract<UiBlock, { type: "link" }> }) {
  return (
    <a href={block.url} target="_blank" rel="noopener noreferrer" className="flex min-h-14 items-center gap-3 rounded-[20px] bg-[#f4f4f4] px-4 py-3 dark:bg-[#242424] focus-ring">
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium leading-5">{block.title}</div>
        {block.subtitle ? <div className="truncate text-[13px] leading-[18px] text-foreground/60">{block.subtitle}</div> : null}
      </div>
      <ExternalLink className="size-4 shrink-0 text-foreground/50" />
    </a>
  );
}

function ImageBlock({ block }: { block: Extract<UiBlock, { type: "image" }> }) {
  const image = useRequestPreview(block.libraryId);
  return (
    <figure className="m-0">
      <div className="relative overflow-hidden rounded-2xl border border-foreground/[0.07] bg-[#fafafa] dark:bg-[#121212]">
        {image.data ? (
          <img src={image.data} alt={block.caption ?? ""} className="max-h-72 w-full object-cover object-top" />
        ) : (
          <div className="grid aspect-[327/193] place-items-center text-[13px] text-foreground/50">{image.isError ? t("uidoc.imageFailed") : null}</div>
        )}
      </div>
      {block.caption ? <figcaption className="mt-1.5 px-1 text-[13px] leading-[18px] text-foreground/60">{block.caption}</figcaption> : null}
    </figure>
  );
}

function LeafView({ block, nested }: { block: LeafBlock; nested: boolean }) {
  switch (block.type) {
    case "text":
      return <p className="whitespace-pre-wrap px-1 text-sm leading-5">{block.text}</p>;
    case "facts":
      return <FactsBlock block={block} nested={nested} />;
    case "items":
      return <ItemsBlock block={block} nested={nested} />;
    case "table":
      return <TableBlock block={block} nested={nested} />;
    case "notice":
      return <NoticeBlock block={block} />;
    case "link":
      return <LinkBlock block={block} />;
    case "image":
      return <ImageBlock block={block} />;
  }
}

function GroupBlock({ block }: { block: Extract<UiBlock, { type: "group" }> }) {
  return (
    <section className="rounded-[20px] bg-[#f4f4f4] px-4 py-3 dark:bg-[#242424]">
      {block.title ? <h4 className="mb-2 text-[15px] font-semibold leading-[21px] tracking-[-0.008em]">{block.title}</h4> : null}
      <div className="flex flex-col gap-3">
        {block.blocks.map((inner, index) => (
          <LeafView key={index} block={inner} nested />
        ))}
      </div>
    </section>
  );
}

export interface UiDocProps {
  doc: UiDocData;
  /** Draw `doc.title` above the blocks (a message card); a question card shows it in its header. */
  showTitle?: boolean;
  answering?: UiDocAnswering;
  className?: string;
}

/**
 * Juno UI blocks (BACKEND 8.7.1), one view per block type. A block type this client does not know
 * (or a doc it cannot draw) shows the server-written `text` instead: a card is never dropped.
 * Choices and fields only draw when `answering` is given (a question card).
 */
export function UiDoc({ doc, showTitle = false, answering, className }: UiDocProps) {
  if (!isRenderable(doc)) {
    return <p data-slot="ui-doc-fallback" className={cn("whitespace-pre-wrap px-1 text-sm leading-5", className)}>{doc.text ?? ""}</p>;
  }
  return (
    <div data-slot="ui-doc" className={cn("flex flex-col gap-3", className)}>
      {showTitle && doc.title ? <h4 className="px-1 text-[15px] font-semibold leading-[21px] tracking-[-0.008em]">{doc.title}</h4> : null}
      {doc.blocks.map((block, index) => {
        switch (block.type) {
          case "group":
            return <GroupBlock key={index} block={block} />;
          case "replies": // drawn under the bubble by AgentMessage, only on the latest turn
            return null;
          case "choices":
            return answering ? <ChoicesBlock key={index} block={block} answering={answering} /> : null;
          case "fields":
            return answering ? <FieldsBlock key={index} doc={doc} block={block} answering={answering} /> : null;
          default:
            return <LeafView key={index} block={block} nested={false} />;
        }
      })}
    </div>
  );
}
