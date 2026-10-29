/** Per-agent handles over tabs the owner explicitly granted, plus tabs that agent opened. */
export class TabScope {
  #grants = new Map();
  #agents = new Map();

  #agent(agentId) {
    let state = this.#agents.get(agentId);
    if (!state) {
      state = { handles: new Map(), active: undefined };
      this.#agents.set(agentId, state);
    }
    return state;
  }

  grant(tabId, ownerAgentId = null) {
    if (!Number.isInteger(tabId) || tabId < 0) throw new Error("tab id must be a non-negative integer");
    this.#grants.set(tabId, ownerAgentId);
  }

  grantCount() {
    return this.#grants.size;
  }

  grants() {
    return [...this.#grants.entries()].map(([tabId, ownerAgentId]) => ({ tabId, ownerAgentId }));
  }

  accessible(tabId, agentId) {
    if (!this.#grants.has(tabId)) return false;
    const owner = this.#grants.get(tabId);
    return owner === null || owner === agentId;
  }

  handle(agentId, tabId) {
    if (!this.accessible(tabId, agentId)) throw new Error("tab is not granted to this agent");
    const state = this.#agent(agentId);
    for (const [handle, owned] of state.handles) {
      if (owned === tabId) return handle;
    }
    const handle = `mt${tabId.toString(36)}`;
    if (handle.length > 16) throw new Error("Mac tab handle exceeds the browser contract limit");
    state.handles.set(handle, tabId);
    if (state.active === undefined) state.active = tabId;
    return handle;
  }

  resolve(agentId, handle) {
    if (typeof handle !== "string" || !/^mt[0-9a-z]{1,13}$/.test(handle)) {
      throw new Error(`invalid Mac tab handle: ${String(handle)}`);
    }
    const tabId = this.#agents.get(agentId)?.handles.get(handle);
    if (tabId === undefined || !this.accessible(tabId, agentId)) {
      throw new Error(`unknown or revoked tab handle: ${String(handle)}`);
    }
    return tabId;
  }

  accessibleTabs(agentId) {
    return [...this.#grants.entries()]
      .filter(([, owner]) => owner === null || owner === agentId)
      .map(([tabId]) => ({ tabId, handle: this.handle(agentId, tabId) }));
  }

  activeTab(agentId) {
    const state = this.#agent(agentId);
    if (state.active !== undefined && this.accessible(state.active, agentId)) return state.active;
    const first = this.accessibleTabs(agentId)[0];
    state.active = first?.tabId;
    return state.active;
  }

  setActive(agentId, tabId) {
    if (!this.accessible(tabId, agentId)) throw new Error("tab is not granted to this agent");
    this.handle(agentId, tabId);
    this.#agent(agentId).active = tabId;
  }

  close(tabId) {
    this.#grants.delete(tabId);
    for (const state of this.#agents.values()) {
      for (const [handle, owned] of state.handles) {
        if (owned === tabId) state.handles.delete(handle);
      }
      if (state.active === tabId) state.active = undefined;
    }
  }

  revokeAll() {
    this.#grants.clear();
    for (const state of this.#agents.values()) {
      state.handles.clear();
      state.active = undefined;
    }
  }
}
