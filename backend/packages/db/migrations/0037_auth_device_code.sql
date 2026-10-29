-- 0037_auth_device_code: Better Auth device-authorization table (a watch shows a code, the signed-in phone approves it).
-- Generated from packages/api/src/account-auth.ts buildAccountAuthOptions via better-auth 1.7.7 getSchema. Additive only.

CREATE TABLE IF NOT EXISTS "auth_deviceCode" (
  "id" text PRIMARY KEY NOT NULL,
  "deviceCode" text NOT NULL,
  "userCode" text NOT NULL,
  "userId" text,
  "expiresAt" timestamptz NOT NULL,
  "status" text NOT NULL,
  "lastPolledAt" timestamptz,
  "pollingInterval" integer,
  "clientId" text,
  "scope" text
);
CREATE UNIQUE INDEX IF NOT EXISTS "auth_deviceCode_deviceCode_uidx" ON "auth_deviceCode" ("deviceCode");
CREATE UNIQUE INDEX IF NOT EXISTS "auth_deviceCode_userCode_uidx" ON "auth_deviceCode" ("userCode");
