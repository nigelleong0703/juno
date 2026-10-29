import type { ArtifactPart, ArtifactsApi, Id } from '../contracts.js';
import { artifactSchema, artifactVersionSchema, fileDownloadSchema } from '../contracts.js';
import type { HttpTransport } from './transport.js';
import { z } from 'zod';

const renderUrlSchema = z.object({ url: z.string().min(1), expiresAt: z.string().min(1) });

/** Published artifacts (BACKEND §5.11): versions, version bytes and the signed URL of an HTML page. */
export function createArtifactsApi(http: HttpTransport): ArtifactsApi {
  return {
    async get(id: Id) {
      return http.parse(artifactSchema, await http.request(`/v1/artifacts/${id}`, 'GET'));
    },

    async version(id: Id, version: number) {
      return http.parse(artifactVersionSchema, await http.request(`/v1/artifacts/${id}/versions/${version}`, 'GET'));
    },

    async download(id: Id, version: number, part: ArtifactPart = 'file') {
      const data = await http.request(`/v1/artifacts/${id}/versions/${version}/download?part=${part}`, 'GET');
      return http.parse(fileDownloadSchema, data);
    },

    async renderUrl(id: Id, version: number) {
      return http.parse(renderUrlSchema, await http.request(`/v1/artifacts/${id}/versions/${version}/render-url`, 'POST'));
    },
  };
}
