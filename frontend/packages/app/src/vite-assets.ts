/**
 * Vite asset URL ambient declarations (PH12 visible).
 *
 * A real `.ts` module (not `.d.ts`-only) so bundlers and test runners always resolve the
 * side-effect import below to an actual file: it emits an empty runtime module while the
 * ambient `declare module` block types every `?url` worker import program-wide, including
 * across UI projects that compile PdfFilePreview through the import graph.
 */
declare module "*.mjs?url" {
  const url: string;
  export default url;
}
