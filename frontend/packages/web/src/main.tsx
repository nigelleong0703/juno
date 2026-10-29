import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import { AccountGate, ConnectServer, OnboardingView, onboardingFinish, markOnboardingSeen, shouldShowOnboarding, webPlatform, getServerSettings, hasSavedServerSettings, setServerSettings, type ServerSettings } from "@agent-desktop/app";
import { resolveWebServerSettings } from "./server-settings";
import "./index.css";

/**
 * Web entry point. It honours `?theme=dark|light` and renders the very same `<App>` the
 * desktop shell renders — only the client and platform adapter differ.
 */

const params = new URLSearchParams(window.location.search);
const themeParam = params.get("theme");
const theme = themeParam === "light" ? "light" : themeParam === "dark" ? "dark" : undefined;

if (theme) {
  try {
    window.localStorage.setItem("agent-desktop-theme", theme);
  } catch {
    /* localStorage unavailable — the ThemeProvider default still applies */
  }
}

const settings = resolveWebServerSettings(getServerSettings(), hasSavedServerSettings(), window.location.origin);

function WebRoot() {
  const [target, setTarget] = useState<ServerSettings | null>(settings);
  const [onboarding, setOnboarding] = useState(() => shouldShowOnboarding() && params.get("onboarding") !== "NO");
  if (onboarding) {
    const done = () => { markOnboardingSeen(); setOnboarding(false); };
    return <OnboardingView finish={onboardingFinish(false, done)} onSkip={done} />;
  }
  if (!target) return <ConnectServer authMode="discover" defaultServerUrl={settings.serverUrl} onConnect={(next) => { setServerSettings(next); setTarget(next); }} />;
  return <AccountGate settings={target} platform={webPlatform} theme={theme ?? "dark"} onChangeServer={() => setTarget(null)} />;
}

const container = document.getElementById("root");
if (!container) throw new Error("Root element #root not found");

/** The production bootstrap renders only the real `<App>`. */
createRoot(container).render(
  <StrictMode>
    <WebRoot />
  </StrictMode>,
);
