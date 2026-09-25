import { Injectable, OnModuleDestroy } from "@nestjs/common";
import { Queue } from "bullmq";
import { randomUUID } from "node:crypto";

@Injectable()
export class JobsService implements OnModuleDestroy {
  readonly queue = new Queue("nbboss", { connection: { url: process.env.REDIS_URL ?? "redis://localhost:6379" }, defaultJobOptions: { attempts: 3, backoff: { type: "exponential", delay: 1000 }, removeOnComplete: 100, removeOnFail: 100 } });
  parseFile(fileId: string) { return this.queue.add("file.parse", { fileId }, { jobId: `file-${fileId}` }); }
  analyzeMeeting(userId: string, conversationId: string, force = false) { return this.queue.add("meeting.analyze", { userId, conversationId, force }, { jobId: `meeting-${conversationId}-${randomUUID()}`, attempts: 10, backoff: { type: "fixed", delay: 15_000 } }); }
  analyzeMeetingAfterUpload(userId: string, conversationId: string) {
    const configured = Number(process.env.MEETING_UPLOAD_DEBOUNCE_MS ?? 2_000);
    const delay = Number.isFinite(configured) ? Math.max(250, Math.min(configured, 30_000)) : 2_000;
    // Multiple TXT files are commonly uploaded together and finish parsing a
    // few milliseconds apart. BullMQ debounce replaces/extends the delayed job
    // so that one analysis sees the complete batch and sends one summary mail.
    // If another file becomes ready after the first analysis has started, its
    // deduplication TTL has expired and a necessary incremental run is queued.
    return this.queue.add("meeting.analyze", { userId, conversationId, force: false }, {
      jobId: `meeting-upload-${conversationId}-${randomUUID()}`,
      delay,
      deduplication: { id: `meeting-upload-${conversationId}`, ttl: delay, extend: true, replace: true },
      attempts: 10,
      backoff: { type: "fixed", delay: 15_000 },
    });
  }
  extractMemory(userId: string, sourceType: "CONVERSATION" | "MEETING", sourceId: string, text: string, observedAt = new Date()) { return this.queue.add("memory.extract", { userId, sourceType, sourceId, text, observedAt: observedAt.toISOString() }, { jobId: `memory-${sourceType}-${sourceId}-${Date.now()}` }); }
  generatePresentation(userId: string, presentationId: string) { return this.queue.add("presentation.generate", { userId, presentationId }, { jobId: `presentation-${presentationId}`, attempts: 2, backoff: { type: "exponential", delay: 3000 } }); }
  async onModuleDestroy() { await this.queue.close(); }
}
