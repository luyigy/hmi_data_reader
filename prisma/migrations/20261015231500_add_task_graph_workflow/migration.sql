-- CreateTable
CREATE TABLE "TaskGraphRun" (
    "id" TEXT NOT NULL,
    "parentTaskId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "requestKey" TEXT NOT NULL,
    "snapshotHash" TEXT NOT NULL,
    "snapshot" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'running',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TaskGraphRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TaskGraphNode" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "dependsOn" TEXT[],
    "acceptance" TEXT NOT NULL,
    "reviewerId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'planned',
    "evidence" JSONB,
    "claimToken" TEXT,
    "claimedAt" TIMESTAMP(3),
    "passedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TaskGraphNode_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TaskGraphExecution" (
    "id" TEXT NOT NULL,
    "nodeId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "repository" TEXT NOT NULL,
    "gitRef" TEXT NOT NULL,
    "baseCommit" TEXT NOT NULL,
    "agentSelector" TEXT NOT NULL,
    "launchConfig" JSONB,
    "status" TEXT NOT NULL DEFAULT 'planned',
    "issueKind" TEXT,
    "claimToken" TEXT,
    "claimedAt" TIMESTAMP(3),
    "childTaskId" TEXT,
    "sessionId" TEXT,
    "taskRunId" TEXT,
    "worktreePath" TEXT,
    "worktreeBranch" TEXT,
    "dispatchMetadata" JSONB,
    "commit" TEXT,
    "evidence" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TaskGraphExecution_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TaskGraphEvent" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "nodeId" TEXT,
    "idempotencyKey" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TaskGraphEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "TaskGraphRun_requestKey_key" ON "TaskGraphRun"("requestKey");

-- CreateIndex
CREATE INDEX "TaskGraphRun_status_idx" ON "TaskGraphRun"("status");

-- CreateIndex
CREATE UNIQUE INDEX "TaskGraphRun_parentTaskId_version_key" ON "TaskGraphRun"("parentTaskId", "version");

-- CreateIndex
CREATE INDEX "TaskGraphNode_runId_status_idx" ON "TaskGraphNode"("runId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "TaskGraphNode_runId_key_key" ON "TaskGraphNode"("runId", "key");

-- CreateIndex
CREATE UNIQUE INDEX "TaskGraphExecution_childTaskId_key" ON "TaskGraphExecution"("childTaskId");

-- CreateIndex
CREATE INDEX "TaskGraphExecution_nodeId_status_idx" ON "TaskGraphExecution"("nodeId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "TaskGraphExecution_nodeId_key_key" ON "TaskGraphExecution"("nodeId", "key");

-- CreateIndex
CREATE INDEX "TaskGraphEvent_runId_createdAt_idx" ON "TaskGraphEvent"("runId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "TaskGraphEvent_runId_idempotencyKey_key" ON "TaskGraphEvent"("runId", "idempotencyKey");

-- AddForeignKey
ALTER TABLE "TaskGraphRun" ADD CONSTRAINT "TaskGraphRun_parentTaskId_fkey" FOREIGN KEY ("parentTaskId") REFERENCES "Task"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaskGraphNode" ADD CONSTRAINT "TaskGraphNode_runId_fkey" FOREIGN KEY ("runId") REFERENCES "TaskGraphRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaskGraphExecution" ADD CONSTRAINT "TaskGraphExecution_nodeId_fkey" FOREIGN KEY ("nodeId") REFERENCES "TaskGraphNode"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaskGraphExecution" ADD CONSTRAINT "TaskGraphExecution_childTaskId_fkey" FOREIGN KEY ("childTaskId") REFERENCES "Task"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaskGraphEvent" ADD CONSTRAINT "TaskGraphEvent_runId_fkey" FOREIGN KEY ("runId") REFERENCES "TaskGraphRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaskGraphEvent" ADD CONSTRAINT "TaskGraphEvent_nodeId_fkey" FOREIGN KEY ("nodeId") REFERENCES "TaskGraphNode"("id") ON DELETE CASCADE ON UPDATE CASCADE;

