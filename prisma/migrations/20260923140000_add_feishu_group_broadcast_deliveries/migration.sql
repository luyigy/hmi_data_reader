CREATE TABLE "FeishuGroupBroadcastMemberDelivery" (
    "id" TEXT NOT NULL,
    "targetId" TEXT NOT NULL,
    "memberKey" TEXT NOT NULL,
    "sessionKey" TEXT NOT NULL,
    "endOffset" INTEGER NOT NULL,
    "complete" BOOLEAN NOT NULL DEFAULT false,
    "ackedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "FeishuGroupBroadcastMemberDelivery_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "FeishuGroupBroadcastMemberDelivery_targetId_memberKey_sessionKey_key"
    ON "FeishuGroupBroadcastMemberDelivery"("targetId", "memberKey", "sessionKey");
CREATE INDEX "FeishuGroupBroadcastMemberDelivery_memberKey_sessionKey_idx"
    ON "FeishuGroupBroadcastMemberDelivery"("memberKey", "sessionKey");
ALTER TABLE "FeishuGroupBroadcastMemberDelivery"
    ADD CONSTRAINT "FeishuGroupBroadcastMemberDelivery_targetId_fkey"
    FOREIGN KEY ("targetId") REFERENCES "FeishuGroupBroadcastTarget"("id") ON DELETE CASCADE ON UPDATE CASCADE;
