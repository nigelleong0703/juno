const REF = /^mac_e[1-9][0-9]*$/;

/** Agent-local refs carry tab, frame and loader ids so a reloaded or other tab cannot be operated. */
export class RefRegistry {
  #agents = new Map();

  #agent(agentId) {
    let state = this.#agents.get(agentId);
    if (!state) {
      state = { next: 1, refs: new Map() };
      this.#agents.set(agentId, state);
    }
    return state;
  }

  /** A new snapshot invalidates every old ref on that tab for this agent and never reuses refs. */
  capture(agentId, tabId, tabHandle, items) {
    const state = this.#agent(agentId);
    for (const [ref, record] of state.refs) {
      if (record.tabId === tabId) state.refs.delete(ref);
    }
    return items.map((item) => {
      const ref = `mac_e${state.next++}`;
      state.refs.set(ref, { ...item, ref, tabId, tabHandle, agentId });
      return ref;
    });
  }

  resolve(agentId, ref) {
    if (typeof ref !== "string" || !REF.test(ref)) throw new Error(`invalid browser ref: ${String(ref)}`);
    const record = this.#agents.get(agentId)?.refs.get(ref);
    if (!record) throw new Error(`unknown or stale ref ${ref}; take a fresh snapshot`);
    return { ...record };
  }

  invalidateTab(tabId) {
    for (const state of this.#agents.values()) {
      for (const [ref, record] of state.refs) {
        if (record.tabId === tabId) state.refs.delete(ref);
      }
    }
  }

  invalidateAll() {
    for (const state of this.#agents.values()) state.refs.clear();
  }
}
