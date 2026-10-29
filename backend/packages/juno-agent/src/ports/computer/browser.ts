/**
 * Typed browser request/response schemas for one agent display.
 *
 * Package-owned pure seam: BrowserInput/Node/Result schemas only.
 * No helper paths, build commands, output parsing, ports, or providers.
 */
import { z } from 'zod';

/** Short tab handle (`t2`) from `tabs`/`new_tab`; omitted means the tab last acted on. */
const tab = z.string().min(1).max(16).optional();
const tabsInput = z.object({ action: z.literal('tabs') });
const newTabInput = z.object({ action: z.literal('new_tab'), url: z.string().min(1).optional() });
/** `follow`: the after-action snapshot shows the tab the action moved to (a popup it opened, or the opener of a popup that closed). */
const snapshotInput = z.object({ action: z.literal('snapshot'), tab, follow: z.literal(true).optional(), upstream: z.literal(true).optional() });
const scrollInput = z.object({ action: z.literal('scroll'), tab, ref: z.string().min(1).optional(), direction: z.enum(['up', 'down']).optional() });
const textInput = z.object({ action: z.literal('get_text'), tab });
const navigateInput = z.object({ action: z.literal('navigate'), url: z.string().min(1), tab });
// A ref (`e12`) already names its tab, frame and document, so click/type take no tab.
const clickInput = z.object({ action: z.literal('click'), ref: z.string().min(1) });
const typeInput = z.object({ action: z.literal('type'), ref: z.string().min(1), text: z.string().max(20_000) });
/** Read the native dialog open on a tab (no `accept`), or answer it; `text` fills a prompt(). */
const dialogInput = z.object({ action: z.literal('dialog'), tab, accept: z.boolean().optional(), text: z.string().max(2_000).optional() });
/**
 * The browser control under a screen point (the purchase gate on coordinate clicks), or without x/y the
 * focused control (what Enter would press). x/y are model coordinates, the pixels of the screenshot the
 * model saw; the adapter maps them to the framebuffer.
 */
const pointInput = z.object({ action: z.literal('point'), x: z.number().optional(), y: z.number().optional() });
/** Only what the browser reported since the agent last looked (dialogs, alerts, tabs); touches no page. */
const noticesInput = z.object({ action: z.literal('notices') });
/** Screen rects of these refs (brought into view), or without refs the visible tab's controls (read-only). */
const boundsInput = z.object({ action: z.literal('bounds'), refs: z.array(z.string().min(1)).min(1).max(20).optional() });
/** Form-control attributes (never values) of these refs: type, autocomplete, maxlength, required, min/max, select options. */
const attrsInput = z.object({ action: z.literal('attrs'), refs: z.array(z.string().min(1)).min(1).max(8) });
/** A value sealed to the sandbox key by the client (BACKEND 8.7): base64 ephemeral public key, 12-byte nonce, ciphertext + tag. */
export const sealedValueSchema = z.object({
  epk: z.string().min(1).max(64),
  nonce: z.string().min(1).max(32),
  ciphertext: z.string().min(1).max(2_800),
}).strict();
export type SealedValue = z.infer<typeof sealedValueSchema>;
/**
 * Type a secret into a ref. The input carries only ciphertext sealed to the sandbox's own key (`secure_key`); the
 * helper alone opens it, with the request id, field id and ref as AAD, and masks the page. Only the user's
 * secure-input submission builds this; no plaintext reaches any hop.
 */
const fillSecretInput = z.object({
  action: z.literal('fill_secret'),
  ref: z.string().min(1),
  requestId: z.string().min(1).max(128),
  fieldId: z.string().min(1).max(64),
  sealed: sealedValueSchema,
});
/** The sandbox's public key for end-to-end encrypted secure input (the private key never leaves the sandbox). */
const secureKeyInput = z.object({ action: z.literal('secure_key') });

export const browserInputSchema = z.discriminatedUnion('action', [
  tabsInput,
  newTabInput,
  snapshotInput,
  scrollInput,
  textInput,
  navigateInput,
  clickInput,
  typeInput,
  boundsInput,
  attrsInput,
  secureKeyInput,
  fillSecretInput,
  dialogInput,
  pointInput,
  noticesInput,
]);
export type BrowserInput = z.infer<typeof browserInputSchema>;

