import { BadRequestException, ConflictException, Injectable } from "@nestjs/common";
import { createHash } from "node:crypto";
import { z } from "zod";
import { meetingAnalysisSchema, type MeetingAnalysis } from "@nbboss/contracts";
import { PrismaService } from "../../infra/prisma.service.js";
import { PiModelsService } from "../agent/pi-models.service.js";
import { ConversationsService } from "../conversations/conversations.service.js";
import { MailService } from "../mail/mail.service.js";
import { JobsService } from "../../infra/jobs.service.js";
import { Type } from "typebox";
import { RedisService } from "../../infra/redis.service.js";
import { deleteMemoryFactsBySources } from "../memories/memory-history.js";

const analysesSchema = z.object({ meetings: z.array(meetingAnalysisSchema).min(1) });
const PROMPT_VERSION = "meeting-v1";
const analysisToolSchema = Type.Object({ meetings: Type.Array(Type.Object({
  sourceFileIds: Type.Array(Type.String()), title: Type.String(), summary: Type.String(), participants: Type.Array(Type.String()),
  time: Type.Union([Type.String(), Type.Null()]), location: Type.Union([Type.String(), Type.Null()]), topics: Type.Array(Type.String()),
  decisions: Type.Array(Type.String()), commitments: Type.Array(Type.String()), grouping: Type.Union([Type.Literal("SAME_MEETING"), Type.Literal("DIFFERENT_MEETINGS"), Type.Literal("UNKNOWN")]),
  risks: Type.Array(Type.Object({ severity: Type.Union([Type.Literal("LOW"), Type.Literal("MEDIUM"), Type.Literal("HIGH")]), description: Type.String(), evidence: Type.Array(Type.Object({ fileId: Type.String(), fileName: Type.String(), quote: Type.String(), page: Type.Optional(Type.Number()) })), todo: Type.Object({ title: Type.String(), description: Type.String(), owner: Type.String(), dueAt: Type.Union([Type.String(), Type.Null()]) }) })),
  insights: Type.Array(Type.String()),
})) });

