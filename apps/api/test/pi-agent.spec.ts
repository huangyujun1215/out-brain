import { describe, expect, it, vi } from "vitest";
import { Agent } from "@earendil-works/pi-agent-core";
import { createModels, fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { PiModelsService } from "../src/modules/agent/pi-models.service.js";
import { AgentRuntimeService } from "../src/modules/agent/agent-runtime.service.js";
import { createServer } from "node:http";
import { safeErrorMeta } from "../src/common/safe-error.js";

function fixture(tokensPerSecond = 0) {
  const faux = fauxProvider({ tokensPerSecond });
  const models = createModels();
  models.setProvider(faux.provider);
  return { faux, models };
}

describe("Pi Agent runtime contract", () => {
  it("applies bounded provider timeout and retry options", () => {
    const previous = { timeout: process.env.LLM_TIMEOUT_MS, retries: process.env.LLM_MAX_RETRIES, delay: process.env.LLM_MAX_RETRY_DELAY_MS };
    process.env.LLM_TIMEOUT_MS = "12345"; process.env.LLM_MAX_RETRIES = "3"; process.env.LLM_MAX_RETRY_DELAY_MS = "4321";
    try {
      const service = new PiModelsService();
      const stream = { marker: true, result: () => new Promise(() => {}) };
      const spy = vi.spyOn(service.models, "streamSimple").mockReturnValue(stream as any);
      expect(service.stream(service.model, { messages: [] }, { maxRetries: 0 } as any)).toBe(stream);
      expect(spy).toHaveBeenCalledWith(service.model, { messages: [] }, expect.objectContaining({ timeoutMs: 12345, maxRetries: 3, maxRetryDelayMs: 4321 }));
    } finally {
      previous.timeout === undefined ? delete process.env.LLM_TIMEOUT_MS : process.env.LLM_TIMEOUT_MS = previous.timeout;
      previous.retries === undefined ? delete process.env.LLM_MAX_RETRIES : process.env.LLM_MAX_RETRIES = previous.retries;
      previous.delay === undefined ? delete process.env.LLM_MAX_RETRY_DELAY_MS : process.env.LLM_MAX_RETRY_DELAY_MS = previous.delay;
    }
  });

  it("falls back to safe bounded retry settings for invalid configuration", () => {
    const previous = { timeout: process.env.LLM_TIMEOUT_MS, retries: process.env.LLM_MAX_RETRIES, delay: process.env.LLM_MAX_RETRY_DELAY_MS };
    process.env.LLM_TIMEOUT_MS = "-1"; process.env.LLM_MAX_RETRIES = "99"; process.env.LLM_MAX_RETRY_DELAY_MS = "not-a-number";
    try {
      const service = new PiModelsService();
      const spy = vi.spyOn(service.models, "streamSimple").mockReturnValue({ result: () => new Promise(() => {}) } as any);
      service.stream(service.model, { messages: [] });
      expect(spy).toHaveBeenCalledWith(service.model, { messages: [] }, expect.objectContaining({ timeoutMs: 180_000, maxRetries: 2, maxRetryDelayMs: 30_000 }));
    } finally {
      previous.timeout === undefined ? delete process.env.LLM_TIMEOUT_MS : process.env.LLM_TIMEOUT_MS = previous.timeout;
      previous.retries === undefined ? delete process.env.LLM_MAX_RETRIES : process.env.LLM_MAX_RETRIES = previous.retries;
      previous.delay === undefined ? delete process.env.LLM_MAX_RETRY_DELAY_MS : process.env.LLM_MAX_RETRY_DELAY_MS = previous.delay;
    }
  });

  it("rejects a structured response that never calls the required submission tool", async () => {
    const { faux, models } = fixture();
    faux.setResponses([fauxAssistantMessage([fauxText("not a structured submission")])]);
    const service = Object.create(PiModelsService.prototype) as PiModelsService & { model: unknown; stream: unknown };
    Object.defineProperties(service, {
      model: { value: faux.getModel() },
      stream: { value: models.streamSimple.bind(models) },
      timedOutSessions: { value: new Set<string>() },
    });
    await expect(service.runStructuredAgent("test", "submit", "submit_result", Type.Object({ value: Type.String() }))).rejects.toThrow("Agent 未调用 submit_result");
  });

  it("maps provider failure classes to distinct persisted run codes", () => {
    const runtime = Object.create(AgentRuntimeService.prototype) as any;
    expect(runtime.runErrorCode(new Error("request timed out"))).toBe("PROVIDER_TIMEOUT");
    expect(runtime.runErrorCode(new Error("HTTP 429 rate limit"))).toBe("PROVIDER_RATE_LIMITED");
    expect(runtime.runErrorCode(new Error("HTTP 401 unauthorized"))).toBe("PROVIDER_AUTH");
    expect(runtime.runErrorCode(new Error("invalid json response"))).toBe("PROVIDER_INVALID_RESPONSE");
    expect(runtime.runErrorCode(new Error("AbortError"))).toBe("ABORTED");
    expect(runtime.runErrorCode(new Error("AGENT_MAX_TOOL_TURNS"))).toBe("MAX_TOOL_TURNS");
  });

  it("retries a real OpenAI-compatible 429 response only within the configured cap", async () => {
    let calls = 0;
    const server = createServer((_request, response) => {
      calls += 1;
      if (calls === 1) {
        response.writeHead(429, { "content-type": "application/json", "retry-after": "0" });
        response.end(JSON.stringify({ error: { message: "rate limited", type: "rate_limit_error" } }));
        return;
      }
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(`data: ${JSON.stringify({ id: "chatcmpl-test", object: "chat.completion.chunk", created: 1, model: "mock", choices: [{ index: 0, delta: { role: "assistant", content: "retry succeeded" }, finish_reason: null }] })}\n\n`);
      response.write(`data: ${JSON.stringify({ id: "chatcmpl-test", object: "chat.completion.chunk", created: 1, model: "mock", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 2, completion_tokens: 2, total_tokens: 4 } })}\n\n`);
      response.end("data: [DONE]\n\n");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("mock server did not bind");
    const previous = { base: process.env.LLM_BASE_URL, key: process.env.LLM_API_KEY, retries: process.env.LLM_MAX_RETRIES, delay: process.env.LLM_MAX_RETRY_DELAY_MS };
    process.env.LLM_BASE_URL = `http://127.0.0.1:${address.port}/v1`;
    process.env.LLM_API_KEY = "test-only-key";
    process.env.LLM_MAX_RETRIES = "1";
    process.env.LLM_MAX_RETRY_DELAY_MS = "100";
    try {
      await expect(new PiModelsService().runAgentText("test", "hello")).resolves.toBe("retry succeeded");
      expect(calls).toBe(2);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      previous.base === undefined ? delete process.env.LLM_BASE_URL : process.env.LLM_BASE_URL = previous.base;
      previous.key === undefined ? delete process.env.LLM_API_KEY : process.env.LLM_API_KEY = previous.key;
      previous.retries === undefined ? delete process.env.LLM_MAX_RETRIES : process.env.LLM_MAX_RETRIES = previous.retries;
      previous.delay === undefined ? delete process.env.LLM_MAX_RETRY_DELAY_MS : process.env.LLM_MAX_RETRY_DELAY_MS = previous.delay;
    }
  });

  it("bounds a stalled provider request with a classified timeout", async () => {
    const server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(": connected\n\n");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("mock server did not bind");
    const previous = { base: process.env.LLM_BASE_URL, key: process.env.LLM_API_KEY, timeout: process.env.LLM_TIMEOUT_MS, retries: process.env.LLM_MAX_RETRIES };
    process.env.LLM_BASE_URL = `http://127.0.0.1:${address.port}/v1`;
    process.env.LLM_API_KEY = "test-only-key";
    process.env.LLM_TIMEOUT_MS = "50";
    process.env.LLM_MAX_RETRIES = "0";
    try {
      const failure = await new PiModelsService().runAgentText("test", "hello").then(() => undefined, (error: unknown) => error);
      expect(safeErrorMeta(failure).errorCode).toBe("TIMEOUT");
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      previous.base === undefined ? delete process.env.LLM_BASE_URL : process.env.LLM_BASE_URL = previous.base;
      previous.key === undefined ? delete process.env.LLM_API_KEY : process.env.LLM_API_KEY = previous.key;
      previous.timeout === undefined ? delete process.env.LLM_TIMEOUT_MS : process.env.LLM_TIMEOUT_MS = previous.timeout;
      previous.retries === undefined ? delete process.env.LLM_MAX_RETRIES : process.env.LLM_MAX_RETRIES = previous.retries;
    }
  });

  it("streams text deltas and awaits the agent_end persistence barrier", async () => {
    const { faux, models } = fixture();
    faux.setResponses([fauxAssistantMessage([fauxText("你好，世界")])]);
    const events: string[] = []; let text = ""; let persisted = false;
    const agent = new Agent({ initialState: { systemPrompt: "test", model: faux.getModel(), thinkingLevel: "off", tools: [], messages: [] }, streamFn: models.streamSimple.bind(models) });
    agent.subscribe(async (event) => {
      events.push(event.type);
      if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") text += event.assistantMessageEvent.delta;
      if (event.type === "agent_end") { await new Promise((resolve) => setTimeout(resolve, 5)); persisted = true; }
    });
    await agent.prompt("hello");
    expect(text).toBe("你好，世界");
    expect(events.at(-1)).toBe("agent_end");
    expect(persisted).toBe(true);
  });

  it("executes a validated tool and can restore an existing transcript", async () => {
    const { faux, models } = fixture();
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("lookup", { query: "负责人" })], { stopReason: "toolUse" }),
      fauxAssistantMessage([fauxText("负责人是 Alice")]),
    ]);
    const execute = vi.fn(async () => ({ content: [{ type: "text" as const, text: "Alice" }], details: {} }));
    const agent = new Agent({ initialState: {
      systemPrompt: "test", model: faux.getModel(), thinkingLevel: "off",
      tools: [{ name: "lookup", label: "lookup", description: "lookup", parameters: Type.Object({ query: Type.String() }), execute }],
      messages: [{ role: "user", content: "之前的问题", timestamp: Date.now() }],
    }, streamFn: models.streamSimple.bind(models) });
    await agent.prompt("现在负责人是谁？");
    expect(execute).toHaveBeenCalledOnce();
    expect(agent.state.messages.some((message) => message.role === "toolResult")).toBe(true);
    expect(agent.state.messages.some((message) => message.role === "user" && message.content === "之前的问题")).toBe(true);
  });

  it("surfaces tool failures as error tool results", async () => {
    const { faux, models } = fixture();
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("explode", {})], { stopReason: "toolUse" }),
      fauxAssistantMessage([fauxText("工具执行失败")]),
    ]);
    const failed: boolean[] = [];
    const agent = new Agent({ initialState: {
      systemPrompt: "test", model: faux.getModel(), thinkingLevel: "off",
      tools: [{ name: "explode", label: "explode", description: "explode", parameters: Type.Object({}), execute: async () => { throw new Error("boom"); } }], messages: [],
    }, streamFn: models.streamSimple.bind(models) });
    agent.subscribe((event) => { if (event.type === "tool_execution_end") failed.push(event.isError); });
    await agent.prompt("run");
    expect(failed).toEqual([true]);
  });

  it("honors a maximum tool-turn finish policy", async () => {
    const { faux, models } = fixture();
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("again", {})], { stopReason: "toolUse" }),
      fauxAssistantMessage([fauxToolCall("again", {})], { stopReason: "toolUse" }),
    ]);
    let turns = 0;
    const agent = new Agent({ initialState: {
      systemPrompt: "test", model: faux.getModel(), thinkingLevel: "off",
      tools: [{ name: "again", label: "again", description: "again", parameters: Type.Object({}), execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }) }], messages: [],
    }, streamFn: models.streamSimple.bind(models), finishTurn: ({ toolResults }) => {
      if (toolResults.length && ++turns >= 1) return { action: "end" };
    }});
    await agent.prompt("loop");
    expect(faux.state.callCount).toBe(1);
  });

  it("aborts an in-flight stream", async () => {
    const { faux, models } = fixture(1);
    faux.setResponses([fauxAssistantMessage([fauxText("这是一段会被中止的较长回答")])]);
    const agent = new Agent({ initialState: { systemPrompt: "test", model: faux.getModel(), thinkingLevel: "off", tools: [], messages: [] }, streamFn: models.streamSimple.bind(models) });
    const promise = agent.prompt("start");
    setTimeout(() => agent.abort(), 5);
    await promise;
    expect(agent.state.errorMessage?.toLowerCase()).toContain("abort");
  });
});
