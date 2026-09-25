import { Controller, Get } from "@nestjs/common";
import { PrismaService } from "./infra/prisma.service.js";
import { RedisService } from "./infra/redis.service.js";

@Controller("health")
export class HealthController {
  constructor(private readonly prisma: PrismaService, private readonly redis: RedisService) {}

  @Get("live")
  live() { return { status: "ok", time: new Date().toISOString() }; }

  @Get("ready")
  async ready() {
    await this.prisma.$queryRaw`SELECT 1`;
    await this.redis.ping();
    return { status: "ready", database: "ok", redis: "ok" };
  }

  @Get("capabilities")
  capabilities() {
    return {
      search: process.env.SEARCH_ENABLED === "true" && (process.env.SEARCH_PROVIDER === "mock" || Boolean(process.env.SEARCH_API_KEY)),
      smtp: process.env.SMTP_ENABLED === "true" && (process.env.SMTP_PROVIDER === "mock" || Boolean(process.env.SMTP_HOST && process.env.SMTP_TO)),
      embedding: Boolean(process.env.EMBEDDING_BASE_URL && process.env.EMBEDDING_API_KEY && process.env.EMBEDDING_MODEL),
      vision: process.env.VISION_ENABLED === "true" && Boolean(process.env.VISION_BASE_URL && process.env.VISION_API_KEY && process.env.VISION_MODEL),
    };
  }
}
