-- AlterTable
ALTER TABLE "Agent" ADD COLUMN "runtimeAgentId" TEXT;

-- CreateIndex
CREATE INDEX "Agent_runtimeAgentId_idx" ON "Agent"("runtimeAgentId");
