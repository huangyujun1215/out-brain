import { Injectable, OnModuleDestroy } from "@nestjs/common";
import { Redis } from "ioredis";
import { randomUUID } from "node:crypto";

@Injectable()
export class RedisService implements OnModuleDestroy {
  readonly client = new Redis(process.env.REDIS_URL ?? "redis://localhost:6379", { maxRetriesPerRequest: 2, lazyConnect: true });
  private connected = false;
  async connect() { if (!this.connected) { await this.client.connect(); this.connected = true; } }
  async acquire(key: string, ttlMs: number) { await this.connect(); const token = randomUUID(); const result = await this.client.set(`lock:${key}`, token, "PX", ttlMs, "NX"); return result === "OK" ? token : null; }
  async ping() { await this.connect(); return this.client.ping(); }
  async renew(key: string, token: string, ttlMs: number) { await this.connect(); return Number(await this.client.eval("if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('pexpire', KEYS[1], ARGV[2]) else return 0 end", 1, `lock:${key}`, token, ttlMs)) === 1; }
  async release(key: string, token: string) { await this.connect(); await this.client.eval("if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end", 1, `lock:${key}`, token); }
  async onModuleDestroy() { if (this.connected) await this.client.quit(); }
}
