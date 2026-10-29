# Pinned upstream browser decision core

Source: https://github.com/Ying-Kai-Liao/jev-browser
Commit: `74592bac3fa78407ea1571b8233ead8540d531f3` (MIT; see LICENSE).

`core.mjs` extracts ten original class methods and their pure helper declarations from
`src/session.mjs`. Methods are verbatim, with original questions, grouping, thresholds,
completion checks and stop conditions. `page-model.mjs` and `prune.mjs` are verbatim
copies. `core.d.mts` supplies handwritten adapter types. This is an extraction, not a
complete copy of the upstream browser or MCP server.

Run `node scripts/verify/jev-browser-vendor.mjs /path/to/upstream-checkout` to compare
method hashes and original source. Without an argument it checks method and page-script hashes.

Juno's `upstream-browser.ts` supplies observation, inference and action hooks through
existing canonical tools. It does not launch a browser or load upstream credentials.
The System One port preserves structured native state and upstream null option
descriptions. The JSON encoding option is explicit; existing plain-text callers are unchanged. No decision algorithm is replaced by a Juno implementation.

The Chrome helper now runs upstream ENUMERATE verbatim and binds its DOM nodes to
Juno's document-scoped refs. The original SCROLL_BOX_MAIN/SCROLL_BOX_OF/SCROLL_OFFSET
functions are also pinned verbatim; the original 80% wheel step and landing loop use
CDP input through Juno's canonical browser.scroll. These scripts are shipped with the
helper and license; the model cannot submit JavaScript. A missing updated helper fails
explicitly rather than silently substituting an accessibility-only page.

Juno returns a bounded rendering of the last observed page at goal handoff, including
canonical-ref/read-only hints and metrics. It also feeds factual wheel displacement
through the upstream action.result hook and adds observed readonly DOM attributes.
These are observation/transport additions. Juno now also enforces a separate declared
completion contract outside the upstream loop. Exact observed label/text/placeholder/name
conditions check count/value/checked/expanded/disabled on a fresh DOM snapshot. A pending
contract is persisted before inference/effects, bound to the observed tab and owner/run,
and blocks subsequent goal/navigation calls. Recovery preserves the original predicates;
abandonment stays unverified and ends browser mutations for that run. The canonical run
completion gate also refuses completion over an unresolved browser contract. These checks
do not change upstream status, probabilities, thresholds or action selection. They verify
only the declared predicates, not completeness of the caller's natural-language intent.

Known editable strings can use Juno's direct batch fill without Jev. Optional write
uses the existing fast-model resolver to draft from supplied facts and validates exact
field references before canonical fill. This route is outside the upstream decision
loop and does not override a Jev-selected action. There is no target Jev action ratio.

Current adapter limitations:

- Frame traversal follows the existing helper's frame/session limits; skipped frames
  are reported in metrics. The ordinary model snapshot remains bounded, while the
  upstream decision receives the complete collected DOM controls.
- Click, type and scroll effects are mapped. Other upstream actions have no canonical
  mapping yet. Page WebMCP is unavailable.
- Read blocks come from canonical get_text paragraph splitting, not upstream DOM blocks.
- Readiness remains the existing Chrome helper's responsibility.
- Secrets use Juno's secure input; permissions, suspension and cancellation remain in
  the canonical dispatcher. Upstream irreversible permission is not enabled here.
- Native billing is not exposed by the port; the upstream token counter is unavailable
  (zero), not evidence of free inference. Verification logs capture endpoint usage.

Enable only with `BROWSER_GOAL_INTERFACE=1` plus native System One configuration.
Ordinary browser tools remain the single-model path. Shared service defaults are not
changed by this implementation. This extraction alone establishes neither equivalent
browser coverage nor a speed/cost advantage over the existing implementation.
