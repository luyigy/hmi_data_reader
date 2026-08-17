-- LiveRoom room-level execution timeout in milliseconds.
-- NULL keeps the existing backend defaults (remote SSH / remote runner: 10 minutes;
-- Platform Local codex/claude/kimi-code: unlimited). Explicit values are stored as
-- whole minutes converted to milliseconds (1-1440 minutes).
ALTER TABLE "LiveRoom"
ADD COLUMN "executionTimeoutMs" INTEGER;
