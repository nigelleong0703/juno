import { createMockClient, type MockClient } from "@agent-desktop/test-fixtures";
import { QueryClient } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ClientProvider } from "../../data/ClientProvider";
import { useReportTimeZone } from "../useReportTimeZone";

const DEVICE = "Asia/Singapore";

function setup(general: { timezone?: string; timezoneAuto?: boolean; locale?: string }) {
  const base = createMockClient({ seed: 7 });
  const update = vi.fn(() => base.settings.get());
  const get = vi.fn(async () => {
    const settings = await base.settings.get();
    return { ...settings, general: { ...settings.general, ...general } };
  });
  const client: MockClient = { ...base, settings: { ...base.settings, get, update } };
  const wrapper = ({ children }: { children: ReactNode }) => (
    <ClientProvider client={client} queryClient={new QueryClient()}>
      {children}
    </ClientProvider>
  );
  return { get, update, wrapper };
}

afterEach(() => vi.restoreAllMocks());

describe("useReportTimeZone", () => {
  it("reports the device zone once when it differs", async () => {
    vi.spyOn(Intl.DateTimeFormat.prototype, "resolvedOptions").mockReturnValue({ timeZone: DEVICE, locale: "en-SG" } as Intl.ResolvedDateTimeFormatOptions);
    const { update, wrapper } = setup({ timezone: "UTC", locale: "en-SG" });
    renderHook(() => useReportTimeZone(), { wrapper });
    await waitFor(() => expect(update).toHaveBeenCalledTimes(1));
    expect(update).toHaveBeenCalledWith({ general: { timezone: DEVICE } });
  });

  it("does nothing when the zone already matches", async () => {
    vi.spyOn(Intl.DateTimeFormat.prototype, "resolvedOptions").mockReturnValue({ timeZone: DEVICE, locale: "en-SG" } as Intl.ResolvedDateTimeFormatOptions);
    const { get, update, wrapper } = setup({ timezone: DEVICE, locale: "en-SG" });
    renderHook(() => useReportTimeZone(), { wrapper });
    await waitFor(() => expect(get).toHaveBeenCalled());
    expect(update).not.toHaveBeenCalled();
  });

  it("respects a manually chosen zone (timezoneAuto false)", async () => {
    vi.spyOn(Intl.DateTimeFormat.prototype, "resolvedOptions").mockReturnValue({ timeZone: DEVICE, locale: "en-SG" } as Intl.ResolvedDateTimeFormatOptions);
    const { get, update, wrapper } = setup({ timezone: "UTC", timezoneAuto: false, locale: "en-SG" });
    renderHook(() => useReportTimeZone(), { wrapper });
    await waitFor(() => expect(get).toHaveBeenCalled());
    expect(update).not.toHaveBeenCalled();
  });

  it("reports a changed locale even when the zone is chosen by hand", async () => {
    vi.spyOn(Intl.DateTimeFormat.prototype, "resolvedOptions").mockReturnValue({ timeZone: DEVICE, locale: "en-SG" } as Intl.ResolvedDateTimeFormatOptions);
    const { update, wrapper } = setup({ timezone: "UTC", timezoneAuto: false, locale: "en-US" });
    renderHook(() => useReportTimeZone(), { wrapper });
    await waitFor(() => expect(update).toHaveBeenCalledTimes(1));
    expect(update).toHaveBeenCalledWith({ general: { locale: "en-SG" } });
  });
});
