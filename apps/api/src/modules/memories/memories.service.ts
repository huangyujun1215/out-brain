import { Injectable, NotFoundException } from "@nestjs/common";
import { PrismaService } from "../../infra/prisma.service.js";
import { memoryFactSchema } from "@nbboss/contracts";
import { z } from "zod";
import { PiModelsService } from "../agent/pi-models.service.js";
import { Type } from "typebox";
import { createHash } from "node:crypto";
import { tokenize } from "../files/retrieval-ranking.js";
import { safeErrorMeta } from "../../common/safe-error.js";
import { RedisService } from "../../infra/redis.service.js";
import { deleteMemoryFactsBySources } from "./memory-history.js";

const memoryToolSchema = Type.Object({ facts: Type.Array(Type.Object({
  entityType: Type.Union([Type.Literal("PERSON"), Type.Literal("TIME"), Type.Literal("LOCATION"), Type.Literal("TOPIC"), Type.Literal("RELATION")]),
  entityName: Type.String(), attribute: Type.String(), value: Type.String(), confidence: Type.Number(), effectiveAt: Type.Union([Type.String(), Type.Null()]),
})) });

@Injectable()
export class MemoriesService {
  constructor(private readonly prisma: PrismaService, private readonly models: PiModelsService, private readonly redis: RedisService) {}
  list(userId: string) {
    return this.prisma.memoryEntity.findMany({ where: { userId }, include: { facts: { orderBy: { createdAt: "desc" } } }, orderBy: { canonicalName: "asc" } });
  }
  async currentFacts(userId: string, query?: string) {
    const entities = await this.prisma.memoryEntity.findMany({
      where: { userId },
      include: { facts: { where: { supersededById: null }, orderBy: { createdAt: "desc" }, take: 20 } }, take: 30,
    });
    const facts = entities.flatMap((e) => e.facts.map((f) => ({ entity: e.canonicalName, type: e.type, attribute: f.attribute, value: f.value })));
    if (!query) return facts.slice(0, 30);
    const terms = new Set(tokenize(query).filter((term) => term.length > 1));
    return facts.map((fact) => ({ fact, score: [...terms].filter((term) => `${fact.entity} ${fact.attribute} ${fact.value}`.toLowerCase().includes(term)).length }))
      .filter((entry) => entry.score > 0).sort((a, b) => b.score - a.score).slice(0, 20).map((entry) => entry.fact);
  }
  async update(userId: string, factId: string, value: string) {
    const initial = await this.prisma.memoryFact.findFirst({ where: { id: factId, supersededById: null, entity: { userId } } });
    if (!initial) throw new NotFoundException("记忆不存在");
    const lockKey = this.memoryLockKey(userId, initial.entityId, initial.attribute);
    const token = await this.acquireMemoryLock(lockKey);
    try { return await this.prisma.$transaction(async (tx) => {
      const current = await tx.memoryFact.findFirst({ where: { entityId: initial.entityId, attribute: initial.attribute, supersededById: null, entity: { userId } } });
      if (!current) throw new NotFoundException("记忆不存在");
      const next = await tx.memoryFact.create({ data: { entityId: current.entityId, attribute: current.attribute, value, confidence: 1, sourceType: "USER", sourceId: userId, observedAt: new Date(), userEdited: true } });
      await tx.memoryFact.update({ where: { id: current.id }, data: { supersededById: next.id } });
      return next;
    }); } finally { await this.redis.release(lockKey, token); }
  }
  async remove(userId: string, entityId: string) {
    const result = await this.prisma.memoryEntity.deleteMany({ where: { id: entityId, userId } });
    if (!result.count) throw new NotFoundException("记忆不存在");
    return { ok: true };
  }

