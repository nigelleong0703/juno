import { createElement, type ComponentType } from "react";
import {
  File as FileGlyph,
  FileArchive,
  FileAudio,
  FileCode,
  FileImage,
  FileSpreadsheet,
  FileText,
  FileVideo,
  Presentation,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";

export interface FileIconProps {
  /** File name or extension, used to pick the glyph. */
  name?: string;
  className?: string;
  size?: number;
}

function glyphFor(name: string): LucideIcon {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  if (["png", "jpg", "jpeg", "gif", "webp", "svg", "avif"].includes(ext)) return FileImage;
  if (["mp4", "mov", "webm", "avi", "mkv"].includes(ext)) return FileVideo;
  if (["mp3", "wav", "ogg", "flac", "m4a"].includes(ext)) return FileAudio;
  if (["zip", "tar", "gz", "rar", "7z"].includes(ext)) return FileArchive;
  if (["csv", "xls", "xlsx", "numbers"].includes(ext)) return FileSpreadsheet;
  if (["ppt", "pptx", "key"].includes(ext)) return Presentation;
  if (["ts", "tsx", "js", "jsx", "py", "go", "rs", "java", "json", "css", "html", "sh"].includes(ext))
    return FileCode;
  if (["md", "txt", "pdf", "doc", "docx", "rtf"].includes(ext)) return FileText;
  return FileGlyph;
}

/** Glyph chosen from a file name or extension. */
export function FileIcon({ name = "", className, size = 16 }: FileIconProps) {
  const Glyph = glyphFor(name) as ComponentType<Record<string, unknown>>;
  return createElement(Glyph, {
    "data-slot": "file-icon",
    "aria-hidden": true,
    className: cn("text-muted-foreground", className),
    size,
  });
}
