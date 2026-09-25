export interface AgentRunInput {
  userId: string;
  conversationId: string;
  content: string;
  webSearch: boolean;
}

export abstract class AgentRuntimePort {
  abstract run(input: AgentRunInput, emit: (event: unknown) => void): Promise<void>;
  abstract abort(runId: string, userId: string): Promise<{ ok: boolean }>;
  abstract abortConversation(conversationId: string, userId: string): Promise<void>;
}

export const AGENT_RUNTIME_PORT = Symbol("AGENT_RUNTIME_PORT");
