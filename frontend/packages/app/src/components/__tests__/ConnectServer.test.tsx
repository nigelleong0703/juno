import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConnectServer } from "../ConnectServer";

// vitest runs without globals, so testing-library's automatic cleanup is not registered.
afterEach(cleanup);

describe("ConnectServer", () => {
  it("connects an account server without forcing an API token", () => {
    const onConnect = vi.fn();
    render(<ConnectServer authMode="account" onConnect={onConnect} />);
    expect(screen.queryByLabelText("API token")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));
    expect(onConnect).toHaveBeenCalledWith(expect.objectContaining({ serverUrl: "http://127.0.0.1:8787" }));
  });

  it("discovers auth after URL selection and exposes the legacy token only on request", () => {
    render(<ConnectServer authMode="discover" onConnect={() => {}} />);
    expect(screen.queryByLabelText("API token")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Use an API token (legacy server)" }));
    expect(screen.getByLabelText("API token")).toBeDefined();
  });

  it("starts from the local defaults and hands the settings up on connect", () => {
    const onConnect = vi.fn();
    render(<ConnectServer onConnect={onConnect} />);

    expect(screen.getByText("Connect to your Juno server")).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));

    expect(onConnect).toHaveBeenCalledWith({
      serverUrl: "http://127.0.0.1:8787",
      apiToken: "dev-token",
    });
  });

  it("passes the typed server URL and token through", () => {
    const onConnect = vi.fn();
    render(<ConnectServer onConnect={onConnect} />);

    fireEvent.change(screen.getByLabelText("Server URL"), {
      target: { value: "https://box.example:9000" },
    });
    fireEvent.change(screen.getByLabelText("API token"), { target: { value: "s3cret" } });
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));

    expect(onConnect).toHaveBeenCalledWith({
      serverUrl: "https://box.example:9000",
      apiToken: "s3cret",
    });
  });

  it("refuses a URL that is not http(s) and explains why", () => {
    const onConnect = vi.fn();
    render(<ConnectServer onConnect={onConnect} />);

    fireEvent.change(screen.getByLabelText("Server URL"), { target: { value: "localhost:8787" } });
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));

    expect(onConnect).not.toHaveBeenCalled();
    expect(screen.getByRole("alert").textContent).toContain("http://");
  });

});
