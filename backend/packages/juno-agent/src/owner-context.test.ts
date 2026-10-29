import { describe, expect, it } from 'vitest';
import { createMemoryStore } from './testing/store.js';
import type { Store } from './contracts/index.js';
import { OwnerScopeError, requestScopedStore, runWithOwner } from './owner-context.js';

const subscription = (id: string) => ({
  id,
  agentId: 'agent',
  conversationId: 'chat',
  filter: { source: 'github' },
  expiresAt: '2099-01-01T00:00:00Z',
  createdAt: '2026-10-08T00:00:00Z',
});

const requireLock = (store: Store): NonNullable<Store['getForUpdate']> => {
  if (typeof store.getForUpdate !== 'function') throw new Error('Store.getForUpdate is required for this test');
  return store.getForUpdate;
};

/** A base store with the lock method removed: the facade must fail loudly, never silently race. */
const withoutLock = (store: Store): Store =>
  new Proxy(store, {
    get: (target, prop) => (prop === 'getForUpdate' ? undefined : Reflect.get(target, prop)),
  });

const owned = (store: Store, owner: string): Store => {
  if (typeof store.forOwner !== 'function') throw new Error('Store.forOwner is required for this test');
  return store.forOwner(owner);
};

describe('requestScopedStore row-lock forwarding', () => {
  it('locks and writes through the owner scope', async () => {
    const base = createMemoryStore();
    await owned(base, 'alice').put('subscriptions', subscription('waiting'));
    const facade = requestScopedStore(base);
    await runWithOwner('alice', () =>
      facade.tx(async (tx) => {
        const row = await requireLock(tx)('subscriptions', 'waiting');
        expect(row?.id).toBe('waiting');
        await tx.patch('subscriptions', 'waiting', { event: { id: 'event' } });
      }),
    );
    expect((await owned(base, 'alice').get('subscriptions', 'waiting'))?.event).toEqual({ id: 'event' });
  });

  it('keeps the owner boundary on locked reads', async () => {
    const base = createMemoryStore();
    await owned(base, 'bob').put('subscriptions', subscription('waiting'));
    const facade = requestScopedStore(base);
    await runWithOwner('alice', () =>
      facade.tx(async (tx) => {
        expect(await requireLock(tx)('subscriptions', 'waiting')).toBeNull();
      }),
    );
    expect(await owned(base, 'bob').get('subscriptions', 'waiting')).not.toBeNull();
  });

  it('serializes concurrent locked sections on one row', async () => {
    const base = createMemoryStore();
    await owned(base, 'alice').put('subscriptions', subscription('waiting'));
    const facade = requestScopedStore(base);
    const order: string[] = [];
    const critical = async (name: string): Promise<void> =>
      runWithOwner('alice', () =>
        facade.tx(async (tx) => {
          await requireLock(tx)('subscriptions', 'waiting');
          order.push(name + '-in');
          await new Promise((resolve) => setTimeout(resolve, 30));
          order.push(name + '-out');
        }),
      );
    await Promise.all([critical('a'), critical('b')]);
    expect(order).toEqual(['a-in', 'a-out', 'b-in', 'b-out']);
  });

  it('refuses locked access when the underlying store has no lock', async () => {
    const facade = requestScopedStore(withoutLock(createMemoryStore()));
    await expect(facade.getForUpdate?.('subscriptions', 'waiting')).rejects.toThrow(OwnerScopeError);
  });

  it('still requires a transaction on the facade', async () => {
    const facade = requestScopedStore(createMemoryStore());
    await expect(facade.getForUpdate?.('subscriptions', 'waiting')).rejects.toThrow(/transaction/);
  });
});
