import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";

@Injectable()
export class JwtAuthGuard implements CanActivate {
  private readonly jwt = new JwtService({ secret: process.env.JWT_ACCESS_SECRET ?? "local-dev-access-secret-change-me" });

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest();
    const header = request.headers.authorization as string | undefined;
    const token = request.cookies?.nbboss_access ?? header?.replace(/^Bearer\s+/i, "");
    if (!token) throw new UnauthorizedException("请先登录");
    try {
      request.user = this.jwt.verify(token);
      return true;
    } catch {
      throw new UnauthorizedException("登录已过期");
    }
  }
}
