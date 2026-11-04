import type { ApiClient, GroupSettings } from "@agent-desktop/client";
import { createMockClient } from "@agent-desktop/test-fixtures";
import { QueryClient } from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ClientProvider } from "../ClientProvider";
import { useGroupSettings, useUpdateGroupSettings } from "../group";

afterEach(cleanup);

const settings: GroupSettings = { platform: "slack", title: "Design team", observes: true, speak: false, delegated: [] };

function setup(client: ApiClient) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => <ClientProvider client={client} queryClient={queryClient}>{children}</ClientProvider>;
  return renderHook(() => ({ read: useGroupSettings("c1"), save: useUpdateGroupSettings("c1") }), { wrapper });
}

describe("group settings", () => {
  it("shows a change at once and keeps the server's answer", async () => {
    const client = createMockClient();
    vi.spyOn(client.conversations, "groupSettings").mockResolvedValue(settings);
    let answer: (value: GroupSettings) => void = () => {};
    vi.spyOn(client.conversations, "updateGroupSettings").mockReturnValue(new Promise((resolve) => (answer = resolve)));
    const { result } = setup(client);
    await waitFor(() => expect(result.current.read.data).toEqual(settings));

    act(() => result.current.save.mutate({ speak: true, delegated: ["spending"] }));
    await waitFor(() => expect(result.current.read.data).toEqual({ ...settings, speak: true, delegated: ["spending"] }));
    answer({ ...settings, speak: true, delegated: ["spending"], backfill: { status: "done", count: 142, at: "2026-11-02T14:05:00.000Z" } });
    await waitFor(() => expect(result.current.read.data?.backfill?.count).toBe(142));
  });

  it("puts the old settings back when the save fails", async () => {
    const client = createMockClient();
    vi.spyOn(client.conversations, "groupSettings").mockResolvedValue(settings);
    vi.spyOn(client.conversations, "updateGroupSettings").mockRejectedValue(new Error("offline"));
    const { result } = setup(client);
    await waitFor(() => expect(result.current.read.data).toEqual(settings));

    act(() => result.current.save.mutate({ speak: true }));
    await waitFor(() => expect(result.current.save.isError).toBe(true));
    expect(result.current.read.data).toEqual(settings);
  });
});
