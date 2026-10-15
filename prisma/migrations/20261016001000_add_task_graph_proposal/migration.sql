CREATE TABLE "TaskGraphProposal" (
    "id" TEXT NOT NULL,
    "parentTaskId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "snapshotHash" TEXT NOT NULL,
    "definition" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "createdBy" TEXT NOT NULL,
    "decidedBy" TEXT,
    "decidedAt" TIMESTAMP(3),
    "cardMessageId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TaskGraphProposal_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "TaskGraphProposal_parentTaskId_version_key" ON "TaskGraphProposal"("parentTaskId", "version");
CREATE INDEX "TaskGraphProposal_parentTaskId_status_idx" ON "TaskGraphProposal"("parentTaskId", "status");
ALTER TABLE "TaskGraphProposal" ADD CONSTRAINT "TaskGraphProposal_parentTaskId_fkey" FOREIGN KEY ("parentTaskId") REFERENCES "Task"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
