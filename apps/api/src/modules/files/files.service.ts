import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { PrismaService } from "../../infra/prisma.service.js";
import { ConversationsService } from "../conversations/conversations.service.js";
import { EmbeddingService } from "./embedding.service.js";
import { JobsService } from "../../infra/jobs.service.js";
import { deleteMemoryFactsBySources } from "../memories/memory-history.js";

@Injectable()
export class FilesService {
  private readonly root = process.env.STORAGE_ROOT ?? join(process.cwd(), "data", "uploads");
  constructor(private readonly prisma: PrismaService, private readonly conversations: ConversationsService, private readonly embeddings: EmbeddingService, private readonly jobs: JobsService) {}

  async save(userId: string, conversationId: string, file: Express.Multer.File) {
    const conversation = await this.conversations.assertOwned(userId, conversationId);
    if (!file?.buffer) throw new BadRequestException("请选择要上传的文件");
    const ext = extname(file.originalname).toLowerCase();
    const kind = ext === ".pdf" ? "PDF" : ext === ".txt" ? "TXT" : null;
    if (!kind) throw new BadRequestException("仅支持 PDF 和 UTF-8 TXT 文件");
    if (kind === "TXT" && conversation.mode !== "MEETING") throw new BadRequestException("TXT 仅可上传到会议分析会话");
    if (kind === "PDF" && file.mimetype !== "application/pdf") throw new BadRequestException("PDF 的 MIME 类型不正确");
    if (kind === "PDF" && file.buffer.subarray(0, 5).toString("ascii") !== "%PDF-") throw new BadRequestException("文件内容不是有效的 PDF");
    if (kind === "TXT" && !["text/plain", "application/octet-stream"].includes(file.mimetype)) throw new BadRequestException("TXT 的 MIME 类型不正确");
    if (kind === "PDF" && file.size > 20 * 1024 * 1024) throw new BadRequestException("PDF 不得超过 20 MB");
    if (kind === "TXT" && file.size > 5 * 1024 * 1024) throw new BadRequestException("TXT 不得超过 5 MB");
    if (kind === "TXT") {
      try { new TextDecoder("utf-8", { fatal: true }).decode(file.buffer); }
      catch { throw new BadRequestException("TXT 必须为 UTF-8 文本"); }
      if (file.buffer.includes(0)) throw new BadRequestException("TXT 必须为 UTF-8 文本");
    }
    const id = randomUUID();
    const dir = join(this.root, userId, conversationId);
    await mkdir(dir, { recursive: true });
    const temp = join(dir, `${id}.tmp`);
    const finalPath = join(dir, `${id}${ext}`);
    await writeFile(temp, file.buffer, { mode: 0o600 });
    await rename(temp, finalPath);
    const asset = await this.prisma.fileAsset.create({ data: {
      id, userId, conversationId, kind, originalName: file.originalname.slice(0, 255), storagePath: finalPath,
      mimeType: file.mimetype, size: file.size, sha256: createHash("sha256").update(file.buffer).digest("hex"), status: "PROCESSING",
    }});
    if (kind === "TXT" && conversation.mode === "MEETING") await this.prisma.conversation.update({ where: { id: conversationId }, data: { meetingStatus: "PROCESSING", meetingErrorMessage: null } });
    try { await this.jobs.parseFile(asset.id); }
    catch (error) {
      await this.prisma.fileAsset.update({ where: { id: asset.id }, data: { status: "FAILED", errorMessage: "后台处理队列暂不可用" } });
      throw error;
    }
    return asset;
  }

  async process(fileId: string) {
    const asset = await this.prisma.fileAsset.findUnique({ where: { id: fileId } });
    if (!asset) return;
    if (asset.status === "READY") return;
    try {
      await this.prisma.$transaction([this.prisma.documentChunk.deleteMany({ where: { fileId } }), this.prisma.documentPage.deleteMany({ where: { fileId } })]);
      const buffer = await readFile(asset.storagePath);
      if (asset.kind === "TXT") {
        const text = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
        if (!text.trim()) throw new Error("TXT 文件为空");
        await this.prisma.documentPage.create({ data: { fileId, pageNo: 1, text } });
        await this.createChunks(fileId, [{ pageNo: 1, text }]);
      } else {
        const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
        const document = await pdfjs.getDocument({ data: new Uint8Array(buffer), useSystemFonts: true }).promise;
        if (document.numPages > 200) throw new Error("PDF 不得超过 200 页");
        const pages: Array<{ pageNo: number; text: string }> = [];
        for (let pageNo = 1; pageNo <= document.numPages; pageNo++) {
          const page = await document.getPage(pageNo);
          const content = await page.getTextContent();
          const text = content.items.map((item) => "str" in item ? item.str : "").join(" ").replace(/\s+/g, " ").trim();
          pages.push({ pageNo, text });
        }
        if (!pages.some((page) => page.text.length > 20)) throw new Error("该 PDF 无法提取文字，首期不支持扫描件 OCR");
        await this.prisma.documentPage.createMany({ data: pages.map((page) => ({ fileId, ...page })) });
        await this.createChunks(fileId, pages);
      }
      // The owner may delete the file/conversation while parsing is in flight.
      // updateMany turns that normal cancellation race into a no-op instead of
      // making BullMQ retry a job whose source no longer exists.
      await this.prisma.fileAsset.updateMany({ where: { id: fileId }, data: { status: "READY", errorMessage: null } });
    } catch (error) {
      const message = error instanceof Error ? error.message.slice(0, 500) : "解析失败";
      const updated = await this.prisma.fileAsset.updateMany({ where: { id: fileId }, data: { status: "FAILED", errorMessage: message } });
      if (updated.count && asset.kind === "TXT") await this.prisma.conversation.updateMany({ where: { id: asset.conversationId, mode: "MEETING" }, data: { meetingStatus: "FAILED", meetingErrorMessage: `会议文件解析失败：${message}` } });
    }
  }

