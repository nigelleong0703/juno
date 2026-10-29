import { useEffect, useState, type RefObject } from "react";

/** Live width of the shell grid, following resizes through ResizeObserver + window resize. */
export function useShellWidth(shellRef: RefObject<HTMLDivElement | null>): number {
  const [shellWidth, setShellWidth] = useState(() => window.innerWidth);

  useEffect(() => {
    const shell = shellRef.current;
    if (!shell) return;
    const measure = () => {
      const width = shell.getBoundingClientRect().width;
      setShellWidth(width > 0 ? width : window.innerWidth);
    };
    measure();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(shell);
    window.addEventListener("resize", measure);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [shellRef]);

  return shellWidth;
}
