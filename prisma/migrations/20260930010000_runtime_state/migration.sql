CREATE INDEX "Greeting_createdAt_idx" ON "Greeting"("createdAt");

CREATE TABLE "WhatsAppAuthEntry" (
    "category" TEXT NOT NULL,
    "keyId" TEXT NOT NULL,
    "encrypted" TEXT NOT NULL,
    "updatedAt" DATETIME NOT NULL,
    PRIMARY KEY ("category", "keyId")
);

CREATE TABLE "AdminSession" (
    "tokenHash" TEXT NOT NULL PRIMARY KEY,
    "expiresAt" DATETIME NOT NULL
);
CREATE INDEX "AdminSession_expiresAt_idx" ON "AdminSession"("expiresAt");

CREATE TABLE "LoginBucket" (
    "key" TEXT NOT NULL PRIMARY KEY,
    "attempts" INTEGER NOT NULL,
    "expiresAt" DATETIME NOT NULL
);

CREATE TABLE "BotSetting" (
    "key" TEXT NOT NULL PRIMARY KEY,
    "value" TEXT NOT NULL
);
