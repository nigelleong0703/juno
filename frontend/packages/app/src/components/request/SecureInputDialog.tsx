import { validateSecureInputValues, type SecureInputField, type SecureInputResult } from "@agent-desktop/client";
import { Button, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, Input, Label } from "@agent-desktop/ui";
import { Lock } from "lucide-react";
import { useState, type FormEvent } from "react";
import { t } from "../../lib/i18n";

const INPUT: Record<SecureInputField["kind"], { type: "password" | "text"; mode?: "numeric"; autoComplete: string; placeholder?: string }> = {
  password: { type: "password", autoComplete: "off" },
  card_number: { type: "text", mode: "numeric", autoComplete: "off", placeholder: "1234 5678 9012 3456" },
  card_expiry: { type: "text", mode: "numeric", autoComplete: "off", placeholder: "MM / YY" },
  card_cvc: { type: "password", mode: "numeric", autoComplete: "off", placeholder: "•••" },
  otp: { type: "text", mode: "numeric", autoComplete: "one-time-code", placeholder: "123456" },
  text: { type: "text", autoComplete: "off" },
  name: { type: "text", autoComplete: "name" },
  email: { type: "text", autoComplete: "email" },
  phone: { type: "text", autoComplete: "tel" },
  address: { type: "text", autoComplete: "street-address" },
  city: { type: "text", autoComplete: "address-level2" },
  country: { type: "text", autoComplete: "country-name" },
  postal_code: { type: "text", autoComplete: "postal-code" },
  month: { type: "text", mode: "numeric", autoComplete: "off", placeholder: "MM" },
  year: { type: "text", mode: "numeric", autoComplete: "off", placeholder: "YYYY" },
  date: { type: "text", autoComplete: "off", placeholder: "YYYY-MM-DD" },
  number: { type: "text", mode: "numeric", autoComplete: "off" },
};

export interface SecureInputDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  site: string;
  fields: SecureInputField[];
  /** Sends the values; they are not kept here after this call starts. */
  onSubmit: (values: Record<string, string>) => Promise<SecureInputResult>;
}

/** The one quiet line that says where the typed values go. */
export function EncryptionNote({ className }: { className?: string }) {
  return <p className={`flex items-center gap-1.5 text-[13px] text-foreground/60 ${className ?? ""}`}><Lock className="size-3.5 shrink-0" />{t("request.secure.encrypted")}</p>;
}

/** What the user is told when the submit failed; never includes anything they typed. */
function failureText(error: unknown): string {
  const code = typeof error === "object" && error !== null && "code" in error ? String((error as { code: unknown }).code) : "";
  if (code === "ENCRYPTION_UNAVAILABLE") return t("request.secure.olderComputer");
  return code === "USER_CONTROL" ? t("request.secure.userControl") : t("request.secure.failed");
}

/**
 * The native-looking secure form: one masked input per field. The typed values live only in this
 * component's state until the submit starts, and are cleared the moment it does, so nothing a user
 * typed outlives the click (not in a query cache, not in a mutation, not after an error).
 */
export function SecureInputDialog({ open, onOpenChange, site, fields, onSubmit }: SecureInputDialogProps) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const ready = fields.every((field) => field.required === false || (values[field.id] ?? "").length > 0);

  const close = (next: boolean) => {
    if (busy) return;
    setValues({});
    setMessage(null);
    setErrors({});
    onOpenChange(next);
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!ready || busy) return;
    const checked = validateSecureInputValues(fields, values);
    if (!("ok" in checked)) {
      setErrors(checked.errors);
      return;
    }
    setErrors({});
    const payload = values;
    setValues({});
    setBusy(true);
    setMessage(null);
    try {
      const result = await onSubmit(payload);
      const failed = result.fields.filter((field) => field.status === "failed");
      if (failed.length > 0) {
        const labels = failed.map((entry) => fields.find((field) => field.id === entry.id)?.label ?? entry.id).join(", ");
        setMessage(t("request.secure.fieldsFailed", { fields: labels }));
      } else onOpenChange(false);
    } catch (error) {
      setMessage(failureText(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="max-w-[420px] rounded-[28px]">
        <form onSubmit={(event) => void submit(event)} autoComplete="off" className="flex flex-col gap-4">
          <DialogHeader>
            <DialogTitle>{fields.map((field) => field.label).join(", ")}</DialogTitle>
            <DialogDescription>{t("request.secure.sentTo", { site })}</DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-2.5">
            {fields.map((field) => {
              const spec = INPUT[field.kind];
              return (
                <div key={field.id} className="flex flex-col gap-1 rounded-2xl bg-[#f4f4f4] px-4 py-2 dark:bg-[#242424]">
                  <Label htmlFor={`secure-${field.id}`} className="text-xs font-normal text-foreground/60">{field.label}</Label>
                  <Input
                    id={`secure-${field.id}`}
                    type={spec.type}
                    inputMode={spec.mode}
                    autoComplete={spec.autoComplete}
                    placeholder={spec.placeholder}
                    value={values[field.id] ?? ""}
                    disabled={busy}
                    maxLength={512}
                    onChange={(event) => {
                      const next = event.currentTarget.value;
                      setValues((prev) => ({ ...prev, [field.id]: next }));
                      setErrors(({ [field.id]: _cleared, ...rest }) => rest);
                    }}
                    aria-invalid={errors[field.id] ? true : undefined}
                    className="h-6 border-0 bg-transparent p-0 text-base shadow-none focus-visible:ring-0"
                  />
                  {errors[field.id] ? <p role="alert" className="text-xs text-danger">{errors[field.id]}</p> : null}
                </div>
              );
            })}
          </div>
          {message ? <p role="alert" className="text-sm text-danger">{message}</p> : null}
          <EncryptionNote className="justify-center" />
          <DialogFooter className="sm:justify-stretch">
            <Button type="submit" disabled={!ready || busy} className="h-[38px] w-full rounded-full">{t("request.enterSecurely")}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
