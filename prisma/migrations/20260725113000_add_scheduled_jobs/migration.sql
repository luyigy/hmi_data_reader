CREATE TABLE "ScheduledJobState" (
  "id" TEXT NOT NULL,
  "projectId" TEXT NOT NULL,
  "jobId" TEXT NOT NULL,
  "enabledOverride" BOOLEAN,
  "modeOverride" TEXT,
  "lastScheduledAt" TIMESTAMP(3),
  "lastStartedAt" TIMESTAMP(3),
  "lastFinishedAt" TIMESTAMP(3),
  "lastSuccessAt" TIMESTAMP(3),
  "lastError" TEXT,
  "cursorJson" JSONB,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ScheduledJobState_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ScheduledJobRun" (
  "id" TEXT NOT NULL,
  "projectId" TEXT NOT NULL,
  "jobId" TEXT NOT NULL,
  "trigger" TEXT NOT NULL,
  "mode" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "scheduledFor" TIMESTAMP(3) NOT NULL,
  "startedAt" TIMESTAMP(3) NOT NULL,
  "finishedAt" TIMESTAMP(3),
  "summary" TEXT,
  "error" TEXT,
  "idempotencyKey" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ScheduledJobRun_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ScheduledJobState_projectId_jobId_key" ON "ScheduledJobState"("projectId", "jobId");
CREATE UNIQUE INDEX "ScheduledJobRun_idempotencyKey_key" ON "ScheduledJobRun"("idempotencyKey");
CREATE INDEX "ScheduledJobRun_projectId_jobId_startedAt_idx" ON "ScheduledJobRun"("projectId", "jobId", "startedAt");