  async get(userId: string, id: string) {
    const file = await this.prisma.fileAsset.findFirst({ where: { id, userId } });
    if (!file) throw new NotFoundException("文件不存在");
    return file;
  }
  async remove(userId: string, id: string) {
    const file = await this.get(userId, id);
    const trashPath = `${file.storagePath}.deleting-${randomUUID()}`;
    let moved = false;
    try { await rename(file.storagePath, trashPath); moved = true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    let reanalyze = false;
    try {
      await this.prisma.$transaction(async (tx) => {
        await tx.fileAsset.delete({ where: { id } });
        const conversation = await tx.conversation.findFirst({ where: { id: file.conversationId, userId } });
        if (conversation?.mode !== "MEETING") return;
        const remainingTxt = await tx.fileAsset.count({ where: { conversationId: file.conversationId, userId, kind: "TXT", status: "READY" } });
        if (remainingTxt) {
          reanalyze = true;
          await tx.conversation.update({ where: { id: file.conversationId }, data: { meetingStatus: "PROCESSING", meetingErrorMessage: null } });
        } else {
          const meetings = await tx.meeting.findMany({ where: { conversationId: file.conversationId }, select: { id: true } });
          await deleteMemoryFactsBySources(tx, userId, meetings.map((meeting) => meeting.id));
          await tx.meeting.deleteMany({ where: { conversationId: file.conversationId } });
          await tx.conversation.update({ where: { id: file.conversationId }, data: { meetingStatus: null, meetingErrorMessage: null } });
        }
      });
    } catch (error) {
      if (moved) await rename(trashPath, file.storagePath).catch(() => undefined);
      throw error;
    }
    if (moved) void rm(trashPath, { force: true }).catch((error) => console.error(JSON.stringify({ level: "error", operation: "storage.cleanup", resource: id, error: error instanceof Error ? error.name : "unknown" })));
    if (reanalyze) {
      try { await this.jobs.analyzeMeeting(userId, file.conversationId, true); }
      catch (error) {
        await this.prisma.conversation.updateMany({ where: { id: file.conversationId, userId }, data: { meetingStatus: "FAILED", meetingErrorMessage: "会议分析队列暂不可用，请稍后重试" } });
        throw error;
      }
    }
    return { ok: true };
  }

  private async createChunks(fileId: string, pages: Array<{ pageNo: number; text: string }>) {
    const chunks: Array<{ fileId: string; pageStart: number; pageEnd: number; charStart: number; charEnd: number; content: string; tokenCount: number }> = [];
    for (const page of pages) {
      for (let start = 0; start < page.text.length; start += 1200) {
        const charStart = Math.max(0, start - (start ? 150 : 0));
        const charEnd = Math.min(page.text.length, start + 1500);
        const content = page.text.slice(charStart, charEnd).trim();
        if (content) chunks.push({ fileId, pageStart: page.pageNo, pageEnd: page.pageNo, charStart, charEnd, content, tokenCount: Math.ceil(content.length / 2) });
      }
    }
    if (chunks.length) {
      await this.prisma.documentChunk.createMany({ data: chunks });
      if (this.embeddings.available()) {
        try {
          const stored = await this.prisma.documentChunk.findMany({ where: { fileId }, orderBy: { id: "asc" } });
          for (let offset = 0; offset < stored.length; offset += 32) {
            const batch = stored.slice(offset, offset + 32);
            const vectors = await this.embeddings.embed(batch.map((item) => item.content));
            for (let index = 0; index < vectors.length; index++) {
              const vector = `[${vectors[index].join(",")}]`;
              await this.prisma.$executeRaw`UPDATE "DocumentChunk" SET "embedding" = ${vector}::vector WHERE "id" = ${batch[index].id}`;
            }
          }
        } catch (error) {
          console.warn(JSON.stringify({ level: "warn", operation: "document.embedding", fileId, errorCode: "EMBEDDING_UNAVAILABLE", error: error instanceof Error ? error.name : "unknown", fallback: "BM25" }));
        }
      }
    }
  }
}
