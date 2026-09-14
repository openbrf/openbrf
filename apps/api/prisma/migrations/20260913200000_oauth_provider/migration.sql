-- The OAuth 2.1 provider's own tables.
--
-- Eight tables, all of them the library's: this is the shape jwt(), mcp() and
-- cimd() declare, emitted by the generator rather than designed here. The model
-- names in schema.prisma are the library's too and are load-bearing, because
-- the adapter reaches a delegate as db[model]. Only the table names are ours,
-- under the auth_ prefix the other authentication tables already carry. No
-- domain column appears in any of them; the person behind an account is reached
-- through auth_user.personId.
--
-- Service tier, deliberately. No append-only trigger, no no-truncate trigger,
-- and no line in sql/harden-runtime-role.sql, unlike the statutory tables. A
-- token table that cannot be deleted from cannot be revoked from, and cutting a
-- connection off at once is the whole point of holding opaque tokens rather
-- than issuing self-contained ones. What a token did is recorded in
-- audit_log_entry, which is append-only and carries both the channel the change
-- arrived through and, in its context, the client that acted.
--
-- One foreign key deviates from what the generator emitted, and it is the
-- reason this file is hand-kept rather than regenerated. auth_oauth_client
-- .userId records who registered a client, and the library cascades it. Every
-- other table here reaches a client by clientId and cascades, so deleting one
-- client row takes every member's consents and tokens for that client with it,
-- along with its resource link. Erasing the single person who happened to be
-- recorded as the registrant would therefore disconnect the app for everybody
-- else, with no audit entry and no board decision behind it. The column is
-- nullable, so ON DELETE SET NULL is available and a client registered by hand
-- leaves it null in any case. The three that genuinely belong to one person -
-- auth_oauth_access_token, auth_oauth_refresh_token and auth_oauth_consent -
-- keep ON DELETE CASCADE, which is what makes the single delete of auth_user in
-- the purge erase them all.
-- CreateTable
CREATE TABLE "auth_jwks" (
    "id" TEXT NOT NULL,
    "publicKey" TEXT NOT NULL,
    "privateKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL,
    "expiresAt" TIMESTAMP(3),
    "alg" TEXT,
    "crv" TEXT,

    CONSTRAINT "auth_jwks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "auth_oauth_client" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "clientSecret" TEXT,
    "clientDiscoveryId" TEXT,
    "disabled" BOOLEAN DEFAULT false,
    "skipConsent" BOOLEAN,
    "enableEndSession" BOOLEAN,
    "subjectType" TEXT,
    "scopes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "clientCredentialsScopes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "userId" TEXT,
    "createdAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3),
    "name" TEXT,
    "uri" TEXT,
    "icon" TEXT,
    "contacts" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "tos" TEXT,
    "policy" TEXT,
    "softwareId" TEXT,
    "softwareVersion" TEXT,
    "softwareStatement" TEXT,
    "redirectUris" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "postLogoutRedirectUris" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "backchannelLogoutUri" TEXT,
    "backchannelLogoutSessionRequired" BOOLEAN,
    "tokenEndpointAuthMethod" TEXT,
    "applicationType" TEXT,
    "jwks" TEXT,
    "jwksUri" TEXT,
    "grantTypes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "responseTypes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "requirePKCE" BOOLEAN,
    "dpopBoundAccessTokens" BOOLEAN DEFAULT false,
    "referenceId" TEXT,
    "metadata" JSONB,

    CONSTRAINT "auth_oauth_client_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "auth_oauth_resource" (
    "id" TEXT NOT NULL,
    "identifier" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "accessTokenTtl" INTEGER,
    "refreshTokenTtl" INTEGER,
    "signingAlgorithm" TEXT,
    "signingKeyId" TEXT,
    "allowedScopes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "customClaims" JSONB,
    "dpopBoundAccessTokensRequired" BOOLEAN DEFAULT false,
    "disabled" BOOLEAN DEFAULT false,
    "createdAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3),
    "policyVersion" INTEGER DEFAULT 1,
    "metadata" JSONB,

    CONSTRAINT "auth_oauth_resource_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "auth_oauth_client_resource" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "resourceId" TEXT NOT NULL,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3),

    CONSTRAINT "auth_oauth_client_resource_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "auth_oauth_refresh_token" (
    "id" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "sessionId" TEXT,
    "userId" TEXT NOT NULL,
    "referenceId" TEXT,
    "authorizationCodeId" TEXT,
    "resources" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "requestedUserInfoClaims" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "scopes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL,
    "revoked" TIMESTAMP(3),
    "rotatedAt" TIMESTAMP(3),
    "rotationReplayResponse" TEXT,
    "rotationReplayExpiresAt" TIMESTAMP(3),
    "authTime" TIMESTAMP(3),
    "confirmation" JSONB,

    CONSTRAINT "auth_oauth_refresh_token_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "auth_oauth_access_token" (
    "id" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "sessionId" TEXT,
    "userId" TEXT,
    "referenceId" TEXT,
    "authorizationCodeId" TEXT,
    "resources" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "requestedUserInfoClaims" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "scopes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "refreshId" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL,
    "revoked" TIMESTAMP(3),
    "confirmation" JSONB,

    CONSTRAINT "auth_oauth_access_token_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "auth_oauth_consent" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "userId" TEXT,
    "referenceId" TEXT,
    "resources" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "requestedUserInfoClaims" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "scopes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "auth_oauth_consent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "auth_oauth_client_assertion" (
    "id" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "auth_oauth_client_assertion_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "auth_oauth_client_clientId_key" ON "auth_oauth_client"("clientId");

-- CreateIndex
CREATE INDEX "auth_oauth_client_userId_idx" ON "auth_oauth_client"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "auth_oauth_resource_identifier_key" ON "auth_oauth_resource"("identifier");

-- CreateIndex
CREATE INDEX "auth_oauth_client_resource_clientId_idx" ON "auth_oauth_client_resource"("clientId");

-- CreateIndex
CREATE INDEX "auth_oauth_client_resource_resourceId_idx" ON "auth_oauth_client_resource"("resourceId");

-- CreateIndex
CREATE UNIQUE INDEX "auth_oauth_client_resource_clientId_resourceId_key" ON "auth_oauth_client_resource"("clientId", "resourceId");

-- CreateIndex
CREATE UNIQUE INDEX "auth_oauth_refresh_token_token_key" ON "auth_oauth_refresh_token"("token");

-- CreateIndex
CREATE INDEX "auth_oauth_refresh_token_clientId_idx" ON "auth_oauth_refresh_token"("clientId");

-- CreateIndex
CREATE INDEX "auth_oauth_refresh_token_sessionId_idx" ON "auth_oauth_refresh_token"("sessionId");

-- CreateIndex
CREATE INDEX "auth_oauth_refresh_token_userId_idx" ON "auth_oauth_refresh_token"("userId");

-- CreateIndex
CREATE INDEX "auth_oauth_refresh_token_authorizationCodeId_idx" ON "auth_oauth_refresh_token"("authorizationCodeId");

-- CreateIndex
CREATE UNIQUE INDEX "auth_oauth_access_token_token_key" ON "auth_oauth_access_token"("token");

-- CreateIndex
CREATE INDEX "auth_oauth_access_token_clientId_idx" ON "auth_oauth_access_token"("clientId");

-- CreateIndex
CREATE INDEX "auth_oauth_access_token_sessionId_idx" ON "auth_oauth_access_token"("sessionId");

-- CreateIndex
CREATE INDEX "auth_oauth_access_token_userId_idx" ON "auth_oauth_access_token"("userId");

-- CreateIndex
CREATE INDEX "auth_oauth_access_token_authorizationCodeId_idx" ON "auth_oauth_access_token"("authorizationCodeId");

-- CreateIndex
CREATE INDEX "auth_oauth_access_token_refreshId_idx" ON "auth_oauth_access_token"("refreshId");

-- CreateIndex
CREATE INDEX "auth_oauth_consent_clientId_idx" ON "auth_oauth_consent"("clientId");

-- CreateIndex
CREATE INDEX "auth_oauth_consent_userId_idx" ON "auth_oauth_consent"("userId");

-- AddForeignKey
ALTER TABLE "auth_oauth_client" ADD CONSTRAINT "auth_oauth_client_userId_fkey" FOREIGN KEY ("userId") REFERENCES "auth_user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "auth_oauth_client_resource" ADD CONSTRAINT "auth_oauth_client_resource_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "auth_oauth_client"("clientId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "auth_oauth_client_resource" ADD CONSTRAINT "auth_oauth_client_resource_resourceId_fkey" FOREIGN KEY ("resourceId") REFERENCES "auth_oauth_resource"("identifier") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "auth_oauth_refresh_token" ADD CONSTRAINT "auth_oauth_refresh_token_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "auth_oauth_client"("clientId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "auth_oauth_refresh_token" ADD CONSTRAINT "auth_oauth_refresh_token_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "auth_session"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "auth_oauth_refresh_token" ADD CONSTRAINT "auth_oauth_refresh_token_userId_fkey" FOREIGN KEY ("userId") REFERENCES "auth_user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "auth_oauth_access_token" ADD CONSTRAINT "auth_oauth_access_token_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "auth_oauth_client"("clientId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "auth_oauth_access_token" ADD CONSTRAINT "auth_oauth_access_token_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "auth_session"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "auth_oauth_access_token" ADD CONSTRAINT "auth_oauth_access_token_userId_fkey" FOREIGN KEY ("userId") REFERENCES "auth_user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "auth_oauth_access_token" ADD CONSTRAINT "auth_oauth_access_token_refreshId_fkey" FOREIGN KEY ("refreshId") REFERENCES "auth_oauth_refresh_token"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "auth_oauth_consent" ADD CONSTRAINT "auth_oauth_consent_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "auth_oauth_client"("clientId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "auth_oauth_consent" ADD CONSTRAINT "auth_oauth_consent_userId_fkey" FOREIGN KEY ("userId") REFERENCES "auth_user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

