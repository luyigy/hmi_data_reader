CREATE TABLE "FeishuTurnCard" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "sourceMessageId" TEXT NOT NULL,
  "memberId" TEXT NOT NULL,
  "bindingId" TEXT NOT NULL,
  "targetJson" TEXT NOT NULL,
  "ownerJson" TEXT NOT NULL,
  "taskRunId" TEXT,
  "messageId" TEXT,
  "cardJson" TEXT,
  "terminal" BOOLEAN NOT NULL DEFAULT false,
  "revision" INTEGER NOT NULL DEFAULT 0,
  "deliveredRevision" INTEGER NOT NULL DEFAULT -1,
  "pending" BOOLEAN NOT NULL DEFAULT true,
  "sendStartedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL
);
CREATE UNIQUE INDEX "FeishuTurnCard_sourceMessageId_memberId_bindingId_key" ON "FeishuTurnCard"("sourceMessageId", "memberId", "bindingId");
CREATE INDEX "FeishuTurnCard_pending_updatedAt_idx" ON "FeishuTurnCard"("pending", "updatedAt");
