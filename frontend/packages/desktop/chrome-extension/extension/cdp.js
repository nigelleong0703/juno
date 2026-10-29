/* global chrome */

const DEBUGGER_VERSION = "1.3";
const attached = new Set();
const INTERACTIVE = new Set([
  "button",
  "link",
  "textbox",
  "searchbox",
  "checkbox",
  "radio",
  "combobox",
  "listbox",
  "option",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "tab",
  "switch",
  "slider",
  "spinbutton",
  "treeitem",
  "gridcell",
]);
const STATE_NAMES = new Set([
  "checked",
  "selected",
  "expanded",
  "pressed",
  "required",
  "invalid",
  "readonly",
  "focused",
  "disabled",
]);

export class BrowserCommandError extends Error {
  constructor(code, message, outcome = "not_dispatched") {
    super(message);
    this.name = "BrowserCommandError";
    this.code = code;
    this.outcome = outcome;
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function isSafeWebUrl(value) {
  if (typeof value !== "string" || value.length === 0 || value.length > 8192) return false;
  try {
    const url = new URL(value);
    return (url.protocol === "http:" || url.protocol === "https:") && !url.username && !url.password;
  } catch {
    return false;
  }
}

function debuggerAttach(tabId) {
  return new Promise((resolve, reject) => {
    chrome.debugger.attach({ tabId }, DEBUGGER_VERSION, () => {
      const error = chrome.runtime.lastError;
      if (error) reject(new BrowserCommandError("DEBUGGER_ATTACH_FAILED", error.message));
      else resolve();
    });
  });
}

export function send(tabId, method, params = {}, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new BrowserCommandError("CDP_TIMEOUT", `CDP ${method} timed out after ${timeoutMs}ms`, "unknown"));
    }, timeoutMs);
    chrome.debugger.sendCommand({ tabId }, method, params, (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const error = chrome.runtime.lastError;
      if (error) reject(new BrowserCommandError("CDP_COMMAND_FAILED", `${method}: ${error.message}`));
      else resolve(result);
    });
  });
}

export async function ensureAttached(tabId) {
  if (attached.has(tabId)) return;
  await debuggerAttach(tabId);
  attached.add(tabId);
  await Promise.all([
    send(tabId, "DOM.enable").catch(() => undefined),
    send(tabId, "Accessibility.enable").catch(() => undefined),
    send(tabId, "Page.enable").catch(() => undefined),
    send(tabId, "Page.setLifecycleEventsEnabled", { enabled: true }).catch(() => undefined),
  ]);
}

export function detachTab(tabId) {
  if (!attached.delete(tabId)) return;
  chrome.debugger.detach({ tabId }, () => void chrome.runtime.lastError);
}

export function detachAll() {
  for (const tabId of [...attached]) detachTab(tabId);
}

export function forgetAttachment(tabId) {
  attached.delete(tabId);
}

export function isAttached(tabId) {
  return attached.has(tabId);
}

export async function pageInfo(tabId) {
  const result = await send(tabId, "Runtime.evaluate", {
    expression: "({url:location.href,title:document.title})",
    returnByValue: true,
    awaitPromise: false,
  });
  const value = result?.result?.value;
  return {
    url: typeof value?.url === "string" ? value.url : "",
    title: typeof value?.title === "string" ? value.title : "",
  };
}

export async function getText(tabId) {
  const result = await send(tabId, "Runtime.evaluate", {
    expression: "(document.body?.innerText ?? document.documentElement?.innerText ?? '').trim()",
    returnByValue: true,
    awaitPromise: false,
  });
  const text = typeof result?.result?.value === "string" ? result.result.value : "";
  return text.slice(0, 20_000);
}

function frameList(frameTree) {
  const frames = [];
  const walk = (entry, parentId = undefined) => {
    if (!entry?.frame?.id) return;
    frames.push({
      frameId: entry.frame.id,
      loaderId: typeof entry.frame.loaderId === "string" ? entry.frame.loaderId : "",
      url: typeof entry.frame.url === "string" ? entry.frame.url : "",
      parentId,
    });
    for (const child of entry.childFrames ?? []) walk(child, entry.frame.id);
  };
  walk(frameTree);
  return frames;
}

export async function frameDocuments(tabId) {
  const result = await send(tabId, "Page.getFrameTree");
  const frames = frameList(result?.frameTree);
  let crossOriginFrames = 0;
  let mainOrigin;
  try {
    mainOrigin = frames[0]?.url ? new URL(frames[0].url).origin : undefined;
  } catch {
    mainOrigin = undefined;
  }
  const documents = new Map();
  for (const frame of frames) {
    documents.set(frame.frameId, frame);
    if (frame.parentId && mainOrigin) {
      try {
        if (new URL(frame.url).origin !== mainOrigin) crossOriginFrames += 1;
      } catch {
        // A frame without a committed URL is counted only once it exposes a cross-origin URL.
      }
    }
  }
  return { frames, documents, crossOriginFrames };
}

