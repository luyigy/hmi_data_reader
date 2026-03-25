-- CreateTable
CREATE TABLE "RemoteHarnessHost" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "label" TEXT NOT NULL,
    "host" TEXT NOT NULL,
    "port" INTEGER NOT NULL DEFAULT 22,
    "sshUser" TEXT NOT NULL,
    "authType" TEXT NOT NULL DEFAULT 'ssh_key',
    "encryptedPrivateKey" TEXT,
    "workingDirectory" TEXT,
    "status" TEXT NOT NULL DEFAULT 'offline',
    "viaNetwork" TEXT NOT NULL DEFAULT 'wireguard',
    "supportedHarnesses" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateIndex
CREATE INDEX "RemoteHarnessHost_status_idx" ON "RemoteHarnessHost"("status");

-- CreateIndex
CREATE INDEX "RemoteHarnessHost_label_idx" ON "RemoteHarnessHost"("label");
