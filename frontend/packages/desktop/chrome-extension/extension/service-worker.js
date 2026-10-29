/* global chrome */
import {
  BrowserCommandError,
  attrsForRefs,
  boundsForRefs,
  clickRef,
  detachAll,
  detachTab,
  ensureAttached,
  forgetAttachment,
  getText,
  handleDialog,
  isSafeWebUrl,
  navigateTab,
  pageInfo,
  pointAt,
  snapshotPage,
  typeRef,
} from "./cdp.js";
import { RefRegistry } from "./refs.js";
import { TabScope } from "./tab-scope.js";

const HOST_NAME = "io.github.nigelleong0703.juno.chrome";
const ACTIONS = new Set([
  "tabs",
  "new_tab",
  "navigate",
  "snapshot",
  "get_text",
  "click",
  "type",
  "dialog",
  "notices",
  "point",
  "attrs",
  "bounds",
  "secure_key",
  "fill_secret",
]);

const tabs = new TabScope();
const refs = new RefRegistry();
const dialogs = new Map();
const tabOpeners = new Map();
const noticesByAgent = new Map();
const requestedAgents = new Set();
const controllers = new Map();
const queues = new Map();
let nativePort;
let ready = false;
let connecting = false;
let lastError = "";

function emptyNotices() {
  return { alerts: [], opened: [], closed: [] };
}

function noticesFor(agentId) {
  let value = noticesByAgent.get(agentId);
  if (!value) {
    value = emptyNotices();
    noticesByAgent.set(agentId, value);
  }
  return value;
}

function knownAgents() {
  const agents = new Set([...noticesByAgent.keys(), ...requestedAgents]);
  for (const grant of tabs.grants()) {
    if (grant.ownerAgentId) agents.add(grant.ownerAgentId);
  }
  return [...agents];
}

function pushBounded(list, entry) {
  list.push(entry);
  if (list.length > 20) list.splice(0, list.length - 20);
}

function dialogView(tabId, agentId) {
  const dialog = dialogs.get(tabId);
  if (!dialog) return undefined;
  return { ...dialog, tab: tabs.handle(agentId, tabId) };
}

function currentDialog(agentId, preferredTabId) {
  const candidates = preferredTabId === undefined ? tabs.accessibleTabs(agentId).map((tab) => tab.tabId) : [preferredTabId];
  const active = tabs.activeTab(agentId);
  if (active !== undefined && !candidates.includes(active)) candidates.push(active);
  for (const tabId of candidates) {
    if (tabs.accessible(tabId, agentId) && dialogs.has(tabId)) return dialogView(tabId, agentId);
  }
  return undefined;
}

function takeNotices(agentId, preferredTabId) {
  const queued = noticesFor(agentId);
  const dialog = currentDialog(agentId, preferredTabId);
  const result = {
    ...(dialog ? { dialog } : {}),
    ...(queued.alerts.length ? { alerts: queued.alerts.splice(0) } : {}),
    ...(queued.opened.length ? { opened: queued.opened.splice(0) } : {}),
    ...(queued.closed.length ? { closed: queued.closed.splice(0) } : {}),
  };
  return result;
}

function setBadge() {
  const text = ready ? "ON" : lastError ? "!" : "";
  void chrome.action.setBadgeText({ text });
  void chrome.action.setBadgeBackgroundColor({ color: "#2f7d5b" });
}

async function restoreGrants() {
  try {
    const stored = await chrome.storage.session.get("juno-grants");
    const grants = stored?.["juno-grants"];
    if (!Array.isArray(grants)) return;
    for (const grant of grants) {
      if (Number.isInteger(grant?.tabId) && (grant.ownerAgentId === null || typeof grant.ownerAgentId === "string")) {
        tabs.grant(grant.tabId, grant.ownerAgentId);
      }
    }
  } catch {
    // A session-storage failure leaves the in-memory grant table empty and safe.
  }
  setBadge();
}

const grantsReady = restoreGrants();

async function persistGrants() {
  try {
    await chrome.storage.session.set({ "juno-grants": tabs.grants() });
  } catch {
    // Persistence is a convenience across service-worker suspension; explicit grants remain in memory.
  }
}

