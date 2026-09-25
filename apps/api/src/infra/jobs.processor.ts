import { BadRequestException, Injectable, NotFoundException, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { UnrecoverableError, Worker } from "bullmq";
import { PrismaService } from "./prisma.service.js";
import { FilesService } from "../modules/files/files.service.js";
import { MeetingsService } from "../modules/meetings/meetings.service.js";
import { MemoriesService } from "../modules/memories/memories.service.js";
import { JobsService } from "./jobs.service.js";
import { PresentationsService } from "../modules/presentations/presentations.service.js";
import { safeErrorMeta } from "../common/safe-error.js";
import { createHash } from "node:crypto";

@Injectable()
export class JobsProcessor implements OnModuleInit, OnModuleDestroy {
  private worker?: Worker;
  constructor(private readonly prisma: PrismaService, private readonly files: FilesService, private readonly meetings: MeetingsService, private readonly memories: MemoriesService, private readonly presentations: PresentationsService, private readonly jobs: JobsService) {}
  onModuleInit() {
    if (process.env.WORKER_MODE !== "true") return;
    this.worker = new Worker("nbboss", async (job) => {
      const startedAt = Date.now();
      let userId = typeof job.data.userId === "string" ? job.data.userId : undefined;
      let resource = job.data.conversationId ?? job.data.sourceId ?? job.data.presentationId ?? job.data.fileId ?? "unknown";
      if (job.name === "file.parse" && !userId) {
        const file = await this.prisma.fileAsset.findUnique({ where: { id: job.data.fileId }, select: { userId: true, conversationId: true } });
        userId = file?.userId;
        resource = file?.conversationId ?? job.data.fileId;
      }
      try {
        if (job.name === "file.parse") {
          await this.files.process(job.data.fileId);
          const file = await this.prisma.fileAsset.findUnique({ where: { id: job.data.fileId } });
          if (file?.kind === "TXT" && file.status === "READY") await this.jobs.analyzeMeetingAfterUpload(file.userId, file.conversationId);
        } else if (job.name === "meeting.analyze") {
          try { await this.meetings.analyzeConversation(job.data.userId, job.data.conversationId, Boolean(job.data.force)); }
          catch (error) {
            const meta = safeErrorMeta(error);
            if (error instanceof NotFoundException) throw new UnrecoverableError("SOURCE_NOT_FOUND");
            if (error instanceof BadRequestException) throw new UnrecoverableError("INVALID_REQUEST");
            if (meta.errorCode === "INVALID_RESPONSE" && job.attemptsMade >= 1) throw new UnrecoverableError("INVALID_RESPONSE");
            throw error;
          }
        } else if (job.name === "memory.extract") {
          await this.memories.extract(job.data.userId, job.data.sourceType, job.data.sourceId, job.data.text, new Date(job.data.observedAt));
        } else if (job.name === "presentation.generate") {
          await this.presentations.process(job.data.userId, job.data.presentationId, (progress) => job.updateProgress(progress));
        } else {
          throw new UnrecoverableError("UNKNOWN_JOB_TYPE");
        }
        console.info(JSON.stringify({ level: "info", traceId: job.id, user: this.userHash(userId), resource, job: job.name, status: "COMPLETED", durationMs: Date.now() - startedAt, attempt: job.attemptsMade + 1 }));
      } catch (error) {
        const meta = safeErrorMeta(error);
        const attempt = job.attemptsMade + 1;
        const final = error instanceof UnrecoverableError || attempt >= (job.opts.attempts ?? 1);
        const traceId = String(job.id ?? "unknown");
        if (final && job.name === "meeting.analyze") {
          await this.prisma.conversation.updateMany({ where: { id: job.data.conversationId, userId: job.data.userId }, data: { meetingStatus: "FAILED", meetingErrorMessage: `会议分析失败，系统已记录（参考编号：${traceId}）` } });
        }
        if (final && job.name === "presentation.generate") {
          await this.prisma.presentation.updateMany({ where: { id: job.data.presentationId, conversation: { userId: job.data.userId } }, data: { status: "FAILED", errorMessage: `PPT 生成失败，系统已记录（参考编号：${traceId}）` } });
        }
        console.error(JSON.stringify({ level: "error", traceId, user: this.userHash(userId), resource, job: job.name, status: final ? "FAILED" : "RETRYING", durationMs: Date.now() - startedAt, attempt, errorCode: error instanceof UnrecoverableError ? error.message : meta.errorCode }));
        throw error;
      }
    }, {
      connection: { url: process.env.REDIS_URL ?? "redis://localhost:6379" },
      concurrency: 3,
      // Provider calls may legitimately approach the configured three-minute
      // timeout. Keep the BullMQ lease longer than that window so a long
      // structured response is not mistaken for a stalled duplicate job.
      lockDuration: 10 * 60_000,
    });
  }
  async onModuleDestroy() { await this.worker?.close(); }
  private userHash(userId?: string) { return userId ? createHash("sha256").update(userId).digest("hex").slice(0, 12) : "unknown"; }
}
