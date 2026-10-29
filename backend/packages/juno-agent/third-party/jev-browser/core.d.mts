export interface Element { i: number; tag: string; text?: string; label?: string; value?: string; readonly?: boolean; checked?: boolean; disabled?: boolean; options?: string[]; [key: string]: unknown }
export interface Page { url: string; title: string; text: string; elements: Element[]; metrics: Record<string, unknown>; [key: string]: unknown }
export interface Action { tool: string; target?: number | null; value?: string; valueKey?: string; key?: string; destination?: number; el?: Element; [key: string]: unknown }
export interface Question { type: 'noul' | 'choice'; instructions: string; criteria?: Record<string, string | null> }
export interface GoalResult { status: string; goal: string; url: string; title: string; actions: unknown[]; rounds: unknown[]; done_score: number; jev_calls: number; ms: number; [key: string]: unknown }
export class UpstreamGoalSession {
  stats: { calls: number; jev_ms: number; tokens: number };
  events: string[];
  page: { url(): string; title(): Promise<string> };
  lastPage?: Page;
  shown?: Page;
  heldDialog: { message: string; p_irreversible: number } | null;
  highlight: boolean;
  snapshot: () => Promise<Page>;
  settle: (options?: unknown) => Promise<void>;
  webmcpTools: () => Promise<never[]>;
  extractBlocks: () => Promise<{ url: string; title: string; blocks: Array<{ text: string; tag?: string }>; truncated: boolean }>;
  act: (action: Action) => Promise<number>;
  call: (state: unknown, questions: Record<string, Question>) => Promise<{ answers: Record<string, unknown>; ms: number; tokens: number }>;
  redact(state: unknown): unknown;
  runGoal(goal: string, options?: { values?: Record<string, string>; maxActions?: number }): Promise<GoalResult>;
  check(question: string): Promise<number>;
  read(question: string): Promise<Record<string, unknown>>;
  decide(page: Page, goal: string, values: Record<string,string>, history: unknown[], change?: unknown): Promise<Record<string, unknown>>;
}
