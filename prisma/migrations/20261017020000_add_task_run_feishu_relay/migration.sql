CREATE TABLE "TaskRunFeishuRelay" (
  "taskRunId" TEXT NOT NULL,
  "bindingId" TEXT NOT NULL,
  "messageId" TEXT,
  "deliveredSequence" INTEGER NOT NULL DEFAULT -1,
  "lastStatus" TEXT NOT NULL DEFAULT '',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "TaskRunFeishuRelay_pkey" PRIMARY KEY ("taskRunId")
);
ALTER TABLE "TaskRunFeishuRelay" ADD CONSTRAINT "TaskRunFeishuRelay_taskRunId_fkey"
FOREIGN KEY ("taskRunId") REFERENCES "TaskRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;
