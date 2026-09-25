const { PrismaClient } = require("../apps/api/node_modules/@prisma/client");

try { process.loadEnvFile(".env"); } catch { /* CI may inject variables. */ }

const prisma = new PrismaClient();
const [action, encoded = "e30="] = process.argv.slice(2);
const input = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));

async function main() {
  if (action === "seed-artifacts") {
    const { userId, conversationId, suffix } = input;
    const meeting = await prisma.meeting.create({ data: {
      conversationId, title: "项目周会", location: "杭州", analysis: {
        sourceFileIds: [], title: "项目周会", summary: "团队确认交付计划。", participants: ["王芳", "李四"], time: "2026-09-24", location: "杭州",
        topics: ["交付计划"], decisions: ["按期交付"], commitments: ["完成方案"], insights: ["需要跟踪责任人"], risks: [], grouping: "SAME_MEETING",
      },
    } });
    const risk = await prisma.risk.create({ data: { meetingId: meeting.id, severity: "MEDIUM", description: "截止时间待确认", evidence: [{ fileName: "meeting.txt", quote: "截止时间还没定" }] } });
    const todo = await prisma.todo.create({ data: { userId, meetingId: meeting.id, riskId: risk.id, title: "确认截止时间", description: "与团队确认方案截止时间", owner: "王芳", idempotencyKey: `pw-${suffix}` } });
    const entity = await prisma.memoryEntity.create({ data: { userId, type: "LOCATION", canonicalName: "项目地点" } });
    const oldFact = await prisma.memoryFact.create({ data: { entityId: entity.id, attribute: "城市", value: "上海", sourceType: "CONVERSATION", sourceId: conversationId } });
    const fact = await prisma.memoryFact.create({ data: { entityId: entity.id, attribute: "城市", value: "杭州", sourceType: "USER", sourceId: userId, userEdited: true } });
    await prisma.memoryFact.update({ where: { id: oldFact.id }, data: { supersededById: fact.id } });
    const presentation = await prisma.presentation.create({ data: { conversationId, title: "项目汇报", requestedPrompt: "测试", status: "READY", progress: 100 } });
    await prisma.presentationVersion.create({ data: { presentationId: presentation.id, version: 1, prompt: "测试", pptxPath: "/tmp/not-downloaded.pptx", slideJson: { title: "项目汇报", slides: [{ id: "s1", title: "首页", notes: "", elements: [{ id: "e1", type: "text", text: "初始标题", x: 1, y: 1, w: 6, h: 1, fontSize: 28, color: "111827", bold: true }] }] } } });
    const message = await prisma.message.create({ data: { conversationId, role: "ASSISTANT", content: "这是带联网来源的历史回答。" } });
    await prisma.searchRun.create({ data: { messageId: message.id, query: "项目动态", searchedAt: new Date(), sources: [{ title: "项目动态来源", url: "https://example.test/project", snippet: "测试来源", retrievedAt: new Date().toISOString() }] } });
    return { todoId: todo.id, presentationId: presentation.id };
  }
  if (action === "cleanup-user") {
    await prisma.user.deleteMany({ where: { id: input.userId } });
    return { ok: true };
  }
  throw new Error(`Unknown fixture action: ${action}`);
}

main().then((result) => process.stdout.write(JSON.stringify(result))).finally(() => prisma.$disconnect());
