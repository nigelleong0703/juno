/** Small shared helpers for the built-in tools. */

export const newId = (prefix: string): string => `${prefix}_${Math.random().toString(36).slice(2, 10)}`;

export const nowIso = (): string => new Date().toISOString();
