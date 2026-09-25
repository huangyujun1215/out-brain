import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { PrismaService } from "../../infra/prisma.service.js";

@Injectable()
export class TodosService {
  constructor(private readonly prisma: PrismaService) {}
  list(userId: string, filters: { status?: string; owner?: string; dueFrom?: string; dueTo?: string }) {
    if (filters.status && !["PENDING", "IN_PROGRESS", "COMPLETED", "CANCELLED"].includes(filters.status)) throw new BadRequestException("待办状态筛选值无效");
    const dueFrom = filters.dueFrom ? new Date(`${filters.dueFrom}T00:00:00`) : undefined;
    const dueTo = filters.dueTo ? new Date(`${filters.dueTo}T23:59:59.999`) : undefined;
    if ((dueFrom && Number.isNaN(dueFrom.valueOf())) || (dueTo && Number.isNaN(dueTo.valueOf()))) throw new BadRequestException("截止日期筛选格式无效");
    return this.prisma.todo.findMany({
      where: { userId, ...(filters.status ? { status: filters.status as never } : {}), ...(filters.owner ? { owner: { contains: filters.owner, mode: "insensitive" } } : {}), ...((dueFrom || dueTo) ? { dueAt: { gte: dueFrom, lte: dueTo } } : {}) },
      include: { meeting: { select: { id: true, title: true } }, risk: { select: { severity: true, description: true } } },
      orderBy: [{ status: "asc" }, { dueAt: "asc" }, { createdAt: "desc" }],
    });
  }
  async update(userId: string, id: string, data: Record<string, unknown>) {
    const existing = await this.prisma.todo.findFirst({ where: { id, userId } });
    if (!existing) throw new NotFoundException("待办不存在");
    return this.prisma.todo.update({ where: { id }, data: data as never });
  }
  async remove(userId: string, id: string) {
    const result = await this.prisma.todo.deleteMany({ where: { id, userId } });
    if (!result.count) throw new NotFoundException("待办不存在");
    return { ok: true };
  }
}
