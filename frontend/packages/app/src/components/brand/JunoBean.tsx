/** Literal `new URL(..., import.meta.url)` is the form Vite bundles (hashed) and rewrites. */
const BEAN_URL = new URL("../../characters/bean/bean.webp", import.meta.url).href;

/** Juno's mascot: the rendered yellow bean (transparent cut-out, 346x466). `height` is the box height in px. */
export function JunoBean({ height, label, className }: { height: number; label?: string; className?: string }) {
  return (
    <img
      src={BEAN_URL}
      alt={label ?? ""}
      aria-hidden={label ? undefined : true}
      width={Math.round((height * 346) / 466)}
      height={height}
      draggable={false}
      className={className}
      style={{ objectFit: "contain" }}
    />
  );
}
