-- Enforce the tenant invariants that cannot be expressed by the current
-- Prisma relation graph because userId is intentionally denormalized for
-- efficient scoping. These constraints prevent a compromised service path
-- from linking one user's child record to another user's conversation.

CREATE OR REPLACE FUNCTION enforce_conversation_user_match()
RETURNS trigger AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM "Conversation"
    WHERE "id" = NEW."conversationId" AND "userId" = NEW."userId"
  ) THEN
    RAISE EXCEPTION 'tenant ownership mismatch' USING ERRCODE = '23503';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "AgentRun_tenant_integrity"
BEFORE INSERT OR UPDATE OF "conversationId", "userId" ON "AgentRun"
FOR EACH ROW EXECUTE FUNCTION enforce_conversation_user_match();

CREATE TRIGGER "FileAsset_tenant_integrity"
BEFORE INSERT OR UPDATE OF "conversationId", "userId" ON "FileAsset"
FOR EACH ROW EXECUTE FUNCTION enforce_conversation_user_match();

CREATE OR REPLACE FUNCTION enforce_todo_user_match()
RETURNS trigger AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM "Meeting" m
    JOIN "Conversation" c ON c."id" = m."conversationId"
    WHERE m."id" = NEW."meetingId" AND c."userId" = NEW."userId"
  ) THEN
    RAISE EXCEPTION 'tenant ownership mismatch' USING ERRCODE = '23503';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "Todo_tenant_integrity"
BEFORE INSERT OR UPDATE OF "meetingId", "userId" ON "Todo"
FOR EACH ROW EXECUTE FUNCTION enforce_todo_user_match();

CREATE OR REPLACE FUNCTION enforce_meeting_document_scope()
RETURNS trigger AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM "Meeting" m
    JOIN "FileAsset" f ON f."id" = NEW."fileId"
    WHERE m."id" = NEW."meetingId" AND m."conversationId" = f."conversationId"
  ) THEN
    RAISE EXCEPTION 'meeting document scope mismatch' USING ERRCODE = '23503';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "MeetingDocument_scope_integrity"
BEFORE INSERT OR UPDATE OF "meetingId", "fileId" ON "MeetingDocument"
FOR EACH ROW EXECUTE FUNCTION enforce_meeting_document_scope();
