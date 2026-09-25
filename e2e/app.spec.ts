import { expect, test } from "@playwright/test";
import { execFileSync } from "node:child_process";

function fixture<T>(action: string, input: unknown): T {
  const encoded = Buffer.from(JSON.stringify(input)).toString("base64url");
  return JSON.parse(execFileSync(process.execPath, ["e2e/fixture.cjs", action, encoded], { cwd: process.cwd(), encoding: "utf8", env: process.env }));
}

const username = `pw_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

function textPdf(text: string) {
  const stream = `BT /F1 12 Tf 72 720 Td (${text.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)")}) Tj ET`;
  const objects = ["", "<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [4 0 R] /Count 1 >>", "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>", "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents 5 0 R >>", `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`];
  let output = "%PDF-1.4\n"; const offsets = [0];
  for (let id=1;id<objects.length;id++){offsets[id]=Buffer.byteLength(output);output+=`${id} 0 obj\n${objects[id]}\nendobj\n`;}
  const xref=Buffer.byteLength(output);output+=`xref\n0 ${objects.length}\n0000000000 65535 f \n`;
  for(let id=1;id<objects.length;id++)output+=`${String(offsets[id]).padStart(10,"0")} 00000 n \n`;
  return Buffer.from(`${output}trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
}

test("register, create both conversation modes, navigate and logout", async ({ page }) => {
  await page.goto("/login");
  await page.getByRole("button", { name: "没有账号？立即注册" }).click();
  await page.getByLabel("用户名").fill(username);
  await page.getByLabel("密码").fill("Playwright123!");
  await page.getByRole("button", { name: "注册并登录" }).click();
  await expect(page.getByRole("heading", { name: "今天想一起推进什么？" })).toBeVisible();

  await page.getByRole("button", { name: /普通对话/ }).click();
  await expect(page).toHaveURL(/\/chat\//);
  await expect(page.getByText("普通对话", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "新建会话" }).click();
  await page.getByRole("button", { name: /会议分析/ }).click();
  await expect(page.getByText("会议分析", { exact: true }).first()).toBeVisible();

  await page.getByTitle("退出").click();
  await expect(page).toHaveURL(/\/login$/);
});

test("an unauthenticated visitor is redirected to login", async ({ browser }) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto("/todos");
  await expect(page).toHaveURL(/\/login$/);
  await context.close();
});

test("critical artifact UIs support todo updates, memory edits and PPT versioning", async ({ page }) => {
  const suffix = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const account = `artifact_${suffix}`;
  let userId = "";
  try {
    await page.goto("/login");
    await page.getByRole("button", { name: "没有账号？立即注册" }).click();
    await page.getByLabel("用户名").fill(account);
    await page.getByLabel("密码").fill("Playwright123!");
    await page.getByRole("button", { name: "注册并登录" }).click();
    await expect(page.getByRole("heading", { name: "今天想一起推进什么？" })).toBeVisible();
    const user = await page.evaluate(() => JSON.parse(localStorage.getItem("nbboss-user") ?? "null"));
    userId = user.id;
    await page.getByRole("button", { name: /会议分析/ }).click();
    await expect(page).toHaveURL(/\/chat\/[0-9a-f-]+$/);
    const conversationId = new URL(page.url()).pathname.split("/").at(-1)!;

    const seeded = fixture<{ todoId: string; presentationId: string }>("seed-artifacts", { userId, conversationId, suffix });

    await page.getByRole("button", { name: "待办中心" }).click();
    const todoRow = page.locator(".todo-row").filter({ hasText: "确认截止时间" });
    await expect(todoRow).toBeVisible();
    await todoRow.locator("select").selectOption("IN_PROGRESS");
    await expect(todoRow.locator("select")).toHaveValue("IN_PROGRESS");

    await page.getByRole("button", { name: "记忆管理" }).click();
    await expect(page.getByText("项目地点")).toBeVisible();
    await expect(page.getByText("上海")).toBeVisible();
    await expect(page.getByText("杭州")).toBeVisible();
    page.once("dialog", (dialog) => dialog.accept("苏州"));
    await page.getByTitle("编辑记忆").click();
    await expect(page.getByText("苏州")).toBeVisible();

    await page.goto(`/presentations/${seeded.presentationId}`);
    await expect(page.getByRole("heading", { name: "项目汇报" })).toBeVisible();
    const canvasText = page.locator(".slide-canvas textarea");
    await canvasText.click();
    await canvasText.fill("修改后标题");
    await page.getByRole("button", { name: /保存新版本/ }).click();
    await expect(page.locator(".ppt-toolbar").getByText("版本 2")).toBeVisible();
  } finally {
    if (userId) fixture("cleanup-user", { userId });
  }
});

test("chat UI uploads a PDF and renders normalized tool lifecycle events", async ({ page }) => {
  const suffix = `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const account = `flow_${suffix}`;
  let userId = "";
  try {
    await page.goto("/login");
    await page.getByRole("button", { name: "没有账号？立即注册" }).click();
    await page.getByLabel("用户名").fill(account);
    await page.getByLabel("密码").fill("Playwright123!");
    await page.getByRole("button", { name: "注册并登录" }).click();
    await expect(page.getByRole("heading", { name: "今天想一起推进什么？" })).toBeVisible();
    const user = await page.evaluate(() => JSON.parse(localStorage.getItem("nbboss-user") ?? "null"));
    userId = user.id;
    await page.getByRole("button", { name: /普通对话/ }).click();
    await page.locator('input[type="file"]').setInputFiles({ name: "knowledge.pdf", mimeType: "application/pdf", buffer: textPdf("Project owner Alice deadline October 15 2026") });
    await expect(page.getByText("knowledge.pdf · READY")).toBeVisible({ timeout: 15_000 });

    await page.route("**/api/conversations/*/messages", async (route) => {
      const frames = [
        { type: "run.started", runId: "run-ui" },
        { type: "tool.started", runId: "run-ui", toolCallId: "tool-ui", toolName: "retrieve_documents" },
        { type: "message.delta", runId: "run-ui", delta: "依据文件回答。" },
        { type: "tool.completed", runId: "run-ui", toolCallId: "tool-ui", toolName: "retrieve_documents", isError: false },
        { type: "message.completed", runId: "run-ui", messageId: "message-ui", content: "依据文件回答。" },
        { type: "run.completed", runId: "run-ui" },
      ].map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");
      await route.fulfill({ status: 200, contentType: "text/event-stream", body: frames });
    });
    await page.getByPlaceholder("输入消息，Shift + Enter 换行").fill("项目负责人是谁？");
    await page.getByPlaceholder("输入消息，Shift + Enter 换行").press("Enter");
    await expect(page.getByText("检索会话文件")).toBeVisible();
    await expect(page.getByText("已完成")).toBeVisible();
  } finally {
    if (userId) fixture("cleanup-user", { userId });
  }
});

