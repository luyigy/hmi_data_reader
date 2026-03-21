-- CreateTable
CREATE TABLE "CrossGatewayChatSession" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "fromGatewayId" TEXT NOT NULL,
    "toGatewayId" TEXT NOT NULL,
    "fromAgentId" TEXT NOT NULL DEFAULT 'main',
    "toAgentId" TEXT NOT NULL DEFAULT 'main',
    "prompt" TEXT NOT NULL,
    "turns" INTEGER NOT NULL DEFAULT 2,
    "status" TEXT NOT NULL DEFAULT 'completed',
    "error" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "CrossGatewayChatMessage" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sessionId" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL,
    "speaker" TEXT NOT NULL,
    "gatewayId" TEXT,
    "agentId" TEXT,
    "text" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "CrossGatewayChatMessage_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "CrossGatewayChatSession" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

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
