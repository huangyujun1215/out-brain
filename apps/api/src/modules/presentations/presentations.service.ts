import { Injectable, NotFoundException } from "@nestjs/common";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import PptxGenJS from "pptxgenjs";
import { presentationSchema, type PresentationDocument } from "@nbboss/contracts";
import { PrismaService } from "../../infra/prisma.service.js";
import { PiModelsService } from "../agent/pi-models.service.js";
import { ConversationsService } from "../conversations/conversations.service.js";
import { Type } from "typebox";
import { JobsService } from "../../infra/jobs.service.js";
import { RedisService } from "../../infra/redis.service.js";

const presentationToolSchema = Type.Object({ title: Type.String(), slides: Type.Array(Type.Object({
  id: Type.String(), title: Type.String(), notes: Type.String(), elements: Type.Array(Type.Object({
    id: Type.String(), type: Type.Union([Type.Literal("text"), Type.Literal("shape")]), text: Type.String(),
    x: Type.Number(), y: Type.Number(), w: Type.Number(), h: Type.Number(), fontSize: Type.Number(), color: Type.String(), fill: Type.Optional(Type.String()), bold: Type.Boolean(),
  }))
})) });

@Injectable()
export class PresentationsService {
  private readonly root = process.env.STORAGE_ROOT ?? join(process.cwd(), "data", "uploads");
  constructor(private readonly prisma: PrismaService, private readonly models: PiModelsService, private readonly conversations: ConversationsService, private readonly jobs: JobsService, private readonly redis: RedisService) {}

  async request(userId: string, conversationId: string, prompt: string, idempotencyKey?: string) {
    await this.conversations.assertOwned(userId, conversationId);
    if (idempotencyKey) {
      const existing = await this.prisma.presentation.findFirst({ where: { idempotencyKey, conversation: { userId } } });
      if (existing) return existing;
    }
    let presentation;
    try {
      presentation = await this.prisma.presentation.create({ data: {
        conversationId, title: "正在生成演示文稿…", requestedPrompt: prompt, status: "PENDING", progress: 0, idempotencyKey,
      }});
    } catch (error) {
      // Two HTTP retries or a replayed Pi tool call can pass the optimistic
      // lookup together. The database key is the final arbiter; return the
      // already-created job instead of surfacing a transient P2002.
      if (idempotencyKey && (error as { code?: string })?.code === "P2002") {
        const existing = await this.prisma.presentation.findFirst({ where: { idempotencyKey, conversation: { userId } } });
        if (existing) return existing;
      }
      throw error;
    }
    try { await this.jobs.generatePresentation(userId, presentation.id); }
    catch (error) {
      await this.prisma.presentation.update({ where: { id: presentation.id }, data: { status: "FAILED", errorMessage: "后台处理队列暂不可用" } });
      throw error;
    }
    return presentation;
  }

  async process(userId: string, presentationId: string, onProgress?: (progress: number) => Promise<unknown>) {
    const presentation = await this.prisma.presentation.findFirst({ where: { id: presentationId, conversation: { userId } }, include: { versions: { orderBy: { version: "desc" }, take: 1 } } });
    if (!presentation || presentation.status === "READY") return presentation;
    if (presentation.versions.length) return this.prisma.presentation.update({ where: { id: presentationId }, data: { status: "READY", progress: 100, errorMessage: null } });
    await this.prisma.presentation.update({ where: { id: presentationId }, data: { status: "PROCESSING", progress: 10, errorMessage: null } });
    await onProgress?.(10);
    try {
      const document = await this.createDocument(userId, presentation.conversationId, presentation.requestedPrompt, async (progress) => {
        await this.prisma.presentation.update({ where: { id: presentationId }, data: { progress } });
        await onProgress?.(progress);
      });
      await this.prisma.presentation.update({ where: { id: presentationId }, data: { title: document.title, progress: 80 } });
      await this.saveVersion(userId, presentation.id, presentation.requestedPrompt, document);
      return await this.prisma.presentation.update({ where: { id: presentationId }, data: { status: "READY", progress: 100, errorMessage: null } });
    } catch (error) {
      throw error;
    }
  }

