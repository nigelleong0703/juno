// The scenario clock: preloaded (node --import) into the e2e stack's agentd processes when E2E_CLOCK_FILE is set. `new Date()` and
// `Date.now()` answer real time plus the milliseconds the file holds, so a case can let a "week" pass in minutes (harness `advanceClock`).
// Timers keep running on real time; only what the process reads as "now" moves, so a schedule item or timer due on the scenario's Thursday
// fires when the clock reaches it. The file is re-read every 200 ms.
import { readFileSync } from 'node:fs';

const file = process.env.E2E_CLOCK_FILE;
const RealDate = Date;
let offset = 0;
const refresh = () => {
  try {
    const value = Number(readFileSync(file, 'utf8'));
    if (Number.isFinite(value)) offset = value;
  } catch {
    // keep the last offset
  }
};

if (file) {
  refresh();
  setInterval(refresh, 200).unref();
  const now = () => RealDate.now() + offset;
  globalThis.Date = new Proxy(RealDate, {
    construct: (target, args, newTarget) => (args.length === 0 ? new target(now()) : Reflect.construct(target, args, newTarget)),
    apply: (target) => new target(now()).toString(),
    get: (target, prop, receiver) => (prop === 'now' ? now : Reflect.get(target, prop, receiver)),
  });
}
