import { ConflictException, Injectable, NotFoundException, OnModuleInit } from "@nestjs/common";
import { Agent, type AgentTool } from "@earendil-works/pi-agent-core";
import type { Message } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { PrismaService } from "../../infra/prisma.service.js";
import { ConversationsService } from "../conversations/conversations.service.js";
import { RetrievalService } from "../files/retrieval.service.js";
import { MemoriesService } from "../memories/memories.service.js";
import { PresentationsService } from "../presentations/presentations.service.js";
import { SearchService } from "../search/search.service.js";
import { PiModelsService } from "./pi-models.service.js";
import { RedisService } from "../../infra/redis.service.js";
import { JobsService } from "../../infra/jobs.service.js";
import { AgentRuntimePort, type AgentRunInput } from "./agent-runtime.port.js";
import { createHash } from "node:crypto";
import { safeErrorMeta } from "../../common/safe-error.js";

@Injectable()
export class AgentRuntimeService extends AgentRuntimePort implements OnModuleInit {
  private readonly active = new Map<string, { userId: string; conversationId: string; agent: Agent }>();
  constructor(
    private readonly prisma: PrismaService,
    private readonly conversations: ConversationsService,
    private readonly models: PiModelsService,
    private readonly retrieval: RetrievalService,
    private readonly memories: MemoriesService,
    private readonly search: SearchService,
    private readonly presentations: PresentationsService,
    private readonly redis: RedisService,
    private readonly jobs: JobsService,
  ) { super(); }

  async onModuleInit() {
    if (process.env.WORKER_MODE === "true") return;
    await this.prisma.agentRun.updateMany({ where: { status: "RUNNING" }, data: { status: "INTERRUPTED", endedAt: new Date(), errorCode: "PROCESS_RESTARTED" } });
  }

