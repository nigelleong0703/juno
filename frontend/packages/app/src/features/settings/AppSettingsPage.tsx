import type { PlatformLoginItem } from "../../platform/adapter";
import type { UpdateSettingsInput } from "@agent-desktop/client";
import { Button, SegmentedControl, Switch, Textarea } from "@agent-desktop/ui";
import { useEffect, useState } from "react";
import { useParams } from "react-router";
import { usePlatform } from "../../data/ClientProvider";
import { useHomeFile, useWriteHomeFile } from "../../data/home";
import { errorCode } from "../../data/model-providers";
import { useUpdateSettings } from "../../data/mutations";
import { useSettings } from "../../data/queries";
import { t } from "../../lib/i18n";
import { usePersistedTheme } from "../../lib/persistedTheme";
import { useServerConnection } from "../../components/ServerConnection";
import { ModelsSection } from "./models/ModelsSection";
import { MyMacSection } from "./MyMacSection";
import { ProactiveRulesSection } from "./ProactiveRules";
import { Group, Row, SettingsTitle } from "./SettingsGroup";
import { isSettingsPage, SettingsShell, settingsPageLabel } from "./SettingsShell";
import { TimeZoneSection } from "./TimeZoneSection";
import { YourDetailsSection } from "./YourDetails";
export function AppSettingsPage() {
  const { section } = useParams<{ section?: string }>();
  const active = isSettingsPage(section) ? (section as string) : "profile";
  const heading = settingsPageLabel(active);

  return (
    <SettingsShell activeId={active}>
      <div className="max-w-2xl space-y-8">
        {active !== "profile" && active !== "details" && <SettingsTitle title={heading} />}
        {active === "models" && <ModelsSection />}
        {active === "profile" && <ProfileSection title={heading} />}
        {active === "details" && (
          <YourDetailsSection title={heading} before={<TimeZoneSection />} />
        )}
        {active === "budget" && <BudgetSection />}
        {active === "mac" && <MyMacSection />}
        {active === "proactive" && <ProactiveRulesSection />}
        {active === "appearance" && <AppearanceSection />}
        {active === "connection" && <ConnectionSection />}
        {active === "about" && <AboutSection />}
      </div>
    </SettingsShell>
  );
}

interface BudgetDraft {
  steps: string;
  tokens: string;
  activeSeconds: string;
  costUsd: string;
  onUnknown: string;
}

function budgetFromSettings(usage: { steps?: number; tokens?: number; activeSeconds?: number; costUsd?: number; onUnknown?: string } | undefined): BudgetDraft {
  return {
    steps: usage?.steps === undefined ? "" : String(usage.steps),
    tokens: usage?.tokens === undefined ? "" : String(usage.tokens),
    activeSeconds: usage?.activeSeconds === undefined ? "" : String(usage.activeSeconds),
    costUsd: usage?.costUsd === undefined ? "" : String(usage.costUsd),
    // Mirror the actual current policy (helper/API default is block); the user may pick the looser
    // option deliberately rather than having it silently chosen for them.
    onUnknown: usage?.onUnknown ?? "block",
  };
}

function budgetPatch(draft: BudgetDraft): NonNullable<UpdateSettingsInput["usage"]> {
  const patch: NonNullable<UpdateSettingsInput["usage"]> = {};
  const steps = Number.parseInt(draft.steps, 10);
  if (Number.isFinite(steps) && steps >= 0) patch.steps = steps;
  const tokens = Number.parseInt(draft.tokens, 10);
  if (Number.isFinite(tokens) && tokens >= 0) patch.tokens = tokens;
  const activeSeconds = Number.parseFloat(draft.activeSeconds);
  if (Number.isFinite(activeSeconds) && activeSeconds >= 0) patch.activeSeconds = activeSeconds;
  const costUsd = Number.parseFloat(draft.costUsd);
  if (Number.isFinite(costUsd) && costUsd >= 0) patch.costUsd = costUsd;
  patch.onUnknown = draft.onUnknown === "block" ? "block" : "ignore";
  return patch;
}

/**
 * Owner-wide run budgets (PH11). Steps and active time are hard caps; a cost budget stops the run
 * once the known spend reaches it, and "Block on unknown price" also stops when a price cannot be
 * measured. This is a global setting, never a per-agent model option.
 */
