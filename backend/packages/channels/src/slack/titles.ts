/** "#general" for a Slack channel id, or undefined when the lookup fails. */
export async function slackChannelName(fetchFn: typeof fetch, token: string, chatId: string): Promise<string | undefined> {
  try {
    const response = await fetchFn('https://slack.com/api/conversations.info', {
      method: 'POST',
      headers: { authorization: 'Bearer ' + token, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ channel: chatId }).toString(),
    });
    const payload: unknown = await response.json().catch(() => null);
    const record = typeof payload === 'object' && payload !== null ? (payload as Record<string, unknown>) : {};
    const channel = record['ok'] === true && typeof record['channel'] === 'object' && record['channel'] !== null ? (record['channel'] as Record<string, unknown>) : {};
    return typeof channel['name'] === 'string' && channel['name'] !== '' ? '#' + channel['name'] : undefined;
  } catch {
    return undefined;
  }
}
