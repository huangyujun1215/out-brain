export function tokenize(input: string): string[] {
  const normalized = input.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ");
  const words = normalized.split(/\s+/).filter(Boolean);
  const chinese = [...normalized.replace(/[^\p{Script=Han}]/gu, "")];
  const bigrams = chinese.slice(0, -1).map((char, index) => char + chinese[index + 1]);
  return [...words, ...chinese, ...bigrams];
}

export interface Bm25Index<T> {
  documents: T[];
  terms: string[][];
  averageLength: number;
  documentFrequency: Map<string, number>;
}

export function buildBm25Index<T extends { content: string }>(documents: T[]): Bm25Index<T> {
  const terms = documents.map((document) => tokenize(document.content));
  const averageLength = terms.reduce((sum, value) => sum + value.length, 0) / Math.max(1, terms.length);
  const documentFrequency = new Map<string, number>();
  for (const documentTerms of terms) for (const term of new Set(documentTerms)) documentFrequency.set(term, (documentFrequency.get(term) ?? 0) + 1);
  return { documents, terms, averageLength, documentFrequency };
}

export function searchBm25<T extends { content: string }>(index: Bm25Index<T>, query: string): Array<T & { score: number }> {
  const queryTerms = tokenize(query);
  return index.documents.map((document, documentIndex) => {
    const terms = index.terms[documentIndex];
    const frequencies = new Map<string, number>();
    for (const term of terms) frequencies.set(term, (frequencies.get(term) ?? 0) + 1);
    let score = 0;
    for (const term of queryTerms) {
      const frequency = frequencies.get(term) ?? 0;
      if (!frequency) continue;
      const documentFrequency = index.documentFrequency.get(term) ?? 0;
      const inverseFrequency = Math.log(1 + (index.documents.length - documentFrequency + 0.5) / (documentFrequency + 0.5));
      score += inverseFrequency * ((frequency * 2.2) / (frequency + 1.2 * (0.25 + 0.75 * terms.length / Math.max(1, index.averageLength))));
    }
    return { ...document, score };
  }).filter((document) => document.score > 0).sort((a, b) => b.score - a.score);
}

export function reciprocalRankFuse<T>(lists: T[][], key: (value: T) => string, offset = 60): Array<{ value: T; score: number }> {
  const values = new Map<string, T>();
  const scores = new Map<string, number>();
  for (const list of lists) list.forEach((value, rank) => {
    const id = key(value);
    values.set(id, value);
    scores.set(id, (scores.get(id) ?? 0) + 1 / (offset + rank + 1));
  });
  return [...values].map(([id, value]) => ({ value, score: scores.get(id) ?? 0 })).sort((a, b) => b.score - a.score);
}