  async run(input: AgentRunInput, emit: (event: unknown) => void) {
    const conversation = await this.conversations.assertOwned(input.userId, input.conversationId);
    if ([...this.active.values()].some((run) => run.conversationId === input.conversationId)) throw new ConflictException("当前会话已有生成任务");
    const run = await this.prisma.agentRun.create({ data: { userId: input.userId, conversationId: input.conversationId, model: this.models.model.id, status: "RUNNING", startedAt: new Date() } });
    const searchCaptures: Array<{ query: string; results: unknown[] }> = [];
    const tools = await this.tools(input, (capture) => { searchCaptures.push(capture); });
    const toolNames = tools.map((tool) => tool.name);
    const history = await this.loadHistory(input.conversationId);
    const searchEnabled = input.webSearch && this.search.available();
    const memoryRequired = this.needsMemory(input.content);
    const systemPrompt = this.systemPrompt(conversation.mode, searchEnabled, input.webSearch && !searchEnabled, memoryRequired);
    const lastSystem = await this.prisma.message.findFirst({ where: { conversationId: input.conversationId, role: "SYSTEM" }, orderBy: { createdAt: "desc" } });
    const systemMetadata = { tools: toolNames, runtime: "pi-agent-core", version: "0.87.1" };
    if (!lastSystem || lastSystem.content !== systemPrompt || JSON.stringify(lastSystem.metadata) !== JSON.stringify(systemMetadata)) {
      await this.prisma.message.create({ data: { conversationId: input.conversationId, role: "SYSTEM", content: systemPrompt, metadata: systemMetadata } });
    }
    const configuredMaxToolTurns = Number(process.env.PI_AGENT_MAX_TOOL_TURNS ?? 8);
    const maxToolTurns = Number.isInteger(configuredMaxToolTurns) && configuredMaxToolTurns > 0 ? configuredMaxToolTurns : 8;
    let toolTurns = 0;
    let maxToolTurnsReached = false;
    const agent = new Agent({
      initialState: {
        systemPrompt,
        model: this.models.model,
        thinkingLevel: (process.env.PI_AGENT_THINKING_LEVEL as "off" | "minimal" | "low" | "medium" | "high") ?? "medium",
        tools,
        messages: history,
      },
      streamFn: this.models.stream,
      sessionId: input.conversationId,
      maxRetryDelayMs: Number(process.env.LLM_MAX_RETRY_DELAY_MS ?? 30_000),
      toolExecution: process.env.PI_AGENT_TOOL_EXECUTION === "sequential" ? "sequential" : "parallel",
      beforeToolCall: async ({ toolCall }) => {
        await this.conversations.assertOwned(input.userId, input.conversationId);
        const allowed = tools.some((tool) => tool.name === toolCall.name);
        return allowed ? undefined : { block: true, reason: "该工具未获本轮授权", terminate: true };
      },
      afterToolCall: async ({ result, isError }) => ({
        isError,
        content: result.content.map((part) => part.type === "text" ? { ...part, text: part.text.slice(0, 16_000) } : part),
        details: result.details ? { available: true } : {},
      }),
      finishTurn: async ({ toolResults }) => {
        if (toolResults.length) toolTurns += 1;
        if (toolTurns >= maxToolTurns && toolResults.length) { maxToolTurnsReached = true; return { action: "end" }; }
        return undefined;
      },
      prepareRequest: async ({ context, model, thinkingLevel }) => {
        await this.conversations.assertOwned(input.userId, input.conversationId);
        const canonical = await this.loadHistory(input.conversationId);
        const system = context.messages.filter((message) => message.role === "system");
        const messages = [...system, ...this.pruneHistory(canonical, 240_000)];
        return { context: { messages, tools }, model, thinkingLevel };
      },
    });
    const lockToken = await this.redis.acquire(`conversation:${input.conversationId}`, 15 * 60_000);
    if (!lockToken) {
      await this.prisma.agentRun.update({ where: { id: run.id }, data: { status: "FAILED", errorCode: "CONCURRENT_RUN", endedAt: new Date() } });
      throw new ConflictException("当前会话已有生成任务");
    }
    this.active.set(run.id, { userId: input.userId, conversationId: input.conversationId, agent });
    const renewTimer = setInterval(() => { void this.redis.renew(`conversation:${input.conversationId}`, lockToken, 15 * 60_000); }, 60_000);
    renewTimer.unref();
    let sequence = 0;
    let assistantPersisted = false;
    const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    agent.subscribe(async (event) => {
      const payload = this.safeEvent(event);
      await this.prisma.agentEvent.create({ data: { runId: run.id, sequence: sequence++, eventType: event.type, payload: payload as never } });
      if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") emit({ type: "message.delta", runId: run.id, delta: event.assistantMessageEvent.delta });
      if (event.type === "tool_execution_start") {
        emit({ type: "tool.started", runId: run.id, toolCallId: event.toolCallId, toolName: event.toolName });
        await this.prisma.toolExecution.upsert({ where: { runId_toolCallId: { runId: run.id, toolCallId: event.toolCallId } }, create: { runId: run.id, toolCallId: event.toolCallId, toolName: event.toolName, arguments: this.redactValue(event.args, 2_000) as never, status: "RUNNING" }, update: {} });
      }
      if (event.type === "tool_execution_end") {
        emit({ type: "tool.completed", runId: run.id, toolCallId: event.toolCallId, toolName: event.toolName, isError: event.isError });
        await this.prisma.toolExecution.updateMany({ where: { runId: run.id, toolCallId: event.toolCallId }, data: { status: event.isError ? "FAILED" : "COMPLETED", result: this.redactToolResult(event.result) as never, endedAt: new Date() } });
      }
      if (event.type === "message_end" && event.message.role === "assistant") {
        usage.input += event.message.usage.input;
        usage.output += event.message.usage.output;
        usage.cacheRead += event.message.usage.cacheRead;
        usage.cacheWrite += event.message.usage.cacheWrite;
        const content = this.messageText(event.message);
        const visible = content.trim().length > 0;
        const message = await this.prisma.message.create({ data: { conversationId: input.conversationId, role: visible ? "ASSISTANT" : "TOOL", content, metadata: { piMessage: event.message } as never } });
        if (visible) {
          if (searchCaptures.length) {
            await this.prisma.searchRun.createMany({ data: searchCaptures.map((capture) => ({ messageId: message.id, query: capture.query, searchedAt: new Date(), sources: capture.results as never })) });
            searchCaptures.length = 0;
          }
          assistantPersisted = true;
          emit({ type: "message.completed", runId: run.id, messageId: message.id, content });
        }
      }
      if (event.type === "message_end" && event.message.role === "toolResult") {
        const content = event.message.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
        await this.prisma.message.create({ data: { conversationId: input.conversationId, role: "TOOL", content, metadata: { piMessage: event.message } as never } });
      }
    });
    emit({ type: "run.started", runId: run.id });
    try {
      await this.prisma.message.create({ data: { conversationId: input.conversationId, role: "USER", content: input.content, metadata: { webSearch: input.webSearch } } });
      await agent.prompt(input.content);
      if (maxToolTurnsReached) throw new Error("AGENT_MAX_TOOL_TURNS");
      if (this.models.consumeTimeout(input.conversationId)) throw new Error("PROVIDER_TIMEOUT");
      // Pi represents provider/transport failures on the final assistant
      // message instead of necessarily rejecting prompt(). Preserve that
      // signal so timeout, rate-limit, auth and malformed responses do not all
      // collapse into an undiagnosable generic error in persisted run state.
      if (!assistantPersisted) throw new Error(agent.state.errorMessage || "Agent 未生成可保存的回复");
      const endedAt = new Date();
      await this.prisma.agentRun.update({ where: { id: run.id }, data: { status: "COMPLETED", endedAt, durationMs: endedAt.valueOf() - run.createdAt.valueOf(), inputTokens: usage.input, outputTokens: usage.output, cacheReadTokens: usage.cacheRead, cacheWriteTokens: usage.cacheWrite } });
      console.info(JSON.stringify({ level: "info", traceId: run.id, user: this.userHash(input.userId), resource: input.conversationId, operation: "agent.run", status: "COMPLETED", durationMs: endedAt.valueOf() - run.createdAt.valueOf(), usage }));
      await this.prisma.conversation.update({ where: { id: input.conversationId }, data: { updatedAt: new Date(), ...(conversation.title.startsWith("新") ? { title: input.content.slice(0, 36) } : {}) } });
      const assistant = [...agent.state.messages].reverse().find((item) => item.role === "assistant");
      try { await this.jobs.extractMemory(input.userId, "CONVERSATION", run.id, `${input.content}\n${assistant ? this.messageText(assistant as Message) : ""}`, run.createdAt); }
      catch { console.error(JSON.stringify({ level: "error", runId: run.id, job: "memory.extract", errorCode: "QUEUE_UNAVAILABLE" })); }
      emit({ type: "run.completed", runId: run.id });
    } catch (error) {
      const code = this.runErrorCode(error, agent.state.errorMessage);
      const aborted = code === "ABORTED";
      const endedAt = new Date();
      await this.prisma.agentRun.update({ where: { id: run.id }, data: { status: aborted ? "ABORTED" : "FAILED", endedAt, durationMs: endedAt.valueOf() - run.createdAt.valueOf(), errorCode: code, inputTokens: usage.input, outputTokens: usage.output, cacheReadTokens: usage.cacheRead, cacheWriteTokens: usage.cacheWrite } });
      console.error(JSON.stringify({ level: "error", traceId: run.id, user: this.userHash(input.userId), resource: input.conversationId, operation: "agent.run", status: aborted ? "ABORTED" : "FAILED", errorCode: code, durationMs: endedAt.valueOf() - run.createdAt.valueOf(), usage }));
      if (aborted) emit({ type: "run.aborted", runId: run.id }); else throw error;
    } finally { clearInterval(renewTimer); this.active.delete(run.id); await this.redis.release(`conversation:${input.conversationId}`, lockToken); }
  }

