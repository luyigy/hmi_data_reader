-- CreateTable
CREATE TABLE "Agent" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "runtimeAgentId" TEXT,
    "type" TEXT NOT NULL,
    "location" TEXT,
    "capabilities" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'offline',
    "lastHeartbeat" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "gatewayId" TEXT,
    "userNickname" TEXT,
    "roleDescription" TEXT,
    "colorTag" TEXT,
    "emojiIcon" TEXT,
    "hostname" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Agent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Gateway" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "url" TEXT,
    "token" TEXT,
    "openclawToken" TEXT,
    "ip" TEXT,
    "status" TEXT NOT NULL DEFAULT 'offline',
    "resources" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Gateway_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RemoteHarnessHost" (
    "id" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "host" TEXT NOT NULL,
    "port" INTEGER NOT NULL DEFAULT 22,
    "sshUser" TEXT NOT NULL,
    "authType" TEXT NOT NULL DEFAULT 'ssh_key',
    "encryptedPrivateKey" TEXT,
    "workingDirectory" TEXT,
    "status" TEXT NOT NULL DEFAULT 'offline',
    "viaNetwork" TEXT NOT NULL DEFAULT 'wireguard',
    "supportedHarnesses" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RemoteHarnessHost_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Task" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "executionMode" TEXT NOT NULL DEFAULT 'standard',
    "runnerTarget" TEXT,
    "acpxParticipants" TEXT,
    "acpxPermissionConfig" TEXT,
    "workingDirectory" TEXT,
    "currentTaskSessionId" TEXT,
    "result" TEXT,
    "error" TEXT,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Task_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TaskRun" (
    "id" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "taskSessionId" TEXT,
    "mode" TEXT NOT NULL DEFAULT 'acpx',
    "runnerTarget" TEXT,
    "orchestrationMode" TEXT NOT NULL DEFAULT 'single',
    "status" TEXT NOT NULL DEFAULT 'pending',
    "controlState" TEXT NOT NULL DEFAULT 'normal',
    "activityState" TEXT NOT NULL DEFAULT 'quiet',
    "summary" TEXT,
    "error" TEXT,
    "watchdogConfig" TEXT,
    "controlMetadata" TEXT,
    "lastActivityAt" TIMESTAMP(3),
    "lastStdoutAt" TIMESTAMP(3),
    "lastStderrAt" TIMESTAMP(3),
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TaskRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TaskRunParticipant" (
    "id" TEXT NOT NULL,
    "taskRunId" TEXT NOT NULL,
    "runner" TEXT,
    "executionBackend" TEXT NOT NULL DEFAULT 'gateway_openclaw',
    "gatewayId" TEXT,
    "gatewayNameSnapshot" TEXT NOT NULL,
    "harnessType" TEXT NOT NULL,
    "harnessNameSnapshot" TEXT,
    "role" TEXT NOT NULL,
    "agentId" TEXT,
    "agentNameSnapshot" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "activityState" TEXT NOT NULL DEFAULT 'quiet',
    "summary" TEXT,
    "error" TEXT,
    "filesModified" TEXT,
    "controlMetadata" TEXT,
    "lastActivityAt" TIMESTAMP(3),
    "interruptSupported" BOOLEAN NOT NULL DEFAULT false,
    "resumeSupported" BOOLEAN NOT NULL DEFAULT false,
    "sessionControlSupported" BOOLEAN NOT NULL DEFAULT false,
    "softStopSupported" BOOLEAN NOT NULL DEFAULT false,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TaskRunParticipant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TaskRunEvent" (
    "id" TEXT NOT NULL,
    "taskRunId" TEXT NOT NULL,
    "participantId" TEXT,
    "sequence" INTEGER NOT NULL,
    "eventType" TEXT NOT NULL,
    "stream" TEXT NOT NULL DEFAULT 'system',
    "content" TEXT NOT NULL,
    "metadata" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TaskRunEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TaskSession" (
    "id" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "attentionState" TEXT NOT NULL DEFAULT 'normal',
    "activeRunId" TEXT,
    "summary" TEXT,
    "metadata" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TaskSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TaskRunControlMessage" (
    "id" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "taskSessionId" TEXT,
    "taskRunId" TEXT NOT NULL,
    "roomMessageId" TEXT,
    "participantId" TEXT,
    "senderUserId" TEXT NOT NULL,
    "senderName" TEXT NOT NULL,
    "deliveryMode" TEXT NOT NULL DEFAULT 'queued',
    "deliveryStatus" TEXT NOT NULL DEFAULT 'pending',
    "controlAction" TEXT NOT NULL DEFAULT 'queue_message',
    "content" TEXT NOT NULL,
    "metadata" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMP(3),

    CONSTRAINT "TaskRunControlMessage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TaskRunInteractionRequest" (
    "id" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "taskSessionId" TEXT,
    "taskRunId" TEXT NOT NULL,
    "participantId" TEXT,
    "roomMessageId" TEXT,
    "source" TEXT NOT NULL DEFAULT 'harness',
    "requestKind" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "title" TEXT,
    "message" TEXT NOT NULL,
    "rawPayload" TEXT,
    "optionsJson" TEXT,
    "defaultAnswer" TEXT,
    "responseText" TEXT,
    "responseMetadata" TEXT,
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TaskRunInteractionRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ChatRoom" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ChatRoom_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Message" (
    "id" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "roomId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "userName" TEXT NOT NULL,
    "targetType" TEXT NOT NULL DEFAULT 'task',
    "targetParticipantKey" TEXT,
    "targetParticipantLabel" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Message_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GatewayMessage" (
    "id" TEXT NOT NULL,
    "fromGatewayId" TEXT NOT NULL,
    "toGatewayId" TEXT NOT NULL,
    "type" TEXT NOT NULL DEFAULT 'direct',
    "payload" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deliveredAt" TIMESTAMP(3),
    "error" TEXT,

    CONSTRAINT "GatewayMessage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IncomingGatewayMessage" (
    "id" TEXT NOT NULL,
    "fromGatewayId" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "type" TEXT NOT NULL DEFAULT 'direct',
    "status" TEXT NOT NULL DEFAULT 'received',
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMP(3),
    "error" TEXT,

    CONSTRAINT "IncomingGatewayMessage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ControlPlaneState" (
    "id" TEXT NOT NULL,
    "gatewayId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'offline',
    "lastHeartbeat" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "loadScore" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "latency" INTEGER NOT NULL DEFAULT 0,
    "consecutiveFails" INTEGER NOT NULL DEFAULT 0,
    "metadata" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ControlPlaneState_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CrossGatewayChatSession" (
    "id" TEXT NOT NULL,
    "fromGatewayId" TEXT NOT NULL,
    "toGatewayId" TEXT NOT NULL,
    "fromAgentId" TEXT NOT NULL DEFAULT 'main',
    "toAgentId" TEXT NOT NULL DEFAULT 'main',
    "prompt" TEXT NOT NULL,
    "turns" INTEGER NOT NULL DEFAULT 2,
    "status" TEXT NOT NULL DEFAULT 'completed',
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CrossGatewayChatSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CrossGatewayChatMessage" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL,
    "speaker" TEXT NOT NULL,
    "gatewayId" TEXT,
    "agentId" TEXT,
    "text" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CrossGatewayChatMessage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LiveRoom" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "sourceTaskId" TEXT,
    "currentTopic" TEXT,
    "mode" TEXT NOT NULL DEFAULT 'discussion',
    "status" TEXT NOT NULL DEFAULT 'active',
    "createdBy" TEXT NOT NULL DEFAULT 'user',
    "currentSpeakerMemberId" TEXT,
    "workingDirectory" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LiveRoom_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FeishuConversationBinding" (
    "id" TEXT NOT NULL,
    "scopeKey" TEXT NOT NULL,
    "chatId" TEXT NOT NULL,
    "chatType" TEXT NOT NULL,
    "senderOpenId" TEXT,
    "latestMessageId" TEXT,
    "typingReactionId" TEXT,
    "typingForMessageId" TEXT,
    "liveRoomId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FeishuConversationBinding_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FeishuUserAccess" (
    "openId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "chatId" TEXT,
    "displayName" TEXT,
    "nameUpdatedAt" TIMESTAMP(3),
    "decidedBy" TEXT,
    "decidedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FeishuUserAccess_pkey" PRIMARY KEY ("openId")
);

-- CreateTable
CREATE TABLE "FeishuAdminApproval" (
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "requesterOpenId" TEXT NOT NULL,
    "requesterChatId" TEXT NOT NULL,
    "payloadJson" TEXT,
    "cardMessageId" TEXT,
    "expiresAt" TIMESTAMP(3),
    "resolvedBy" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FeishuAdminApproval_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LiveRoomMember" (
    "id" TEXT NOT NULL,
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
    "role" TEXT NOT NULL DEFAULT 'custom',
    "acpxPermissionConfig" TEXT,
    "codexModel" TEXT,
    "codexReasoningEffort" TEXT,
    "userNickname" TEXT,
    "shortAlias" TEXT,
    "joinStatus" TEXT NOT NULL DEFAULT 'joined',
    "presenceStatus" TEXT NOT NULL DEFAULT 'idle',
    "canReply" BOOLEAN NOT NULL DEFAULT false,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LiveRoomMember_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LiveRoomMessage" (
    "id" TEXT NOT NULL,
    "roomId" TEXT NOT NULL,
    "senderMemberId" TEXT,
    "replyToMessageId" TEXT,
    "messageType" TEXT NOT NULL DEFAULT 'user',
    "visibility" TEXT NOT NULL DEFAULT 'room',
    "content" TEXT NOT NULL,
    "topicSnapshot" TEXT,
    "metadata" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LiveRoomMessage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LiveRoomMemberSession" (
    "id" TEXT NOT NULL,
    "roomId" TEXT NOT NULL,
    "memberId" TEXT NOT NULL,
    "backend" TEXT NOT NULL,
    "sessionKey" TEXT NOT NULL,
    "threadId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'online',
    "supportsStreaming" BOOLEAN NOT NULL DEFAULT false,
    "supportsAppendMessage" BOOLEAN NOT NULL DEFAULT true,
    "supportsInterrupt" BOOLEAN NOT NULL DEFAULT false,
    "lastHeartbeatAt" TIMESTAMP(3),
    "lastDeliveredAt" TIMESTAMP(3),
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LiveRoomMemberSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LiveRoomDelivery" (
    "id" TEXT NOT NULL,
    "roomMessageId" TEXT NOT NULL,
    "targetMemberId" TEXT NOT NULL,
    "sessionId" TEXT,
    "deliveryStatus" TEXT NOT NULL DEFAULT 'pending',
    "fallbackReason" TEXT,
    "attemptedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "acknowledgedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LiveRoomDelivery_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "_AgentToTask" (
    "A" TEXT NOT NULL,
    "B" TEXT NOT NULL
);

-- CreateIndex
CREATE INDEX "Agent_status_idx" ON "Agent"("status");

-- CreateIndex
CREATE INDEX "Agent_gatewayId_idx" ON "Agent"("gatewayId");

-- CreateIndex
CREATE INDEX "Agent_runtimeAgentId_idx" ON "Agent"("runtimeAgentId");

-- CreateIndex
CREATE INDEX "Agent_hostname_idx" ON "Agent"("hostname");

-- CreateIndex
CREATE INDEX "Gateway_status_idx" ON "Gateway"("status");

-- CreateIndex
CREATE INDEX "RemoteHarnessHost_status_idx" ON "RemoteHarnessHost"("status");

-- CreateIndex
CREATE INDEX "RemoteHarnessHost_label_idx" ON "RemoteHarnessHost"("label");

-- CreateIndex
CREATE INDEX "Task_status_idx" ON "Task"("status");

-- CreateIndex
CREATE INDEX "Task_executionMode_idx" ON "Task"("executionMode");

-- CreateIndex
CREATE INDEX "Task_currentTaskSessionId_idx" ON "Task"("currentTaskSessionId");

-- CreateIndex
CREATE INDEX "TaskRun_taskId_createdAt_idx" ON "TaskRun"("taskId", "createdAt");

-- CreateIndex
CREATE INDEX "TaskRun_taskSessionId_createdAt_idx" ON "TaskRun"("taskSessionId", "createdAt");

-- CreateIndex
CREATE INDEX "TaskRun_status_idx" ON "TaskRun"("status");

-- CreateIndex
CREATE INDEX "TaskRunParticipant_taskRunId_idx" ON "TaskRunParticipant"("taskRunId");

-- CreateIndex
CREATE INDEX "TaskRunParticipant_runner_idx" ON "TaskRunParticipant"("runner");

-- CreateIndex
CREATE INDEX "TaskRunParticipant_status_idx" ON "TaskRunParticipant"("status");

-- CreateIndex
CREATE INDEX "TaskRunEvent_taskRunId_sequence_idx" ON "TaskRunEvent"("taskRunId", "sequence");

-- CreateIndex
CREATE INDEX "TaskRunEvent_participantId_idx" ON "TaskRunEvent"("participantId");

-- CreateIndex
CREATE INDEX "TaskRunEvent_eventType_idx" ON "TaskRunEvent"("eventType");

-- CreateIndex
CREATE INDEX "TaskSession_taskId_createdAt_idx" ON "TaskSession"("taskId", "createdAt");

-- CreateIndex
CREATE INDEX "TaskSession_status_idx" ON "TaskSession"("status");

-- CreateIndex
CREATE INDEX "TaskSession_activeRunId_idx" ON "TaskSession"("activeRunId");

-- CreateIndex
CREATE INDEX "TaskRunControlMessage_taskId_createdAt_idx" ON "TaskRunControlMessage"("taskId", "createdAt");

-- CreateIndex
CREATE INDEX "TaskRunControlMessage_taskSessionId_createdAt_idx" ON "TaskRunControlMessage"("taskSessionId", "createdAt");

-- CreateIndex
CREATE INDEX "TaskRunControlMessage_taskRunId_createdAt_idx" ON "TaskRunControlMessage"("taskRunId", "createdAt");

-- CreateIndex
CREATE INDEX "TaskRunControlMessage_participantId_idx" ON "TaskRunControlMessage"("participantId");

-- CreateIndex
CREATE INDEX "TaskRunControlMessage_deliveryStatus_idx" ON "TaskRunControlMessage"("deliveryStatus");

-- CreateIndex
CREATE INDEX "TaskRunInteractionRequest_taskRunId_createdAt_idx" ON "TaskRunInteractionRequest"("taskRunId", "createdAt");

-- CreateIndex
CREATE INDEX "TaskRunInteractionRequest_participantId_status_idx" ON "TaskRunInteractionRequest"("participantId", "status");

-- CreateIndex
CREATE INDEX "TaskRunInteractionRequest_status_expiresAt_idx" ON "TaskRunInteractionRequest"("status", "expiresAt");

-- CreateIndex
CREATE INDEX "ChatRoom_name_idx" ON "ChatRoom"("name");

-- CreateIndex
CREATE INDEX "Message_roomId_createdAt_idx" ON "Message"("roomId", "createdAt");

-- CreateIndex
CREATE INDEX "Message_roomId_targetType_createdAt_idx" ON "Message"("roomId", "targetType", "createdAt");

-- CreateIndex
CREATE INDEX "GatewayMessage_fromGatewayId_idx" ON "GatewayMessage"("fromGatewayId");

-- CreateIndex
CREATE INDEX "GatewayMessage_toGatewayId_idx" ON "GatewayMessage"("toGatewayId");

-- CreateIndex
CREATE INDEX "GatewayMessage_status_idx" ON "GatewayMessage"("status");

-- CreateIndex
CREATE INDEX "IncomingGatewayMessage_fromGatewayId_idx" ON "IncomingGatewayMessage"("fromGatewayId");

-- CreateIndex
CREATE INDEX "IncomingGatewayMessage_status_idx" ON "IncomingGatewayMessage"("status");

-- CreateIndex
CREATE INDEX "IncomingGatewayMessage_receivedAt_idx" ON "IncomingGatewayMessage"("receivedAt");

-- CreateIndex
CREATE UNIQUE INDEX "ControlPlaneState_gatewayId_key" ON "ControlPlaneState"("gatewayId");

-- CreateIndex
CREATE INDEX "ControlPlaneState_status_idx" ON "ControlPlaneState"("status");

-- CreateIndex
CREATE INDEX "CrossGatewayChatSession_fromGatewayId_idx" ON "CrossGatewayChatSession"("fromGatewayId");

-- CreateIndex
CREATE INDEX "CrossGatewayChatSession_toGatewayId_idx" ON "CrossGatewayChatSession"("toGatewayId");

-- CreateIndex
CREATE INDEX "CrossGatewayChatSession_createdAt_idx" ON "CrossGatewayChatSession"("createdAt");

-- CreateIndex
CREATE INDEX "CrossGatewayChatSession_status_idx" ON "CrossGatewayChatSession"("status");

-- CreateIndex
CREATE INDEX "CrossGatewayChatMessage_sessionId_sequence_idx" ON "CrossGatewayChatMessage"("sessionId", "sequence");

-- CreateIndex
CREATE INDEX "CrossGatewayChatMessage_gatewayId_idx" ON "CrossGatewayChatMessage"("gatewayId");

-- CreateIndex
CREATE INDEX "LiveRoom_sourceTaskId_idx" ON "LiveRoom"("sourceTaskId");

-- CreateIndex
CREATE INDEX "LiveRoom_status_updatedAt_idx" ON "LiveRoom"("status", "updatedAt");

-- CreateIndex
CREATE UNIQUE INDEX "FeishuConversationBinding_scopeKey_key" ON "FeishuConversationBinding"("scopeKey");

-- CreateIndex
CREATE INDEX "FeishuConversationBinding_chatId_updatedAt_idx" ON "FeishuConversationBinding"("chatId", "updatedAt");

-- CreateIndex
CREATE INDEX "FeishuConversationBinding_liveRoomId_idx" ON "FeishuConversationBinding"("liveRoomId");

-- CreateIndex
CREATE INDEX "FeishuUserAccess_status_idx" ON "FeishuUserAccess"("status");

-- CreateIndex
CREATE INDEX "FeishuAdminApproval_requesterOpenId_kind_status_idx" ON "FeishuAdminApproval"("requesterOpenId", "kind", "status");

-- CreateIndex
CREATE INDEX "FeishuAdminApproval_status_expiresAt_idx" ON "FeishuAdminApproval"("status", "expiresAt");

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

-- CreateIndex
CREATE UNIQUE INDEX "_AgentToTask_AB_unique" ON "_AgentToTask"("A", "B");

-- CreateIndex
CREATE INDEX "_AgentToTask_B_index" ON "_AgentToTask"("B");

-- AddForeignKey
ALTER TABLE "Agent" ADD CONSTRAINT "Agent_gatewayId_fkey" FOREIGN KEY ("gatewayId") REFERENCES "Gateway"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Task" ADD CONSTRAINT "Task_currentTaskSessionId_fkey" FOREIGN KEY ("currentTaskSessionId") REFERENCES "TaskSession"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaskRun" ADD CONSTRAINT "TaskRun_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaskRun" ADD CONSTRAINT "TaskRun_taskSessionId_fkey" FOREIGN KEY ("taskSessionId") REFERENCES "TaskSession"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaskRunParticipant" ADD CONSTRAINT "TaskRunParticipant_taskRunId_fkey" FOREIGN KEY ("taskRunId") REFERENCES "TaskRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaskRunEvent" ADD CONSTRAINT "TaskRunEvent_taskRunId_fkey" FOREIGN KEY ("taskRunId") REFERENCES "TaskRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaskRunEvent" ADD CONSTRAINT "TaskRunEvent_participantId_fkey" FOREIGN KEY ("participantId") REFERENCES "TaskRunParticipant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaskSession" ADD CONSTRAINT "TaskSession_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaskRunControlMessage" ADD CONSTRAINT "TaskRunControlMessage_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaskRunControlMessage" ADD CONSTRAINT "TaskRunControlMessage_taskSessionId_fkey" FOREIGN KEY ("taskSessionId") REFERENCES "TaskSession"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaskRunControlMessage" ADD CONSTRAINT "TaskRunControlMessage_taskRunId_fkey" FOREIGN KEY ("taskRunId") REFERENCES "TaskRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaskRunControlMessage" ADD CONSTRAINT "TaskRunControlMessage_participantId_fkey" FOREIGN KEY ("participantId") REFERENCES "TaskRunParticipant"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaskRunInteractionRequest" ADD CONSTRAINT "TaskRunInteractionRequest_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaskRunInteractionRequest" ADD CONSTRAINT "TaskRunInteractionRequest_taskSessionId_fkey" FOREIGN KEY ("taskSessionId") REFERENCES "TaskSession"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaskRunInteractionRequest" ADD CONSTRAINT "TaskRunInteractionRequest_taskRunId_fkey" FOREIGN KEY ("taskRunId") REFERENCES "TaskRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaskRunInteractionRequest" ADD CONSTRAINT "TaskRunInteractionRequest_participantId_fkey" FOREIGN KEY ("participantId") REFERENCES "TaskRunParticipant"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Message" ADD CONSTRAINT "Message_roomId_fkey" FOREIGN KEY ("roomId") REFERENCES "ChatRoom"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GatewayMessage" ADD CONSTRAINT "GatewayMessage_fromGatewayId_fkey" FOREIGN KEY ("fromGatewayId") REFERENCES "Gateway"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GatewayMessage" ADD CONSTRAINT "GatewayMessage_toGatewayId_fkey" FOREIGN KEY ("toGatewayId") REFERENCES "Gateway"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IncomingGatewayMessage" ADD CONSTRAINT "IncomingGatewayMessage_fromGatewayId_fkey" FOREIGN KEY ("fromGatewayId") REFERENCES "Gateway"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CrossGatewayChatMessage" ADD CONSTRAINT "CrossGatewayChatMessage_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "CrossGatewayChatSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LiveRoom" ADD CONSTRAINT "LiveRoom_sourceTaskId_fkey" FOREIGN KEY ("sourceTaskId") REFERENCES "Task"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LiveRoom" ADD CONSTRAINT "LiveRoom_currentSpeakerMemberId_fkey" FOREIGN KEY ("currentSpeakerMemberId") REFERENCES "LiveRoomMember"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FeishuConversationBinding" ADD CONSTRAINT "FeishuConversationBinding_liveRoomId_fkey" FOREIGN KEY ("liveRoomId") REFERENCES "LiveRoom"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LiveRoomMember" ADD CONSTRAINT "LiveRoomMember_roomId_fkey" FOREIGN KEY ("roomId") REFERENCES "LiveRoom"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LiveRoomMember" ADD CONSTRAINT "LiveRoomMember_agentRecordId_fkey" FOREIGN KEY ("agentRecordId") REFERENCES "Agent"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LiveRoomMember" ADD CONSTRAINT "LiveRoomMember_gatewayId_fkey" FOREIGN KEY ("gatewayId") REFERENCES "Gateway"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LiveRoomMessage" ADD CONSTRAINT "LiveRoomMessage_roomId_fkey" FOREIGN KEY ("roomId") REFERENCES "LiveRoom"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LiveRoomMessage" ADD CONSTRAINT "LiveRoomMessage_senderMemberId_fkey" FOREIGN KEY ("senderMemberId") REFERENCES "LiveRoomMember"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LiveRoomMessage" ADD CONSTRAINT "LiveRoomMessage_replyToMessageId_fkey" FOREIGN KEY ("replyToMessageId") REFERENCES "LiveRoomMessage"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LiveRoomMemberSession" ADD CONSTRAINT "LiveRoomMemberSession_roomId_fkey" FOREIGN KEY ("roomId") REFERENCES "LiveRoom"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LiveRoomMemberSession" ADD CONSTRAINT "LiveRoomMemberSession_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "LiveRoomMember"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LiveRoomDelivery" ADD CONSTRAINT "LiveRoomDelivery_roomMessageId_fkey" FOREIGN KEY ("roomMessageId") REFERENCES "LiveRoomMessage"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LiveRoomDelivery" ADD CONSTRAINT "LiveRoomDelivery_targetMemberId_fkey" FOREIGN KEY ("targetMemberId") REFERENCES "LiveRoomMember"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LiveRoomDelivery" ADD CONSTRAINT "LiveRoomDelivery_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "LiveRoomMemberSession"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_AgentToTask" ADD CONSTRAINT "_AgentToTask_A_fkey" FOREIGN KEY ("A") REFERENCES "Agent"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_AgentToTask" ADD CONSTRAINT "_AgentToTask_B_fkey" FOREIGN KEY ("B") REFERENCES "Task"("id") ON DELETE CASCADE ON UPDATE CASCADE;