function BudgetSection() {
  const settingsQuery = useSettings();
  const save = useUpdateSettings();
  const [draft, setDraft] = useState<BudgetDraft | undefined>(undefined);
  const loaded = settingsQuery.data !== undefined;
  const served = budgetFromSettings(settingsQuery.data?.usage);
  if (draft === undefined && loaded) setDraft(served);
  const patch = draft === undefined ? null : budgetPatch(draft);
  const dirty = draft !== undefined && JSON.stringify(draft) !== JSON.stringify(served);
  const setField = (key: "steps" | "tokens" | "activeSeconds" | "costUsd") => (event: React.ChangeEvent<HTMLInputElement>) => {
    const value = event.currentTarget.value;
    setDraft((current) => (current ? { ...current, [key]: value } : current));
  };
  const setOnUnknown = (value: string) => setDraft((current) => (current ? { ...current, onUnknown: value } : current));
  const onSave = () => {
    if (patch === null) return;
    save.mutate({ usage: patch }, { onSuccess: () => setDraft(draft) });
  };
  if (draft === undefined) return null;
  return (
    <section className="space-y-4">
      <header className="space-y-1">
        <p className="text-xs text-fg-muted">
          Owner-wide run budgets, applied to every agent. Steps and active time are hard caps. A cost
          budget stops the run once the known spend reaches it; Block on unknown price also stops when a
          price cannot be measured. Leave a field empty to leave it unenforced.
        </p>
      </header>
      <div className="grid grid-cols-2 gap-3">
        <label className="space-y-1 text-xs text-fg-muted">
          Max steps
          <input className="h-8 w-full rounded-md border border-border bg-bg px-2 text-sm text-fg" inputMode="numeric" value={draft.steps} onChange={setField("steps")} />
        </label>
        <label className="space-y-1 text-xs text-fg-muted">
          Max tokens
          <input className="h-8 w-full rounded-md border border-border bg-bg px-2 text-sm text-fg" inputMode="numeric" value={draft.tokens} onChange={setField("tokens")} />
        </label>
        <label className="space-y-1 text-xs text-fg-muted">
          Max active seconds
          <input className="h-8 w-full rounded-md border border-border bg-bg px-2 text-sm text-fg" inputMode="decimal" value={draft.activeSeconds} onChange={setField("activeSeconds")} />
        </label>
        <label className="space-y-1 text-xs text-fg-muted">
          Max cost (USD)
          <input className="h-8 w-full rounded-md border border-border bg-bg px-2 text-sm text-fg" inputMode="decimal" value={draft.costUsd} onChange={setField("costUsd")} />
        </label>
      </div>
      <div className="space-y-1">
        <p className="text-xs text-fg-muted">When a budget cannot be measured exactly</p>
        <SegmentedControl
          value={draft.onUnknown}
          onValueChange={setOnUnknown}
          items={[
            { value: "ignore", label: "Known spend only" },
            { value: "block", label: "Block on unknown price" },
          ]}
        />
      </div>
      <Button variant="primary" size="sm" onClick={onSave} disabled={!dirty || save.isPending}>
        Save
      </Button>
    </section>
  );
}

/** The owner's own free-text "about me": USER.md in the home, read by every agent. */
function ProfileSection({ title }: { title: string }) {
  const { file, isPending } = useHomeFile("USER.md");
  const save = useWriteHomeFile();
  const [draft, setDraft] = useState<string | undefined>(undefined);
  const [conflict, setConflict] = useState(false);
  const served = file?.content ?? "";
  if (isPending) return null;
  const value = draft ?? served;
  const onSave = () =>
    save.mutate(
      { path: "USER.md", content: value, ...(file === undefined ? {} : { expectedHash: file.hash }) },
      {
        onSuccess: () => {
          setConflict(false);
          setDraft(undefined);
        },
        onError: (error) => {
          if (errorCode(error).status !== 409) return;
          setConflict(true);
          setDraft(undefined);
        },
      },
    );
  return (
    <section className="space-y-4">
      <SettingsTitle
        title={title}
        action={
          <Button variant="primary" size="sm" disabled={value === served || save.isPending} onClick={onSave}>
            Save
          </Button>
        }
      />
      <p className="border-l-2 border-border pl-3 text-xs italic text-fg-muted">{t("fileNote.user")}</p>
      <Textarea
        aria-label="About you"
        placeholder="Nothing here yet"
        rows={6}
        className="max-h-96 overflow-y-auto"
        value={value}
        disabled={save.isPending}
        onChange={(event) => setDraft(event.currentTarget.value)}
      />
      <p className="px-1 text-xs text-fg-subtle">
        Free text every agent reads. Your own words here outrank agent instructions and remembered facts.
      </p>
      {conflict && (
        <p role="alert" className="text-xs text-danger">
          This changed elsewhere and was reloaded. Review it and make your edit again.
        </p>
      )}
    </section>
  );
}

