import { errorCode } from "../../../data/model-providers";
import { t } from "../../../lib/i18n";

/** Specific copy for the backend's provider error codes; anything else gets one generic line. */
export function providerErrorMessage(error: unknown): string {
  const { code, status } = errorCode(error);
  if (status !== undefined && status >= 500) return t("models.error.server");
  const key = code === undefined ? undefined : `models.error.${code}`;
  const specific = key === undefined ? key : t(key);
  // `t` returns the key itself for an unknown code, which must never reach the screen.
  return specific !== undefined && specific !== key ? specific : t("models.error.generic");
}
