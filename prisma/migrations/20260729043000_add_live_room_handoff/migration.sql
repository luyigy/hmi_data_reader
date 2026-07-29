ALTER TABLE "LiveRoom"
ADD COLUMN "handoffLimit" INTEGER NOT NULL DEFAULT 4;

ALTER TABLE "LiveRoomMessage"
ADD COLUMN "handoffRootMessageId" TEXT,
ADD COLUMN "handoffLimitSnapshot" INTEGER,
ADD COLUMN "handoffCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "handoffClaimStatus" TEXT,
ADD COLUMN "handoffTargetMemberId" TEXT;

ALTER TABLE "LiveRoomDelivery"
ADD COLUMN "handoffRootMessageId" TEXT;

CREATE INDEX "LiveRoomMessage_handoffRootMessageId_idx"
ON "LiveRoomMessage"("handoffRootMessageId");

CREATE INDEX "LiveRoomMessage_handoffClaimStatus_idx"
ON "LiveRoomMessage"("handoffClaimStatus");

CREATE INDEX "LiveRoomDelivery_handoffRootMessageId_idx"
ON "LiveRoomDelivery"("handoffRootMessageId");
