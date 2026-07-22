CREATE TABLE "FeishuUserAccess" (
  "openId" TEXT NOT NULL PRIMARY KEY,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "chatId" TEXT,
  "decidedBy" TEXT,
  "decidedAt" DATETIME,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL
);

CREATE INDEX "FeishuUserAccess_status_idx" ON "FeishuUserAccess"("status");

CREATE TABLE "FeishuAdminApproval" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "kind" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "requesterOpenId" TEXT NOT NULL,
  "requesterChatId" TEXT NOT NULL,
  "payloadJson" TEXT,
  "cardMessageId" TEXT,
  "expiresAt" DATETIME,
  "resolvedBy" TEXT,
  "resolvedAt" DATETIME,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL
);

CREATE INDEX "FeishuAdminApproval_requesterOpenId_kind_status_idx" ON "FeishuAdminApproval"("requesterOpenId", "kind", "status");
CREATE INDEX "FeishuAdminApproval_status_expiresAt_idx" ON "FeishuAdminApproval"("status", "expiresAt");