function releaseAuthority() {
  detachAll();
  refs.invalidateAll();
  dialogs.clear();
  for (const controller of controllers.values()) controller.abort();
  controllers.clear();
  queues.clear();
}

function disconnectNative() {
  const port = nativePort;
  nativePort = undefined;
  ready = false;
  connecting = false;
  releaseAuthority();
  setBadge();
  try {
    port?.disconnect();
  } catch {
    // The port may already be gone.
  }
}

function connectNative() {
  if (nativePort || connecting) return;
  connecting = true;
  lastError = "";
  try {
    const port = chrome.runtime.connectNative(HOST_NAME);
    nativePort = port;
    port.onMessage.addListener((message) => onNativeMessage(message));
    port.onDisconnect.addListener(() => {
      lastError = chrome.runtime.lastError?.message || "Juno desktop is offline";
      if (nativePort === port) nativePort = undefined;
      ready = false;
      connecting = false;
      releaseAuthority();
      setBadge();
    });
  } catch (error) {
    lastError = error instanceof Error ? error.message : String(error);
    nativePort = undefined;
    connecting = false;
    setBadge();
  }
}

async function onNativeMessage(message) {
  if (!message || typeof message !== "object") return;
  if (message.type === "ready") {
    ready = true;
    connecting = false;
    lastError = "";
    setBadge();
    return;
  }
  if (message.type === "bridge-error") {
    lastError = typeof message.message === "string" ? message.message : "Juno native host could not connect";
    connecting = false;
    setBadge();
    return;
  }
  if (message.type === "cancel" && typeof message.id === "string") {
    controllers.get(message.id)?.abort();
    return;
  }
  if (message.type !== "request" || typeof message.id !== "string" || typeof message.agentId !== "string" || !message.input || typeof message.input !== "object" || Array.isArray(message.input)) {
    return;
  }
  if (controllers.has(message.id)) return;
  requestedAgents.add(message.agentId);
  const controller = new AbortController();
  controllers.set(message.id, controller);
  const previous = queues.get(message.agentId) ?? Promise.resolve();
  const current = previous
    .catch(() => undefined)
    .then(() => handleBrowserRequest(message.agentId, message.input, controller.signal))
    .then(
      (result) => sendResponse(message.id, true, result),
      (error) => sendResponse(message.id, false, undefined, error),
    )
    .finally(() => {
      controllers.delete(message.id);
      if (queues.get(message.agentId) === current) queues.delete(message.agentId);
    });
  queues.set(message.agentId, current);
}

function sendResponse(id, ok, result, error) {
  const port = nativePort;
  if (!port || !ready) return;
  if (ok) {
    port.postMessage({ type: "response", id, ok: true, result });
    return;
  }
  const failure = error instanceof BrowserCommandError
    ? { code: error.code, message: error.message, outcome: error.outcome }
    : { code: "BROWSER_COMMAND_FAILED", message: error instanceof Error ? error.message : String(error), outcome: "reported" };
  port.postMessage({ type: "response", id, ok: false, error: failure });
}

function assertNotAborted(signal) {
  if (signal.aborted) throw new BrowserCommandError("BROWSER_ABORTED", "The browser command was cancelled.");
}

async function tabById(tabId) {
  try {
    return await chrome.tabs.get(tabId);
  } catch {
    tabs.close(tabId);
    refs.invalidateTab(tabId);
    dialogs.delete(tabId);
    throw new BrowserCommandError("TAB_CLOSED", "The granted Chrome tab is no longer open.");
  }
}

async function targetTab(agentId, handle) {
  const tabId = handle === undefined ? tabs.activeTab(agentId) : tabs.resolve(agentId, String(handle));
  if (tabId === undefined) throw new BrowserCommandError("NO_GRANTED_TAB", "No browser tab is granted. Open the Juno extension popup and allow the current tab.");
  const tab = await tabById(tabId);
  tabs.setActive(agentId, tabId);
  return { tabId, handle: tabs.handle(agentId, tabId), tab };
}

function assertNoBlockingDialog(agentId, tabId) {
  const dialog = currentDialog(agentId, tabId);
  if (dialog) throw new BrowserCommandError("DIALOG_OPEN", "A dialog is blocking this tab; answer it with browser.dialog before doing anything else.");
}

