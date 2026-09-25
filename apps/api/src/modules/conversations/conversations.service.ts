import { Injectable, NotFoundException } from "@nestjs/common";
import { PrismaService } from "../../infra/prisma.service.js";
import { join } from "node:path";
import { deleteMemoryFactsBySources } from "../memories/memory-history.js";
import { mkdir, rename, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";

@Injectable()
export class ConversationsService {
  constructor(private readonly prisma: PrismaService) {}

  list(userId: string) {
    return this.prisma.conversation.findMany({
      where: { userId }, orderBy: { updatedAt: "desc" },
      select: { id: true, title: true, mode: true, createdAt: true, updatedAt: true },
    });
  }

  create(userId: string, mode: "CHAT" | "MEETING", title?: string) {
    return this.prisma.conversation.create({ data: { userId, mode, title: title ?? (mode === "MEETING" ? "新会议分析" : "新对话") } });
  }

  async get(userId: string, id: string) {
    const conversation = await this.prisma.conversation.findFirst({
      where: { id, userId },
      include: {
        messages: { where: { role: { in: ["USER", "ASSISTANT"] } }, orderBy: { createdAt: "asc" }, select: { id: true, role: true, content: true, status: true, createdAt: true, searchRuns: { orderBy: { searchedAt: "asc" }, select: { id: true, query: true, searchedAt: true, sources: true } } } },
        files: { select: { id: true, originalName: true, kind: true, size: true, status: true, errorMessage: true, createdAt: true } },
        meetings: { orderBy: { createdAt: "desc" }, include: { risks: true, todos: true, emails: true } },
        presentations: { orderBy: { createdAt: "desc" }, include: { versions: { orderBy: { version: "desc" }, select: { id: true, version: true, createdAt: true } } } },
      },
    });
    if (!conversation) throw new NotFoundException("会话不存在");
    return conversation;
  }

  async assertOwned(userId: string, id: string) {
    const value = await this.prisma.conversation.findFirst({ where: { id, userId } });
    if (!value) throw new NotFoundException("会话不存在");
    return value;
  }

  async remove(userId: string, id: string) {
    await this.assertOwned(userId, id);
    const root = process.env.STORAGE_ROOT ?? join(process.cwd(), "data", "uploads");
    const storageDirectory = join(root, userId, id);
    const trashRoot = join(root, ".trash");
    const trashDirectory = join(trashRoot, `${userId}-${id}-${randomUUID()}`);
    let moved = false;
    try {
      await mkdir(trashRoot, { recursive: true });
      await rename(storageDirectory, trashDirectory);
      moved = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    try {
      await this.prisma.$transaction(async (tx) => {
        const [runs, meetings] = await Promise.all([
          tx.agentRun.findMany({ where: { conversationId: id, userId }, select: { id: true } }),
          tx.meeting.findMany({ where: { conversationId: id }, select: { id: true } }),
        ]);
        const sourceIds = [...runs.map((run) => run.id), ...meetings.map((meeting) => meeting.id)];
        await deleteMemoryFactsBySources(tx, userId, sourceIds);
        await tx.conversation.delete({ where: { id } });
      });
    } catch (error) {
      if (moved) await rename(trashDirectory, storageDirectory).catch(() => undefined);
      throw error;
    }
    if (moved) void rm(trashDirectory, { force: true, recursive: true }).catch((error) => console.error(JSON.stringify({ level: "error", operation: "storage.cleanup", resource: id, error: error instanceof Error ? error.name : "unknown" })));
    return { ok: true };
  }
}
