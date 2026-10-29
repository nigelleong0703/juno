import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AccountGate } from "../../AccountGate";
import { useUiStore } from "../../../store/ui";

const settings = { serverUrl: "https://accounts.example", apiToken: "token" };
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
function pathOf(input: RequestInfo | URL) { return new URL(input instanceof Request ? input.url : String(input)).pathname; }
function baseFetcher() {
  return vi.fn<typeof fetch>(async (input) => {
    const path = pathOf(input);
    if (path === "/auth/info") return json({ mode: "account", providers: ["credential"] });
    if (path === "/auth/get-session") return json(null);
    throw new Error("Unexpected request: " + path);
  });
}
beforeEach(() => {
  const FetchRequest = globalThis.Request;
  vi.stubGlobal("Request", class extends FetchRequest {
    constructor(input: RequestInfo | URL, init?: RequestInit) { super(input, { ...init, signal: undefined }); }
  });
});
afterEach(() => { cleanup(); useUiStore.getState().clearCompose(); vi.unstubAllGlobals(); });

it("switching modes keeps email, clears secrets, and collapses the name field from AX", async () => {
  render(<AccountGate settings={settings} fetcher={baseFetcher()} />);
  await screen.findByRole("button", { name: "Sign in" });
  fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
  await screen.findByLabelText("Email");
  expect(document.querySelector(".al1-namefield")?.getAttribute("data-open")).toBe("false");
  expect(document.querySelector(".al1-namefield")?.hasAttribute("inert")).toBe(true);
  fireEvent.change(screen.getByLabelText("Email"), { target: { value: "test@example.com" } });
  fireEvent.change(screen.getByLabelText("Password"), { target: { value: "secret-pass" } });
  fireEvent.click(screen.getByRole("button", { name: "Create an account" }));
  expect(screen.getByLabelText("Email")).toHaveProperty("value", "test@example.com");
  expect(screen.getByLabelText("Password")).toHaveProperty("value", "");
  expect(document.querySelector(".al1-namefield")?.getAttribute("data-open")).toBe("true");
  expect(document.querySelector(".al1-namefield")?.hasAttribute("inert")).toBe(false);
  fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Test User" } });
  expect(screen.queryByText(/Google/i)).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Already have an account? Sign in" }));
  expect(screen.getByLabelText("Email")).toHaveProperty("value", "test@example.com");
  expect(screen.getByLabelText("Password")).toHaveProperty("value", "");
  expect(document.querySelector(".al1-namefield")?.hasAttribute("inert")).toBe(true);
});

it("password visibility is a local icon toggle and resets on mode change", async () => {
  const fetcher = baseFetcher();
  render(<AccountGate settings={settings} fetcher={fetcher} />);
  await screen.findByRole("button", { name: "Sign in" });
  fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
  await screen.findByLabelText("Email");
  fireEvent.change(screen.getByLabelText("Password"), { target: { value: "keep-private" } });
  const before = fetcher.mock.calls.length;
  fireEvent.click(screen.getByRole("button", { name: "Show password" }));
  expect(screen.getByLabelText("Password").getAttribute("type")).toBe("text");
  fireEvent.click(screen.getByRole("button", { name: "Hide password" }));
  expect(screen.getByLabelText("Password").getAttribute("type")).toBe("password");
  expect(fetcher.mock.calls.length).toBe(before);
  fireEvent.click(screen.getByRole("button", { name: "Show password" }));
  fireEvent.click(screen.getByRole("button", { name: "Create an account" }));
  expect(screen.getByRole("button", { name: "Show password" })).toBeDefined();
});

it("pending sign-in blocks duplicates and mode switch, then surfaces errors once", async () => {
  let release: ((response: Response) => void) | undefined;
  const fetcher = baseFetcher();
  fetcher.mockImplementation(async (input) => {
    const path = pathOf(input);
    if (path === "/auth/info") return json({ mode: "account", providers: ["credential"] });
    if (path === "/auth/sign-in/email") return new Promise((resolve) => { release = resolve; });
    return json(null);
  });
  render(<AccountGate settings={settings} fetcher={fetcher} />);
  await screen.findByRole("button", { name: "Sign in" });
  fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
  await screen.findByLabelText("Email");
  fireEvent.change(screen.getByLabelText("Email"), { target: { value: "test@example.com" } });
  fireEvent.change(screen.getByLabelText("Password"), { target: { value: "wrong-pass" } });
  fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
  expect(screen.getByRole("group").hasAttribute("disabled")).toBe(true);
  expect(screen.getByRole("button", { name: "Create an account" }).hasAttribute("disabled")).toBe(true);
  expect(document.querySelector(".al1-spinner")).not.toBeNull();
  fireEvent.click(screen.getByRole("button", { name: /Please wait/ }));
  const signins = () => fetcher.mock.calls.filter(([input]) => pathOf(input) === "/auth/sign-in/email").length;
  expect(signins()).toBe(1);
  await act(async () => { release?.(json({ message: "Invalid email or password" }, 401)); });
  await screen.findByText("Invalid email or password");
  expect(screen.getByLabelText("Password")).toHaveProperty("value", "");
  expect(screen.getByRole("button", { name: "Show password" })).toBeDefined();
  expect(screen.getByRole("group").hasAttribute("disabled")).toBe(false);
});
