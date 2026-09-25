CREATE TYPE "PresentationStatus" AS ENUM ('PENDING', 'PROCESSING', 'READY', 'FAILED');

ALTER TABLE "Presentation"
  ADD COLUMN "requestedPrompt" TEXT NOT NULL DEFAULT '',
  ADD COLUMN "status" "PresentationStatus" NOT NULL DEFAULT 'READY',
  ADD COLUMN "progress" INTEGER NOT NULL DEFAULT 100,
  ADD COLUMN "errorMessage" TEXT,
  ADD COLUMN "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

ALTER TABLE "Presentation" ALTER COLUMN "status" SET DEFAULT 'PENDING';
ALTER TABLE "Presentation" ALTER COLUMN "progress" SET DEFAULT 0;
CREATE INDEX "Presentation_conversationId_createdAt_idx" ON "Presentation"("conversationId", "createdAt");
