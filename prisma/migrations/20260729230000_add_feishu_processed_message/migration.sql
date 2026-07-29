CREATE TABLE "FeishuProcessedMessage" (
  "messageId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "FeishuProcessedMessage_pkey" PRIMARY KEY ("messageId")
);

CREATE INDEX "FeishuProcessedMessage_createdAt_idx"
ON "FeishuProcessedMessage"("createdAt");
