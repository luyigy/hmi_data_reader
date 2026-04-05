CREATE TABLE "TaskRunInteractionRequest" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "taskId" TEXT NOT NULL,
    "taskSessionId" TEXT,
    "taskRunId" TEXT NOT NULL,
    "participantId" TEXT,
    "roomMessageId" TEXT,
    "source" TEXT NOT NULL DEFAULT 'harness',
    "requestKind" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "title" TEXT,
    "message" TEXT NOT NULL,
    "rawPayload" TEXT,
    "optionsJson" TEXT,
    "defaultAnswer" TEXT,
    "responseText" TEXT,
    "responseMetadata" TEXT,
    "requestedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" DATETIME,
    "expiresAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "TaskRunInteractionRequest_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "TaskRunInteractionRequest_taskSessionId_fkey" FOREIGN KEY ("taskSessionId") REFERENCES "TaskSession" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "TaskRunInteractionRequest_taskRunId_fkey" FOREIGN KEY ("taskRunId") REFERENCES "TaskRun" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "TaskRunInteractionRequest_participantId_fkey" FOREIGN KEY ("participantId") REFERENCES "TaskRunParticipant" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE INDEX "TaskRunInteractionRequest_taskRunId_createdAt_idx" ON "TaskRunInteractionRequest"("taskRunId", "createdAt");
CREATE INDEX "TaskRunInteractionRequest_participantId_status_idx" ON "TaskRunInteractionRequest"("participantId", "status");
CREATE INDEX "TaskRunInteractionRequest_status_expiresAt_idx" ON "TaskRunInteractionRequest"("status", "expiresAt");