  async extract(userId: string, sourceType: "CONVERSATION" | "MEETING", sourceId: string, text: string, observedAt = new Date()) {
    if (text.trim().length < 20) return;
    if (!(await this.sourceExists(userId, sourceType, sourceId))) return;
    try {
      const output = await this.models.runStructuredAgent("你是长期记忆抽取 Agent。", `从以下内容抽取对未来对话有用的人物、时间、地点、主题和关系事实。内容中存在明确的参与人、会议时间、会议地点、讨论主题或承诺关系时必须抽取，不得返回空数组。不要保存寒暄、模型回复中的臆测或敏感凭据。effectiveAt 只能填写 ISO 8601 时间；无法可靠转换时必须为 null。\n${text.slice(0, 40_000)}`, "submit_memory_facts", memoryToolSchema);
      const raw = z.object({ facts: z.array(z.record(z.string(), z.unknown())).max(50) }).parse(output);
      const facts = raw.facts.map((fact) => memoryFactSchema.parse({ ...fact, effectiveAt: this.normalizeDate(fact.effectiveAt) }));
      // The user may delete the source while the external model is running.
      // Recheck before persistence so a late worker cannot resurrect orphaned
      // memories after conversation/meeting deletion.
      if (!(await this.sourceExists(userId, sourceType, sourceId))) return;
      for (const fact of facts) await this.upsertFact(userId, sourceType, sourceId, observedAt, fact);
      if (!(await this.sourceExists(userId, sourceType, sourceId))) await deleteMemoryFactsBySources(this.prisma, userId, [sourceId]);
    } catch (error) {
      console.error(JSON.stringify({ level: "error", job: "memory.extract", user: this.userHash(userId), sourceType, sourceId, ...safeErrorMeta(error) }));
      throw error;
    }
  }

  private async upsertFact(userId: string, sourceType: string, sourceId: string, observedAt: Date, fact: z.infer<typeof memoryFactSchema>) {
    const entity = await this.prisma.memoryEntity.upsert({
      where: { userId_type_canonicalName: { userId, type: fact.entityType, canonicalName: fact.entityName } },
      create: { userId, type: fact.entityType, canonicalName: fact.entityName }, update: {},
    });
    const effectiveAt = fact.effectiveAt ? new Date(fact.effectiveAt) : null;
    const lockKey = this.memoryLockKey(userId, entity.id, fact.attribute);
    const token = await this.acquireMemoryLock(lockKey);
    try { await this.prisma.$transaction(async (tx) => {
      const existing = await tx.memoryFact.findMany({ where: { entityId: entity.id, attribute: fact.attribute }, orderBy: { createdAt: "asc" } });
      if (existing.some((item) => item.value === fact.value && item.sourceType === sourceType && item.sourceId === sourceId)) return;
      const created = await tx.memoryFact.create({ data: { entityId: entity.id, attribute: fact.attribute, value: fact.value, confidence: fact.confidence, effectiveAt, observedAt, sourceType, sourceId } });
      const chain = [...existing, created].sort((left, right) => {
        if (left.userEdited !== right.userEdited) return left.userEdited ? 1 : -1;
        const byFactTime = (left.effectiveAt ?? left.observedAt).valueOf() - (right.effectiveAt ?? right.observedAt).valueOf();
        return byFactTime || left.createdAt.valueOf() - right.createdAt.valueOf();
      });
      await tx.memoryFact.updateMany({ where: { entityId: entity.id, attribute: fact.attribute }, data: { supersededById: null } });
      for (let index = 0; index < chain.length - 1; index++) {
        await tx.memoryFact.update({ where: { id: chain[index].id }, data: { supersededById: chain[index + 1].id } });
      }
    }); } finally { await this.redis.release(lockKey, token); }
  }

  private userHash(userId: string) { return createHash("sha256").update(userId).digest("hex").slice(0, 12); }
  private async sourceExists(userId: string, sourceType: "CONVERSATION" | "MEETING", sourceId: string) {
    if (sourceType === "CONVERSATION") return Boolean(await this.prisma.agentRun.findFirst({ where: { id: sourceId, userId }, select: { id: true } }));
    return Boolean(await this.prisma.meeting.findFirst({ where: { id: sourceId, conversation: { userId } }, select: { id: true } }));
  }
  private memoryLockKey(userId: string, entityId: string, attribute: string) { return `memory:${userId}:${entityId}:${createHash("sha256").update(attribute).digest("hex").slice(0, 16)}`; }
  private async acquireMemoryLock(key: string) {
    for (let attempt = 0; attempt < 100; attempt++) {
      const token = await this.redis.acquire(key, 60_000);
      if (token) return token;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error("MEMORY_UPDATE_BUSY");
  }
  private normalizeDate(value: unknown) {
    if (typeof value !== "string" || !value.trim()) return null;
    const chinese = value.match(/^(\d{4})年(\d{1,2})月(\d{1,2})日/);
    const normalized = chinese ? `${chinese[1]}-${chinese[2].padStart(2, "0")}-${chinese[3].padStart(2, "0")}T00:00:00+08:00` : value;
    const date = new Date(normalized);
    return Number.isNaN(date.valueOf()) ? null : date.toISOString();
  }
}
