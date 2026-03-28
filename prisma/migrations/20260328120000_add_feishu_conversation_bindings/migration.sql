-- CreateTable
CREATE TABLE "FeishuConversationBinding" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "scopeKey" TEXT NOT NULL,
    "chatId" TEXT NOT NULL,
    "chatType" TEXT NOT NULL,
    "senderOpenId" TEXT,
    "latestMessageId" TEXT,
    "liveRoomId" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "FeishuConversationBinding_liveRoomId_fkey" FOREIGN KEY ("liveRoomId") REFERENCES "LiveRoom" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "FeishuConversationBinding_scopeKey_key" ON "FeishuConversationBinding"("scopeKey");

-- CreateIndex
CREATE INDEX "FeishuConversationBinding_chatId_updatedAt_idx" ON "FeishuConversationBinding"("chatId", "updatedAt");

-- CreateIndex
CREATE INDEX "FeishuConversationBinding_liveRoomId_idx" ON "FeishuConversationBinding"("liveRoomId");
