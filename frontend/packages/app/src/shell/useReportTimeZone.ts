import { useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { useClient } from "../data/ClientProvider";
import { qk } from "../data/keys";

/**
 * "Set time zone automatically" (Slack/Notion): on mount and whenever the tab becomes visible
 * again, report the device's IANA zone (unless the owner picked one by hand, `general.timezoneAuto
 * === false`) and its BCP 47 locale to the backend, only what changed. Failures are logged and
 * retried at the next foreground.
 */
export function useReportTimeZone(): void {
  const client = useClient();
  const qc = useQueryClient();
  useEffect(() => {
    const report = async (): Promise<void> => {
      try {
        const { timeZone, locale } = Intl.DateTimeFormat().resolvedOptions();
        const { general } = await client.settings.get();
        const patch = {
          ...(timeZone && general.timezoneAuto !== false && general.timezone !== timeZone ? { timezone: timeZone } : {}),
          ...(locale && general.locale !== locale ? { locale } : {}),
        };
        if (Object.keys(patch).length === 0) return;
        const updated = await client.settings.update({ general: patch });
        qc.setQueryData(qk.settings(), updated);
      } catch (error) {
        console.warn("Could not report the device time zone", error);
      }
    };
    const onVisible = (): void => {
      if (document.visibilityState === "visible") void report();
    };
    void report();
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [client, qc]);
}