  async abort(runId: string, userId: string) {
    const active = this.active.get(runId);
    if (!active || active.userId !== userId) throw new NotFoundException("运行不存在或已结束");
    active.agent.abort();
    await this.prisma.agentRun.update({ where: { id: runId }, data: { abortReason: "USER_REQUEST" } });
    return { ok: true };
  }

  async abortConversation(conversationId: string, userId: string) {
    const active = [...this.active.values()].find((run) => run.conversationId === conversationId && run.userId === userId);
    if (!active) return;
    active.agent.abort();
    await active.agent.waitForIdle();
  }

  private async tools(input: AgentRunInput, onSearch: (capture: { query: string; results: unknown[] }) => void): Promise<AgentTool<any>[]> {
    const tools: AgentTool<any>[] = [];
    const conversation = await this.conversations.assertOwned(input.userId, input.conversationId);
    const pdfCount = await this.prisma.fileAsset.count({ where: { userId: input.userId, conversationId: input.conversationId, kind: "PDF", status: "READY" } });
    if (pdfCount) tools.push({
      name: "retrieve_documents", label: "检索会话文件", description: "检索当前会话上传的 PDF。回答文件相关问题前必须调用。",
      parameters: Type.Object({ query: Type.String() }),
      execute: async (_id, params: any) => {
        const results = await this.retrieval.search(input.userId, input.conversationId, params.query);
        return { content: [{ type: "text", text: results.length ? results.map((r) => `[${r.fileName} 第${r.pageStart}页] ${r.content}`).join("\n\n") : "资料中没有相关信息。回答必须先原样说明“资料中没有相关信息”，再将任何通用知识放在“### 常识补充”下。" }], details: { results } };
      },
    });
    if (this.needsMemory(input.content)) tools.push({
      name: "retrieve_memory", label: "检索长期记忆", description: "检索当前用户在历史对话和会议中的相关记忆。",
      parameters: Type.Object({ query: Type.String() }),
      execute: async (_id, params: any) => { const facts = await this.memories.currentFacts(input.userId, params.query); return { content: [{ type: "text", text: JSON.stringify(facts) }], details: { count: facts.length } }; },
    });
    if (input.webSearch && this.search.available()) tools.push({
      name: "search_web", label: "联网搜索", description: "搜索时效性信息，回答中必须附可点击 URL 和检索时间。",
      parameters: Type.Object({ query: Type.String() }),
      execute: async (_id, params: any) => { const results = await this.search.search(params.query); onSearch({ query: params.query, results }); return { content: [{ type: "text", text: JSON.stringify(results) }], details: { results, query: params.query } }; },
    });
    if (conversation.mode === "MEETING") tools.push({
      name: "analyze_meeting", label: "分析会议", description: "用户要求重新分析当前会议材料时，将分析任务加入后台队列。",
      parameters: Type.Object({ force: Type.Boolean() }), executionMode: "sequential",
      execute: async (_id, params: any) => { await this.jobs.analyzeMeeting(input.userId, input.conversationId, params.force); return { content: [{ type: "text", text: "会议分析任务已提交，结果稍后显示在会话产物区。" }], details: { conversationId: input.conversationId }, terminate: false }; },
    });
    if (this.wantsPresentation(input.content)) tools.push({
      name: "generate_presentation", label: "生成 PPT", description: "用户已明确要求制作 PPT；调用后创建可编辑演示文稿的后台任务。",
      parameters: Type.Object({ instruction: Type.String() }), executionMode: "sequential",
      execute: async (toolCallId, params: any) => { const presentation = await this.presentations.request(input.userId, input.conversationId, params.instruction, `${input.conversationId}:${toolCallId}`); return { content: [{ type: "text", text: `PPT 已进入后台生成队列，任务 ID：${presentation.id}` }], details: { presentationId: presentation.id, status: presentation.status }, terminate: false }; },
    });
    return tools;
  }

