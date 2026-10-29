/* global chrome */

const elements = {
  badge: document.querySelector("#badge"),
  title: document.querySelector("#page-title"),
  url: document.querySelector("#page-url"),
  access: document.querySelector("#tab-access"),
  message: document.querySelector("#message"),
  connect: document.querySelector("#connect"),
  allow: document.querySelector("#allow"),
  revoke: document.querySelector("#revoke"),
  count: document.querySelector("#grant-count"),
};

async function request(type) {
  try {
    const response = await chrome.runtime.sendMessage({ type });
    if (!response?.ok) throw new Error(response?.error || "Juno did not respond");
    render(response.status);
    return response.status;
  } catch (error) {
    elements.message.textContent = error instanceof Error ? error.message : String(error);
    return undefined;
  }
}

function render(status) {
  if (!status) return;
  elements.badge.textContent = status.connected ? "Connected" : status.connecting ? "Connecting" : "Offline";
  elements.badge.className = `badge ${status.connected ? "online" : status.error ? "error" : ""}`;
  elements.connect.disabled = status.connected || status.connecting;
  elements.count.textContent = String(status.grants ?? 0);
  elements.revoke.disabled = !status.grants;
  elements.message.textContent = status.error || (status.connected ? "" : "Start Juno desktop to connect.");

  const tab = status.activeTab;
  if (!tab) {
    elements.title.textContent = "No current tab";
    elements.url.textContent = "";
    elements.access.textContent = "";
    elements.allow.disabled = true;
    return;
  }
  elements.title.textContent = tab.title || "Untitled tab";
  elements.url.textContent = tab.url || "";
  elements.access.textContent = tab.allowed ? "Allowed for Juno agents" : "Not allowed";
  elements.access.className = `tab-access ${tab.allowed ? "allowed" : ""}`;
  elements.allow.disabled = !tab.grantable || tab.allowed;
}

elements.connect.addEventListener("click", () => void request("bridge:connect"));
elements.allow.addEventListener("click", () => void request("bridge:allow-current"));
elements.revoke.addEventListener("click", () => void request("bridge:revoke"));

void (async () => {
  const status = await request("bridge:status");
  if (status && !status.connected && !status.connecting) await request("bridge:connect");
})();
