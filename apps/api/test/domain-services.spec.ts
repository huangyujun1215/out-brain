import { describe, expect, it, vi } from "vitest";
import { FilesService } from "../src/modules/files/files.service.js";
import { MemoriesService } from "../src/modules/memories/memories.service.js";
import { TodosService } from "../src/modules/todos/todos.service.js";
import { AgentRuntimeService } from "../src/modules/agent/agent-runtime.service.js";
import { PresentationsService } from "../src/modules/presentations/presentations.service.js";
import { safeErrorMeta } from "../src/common/safe-error.js";
import { JobsService } from "../src/infra/jobs.service.js";
import { MeetingsService } from "../src/modules/meetings/meetings.service.js";
import { z } from "zod";
import { presentationSchema } from "@nbboss/contracts";

describe("file safety", () => {
  const service = new FilesService({} as any, { assertOwned: vi.fn(async () => ({})) } as any, {} as any, {} as any);
  it("rejects a PDF extension with a forged MIME type", async () => {
    await expect(service.save("u", "c", { originalname: "attack.pdf", mimetype: "text/plain", size: 5, buffer: Buffer.from("hello") } as any)).rejects.toMatchObject({ status: 400 });
  });
  it("rejects a fake PDF signature", async () => {
    await expect(service.save("u", "c", { originalname: "attack.pdf", mimetype: "application/pdf", size: 5, buffer: Buffer.from("hello") } as any)).rejects.toMatchObject({ status: 400 });
  });
  it("rejects invalid UTF-8 text", async () => {
    await expect(service.save("u", "c", { originalname: "bad.txt", mimetype: "text/plain", size: 2, buffer: Buffer.from([0xc3, 0x28]) } as any)).rejects.toMatchObject({ status: 400 });
  });
  it("rejects TXT uploads outside meeting mode", async () => {
    const chatService = new FilesService({} as any, { assertOwned: vi.fn(async () => ({ mode: "CHAT" })) } as any, {} as any, {} as any);
    await expect(chatService.save("u", "c", { originalname: "notes.txt", mimetype: "text/plain", size: 5, buffer: Buffer.from("hello") } as any)).rejects.toMatchObject({ status: 400 });
  });
});

describe("meeting upload scheduling", () => {
  it("debounces a batch of parsed TXT files under one conversation key", async () => {
    const service = new JobsService();
    const add = vi.spyOn(service.queue, "add").mockResolvedValue({ id: "job" } as never);
    try {
      await service.analyzeMeetingAfterUpload("user", "conversation");
      expect(add).toHaveBeenCalledWith("meeting.analyze", { userId: "user", conversationId: "conversation", force: false }, expect.objectContaining({
        delay: 2_000,
        deduplication: { id: "meeting-upload-conversation", ttl: 2_000, extend: true, replace: true },
      }));
    } finally {
      await service.onModuleDestroy();
    }
  });
});

describe("meeting structured-output normalization", () => {
  it("normalizes provider business dates before strict domain validation", () => {
    const service = Object.create(MeetingsService.prototype) as any;
    const output = service.normalizeAnalysisDates({ meetings: [{ risks: [
      { todo: { dueAt: "2026-10-01" } },
      { todo: { dueAt: "2026年10月2日" } },
      { todo: { dueAt: "待确认" } },
    ] }] });
    expect(output.meetings[0].risks.map((risk: any) => risk.todo.dueAt)).toEqual([
      "2026-10-01T00:00:00.000Z",
      "2026-10-01T16:00:00.000Z",
      null,
    ]);
  });
});

describe("agent tool exposure policy", () => {
  const service = Object.create(AgentRuntimeService.prototype) as any;
  it("only recognizes explicit presentation requests", () => {
    expect(service.wantsPresentation("请基于当前会话生成一份 PPT")).toBe(true);
    expect(service.wantsPresentation("帮我制作演示文稿")).toBe(true);
    expect(service.wantsPresentation("总结一下刚才的内容")).toBe(false);
  });
});

