import { useLayoutEffect, useRef, useState } from "react";
import { SCREEN_RADIUS } from "./surface";

/** The reference control stroke: the same solid 5px stroke as the connected tab base. */
const OUTLINE_STROKE = 5;

interface OutlineSize {
  width: number;
  height: number;
}

interface PerimeterPaths {
  left: string;
  right: string;
}

/**
 * Two mirror half-perimeter paths for the ownership outline. Each half starts at the bottom
 * centre (where the control tab welds on), runs outward along the bottom edge, around a rounded
 * corner, up the side, around the top corner and across to the top centre. Splitting the perimeter
 * in two is what lets the stroke grow from the tab and close over the screen from the bottom, and
 * retract along the very same geometry when ownership returns.
 *
 * The SVG is expanded 5px outside the frame on every side and the path is inset by half the
 * stroke from the SVG edge, so the 5px stroke sits fully outside the framebuffer pixels: the
 * path-centre radius is SCREEN_RADIUS + inset (26.5) and the inner stroke edge lands exactly on
 * the frame's own 24px corner radius.
 */
function perimeterPaths({ width, height }: OutlineSize): PerimeterPaths {
  const inset = OUTLINE_STROKE / 2;
  const radius = Math.max(0, SCREEN_RADIUS + inset);
  const left = inset;
  const right = width - inset;
  const top = inset;
  const bottom = height - inset;
  const midX = width / 2;
  const leftPath = [
    `M ${midX} ${bottom}`,
    `L ${left + radius} ${bottom}`,
    `A ${radius} ${radius} 0 0 1 ${left} ${bottom - radius}`,
    `L ${left} ${top + radius}`,
    `A ${radius} ${radius} 0 0 1 ${left + radius} ${top}`,
    `L ${midX} ${top}`,
  ].join(" ");
  const rightPath = [
    `M ${midX} ${bottom}`,
    `L ${right - radius} ${bottom}`,
    `A ${radius} ${radius} 0 0 0 ${right} ${bottom - radius}`,
    `L ${right} ${top + radius}`,
    `A ${radius} ${radius} 0 0 0 ${right - radius} ${top}`,
    `L ${midX} ${top}`,
  ].join(" ");
  return { left: leftPath, right: rightPath };
}

/**
 * CT6 ownership outline (UI85: external stroke). An absolutely positioned SVG sibling expands 5px
 * outside the screen frame's box and measures its own box, so the frame and the framebuffer never
 * move or shift and no stroke overlaps the pixels. The stroke is a single normalised
 * `stroke-dashoffset` transition (controlShape.css) from the bottom centre out and up, which
 * reverses along the same paths and snaps under reduced motion — it never fades in or out.
 */
export function FrameOutline() {
  const svgRef = useRef<SVGSVGElement>(null);
  const [size, setSize] = useState<OutlineSize | null>(null);

  useLayoutEffect(() => {
    const svg = svgRef.current;
    if (svg === null) return;
    const measure = (): boolean => {
      const rect = svg.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return false;
      setSize((prev) =>
        prev !== null && prev.width === rect.width && prev.height === rect.height
          ? prev
          : { width: rect.width, height: rect.height },
      );
      return true;
    };
    // Observe only a laid-out outline box: a zero box means there is nothing to trace yet.
    // Skipping the observer until the outline has a box also keeps the overlay inert in jsdom,
    // which has no layout and no real ResizeObserver.
    if (!measure()) return;
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      measure();
    });
    observer.observe(svg);
    return () => observer.disconnect();
  }, []);

  const paths = size === null ? null : perimeterPaths(size);

  return (
    <svg
      ref={svgRef}
      className="control-outline"
      viewBox={size === null ? undefined : `0 0 ${size.width} ${size.height}`}
      preserveAspectRatio="none"
      aria-hidden="true"
      focusable="false"
    >
      {paths === null ? null : (
        <>
          <path className="control-outline-path" d={paths.left} pathLength={1} />
          <path className="control-outline-path" d={paths.right} pathLength={1} />
        </>
      )}
    </svg>
  );
}
