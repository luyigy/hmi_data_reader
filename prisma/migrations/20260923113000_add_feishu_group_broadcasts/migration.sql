-- One public notification per source message; receiving scope fixed at publish time.
CREATE TABLE "FeishuGroupBroadcast" (
    "id" TEXT NOT NULL,
    "appId" TEXT NOT NULL,
    "chatId" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL,
    "sourceMessageId" TEXT NOT NULL,
    "senderOpenId" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "publishedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FeishuGroupBroadcast_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FeishuGroupBroadcastTarget" (
    "id" TEXT NOT NULL,
    "broadcastId" TEXT NOT NULL,
    "appId" TEXT NOT NULL,
    "chatId" TEXT NOT NULL,
    "bindingId" TEXT NOT NULL,
    "liveRoomId" TEXT NOT NULL,
    "threadId" TEXT NOT NULL,
    "rootMessageId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FeishuGroupBroadcastTarget_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "FeishuGroupBroadcast_appId_chatId_sourceMessageId_key"
    ON "FeishuGroupBroadcast"("appId", "chatId", "sourceMessageId");

-- CreateIndex
CREATE UNIQUE INDEX "FeishuGroupBroadcast_appId_chatId_sequence_key"
    ON "FeishuGroupBroadcast"("appId", "chatId", "sequence");

-- CreateIndex
CREATE INDEX "FeishuGroupBroadcast_appId_chatId_publishedAt_idx"
    ON "FeishuGroupBroadcast"("appId", "chatId", "publishedAt");

-- CreateIndex
CREATE UNIQUE INDEX "FeishuGroupBroadcastTarget_broadcastId_bindingId_key"
    ON "FeishuGroupBroadcastTarget"("broadcastId", "bindingId");

-- CreateIndex
CREATE INDEX "FeishuGroupBroadcastTarget_appId_chatId_threadId_idx"
    ON "FeishuGroupBroadcastTarget"("appId", "chatId", "threadId");

-- CreateIndex
CREATE INDEX "FeishuGroupBroadcastTarget_liveRoomId_idx"
    ON "FeishuGroupBroadcastTarget"("liveRoomId");

-- AddForeignKey
-- The only foreign key is the target->broadcast cascade. Identity fields
-- (bindingId/liveRoomId/threadId/rootMessageId) are a deliberate snapshot:
-- no live FK so historical scope survives later binding or room changes.
ALTER TABLE "FeishuGroupBroadcastTarget" ADD CONSTRAINT "FeishuGroupBroadcastTarget_broadcastId_fkey"
    FOREIGN KEY ("broadcastId") REFERENCES "FeishuGroupBroadcast"("id") ON DELETE CASCADE ON UPDATE CASCADE;