function roleValue(node) {
  return typeof node.role?.value === "string" ? node.role.value.toLowerCase() : "";
}

function scalar(value) {
  const inner = value?.value;
  return typeof inner === "string" || typeof inner === "number" || typeof inner === "boolean" ? inner : undefined;
}

function axProperties(node) {
  const values = new Map();
  for (const property of node.properties ?? []) {
    if (typeof property?.name === "string") values.set(property.name, scalar(property.value));
  }
  return values;
}

function nodeStates(properties) {
  const states = [];
  for (const name of STATE_NAMES) {
    const value = properties.get(name);
    if (value === true) states.push(name);
    else if (name === "checked" && value === "mixed") states.push("mixed");
  }
  return states.slice(0, 8);
}

function candidateFromAx(node, frame, site) {
  if (!node || node.ignored || typeof node.role?.value !== "string") return undefined;
  const role = roleValue(node);
  const isHeading = role === "heading";
  if (!isHeading && !INTERACTIVE.has(role)) return undefined;
  if (!isHeading && !Number.isInteger(node.backendDOMNodeId)) return undefined;
  const properties = axProperties(node);
  const name = typeof node.name?.value === "string" ? node.name.value.trim() : "";
  if (isHeading) {
    const level = Number(properties.get("level"));
    return {
      role: "heading",
      name,
      heading: Number.isInteger(level) && level >= 1 && level <= 3 ? level : 2,
    };
  }
  const output = { role, name };
  const disabled = properties.get("disabled");
  if (disabled === true) output.disabled = true;
  const states = nodeStates(properties);
  if (states.length > 0) output.state = states;
  if (site) output.site = site;
  return {
    node: output,
    refItem: {
      frameId: frame.frameId,
      loaderId: frame.loaderId,
      backendNodeId: node.backendDOMNodeId,
      role,
      name,
    },
  };
}

function parseOrigin(url) {
  try {
    return new URL(url).host;
  } catch {
    return undefined;
  }
}

