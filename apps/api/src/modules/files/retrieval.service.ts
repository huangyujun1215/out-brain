import { Injectable } from "@nestjs/common";
import { PrismaService } from "../../infra/prisma.service.js";
import { EmbeddingService } from "./embedding.service.js";
import { buildBm25Index, reciprocalRankFuse, searchBm25, type Bm25Index } from "./retrieval-ranking.js";

export interface RetrievedChunk { fileId: string; fileName: string; pageStart: number; pageEnd: number; content: string; score: number }

@Injectable()
export class RetrievalService {
  private readonly lexicalCache = new Map<string, { signature: string; index: Bm25Index<any> }>();
  constructor(private readonly prisma: PrismaService, private readonly embeddings: EmbeddingService) {}

  async search(userId: string, conversationId: string, query: string, limit = 8): Promise<RetrievedChunk[]> {
    const chunks = await this.prisma.documentChunk.findMany({
      where: { file: { userId, conversationId, status: "READY", kind: "PDF" } },
      include: { file: { select: { id: true, originalName: true } } },
    });
    const documents = chunks.map((chunk) => ({ id: chunk.id, fileId: chunk.file.id, fileName: chunk.file.originalName, pageStart: chunk.pageStart, pageEnd: chunk.pageEnd, content: chunk.content }));
    const signature = documents.map((document) => document.id).join(":");
    let cache = this.lexicalCache.get(conversationId);
    if (!cache || cache.signature !== signature) {
      cache = { signature, index: buildBm25Index(documents) };
      this.lexicalCache.set(conversationId, cache);
      if (this.lexicalCache.size > 100) this.lexicalCache.delete(this.lexicalCache.keys().next().value!);
    }
    const lexical = searchBm25(cache.index, query);
    if (!this.embeddings.available()) return lexical.slice(0, limit);
    try {
      const [embedding] = await this.embeddings.embed([query]);
      const vector = `[${embedding.join(",")}]`;
      const semantic = await this.prisma.$queryRaw<Array<{ fileId: string; fileName: string; pageStart: number; pageEnd: number; content: string; score: number }>>`
        SELECT c."fileId", f."originalName" AS "fileName", c."pageStart", c."pageEnd", c."content",
               1 - (c."embedding" <=> ${vector}::vector) AS score
        FROM "DocumentChunk" c JOIN "FileAsset" f ON f.id = c."fileId"
        WHERE f."userId" = ${userId} AND f."conversationId" = ${conversationId}
          AND f.status = 'READY' AND f.kind = 'PDF' AND c.embedding IS NOT NULL
        ORDER BY c.embedding <=> ${vector}::vector LIMIT ${limit * 2}`;
      return reciprocalRankFuse([lexical.slice(0, limit * 2), semantic], (item) => `${item.fileId}:${item.pageStart}:${item.content.slice(0, 30)}`)
        .map(({ value, score }) => ({ ...value, score })).slice(0, limit);
    } catch { return lexical.slice(0, limit); }
  }
}
