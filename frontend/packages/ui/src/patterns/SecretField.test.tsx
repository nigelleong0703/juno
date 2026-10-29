import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { SecretField } from "./SecretField";

const SECRET = "sk-live-should-never-render";

describe("SecretField", () => {
  it("is write-only: it exposes no prop for reading a stored secret back", () => {
    render(<SecretField label="API key" hasStoredValue />);
    // The only rendered trace of a stored secret is a fixed placeholder marker,
    // never the secret itself.
    expect(screen.getByText("•••••••• stored")).toBeInTheDocument();
    expect(screen.getByLabelText("API key")).toHaveValue("");
  });

  it("never renders a typed value as page text", async () => {
    const user = userEvent.setup();
    render(<SecretField label="API key" />);

    await user.type(screen.getByLabelText("API key"), SECRET);

    expect(screen.queryByText(SECRET)).not.toBeInTheDocument();
    expect(document.body.textContent).not.toContain(SECRET);
  });

  it("masks input by default and only reveals it on demand", async () => {
    const user = userEvent.setup();
    render(<SecretField label="API key" />);

    const input = screen.getByLabelText("API key");
    expect(input).toHaveAttribute("type", "password");

    await user.type(input, SECRET);
    expect(input).toHaveAttribute("type", "password");

    await user.click(screen.getByRole("button", { name: "Show" }));
    expect(input).toHaveAttribute("type", "text");
  });

  it("ignores a stored value even when the field is revealed and empty", async () => {
    const user = userEvent.setup();
    render(<SecretField label="API key" hasStoredValue />);

    await user.click(screen.getByRole("button", { name: "Show" }));

    const input = screen.getByLabelText("API key");
    expect(input).toHaveValue("");
    expect(document.body.textContent).not.toContain(SECRET);
  });

  it("reports new input through onChange but keeps no readable value", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<SecretField label="API key" onChange={onChange} />);

    await user.type(screen.getByLabelText("API key"), "abc");

    expect(onChange).toHaveBeenLastCalledWith("abc");
    // The value lives only in the input element's masked value attribute.
    expect(screen.getByLabelText("API key")).toHaveAttribute("type", "password");
  });

  it("offers a clear action when a value is stored or typed", async () => {
    const user = userEvent.setup();
    const onClear = vi.fn();
    render(<SecretField label="API key" hasStoredValue onClear={onClear} />);

    await user.click(screen.getByRole("button", { name: "Clear" }));
    expect(onClear).toHaveBeenCalledTimes(1);
  });

  it("shows a hint when a value is already stored, and disables the field when disabled", () => {
    const { rerender } = render(<SecretField label="API key" hasStoredValue />);
    expect(screen.getByText("A value is already set")).toBeInTheDocument();

    rerender(<SecretField label="API key" hasStoredValue disabled />);
    expect(screen.getByLabelText("API key")).toBeDisabled();
    expect(screen.getByRole("button", { name: "Show" })).toBeDisabled();
  });
});
