-- CreateTable
CREATE TABLE "LiveRoom" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "sourceTaskId" TEXT,
    "currentTopic" TEXT,
    "mode" TEXT NOT NULL DEFAULT 'discussion',
    "status" TEXT NOT NULL DEFAULT 'active',
    "createdBy" TEXT NOT NULL DEFAULT 'user',
    "currentSpeakerMemberId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "LiveRoom_sourceTaskId_fkey" FOREIGN KEY ("sourceTaskId") REFERENCES "Task" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "LiveRoom_currentSpeakerMemberId_fkey" FOREIGN KEY ("currentSpeakerMemberId") REFERENCES "LiveRoomMember" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "LiveRoomMember" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "roomId" TEXT NOT NULL,
    "agentRecordId" TEXT,
    "gatewayId" TEXT,
    "memberType" TEXT NOT NULL DEFAULT 'user',
    "displayName" TEXT NOT NULL,
    "agentNameSnapshot" TEXT,
    "harnessType" TEXT,
    "backend" TEXT,
    "runtimeAgentId" TEXT,
    "roleLabel" TEXT,
    "joinStatus" TEXT NOT NULL DEFAULT 'joined',
    "presenceStatus" TEXT NOT NULL DEFAULT 'idle',
    "canReply" BOOLEAN NOT NULL DEFAULT false,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "LiveRoomMember_roomId_fkey" FOREIGN KEY ("roomId") REFERENCES "LiveRoom" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "LiveRoomMember_agentRecordId_fkey" FOREIGN KEY ("agentRecordId") REFERENCES "Agent" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "LiveRoomMember_gatewayId_fkey" FOREIGN KEY ("gatewayId") REFERENCES "Gateway" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "LiveRoomMessage" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "roomId" TEXT NOT NULL,
    "senderMemberId" TEXT,
    "replyToMessageId" TEXT,
    "messageType" TEXT NOT NULL DEFAULT 'user',
    "visibility" TEXT NOT NULL DEFAULT 'room',
    "content" TEXT NOT NULL,
    "topicSnapshot" TEXT,
    "metadata" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "LiveRoomMessage_roomId_fkey" FOREIGN KEY ("roomId") REFERENCES "LiveRoom" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "LiveRoomMessage_senderMemberId_fkey" FOREIGN KEY ("senderMemberId") REFERENCES "LiveRoomMember" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "LiveRoomMessage_replyToMessageId_fkey" FOREIGN KEY ("replyToMessageId") REFERENCES "LiveRoomMessage" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "LiveRoomMemberSession" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "roomId" TEXT NOT NULL,
    "memberId" TEXT NOT NULL,
    "backend" TEXT NOT NULL,
    "sessionKey" TEXT NOT NULL,
    "threadId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'online',
    "supportsStreaming" BOOLEAN NOT NULL DEFAULT false,
    "supportsAppendMessage" BOOLEAN NOT NULL DEFAULT true,
    "supportsInterrupt" BOOLEAN NOT NULL DEFAULT false,
    "lastHeartbeatAt" DATETIME,
    "lastDeliveredAt" DATETIME,
    "lastError" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "LiveRoomMemberSession_roomId_fkey" FOREIGN KEY ("roomId") REFERENCES "LiveRoom" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "LiveRoomMemberSession_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "LiveRoomMember" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "LiveRoomDelivery" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "roomMessageId" TEXT NOT NULL,
    "targetMemberId" TEXT NOT NULL,
    "sessionId" TEXT,
    "deliveryStatus" TEXT NOT NULL DEFAULT 'pending',
    "fallbackReason" TEXT,
    "attemptedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "acknowledgedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "LiveRoomDelivery_roomMessageId_fkey" FOREIGN KEY ("roomMessageId") REFERENCES "LiveRoomMessage" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "LiveRoomDelivery_targetMemberId_fkey" FOREIGN KEY ("targetMemberId") REFERENCES "LiveRoomMember" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "LiveRoomDelivery_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "LiveRoomMemberSession" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "LiveRoom_sourceTaskId_idx" ON "LiveRoom"("sourceTaskId");

-- CreateIndex
CREATE INDEX "LiveRoom_status_updatedAt_idx" ON "LiveRoom"("status", "updatedAt");

-- CreateIndex
CREATE INDEX "LiveRoomMember_roomId_sortOrder_idx" ON "LiveRoomMember"("roomId", "sortOrder");

-- CreateIndex
CREATE INDEX "LiveRoomMember_agentRecordId_idx" ON "LiveRoomMember"("agentRecordId");

-- CreateIndex
CREATE INDEX "LiveRoomMember_gatewayId_idx" ON "LiveRoomMember"("gatewayId");

-- CreateIndex
CREATE INDEX "LiveRoomMember_memberType_presenceStatus_idx" ON "LiveRoomMember"("memberType", "presenceStatus");

-- CreateIndex
CREATE INDEX "LiveRoomMessage_roomId_createdAt_idx" ON "LiveRoomMessage"("roomId", "createdAt");

-- CreateIndex
CREATE INDEX "LiveRoomMessage_senderMemberId_createdAt_idx" ON "LiveRoomMessage"("senderMemberId", "createdAt");

-- CreateIndex
CREATE INDEX "LiveRoomMessage_replyToMessageId_idx" ON "LiveRoomMessage"("replyToMessageId");

-- CreateIndex
CREATE INDEX "LiveRoomMessage_messageType_createdAt_idx" ON "LiveRoomMessage"("messageType", "createdAt");

-- CreateIndex
CREATE INDEX "LiveRoomMemberSession_roomId_memberId_idx" ON "LiveRoomMemberSession"("roomId", "memberId");

-- CreateIndex
CREATE INDEX "LiveRoomMemberSession_sessionKey_idx" ON "LiveRoomMemberSession"("sessionKey");

-- CreateIndex
CREATE INDEX "LiveRoomMemberSession_status_updatedAt_idx" ON "LiveRoomMemberSession"("status", "updatedAt");

-- CreateIndex
CREATE INDEX "LiveRoomDelivery_roomMessageId_idx" ON "LiveRoomDelivery"("roomMessageId");

-- CreateIndex
CREATE INDEX "LiveRoomDelivery_targetMemberId_attemptedAt_idx" ON "LiveRoomDelivery"("targetMemberId", "attemptedAt");

-- CreateIndex
CREATE INDEX "LiveRoomDelivery_sessionId_idx" ON "LiveRoomDelivery"("sessionId");

-- CreateIndex
CREATE INDEX "LiveRoomDelivery_deliveryStatus_attemptedAt_idx" ON "LiveRoomDelivery"("deliveryStatus", "attemptedAt");