/** The helper writes heading lines without a role; they read as role `heading` (rendered `## Title`, never clickable). */
const withHeadingRole = (value: unknown): unknown =>
  typeof value === 'object' && value !== null && Reflect.get(value, 'role') === undefined && typeof Reflect.get(value, 'heading') === 'number'
    ? { ...value, role: 'heading' }
    : value;

export const browserNodeSchema = z.preprocess(withHeadingRole, z.object({
  /** Absent on a heading, which is context for the model and not something to act on. */
  ref: z.string().min(1).optional(),
  role: z.string().min(1),
  name: z.string(),
  disabled: z.boolean().optional(),
  /** Form state flags: checked, unchecked, mixed, selected, expanded, collapsed, pressed, required, invalid, readonly, focused. */
  state: z.array(z.string()).max(8).optional(),
  /** Current value of a non-secret text field (already truncated by the helper). */
  value: z.string().max(80).optional(),
  /** The question a radio/checkbox belongs to (its group or heading name). */
  group: z.string().max(80).optional(),
  /** Heading level (1-3) when this entry is a heading line. */
  heading: z.number().int().min(1).max(3).optional(),
  /** The prose under a heading (paragraph text up to the next heading, already capped by the helper). */
  text: z.string().max(400).optional(),
  /** Host of the cross-origin iframe the node is in (sign-in, payment fields); absent on the page itself. */
  site: z.string().optional(),
}));
export type BrowserNode = z.infer<typeof browserNodeSchema>;

/** Set when the browser had closed and was relaunched to serve this call; tabs may have reset. */
const restarted = z.literal(true).optional();
const tabHandle = z.string().min(1);
/** A native JS dialog open on a tab: the page is blocked until it is answered (browser.dialog). */
export const browserDialogSchema = z.object({
  tab: z.string(),
  type: z.enum(['alert', 'confirm', 'prompt', 'beforeunload']),
  message: z.string(),
  url: z.string().optional(),
  defaultPrompt: z.string().optional(),
});
export type BrowserDialog = z.infer<typeof browserDialogSchema>;
/**
 * What happened since the agent last looked, on any agent-facing result: the dialog blocking this tab,
 * alerts accepted automatically, tabs opened (popups, target=_blank) and closed (with their opener).
 */
const notices = {
  dialog: browserDialogSchema.optional(),
  alerts: z.array(z.object({ tab: z.string(), message: z.string() })).optional(),
  opened: z.array(z.object({ tab: z.string(), opener: z.string() })).optional(),
  closed: z.array(z.object({ tab: z.string(), opener: z.string() })).optional(),
};
const tabsResult = z.object({
  action: z.literal('tabs'), restarted,
  tabs: z.array(z.object({ tab: tabHandle, url: z.string(), title: z.string(), active: z.boolean(), dialog: browserDialogSchema.optional() })),
  ...notices,
});
/** Set when the page did not finish loading inside the helper's budget; it keeps loading in the tab. */
const loading = z.literal(true).optional();
const newTabResult = z.object({ action: z.literal('new_tab'), restarted, url: z.string(), title: z.string(), tab: tabHandle, loading, ...notices });
export const upstreamBrowserPageSchema = z.object({
  url: z.string(), title: z.string(), text: z.string(),
  metrics: z.record(z.string(), z.unknown()),
  elements: z.array(z.object({ i: z.number().int(), tag: z.string(), ref: z.string(), text: z.string().optional(), label: z.string().optional() }).passthrough()),
}).passthrough();
const scrollResult = z.object({ action: z.literal('scroll'), restarted, tab: tabHandle, url: z.string(), title: z.string(), scrolled: z.number(), ...notices });
const snapshotResult = z.object({
  action: z.literal('snapshot'), restarted,
  upstream: upstreamBrowserPageSchema.optional(),
  url: z.string(),
  title: z.string(),
  tab: tabHandle,
  nodes: z.array(browserNodeSchema).max(240),
  /** Cross-origin iframes on the page whose controls the snapshot cannot list. */
  crossOriginFrames: z.number().int().min(0),
  /** Controls left out on a busy page: the helper lists what is on screen and just below it first. */
  omitted: z.number().int().min(1).optional(),
  ...notices,
});
const textResult = z.object({
  action: z.literal('get_text'), restarted,
  url: z.string(),
  title: z.string(),
  tab: tabHandle,
  text: z.string().max(20_000),
  ...notices,
});
const navigateResult = z.object({ action: z.literal('navigate'), restarted, url: z.string(), title: z.string(), tab: tabHandle, loading, ...notices });
const clickResult = z.object({
  action: z.literal('click'), restarted,
  url: z.string(),
  title: z.string(),
  tab: tabHandle,
  clicked: z.literal(true),
  ...notices,
});
const typeResult = z.object({
  action: z.literal('type'), restarted,
  url: z.string(),
  title: z.string(),
  tab: tabHandle,
  typed: z.literal(true),
  ...notices,
});

