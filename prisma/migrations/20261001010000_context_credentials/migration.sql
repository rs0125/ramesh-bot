CREATE TABLE "ContextOAuthGrant" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "namespace" TEXT NOT NULL,
    "employeeId" INTEGER NOT NULL,
    "state" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 0,
    "encrypted" TEXT,
    "operation" TEXT,
    "operationExpiresAt" DATETIME,
    "updatedAt" DATETIME NOT NULL
);

CREATE TABLE "ContextOAuthEnrollment" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "namespace" TEXT NOT NULL,
    "employeeId" INTEGER NOT NULL,
    "state" TEXT NOT NULL,
    "encrypted" TEXT,
    "expiresAt" DATETIME NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX "ContextOAuthEnrollment_expiresAt_idx" ON "ContextOAuthEnrollment"("expiresAt");

CREATE TABLE "ContextOAuthRevocation" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "namespace" TEXT NOT NULL,
    "encrypted" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
