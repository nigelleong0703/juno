/** Shared credential redaction used by tool projections and durable recovery records. */
const CREDENTIAL_PATTERNS = [
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi,
  /\bsk-[A-Za-z0-9._-]{8,}/gi,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/gi,
];
const LABELED_SECRET = /\b(password|passwd|passcode|secret|token|api[ _-]?key|access[ _-]?key|authorization)\b([ \t]*[:=][ \t]*|[ \t]+)([^\s,;]+)/gi;

export function redactText(text: string): string {
  let current = text;
  for (const pattern of CREDENTIAL_PATTERNS) current = current.replace(pattern, '[redacted]');
  return current.replace(LABELED_SECRET, '$1$2[redacted]');
}
