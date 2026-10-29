/** Small shared helpers for the platform pieces: loose JSON reading and a GET that never throws. */

export function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

export function str(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/** One JSON call that never throws: a transport failure is status 0; an empty body (Discord's 204) reads as `{}`. */
export async function sendJson(
  fetchFn: typeof fetch,
  method: 'POST' | 'PUT' | 'DELETE',
  url: string,
  headers: Record<string, string>,
  body?: Record<string, unknown>,
): Promise<{ status: number; ok: boolean; body: Record<string, unknown> }> {
  try {
    const response = await fetchFn(url, {
      method,
      headers: body === undefined ? headers : { ...headers, 'content-type': 'application/json; charset=utf-8' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, ok: response.ok, body: record(await response.json().catch(() => null)) };
  } catch {
    return { status: 0, ok: false, body: {} };
  }
}

export async function getJson(fetchFn: typeof fetch, url: string, headers: Record<string, string>): Promise<Record<string, unknown> | unknown[] | undefined> {
  try {
    const response = await fetchFn(url, { headers });
    if (!response.ok) return undefined;
    const body: unknown = await response.json().catch(() => null);
    return Array.isArray(body) ? body : typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}
