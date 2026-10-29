import type { ModelProvidersApi } from '../contracts.js';
import {
  builtinModelProviderListSchema,
  chatgptLoginStartResultSchema,
  chatgptLoginStatusSchema,
  modelCatalogSchema,
  modelProviderListSchema,
  modelProviderSchema,
} from '../contracts.js';
import type { HttpTransport } from './transport.js';

/** The owner's model providers and ChatGPT sign-in. */
export function createModelProvidersApi(http: HttpTransport): ModelProvidersApi {
  return {
    list: () => http.request('/v1/model-providers', 'GET', undefined, modelProviderListSchema),
    builtin: () => http.request('/v1/model-providers/builtin', 'GET', undefined, builtinModelProviderListSchema),
    create: (input) => http.request('/v1/model-providers', 'POST', input, modelProviderSchema),
    update: (id, patch) => http.request(`/v1/model-providers/${encodeURIComponent(id)}`, 'PATCH', patch, modelProviderSchema),
    async delete(id) {
      await http.request(`/v1/model-providers/${encodeURIComponent(id)}`, 'DELETE');
    },
    models: (id) => http.request(`/v1/model-providers/${encodeURIComponent(id)}/models`, 'GET', undefined, modelCatalogSchema),
    startChatGPTLogin: () => http.request('/v1/model-providers/chatgpt/login', 'POST', {}, chatgptLoginStartResultSchema),
    completeChatGPTLogin: (input) => http.request('/v1/model-providers/chatgpt/complete', 'POST', input, modelProviderSchema),
    chatGPTLoginStatus: (loginId) => http.request(`/v1/model-providers/chatgpt/login/${encodeURIComponent(loginId)}`, 'GET', undefined, chatgptLoginStatusSchema),
    async cancelChatGPTLogin(loginId) {
      await http.request(`/v1/model-providers/chatgpt/login/${encodeURIComponent(loginId)}`, 'DELETE');
    },
  };
}
