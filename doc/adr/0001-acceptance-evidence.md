# ADR-0001 验收证据矩阵

- 验证日期：2026-09-25
- 架构基线：[`0001-nbboss-ai-brain-architecture.md`](0001-nbboss-ai-brain-architecture.md)
- 原则：本文件记录可重复验证的证据，不保存 Cookie、Token、API Key、提示词正文或用户文件正文。

## 自动化命令

```bash
pnpm -r typecheck
pnpm -r test
pnpm test:integration
pnpm test:e2e
docker-compose up -d --build
```

集成测试需要本机 PostgreSQL、Redis、API 和 Worker 已启动。外部 LLM 实测使用本机 `.env`，密钥不进入仓库。

## P0 验收矩阵

| 场景 | 当前证据 |
|---|---|
| A1 两用户注册 | `api.integration.spec.ts` 创建多个独立账号；Playwright 覆盖注册和登录 |
| A2 多轮流式及中止 | Pi Faux 契约测试覆盖增量和 abort；最新镜像真实 Provider 两轮分别约 2.5 秒、3.9 秒完成，第三轮服务端 `abort()` 后 23 ms 结束并收到 `run.aborted`；既有首个文本 delta 实测为 1017 ms |
| A3 文本及工具 SSE | Pi 契约测试覆盖消息/工具事件；Playwright 验证稳定的 `tool.started/tool.completed` 在 UI 呈现 |
| A4 历史恢复 | `ConversationsService` 从 PostgreSQL 返回可见消息；真实两轮对话重新读取 5 条已完成/用户消息；搜索来源集成测试验证恢复 |
| A5 租户隔离 | 集成测试覆盖 Conversation/File/Meeting/Todo/Memory/PPT IDOR；数据库触发器拒绝跨用户 AgentRun/FileAsset/Todo 关联 |
| B1-B2 PDF 上传/状态 | HTTP 集成测试生成并上传真实文本 PDF，等待 Worker 从 PROCESSING 到 READY |
| B3-B4 页码及多 PDF | BM25 集成测试同时命中 `alpha.pdf` 第 2 页和 `budget.pdf` 第 1 页；真实 Pi Agent 调用检索工具并在答案中给出两个文件名和页码 |
| B5 BM25 降级 | 集成环境不配置 Embedding，完整 PDF 检索链通过 |
| B6 无依据 | BM25 对不存在词返回空；工具和系统提示强制“资料中没有相关信息”并将常识置于独立标题 |
| B7 生命周期 | HTTP 删除后文件、页面、分块均消失且下载 404；容器重启前后原文件 SHA-256 相同，删除后 Volume 路径不可见 |
| C1-C5 会议到待办 | 最新镜像真实并发上传双 TXT，自动防抖后仅执行 1 次分析，得到 1 场会议、2 个有效证据风险和 2 个待办；集成测试验证伪造证据被移除、缺失字段策略和事务落库 |
| C6 待办管理 | Playwright 覆盖四态中的状态更新；API 支持标题、说明、责任人、截止时间编辑及多条件筛选 |
| C7 SMTP 关闭 | 最新双 TXT 真实会议流程 READY，仅产生 1 条 `DISABLED` 邮件记录且不影响 2 个风险/待办 |
| C8 SMTP Mock/重试 | Adapter 测试覆盖 Mock SENT、关闭状态以及真实传输适配器三次有限重试和错误脱敏 |
| C9 缓存/强制重跑 | 集成测试验证相同 TXT 快照重复任务不再次调用模型/发信，新 TXT 时旧文件使用 `[缓存分析]`、新文件使用原文，`force=true` 不使用缓存；同批 TXT 自动任务使用 BullMQ 延迟去重 |
| D1 异步抽取 | Agent/会议完成只提交 BullMQ 任务；真实 PostgreSQL 竞态测试在模型抽取期间删除来源，确认不会生成孤儿记忆 |
| D2 按需检索 | Pi Agent 实测记忆问题调用 `retrieve_memory`，普通 `2+2` 不暴露/调用记忆工具 |
| D3 冲突历史 | 真实 PostgreSQL + Redis 集成测试覆盖并发、迟到旧任务、唯一当前值、单链历史和用户修正优先 |
| D4-D5 管理/隔离 | Playwright 覆盖查看、历史和编辑；集成测试覆盖跨用户修改/删除 404 |
| E1-E3 手动搜索 | Search Adapter 测试覆盖关闭、Mock 和危险 URL 过滤；Agent 只有本轮 `webSearch=true` 且服务可用时才获得工具 |
| E4 搜索恢复 | 真实 Pi Agent + Mock Search 集成测试持久化两个 SearchRun；会话详情返回链接、查询及时间；Playwright 验证历史来源卡片 |
| F1 生成 | 最新镜像真实 Provider 基于当前会话生成指定 4 页；默认/中英文页数规则有契约测试，生成在 BullMQ 异步执行 |
| F2-F4 预览/导出/编辑 | Playwright 覆盖逐页画布、文字编辑和属性面板；真实下载为 ZIP/PPTX 且 Slide JSON 元素均为 text/shape |
| F5-F6 版本 | 真实 PostgreSQL/Redis 并发保存产生不可变版本 1、2；Playwright 保存并切换版本 |
| F7 非整页图片 | 导出由 PptxGenJS 按文本和 Shape 元素创建，真实文件以 PPTX ZIP 格式打开，未使用全页截图导出 |

