import { validateUiAnswers, type UiChoicesBlock, type UiDoc, type UiField, type UiFieldsBlock } from "@agent-desktop/client";
import { ActionCardButtons, Input, cn } from "@agent-desktop/ui";
import { Check } from "lucide-react";
import { useState } from "react";
import { t } from "../../lib/i18n";
import { parseChoiceIds } from "./answers";
import type { UiDocAnswering } from "./UiDoc";

const OPTION_BASE = "flex w-full items-center gap-3 rounded-[20px] px-4 py-3 text-left text-base leading-[21px] tracking-[-0.01em] transition-colors focus-ring disabled:opacity-60";
const OPTION_TONE = {
  default: "bg-[#f4f4f4] hover:bg-[#ececec] dark:bg-[#242424] dark:hover:bg-[#2c2c2c]",
  primary: "bg-[#070707] text-[#fcfcfc] hover:bg-[#2f2f2f] dark:bg-[#fafafa] dark:text-[#070707] dark:hover:bg-[#d5d5d5]",
  destructive: "bg-[#f4f4f4] text-danger hover:bg-[#ececec] dark:bg-[#242424] dark:hover:bg-[#2c2c2c]",
} as const;

/** Pick one (a tap answers at once) or several (toggles, then Submit). */
export function ChoicesBlock({ block, answering }: { block: UiChoicesBlock; answering: UiDocAnswering }) {
  const multiple = block.multiple === true;
  const recorded = answering.readOnly === true;
  const [picked, setPicked] = useState<string[]>(() => parseChoiceIds(answering.answers?.[block.id], multiple));
  const error = answering.errors?.[block.id];
  const toggle = (id: string) => setPicked((current) => (current.includes(id) ? current.filter((x) => x !== id) : [...current, id]));
  const tap = (id: string) => {
    if (recorded || answering.disabled) return;
    if (multiple) return toggle(id);
    setPicked([id]);
    answering.onAnswer({ [block.id]: id });
  };
  return (
    <div className="flex flex-col gap-2">
      <div role={multiple ? "group" : "radiogroup"} className="flex flex-col gap-2">
        {block.options.map((option) => {
          const on = picked.includes(option.id);
          const style = on && !recorded && multiple ? "default" : (option.style ?? "default");
          return (
            <button
              key={option.id}
              type="button"
              role={multiple ? "checkbox" : "radio"}
              aria-checked={on}
              disabled={answering.disabled || (recorded && !on)}
              onClick={() => tap(option.id)}
              className={cn(OPTION_BASE, OPTION_TONE[style], on && "shadow-[inset_0_0_0_1.5px_#070707] dark:shadow-[inset_0_0_0_1.5px_#fafafa]")}
            >
              <span className="min-w-0 flex-1">
                <span className={cn("block", on && "font-semibold")}>{option.label}</span>
                {option.description ? <span className={cn("block text-[13px] leading-[18px] tracking-normal", style === "primary" ? "opacity-70" : "text-foreground/60")}>{option.description}</span> : null}
              </span>
              {on ? <Check className="size-[18px] shrink-0" strokeWidth={2.5} /> : null}
            </button>
          );
        })}
      </div>
      {error ? <p role="alert" className="px-1 text-[13px] text-danger">{error}</p> : null}
      {multiple && !recorded ? (
        <ActionCardButtons
          className="mt-1"
          primary={{ label: t("request.submit"), disabled: answering.disabled || picked.length === 0, onClick: () => answering.onAnswer({ [block.id]: JSON.stringify(block.options.map((o) => o.id).filter((id) => picked.includes(id))) }) }}
        />
      ) : null}
    </div>
  );
}

const INPUT = "h-[38px] w-full rounded-full border-0 bg-[#f4f4f4] px-4 text-sm dark:bg-[#242424]";

function FieldInput({ field, value, readOnly, onChange }: { field: UiField; value: string; readOnly: boolean; onChange: (value: string) => void }) {
  const placeholder = field.placeholder ?? (field.required === false ? t("common.optional") : undefined);
  if (field.kind === "select") {
    return (
      <select value={value} disabled={readOnly} onChange={(event) => onChange(event.currentTarget.value)} aria-label={field.label} className={cn(INPUT, "focus-ring")}>
        <option value="">{placeholder ?? t("uidoc.choose")}</option>
        {(field.options ?? []).map((option) => (
          <option key={option} value={option}>{option}</option>
        ))}
      </select>
    );
  }
  return (
    <Input
      type={field.kind === "date" ? "date" : "text"}
      inputMode={field.kind === "number" ? "decimal" : undefined}
      value={value}
      readOnly={readOnly}
      onChange={(event) => onChange(event.currentTarget.value)}
      placeholder={placeholder}
      aria-label={field.label}
      className={INPUT}
    />
  );
}

/** A small form: text / number / date / select, validated with the contract's own rules, server reasons per field. */
export function FieldsBlock({ doc, block, answering }: { doc: UiDoc; block: UiFieldsBlock; answering: UiDocAnswering }) {
  const recorded = answering.readOnly === true;
  const [values, setValues] = useState<Record<string, string>>(() => ({ ...answering.answers }));
  const [shown, setShown] = useState(false);
  const [serverErrors, setServerErrors] = useState<Record<string, string> | undefined>(answering.errors);
  const [seenErrors, setSeenErrors] = useState(answering.errors);
  if (answering.errors !== seenErrors) {
    setSeenErrors(answering.errors);
    setServerErrors(answering.errors);
  }
  const checked = validateUiAnswers(doc, values);
  const problems = "errors" in checked ? checked.errors : {};
  const set = (id: string, value: string) => {
    setValues((current) => ({ ...current, [id]: value }));
    setServerErrors((current) => (current && id in current ? Object.fromEntries(Object.entries(current).filter(([key]) => key !== id)) : current));
  };
  const submit = () => {
    if (Object.keys(problems).length > 0) return setShown(true);
    answering.onAnswer(Object.fromEntries(Object.entries(values).map(([id, value]) => [id, value.trim()]).filter(([, value]) => value !== "")));
  };
  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        if (!recorded && answering.disabled !== true) submit();
      }}
    >
      {block.fields.map((field) => {
        const message = serverErrors?.[field.id] ?? (shown ? problems[field.id] : undefined);
        return (
          <label key={field.id} className="flex flex-col gap-1.5 px-1">
            <span className="text-sm leading-5">
              {field.label}
              {field.required === false ? <span className="text-foreground/50"> · {t("common.optional")}</span> : null}
            </span>
            <FieldInput field={field} value={values[field.id] ?? ""} readOnly={recorded || answering.disabled === true} onChange={(value) => set(field.id, value)} />
            {message ? <span role="alert" className="text-[13px] text-danger">{message}</span> : null}
          </label>
        );
      })}
      {recorded ? null : (
        <ActionCardButtons className="mt-1" primary={{ label: t("request.submit"), disabled: answering.disabled, onClick: submit }} />
      )}
    </form>
  );
}
