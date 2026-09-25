ALTER TABLE "Presentation" ADD COLUMN "idempotencyKey" TEXT;
CREATE UNIQUE INDEX "Presentation_idempotencyKey_key" ON "Presentation"("idempotencyKey");
