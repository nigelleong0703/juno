import { cn } from "@agent-desktop/ui";
import type { AvatarCharacter } from "@agent-desktop/client";
import { CHARACTERS } from "../../characters";
import { CharacterAvatar } from "../../components/agent/CharacterAvatar";
import { t } from "../../lib/i18n";

const CHOICES: ReadonlyArray<{ character: AvatarCharacter; label: string }> = [
  { character: "mint", label: "Mint" },
  { character: "blue", label: "Blue" },
  { character: "purple", label: "Purple" },
  { character: "pink", label: "Pink" },
  { character: "star", label: "Star" },
  { character: "bean", label: "Bean" },
];

/** Pick one of the six characters (the iPhone's AvatarCharacterPicker); saving is the caller's form. */
export function AvatarCharacterPicker({ value, onChange, disabled }: { value: AvatarCharacter; onChange: (character: AvatarCharacter) => void; disabled?: boolean }) {
  return (
    <div role="radiogroup" aria-label={t("agentEdit.character")} className="grid grid-cols-3 gap-2 sm:grid-cols-6">
      {CHOICES.map(({ character, label }) => {
        const selected = value === character;
        return (
          <button
            key={character}
            type="button"
            role="radio"
            aria-checked={selected}
            aria-label={label}
            disabled={disabled}
            onClick={() => onChange(character)}
            className={cn(
              "flex flex-col items-center gap-1.5 rounded-xl border py-2.5 text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60",
              selected ? "border-fg bg-muted font-medium text-fg" : "border-border text-fg-muted hover:bg-muted",
            )}
          >
            <CharacterAvatar sprite={CHARACTERS[character]} px={48} clip={null} />
            {label}
          </button>
        );
      })}
    </div>
  );
}
