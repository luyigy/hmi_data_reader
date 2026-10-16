ALTER TABLE "TaskGraphProposal" ADD COLUMN "routeImageKey" TEXT;

CREATE TABLE "TaskGraphArtifactDelivery" (
  "key" TEXT NOT NULL,
  "parentTaskId" TEXT NOT NULL,
  "artifactPath" TEXT NOT NULL,
  "contentHash" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'sending',
  "messageId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "TaskGraphArtifactDelivery_pkey" PRIMARY KEY ("key")
);
CREATE INDEX "TaskGraphArtifactDelivery_parentTaskId_status_idx" ON "TaskGraphArtifactDelivery"("parentTaskId", "status");
ALTER TABLE "TaskGraphArtifactDelivery" ADD CONSTRAINT "TaskGraphArtifactDelivery_parentTaskId_fkey"
  FOREIGN KEY ("parentTaskId") REFERENCES "Task"("id") ON DELETE CASCADE ON UPDATE CASCADE;