/** A rect in the screen's framebuffer pixels (VNC stream coordinates). */
const rect = z.object({ x: z.number().int().min(0), y: z.number().int().min(0), width: z.number().int().min(1), height: z.number().int().min(1) });
const boundsResult = z.object({
  action: z.literal('bounds'), restarted,
  url: z.string(),
  title: z.string(),
  tab: tabHandle,
  elements: z.array(z.object({ ref: z.string().optional(), rect, role: z.string(), name: z.string() })).max(300),
});
/** What the page says about one control; everything but `ref` and `tag` is present only when the page sets it. */
export const browserFieldAttrsSchema = z.object({
  ref: z.string(),
  tag: z.string(),
  /** The `type` attribute (an `<input>` without one reads as "text"). */
  type: z.string().optional(),
  autocomplete: z.string().optional(),
  id: z.string().optional(),
  name: z.string().optional(),
  placeholder: z.string().optional(),
  inputmode: z.string().optional(),
  pattern: z.string().optional(),
  /** Text of the associated `<label>` or the aria-label. */
  label: z.string().optional(),
  maxLength: z.number().optional(),
  min: z.number().optional(),
  max: z.number().optional(),
  step: z.number().optional(),
  /** True from `required` or aria-required="true"; false from aria-required="false"; absent when the page says nothing. */
  required: z.boolean().optional(),
  /** `<select>` option values (or texts), at most 100. */
  options: z.array(z.string()).optional(),
});
export type BrowserFieldAttrs = z.infer<typeof browserFieldAttrsSchema>;
const attrsResult = z.object({
  action: z.literal('attrs'), restarted,
  url: z.string(),
  title: z.string(),
  tab: tabHandle,
  fields: z.array(browserFieldAttrsSchema).max(8),
});
const secureKeyResult = z.object({
  action: z.literal('secure_key'), restarted,
  alg: z.literal('X25519-HKDF-SHA256-AES256GCM'),
  /** Names the sandbox key (first 8 bytes of sha256 of the public key, hex). */
  keyId: z.string().min(1).max(64),
  /** Raw 32-byte X25519 public key, base64. */
  publicKey: z.string().min(1).max(64),
});
const fillSecretResult = z.object({
  action: z.literal('fill_secret'), restarted,
  url: z.string(),
  title: z.string(),
  tab: tabHandle,
  filled: z.literal(true),
});

const dialogResult = z.object({
  action: z.literal('dialog'), restarted,
  url: z.string(),
  title: z.string(),
  tab: tabHandle,
  /** The dialog the call answered (with `accepted`); absent on a read. */
  handled: browserDialogSchema.extend({ accepted: z.boolean() }).optional(),
  ...notices,
});
const noticesResult = z.object({ action: z.literal('notices'), restarted, ...notices });
const pointResult = z.object({
  action: z.literal('point'), restarted,
  url: z.string(),
  title: z.string(),
  tab: z.string(),
  /** The control a click there would hit; absent outside the page or on no control. */
  element: z.object({ role: z.string(), name: z.string() }).optional(),
  /** Without a point, when the focused control is a text field of a form: the form's submit button, which Enter in the field presses. */
  submit: z.object({ role: z.string(), name: z.string() }).optional(),
  /** A dialog open on a tab: a click may answer it. */
  dialog: browserDialogSchema.optional(),
});

export const browserResultSchema = z.discriminatedUnion('action', [
  tabsResult,
  newTabResult,
  snapshotResult,
  scrollResult,
  textResult,
  navigateResult,
  clickResult,
  typeResult,
  boundsResult,
  attrsResult,
  secureKeyResult,
  fillSecretResult,
  dialogResult,
  pointResult,
  noticesResult,
]);
export type BrowserResult = z.infer<typeof browserResultSchema>;

export function parseBrowserInput(value: unknown): BrowserInput {
  return browserInputSchema.parse(value);
}

export function parseBrowserResult(value: unknown): BrowserResult {
  return browserResultSchema.parse(value);
}
