import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ErrorState } from "./ErrorState";

describe("ErrorState", () => {

  it("calls onRetry when the retry button is pressed", async () => {
    const user = userEvent.setup();
    const onRetry = vi.fn();
    render(<ErrorState onRetry={onRetry} retryLabel="Reload" />);

    await user.click(screen.getByRole("button", { name: "Reload" }));

    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("hides the retry button when no handler is given", () => {
    render(<ErrorState />);
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });
});
