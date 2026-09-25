import { Controller, Get, Param, Post, UseGuards } from "@nestjs/common";
import { CurrentUser, type AuthUser } from "../../common/current-user.js";
import { JwtAuthGuard } from "../auth/jwt-auth.guard.js";
import { MeetingsService } from "./meetings.service.js";

@Controller("conversations/:conversationId/meetings") @UseGuards(JwtAuthGuard)
export class MeetingsController {
  constructor(private readonly meetings: MeetingsService) {}
  @Get() list(@CurrentUser() user: AuthUser, @Param("conversationId") id: string) { return this.meetings.list(user.id, id); }
  @Post("reanalyze") reanalyze(@CurrentUser() user: AuthUser, @Param("conversationId") id: string) { return this.meetings.requestAnalysis(user.id, id, true); }
}