async function waitForLoad(tabId, budgetMs = 2000) {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    const tab = await tabById(tabId);
    if (tab.status === "complete") return false;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return true;
}

async function safePageInfo(tabId, fallback) {
  try {
    return await pageInfo(tabId);
  } catch {
    return { url: fallback?.url || "", title: fallback?.title || "" };
  }
}

async function handleBrowserRequest(agentId, input, signal) {
  await grantsReady;
  assertNotAborted(signal);
  if (typeof input.action !== "string" || !ACTIONS.has(input.action)) {
    throw new BrowserCommandError("UNKNOWN_BROWSER_ACTION", "Unknown Chrome browser action.");
  }
  const action = input.action;

  if (action === "secure_key" || action === "fill_secret") {
    throw new BrowserCommandError("SECURE_INPUT_UNAVAILABLE", "Secure browser input is not available in the existing-Chrome bridge; no value was sent.");
  }

  if (action === "notices") {
    const tabId = tabs.activeTab(agentId);
    return { action, ...takeNotices(agentId, tabId) };
  }

  if (action === "tabs") {
    const resultTabs = [];
    for (const granted of tabs.accessibleTabs(agentId)) {
      try {
        const tab = await chrome.tabs.get(granted.tabId);
        const dialog = dialogView(granted.tabId, agentId);
        resultTabs.push({
          tab: granted.handle,
          url: tab.url || "",
          title: tab.title || "",
          active: Boolean(tab.active),
          ...(dialog ? { dialog } : {}),
        });
      } catch {
        tabs.close(granted.tabId);
        refs.invalidateTab(granted.tabId);
      }
    }
    return { action, tabs: resultTabs, ...takeNotices(agentId) };
  }

  if (action === "new_tab") {
    let url = "about:blank";
    if (input.url !== undefined) {
      if (!isSafeWebUrl(input.url)) throw new BrowserCommandError("UNSAFE_URL", "Only http and https URLs without embedded credentials are allowed.");
      url = input.url;
    }
    const created = await chrome.tabs.create({ url, active: true });
    if (created.id === undefined) throw new BrowserCommandError("NEW_TAB_FAILED", "Chrome did not return the new tab id.");
    try {
      tabs.grant(created.id, agentId);
      tabs.setActive(agentId, created.id);
      const handle = tabs.handle(agentId, created.id);
      const loading = await waitForLoad(created.id);
      const tab = await tabById(created.id);
      await persistGrants();
      return {
        action,
        url: tab.url || url,
        title: tab.title || "",
        tab: handle,
        ...(loading ? { loading: true } : {}),
        ...takeNotices(agentId, created.id),
      };
    } catch (error) {
      if (error instanceof BrowserCommandError) error.outcome = "unknown";
      throw error;
    }
  }

  if (action === "navigate") {
    if (!isSafeWebUrl(input.url)) throw new BrowserCommandError("UNSAFE_URL", "Only http and https URLs without embedded credentials are allowed.");
    const target = await targetTab(agentId, typeof input.tab === "string" ? input.tab : undefined);
    assertNoBlockingDialog(agentId, target.tabId);
    refs.invalidateTab(target.tabId);
    const navigation = await navigateTab(target.tabId, input.url);
    const info = await safePageInfo(target.tabId, target.tab);
    return {
      action,
      url: info.url,
      title: info.title,
      tab: target.handle,
      ...(navigation.loading ? { loading: true } : {}),
      ...takeNotices(agentId, target.tabId),
    };
  }

  if (action === "snapshot") {
    let target = await targetTab(agentId, typeof input.tab === "string" ? input.tab : undefined);
    if (input.follow === true) {
      const opened = noticesFor(agentId).opened.at(-1);
      if (opened?.tab) {
        try {
          tabs.setActive(agentId, tabs.resolve(agentId, opened.tab));
          target = await targetTab(agentId, opened.tab);
        } catch {
          // A popup that already closed remains in the notice and the requested tab stays active.
        }
      }
    }
    const dialog = currentDialog(agentId, target.tabId);
    if (dialog) {
      return {
        action,
        url: dialog.url || target.tab.url || "",
        title: target.tab.title || "",
        tab: target.handle,
        nodes: [],
        crossOriginFrames: 0,
        ...takeNotices(agentId, target.tabId),
      };
    }
    await ensureAttached(target.tabId);
    const info = await pageInfo(target.tabId);
    const snapshot = await snapshotPage(agentId, target.tabId, target.handle, refs);
    return { action, ...info, tab: target.handle, ...snapshot, ...takeNotices(agentId, target.tabId) };
  }

  if (action === "get_text") {
    const target = await targetTab(agentId, typeof input.tab === "string" ? input.tab : undefined);
    const dialog = currentDialog(agentId, target.tabId);
    if (dialog) {
      return {
        action,
        url: dialog.url || target.tab.url || "",
        title: target.tab.title || "",
        tab: target.handle,
        text: "",
        ...takeNotices(agentId, target.tabId),
      };
    }
    await ensureAttached(target.tabId);
    const info = await pageInfo(target.tabId);
    const text = await getText(target.tabId);
    return { action, ...info, tab: target.handle, text, ...takeNotices(agentId, target.tabId) };
  }

  if (action === "click") {
    if (typeof input.ref !== "string") throw new BrowserCommandError("REF_REQUIRED", "browser.click requires a ref from snapshot.");
    const record = refs.resolve(agentId, input.ref);
    if (!tabs.accessible(record.tabId, agentId)) throw new BrowserCommandError("TAB_NOT_GRANTED", "The ref's tab is no longer granted.");
    await tabById(record.tabId);
    tabs.setActive(agentId, record.tabId);
    assertNoBlockingDialog(agentId, record.tabId);
    await clickRef(record.tabId, record);
    await new Promise((resolve) => setTimeout(resolve, 100));
    const dialog = currentDialog(agentId, record.tabId);
    const info = dialog ? { url: dialog.url || "", title: (await tabById(record.tabId)).title || "" } : await safePageInfo(record.tabId, undefined);
    return { action, ...info, tab: record.tabHandle, clicked: true, ...takeNotices(agentId, record.tabId) };
  }

  if (action === "type") {
    if (typeof input.ref !== "string" || typeof input.text !== "string" || input.text.length > 20_000) {
      throw new BrowserCommandError("INVALID_TYPE_INPUT", "browser.type requires a ref and text of at most 20000 characters.");
    }
    const record = refs.resolve(agentId, input.ref);
    if (!tabs.accessible(record.tabId, agentId)) throw new BrowserCommandError("TAB_NOT_GRANTED", "The ref's tab is no longer granted.");
    await tabById(record.tabId);
    tabs.setActive(agentId, record.tabId);
    assertNoBlockingDialog(agentId, record.tabId);
    await typeRef(record.tabId, record, input.text);
    await new Promise((resolve) => setTimeout(resolve, 100));
    const dialog = currentDialog(agentId, record.tabId);
    const info = dialog ? { url: dialog.url || "", title: (await tabById(record.tabId)).title || "" } : await safePageInfo(record.tabId, undefined);
    return { action, ...info, tab: record.tabHandle, typed: true, ...takeNotices(agentId, record.tabId) };
  }

  if (action === "dialog") {
    const target = await targetTab(agentId, typeof input.tab === "string" ? input.tab : undefined);
    const open = dialogView(target.tabId, agentId);
    if (input.accept === undefined) {
      return {
        action,
        url: open?.url || target.tab.url || "",
        title: target.tab.title || "",
        tab: target.handle,
        ...takeNotices(agentId, target.tabId),
      };
    }
    if (typeof input.accept !== "boolean" || (input.text !== undefined && (typeof input.text !== "string" || input.text.length > 2000))) {
      throw new BrowserCommandError("INVALID_DIALOG_INPUT", "dialog.accept must be boolean and dialog.text at most 2000 characters.");
    }
    if (!open) throw new BrowserCommandError("NO_DIALOG", "No JavaScript dialog is open on this tab.");
    await handleDialog(target.tabId, input.accept, input.text);
    dialogs.delete(target.tabId);
    return {
      action,
      url: open.url || target.tab.url || "",
      title: target.tab.title || "",
      tab: target.handle,
      handled: { ...open, accepted: input.accept },
      ...takeNotices(agentId, target.tabId),
    };
  }

  if (action === "point") {
    const target = await targetTab(agentId, typeof input.tab === "string" ? input.tab : undefined);
    const window = await chrome.windows.get(target.tab.windowId);
    if (!window.focused || !target.tab.active) {
      return { action, url: target.tab.url || "", title: target.tab.title || "", tab: target.handle };
    }
    if (input.x !== undefined && input.y !== undefined) {
      if (typeof input.x !== "number" || typeof input.y !== "number") throw new BrowserCommandError("INVALID_POINT", "point x and y must be numbers.");
    }
    if (input.x === undefined && input.y !== undefined) throw new BrowserCommandError("INVALID_POINT", "point requires both x and y.");
    if (input.y === undefined && input.x !== undefined) throw new BrowserCommandError("INVALID_POINT", "point requires both x and y.");
    const dialog = currentDialog(agentId, target.tabId);
    const element = dialog ? undefined : await pointAt(target.tabId, input.x, input.y);
    const info = dialog ? { url: dialog.url || target.tab.url || "", title: target.tab.title || "" } : await pageInfo(target.tabId);
    return {
      action,
      ...info,
      tab: target.handle,
      ...(element ? { element } : {}),
      ...(dialog ? { dialog } : {}),
    };
  }

  if (action === "attrs") {
    if (!Array.isArray(input.refs) || input.refs.length < 1 || input.refs.length > 8 || input.refs.some((ref) => typeof ref !== "string")) {
      throw new BrowserCommandError("INVALID_REFS", "attrs requires one to eight refs.");
    }
    const records = input.refs.map((ref) => refs.resolve(agentId, ref));
    const tabIds = new Set(records.map((record) => record.tabId));
    if (tabIds.size !== 1) throw new BrowserCommandError("MIXED_TAB_REFS", "attrs refs must all belong to the same snapshot tab.");
    const record = records[0];
    const target = await targetTab(agentId, record.tabHandle);
    assertNoBlockingDialog(agentId, target.tabId);
    const info = await pageInfo(target.tabId);
    const fields = await attrsForRefs(target.tabId, records);
    return { action, ...info, tab: target.handle, fields };
  }

  if (action === "bounds") {
    const target = await targetTab(agentId, typeof input.tab === "string" ? input.tab : undefined);
    assertNoBlockingDialog(agentId, target.tabId);
    let requested = input.refs;
    if (requested === undefined) {
      const snapshot = await snapshotPage(agentId, target.tabId, target.handle, refs);
      requested = snapshot.nodes.flatMap((node) => (typeof node.ref === "string" ? [node.ref] : []));
    }
    if (!Array.isArray(requested) || requested.length < 1 || requested.length > 20 || requested.some((ref) => typeof ref !== "string")) {
      throw new BrowserCommandError("INVALID_REFS", "bounds requires one to twenty refs.");
    }
    const records = requested.map((ref) => refs.resolve(agentId, ref));
    if (new Set(records.map((record) => record.tabId)).size !== 1) {
      throw new BrowserCommandError("MIXED_TAB_REFS", "bounds refs must all belong to one tab.");
    }
    const info = await pageInfo(target.tabId);
    const elements = await boundsForRefs(target.tabId, records);
    return { action, ...info, tab: target.handle, elements };
  }

  throw new BrowserCommandError("UNKNOWN_BROWSER_ACTION", "Unknown Chrome browser action.");
}

