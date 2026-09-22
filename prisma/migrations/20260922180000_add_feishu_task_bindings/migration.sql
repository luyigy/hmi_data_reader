ALTER TABLE "FeishuConversationBinding"
  ADD COLUMN "appId" TEXT,
  ADD COLUMN "threadId" TEXT,
  ADD COLUMN "rootMessageId" TEXT;

-- Legacy group/DM bindings keep NULL fields and their existing scope keys.
ALTER TABLE "FeishuConversationBinding" ADD CONSTRAINT "FeishuConversationBinding_task_identity_check"
  CHECK (("threadId" IS NULL AND "rootMessageId" IS NULL)
    OR ("appId" IS NOT NULL AND "threadId" IS NOT NULL AND "rootMessageId" IS NOT NULL AND "chatType" = 'group'));
CREATE UNIQUE INDEX "FeishuConversationBinding_appId_chatId_threadId_key"
  ON "FeishuConversationBinding"("appId", "chatId", "threadId");
CREATE UNIQUE INDEX "FeishuConversationBinding_appId_chatId_rootMessageId_key"
  ON "FeishuConversationBinding"("appId", "chatId", "rootMessageId");

CREATE TABLE "FeishuGroupTaskSettings" (
  "appId" TEXT NOT NULL,
  "chatId" TEXT NOT NULL,
  "isolationEnabled" BOOLEAN NOT NULL DEFAULT false,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "FeishuGroupTaskSettings_pkey" PRIMARY KEY ("appId", "chatId")
);
CREATE TABLE "FeishuTaskBindingRequest" (
  "id" TEXT NOT NULL,
  "appId" TEXT NOT NULL,
  "chatId" TEXT NOT NULL,
  "sourceMessageId" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "workingDirectory" TEXT NOT NULL,
  "rootMessageId" TEXT,
  "bindingId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "FeishuTaskBindingRequest_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "FeishuTaskBindingRequest_bindingId_key" ON "FeishuTaskBindingRequest"("bindingId");
CREATE UNIQUE INDEX "FeishuTaskBindingRequest_appId_chatId_sourceMessageId_key"
  ON "FeishuTaskBindingRequest"("appId", "chatId", "sourceMessageId");
CREATE UNIQUE INDEX "FeishuTaskBindingRequest_appId_chatId_rootMessageId_key"
  ON "FeishuTaskBindingRequest"("appId", "chatId", "rootMessageId");
