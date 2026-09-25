import { ConflictException, Injectable, UnauthorizedException } from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import * as argon2 from "argon2";
import { createHash, randomUUID } from "node:crypto";
import { PrismaService } from "../../infra/prisma.service.js";

@Injectable()
export class AuthService {
  private readonly accessJwt = new JwtService({ secret: process.env.JWT_ACCESS_SECRET ?? "local-dev-access-secret-change-me" });
  private readonly refreshJwt = new JwtService({ secret: process.env.JWT_REFRESH_SECRET ?? "local-dev-refresh-secret-change-me" });
  constructor(private readonly prisma: PrismaService) {}

  async register(username: string, password: string) {
    if (!/^[\w\u4e00-\u9fa5.-]{3,32}$/.test(username) || password.length < 8) {
      throw new UnauthorizedException("用户名需为 3-32 个字符，密码至少 8 位");
    }
    const exists = await this.prisma.user.findUnique({ where: { username } });
    if (exists) throw new ConflictException("用户名已存在");
    const user = await this.prisma.user.create({ data: { username, passwordHash: await argon2.hash(password, { type: argon2.argon2id }) } });
    return this.issue(user.id, user.username);
  }

  async login(username: string, password: string) {
    const user = await this.prisma.user.findUnique({ where: { username } });
    if (!user || !(await argon2.verify(user.passwordHash, password))) throw new UnauthorizedException("用户名或密码错误");
    return this.issue(user.id, user.username);
  }

  async refresh(raw: string) {
    try {
      const payload = this.refreshJwt.verify<{ sub: string; username: string; jti: string }>(raw);
      const token = await this.prisma.refreshToken.findUnique({ where: { id: payload.jti } });
      if (!token || token.revokedAt || token.expiresAt < new Date() || token.tokenHash !== this.hash(raw)) throw new Error();
      const revoked = await this.prisma.refreshToken.updateMany({ where: { id: token.id, revokedAt: null, expiresAt: { gt: new Date() }, tokenHash: this.hash(raw) }, data: { revokedAt: new Date() } });
      if (revoked.count !== 1) throw new Error();
      return this.issue(payload.sub, payload.username);
    } catch { throw new UnauthorizedException("刷新令牌无效"); }
  }

  async logout(raw?: string) {
    if (!raw) return;
    try {
      const { jti } = this.refreshJwt.verify<{ jti: string }>(raw);
      await this.prisma.refreshToken.updateMany({ where: { id: jti }, data: { revokedAt: new Date() } });
    } catch { /* idempotent */ }
  }

  private async issue(id: string, username: string) {
    const accessToken = await this.accessJwt.signAsync({ sub: id, id, username }, { expiresIn: "15m" });
    const jti = randomUUID();
    const refreshToken = await this.refreshJwt.signAsync({ sub: id, username, jti }, { expiresIn: "7d" });
    await this.prisma.refreshToken.create({ data: { id: jti, userId: id, tokenHash: this.hash(refreshToken), expiresAt: new Date(Date.now() + 7 * 86400_000) } });
    return { user: { id, username }, accessToken, refreshToken };
  }

  private hash(value: string) { return createHash("sha256").update(value).digest("hex"); }
}
