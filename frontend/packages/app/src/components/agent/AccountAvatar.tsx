/**
 * Account avatar (owner feedback 2026-10-06, corrected against the HOVER reference): the
 * signed-in owner's resting presence in the sidebar footer — a neutral circle that stays
 * visible at rest, independent of the row hover, and SMALLER than the plus hover box.
 * Reference ratio is account/plus = 56/68 raw = 0.82, so the circle is 32px against the 40px
 * plus box (32/40 = 0.8). `bg-fg/10` lands on ~#2b2b2b over the #141414 sidebar without a
 * hover-only surface or a high-contrast colored icon; 12px medium-weight muted initials stay
 * legible grey, never bold white. Decorative: the parent button already carries the
 * accessible name (the signed-in user's name).
 */
export interface AccountAvatarProps {
  initials: string;
  /**
   * Diameter in px when it is not the 32px sidebar size. This is also the person avatar of the People pages (2026-10-27:
   * 44 in the list, 88 on a person's page): the same neutral initials circle, the initials scaling with it.
   */
  size?: number;
}

export function AccountAvatar({ initials, size }: AccountAvatarProps) {
  return (
    <span
      data-slot="account-avatar"
      aria-hidden="true"
      className="flex size-8 shrink-0 items-center justify-center rounded-full bg-fg/10 text-xs font-medium text-fg-muted"
      style={size === undefined ? undefined : { width: size, height: size, fontSize: Math.round(size * 0.38) }}
    >
      {initials}
    </span>
  );
}
