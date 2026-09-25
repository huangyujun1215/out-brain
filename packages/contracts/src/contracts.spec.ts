import { describe, expect, it } from "vitest";
import { meetingAnalysisSchema, presentationSchema } from "./index.js";

describe("domain contracts", () => {
  it("rejects a meeting risk without source evidence", () => {
    expect(() => meetingAnalysisSchema.parse({ sourceFileIds: [], title: "周会", summary: "", participants: [], time: null, location: null, topics: [], decisions: [], commitments: [], insights: [], risks: [{ severity: "HIGH", description: "无人负责", evidence: [], todo: { title: "确定负责人", description: "", owner: "待确认", dueAt: null } }] })).toThrow();
  });

  it("accepts editable slide JSON", () => {
    expect(presentationSchema.parse({ title: "测试", slides: [{ id: "s1", title: "封面", notes: "", elements: [{ id: "e1", type: "text", text: "标题", x: 1, y: 1, w: 6, h: 1, fontSize: 28, color: "111827", bold: true }] }] }).slides).toHaveLength(1);
  });
});