async function activeChromeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function uiStatus() {
  await grantsReady;
  const tab = await activeChromeTab().catch(() => undefined);
  return {
    connected: ready,
    connecting,
    error: lastError,
    grants: tabs.grantCount(),
    extensionId: chrome.runtime.id,
    activeTab: tab ? {
      id: tab.id,
      title: tab.title || "",
      url: tab.url || "",
      allowed: tab.id === undefined ? false : tabs.grants().some((grant) => grant.tabId === tab.id && grant.ownerAgentId === null),
      grantable: Boolean(tab.id !== undefined && isSafeWebUrl(tab.url ?? "")),
    } : undefined,
  };
}

async function handleUiMessage(message) {
  await grantsReady;
  if (!message || typeof message !== "object") return uiStatus();
  if (message.type === "bridge:connect") {
    connectNative();
    await new Promise((resolve) => setTimeout(resolve, 200));
  } else if (message.type === "bridge:allow-current") {
    const tab = await activeChromeTab();
    if (tab?.id === undefined || !isSafeWebUrl(tab.url ?? "")) {
      throw new Error("Only an ordinary http or https tab can be granted.");
    }
    tabs.grant(tab.id, null);
    await persistGrants();
    connectNative();
  } else if (message.type === "bridge:revoke") {
    tabs.revokeAll();
    refs.invalidateAll();
    detachAll();
    dialogs.clear();
    await persistGrants();
  } else if (message.type === "bridge:disconnect") {
    disconnectNative();
  }
  return uiStatus();
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id) return false;
  void handleUiMessage(message).then(
    (status) => sendResponse({ ok: true, status }),
    (error) => sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) }),
  );
  return true;
});

