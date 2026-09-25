import "reflect-metadata";
import { randomUUID } from "node:crypto";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { PrismaClient } from "@prisma/client";
import { MemoriesService } from "../src/modules/memories/memories.service.js";
import { RedisService } from "../src/infra/redis.service.js";
import { PresentationsService } from "../src/modules/presentations/presentations.service.js";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { MeetingsService } from "../src/modules/meetings/meetings.service.js";
import { RetrievalService } from "../src/modules/files/retrieval.service.js";
import { EmbeddingService } from "../src/modules/files/embedding.service.js";
import { AgentRuntimeService } from "../src/modules/agent/agent-runtime.service.js";
import { ConversationsService } from "../src/modules/conversations/conversations.service.js";
import { SearchService } from "../src/modules/search/search.service.js";
import { createModels, fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai";

const integration = process.env.RUN_INTEGRATION === "true" ? describe : describe.skip;

function cookies(response: request.Response) {
  const header = response.headers["set-cookie"] as unknown as string[] | undefined;
  return (header ?? []).map((value) => value.split(";", 1)[0]).join("; ");
}

function cookieValue(response: request.Response, name: string) {
  const header = response.headers["set-cookie"] as unknown as string[] | undefined;
  return (header ?? []).find((value) => value.startsWith(`${name}=`))?.split(";", 1)[0] ?? "";
}

function textPdf(pages: string[]) {
  const objects: string[] = [];
  const pageRefs = pages.map((_, index) => `${4 + index * 2} 0 R`).join(" ");
  objects[1] = "<< /Type /Catalog /Pages 2 0 R >>";
  objects[2] = `<< /Type /Pages /Kids [${pageRefs}] /Count ${pages.length} >>`;
  objects[3] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>";
  pages.forEach((text, index) => {
    const pageId = 4 + index * 2;
    const contentId = pageId + 1;
    const escaped = text.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
    const stream = `BT /F1 12 Tf 72 720 Td (${escaped}) Tj ET`;
    objects[pageId] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${contentId} 0 R >>`;
    objects[contentId] = `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`;
  });
  let output = "%PDF-1.4\n";
  const offsets = [0];
  for (let id = 1; id < objects.length; id++) {
    offsets[id] = Buffer.byteLength(output);
    output += `${id} 0 obj\n${objects[id]}\nendobj\n`;
  }
  const xref = Buffer.byteLength(output);
  output += `xref\n0 ${objects.length}\n0000000000 65535 f \n`;
  for (let id = 1; id < objects.length; id++) output += `${String(offsets[id]).padStart(10, "0")} 00000 n \n`;
  output += `trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(output);
}

async function waitForFile(baseUrl: string, cookie: string, conversationId: string, fileId: string, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const detail = await request(baseUrl).get(`/api/conversations/${conversationId}`).set("Cookie", cookie).expect(200);
    const file = detail.body.files.find((item: { id: string }) => item.id === fileId);
    if (file?.status === "READY" || file?.status === "FAILED") return file;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`file ${fileId} did not finish in ${timeoutMs}ms`);
}

integration("API auth, tenant isolation and cascade integration", () => {
  const baseUrl = process.env.INTEGRATION_API_URL ?? "http://localhost:3001";
  let prisma: PrismaClient;
  let redis: RedisService;
  const users: string[] = [];

  beforeAll(async () => {
    prisma = new PrismaClient();
    await prisma.$connect();
    redis = new RedisService();
    await redis.ping();
    await request(baseUrl).get("/api/health/ready").expect(200);
  }, 30_000);

  afterAll(async () => {
    if (prisma && users.length) await prisma.user.deleteMany({ where: { username: { in: users } } });
    await redis?.onModuleDestroy();
    await prisma?.$disconnect();
  });

  async function register(label: string) {
    const username = `it_${label.slice(0, 8)}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
    users.push(username);
    const response = await request(baseUrl).post("/api/auth/register").send({ username, password: "Integration123!" }).expect(201);
    expect(response.body.user.username).toBe(username);
    return { username, userId: response.body.user.id as string, cookie: cookies(response), refresh: cookieValue(response, "nbboss_refresh") };
  }

  it("rotates refresh tokens and revokes the active refresh token on logout", async () => {
    const user = await register("refresh");
    const refreshed = await request(baseUrl).post("/api/auth/refresh").set("Cookie", user.refresh).expect(201);
    const rotated = cookieValue(refreshed, "nbboss_refresh");
    expect(rotated).toContain("nbboss_refresh=");
    expect(rotated).not.toBe(user.refresh);
    await request(baseUrl).post("/api/auth/refresh").set("Cookie", user.refresh).expect(401);
    await request(baseUrl).post("/api/auth/logout").set("Cookie", rotated).expect(201);
    await request(baseUrl).post("/api/auth/refresh").set("Cookie", rotated).expect(401);
  });

  it("returns 404 across tenants and cascades conversation data, files and source memory", async () => {
    const owner = await register("owner");
    const attacker = await register("attacker");
    const created = await request(baseUrl).post("/api/conversations").set("Cookie", owner.cookie).send({ mode: "CHAT", title: "cascade" }).expect(201);
    const conversationId = created.body.id as string;

    await request(baseUrl).get(`/api/conversations/${conversationId}`).set("Cookie", attacker.cookie).expect(404);
    await request(baseUrl).delete(`/api/conversations/${conversationId}`).set("Cookie", attacker.cookie).expect(404);

    const sourcePath = `/non-public/${owner.userId}/${conversationId}/source.pdf`;
    const pptxPath = `/non-public/${owner.userId}/${conversationId}/v1.pptx`;

    const file = await prisma.fileAsset.create({ data: { userId: owner.userId, conversationId, kind: "PDF", originalName: "source.pdf", storagePath: sourcePath, mimeType: "application/pdf", size: 9, sha256: "a".repeat(64), status: "READY" } });
    await prisma.documentPage.create({ data: { fileId: file.id, pageNo: 1, text: "evidence" } });
    await prisma.documentChunk.create({ data: { fileId: file.id, pageStart: 1, pageEnd: 1, charStart: 0, charEnd: 8, content: "evidence", tokenCount: 2 } });
    await prisma.message.create({ data: { conversationId, role: "USER", content: "hello" } });
    const run = await prisma.agentRun.create({ data: { userId: owner.userId, conversationId, model: "faux", status: "COMPLETED" } });
    await prisma.agentEvent.create({ data: { runId: run.id, sequence: 0, eventType: "agent_end" } });
    await prisma.toolExecution.create({ data: { runId: run.id, toolCallId: "tool-1", toolName: "retrieve_documents", status: "COMPLETED" } });
    const presentation = await prisma.presentation.create({ data: { id: randomUUID(), conversationId, title: "deck", requestedPrompt: "deck", status: "READY", progress: 100 } });
    const version = await prisma.presentationVersion.create({ data: { presentationId: presentation.id, version: 1, prompt: "deck", slideJson: { title: "deck", slides: [] }, pptxPath } });
    const meeting = await prisma.meeting.create({ data: { conversationId, title: "meeting", analysis: {} } });
    const risk = await prisma.risk.create({ data: { meetingId: meeting.id, severity: "MEDIUM", description: "risk", evidence: [] } });
    const todo = await prisma.todo.create({ data: { userId: owner.userId, meetingId: meeting.id, riskId: risk.id, title: "todo", description: "todo", idempotencyKey: `it-${conversationId}` } });
    const entity = await prisma.memoryEntity.create({ data: { userId: owner.userId, type: "TOPIC", canonicalName: "cascade-memory" } });
    const sourceFact = await prisma.memoryFact.create({ data: { entityId: entity.id, attribute: "name", value: "from conversation", sourceType: "CONVERSATION", sourceId: run.id } });
    const userFact = await prisma.memoryFact.create({ data: { entityId: entity.id, attribute: "name", value: "user override", sourceType: "USER", sourceId: owner.userId, userEdited: true } });
    const meetingFact = await prisma.memoryFact.create({ data: { entityId: entity.id, attribute: "meeting", value: "from meeting", sourceType: "MEETING", sourceId: meeting.id } });
    await prisma.memoryFact.update({ where: { id: sourceFact.id }, data: { supersededById: userFact.id } });

    await expect(prisma.agentRun.create({ data: { userId: attacker.userId, conversationId, model: "faux" } })).rejects.toThrow();
    await expect(prisma.fileAsset.create({ data: { userId: attacker.userId, conversationId, kind: "PDF", originalName: "cross-user.pdf", storagePath: "/invalid", mimeType: "application/pdf", size: 1, sha256: "b".repeat(64) } })).rejects.toThrow();
    await expect(prisma.todo.create({ data: { userId: attacker.userId, meetingId: meeting.id, title: "cross-user", description: "invalid", idempotencyKey: `invalid-${conversationId}` } })).rejects.toThrow();

    await request(baseUrl).get(`/api/files/${file.id}`).set("Cookie", attacker.cookie).expect(404);
    await request(baseUrl).delete(`/api/files/${file.id}`).set("Cookie", attacker.cookie).expect(404);
    await request(baseUrl).get(`/api/conversations/${conversationId}/meetings`).set("Cookie", attacker.cookie).expect(404);
    await request(baseUrl).patch(`/api/todos/${todo.id}`).set("Cookie", attacker.cookie).send({ status: "COMPLETED" }).expect(404);
    await request(baseUrl).delete(`/api/todos/${todo.id}`).set("Cookie", attacker.cookie).expect(404);
    await request(baseUrl).patch(`/api/memories/facts/${userFact.id}`).set("Cookie", attacker.cookie).send({ value: "tampered" }).expect(404);
    await request(baseUrl).delete(`/api/memories/${entity.id}`).set("Cookie", attacker.cookie).expect(404);
    await request(baseUrl).get(`/api/presentations/${presentation.id}/versions`).set("Cookie", attacker.cookie).expect(404);
    await request(baseUrl).get(`/api/presentation-versions/${version.id}/download`).set("Cookie", attacker.cookie).expect(404);
    await request(baseUrl).post(`/api/conversations/${conversationId}/presentations`).set("Cookie", attacker.cookie).send({ prompt: "deck" }).expect(404);

    await request(baseUrl).delete(`/api/conversations/${conversationId}`).set("Cookie", owner.cookie).expect(200);
    expect(await prisma.conversation.count({ where: { id: conversationId } })).toBe(0);
    expect(await prisma.fileAsset.count({ where: { id: file.id } })).toBe(0);
    expect(await prisma.agentRun.count({ where: { id: run.id } })).toBe(0);
    expect(await prisma.presentation.count({ where: { id: presentation.id } })).toBe(0);
    expect(await prisma.todo.count({ where: { id: todo.id } })).toBe(0);
    expect(await prisma.memoryFact.count({ where: { id: sourceFact.id } })).toBe(0);
    expect(await prisma.memoryFact.count({ where: { id: meetingFact.id } })).toBe(0);
    expect(await prisma.memoryFact.count({ where: { id: userFact.id, supersededById: null } })).toBe(1);
  }, 30_000);

  it("serializes concurrent memory updates, retains late history and keeps user edits current", async () => {
    const owner = await register("memory");
    const service = new MemoriesService(prisma as never, {} as never, redis);
    const common = { entityType: "PERSON", entityName: "项目负责人", attribute: "所在城市", confidence: 0.9, effectiveAt: null } as const;

    // Deliberately submit a newer and an older observation concurrently. The
    // Redis lock must prevent a branched history, while fact time—not job
    // completion order—selects the current value.
    await Promise.all([
      (service as any).upsertFact(owner.userId, "CONVERSATION", "newer-run", new Date("2026-03-01T00:00:00Z"), { ...common, value: "上海" }),
      (service as any).upsertFact(owner.userId, "CONVERSATION", "older-run", new Date("2026-02-01T00:00:00Z"), { ...common, value: "杭州" }),
    ]);

    const entity = await prisma.memoryEntity.findUniqueOrThrow({
      where: { userId_type_canonicalName: { userId: owner.userId, type: "PERSON", canonicalName: "项目负责人" } },
    });
    let facts = await prisma.memoryFact.findMany({ where: { entityId: entity.id, attribute: common.attribute } });
    expect(facts).toHaveLength(2);
    expect(facts.filter((fact) => fact.supersededById === null).map((fact) => fact.value)).toEqual(["上海"]);

    const current = facts.find((fact) => fact.supersededById === null)!;
    const userEdit = await service.update(owner.userId, current.id, "北京");
    await (service as any).upsertFact(owner.userId, "MEETING", "later-meeting", new Date("2026-04-01T00:00:00Z"), { ...common, value: "深圳" });

    facts = await prisma.memoryFact.findMany({ where: { entityId: entity.id, attribute: common.attribute } });
    expect(facts).toHaveLength(4);
    const currentFacts = facts.filter((fact) => fact.supersededById === null);
    expect(currentFacts).toHaveLength(1);
    expect(currentFacts[0]).toMatchObject({ id: userEdit.id, value: "北京", userEdited: true });

    // Every non-current row has one successor and all rows form one acyclic
    // chain ending at the sole current value.
    const byId = new Map(facts.map((fact) => [fact.id, fact]));
    const referenced = new Set(facts.flatMap((fact) => fact.supersededById ? [fact.supersededById] : []));
    const heads = facts.filter((fact) => !referenced.has(fact.id));
    expect(heads).toHaveLength(1);
    const visited = new Set<string>();
    let cursor: typeof facts[number] | undefined = heads[0];
    while (cursor) {
      expect(visited.has(cursor.id)).toBe(false);
      visited.add(cursor.id);
      cursor = cursor.supersededById ? byId.get(cursor.supersededById) : undefined;
    }
    expect(visited.size).toBe(facts.length);
  }, 30_000);

  it("does not persist memory when its source is deleted during model extraction", async () => {
    const owner = await register("memory_race");
    const conversation = await prisma.conversation.create({ data: { userId: owner.userId, mode: "CHAT", title: "memory deletion race" } });
    const run = await prisma.agentRun.create({ data: { userId: owner.userId, conversationId: conversation.id, model: "faux", status: "COMPLETED" } });
    let release!: (value: unknown) => void;
    const pending = new Promise<unknown>((resolve) => { release = resolve; });
    const started = Promise.withResolvers<void>();
    const models = { runStructuredAgent: vi.fn(async () => { started.resolve(); return pending; }) };
    const service = new MemoriesService(prisma as never, models as never, redis);

    const extraction = service.extract(
      owner.userId,
      "CONVERSATION",
      run.id,
      "项目负责人王芳确认后续长期在上海办公室推进交付，这是一条足够长且应当被删除竞态拦截的事实。",
      new Date("2026-09-25T00:00:00Z"),
    );
    await started.promise;
    await prisma.conversation.delete({ where: { id: conversation.id } });
    release({ facts: [{ entityType: "PERSON", entityName: "王芳", attribute: "办公地点", value: "上海", confidence: 0.9, effectiveAt: null }] });
    await extraction;

    expect(await prisma.memoryEntity.count({ where: { userId: owner.userId, canonicalName: "王芳" } })).toBe(0);
    expect(await prisma.memoryFact.count({ where: { sourceId: run.id } })).toBe(0);
  }, 30_000);

  it("rejects oversized uploads and never derives storage paths from hostile filenames", async () => {
    const owner = await register("upload");
    const created = await request(baseUrl).post("/api/conversations").set("Cookie", owner.cookie).send({ mode: "CHAT", title: "upload-security" }).expect(201);
    const conversationId = created.body.id as string;

    const payload = Buffer.from("%PDF-1.4\n% integration fixture\n");
    const uploaded = await request(baseUrl)
      .post(`/api/conversations/${conversationId}/files`)
      .set("Cookie", owner.cookie)
      .attach("file", payload, { filename: "../../escape.pdf", contentType: "application/pdf" })
      .expect(201);
    const fileId = uploaded.body.id as string;
    const row = await prisma.fileAsset.findUniqueOrThrow({ where: { id: fileId } });
    expect(row.storagePath).not.toContain("escape.pdf");
    expect(row.storagePath).toContain(owner.userId);
    expect(row.storagePath).toContain(conversationId);
    const download = await request(baseUrl).get(`/api/files/${fileId}`).set("Cookie", owner.cookie).expect(200);
    expect(Buffer.compare(download.body as Buffer, payload)).toBe(0);

    const oversized = Buffer.alloc(20 * 1024 * 1024 + 1, 0x20);
    oversized.write("%PDF-", 0, "ascii");
    const rejection = await request(baseUrl)
      .post(`/api/conversations/${conversationId}/files`)
      .set("Cookie", owner.cookie)
      .attach("file", oversized, { filename: "large.pdf", contentType: "application/pdf" })
      .expect(413);
    expect(JSON.stringify(rejection.body)).toContain("大小限制");

    await request(baseUrl).delete(`/api/conversations/${conversationId}`).set("Cookie", owner.cookie).expect(200);
    await request(baseUrl).get(`/api/files/${fileId}`).set("Cookie", owner.cookie).expect(404);
    expect(await prisma.fileAsset.count({ where: { id: fileId } })).toBe(0);
  }, 30_000);

  it("serializes concurrent PPT edits into immutable sequential versions", async () => {
    const owner = await register("ppt_versions");
    const conversation = await prisma.conversation.create({ data: { userId: owner.userId, mode: "CHAT", title: "ppt versions" } });
    const presentation = await prisma.presentation.create({ data: { conversationId: conversation.id, title: "deck", requestedPrompt: "deck", status: "READY", progress: 100 } });
    const service = new PresentationsService(prisma as never, {} as never, {} as never, {} as never, redis);
    const document = (label: string) => ({ title: "并发版本", slides: [{ id: "s1", title: label, notes: "", elements: [{ id: "e1", type: "text" as const, text: label, x: 1, y: 1, w: 5, h: 1, fontSize: 24, color: "111827", bold: true }] }] });
    const [first, second] = await Promise.all([
      service.saveVersion(owner.userId, presentation.id, "edit-a", document("版本 A")),
      service.saveVersion(owner.userId, presentation.id, "edit-b", document("版本 B")),
    ]);
    expect([first.version, second.version].sort()).toEqual([1, 2]);
    const rows = await prisma.presentationVersion.findMany({ where: { presentationId: presentation.id }, orderBy: { version: "asc" } });
    expect(rows.map((row) => row.version)).toEqual([1, 2]);
    expect(new Set(rows.map((row) => JSON.stringify(row.slideJson))).size).toBe(2);
    for (const row of rows) expect((await readFile(row.pptxPath)).subarray(0, 2).toString()).toBe("PK");
    await rm(join(process.env.STORAGE_ROOT ?? join(process.cwd(), "data", "uploads"), owner.userId, conversation.id), { recursive: true, force: true });
  }, 30_000);

  it("reuses per-file meeting cache, filters invented evidence and lets force bypass cache", async () => {
    const owner = await register("meeting_cache");
    const conversation = await prisma.conversation.create({ data: { userId: owner.userId, mode: "MEETING", title: "meeting cache" } });
    const firstFile = await prisma.fileAsset.create({ data: { userId: owner.userId, conversationId: conversation.id, kind: "TXT", originalName: "first.txt", storagePath: "/test/first.txt", mimeType: "text/plain", size: 100, sha256: "1".repeat(64), status: "READY" } });
    await prisma.documentPage.create({ data: { fileId: firstFile.id, pageNo: 1, text: "王芳承诺完成验收文档，但没有给出截止日期。" } });
    const prompts: string[] = [];
    const models = { runStructuredAgent: vi.fn(async (_system: string, prompt: string) => {
      prompts.push(prompt);
      return { meetings: [{
        sourceFileIds: [firstFile.id], title: "项目周会", summary: "讨论验收", participants: ["王芳"], time: null, location: null,
        topics: ["验收"], decisions: [], commitments: ["王芳承诺完成验收文档"], grouping: "SAME_MEETING", insights: ["需补齐时间"],
        risks: [
          { severity: "HIGH", description: "承诺缺少截止时间", evidence: [{ fileId: firstFile.id, fileName: "wrong-name.txt", quote: "王芳承诺完成验收文档" }], todo: { title: "确认验收文档期限", description: "补齐日期", owner: "王芳", dueAt: null } },
          { severity: "LOW", description: "模型编造的风险", evidence: [{ fileId: firstFile.id, fileName: "first.txt", quote: "原文不存在的句子" }], todo: { title: "不应创建", description: "", owner: "待确认", dueAt: null } },
        ],
      }] };
    }) };
    const mail = { sendMeetingSummary: vi.fn(async () => ({ status: "SENT" })) };
    const jobs = { extractMemory: vi.fn(async () => ({})) };
    const conversations = { assertOwned: vi.fn(async () => conversation) };
    const service = new MeetingsService(prisma as never, conversations as never, models as never, mail as never, jobs as never, redis);

    let result = await service.analyzeConversation(owner.userId, conversation.id, false);
    expect(result).toHaveLength(1);
    expect(result[0].risks).toHaveLength(1);
    expect(result[0].risks[0].evidence).toEqual([expect.objectContaining({ fileName: "first.txt", quote: "王芳承诺完成验收文档" })]);
    expect(result[0].todos).toHaveLength(1);
    const oldMeetingId = result[0].id;
    const duplicate = await service.analyzeConversation(owner.userId, conversation.id, false);
    expect(duplicate[0].id).toBe(oldMeetingId);
    expect(models.runStructuredAgent).toHaveBeenCalledTimes(1);
    expect(mail.sendMeetingSummary).toHaveBeenCalledTimes(1);
    const memoryEntity = await prisma.memoryEntity.create({ data: { userId: owner.userId, type: "TOPIC", canonicalName: "会议缓存清理" } });
    const extractedFact = await prisma.memoryFact.create({ data: { entityId: memoryEntity.id, attribute: "状态", value: "旧会议抽取", sourceType: "MEETING", sourceId: oldMeetingId } });
    const editedFact = await prisma.memoryFact.create({ data: { entityId: memoryEntity.id, attribute: "状态", value: "用户修正", sourceType: "USER", sourceId: owner.userId, userEdited: true } });
    await prisma.memoryFact.update({ where: { id: extractedFact.id }, data: { supersededById: editedFact.id } });

    const secondFile = await prisma.fileAsset.create({ data: { userId: owner.userId, conversationId: conversation.id, kind: "TXT", originalName: "second.txt", storagePath: "/test/second.txt", mimeType: "text/plain", size: 80, sha256: "2".repeat(64), status: "READY" } });
    await prisma.documentPage.create({ data: { fileId: secondFile.id, pageNo: 1, text: "李明补充了新的会议记录。" } });
    await service.analyzeConversation(owner.userId, conversation.id, false);
    expect(prompts[1]).toContain("[缓存分析]");
    expect(prompts[1]).toContain("李明补充了新的会议记录");
    expect(await prisma.memoryFact.count({ where: { id: extractedFact.id } })).toBe(0);
    expect(await prisma.memoryFact.count({ where: { id: editedFact.id, supersededById: null } })).toBe(1);

    await service.analyzeConversation(owner.userId, conversation.id, true);
    expect(prompts[2]).not.toContain("[缓存分析]");
    expect(prompts[2]).toContain("王芳承诺完成验收文档");
    expect(mail.sendMeetingSummary).toHaveBeenCalledTimes(3);
    expect((await prisma.emailDelivery.count({ where: { meeting: { conversationId: conversation.id } } }))).toBe(0);
  }, 30_000);

  it("parses 200-page PDFs within the target and performs isolated multi-PDF BM25 retrieval with page citations", async () => {
    const owner = await register("pdf");
    const other = await register("pdf_other");
    const conversation = await request(baseUrl).post("/api/conversations").set("Cookie", owner.cookie).send({ mode: "CHAT", title: "pdf retrieval" }).expect(201);
    const conversationId = conversation.body.id as string;
    const otherConversation = await request(baseUrl).post("/api/conversations").set("Cookie", other.cookie).send({ mode: "CHAT", title: "other pdf" }).expect(201);

    const alpha = textPdf(["Project Alpha introduction", "Project Alpha owner Alice deadline October 15 2026"]);
    const budget = textPdf(["Project Alpha approved budget two million CNY finance department"]);
    const uploadedA = await request(baseUrl).post(`/api/conversations/${conversationId}/files`).set("Cookie", owner.cookie).attach("file", alpha, { filename: "alpha.pdf", contentType: "application/pdf" }).expect(201);
    const uploadedB = await request(baseUrl).post(`/api/conversations/${conversationId}/files`).set("Cookie", owner.cookie).attach("file", budget, { filename: "budget.pdf", contentType: "application/pdf" }).expect(201);
    expect((await waitForFile(baseUrl, owner.cookie, conversationId, uploadedA.body.id))).toMatchObject({ status: "READY" });
    expect((await waitForFile(baseUrl, owner.cookie, conversationId, uploadedB.body.id))).toMatchObject({ status: "READY" });

    const retrieval = new RetrievalService(prisma as never, new EmbeddingService());
    const results = await retrieval.search(owner.userId, conversationId, "owner budget");
    expect(new Set(results.map((item) => item.fileName))).toEqual(new Set(["alpha.pdf", "budget.pdf"]));
    expect(results.find((item) => item.fileName === "alpha.pdf")).toMatchObject({ pageStart: 2, pageEnd: 2 });
    expect(await retrieval.search(other.userId, otherConversation.body.id, "owner budget")).toEqual([]);
    expect(await retrieval.search(owner.userId, conversationId, "unobtainium zebracorn")).toEqual([]);

    const largePdf = textPdf(Array.from({ length: 200 }, (_, index) => `Page ${index + 1} performance validation unique${index + 1}`));
    const startedAt = Date.now();
    const uploadedLarge = await request(baseUrl).post(`/api/conversations/${conversationId}/files`).set("Cookie", owner.cookie).attach("file", largePdf, { filename: "two-hundred-pages.pdf", contentType: "application/pdf" }).expect(201);
    expect((await waitForFile(baseUrl, owner.cookie, conversationId, uploadedLarge.body.id))).toMatchObject({ status: "READY" });
    expect(Date.now() - startedAt).toBeLessThan(60_000);

    await request(baseUrl).delete(`/api/conversations/${conversationId}`).set("Cookie", owner.cookie).expect(200);
    await request(baseUrl).delete(`/api/conversations/${otherConversation.body.id}`).set("Cookie", other.cookie).expect(200);
    expect(await prisma.documentPage.count({ where: { fileId: { in: [uploadedA.body.id, uploadedB.body.id, uploadedLarge.body.id] } } })).toBe(0);
  }, 70_000);

  it("serves ten isolated users concurrently without crossing the local response target", async () => {
    const startedAt = Date.now();
    const results = await Promise.all(Array.from({ length: 10 }, async (_, index) => {
      const user = await register(`load${index}`);
      const created = await request(baseUrl).post("/api/conversations").set("Cookie", user.cookie).send({ mode: index % 2 ? "MEETING" : "CHAT", title: `load-${index}` }).expect(201);
      const detail = await request(baseUrl).get(`/api/conversations/${created.body.id}`).set("Cookie", user.cookie).expect(200);
      const list = await request(baseUrl).get("/api/conversations").set("Cookie", user.cookie).expect(200);
      return { user, conversationId: created.body.id as string, detail: detail.body, list: list.body as Array<{ id: string }> };
    }));
    expect(Date.now() - startedAt).toBeLessThan(10_000);
    for (const result of results) {
      expect(result.detail.id).toBe(result.conversationId);
      expect(result.list).toEqual([expect.objectContaining({ id: result.conversationId })]);
      expect(result.list).toHaveLength(1);
    }
  }, 15_000);

  it("persists every manually enabled search call and restores its sources with history", async () => {
    const owner = await register("search");
    const conversation = await prisma.conversation.create({ data: { userId: owner.userId, mode: "CHAT", title: "search persistence" } });
    const faux = fauxProvider();
    const modelRegistry = createModels();
    modelRegistry.setProvider(faux.provider);
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("search_web", { query: "release notes" }), fauxToolCall("search_web", { query: "market news" })], { stopReason: "toolUse" }),
      fauxAssistantMessage([fauxText("结果来自 https://example.test/search ，检索时间已记录。")]),
    ]);
    const conversations = new ConversationsService(prisma as never);
    const runtime = new AgentRuntimeService(
      prisma as never,
      conversations,
      { model: faux.getModel(), stream: modelRegistry.streamSimple.bind(modelRegistry), consumeTimeout: () => false } as never,
      new RetrievalService(prisma as never, new EmbeddingService()),
      { currentFacts: vi.fn(async () => []) } as never,
      new SearchService(),
      { request: vi.fn() } as never,
      redis,
      { extractMemory: vi.fn(async () => ({})), analyzeMeeting: vi.fn() } as never,
    );
    const previous = { enabled: process.env.SEARCH_ENABLED, provider: process.env.SEARCH_PROVIDER };
    process.env.SEARCH_ENABLED = "true";
    process.env.SEARCH_PROVIDER = "mock";
    const events: any[] = [];
    try {
      await runtime.run({ userId: owner.userId, conversationId: conversation.id, content: "Give me current releases and market news", webSearch: true }, (event) => events.push(event));
    } finally {
      previous.enabled === undefined ? delete process.env.SEARCH_ENABLED : process.env.SEARCH_ENABLED = previous.enabled;
      previous.provider === undefined ? delete process.env.SEARCH_PROVIDER : process.env.SEARCH_PROVIDER = previous.provider;
    }
    expect(events.filter((event) => event.type === "tool.started" && event.toolName === "search_web")).toHaveLength(2);
    const searchRuns = await prisma.searchRun.findMany({ where: { message: { conversationId: conversation.id } } });
    expect(searchRuns).toHaveLength(2);
    expect(searchRuns.every((run) => Array.isArray(run.sources) && (run.sources as any[])[0]?.url.startsWith("https://"))).toBe(true);
    const restored = await conversations.get(owner.userId, conversation.id);
    const assistant = restored.messages.find((message) => message.role === "ASSISTANT");
    expect(assistant?.searchRuns).toHaveLength(2);
    expect(JSON.stringify(assistant?.searchRuns)).toContain("retrievedAt");
  }, 30_000);
});
