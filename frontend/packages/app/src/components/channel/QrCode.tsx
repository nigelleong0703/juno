import QRCode from "qrcode";
import { useMemo } from "react";

/** A QR code for `value` (scan it with the phone), drawn as SVG on a white tile so it scans in dark mode too. */
export function QrCode({ value, label, size = 144 }: { value: string; label: string; size?: number }) {
  const path = useMemo(() => {
    const { modules } = QRCode.create(value, { errorCorrectionLevel: "M" });
    let d = "";
    for (let row = 0; row < modules.size; row += 1) {
      for (let col = 0; col < modules.size; col += 1) {
        if (modules.get(row, col)) d += `M${col} ${row}h1v1h-1z`;
      }
    }
    return { d, size: modules.size };
  }, [value]);
  return (
    <svg
      role="img"
      aria-label={label}
      width={size}
      height={size}
      viewBox={`-2 -2 ${path.size + 4} ${path.size + 4}`}
      className="shrink-0 rounded-lg bg-white"
      shapeRendering="crispEdges"
    >
      <path d={path.d} fill="#000" />
    </svg>
  );
}