chrome.tabs.onRemoved.addListener((tabId) => {
  const agents = knownAgents().filter((agentId) => tabs.accessible(tabId, agentId));
  const opener = tabOpeners.get(tabId);
  for (const agentId of agents) {
    const openerHandle = opener !== undefined && tabs.accessible(opener, agentId) ? tabs.handle(agentId, opener) : undefined;
    pushBounded(noticesFor(agentId).closed, { tab: tabs.handle(agentId, tabId), opener: openerHandle ?? "owner" });
  }
  tabOpeners.delete(tabId);
  tabs.close(tabId);
  refs.invalidateTab(tabId);
  dialogs.delete(tabId);
  detachTab(tabId);
  void persistGrants();
  setBadge();
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === "loading" || typeof changeInfo.url === "string") {
    refs.invalidateTab(tabId);
    dialogs.delete(tabId);
  }
});

chrome.tabs.onCreated.addListener((tab) => {
  if (tab.id === undefined || tab.openerTabId === undefined) return;
  const opener = tabs.grants().find((grant) => grant.tabId === tab.openerTabId);
  if (!opener) return;
  tabOpeners.set(tab.id, tab.openerTabId);
  tabs.grant(tab.id, opener.ownerAgentId);
  for (const agentId of knownAgents()) {
    if (tabs.accessible(tab.id, agentId)) {
      pushBounded(noticesFor(agentId).opened, {
        tab: tabs.handle(agentId, tab.id),
        opener: tabs.handle(agentId, tab.openerTabId),
      });
    }
  }
  void persistGrants();
  setBadge();
});

