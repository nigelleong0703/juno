import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Meter } from "./Meter";

function bar(container: HTMLElement): HTMLElement {
  const el = container.querySelector('[data-slot="meter"] div[style]');
  if (!el) throw new Error("meter bar not found");
  return el as HTMLElement;
}

describe("Meter", () => {

  it("sizes the bar to the value relative to the max", () => {
    const { container } = render(<Meter value={25} max={100} />);
    expect(bar(container).style.width).toBe("25%");
  });

  it("clamps the bar at 100% when the value exceeds the max", () => {
    const { container } = render(<Meter value={150} max={100} />);
    expect(bar(container).style.width).toBe("100%");
  });

  it("exposes meter semantics with aria values", () => {
    render(<Meter value={40} max={200} label="CPU" />);
    const meter = screen.getByRole("meter");
    expect(meter).toHaveAttribute("aria-valuenow", "40");
    expect(meter).toHaveAttribute("aria-valuemin", "0");
    expect(meter).toHaveAttribute("aria-valuemax", "200");
  });
});
