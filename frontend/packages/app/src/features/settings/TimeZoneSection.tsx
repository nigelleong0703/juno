import { Combobox, Switch } from "@agent-desktop/ui";
import { useMemo } from "react";
import { useUpdateSettings } from "../../data/mutations";
import { useSettings } from "../../data/queries";
import { TIMEZONES, localTimeZone } from "../routines/cron";
import { Group, Row } from "./SettingsGroup";

/** Every IANA zone the browser knows; the short curated list on engines without `supportedValuesOf`. */
function allTimeZones(): string[] {
  const supported = (Intl as { supportedValuesOf?: (key: string) => string[] }).supportedValuesOf;
  const zones = supported ? supported("timeZone") : [];
  return zones.length > 0 ? ["UTC", ...zones.filter((zone) => zone !== "UTC")] : [...TIMEZONES];
}

/**
 * "Set time zone automatically" or pick one by hand. Automatic is the default: the app reports
 * the device zone (`useReportTimeZone`). Choosing a zone writes `timezoneAuto: false` with that
 * IANA name, and the app stops overriding it until automatic is switched back on.
 */
export function TimeZoneSection() {
  const settings = useSettings();
  const save = useUpdateSettings();
  const device = localTimeZone();
  const general = settings.data?.general;
  const auto = general?.timezoneAuto !== false;
  const zone = general?.timezone ?? device;
  const options = useMemo(() => {
    const zones = allTimeZones();
    if (!zones.includes(zone)) zones.unshift(zone);
    return zones.map((entry) => ({ value: entry, label: entry }));
  }, [zone]);
  if (!general) return null;

  return (
    <Group description="Agents use your time zone for the current time and for the routines they schedule.">
      <Row label="Set time zone automatically" description={auto ? `Following this device (${device})` : undefined}>
        <Switch
          checked={auto}
          disabled={save.isPending}
          aria-label="Set time zone automatically"
          onCheckedChange={(checked) =>
            save.mutate({ general: checked ? { timezoneAuto: true, timezone: device } : { timezoneAuto: false, timezone: zone } })
          }
        />
      </Row>
      {!auto && (
        <Row label="Time zone">
          <Combobox
            className="h-8 w-64 text-sm"
            value={zone}
            disabled={save.isPending}
            onValueChange={(next) => save.mutate({ general: { timezoneAuto: false, timezone: next } })}
            placeholder="Time zone"
            searchPlaceholder="Find a time zone…"
            options={options}
          />
        </Row>
      )}
    </Group>
  );
}
