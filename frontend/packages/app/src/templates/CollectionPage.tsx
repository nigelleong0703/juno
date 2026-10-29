import {
  EmptyState,
  ErrorState,
  LoadingState,
  PageHeader,
  ScrollArea,
  SearchField,
  cn,
} from "@agent-desktop/ui";
import type { ReactNode } from "react";
import { t } from "../lib/i18n";

export interface CollectionPageProps<T> {
  title: ReactNode;
  subtitle?: ReactNode;
  count?: number;
  actions?: ReactNode;
  tabs?: ReactNode;
  /** Optional search box wired by the feature. */
  search?: { value: string; onValueChange: (value: string) => void; placeholder?: string };
  /** Extra controls between the header and the list (filters, segmented view switch…). */
  toolbar?: ReactNode;
  /** Content rendered above the list (summary cards, suggested rows…). */
  header?: ReactNode;
  items: T[] | undefined;
  getItemId: (item: T) => string;
  renderItem: (item: T) => ReactNode;
  isLoading?: boolean;
  isError?: boolean;
  onRetry?: () => void;
  emptyTitle?: string;
  emptyDescription?: string;
  emptyAction?: ReactNode;
  className?: string;
}

/**
 * The Collection template (ARCHITECTURE §5.5): a page header, optional search/toolbar, then a
 * bordered list of rows. Every list screen (Inbox, Tasks, Routines, Library, …) is this
 * template plus a `renderItem`, so the chrome stays identical everywhere.
 */
export function CollectionPage<T>({
  title,
  subtitle,
  count,
  actions,
  tabs,
  search,
  toolbar,
  header,
  items,
  getItemId,
  renderItem,
  isLoading,
  isError,
  onRetry,
  emptyTitle,
  emptyDescription,
  emptyAction,
  className,
}: CollectionPageProps<T>) {
  const resolvedSubtitle =
    subtitle ?? (typeof count === "number" ? t("collection.count", { count }) : undefined);

  return (
    <div className={cn("flex h-full min-h-0 flex-col bg-bg", className)}>
      <PageHeader title={title} subtitle={resolvedSubtitle} actions={actions} tabs={tabs} />

      {(search || toolbar) && (
        <div className="flex items-center gap-2 border-b border-border px-4 py-2">
          {search && (
            <SearchField
              className="w-72"
              size="sm"
              value={search.value}
              onValueChange={search.onValueChange}
              placeholder={search.placeholder ?? t("collection.searchPlaceholder")}
            />
          )}
          <div className="flex-1" />
          {toolbar}
        </div>
      )}

      <ScrollArea className="min-h-0 flex-1">
        <div className="p-4">
          {header}
          {isLoading ? (
            <LoadingState label={t("common.loading")} />
          ) : isError ? (
            <ErrorState title={t("common.error")} onRetry={onRetry} />
          ) : !items || items.length === 0 ? (
            <EmptyState
              title={emptyTitle ?? t("collection.empty")}
              description={emptyDescription ?? t("collection.emptyHint")}
              action={emptyAction}
            />
          ) : (
            <div className="overflow-hidden rounded-xl border border-border bg-surface">
              {items.map((item) => (
                <div key={getItemId(item)}>{renderItem(item)}</div>
              ))}
            </div>
          )}
        </div>
      </ScrollArea>
    </div>
  );
}
