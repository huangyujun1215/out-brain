import { Injectable, ServiceUnavailableException } from "@nestjs/common";

export interface SearchResult { title: string; url: string; snippet: string; retrievedAt: string }

@Injectable()
export class SearchService {
  available() { return process.env.SEARCH_ENABLED === "true" && (process.env.SEARCH_PROVIDER === "mock" || Boolean(process.env.SEARCH_API_KEY)); }

  async search(query: string): Promise<SearchResult[]> {
    if (!this.available()) throw new ServiceUnavailableException("联网搜索尚未配置");
    const provider = process.env.SEARCH_PROVIDER ?? "tavily";
    if (provider === "mock") return [{ title: `Mock 搜索结果：${query}`, url: `https://example.test/search?q=${encodeURIComponent(query)}`, snippet: "用于本地验收的确定性搜索结果。", retrievedAt: new Date().toISOString() }];
    if (provider !== "tavily") throw new ServiceUnavailableException(`暂不支持搜索服务：${provider}`);
    const response = await fetch("https://api.tavily.com/search", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ api_key: process.env.SEARCH_API_KEY, query, max_results: 6, search_depth: "advanced" }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) throw new ServiceUnavailableException("联网搜索暂时不可用");
    const data = await response.json() as { results?: Array<{ title?: string; url?: string; content?: string }> };
    const retrievedAt = new Date().toISOString();
    return (data.results ?? []).filter((r) => this.isSafeUrl(r.url)).map((r) => ({ title: r.title ?? r.url!, url: r.url!, snippet: r.content ?? "", retrievedAt }));
  }
  private isSafeUrl(value: unknown): value is string {
    if (typeof value !== "string") return false;
    try { const url = new URL(value); return url.protocol === "http:" || url.protocol === "https:"; }
    catch { return false; }
  }
}
