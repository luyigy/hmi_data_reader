CREATE TABLE "PairingTicket" (
    "id" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "ownerUserId" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PairingTicket_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "PairingTicket_tokenHash_key" ON "PairingTicket"("tokenHash");
CREATE INDEX "PairingTicket_ownerUserId_expiresAt_idx" ON "PairingTicket"("ownerUserId", "expiresAt");
ALTER TABLE "PairingTicket" ADD CONSTRAINT "PairingTicket_ownerUserId_fkey"
  FOREIGN KEY ("ownerUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
