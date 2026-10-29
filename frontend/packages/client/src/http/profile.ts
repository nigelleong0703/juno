import type { ProfileApi } from '../contracts.js';
import { profileSchema } from '../contracts.js';
import type { HttpTransport } from './transport.js';

/** The account profile: a flat list of key/value details the agents may fill into pages. */
export function createProfileApi(http: HttpTransport): ProfileApi {
  return {
    get: () => http.request('/v1/profile', 'GET', undefined, profileSchema),
    put: (input) => http.request('/v1/profile', 'PUT', input, profileSchema),
  };
}