@Injectable()
export class MeetingsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly conversations: ConversationsService,
    private readonly models: PiModelsService,
    private readonly mail: MailService,
    private readonly jobs: JobsService,
    private readonly redis: RedisService,
  ) {}

  async list(userId: string, conversationId: string) {
    await this.conversations.assertOwned(userId, conversationId);
    return this.prisma.meeting.findMany({ where: { conversationId }, include: { risks: true, todos: true, emails: true }, orderBy: { createdAt: "desc" } });
  }

  async requestAnalysis(userId: string, conversationId: string, force = false) {
    const conversation = await this.conversations.assertOwned(userId, conversationId);
    if (conversation.mode !== "MEETING") throw new BadRequestException("仅会议分析模式可执行此操作");
    const readyTxt = await this.prisma.fileAsset.count({ where: { userId, conversationId, kind: "TXT", status: "READY" } });
    if (!readyTxt) throw new BadRequestException("请先上传并等待至少一个 TXT 会议文件处理完成");
    await this.prisma.conversation.update({ where: { id: conversationId }, data: { meetingStatus: "PROCESSING", meetingErrorMessage: null } });
    try {
      const job = await this.jobs.analyzeMeeting(userId, conversationId, force);
      return { queued: true, jobId: job.id, status: "PROCESSING" as const };
    } catch (error) {
      await this.prisma.conversation.update({ where: { id: conversationId }, data: { meetingStatus: "FAILED", meetingErrorMessage: "会议分析队列暂不可用，请稍后重试" } });
      throw error;
    }
  }

  async analyzeConversation(userId: string, conversationId: string, force = false) {
    const token = await this.redis.acquire(`meeting-analysis:${conversationId}`, 10 * 60_000);
    if (!token) throw new ConflictException("当前会议正在分析，请稍后查看结果");
    await this.prisma.conversation.updateMany({ where: { id: conversationId, userId }, data: { meetingStatus: "PROCESSING", meetingErrorMessage: null } });
    try {
      const result = await this.analyzeConversationUnlocked(userId, conversationId, force);
      await this.prisma.conversation.update({ where: { id: conversationId }, data: { meetingStatus: "READY", meetingErrorMessage: null } });
      return result;
    } finally { await this.redis.release(`meeting-analysis:${conversationId}`, token); }
  }

  private async analyzeConversationUnlocked(userId: string, conversationId: string, force: boolean) {
    const conversation = await this.conversations.assertOwned(userId, conversationId);
    if (conversation.mode !== "MEETING") throw new BadRequestException("仅会议分析模式可执行此操作");
    const files = await this.prisma.fileAsset.findMany({
      where: { userId, conversationId, status: "READY", kind: { in: ["TXT", "PDF"] } },
      include: { pages: { orderBy: { pageNo: "asc" } } },
    });
    const txtFiles = files.filter((f) => f.kind === "TXT");
    if (!txtFiles.length) return [];

    const priorDocs = force ? [] : await this.prisma.meetingDocument.findMany({
      where: { meeting: { conversationId } }, include: { file: true },
    });
    const cacheKeyFor = (file: (typeof files)[number]) => createHash("sha256").update(`${file.sha256}:${PROMPT_VERSION}:${process.env.LLM_MODEL ?? "glm-5.3"}`).digest("hex");
    if (!force && priorDocs.length) {
      const expected = new Set(txtFiles.map(cacheKeyFor));
      const persisted = new Set(priorDocs.filter((item) => item.file.kind === "TXT").map((item) => item.cacheKey));
      // A retry or duplicate auto job for the exact same TXT snapshot must be
      // side-effect free. This prevents duplicate todos and external email
      // after a run already committed its analysis but failed while returning.
      if (expected.size === persisted.size && [...expected].every((key) => persisted.has(key))) return this.list(userId, conversationId);
    }
    const cached = new Map(priorDocs.map((item) => [item.cacheKey, item.analysis]));
    const materials = files.map((file) => {
      const cacheKey = cacheKeyFor(file);
      const cachedAnalysis = cached.get(cacheKey);
      return {
        id: file.id, name: file.originalName, type: file.kind, cacheKey,
        content: cachedAnalysis ? `[缓存分析]\n${JSON.stringify(cachedAnalysis)}` : file.pages.map((p) => file.kind === "PDF" ? `[第${p.pageNo}页] ${p.text}` : p.text).join("\n").slice(0, 120_000),
      };
    });
    const prompt = `分析以下会议材料。先判断多个 TXT 属于同一场会议还是不同会议；不同会议分别输出。PDF 仅作为背景。只识别“承诺未闭环风险”：缺责任人、缺截止时间、不可验收、说法冲突、延期/遗忘信号、承诺相关明显漏洞。禁止推断财务/法律/合规风险。每个风险必须逐字引用输入证据并使用真实 fileId；缺责任人写“待确认”，缺日期用 null。输出 {"meetings": MeetingAnalysis[]} JSON。\n材料：\n${materials.map((m) => `FILE id=${m.id} name=${m.name} type=${m.type}\n${m.content}`).join("\n\n")}`;
    const output = await this.models.runStructuredAgent("你是严谨的中文会议分析 Agent。", prompt, "submit_meeting_analysis", analysisToolSchema);
    // TypeBox intentionally accepts strings here because providers commonly
    // return a business date (2026-10-01), a Chinese date, or an offset date.
    // Normalize those deterministic variants before the stricter domain Zod
    // contract instead of wasting retries on an otherwise valid analysis.
    const parsed = analysesSchema.parse(this.normalizeAnalysisDates(output));
    const allowed = new Map(files.map((file) => [file.id, file]));
    for (const analysis of parsed.meetings) {
      analysis.sourceFileIds = analysis.sourceFileIds.filter((id) => allowed.has(id));
      for (const risk of analysis.risks) risk.evidence = risk.evidence.flatMap((e) => {
        const file = allowed.get(e.fileId);
        if (!file) return [];
        const quote = this.normalizeEvidence(e.quote);
        const page = file.pages.find((candidate) => this.normalizeEvidence(candidate.text).includes(quote));
        if (!quote || !page) return [];
        return [{ ...e, fileName: file.originalName, ...(file.kind === "PDF" ? { page: page.pageNo } : { page: undefined }) }];
      });
      analysis.risks = analysis.risks.filter((risk) => risk.evidence.length > 0);
    }
    const created = await this.prisma.$transaction(async (tx) => {
      const replaced = await tx.meeting.findMany({ where: { conversationId }, select: { id: true } });
      await deleteMemoryFactsBySources(tx, userId, replaced.map((meeting) => meeting.id));
      await tx.meeting.deleteMany({ where: { conversationId } });
      const results = [];
      for (const analysis of parsed.meetings) {
        const meeting = await tx.meeting.create({ data: {
          conversationId, title: analysis.title, occurredAt: analysis.time ? this.safeDate(analysis.time) : null,
          location: analysis.location, analysis: analysis as never,
        }});
        const sourceIds = analysis.sourceFileIds.length ? analysis.sourceFileIds : txtFiles.map((f) => f.id);
        for (const fileId of sourceIds) {
          const material = materials.find((m) => m.id === fileId);
          if (material) await tx.meetingDocument.create({ data: { meetingId: meeting.id, fileId, cacheKey: material.cacheKey, groupingKey: analysis.title, analysis: analysis as never } });
        }
        for (let i = 0; i < analysis.risks.length; i++) {
          const value = analysis.risks[i];
          const risk = await tx.risk.create({ data: { meetingId: meeting.id, severity: value.severity, description: value.description, evidence: value.evidence } });
          await tx.todo.create({ data: {
            userId, meetingId: meeting.id, riskId: risk.id, title: value.todo.title, description: value.todo.description,
            owner: value.todo.owner || "待确认", dueAt: value.todo.dueAt ? this.safeDate(value.todo.dueAt) : null,
            idempotencyKey: `${meeting.id}:${i}:${createHash("sha1").update(value.todo.title).digest("hex")}`,
          }});
        }
        results.push({ meeting, analysis });
      }
      return results;
    });
    for (const item of created) {
      if (item.analysis.risks.length) await this.mail.sendMeetingSummary(item.meeting.id, item.meeting.title, item.analysis.risks, item.analysis.risks.map((r) => ({ title: r.todo.title, owner: r.todo.owner })));
      try { await this.jobs.extractMemory(userId, "MEETING", item.meeting.id, JSON.stringify(item.analysis), item.meeting.createdAt); }
      catch { console.error(JSON.stringify({ level: "error", meetingId: item.meeting.id, job: "memory.extract", errorCode: "QUEUE_UNAVAILABLE" })); }
    }
    return this.list(userId, conversationId);
  }

  private safeDate(value: string) {
    const chinese = value.match(/^(\d{4})年(\d{1,2})月(\d{1,2})日/);
    const normalized = chinese ? `${chinese[1]}-${chinese[2].padStart(2, "0")}-${chinese[3].padStart(2, "0")}T00:00:00+08:00` : value;
    const date = new Date(normalized);
    return Number.isNaN(date.valueOf()) ? null : date;
  }
  private normalizeAnalysisDates(output: unknown) {
    if (!output || typeof output !== "object" || !Array.isArray((output as { meetings?: unknown }).meetings)) return output;
    return {
      ...(output as Record<string, unknown>),
      meetings: (output as { meetings: unknown[] }).meetings.map((meeting) => {
        if (!meeting || typeof meeting !== "object") return meeting;
        const value = meeting as Record<string, unknown>;
        return {
          ...value,
          risks: Array.isArray(value.risks) ? value.risks.map((risk) => {
            if (!risk || typeof risk !== "object") return risk;
            const riskValue = risk as Record<string, unknown>;
            if (!riskValue.todo || typeof riskValue.todo !== "object") return risk;
            const todo = riskValue.todo as Record<string, unknown>;
            const dueAt = typeof todo.dueAt === "string" ? this.safeDate(todo.dueAt)?.toISOString() ?? null : todo.dueAt ?? null;
            return { ...riskValue, todo: { ...todo, dueAt } };
          }) : value.risks,
        };
      }),
    };
  }
  private normalizeEvidence(value: string) { return value.replace(/\s+/g, "").replace(/[“”]/g, '"').replace(/[‘’]/g, "'"); }
}
