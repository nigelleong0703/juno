import { Button, cn, EmptyState } from "@agent-desktop/ui";
import { ExternalLink } from "lucide-react";
import { tc } from "../i18n";
import { PILL } from "../surface";

export interface FilesPanelProps {
  /** `computer.filesUrl` when the backend exposes one. */
  filesUrl?: string;
  /** Open the files browser (wired by `ComputerPane` through the platform adapter). */
  onOpenFiles?: (url: string) => void;
  className?: string;
}

/**
 * "Files" tab (§6): the files this agent reads and writes. The backend exposes no file listing yet,
 * so we offer the `filesUrl` hand-off when the backend provides one and an empty state otherwise.
 */
export function FilesPanel({ filesUrl, onOpenFiles, className }: FilesPanelProps) {
  if (!filesUrl) {
    return (
      <EmptyState centered
        title={tc("computer.files.empty")}
        description={tc("computer.files.hint")}
        className={className}
      />
    );
  }

  return (
    <div className={cn("p-3", className)}>
      <Button
        variant="secondary"
        size="sm"
        className={cn("gap-1.5", PILL)}
        onClick={onOpenFiles ? () => onOpenFiles(filesUrl) : undefined}
      >
        <ExternalLink className="size-3.5" />
        {tc("computer.files.open")}
      </Button>
    </div>
  );
}
