/**
 * Where the Mac's own Stop meets the control gateway (BACKEND 7.8b). The daemon on the Mac tells the hub when the person presses Stop
 * or resumes (`FrameType.CONTROL`; the Chrome extension's "Stop all tab access" is the same press, made through the desktop app), and
 * the hub asks what the gateway says when a Mac connects. Only the Mac itself can resume: a resume reaches the gateway as `mac-local`.
 */
import type { ControlGateway } from '../control/gateway.js';
import type { LinkHubOptions } from '@agent-desktop/sandbox-adapters';
import type { MacRegistry } from './registry.js';

export function createMacControlLink(options: {
  registry: MacRegistry;
  control(owner: string): ControlGateway;
  log?: (fields: Record<string, unknown>, message: string) => void;
}): Required<Pick<LinkHubOptions, 'onControl' | 'controlOf'>> {
  const surface = (linkId: string) => ({ kind: 'mac', macId: linkId }) as const;
  return {
    onControl(linkId, body) {
      const owner = options.registry.ownerOf(linkId);
      if (owner === undefined) return;
      const gateway = options.control(owner);
      const done = body.holder === 'stopped'
        ? gateway.stop(surface(linkId), { via: 'mac-local' }, { ...(body.cancelled ? { cancelled: body.cancelled } : {}) })
        : gateway.resume(surface(linkId), { via: 'mac-local' });
      done.catch((error: unknown) => options.log?.({ err: error, linkId }, 'could not record the Mac stop state'));
    },
    async controlOf(linkId) {
      const owner = options.registry.ownerOf(linkId);
      return owner === undefined ? undefined : (await options.control(owner).get(surface(linkId))).holder;
    },
  };
}