  private async loadHistory(conversationId: string): Promise<Message[]> {
    const rows = await this.prisma.message.findMany({ where: { conversationId, role: { not: "SYSTEM" } }, orderBy: { createdAt: "desc" }, take: 100 });
    return rows.reverse().flatMap((row): Message[] => {
      if (row.role === "USER") return [{ role: "user", content: row.content, timestamp: row.createdAt.valueOf() }];
      const piMessage = (row.metadata as { piMessage?: Message } | null)?.piMessage;
      return piMessage ? [piMessage] : [];
    });
  }

  private pruneHistory(messages: Message[], maxCharacters: number) {
    const selected: Message[] = [];
    let used = 0;
    for (let index = messages.length - 1; index >= 0; index--) {
      const size = JSON.stringify(messages[index]).length;
      if (selected.length && used + size > maxCharacters) break;
      selected.unshift(messages[index]); used += size;
    }
    const calls = new Set(selected.flatMap((message) => message.role === "assistant" ? message.content.filter((part) => part.type === "toolCall").map((part) => part.id) : []));
    return selected.filter((message) => message.role !== "toolResult" || calls.has(message.toolCallId));
  }

  private systemPrompt(mode: string, webSearch: boolean, searchUnavailable = false, memoryRequired = false) {
    return `你是 NBBOSS AI 外脑，服务企业内部员工。严禁编造文件引用、人员、日期或待办信息。需要文件依据时调用 retrieve_documents。文件检索没有证据时必须先原样写“资料中没有相关信息”；如继续回答，必须另起“### 常识补充”标题，禁止给常识伪造文件引用。${memoryRequired ? "本轮已由轻量判断器判定需要长期记忆；回答前必须调用 retrieve_memory，即使当前聊天记录中似乎已有答案。" : "本轮无需长期记忆，不得声称调用了长期记忆。"}${webSearch ? "用户已开启联网搜索，需要时调用 search_web 并展示链接和检索时间。" : searchUnavailable ? "用户请求联网搜索，但搜索服务未配置；应明确说明无法联网，再基于常识回答并标明这是常识。" : "用户未开启联网搜索，不得声称访问了互联网。"}${mode === "MEETING" ? "当前是会议分析会话，围绕会议事实、承诺闭环和行动项回答。" : "当前是普通对话会话。"}用户明确要求 PPT 时调用 generate_presentation。`;
  }
  private needsMemory(text: string) { return /(之前|上次|记得|我们聊过|谁|什么时候|哪里|历史|曾经)/.test(text); }
  private wantsPresentation(text: string) { return /(?:ppt|powerpoint|slides?|presentation|幻灯片|演示文稿)/i.test(text); }
  private userHash(userId: string) { return createHash("sha256").update(userId).digest("hex").slice(0, 12); }
  private runErrorCode(error: unknown, agentError?: string) {
    if (agentError?.toLowerCase().includes("abort")) return "ABORTED";
    if (error instanceof Error && error.message === "AGENT_MAX_TOOL_TURNS") return "MAX_TOOL_TURNS";
    const classified = safeErrorMeta(agentError ? new Error(agentError) : error).errorCode;
    if (classified === "ABORTED") return "ABORTED";
    if (classified === "TIMEOUT") return "PROVIDER_TIMEOUT";
    if (classified === "RATE_LIMITED") return "PROVIDER_RATE_LIMITED";
    if (classified === "PROVIDER_AUTH") return "PROVIDER_AUTH";
    if (classified === "INVALID_RESPONSE") return "PROVIDER_INVALID_RESPONSE";
    return "AGENT_ERROR";
  }
  private messageText(message: Message) { return message.role === "assistant" ? message.content.filter((part) => part.type === "text").map((part) => part.text).join("") : ""; }
  private safeEvent(event: any) { return { type: event.type, ...(event.toolCallId ? { toolCallId: event.toolCallId, toolName: event.toolName } : {}) }; }
  private redactToolResult(result: any) { return { content: result?.content?.map((part: any) => part.type === "text" ? { type: "text", text: String(part.text).slice(0, 4000) } : { type: part.type }) ?? [], details: result?.details ? { available: true } : undefined }; }
  private redactValue(value: unknown, maxString: number): unknown {
    if (typeof value === "string") return value.slice(0, maxString);
    if (Array.isArray(value)) return value.slice(0, 50).map((item) => this.redactValue(item, maxString));
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).slice(0, 50).map(([key, item]) => [key, /key|token|password|secret|authorization/i.test(key) ? "[REDACTED]" : this.redactValue(item, maxString)]));
    return value;
  }
}
