CREATE TABLE "ScheduledJobRequest" (
  "id" TEXT NOT NULL,
  "projectId" TEXT NOT NULL,
  "jobId" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "claimedAt" TIMESTAMP(3),
  "finishedAt" TIMESTAMP(3),
  "error" TEXT,

  CONSTRAINT "ScheduledJobRequest_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ScheduledJobRequest_status_requestedAt_idx"
ON "ScheduledJobRequest"("status", "requestedAt");
