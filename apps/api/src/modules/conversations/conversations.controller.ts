import { Body, Controller, Delete, Get, Param, Post, Res, UseGuards } from "@nestjs/common";
import type { Response } from "express";
import { createConversationSchema, sendMessageSchema } from "@nbboss/contracts";
import { CurrentUser, type AuthUser } from "../../common/current-user.js";
import { JwtAuthGuard } from "../auth/jwt-auth.guard.js";
import { AGENT_RUNTIME_PORT, AgentRuntimePort } from "../agent/agent-runtime.port.js";
import { Inject } from "@nestjs/common";
import { ConversationsService } from "./conversations.service.js";
import { createHash, randomUUID } from "node:crypto";
import { safeErrorMeta } from "../../common/safe-error.js";

@Controller("conversations")
@UseGuards(JwtAuthGuard)
export class ConversationsController {
  constructor(private readonly conversations: ConversationsService, @Inject(AGENT_RUNTIME_PORT) private readonly runtime: AgentRuntimePort) {}

  @Get() list(@CurrentUser() user: AuthUser) { return this.conversations.list(user.id); }
  @Post() create(@CurrentUser() user: AuthUser, @Body() body: unknown) {
    const value = createConversationSchema.parse(body);
    return this.conversations.create(user.id, value.mode, value.title);
  }
  @Get(":id") get(@CurrentUser() user: AuthUser, @Param("id") id: string) { return this.conversations.get(user.id, id); }
  @Delete(":id") async remove(@CurrentUser() user: AuthUser, @Param("id") id: string) {
    await this.runtime.abortConversation(id, user.id);
    return this.conversations.remove(user.id, id);
  }

  @Post(":id/messages")
  async message(@CurrentUser() user: AuthUser, @Param("id") id: string, @Body() body: unknown, @Res() res: Response) {
    const input = sendMessageSchema.parse(body);
    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders();
    let runId: string | undefined;
    const send = (event: unknown) => {
      if (event && typeof event === "object" && "runId" in event && typeof event.runId === "string") runId = event.runId;
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    };
    try { await this.runtime.run({ userId: user.id, conversationId: id, ...input }, send); }
    catch (error) {
      const traceId = runId ?? randomUUID();
      const maxTurns = error instanceof Error && error.message === "AGENT_MAX_TOOL_TURNS";
      const code = maxTurns ? "MAX_TOOL_TURNS" : safeErrorMeta(error).errorCode;
      console.error(JSON.stringify({ level: "error", traceId, user: createHash("sha256").update(user.id).digest("hex").slice(0, 12), resource: id, operation: "agent.stream", status: "FAILED", errorCode: code }));
      send({ type: "run.failed", runId: traceId, code, message: maxTurns ? `工具调用次数超过上限，请缩小问题范围（参考编号：${traceId}）` : `生成失败，系统已记录（参考编号：${traceId}）` });
    }
    finally { res.end(); }
  }

  @Post(":id/runs/:runId/abort")
  async abort(@CurrentUser() user: AuthUser, @Param("id") id: string, @Param("runId") runId: string) {
    await this.conversations.assertOwned(user.id, id);
    return this.runtime.abort(runId, user.id);
  }
}