describe("presentation request parsing", () => {
  const service = Object.create(PresentationsService.prototype) as any;
  it("recognizes Arabic and Chinese requested page counts", () => {
    expect(service.requestedSlideCount("生成 4 页 PPT")).toBe(4);
    expect(service.requestedSlideCount("做一份十二页的演示文稿")).toBe(12);
    expect(service.requestedSlideCount("制作二十三页 PPT")).toBe(23);
    expect(service.requestedSlideCount("生成专业 PPT")).toBeNull();
  });

  it("normalizes common provider color and canvas variants before validation", () => {
    const service = Object.create(PresentationsService.prototype) as any;
    const normalized = service.normalizePresentationOutput({ title: "deck", slides: [{ id: "s", title: "slide", notes: "", elements: [{
      id: "e", type: "shape", text: "", x: -2, y: 7.45, w: 20, h: 5, fontSize: 100, color: "#abc", fill: "#7c3aed",
    }] }] });
    const element = normalized.slides[0].elements[0];
    expect(element).toMatchObject({ x: 0, y: 7.4, w: 13.333, fontSize: 72, color: "AABBCC", fill: "7C3AED" });
    expect(element.h).toBeCloseTo(0.1);
    expect(() => presentationSchema.parse(normalized)).not.toThrow();
  });

  it("returns the winning presentation when concurrent idempotent creation races", async () => {
    const existing = { id: "p1", conversationId: "c1", status: "PENDING" };
    const findFirst = vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce(existing);
    const create = vi.fn(async () => { throw Object.assign(new Error("unique"), { code: "P2002" }); });
    const jobs = { generatePresentation: vi.fn() };
    const service = new PresentationsService(
      { presentation: { findFirst, create } } as any,
      {} as any,
      { assertOwned: vi.fn(async () => ({ id: "c1" })) } as any,
      jobs as any,
      {} as any,
    );
    await expect(service.request("u1", "c1", "deck", "c1:key")).resolves.toBe(existing);
    expect(create).toHaveBeenCalledOnce();
    expect(jobs.generatePresentation).not.toHaveBeenCalled();
  });

  it("enforces requested and default slide-count bounds on structured output", async () => {
    const slide = (index: number) => ({ id: `s${index}`, title: `第 ${index} 页`, notes: "", elements: [{ id: `e${index}`, type: "text", text: "内容", x: 1, y: 1, w: 4, h: 1, fontSize: 20, color: "111827", bold: false }] });
    const contextDb = {
      message: { findMany: vi.fn(async () => []) }, documentChunk: { findMany: vi.fn(async () => []) },
      searchRun: { findMany: vi.fn(async () => []) }, meeting: { findMany: vi.fn(async () => []) },
    };
    const output = { title: "测试", slides: Array.from({ length: 8 }, (_, index) => slide(index + 1)) };
    const models = { runStructuredAgent: vi.fn(async () => output) };
    const service = new PresentationsService(contextDb as any, models as any, {} as any, {} as any, {} as any);
    await expect((service as any).createDocument("u", "c", "生成专业 PPT", async () => {})).resolves.toMatchObject({ slides: expect.any(Array) });
    await expect((service as any).createDocument("u", "c", "生成十二页 PPT", async () => {})).rejects.toThrow("未满足指定的 12 页");
    output.slides = Array.from({ length: 5 }, (_, index) => slide(index + 1));
    await expect((service as any).createDocument("u", "c", "生成专业 PPT", async () => {})).rejects.toThrow("6-12 页");
  });

  it("keeps a transient PPT failure retryable without leaking provider diagnostics", async () => {
    const updates: any[] = [];
    const prisma = {
      presentation: {
        findFirst: vi.fn(async () => ({ id: "p", conversationId: "c", requestedPrompt: "deck", status: "PENDING", versions: [] })),
        update: vi.fn(async ({ data }: any) => { updates.push(data); return { id: "p", ...data }; }),
      },
      message: { findMany: vi.fn(async () => []) }, documentChunk: { findMany: vi.fn(async () => []) },
      searchRun: { findMany: vi.fn(async () => []) }, meeting: { findMany: vi.fn(async () => []) },
    };
    const secret = "provider-secret-diagnostic";
    const service = new PresentationsService(prisma as any, { runStructuredAgent: vi.fn(async () => { throw new Error(secret); }) } as any, {} as any, {} as any, {} as any);
    const logger = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await expect(service.process("u", "p")).rejects.toThrow(secret);
    expect(updates.at(-1)).toMatchObject({ progress: 20 });
    expect(updates.some((update) => update.status === "FAILED")).toBe(false);
    expect(JSON.stringify(updates)).not.toContain(secret);
    expect(logger.mock.calls.flat().join(" ")).not.toContain(secret);
  });
});

