export interface TabGrant {
  tabId: number;
  ownerAgentId: string | null;
}

export class TabScope {
  grant(tabId: number, ownerAgentId?: string | null): void;
  grantCount(): number;
  grants(): TabGrant[];
  accessible(tabId: number, agentId: string): boolean;
  handle(agentId: string, tabId: number): string;
  resolve(agentId: string, handle: string): number;
  accessibleTabs(agentId: string): Array<{ tabId: number; handle: string }>;
  activeTab(agentId: string): number | undefined;
  setActive(agentId: string, tabId: number): void;
  close(tabId: number): void;
  revokeAll(): void;
}