/** Native Accessibility trees from the main frame and readable child frames, capped before output. */
export async function snapshotPage(agentId, tabId, tabHandle, refs) {
  await ensureAttached(tabId);
  const frameInfo = await frameDocuments(tabId);
  const mainOrigin = parseOrigin(frameInfo.frames[0]?.url ?? "");
  const candidates = [];
  let total = 0;
  const seen = new Set();

  for (const frame of frameInfo.frames) {
    let tree;
    try {
      tree = await send(tabId, "Accessibility.getFullAXTree", frame.frameId ? { frameId: frame.frameId } : {});
    } catch {
      continue;
    }
    const site = frame.parentId && parseOrigin(frame.url) !== mainOrigin ? parseOrigin(frame.url) : undefined;
    let heading;
    for (const node of tree?.nodes ?? []) {
      if (!node || node.ignored) continue;
      const role = roleValue(node);
      if (role === "statictext") {
        if (heading) {
          const text = typeof node.name?.value === "string" ? node.name.value.trim() : "";
          if (text) heading.text = `${heading.text ? `${heading.text} ` : ""}${text}`.slice(0, 400);
        }
        continue;
      }
      const candidate = candidateFromAx(node, frame, site);
      if (!candidate?.node) {
        if (role !== "heading") heading = undefined;
        continue;
      }
      if (role === "heading") heading = candidate.node;
      else heading = undefined;
      const key = candidate.node.heading ? `h:${frame.frameId}:${node.nodeId}` : `n:${candidate.refItem.backendNodeId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      total += 1;
      if (candidates.length < 240) candidates.push(candidate);
    }
  }

  const refItems = candidates.filter((candidate) => candidate.refItem).map((candidate) => candidate.refItem);
  const assigned = refs.capture(agentId, tabId, tabHandle, refItems);
  let refIndex = 0;
  const nodes = candidates.map((candidate) => {
    if (!candidate.refItem) return candidate.node;
    return { ref: assigned[refIndex++], ...candidate.node };
  });
  return {
    nodes,
    crossOriginFrames: frameInfo.crossOriginFrames,
    ...(total > nodes.length ? { omitted: total - nodes.length } : {}),
  };
}

export async function validateRefDocument(tabId, record) {
  let documents;
  try {
    ({ documents } = await frameDocuments(tabId));
  } catch {
    throw new BrowserCommandError("STALE_REF", "The tab closed or changed while resolving the ref; take a fresh snapshot.");
  }
  const current = documents.get(record.frameId);
  if (!current || current.loaderId !== record.loaderId) {
    throw new BrowserCommandError("STALE_REF", "The page reloaded since the snapshot; take a fresh snapshot before using this ref.");
  }
  return current;
}

export async function resolveNode(tabId, record) {
  await validateRefDocument(tabId, record);
  try {
    const result = await send(tabId, "DOM.resolveNode", { backendNodeId: record.backendNodeId });
    if (!result?.object?.objectId) throw new Error("no object");
    return result.object.objectId;
  } catch {
    throw new BrowserCommandError("STALE_REF", "The element no longer exists; take a fresh snapshot.");
  }
}

async function ensureVisible(tabId) {
  const visible = async () => {
    try {
      const result = await send(tabId, "Runtime.evaluate", { expression: "document.visibilityState", returnByValue: true });
      return result?.result?.value === "visible";
    } catch {
      return false;
    }
  };
  if (await visible()) return;
  await chrome.tabs.update(tabId, { active: true });
  try {
    const tab = await chrome.tabs.get(tabId);
    await chrome.windows.update(tab.windowId, { focused: true });
    await send(tabId, "Page.bringToFront");
  } catch {
    // The visibility check below is the receipt that matters.
  }
  for (let attempt = 0; attempt < 10; attempt += 1) {
    await sleep(100);
    if (await visible()) return;
  }
  throw new BrowserCommandError("TAB_NOT_VISIBLE", "The granted tab is minimized or its window is not visible; native input was not sent.");
}

async function elementCenter(tabId, objectId) {
  await send(tabId, "Runtime.callFunctionOn", {
    objectId,
    functionDeclaration: "function(){ this.scrollIntoView({block:'center',inline:'center'}); }",
  });
  const backendNodeId = await send(tabId, "DOM.describeNode", { objectId }).then((result) => result?.node?.backendNodeId);
  if (!Number.isInteger(backendNodeId)) throw new BrowserCommandError("ELEMENT_NOT_FOUND", "The element has no DOM node; take a fresh snapshot.");
  const box = await send(tabId, "DOM.getBoxModel", { backendNodeId });
  const quad = box?.model?.content;
  if (!Array.isArray(quad) || quad.length !== 8 || quad.some((value) => !Number.isFinite(value))) {
    throw new BrowserCommandError("ELEMENT_NOT_VISIBLE", "The element has no visible box on the page.");
  }
  const xs = [quad[0], quad[2], quad[4], quad[6]];
  const ys = [quad[1], quad[3], quad[5], quad[7]];
  const x0 = Math.min(...xs);
  const x1 = Math.max(...xs);
  const y0 = Math.min(...ys);
  const y1 = Math.max(...ys);
  return { x: (x0 + x1) / 2, y: (y0 + y1) / 2, box: { x: x0, y: y0, width: x1 - x0, height: y1 - y0 } };
}

export async function clickRef(tabId, record) {
  await ensureAttached(tabId);
  await ensureVisible(tabId);
  const objectId = await resolveNode(tabId, record);
  const center = await elementCenter(tabId, objectId);
  let pressed = false;
  try {
    await send(tabId, "Input.dispatchMouseEvent", { type: "mouseMoved", x: center.x, y: center.y });
    await send(tabId, "Input.dispatchMouseEvent", { type: "mousePressed", x: center.x, y: center.y, button: "left", clickCount: 1 });
    pressed = true;
    await send(tabId, "Input.dispatchMouseEvent", { type: "mouseReleased", x: center.x, y: center.y, button: "left", clickCount: 1 });
  } catch (error) {
    if (pressed && error instanceof BrowserCommandError) error.outcome = "unknown";
    throw error;
  }
}

export async function clickPoint(tabId, x, y) {
  await ensureAttached(tabId);
  await ensureVisible(tabId);
  let pressed = false;
  try {
    await send(tabId, "Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
    await send(tabId, "Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
    pressed = true;
    await send(tabId, "Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
  } catch (error) {
    if (pressed && error instanceof BrowserCommandError) error.outcome = "unknown";
    throw error;
  }
}

function attributeMap(attributes) {
  const map = new Map();
  for (let index = 0; Array.isArray(attributes) && index + 1 < attributes.length; index += 2) {
    map.set(String(attributes[index]).toLowerCase(), String(attributes[index + 1]));
  }
  return map;
}

export async function describeNode(tabId, record) {
  await validateRefDocument(tabId, record);
  try {
    const result = await send(tabId, "DOM.describeNode", { backendNodeId: record.backendNodeId });
    return result?.node;
  } catch {
    throw new BrowserCommandError("STALE_REF", "The element no longer exists; take a fresh snapshot.");
  }
}

export function isSensitiveField(type, autocomplete) {
  const kind = typeof type === "string" ? type.toLowerCase() : "";
  const tokens = typeof autocomplete === "string" ? autocomplete.toLowerCase().split(/\s+/).filter(Boolean) : [];
  return kind === "password" || tokens.some((token) => token === "current-password" || token === "new-password" || token === "one-time-code" || token.startsWith("cc-"));
}

export async function typeRef(tabId, record, text) {
  await ensureAttached(tabId);
  await ensureVisible(tabId);
  const node = await describeNode(tabId, record);
  const attributes = attributeMap(node?.attributes);
  const tag = String(node?.nodeName ?? "").toUpperCase();
  const disabled = attributes.has("disabled") || attributes.get("aria-disabled") === "true";
  const readonly = attributes.has("readonly") || attributes.get("aria-readonly") === "true";
  const editableTag = tag === "INPUT" || tag === "TEXTAREA" || (attributes.has("contenteditable") && attributes.get("contenteditable") !== "false");
  if (disabled || readonly || !editableTag) {
    throw new BrowserCommandError("FIELD_NOT_EDITABLE", "The ref is disabled, read-only or not an editable field.");
  }
  if (isSensitiveField(attributes.get("type"), attributes.get("autocomplete"))) {
    throw new BrowserCommandError("SECRET_FIELD_REFUSED", "Use secure input for password, payment and one-time-code fields; plaintext fallback is unavailable.");
  }
  const objectId = await resolveNode(tabId, record);
  const check = await send(tabId, "Runtime.callFunctionOn", {
    objectId,
    functionDeclaration: "function(){ if(this.disabled||this.readOnly) return 'blocked'; const ac=String(this.autocomplete||'').toLowerCase().split(/\\s+/); if(this.type==='password'||ac.some(t=>t==='current-password'||t==='new-password'||t==='one-time-code'||t.startsWith('cc-'))) return 'secret'; if(!(this.isContentEditable||this.tagName==='INPUT'||this.tagName==='TEXTAREA')) return 'uneditable'; this.focus(); if(typeof this.select==='function') this.select(); return 'ok'; }",
    returnByValue: true,
  });
  if (check?.result?.value === "secret") throw new BrowserCommandError("SECRET_FIELD_REFUSED", "Use secure input for password, payment and one-time-code fields; plaintext fallback is unavailable.");
  if (check?.result?.value !== "ok") throw new BrowserCommandError("FIELD_NOT_EDITABLE", "The ref is disabled, read-only or not an editable field.");
  try {
    await send(tabId, "Input.insertText", { text: String(text).slice(0, 20_000) });
  } catch (error) {
    if (error instanceof BrowserCommandError) error.outcome = "unknown";
    throw error;
  }
}

export async function attrsForRefs(tabId, records) {
  await ensureAttached(tabId);
  const fields = [];
  for (const record of records) {
    const node = await describeNode(tabId, record);
    const attributes = attributeMap(node?.attributes);
    const field = { ref: record.ref, tag: String(node?.nodeName ?? "").toLowerCase() };
    for (const key of ["autocomplete", "id", "name", "placeholder", "inputmode", "pattern"]) {
      if (attributes.has(key)) field[key] = attributes.get(key);
    }
    field.type = attributes.get("type") || (field.tag === "input" ? "text" : undefined);
    if (record.name) field.label = record.name;
    const numeric = (key, target, integer = false) => {
      const value = Number(attributes.get(key));
      if (Number.isFinite(value)) field[target] = integer ? Math.trunc(value) : value;
    };
    numeric("maxlength", "maxLength", true);
    numeric("min", "min");
    numeric("max", "max");
    numeric("step", "step");
    if (attributes.has("required")) field.required = true;
    if (attributes.has("aria-required")) field.required = attributes.get("aria-required") === "true";
    for (const key of Object.keys(field)) if (field[key] === undefined) delete field[key];
    if (field.tag === "select") {
      try {
        const objectId = await resolveNode(tabId, record);
        const result = await send(tabId, "Runtime.callFunctionOn", {
          objectId,
          functionDeclaration: "function(){ return Array.from(this.options ?? []).slice(0,100).map((option) => option.text || option.value); }",
          returnByValue: true,
        });
        if (Array.isArray(result?.result?.value)) field.options = result.result.value.slice(0, 100);
      } catch {
        // Attributes are still useful when a page hides its option labels.
      }
    }
    fields.push(field);
  }
  return fields;
}

async function screenMapping(tabId) {
  const result = await send(tabId, "Runtime.evaluate", {
    expression: "({screenX,screenY,outerWidth,outerHeight,innerWidth,innerHeight,devicePixelRatio})",
    returnByValue: true,
  });
  const metrics = result?.result?.value;
  const values = [metrics?.screenX, metrics?.screenY, metrics?.outerWidth, metrics?.outerHeight, metrics?.innerWidth, metrics?.innerHeight, metrics?.devicePixelRatio];
  if (values.some((value) => !Number.isFinite(value)) || metrics.devicePixelRatio <= 0 || metrics.outerWidth < metrics.innerWidth || metrics.outerHeight < metrics.innerHeight) {
    throw new BrowserCommandError("POINT_MAPPING_UNAVAILABLE", "Chrome did not expose a reliable window-to-screen mapping; screen coordinates are unavailable.");
  }
  return {
    scale: metrics.devicePixelRatio,
    left: metrics.screenX + (metrics.outerWidth - metrics.innerWidth) / 2,
    top: metrics.screenY + (metrics.outerHeight - metrics.innerHeight),
    width: metrics.innerWidth,
    height: metrics.innerHeight,
  };
}

export async function boundsForRefs(tabId, records) {
  await ensureAttached(tabId);
  const mapping = await screenMapping(tabId);
  const elements = [];
  for (const record of records) {
    const objectId = await resolveNode(tabId, record);
    const center = await elementCenter(tabId, objectId);
    const rect = {
      x: Math.max(0, Math.round((mapping.left + center.box.x) * mapping.scale)),
      y: Math.max(0, Math.round((mapping.top + center.box.y) * mapping.scale)),
      width: Math.max(1, Math.round(center.box.width * mapping.scale)),
      height: Math.max(1, Math.round(center.box.height * mapping.scale)),
    };
    elements.push({ ref: record.ref, rect, role: record.role, name: record.name });
  }
  return elements;
}

function axElement(nodes) {
  for (const node of nodes ?? []) {
    if (!node || node.ignored) continue;
    const role = roleValue(node);
    if (!role || role === "generic" || role === "none" || role === "statictext") continue;
    const name = typeof node.name?.value === "string" ? node.name.value.trim() : "";
    return { role, name };
  }
  return undefined;
}

async function elementForBackend(tabId, backendNodeId) {
  if (!Number.isInteger(backendNodeId)) return undefined;
  try {
    const result = await send(tabId, "Accessibility.getPartialAXTree", {
      backendNodeId,
      fetchRelatives: true,
    });
    return axElement(result?.nodes);
  } catch {
    return undefined;
  }
}

export async function pointAt(tabId, x, y) {
  await ensureAttached(tabId);
  if (x === undefined && y === undefined) {
    const result = await send(tabId, "Runtime.evaluate", { expression: "document.activeElement", returnByValue: false });
    const objectId = result?.result?.objectId;
    if (!objectId) return undefined;
    const node = await send(tabId, "DOM.describeNode", { objectId });
    return elementForBackend(tabId, node?.node?.backendNodeId);
  }
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    throw new BrowserCommandError("INVALID_POINT", "Both screen x and y are required for a point lookup.");
  }
  const mapping = await screenMapping(tabId);
  const viewportX = x / mapping.scale - mapping.left;
  const viewportY = y / mapping.scale - mapping.top;
  if (viewportX < 0 || viewportY < 0 || viewportX >= mapping.width || viewportY >= mapping.height) return undefined;
  const result = await send(tabId, "DOM.getNodeForLocation", {
    x: viewportX,
    y: viewportY,
    includeUserAgentShadowDOM: true,
    ignorePointerEventsNone: false,
  });
  return elementForBackend(tabId, result?.backendNodeId);
}

export async function navigateTab(tabId, url) {
  await ensureAttached(tabId);
  const result = await send(tabId, "Page.navigate", { url }, 10_000);
  if (result?.errorText) throw new BrowserCommandError("NAVIGATION_FAILED", String(result.errorText));
  let loading = true;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await sleep(100);
    const tab = await chrome.tabs.get(tabId);
    if (tab.status === "complete") {
      loading = false;
      break;
    }
  }
  return { loading };
}

export async function handleDialog(tabId, accept, promptText) {
  await ensureAttached(tabId);
  try {
    await send(tabId, "Page.handleJavaScriptDialog", {
      accept,
      ...(promptText === undefined ? {} : { promptText }),
    });
  } catch (error) {
    if (error instanceof BrowserCommandError) error.outcome = "unknown";
    throw error;
  }
}
