/** Words of a risky command or sentence, shared by the built-in rules (tool-policy.ts) and the decision brief, so they cannot drift apart. */

/**
 * Words of a purchase in the agent's own `confirm` sentence. Purchases are NOT matched in URLs or commands: opening
 * a shop or checkout page is browsing, and asking there popped an approval as soon as the user stated a need
 * (owner 2026-10-13). The final click is gated in browser.click instead (it demands a `confirm`, which asks here).
 */
export const PURCHASE = /\b(purchase|checkout|buy|pay|payment|place[-_ ]?((the|an?|my|your)[-_ ])?order|confirm[-_ ]?order)\b/i;
export const DELETE = /\brm\s+-\w*[rf]|\b(drop|truncate)\s+(table|database|schema)\b|\bdelete\s+(from|account|all|repo|database|bucket)\b|--delete\b/i;
export const INSTALL = /\b(curl|wget)\b[^\n|]*\|\s*(sudo\s+)?(ba|z|da)?sh\b|\b(apt|apt-get|yum|dnf|apk|brew|pip3?|gem|cargo)\s+(-\S+\s+)*install\b|\b(npm|pnpm|yarn)\s+(-\S+\s+)*(install|add|i)\b[^\n]*\s(-g|--global)\b/i;
/** A sentence of the agent that says something is removed for good (browser and screen actions carry no arguments to read). */
export const DELETE_SENTENCE = /\b(delete|remove|erase|permanently|cancel (your |the |this )?(subscription|account|order|membership))\b/i;
