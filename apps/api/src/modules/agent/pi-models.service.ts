import { Injectable } from "@nestjs/common";
import { createModels, createProvider, type Model } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { Agent } from "@earendil-works/pi-agent-core";
import type { TSchema } from "typebox";
import { randomUUID } from "node:crypto";

@Injectable()
export class PiModelsService {
  readonly models = createModels();
  readonly model: Model<"openai-completions">;
  private readonly timedOutSessions = new Set<string>();

  constructor() {
    const providerId = "nbboss-llm";
    const baseUrl = process.env.LLM_BASE_URL ?? "https://open.bigmodel.cn/api/coding/paas/v4";
    const id = process.env.LLM_MODEL ?? "glm-5.3";
    this.model = {
      id, name: id, api: "openai-completions", provider: providerId, baseUrl,
      reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128_000, maxTokens: 16_384,
      compat: { supportsDeveloperRole: false, supportsReasoningEffort: false },
    };
    this.models.setProvider(createProvider({
      id: providerId, name: "NBBOSS configurable LLM", baseUrl,
      auth: { apiKey: { name: "NBBOSS LLM key", resolve: async () => ({ auth: { apiKey: process.env.LLM_API_KEY ?? "" } }) } },
      models: [this.model], api: openAICompletionsApi(),
    }));
  }

  readonly stream = ((model: Parameters<typeof this.models.streamSimple>[0], context: Parameters<typeof this.models.streamSimple>[1], options?: Parameters<typeof this.models.streamSimple>[2]) => {
    const timeoutMs = this.timeoutMs();
    // The OpenAI SDK timeout only covers creation of the streaming response on
    // some compatible servers. Compose an abort signal as a hard wall-clock
    // deadline so a provider that opens SSE and then stalls cannot occupy a
    // conversation lock forever.
    const sessionKey = options?.sessionId ?? randomUUID();
    const timeoutController = new AbortController();
    const timer = setTimeout(() => {
      this.timedOutSessions.add(sessionKey);
      timeoutController.abort(new Error("PROVIDER_TIMEOUT"));
    }, timeoutMs);
    timer.unref();
    const signal = options?.signal ? AbortSignal.any([options.signal, timeoutController.signal]) : timeoutController.signal;
    const result = this.models.streamSimple(model, context, {
      ...options,
      sessionId: sessionKey,
      signal,
      timeoutMs,
      maxRetries: this.maxRetries(),
      maxRetryDelayMs: this.maxRetryDelayMs(),
    });
    void result.result().finally(() => clearTimeout(timer));
    return result;
  }) as typeof this.models.streamSimple;

  async completeJson(prompt: string, signal?: AbortSignal): Promise<string> {
    const response = await this.models.complete(this.model, { messages: [
      { role: "system", content: "只输出符合要求的 JSON，不要使用 Markdown 代码块。", timestamp: Date.now() },
      { role: "user", content: prompt, timestamp: Date.now() },
    ] }, { signal });
    return response.content.filter((part) => part.type === "text").map((part) => part.text).join("");
  }

  async runAgentText(systemPrompt: string, prompt: string, onDelta?: (delta: string) => void, signal?: AbortSignal) {
    const sessionId = randomUUID();
    const agent = new Agent({
      initialState: { systemPrompt, model: this.model, thinkingLevel: (process.env.PI_AGENT_THINKING_LEVEL as "off" | "minimal" | "low" | "medium" | "high") ?? "medium", tools: [], messages: [] },
      streamFn: this.stream,
      sessionId,
    });
    agent.subscribe((event) => {
      if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") onDelta?.(event.assistantMessageEvent.delta);
    });
    if (signal) signal.addEventListener("abort", () => agent.abort(), { once: true });
    await agent.prompt(prompt);
    if (this.consumeTimeout(sessionId)) throw new Error("PROVIDER_TIMEOUT");
    if (agent.state.errorMessage) throw new Error(agent.state.errorMessage);
    const message = [...agent.state.messages].reverse().find((item) => item.role === "assistant");
    if (!message || !("content" in message)) throw new Error("模型未返回回答");
    return Array.isArray(message.content)
      ? message.content.filter((part): part is Extract<typeof part, { type: "text" }> => part.type === "text").map((part) => part.text).join("")
      : String(message.content);
  }

  async runStructuredAgent(systemPrompt: string, prompt: string, toolName: string, parameters: TSchema, signal?: AbortSignal): Promise<unknown> {
    let submitted: unknown;
    const sessionId = randomUUID();
    const agent = new Agent({
      initialState: {
        systemPrompt: `${systemPrompt}\n你必须调用 ${toolName} 提交最终结果，不要直接用自然语言作答。`, model: this.model,
        thinkingLevel: (process.env.PI_AGENT_THINKING_LEVEL as "off" | "minimal" | "low" | "medium" | "high") ?? "medium",
        messages: [], tools: [{ name: toolName, label: "提交结构化结果", description: "提交经过校验的最终结构化结果", parameters, executionMode: "sequential", execute: async (_id: string, params: unknown) => { submitted = params; return { content: [{ type: "text", text: "结果已接收" }], details: {}, terminate: true }; } }],
      },
      streamFn: this.stream, sessionId, toolExecution: "sequential", maxRetryDelayMs: this.maxRetryDelayMs(),
    });
    if (signal) signal.addEventListener("abort", () => agent.abort(), { once: true });
    await agent.prompt(prompt);
    if (this.consumeTimeout(sessionId)) throw new Error("PROVIDER_TIMEOUT");
    if (agent.state.errorMessage) throw new Error(agent.state.errorMessage);
    if (submitted === undefined) throw new Error(`Agent 未调用 ${toolName}`);
    return submitted;
  }

  private timeoutMs() { const value = Number(process.env.LLM_TIMEOUT_MS ?? 180_000); return Number.isFinite(value) && value > 0 ? value : 180_000; }
  private maxRetries() { const value = Number(process.env.LLM_MAX_RETRIES ?? 2); return Number.isInteger(value) && value >= 0 && value <= 5 ? value : 2; }
  private maxRetryDelayMs() { const value = Number(process.env.LLM_MAX_RETRY_DELAY_MS ?? 30_000); return Number.isFinite(value) && value >= 0 ? value : 30_000; }
  consumeTimeout(sessionId: string) { const timedOut = this.timedOutSessions.delete(sessionId); return timedOut; }
}
