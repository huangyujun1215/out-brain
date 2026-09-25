import { Body, Controller, Get, Param, Post, Res, UseGuards } from "@nestjs/common";
import type { Response } from "express";
import { z } from "zod";
import { presentationSchema } from "@nbboss/contracts";
import { CurrentUser, type AuthUser } from "../../common/current-user.js";
import { JwtAuthGuard } from "../auth/jwt-auth.guard.js";
import { PresentationsService } from "./presentations.service.js";

@Controller() @UseGuards(JwtAuthGuard)
export class PresentationsController {
  constructor(private readonly presentations: PresentationsService) {}
  @Post("conversations/:conversationId/presentations")
  generate(@CurrentUser() user: AuthUser, @Param("conversationId") id: string, @Body() body: unknown) {
    const { prompt, idempotencyKey } = z.object({ prompt: z.string().trim().min(1).max(10_000), idempotencyKey: z.string().uuid().optional() }).parse(body);
    return this.presentations.request(user.id, id, prompt, idempotencyKey ? `${id}:${idempotencyKey}` : undefined);
  }
  @Get("presentations/:id/versions") list(@CurrentUser() user: AuthUser, @Param("id") id: string) { return this.presentations.listVersions(user.id, id); }
  @Post("presentations/:id/versions") save(@CurrentUser() user: AuthUser, @Param("id") id: string, @Body() body: unknown) {
    const value = z.object({ prompt: z.string().default("网页编辑"), document: presentationSchema }).parse(body);
    return this.presentations.saveVersion(user.id, id, value.prompt, value.document);
  }
  @Get("presentation-versions/:id/download") async download(@CurrentUser() user: AuthUser, @Param("id") id: string, @Res() res: Response) {
    const version = await this.presentations.getVersion(user.id, id);
    res.download(version.pptxPath, `${version.presentation.title}-v${version.version}.pptx`);
  }
}
