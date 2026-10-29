import { describe, expect, it } from 'vitest';
import { newSpaceId, pickPort, spaceSlug } from '../tools/spacePublish.js';

describe('space_publish pure rules', () => {
  it('takes only /workspace/spaces/<slug> as an app folder', () => {
    expect(spaceSlug('/workspace/spaces/trip-planner')).toBe('trip-planner');
    expect(spaceSlug('/workspace/spaces/trip-planner/')).toBe('trip-planner');
    expect(spaceSlug('/workspace/spaces/a/../b')).toBe('b');
    for (const bad of ['/workspace/spaces', '/workspace/spaces/a/b', '/workspace/other/a', '/workspace/spaces/../x', '/workspace/spaces/Upper', '/workspace/spaces/-dash', '/workspace/spaces/a b', 'spaces/a', '/etc/spaces/a']) expect(spaceSlug(bad)).toBeUndefined();
  });

  it('picks the lowest free port in the app range and reports a full range', () => {
    expect(pickPort(new Set())).toBe(7100);
    expect(pickPort(new Set([7100, 7101, 7103]))).toBe(7102);
    expect(pickPort(new Set(Array.from({ length: 900 }, (_, index) => 7100 + index)))).toBeUndefined();
  });

  it('makes ids that are valid DNS labels and do not repeat', () => {
    const ids = new Set(Array.from({ length: 50 }, newSpaceId));
    expect(ids.size).toBe(50);
    for (const id of ids) expect(id).toMatch(/^sp[0-9a-f]{24}$/);
  });
});
