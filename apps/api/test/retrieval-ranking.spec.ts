import { describe, expect, it } from "vitest";
import { buildBm25Index, reciprocalRankFuse, searchBm25, tokenize } from "../src/modules/files/retrieval-ranking.js";

describe("retrieval ranking", () => {
  it("tokenizes Chinese into characters and bigrams", () => {
    expect(tokenize("项目负责人 Alice")).toEqual(expect.arrayContaining(["项目", "负责", "alice"]));
  });

  it("ranks matching evidence above unrelated text with BM25", () => {
    const index = buildBm25Index([{ id: "owner", content: "项目负责人是 Alice" }, { id: "weather", content: "今天上海天气晴朗" }]);
    expect(searchBm25(index, "负责人是谁")[0]?.id).toBe("owner");
  });

  it("uses reciprocal rank fusion across lexical and semantic lists", () => {
    const a = { id: "a" }, b = { id: "b" }, c = { id: "c" };
    const result = reciprocalRankFuse([[a, b], [b, c]], (item) => item.id);
    expect(result[0].value.id).toBe("b");
  });
});
