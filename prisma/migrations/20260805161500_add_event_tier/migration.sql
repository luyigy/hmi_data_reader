-- AlterTable: add tier column to TaskRunEvent for execution info folding
ALTER TABLE "TaskRunEvent" ADD COLUMN "tier" TEXT NOT NULL DEFAULT 'summary';
