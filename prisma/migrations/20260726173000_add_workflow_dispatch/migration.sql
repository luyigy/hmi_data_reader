CREATE TABLE "WorkflowDispatch" (
  "id" TEXT NOT NULL,
  "projectId" TEXT NOT NULL,
  "jobId" TEXT NOT NULL,
  "eventKey" TEXT NOT NULL,
  "state" TEXT NOT NULL DEFAULT 'prepared',
  "roomId" TEXT,
  "feishuMessageId" TEXT,
  "messageId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "WorkflowDispatch_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "WorkflowDispatch_projectId_jobId_eventKey_key"
ON "WorkflowDispatch"("projectId", "jobId", "eventKey");
