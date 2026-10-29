// Minimal ambient declarations for the few host globals the client package uses.
//
// This package deliberately compiles with `lib: ["ES2023"]` and `types: []` (no DOM, no Node),
// so `setTimeout` & friends are not in scope. The mock's live simulation only needs timers at
// runtime; these declarations describe exactly what we rely on and nothing more.

declare function setTimeout(
  handler: (...args: unknown[]) => void,
  timeout?: number,
  ...args: unknown[]
): unknown;

declare function clearTimeout(handle: unknown): void;

declare function setInterval(
  handler: (...args: unknown[]) => void,
  timeout?: number,
  ...args: unknown[]
): unknown;

declare function clearInterval(handle: unknown): void;

declare function queueMicrotask(callback: () => void): void;
