import { Injectable } from "@nestjs/common";

@Injectable()
export class EmbeddingService {
  available() { return Boolean(process.env.EMBEDDING_BASE_URL && process.env.EMBEDDING_API_KEY && process.env.EMBEDDING_MODEL); }

  async embed(input: string[]): Promise<number[][]> {
    if (!this.available()) return [];
    const base = process.env.EMBEDDING_BASE_URL!.replace(/\/$/, "");
    const response = await fetch(`${base}/embeddings`, {
      method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${process.env.EMBEDDING_API_KEY}` },
      body: JSON.stringify({ model: process.env.EMBEDDING_MODEL, input }), signal: AbortSignal.timeout(60_000),
    });
    if (!response.ok) throw new Error(`Embedding 服务错误：${response.status}`);
    const data = await response.json() as { data: Array<{ index: number; embedding: number[] }> };
    return data.data.sort((a, b) => a.index - b.index).map((item) => item.embedding);
  }
}
