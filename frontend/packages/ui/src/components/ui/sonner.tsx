import * as React from "react";
import {
  CircleCheckIcon,
  InfoIcon,
  Loader2Icon,
  OctagonXIcon,
  TriangleAlertIcon,
} from "lucide-react";
import { Toaster as Sonner, type ToasterProps } from "sonner";
import { useThemeOptional } from "@/theme/ThemeProvider";

/**
 * App-wide toast surface (replaces the old hand-written Toast/ToastProvider).
 * Follows the product theme (ThemeProvider) when one is mounted, and falls back
 * to the OS preference otherwise.
 */
const Toaster = ({ ...props }: ToasterProps) => {
  const theme = useThemeOptional();
  const resolved = theme?.resolvedTheme ?? "system";

  return (
    <Sonner
      theme={resolved as ToasterProps["theme"]}
      className="toaster group"
      icons={{
        success: <CircleCheckIcon className="size-4" />,
        info: <InfoIcon className="size-4" />,
        warning: <TriangleAlertIcon className="size-4" />,
        error: <OctagonXIcon className="size-4" />,
        loading: <Loader2Icon className="size-4 animate-spin" />,
      }}
      style={
        {
          "--normal-bg": "var(--popover)",
          "--normal-text": "var(--popover-foreground)",
          "--normal-border": "var(--border)",
          "--border-radius": "var(--radius)",
        } as React.CSSProperties
      }
      {...props}
    />
  );
};

export { Toaster };
