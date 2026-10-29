import type {
  ComputersApi,
  ControlOptions,
  ComputersListParams,
  EnsureComputerInput,
  ScreenClipboardPaste,
  StreamScreenOptions,
} from '../contracts.js';
import type { Id } from '../contracts.js';
import {
  computerSchema,
  macPairingSchema,
  computerRuntimeSchema,
  macStatusSchema,
  screenClipboardPasteResultSchema,
  screenClipboardSchema,
  screenElementsSchema,
  screenResponseSchema,
  screenScreenshotSchema,
  screenStreamTicketSchema,
} from '../contracts.js';
import { normalizeScreenStreamTicket } from './screen-ticket.js';
import { hasStatus } from './transport.js';
import type { HttpTransport } from './transport.js';

/** The epoch the caller saw, as the header the server compares with the screen's current one. */
const epochHeader = (options?: ControlOptions): Record<string, string> | undefined =>
  options?.expectEpoch === undefined ? undefined : { 'x-expect-epoch': String(options.expectEpoch) };

/** Computers and the per-agent screens allocated inside them. */
export function createComputersApi(http: HttpTransport): ComputersApi {
  return {
    async list(params?: ComputersListParams) {
      const q = new URLSearchParams();
      if (params?.limit) q.set('limit', String(params.limit));
      if (params?.cursor) q.set('cursor', params.cursor);
      return http.list(`/v1/computers?${q.toString()}`, computerSchema);
    },

    async get(id: Id) {
      const data = await http.request(`/v1/computers/${id}`, 'GET');
      return http.parse(computerSchema, data);
    },

    async takeOver(id: Id) {
      const data = await http.request(`/v1/computers/${id}/take-over`, 'POST');
      return http.parse(computerSchema, data);
    },

    async returnControl(id: Id) {
      const data = await http.request(`/v1/computers/${id}/return-control`, 'POST');
      return http.parse(computerSchema, data);
    },

    async pause(id: Id) {
      const data = await http.request(`/v1/computers/${id}/pause`, 'POST');
      return http.parse(computerSchema, data);
    },

    async resume(id: Id) {
      const data = await http.request(`/v1/computers/${id}/resume`, 'POST');
      return http.parse(computerSchema, data);
    },

    async reboot(id: Id) {
      const data = await http.request(`/v1/computers/${id}/reboot`, 'POST');
      return http.parse(computerSchema, data);
    },

    async reset(id: Id) {
      const data = await http.request(`/v1/computers/${id}/reset`, 'POST');
      return http.parse(computerSchema, data);
    },

    async setIdlePause(id: Id, minutes: number) {
      const data = await http.request(`/v1/computers/${id}/idle-pause`, 'POST', { minutes });
      return http.parse(computerSchema, data);
    },

    async ensure(input?: EnsureComputerInput) {
      const data = await http.request(`/v1/computers/ensure`, 'POST', input ?? {});
      return http.parse(computerSchema, data);
    },

    async screens(computerId: Id) {
      return http.list(`/v1/computers/${computerId}/screens`, screenResponseSchema);
    },

    async screen(computerId: Id, agentId: Id) {
      try {
        const data = await http.request(
          `/v1/computers/${computerId}/agents/${agentId}/screen`,
          'GET',
        );
        return http.parse(screenResponseSchema, data);
      } catch (error) {
        // A brand-new agent has no display yet; the API reports that as 404 `no_screen`.
        if (hasStatus(error, 404)) return null;
        throw error;
      }
    },

    async allocateScreen(computerId: Id, agentId: Id) {
      const data = await http.request(`/v1/computers/${computerId}/screens`, 'POST', {
        agentId,
      });
      return http.parse(screenResponseSchema, data);
    },

    async streamScreen(screenId: Id, options?: StreamScreenOptions) {
      const data = await http.request(`/v1/screens/${screenId}/stream`, 'POST', {
        ...(options?.control !== undefined ? { control: options.control } : {}),
      });
      return normalizeScreenStreamTicket(
        http.parse(screenStreamTicketSchema, data),
        screenId,
        http.baseUrl,
      );
    },

    async screenshot(screenId: Id) {
      const data = await http.request(`/v1/screens/${screenId}/screenshot`, 'GET');
      return http.parse(screenScreenshotSchema, data);
    },

    takeOverScreen(screenId: Id, options?: ControlOptions) {
      return http.request(`/v1/screens/${screenId}/take-over`, 'POST', undefined, screenResponseSchema, epochHeader(options));
    },

    async screenElements(screenId: Id) {
      return http.parse(screenElementsSchema, await http.request(`/v1/screens/${screenId}/elements`, 'GET'));
    },

    async pasteScreenClipboard(screenId: Id, input: ScreenClipboardPaste) {
      return http.parse(screenClipboardPasteResultSchema, await http.request(`/v1/screens/${screenId}/clipboard`, 'POST', input));
    },

    async copyScreenClipboard(screenId: Id) {
      return http.parse(screenClipboardSchema, await http.request(`/v1/screens/${screenId}/clipboard`, 'GET'));
    },

    returnControlScreen(screenId: Id, options?: ControlOptions) {
      return http.request(`/v1/screens/${screenId}/return-control`, 'POST', undefined, screenResponseSchema, epochHeader(options));
    },

    async runtime() {
      return http.parse(computerRuntimeSchema, await http.request('/v1/computers/runtime', 'GET'));
    },

    async myMac() {
      return http.parse(macStatusSchema, await http.request('/v1/computers/my-mac', 'GET'));
    },

    async pairMyMac(input) {
      return http.parse(macPairingSchema, await http.request('/v1/computers/my-mac', 'POST', input ?? {}));
    },

    async unpairMyMac() {
      return http.parse(macStatusSchema, await http.request('/v1/computers/my-mac', 'DELETE'));
    },

    async stopMyMac() {
      return http.parse(macStatusSchema, await http.request('/v1/computers/my-mac/stop', 'POST'));
    },
  };
}

