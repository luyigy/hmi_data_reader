ALTER TABLE "Task" ADD COLUMN "ownerUserId" TEXT;
ALTER TABLE "LiveRoom" ADD COLUMN "ownerUserId" TEXT;
ALTER TABLE "RemoteNode" ADD COLUMN "ownerUserId" TEXT;

CREATE INDEX "Task_ownerUserId_idx" ON "Task"("ownerUserId");
CREATE INDEX "LiveRoom_ownerUserId_idx" ON "LiveRoom"("ownerUserId");
CREATE INDEX "RemoteNode_ownerUserId_idx" ON "RemoteNode"("ownerUserId");

ALTER TABLE "Task" ADD CONSTRAINT "Task_ownerUserId_fkey"
  FOREIGN KEY ("ownerUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "LiveRoom" ADD CONSTRAINT "LiveRoom_ownerUserId_fkey"
  FOREIGN KEY ("ownerUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "RemoteNode" ADD CONSTRAINT "RemoteNode_ownerUserId_fkey"
  FOREIGN KEY ("ownerUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
