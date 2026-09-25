import { Body, Controller, Post, Req, Res } from "@nestjs/common";
import type { Request, Response } from "express";
import { z } from "zod";
import { AuthService } from "./auth.service.js";

const credentials = z.object({ username: z.string(), password: z.string() });

@Controller("auth")
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Post("register")
  async register(@Body() body: unknown, @Res({ passthrough: true }) res: Response) {
    return this.setCookies(res, await this.auth.register(...this.values(body)));
  }

  @Post("login")
  async login(@Body() body: unknown, @Res({ passthrough: true }) res: Response) {
    return this.setCookies(res, await this.auth.login(...this.values(body)));
  }

  @Post("refresh")
  async refresh(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    return this.setCookies(res, await this.auth.refresh(req.cookies?.nbboss_refresh));
  }

  @Post("logout")
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    await this.auth.logout(req.cookies?.nbboss_refresh);
    res.clearCookie("nbboss_access"); res.clearCookie("nbboss_refresh");
    return { ok: true };
  }

  private values(body: unknown): [string, string] { const v = credentials.parse(body); return [v.username.trim(), v.password]; }
  private setCookies(res: Response, value: { user: unknown; accessToken: string; refreshToken: string }) {
    const secure = process.env.NODE_ENV === "production";
    res.cookie("nbboss_access", value.accessToken, { httpOnly: true, sameSite: "lax", secure, maxAge: 15 * 60_000 });
    res.cookie("nbboss_refresh", value.refreshToken, { httpOnly: true, sameSite: "lax", secure, maxAge: 7 * 86400_000 });
    return { user: value.user };
  }
}
