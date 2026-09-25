ALTER TABLE "Conversation"
  ADD COLUMN "meetingStatus" "ProcessingStatus",
  ADD COLUMN "meetingErrorMessage" TEXT;
UPDATE "Conversation" SET "meetingStatus" = 'READY' WHERE "mode" = 'MEETING' AND EXISTS (SELECT 1 FROM "Meeting" WHERE "Meeting"."conversationId" = "Conversation"."id");
