/** A recording stand-in for the durable runner, for tests of what the enqueuer hands it. */
import { TimeoutError, type Runner, type Target } from '@agent-desktop/durable';

export interface StubCall { method: string; target?: Target; opts?: unknown }

export class RunnerStub {
  calls: StubCall[] = [];
  /** Makes the next calls fail with this error. */
  failWith: Error | undefined;
  /** What `invoke` answers; 'timeout' makes it time out. */
  answer: unknown = { accepted: true };

  async sendTo(target: Target, opts?: unknown): Promise<void> {
    this.calls.push({ method: 'sendTo', target, opts });
    if (this.failWith) throw this.failWith;
  }

  async invoke(target: Target, opts?: unknown): Promise<unknown> {
    this.calls.push({ method: 'invoke', target, opts });
    if (this.failWith) throw this.failWith;
    if (this.answer === 'timeout') throw new TimeoutError(50);
    return this.answer;
  }

  async resolveAwakeable(id: string, value: unknown): Promise<boolean> {
    this.calls.push({ method: 'resolveAwakeable', opts: { id, value } });
    if (this.failWith) throw this.failWith;
    return true;
  }

  async isLive(): Promise<boolean> {
    return false;
  }

  asRunner(): Runner {
    return this as unknown as Runner;
  }
}
