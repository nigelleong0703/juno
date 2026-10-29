import { defineConfig } from 'vitest/config';

// E39: production config has no built-in credentials, so the token-mode test app gets explicit ones here.
export default defineConfig({
  test: {
    env: {
      API_TOKEN: 'dev-token',
      OWNER_ID: 'member-robin',
      COMPUTERD_TOKEN: 'test-computerd-token',
      SCREEN_TICKET_SECRET: 'test-screen-ticket-secret',
    },
  },
});
