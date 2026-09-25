DROP INDEX IF EXISTS "SearchRun_messageId_key";
CREATE INDEX "SearchRun_messageId_searchedAt_idx" ON "SearchRun"("messageId", "searchedAt");
