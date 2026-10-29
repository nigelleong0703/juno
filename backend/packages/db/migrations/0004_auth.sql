-- 0004_auth: Better Auth tables (email/password + bearer sessions).
-- Generated from apps/agentd/src/account-auth.ts buildAccountAuthOptions via
-- better-auth 1.7.7 getSchema; do not hand-edit. Additive only; existing tables untouched.

CREATE TABLE IF NOT EXISTS "auth_user" (
  "id" text PRIMARY KEY NOT NULL,
  "name" text NOT NULL,
  "email" text NOT NULL UNIQUE,
  "emailVerified" boolean NOT NULL,
  "image" text,
  "createdAt" timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS "auth_session" (
  "id" text PRIMARY KEY NOT NULL,
  "expiresAt" timestamptz NOT NULL,
  "token" text NOT NULL UNIQUE,
  "createdAt" timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" timestamptz NOT NULL,
  "ipAddress" text,
  "userAgent" text,
  "userId" text NOT NULL REFERENCES "auth_user"("id") ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS "auth_session_userId_idx" ON "auth_session" ("userId");

CREATE TABLE IF NOT EXISTS "auth_account" (
  "id" text PRIMARY KEY NOT NULL,
  "accountId" text NOT NULL,
  "providerId" text NOT NULL,
  "userId" text NOT NULL REFERENCES "auth_user"("id") ON DELETE CASCADE,
  "accessToken" text,
  "refreshToken" text,
  "idToken" text,
  "accessTokenExpiresAt" timestamptz,
  "refreshTokenExpiresAt" timestamptz,
  "scope" text,
  "password" text,
  "createdAt" timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS "auth_account_userId_idx" ON "auth_account" ("userId");

CREATE TABLE IF NOT EXISTS "auth_verification" (
  "id" text PRIMARY KEY NOT NULL,
  "identifier" text NOT NULL,
  "value" text NOT NULL,
  "expiresAt" timestamptz NOT NULL,
  "createdAt" timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS "auth_verification_identifier_idx" ON "auth_verification" ("identifier");