## 性能与可靠性

| 目标 | 证据 |
|---|---|
| 页面操作 < 1 秒 | 10 用户并发注册/创建/读取集成场景总耗时约 0.5 秒（本机实测，以每次运行输出为准） |
| 对话 5 秒内开始流式 | 真实 Provider 实测首个文本 delta 1017 ms |
| 上传立即显示状态 | API 创建时返回 PROCESSING；Playwright 等待并观察 READY |
| 200 页 PDF < 60 秒 | 真实 200 页文本 PDF Worker 集成测试约 0.4 秒（本机实测） |
| PPT < 3 分钟 | 最新镜像真实 4 页任务约 113 秒完成；状态进度到 100 |
| 10 并发用户 | 集成测试并行完成 10 个独立账号的创建/读取核心本地流程 |
| Provider 故障 | 真实本地 OpenAI-compatible Mock 覆盖 429 有界重试、流式停滞硬超时；畸形结构、无配置和日志脱敏有契约测试 |

## 2026-09-25 最终复验记录

- `pnpm -r typecheck`：全部工作区通过；
- `pnpm -r test`：Contracts 4/4，API 单元与契约 38/38，通过；
- `pnpm test:integration`：10/10，通过，其中包括来源删除期间记忆抽取的真实数据库竞态；
- `pnpm test:e2e`：5/5，通过；
- Docker Compose 全量重建后 API 为 healthy，API 与 Worker 使用同一镜像 digest；
- 真实 GLM Provider 对无依据 PDF 问题调用 `retrieve_documents`，输出精确短语“资料中没有相关信息”以及独立的 `### 常识补充`，运行正常完成；
- 真实 GLM Provider 在最新镜像完成两轮上下文对话和一次服务端中止；会话删除后，随后完成的记忆任务没有遗留来源事实；
- 真实并发双 TXT 上传只产生一个自动分析任务、一场会议、两个有效风险、两个待办和一条邮件状态；Provider 返回的业务日期先规范化再进入严格领域 Schema；
- 最新镜像真实生成 4 页 PPT，约 113 秒达到 `READY/100%`；所有元素均为可编辑 text/shape，颜色已规范化，下载文件为有效 PPTX ZIP（约 106 KB）；
- 完整复验结束后 BullMQ `active=0`、`wait=0`、`delayed=0`、`failed=0`；API/Worker 最新容器日志无 error/warn；
- Worker 成功日志包含 `traceId`、不可逆用户标识、资源、job、状态、耗时和尝试次数。

## 安全与交付

- Argon2id、HttpOnly Access/Refresh Cookie、Refresh Rotation/Revocation 均有实现和集成测试。
- 上传覆盖 MIME、扩展名、签名、UTF-8、大小和恶意文件名；磁盘名使用 UUID。
- `.env` 被忽略且权限为 `0600`；`.env.example` 不含真实凭据。
- API/Worker 使用同一已锁定 Pi Agent 运行时镜像；健康检查验证 PostgreSQL 与 Redis。
- 视觉检查覆盖 1440px 三栏会议页和 1050px PPT 属性编辑器；1050px 会话页通过按钮打开 Artifact 抽屉。

## 非验收范围

OCR、移动端专项适配、管理员、SSO、实时转写、复杂 PPT 动画/母版/图表编辑均按 ADR 明确排除。