  private async createDocument(userId: string, conversationId: string, prompt: string, onProgress: (progress: number) => Promise<void>) {
    const [messages, chunks, searches, meetings] = await Promise.all([
      this.prisma.message.findMany({ where: { conversationId }, orderBy: { createdAt: "asc" }, take: 80 }),
      this.prisma.documentChunk.findMany({ where: { file: { userId, conversationId, status: "READY", kind: "PDF" } }, include: { file: true }, take: 30 }),
      this.prisma.searchRun.findMany({ where: { message: { conversationId } }, take: 10 }),
      this.prisma.meeting.findMany({ where: { conversationId }, include: { risks: true, todos: true }, take: 20 }),
    ]);
    await onProgress(20);
    const context = [
      messages.map((m) => `${m.role}: ${m.content}`).join("\n"),
      chunks.map((c) => `[${c.file.originalName} 第${c.pageStart}页] ${c.content}`).join("\n"),
      searches.map((s) => JSON.stringify(s.sources)).join("\n"),
      meetings.map((m) => `会议：${m.title}\n分析：${JSON.stringify(m.analysis)}\n已落库风险：${JSON.stringify(m.risks)}\n待办：${JSON.stringify(m.todos)}`).join("\n\n"),
    ].join("\n\n").slice(-100_000);
    const request = `根据且只能根据下方上下文创建中文商务演示文稿。用户要求：${prompt}\n未指定页数时生成 8 页，可在 6-12 页调整。不得编造上下文中不存在的人员、日期、进度、预算、风险、结论或指标；信息不足时明确写“待确认”。画布 13.333x7.5 英寸，所有 x/y/w/h 必须处于画布内。每页包含 title 和可编辑元素；元素只能是 text 或 shape。颜色使用六位十六进制且不要带 #。输出严格符合 {title,slides:[{id,title,notes,elements:[{id,type,text,x,y,w,h,fontSize,color,fill?,bold}]}]}。\n上下文：\n${context || "当前没有可用业务上下文，只能制作标注待确认的框架页。"}`;
    const output = await this.models.runStructuredAgent("你是资深商业演示设计 Agent。", request, "submit_presentation", presentationToolSchema);
    await onProgress(75);
    const document = presentationSchema.parse(this.normalizePresentationOutput(output));
    const requestedCount = this.requestedSlideCount(prompt);
    if (requestedCount !== null && document.slides.length !== requestedCount) throw new Error(`模型生成了 ${document.slides.length} 页，未满足指定的 ${requestedCount} 页`);
    if (requestedCount === null && (document.slides.length < 6 || document.slides.length > 12)) throw new Error("未指定页数时，模型必须生成 6-12 页演示文稿");
    return document;
  }

