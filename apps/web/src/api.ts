const API = import.meta.env.VITE_API_URL ?? "/api";

export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(`${API}${path}`, { ...options, credentials: "include", headers: { ...(options.body instanceof FormData ? {} : { "content-type": "application/json" }), ...options.headers } });
  if (response.status === 401 && path !== "/auth/refresh") {
    const refreshed = await fetch(`${API}/auth/refresh`, { method: "POST", credentials: "include" });
    if (refreshed.ok) return api<T>(path, options);
    localStorage.removeItem("nbboss-user");
    if (location.pathname !== "/login") location.assign("/login");
  }
  if (!response.ok) {
    const error = await response.json().catch(() => ({ message: response.statusText }));
    const message = Array.isArray(error.message) ? error.message.join("，") : error.message ?? "请求失败";
    throw new Error(error.traceId ? `${message}（参考编号：${error.traceId}）` : message);
  }
  return response.status === 204 ? undefined as T : response.json();
}

export async function streamMessage(conversationId: string, content: string, webSearch: boolean, onEvent: (event: any) => void, signal: AbortSignal) {
  const response = await fetch(`${API}/conversations/${conversationId}/messages`, { method: "POST", credentials: "include", headers: { "content-type": "application/json" }, body: JSON.stringify({ content, webSearch }), signal });
  if (!response.ok || !response.body) throw new Error("无法建立对话流");
  const reader = response.body.getReader(); const decoder = new TextDecoder(); let buffer = "";
  while (true) {
    const { value, done } = await reader.read(); if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const frames = buffer.split("\n\n"); buffer = frames.pop() ?? "";
    for (const frame of frames) if (frame.startsWith("data: ")) onEvent(JSON.parse(frame.slice(6)));
  }
}
