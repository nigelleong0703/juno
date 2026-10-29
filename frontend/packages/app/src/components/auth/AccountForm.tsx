import { useId, useState, type FormEvent } from "react";
import { Button, Input } from "@agent-desktop/ui";
import { Eye, EyeOff } from "lucide-react";
import { SCREEN_TITLE } from "../onboarding/Onboarding";
import "./auth.css";

export interface AccountFormProps {
  message?: string;
  authenticate: (values: { name?: string; email: string; password: string }) => Promise<void>;
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Could not connect to the authentication server.";
}

/**
 * AL1 account form (presentation only). The auth lifecycle — modes, transport,
 * sessions — stays in AccountGate. Email is controlled here so it survives the
 * sign-in/sign-up switch; the password is always cleared on mode change and
 * on failure. The visibility toggle only flips the local input type.
 */
export function AccountForm({ message, authenticate }: AccountFormProps) {
  const [register, setRegister] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const passwordId = useId();

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(undefined);
    try {
      await authenticate({ email: email.trim(), password, ...(register ? { name: name.trim() } : {}) });
    } catch (error) {
      setError(errorMessage(error));
    } finally {
      setPassword("");
      setShowPassword(false);
      setBusy(false);
    }
  };

  const switchMode = () => {
    if (busy) return;
    setRegister((value) => !value);
    setError(undefined);
    setName("");
    setPassword("");
    setShowPassword(false);
  };

  const feedback = error ?? message;
  return (
    <div className="al1-formwrap">
      <div className="al1-heading al1-enter">
        <h1 className={SCREEN_TITLE}>{register ? "Create your account" : "Sign in to Juno"}</h1>
        <p className="mt-3 text-base text-fg-muted">Your agents and conversations belong to your account.</p>
      </div>
      <form onSubmit={submit} aria-busy={busy} className="al1-form al1-enter al1-d1">
        <fieldset disabled={busy} className="al1-fields">
          <div className="al1-namefield" data-open={register ? "true" : "false"} aria-hidden={register ? undefined : true} inert={!register}>
            <div className="al1-namefield-inner">
              <label className="al1-label">Name<Input name="name" required={register} disabled={!register || busy} tabIndex={register ? undefined : -1} autoComplete="name" maxLength={200} value={name} onChange={(event) => setName(event.currentTarget.value)} /></label>
            </div>
          </div>
          <label className="al1-label">Email<Input name="email" type="email" required autoComplete="email" spellCheck={false} value={email} onChange={(event) => setEmail(event.currentTarget.value)} /></label>
          <div className="al1-label">
            <label htmlFor={passwordId}>Password</label>
            <span className="al1-password">
              <Input id={passwordId} name="password" type={showPassword ? "text" : "password"} required minLength={register ? 8 : undefined} autoComplete={register ? "new-password" : "current-password"} value={password} onChange={(event) => setPassword(event.currentTarget.value)} />
              <button
                type="button"
                className="al1-show"
                aria-label={showPassword ? "Hide password" : "Show password"}
                aria-pressed={showPassword}
                disabled={busy}
                onClick={() => setShowPassword((value) => !value)}
              >
                {showPassword ? <EyeOff size={16} aria-hidden="true" /> : <Eye size={16} aria-hidden="true" />}
              </button>
            </span>
          </div>
          {feedback ? <p role="alert" key={feedback} className="al1-error text-sm text-danger">{feedback}</p> : null}
          <Button type="submit" variant="primary" size="lg" className="al1-submit w-full">{busy ? <span className="al1-submit-busy"><span className="al1-spinner" aria-hidden="true" />Please wait…</span> : register ? "Create account" : "Sign in"}</Button>
          <button type="button" disabled={busy} className="al1-switch text-sm text-fg-muted underline underline-offset-4" onClick={switchMode}>{register ? "Already have an account? Sign in" : "Create an account"}</button>
        </fieldset>
      </form>
    </div>
  );
}
