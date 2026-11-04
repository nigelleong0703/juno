/**
 * The Slack Web API base. `SLACK_API_BASE_URL` points it at a stand-in (the e2e stack's fake Slack, tests/e2e/harness/slack.ts), the same
 * kind of knob as COMPOSIO_BASE_URL; unset, it is Slack itself. Read per call, so a test can set it late.
 */
export const slackApiBase = (): string => (process.env['SLACK_API_BASE_URL'] ?? 'https://slack.com/api').replace(/\/+$/, '') + '/';