  async saveVersion(userId: string, presentationId: string, prompt: string, input: unknown) {
    let token: string | null = null;
    for (let attempt = 0; attempt < 20 && !token; attempt++) {
      token = await this.redis.acquire(`presentation-version:${presentationId}`, 30_000);
      if (!token) await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (!token) throw new Error("PPT 版本正在保存，请稍后重试");
    try { return this.publicVersion(await this.saveVersionUnlocked(userId, presentationId, prompt, input)); }
    finally { await this.redis.release(`presentation-version:${presentationId}`, token); }
  }

  private async saveVersionUnlocked(userId: string, presentationId: string, prompt: string, input: unknown) {
    const document = presentationSchema.parse(input);
    const presentation = await this.prisma.presentation.findFirst({ where: { id: presentationId, conversation: { userId } }, include: { versions: { orderBy: { version: "desc" }, take: 1 } } });
    if (!presentation) throw new NotFoundException("PPT 不存在");
    const version = (presentation.versions[0]?.version ?? 0) + 1;
    const dir = join(this.root, userId, presentation.conversationId, "presentations", presentationId);
    await mkdir(dir, { recursive: true });
    const path = join(dir, `v${version}.pptx`);
    await this.exportPptx(document, path);
    return this.prisma.presentationVersion.create({ data: {
      presentationId, version, prompt, slideJson: document as never, pptxPath: path,
      previewMeta: { slideCount: document.slides.length, theme: "nbboss-default" },
    }});
  }

  async listVersions(userId: string, id: string) {
    const presentation = await this.prisma.presentation.findFirst({ where: { id, conversation: { userId } }, include: { versions: { orderBy: { version: "desc" }, select: { id: true, presentationId: true, version: true, prompt: true, slideJson: true, previewMeta: true, createdAt: true } } } });
    if (!presentation) throw new NotFoundException("PPT 不存在");
    return presentation;
  }

  async getVersion(userId: string, id: string) {
    const version = await this.prisma.presentationVersion.findFirst({ where: { id, presentation: { conversation: { userId } } }, include: { presentation: true } });
    if (!version) throw new NotFoundException("PPT 版本不存在");
    return version;
  }

  private async exportPptx(document: PresentationDocument, path: string) {
    const pptx = new (PptxGenJS as any)();
    pptx.layout = "LAYOUT_WIDE";
    pptx.author = "NBBOSS AI 外脑";
    pptx.subject = document.title;
    pptx.title = document.title;
    pptx.company = "NBBOSS";
    pptx.theme = { headFontFace: "Microsoft YaHei", bodyFontFace: "Microsoft YaHei", lang: "zh-CN" };
    for (const source of document.slides) {
      const slide = pptx.addSlide();
      slide.background = { color: "F8F8FC" };
      slide.addShape(pptx.ShapeType.rect, { x: 0, y: 0, w: 0.12, h: 7.5, fill: { color: "7C3AED" }, line: { transparency: 100 } });
      for (const element of source.elements) {
        if (element.type === "shape") slide.addShape(pptx.ShapeType.roundRect, { x: element.x, y: element.y, w: element.w, h: element.h, fill: { color: element.fill ?? "EDE9FE" }, line: { color: element.color, transparency: 70 } });
        else slide.addText(element.text, { x: element.x, y: element.y, w: element.w, h: element.h, fontFace: "Microsoft YaHei", fontSize: element.fontSize, color: element.color, bold: element.bold, breakLine: false, margin: 0.06, valign: "mid", fit: "shrink" });
      }
      if (source.notes) slide.addNotes(source.notes);
    }
    await pptx.writeFile({ fileName: path });
  }

  private publicVersion<T extends { pptxPath: string }>(version: T): Omit<T, "pptxPath"> {
    const { pptxPath: _internalPath, ...safe } = version;
    return safe;
  }
  private requestedSlideCount(prompt: string) {
    const match = prompt.match(/(?:生成|制作|做)?\s*([1-9]|[12]\d|30|一|二|两|三|四|五|六|七|八|九|十|十[一二三四五六七八九]|二十|二十[一二三四五六七八九]|三十)\s*页/);
    if (!match) return null;
    if (/^\d+$/.test(match[1])) return Number(match[1]);
    const digits: Record<string, number> = { "一": 1, "二": 2, "两": 2, "三": 3, "四": 4, "五": 5, "六": 6, "七": 7, "八": 8, "九": 9 };
    if (match[1] === "十") return 10;
    if (match[1] === "二十") return 20;
    if (match[1] === "三十") return 30;
    if (match[1].startsWith("十")) return 10 + digits[match[1].slice(1)];
    if (match[1].startsWith("二十")) return 20 + digits[match[1].slice(2)];
    return digits[match[1]] ?? null;
  }

  private normalizePresentationOutput(output: unknown) {
    if (!output || typeof output !== "object" || !Array.isArray((output as { slides?: unknown }).slides)) return output;
    const color = (value: unknown, fallback: string) => {
      const normalized = typeof value === "string" ? value.trim().replace(/^#/, "") : "";
      if (/^[0-9A-Fa-f]{3}$/.test(normalized)) return normalized.split("").map((item) => item + item).join("").toUpperCase();
      return /^[0-9A-Fa-f]{6}$/.test(normalized) ? normalized.toUpperCase() : fallback;
    };
    const finite = (value: unknown, fallback: number) => typeof value === "number" && Number.isFinite(value) ? value : fallback;
    return {
      ...(output as Record<string, unknown>),
      slides: (output as { slides: unknown[] }).slides.map((slide) => {
        if (!slide || typeof slide !== "object") return slide;
        const value = slide as Record<string, unknown>;
        return {
          ...value,
          elements: Array.isArray(value.elements) ? value.elements.map((element) => {
            if (!element || typeof element !== "object") return element;
            const item = element as Record<string, unknown>;
            const x = Math.max(0, Math.min(finite(item.x, 0.5), 13.233));
            const y = Math.max(0, Math.min(finite(item.y, 0.5), 7.4));
            const w = Math.max(0.1, Math.min(finite(item.w, 4), 13.333 - x));
            const h = Math.max(0.1, Math.min(finite(item.h, 1), 7.5 - y));
            return {
              ...item, x, y, w, h,
              fontSize: Math.max(8, Math.min(finite(item.fontSize, 20), 72)),
              color: color(item.color, "111827"),
              ...(item.fill === undefined ? {} : { fill: color(item.fill, "EDE9FE") }),
            };
          }) : value.elements,
        };
      }),
    };
  }

}