test("1100px breakpoint keeps artifacts and PPT editing controls reachable", async ({ page }) => {
  await page.setViewportSize({ width: 1050, height: 800 });
  const account = `wide_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
  let userId = "";
  try {
    await page.goto("/login");
    await page.getByRole("button", { name: "没有账号？立即注册" }).click();
    await page.getByLabel("用户名").fill(account);
    await page.getByLabel("密码").fill("Playwright123!");
    await page.getByRole("button", { name: "注册并登录" }).click();
    await expect(page.getByRole("heading", { name: "今天想一起推进什么？" })).toBeVisible();
    const user = await page.evaluate(() => JSON.parse(localStorage.getItem("nbboss-user") ?? "null"));
    userId = user.id;
    await page.getByRole("button", { name: /普通对话/ }).click();
    await expect(page).toHaveURL(/\/chat\/[0-9a-f-]+$/);
    const conversationId = new URL(page.url()).pathname.split("/").at(-1)!;
    await expect(page.getByRole("button", { name: "显示产物" })).toBeVisible();
    await page.getByRole("button", { name: "显示产物" }).click();
    await expect(page.locator(".artifact-pane")).toBeVisible();

    const seeded = fixture<{ presentationId: string }>("seed-artifacts", { userId, conversationId, suffix: account });
    await page.goto(`/chat/${conversationId}`);
    await expect(page.getByText("联网来源", { exact: true })).toBeVisible();
    await expect(page.getByRole("link", { name: "项目动态来源" })).toHaveAttribute("href", "https://example.test/project");
    await page.goto(`/presentations/${seeded.presentationId}`);
    await page.locator(".slide-canvas textarea").click();
    await expect(page.getByRole("heading", { name: "元素属性" })).toBeVisible();
  } finally {
    if (userId) fixture("cleanup-user", { userId });
  }
});
