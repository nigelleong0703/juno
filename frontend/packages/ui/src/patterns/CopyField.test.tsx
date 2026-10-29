import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { CopyField } from "./CopyField";

// userEvent.setup() installs a clipboard stub on navigator; replace its
// writeText with a spy so we can assert on the calls.
function spyClipboard() {
  return vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue(undefined);
}

describe("CopyField", () => {

  it("writes the value to the clipboard and confirms the copy", async () => {
    const user = userEvent.setup();
    const writeText = spyClipboard();
    render(<CopyField value="https://hooks.example.com/abc" />);

    await user.click(screen.getByRole("button", { name: "Copy to clipboard" }));

    expect(writeText).toHaveBeenCalledWith("https://hooks.example.com/abc");
    expect(
      await screen.findByRole("button", { name: "Copied" }),
    ).toBeInTheDocument();
  });

  it("logs an error and keeps the label when the clipboard rejects", async () => {
    const user = userEvent.setup();
    const writeText = spyClipboard();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    writeText.mockRejectedValueOnce(new Error("denied"));
    render(<CopyField value="secret" />);

    await user.click(screen.getByRole("button", { name: "Copy to clipboard" }));

    expect(errorSpy).toHaveBeenCalled();
    expect(
      screen.getByRole("button", { name: "Copy to clipboard" }),
    ).toBeInTheDocument();
    errorSpy.mockRestore();
  });
});
