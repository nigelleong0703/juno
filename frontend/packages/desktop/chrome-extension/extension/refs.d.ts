export interface RefItem {
  frameId: string;
  loaderId: string;
  backendNodeId: number;
  role?: string;
  name?: string;
}

export interface RefRecord extends RefItem {
  ref: string;
  tabId: number;
  tabHandle: string;
  agentId: string;
}

export class RefRegistry {
  capture(agentId: string, tabId: number, tabHandle: string, items: RefItem[]): string[];
  resolve(agentId: string, ref: string): RefRecord;
  invalidateTab(tabId: number): void;
  invalidateAll(): void;
}