chrome.debugger.onDetach.addListener((source) => {
  if (source.tabId === undefined) return;
  forgetAttachment(source.tabId);
  refs.invalidateTab(source.tabId);
  dialogs.delete(source.tabId);
});

chrome.debugger.onEvent.addListener((source, method, params) => {
  if (source.tabId === undefined || method !== "Page.javascriptDialogOpening" || !params) return;
  const tabId = source.tabId;
  const url = typeof params.url === "string" ? params.url : "";
  if (params.type === "alert") {
    for (const agentId of knownAgents()) {
      if (tabs.accessible(tabId, agentId)) {
        pushBounded(noticesFor(agentId).alerts, { tab: tabs.handle(agentId, tabId), message: String(params.message ?? "") });
      }
    }
    handleDialog(tabId, true).catch(() => undefined);
    return;
  }
  const dialog = {
    type: params.type,
    message: String(params.message ?? ""),
    ...(url ? { url } : {}),
    ...(typeof params.defaultPrompt === "string" ? { defaultPrompt: params.defaultPrompt } : {}),
  };
  dialogs.set(tabId, dialog);
});

chrome.runtime.onStartup.addListener(() => {
  void grantsReady.then(() => connectNative());
});

chrome.runtime.onInstalled.addListener(() => {
  void chrome.alarms.create("juno-native-reconnect", { periodInMinutes: 1 });
  void grantsReady.then(() => connectNative());
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "juno-native-reconnect") connectNative();
});

try {
  chrome.alarms.create("juno-native-reconnect", { periodInMinutes: 1 });
} catch {
  // Older Chrome builds still reconnect when the popup opens.
}
void grantsReady.then(() => connectNative());
