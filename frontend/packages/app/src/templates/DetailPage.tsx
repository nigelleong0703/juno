import {
  EmptyState,
  ErrorState,
  IconButton,
  LoadingState,
  PageHeader,
  ScrollArea,
  cn,
} from "@agent-desktop/ui";
import { ChevronLeft } from "lucide-react";
import type { ReactNode } from "react";
import { useNavigate } from "react-router";
import { t } from "../lib/i18n";

export interface DetailPageProps {
  title: ReactNode;
  subtitle?: ReactNode;
  /** Where the back chevron goes; omit to hide it. */
  backTo?: string;
  actions?: ReactNode;
  tabs?: ReactNode;
  isLoading?: boolean;
  isError?: boolean;
  notFound?: boolean;
  onRetry?: () => void;
  children: ReactNode;
  className?: string;
}

/**
 * The Detail template (ARCHITECTURE §5.5): one entity, full width, with a back affordance and
 * a consistent loading / error / not-found contract. Routines, skills and plugins all reuse it.
 */
export function DetailPage({
  title,
  subtitle,
  backTo,
  actions,
  tabs,
  isLoading,
  isError,
  notFound,
  onRetry,
  children,
  className,
}: DetailPageProps) {
  const navigate = useNavigate();

  return (
    <div className={cn("flex h-full min-h-0 flex-col bg-bg", className)}>
      <PageHeader
        title={title}
        subtitle={subtitle}
        actions={actions}
        tabs={tabs}
        back={
          backTo ? (
            <IconButton label={t("detail.back")} variant="ghost" size="sm" onClick={() => navigate(backTo)}>
              <ChevronLeft />
            </IconButton>
          ) : undefined
        }
      />

      <ScrollArea className="min-h-0 flex-1">
        <div className="mx-auto w-full max-w-3xl p-6">
          {isLoading ? (
            <LoadingState label={t("common.loading")} />
          ) : isError ? (
            <ErrorState title={t("common.error")} onRetry={onRetry} />
          ) : notFound ? (
            <EmptyState centered
              title={t("detail.notFound")}
              description={t("detail.notFoundHint")}
            />
          ) : (
            children
          )}
        </div>
      </ScrollArea>
    </div>
  );
}
