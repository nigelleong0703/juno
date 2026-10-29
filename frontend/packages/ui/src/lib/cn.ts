/**
 * Back-compat entry point. The implementation lives in `./utils` (the path the
 * shadcn registry expects); everything in this package can keep importing
 * `../lib/cn`.
 */
export { cn } from "./utils";
