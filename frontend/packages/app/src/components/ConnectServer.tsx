import { Button, Input, SecretField, ThemeProvider } from "@agent-desktop/ui";
import { useId, useState, type FormEvent } from "react";
import { JunoBean } from "./brand/JunoBean";
import { SCREEN_TITLE } from "./onboarding/Onboarding";
import {
  DEFAULT_API_TOKEN,
  DEFAULT_SERVER_URL,
  type ServerSettings,
} from "../lib/settingsStore";

export interface ConnectServerProps {
  /** Called with the chosen settings once the user connects. */
  onConnect: (settings: ServerSettings) => void;
  /** Prefill; defaults match a blank install so the page is usable without typing. */
  defaultServerUrl?: string;
  defaultApiToken?: string;
  /** Native onboarding discovers account mode only after registering the server origin. */
  authMode?: "discover" | "account" | "token";
}

function isValidServerUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * First-launch onboarding (E3): shown by the desktop shell when no server has been saved yet.
 * The server URL is registered before AccountGate discovers the authentication mode.
 * Prefilled with the local defaults; the user can point at any self-hosted server. Shared so the
 * web build can adopt the same screen later.
 */
export function ConnectServer({
  onConnect,
  defaultServerUrl = DEFAULT_SERVER_URL,
  defaultApiToken = DEFAULT_API_TOKEN,
  authMode = "token",
}: ConnectServerProps) {
  const [serverUrl, setServerUrl] = useState(defaultServerUrl);
  const [apiToken, setApiToken] = useState(defaultApiToken);
  const [showToken, setShowToken] = useState(authMode === "token");
  const [touched, setTouched] = useState(false);

  const urlId = useId();
  const errorId = useId();
  const valid = isValidServerUrl(serverUrl.trim());
  const showError = touched && !valid;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setTouched(true);
    if (!valid) return;
    onConnect({ serverUrl: serverUrl.trim(), apiToken: apiToken.trim() });
  };

  return (
    <ThemeProvider defaultTheme="dark">
    <main className="flex min-h-dvh w-full items-center justify-center bg-background px-6 py-10 text-fg">
      <div className="flex w-full max-w-[560px] flex-col items-center">
        <JunoBean height={72} />
        <h1 className={`mt-6 text-center ${SCREEN_TITLE}`}>Connect to your Juno server</h1>
        <p className="mt-3 mb-8 max-w-[420px] text-center text-base leading-relaxed text-fg-muted">Sync your agents with your phone. Use the address of your Juno server.</p>
        <div className="w-full max-w-[360px]">
          <form
            onSubmit={submit}
            noValidate
            className="space-y-4 rounded-2xl bg-surface p-5 ring-1 ring-border"
          >
            <div className="space-y-1.5">
              <label htmlFor={urlId} className="text-sm font-medium text-fg">
                Server URL
              </label>
              <Input
                id={urlId}
                value={serverUrl}
                onChange={(event) => setServerUrl(event.currentTarget.value)}
                onBlur={() => setTouched(true)}
                placeholder={DEFAULT_SERVER_URL}
                className="font-mono"
                inputMode="url"
                autoComplete="url"
                spellCheck={false}
                aria-invalid={showError}
                aria-describedby={showError ? errorId : undefined}
                autoFocus
              />
              {showError && (
                <p id={errorId} role="alert" className="text-xs text-danger">
                  Enter an http:// or https:// URL.
                </p>
              )}
            </div>

            {authMode !== "account" && !showToken ? <button type="button" className="text-xs text-fg-muted underline" onClick={() => setShowToken(true)}>Use an API token (legacy server)</button> : null}
            {authMode !== "account" && showToken ? <SecretField
              label="API token"
              placeholder="Paste your server token"
              value={apiToken}
              onChange={setApiToken}
            /> : null}

            <Button type="submit" variant="primary" size="lg" className="w-full">
              Connect
            </Button>

            {authMode === "token" ? <p className="text-center text-xs text-fg-subtle">
              The local default is <span className="font-mono">127.0.0.1:8787</span> with token{" "}
              <span className="font-mono">dev-token</span>.
            </p> : <p className="text-center text-xs text-fg-subtle">You sign in or create your account next.</p>}
          </form>
        </div>

      </div>
    </main>
    </ThemeProvider>
  );
}