describe("safe logging", () => {
  it("classifies provider failures without returning sensitive messages", () => {
    const secret = "super-secret-provider-key";
    const meta = safeErrorMeta(new Error(`HTTP 429 authorization=${secret}`));
    expect(meta).toEqual({ name: "Error", errorCode: "RATE_LIMITED" });
    expect(JSON.stringify(meta)).not.toContain(secret);
  });
  it("classifies schema failures as invalid provider responses", () => {
    const failure = z.object({ dueAt: z.string().datetime() }).safeParse({ dueAt: "not-a-date" });
    if (failure.success) throw new Error("fixture must fail");
    expect(safeErrorMeta(failure.error).errorCode).toBe("INVALID_RESPONSE");
  });
});

describe("memory conflict policy", () => {
  const fact = { entityType: "PERSON", entityName: "项目", attribute: "负责人", value: "王芳", confidence: 0.9, effectiveAt: null } as const;
  function fixture(current: any) {
    const rows = current ? [{ entityId: "entity", attribute: "负责人", confidence: 0.8, sourceType: "OLD", sourceId: "old", supersededById: null, createdAt: new Date("2026-01-02"), ...current }] : [];
    const create = vi.fn(async ({ data }: any) => { const value = { id: "new", userEdited: false, supersededById: null, createdAt: new Date("2026-04-01"), ...data }; rows.push(value); return value; });
    const update = vi.fn(async ({ where, data }: any) => { const row = rows.find((item) => item.id === where.id); if (row) Object.assign(row, data); return row; });
    const updateMany = vi.fn(async ({ data }: any) => { rows.forEach((row) => Object.assign(row, data)); return { count: rows.length }; });
    const tx = { memoryFact: { findMany: vi.fn(async () => [...rows]), create, update, updateMany } };
    const prisma = { memoryEntity: { upsert: vi.fn(async () => ({ id: "entity" })) }, $transaction: (fn: any) => fn(tx) };
    const redis = { acquire: vi.fn(async () => "lock"), release: vi.fn(async () => undefined) };
    return { service: new MemoriesService(prisma as any, {} as any, redis as any), create, update, rows };
  }
  it("supersedes an older automatic value", async () => {
    const { service, create, rows } = fixture({ id: "old", value: "李明", userEdited: false, effectiveAt: null, observedAt: new Date("2026-01-01") });
    await (service as any).upsertFact("u", "CONVERSATION", "run", new Date("2026-02-01"), fact);
    expect(create).toHaveBeenCalledOnce(); expect(rows.find((row) => row.id === "old")?.supersededById).toBe("new"); expect(rows.find((row) => row.id === "new")?.supersededById).toBeNull();
  });
  it("keeps a user-edited value current while retaining automatic facts as history", async () => {
    const { service, create, rows } = fixture({ id: "old", value: "李明", userEdited: true, effectiveAt: null, observedAt: new Date("2026-01-01") });
    await (service as any).upsertFact("u", "CONVERSATION", "run", new Date("2026-02-01"), fact);
    expect(create).toHaveBeenCalledOnce(); expect(rows.find((row) => row.id === "new")?.supersededById).toBe("old"); expect(rows.find((row) => row.id === "old")?.supersededById).toBeNull();
  });
  it("retains a late-running older extraction without replacing the newer current fact", async () => {
    const { service, create, rows } = fixture({ id: "newer", value: "李明", userEdited: false, effectiveAt: null, observedAt: new Date("2026-03-01") });
    await (service as any).upsertFact("u", "CONVERSATION", "run", new Date("2026-02-01"), fact);
    expect(create).toHaveBeenCalledOnce(); expect(rows.find((row) => row.id === "new")?.supersededById).toBe("newer"); expect(rows.find((row) => row.id === "newer")?.supersededById).toBeNull();
  });
  it("does not resurrect memory when its queued source has been deleted", async () => {
    const models = { runStructuredAgent: vi.fn() };
    const service = new MemoriesService({ agentRun: { findFirst: vi.fn(async () => null) } } as any, models as any, {} as any);
    await service.extract("u", "CONVERSATION", "deleted-run", "这是一个长度足够但来源已经删除的对话内容，不应再生成任何长期记忆。", new Date());
    expect(models.runStructuredAgent).not.toHaveBeenCalled();
  });
});

describe("tenant scoping", () => {
  it("updates a todo only after a user-scoped lookup", async () => {
    const update = vi.fn();
    const prisma = { todo: { findFirst: vi.fn(async ({ where }: any) => where.userId === "owner" ? { id: "t" } : null), update } };
    const service = new TodosService(prisma as any);
    await expect(service.update("attacker", "t", { status: "COMPLETED" })).rejects.toMatchObject({ status: 404 });
    expect(update).not.toHaveBeenCalled();
  });
});