function AppearanceSection() {
  const { theme, setPersistedTheme, persisted, saveFailed } = usePersistedTheme();
  return (
    <Group description={t("settings.appearanceHint")}>
      <Row label={t("settings.theme")} description={t("settings.themeHint")}>
        <SegmentedControl
          disabled={!persisted}
          items={[
            { value: "dark", label: t("settings.theme.dark") },
            { value: "light", label: t("settings.theme.light") },
            { value: "system", label: t("settings.theme.system") },
          ]}
          value={theme}
          onValueChange={(value) => {
            if (value === "dark" || value === "light" || value === "system") {
              setPersistedTheme(value);
            }
          }}
        />
      </Row>
      {saveFailed && (
        <p className="px-2.5 pb-2 text-xs text-danger">{t("common.error")}</p>
      )}
    </Group>
  );
}

function ConnectionSection() {
  const platform = usePlatform();
  const { serverUrl, onChangeServer } = useServerConnection();
  return (
    <Group description={t("settings.connectionHint")}>
      <Row label={t("settings.currentServer")}>
        <span className="font-mono text-xs text-fg-muted">{serverUrl}</span>
      </Row>
      {onChangeServer ? (
        <div className="flex items-center justify-between gap-4 rounded-md px-2.5 py-2">
          <span className="text-sm text-fg">{t("settings.switchServer")}</span>
          <Button variant="secondary" size="sm" onClick={onChangeServer}>
            {t("settings.switchServer")}
          </Button>
        </div>
      ) : null}
      {platform.launchAtLogin ? <LaunchAtLoginRow login={platform.launchAtLogin} /> : null}
    </Group>
  );
}

function LaunchAtLoginRow({ login }: { login: PlatformLoginItem }) {
  const [enabled, setEnabled] = useState<boolean | undefined>(undefined);
  const [pending, setPending] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    setEnabled(undefined);
    void login.get().then(
      (value) => {
        if (live) setEnabled(value);
      },
      (error: unknown) => {
        if (live) setLoadError(error instanceof Error ? error.message : "Could not read the login setting.");
      },
    );
    return () => {
      live = false;
    };
  }, [login]);
  const error = loadError ?? saveError;
  return (
    <Row label={t("settings.launchAtLogin")} description={t("settings.launchHint")}>
      <span className="flex flex-col items-end gap-1">
        <Switch
          checked={enabled ?? false}
          disabled={enabled === undefined || pending}
          onCheckedChange={(checked) => {
            const previous = enabled;
            setSaveError(null);
            setEnabled(checked);
            setPending(true);
            void login.set(checked).then(
              (actual) => {
                setEnabled(actual);
                setPending(false);
              },
              (err: unknown) => {
                setEnabled(previous ?? false);
                setPending(false);
                setSaveError(err instanceof Error ? err.message : "Could not save the login setting.");
              },
            );
          }}
        />
        {error && <span className="text-xs text-danger">{error}</span>}
      </span>
    </Row>
  );
}

function AboutSection() {
  const platform = usePlatform();
  const { serverUrl } = useServerConnection();
  return (
    <Group description={t("settings.aboutHint")}>
      <Row label={t("app.name")}>
        <span className="text-sm text-fg-muted">
          {platform.isDesktop ? "Desktop app" : "Web client"}
        </span>
      </Row>
      <Row label={t("settings.currentServer")}>
        <span className="font-mono text-xs text-fg-muted">{serverUrl}</span>
      </Row>
    </Group>
  );
}
