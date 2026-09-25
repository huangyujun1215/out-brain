# NBBOSS AI 外脑

NBBOSS AI 外脑是一个面向内部员工的多用户 AI 工作台。项目基于 Node.js/TypeScript，使用 Pi Agent Runtime 统一承载多轮模型执行、工具调用和流式事件，并提供会话级 PDF RAG、会议风险闭环、长期记忆、联网搜索和可编辑 PPTX。

- 产品与架构基线：[`doc/adr/0001-nbboss-ai-brain-architecture.md`](doc/adr/0001-nbboss-ai-brain-architecture.md)
- 用户操作手册：[`doc/user-manual.md`](doc/user-manual.md)
- 验收证据：[`doc/adr/0001-acceptance-evidence.md`](doc/adr/0001-acceptance-evidence.md)
- HTTP/SSE API：[`doc/api.md`](doc/api.md)
- 数据模型：[`doc/data-model.md`](doc/data-model.md)
- 第三方许可证：[`doc/third-party-licenses.md`](doc/third-party-licenses.md)

## 1. 技术栈

| 层次 | 技术 |
|---|---|
| Web | Vue 3、TypeScript、Vite、Vue Router、Pinia、TanStack Query |
| API | Node.js 24、NestJS、REST、SSE |
| Agent | `@earendil-works/pi-agent-core@0.87.1` |
| Model | `@earendil-works/pi-ai@0.87.1`、OpenAI-compatible Provider |
| 数据库 | PostgreSQL 16、pgvector、Prisma |
| 缓存与任务 | Redis、BullMQ |
| 文档 | pdfjs-dist、PptxGenJS |
| 校验 | TypeBox、Zod |
| 测试 | Vitest、Supertest、Playwright |
| 部署 | Docker Compose、Nginx |

## 2. 仓库结构

```text
.
├── apps/
│   ├── api/                    # NestJS API、Worker、Prisma、Pi Agent Runtime
│   └── web/                    # Vue 3 桌面 Web
├── packages/
│   └── contracts/              # 前后端共享 Schema 与事件类型
├── demo/
│   └── meeting-files/          # 可直接上传的会议测试材料
├── docker/
│   └── postgres/init.sql       # pgvector 初始化
├── doc/
│   ├── adr/                    # 架构决策与验收证据
│   ├── api.md                  # API/SSE 文档
│   ├── data-model.md           # 数据模型说明
│   ├── user-manual.md          # 最终用户手册
│   └── third-party-licenses.md
├── e2e/                        # Playwright 端到端测试
├── docker-compose.yml
├── pnpm-workspace.yaml
└── .env.example
```

## 3. 架构概览

```text
Browser / Vue 3
      |
      | REST + SSE / HttpOnly Cookie
      v
NestJS API
      |-- Auth / tenant boundary
      |-- AgentRuntimePort --> Pi Agent Core --> Pi AI Provider --> GLM
      |-- Conversation / File / Meeting / Todo / Memory / PPT services
      |-- PostgreSQL + pgvector
      |-- Redis distributed locks
      `-- BullMQ queue
             |
             v
        NestJS Worker
        |-- PDF/TXT parsing
        |-- Meeting analysis
        |-- Memory extraction
        `-- PPT generation/export
```

关键原则：

- PostgreSQL 是业务数据和 Agent transcript 的唯一权威来源；
- Pi Agent 是唯一 Agent Loop，业务层只依赖 `AgentRuntimePort`；
- API 和 Worker 使用同一镜像与代码版本；
- 所有业务查询都受当前用户范围约束；数据库触发器进一步阻止跨租户关联；
- 文件只能经鉴权 API 下载，不暴露静态上传目录；
- Search、SMTP、Embedding 和模型接入均通过可替换 Adapter。

## 4. 前置条件

推荐直接使用 Docker Compose：

- Docker Desktop，或 macOS 上的 Colima；
- Docker Compose v2，或独立的 `docker-compose`；
- 至少为容器预留约 4 GB 内存。

本地开发还需要：

- Node.js `>=22.19.0`，推荐 Node.js 24；
- pnpm `11.22.0`；
- PostgreSQL 16 + pgvector；
- Redis 7。

启用仓库声明的 pnpm 版本：

```bash
corepack enable
corepack prepare pnpm@11.22.0 --activate
```

## 5. 配置

复制配置模板：

```bash
cp .env.example .env
chmod 600 .env
```

### 5.1 必需配置

| 变量 | 说明 | 示例/默认值 |
|---|---|---|
| `DATABASE_URL` | Prisma PostgreSQL 连接 | Compose 内使用主机名 `postgres` |
| `REDIS_URL` | BullMQ 与分布式锁 | Compose 内使用 `redis://redis:6379` |
| `JWT_ACCESS_SECRET` | Access Token 签名密钥 | 至少 32 个随机字符 |
| `JWT_REFRESH_SECRET` | Refresh Token 签名密钥 | 至少 32 个随机字符，不能与 Access 相同 |
| `STORAGE_ROOT` | 上传文件与 PPTX 的持久化目录 | Compose 中为 `/app/data/uploads` |
| `LLM_BASE_URL` | OpenAI-compatible API 根地址 | `https://open.bigmodel.cn/api/coding/paas/v4` |
| `LLM_API_KEY` | 模型密钥 | 仅写入本机 `.env` |
| `LLM_MODEL` | 模型 ID | `glm-5.3` |
| `WEB_ORIGIN` | CORS 允许的 Web 地址 | `http://localhost:3000` |

不要把真实密钥写入 README、`.env.example`、源码、测试快照或日志。`.env` 已被 `.gitignore` 排除。

### 5.2 Agent 与超时

| 变量 | 默认值 | 说明 |
|---|---:|---|
| `LLM_TIMEOUT_MS` | `180000` | 单次 Provider 调用硬超时 |
| `LLM_MAX_RETRIES` | `2` | Provider 临时错误重试数 |
| `LLM_MAX_RETRY_DELAY_MS` | `30000` | 最大重试等待时间 |
| `PI_AGENT_THINKING_LEVEL` | `medium` | Pi Agent 思考等级 |
| `PI_AGENT_MAX_TOOL_TURNS` | `8` | 单次 Run 最大工具轮次 |
| `PI_AGENT_TOOL_EXECUTION` | `parallel` | 默认工具执行方式；副作用工具单独强制串行 |
| `PI_AGENT_VERSION` | `0.87.1` | 运行时基线标识 |
| `MEETING_UPLOAD_DEBOUNCE_MS` | `2000` | 同批 TXT 自动分析防抖窗口 |

### 5.3 可选 Embedding

```dotenv
EMBEDDING_BASE_URL=
EMBEDDING_API_KEY=
EMBEDDING_MODEL=
```

三项完整配置后使用向量 + BM25 + RRF；否则自动降级为 BM25，不影响 PDF 问答。

### 5.4 可选联网搜索

默认关闭：

```dotenv
SEARCH_ENABLED=false
SEARCH_PROVIDER=tavily
SEARCH_API_KEY=
```

无真实 Key 时可使用确定性 Mock：

```dotenv
SEARCH_ENABLED=true
SEARCH_PROVIDER=mock
```

### 5.5 可选邮件

默认关闭：

```dotenv
SMTP_ENABLED=false
SMTP_PROVIDER=smtp
SMTP_HOST=
SMTP_PORT=587
SMTP_USER=
SMTP_PASSWORD=
SMTP_FROM=
SMTP_TO=
```

本地验证可使用：

```dotenv
SMTP_ENABLED=true
SMTP_PROVIDER=mock
SMTP_TO=demo@example.test
```

Mock 不会发送真实邮件。

### 5.6 可选视觉模型

```dotenv
VISION_ENABLED=false
VISION_BASE_URL=
VISION_API_KEY=
VISION_MODEL=
```

视觉能力是扩展接口，默认关闭，不属于当前硬验收链路。

## 6. Docker Compose 启动

### 6.1 最短上手路径

```bash
make setup
# 编辑 .env，至少填写 LLM_API_KEY，并替换两个 JWT Secret
make up
make ps
```

然后访问 <http://localhost:3000>。常用命令可通过 `make help` 查看。

### 6.2 标准 Docker 环境

```bash
docker compose up -d --build
```

如果环境仍使用独立命令：

```bash
docker-compose up -d --build
```

访问：

- Web：<http://localhost:3000>
- Liveness：<http://localhost:3001/api/health/live>
- Readiness：<http://localhost:3001/api/health/ready>
- 能力开关：<http://localhost:3001/api/health/capabilities>

### 6.3 Colima

```bash
colima start
DOCKER_HOST=unix://$HOME/.colima/default/docker.sock docker-compose up -d --build
```

检查状态：

```bash
DOCKER_HOST=unix://$HOME/.colima/default/docker.sock docker-compose ps
```

也可以让 Makefile 使用指定的 Compose 命令和 Docker Host：

```bash
DOCKER_HOST=unix://$HOME/.colima/default/docker.sock \
  make up
```

Makefile 会自动选择 `docker compose` 或 `docker-compose`；如需强制指定，仍可传入
`COMPOSE=docker-compose`。Colima 默认只共享用户目录，因此请将仓库克隆到
`$HOME` 下（例如 `$HOME/workspace/out-brain`），不要从 `/tmp` 启动挂载了本地文件的服务。

### 6.4 日志

```bash
docker compose logs -f api worker web
docker compose logs -f postgres redis
```

后台任务日志为结构化 JSON，包含 `traceId`、不可逆用户标识、资源、任务类型、状态、耗时、尝试次数和错误码，不记录提示词正文或凭据。

### 6.5 停止与清理

保留数据库及上传文件：

```bash
docker compose down
```

同时永久删除数据库、上传文件和 PPTX：

```bash
docker compose down -v
```

请勿在需要保留演示数据时使用 `-v`。

## 7. 本地开发

### 7.1 安装依赖

```bash
pnpm install --frozen-lockfile
pnpm db:generate
```

### 7.2 启动基础设施

```bash
docker compose up -d postgres redis
```

如果 API/Worker 在宿主机运行，`.env` 中连接地址应使用宿主机端口：

```dotenv
DATABASE_URL=postgresql://nbboss:nbboss@localhost:5432/nbboss?schema=public
REDIS_URL=redis://localhost:6379
STORAGE_ROOT=./data/uploads
```

执行迁移：

```bash
pnpm db:migrate
```

### 7.3 启动 API、Web 和 Worker

终端一：

```bash
pnpm --filter @nbboss/api dev
```

终端二：

```bash
pnpm --filter @nbboss/web dev
```

终端三：

```bash
WORKER_MODE=true pnpm --filter @nbboss/api dev
```

也可使用：

```bash
pnpm dev
```

该命令启动 API 和 Web，Worker 仍需单独启动。

## 8. 数据库与迁移

Prisma Schema 位于：

```text
apps/api/prisma/schema.prisma
```

开发环境创建迁移：

```bash
pnpm --filter @nbboss/api exec prisma migrate dev --name <migration_name>
```

重新生成 Client：

```bash
pnpm db:generate
```

生产式/Compose 启动使用：

```bash
pnpm --filter @nbboss/api exec prisma migrate deploy
```

不要使用 `prisma db push` 代替正式迁移提交。新增跨实体关联时，除了服务层用户 Scope，还应评估是否需要数据库级租户完整性约束。

## 9. Agent Runtime 开发约束

- Agent 入口必须经 `AgentRuntimePort`，Controller 和领域服务不得直接依赖 Pi 事件类型；
- 使用 Pi Agent 高层 `Agent` 类，不另建自定义循环；
- 自定义模型由 `PiModelsService` 注册为 OpenAI-compatible Provider；
- PostgreSQL transcript 用于恢复会话，Pi 不保存第二份业务真相；
- `beforeToolCall` 校验租户、资源归属、模式、功能开关和工具额度；
- `afterToolCall` 截断并脱敏返回内容；
- 浏览器只消费稳定的内部 SSE 事件；
- 有副作用的工具必须串行并带领域幂等键；
- Provider 错误、工具错误、中止、重启中断和最大轮次必须映射为不同状态。

当前主要领域工具：

- `retrieve_documents`
- `retrieve_memory`
- `search_web`
- `analyze_meeting`
- `generate_presentation`

会议结构化提交和 PPT 结构化提交同样由 Pi Agent + TypeBox 工具 Schema 驱动，进入领域层后再使用 Zod 严格校验。

## 10. 后台任务与一致性

BullMQ 队列名为 `nbboss`，当前任务包括：

- `file.parse`
- `meeting.analyze`
- `memory.extract`
- `presentation.generate`

实现约束：

- TXT 同批上传通过延迟去重合并成一次分析；
- 相同会议文件快照的重复任务直接复用结果，避免重复待办和邮件；
- 确定性输入错误不进行无意义重试；
- Provider 临时错误有限重试；重试耗尽前领域状态保持处理中；
- 长模型任务使用覆盖 Provider 超时窗口的 BullMQ 锁；
- 来源删除后，迟到的文件和记忆任务必须安全结束，不能恢复孤儿数据；
- PPT 保存使用 Redis 锁生成连续、不可变版本；
- 会话/文件删除先原子移动到 trash，数据库成功后异步清理，数据库失败则恢复文件。

## 11. 测试

### 11.1 静态检查与单元测试

```bash
pnpm -r typecheck
pnpm -r test
```

覆盖共享契约、风险 Schema、检索排序、Adapter、Pi Agent 事件、工具失败、最大轮次、中止、Provider 超时/限流、记忆冲突、日期/颜色规范化等。

### 11.2 集成测试

先启动完整 Compose 环境，然后执行：

```bash
set -a
source .env
set +a
pnpm test:integration
```

覆盖真实 PostgreSQL/Redis/API/Worker、Refresh Rotation、IDOR、数据库租户约束、文件生命周期、200 页 PDF、BM25、多 PDF 引用、会议缓存、记忆删除竞态、PPT 并发版本和 10 用户并发。

### 11.3 E2E

```bash
pnpm test:e2e
```

Playwright 默认访问 `http://localhost:3000`，覆盖注册、会话模式、未登录跳转、上传、工具状态、待办、记忆、PPT 编辑和 1050px 桌面断点。

### 11.4 完整验收

```bash
pnpm -r typecheck
pnpm -r test
docker compose up -d --build
set -a && source .env && set +a
pnpm test:integration
pnpm test:e2e
```

最新验收结果与真实 Provider 证据见 [`doc/adr/0001-acceptance-evidence.md`](doc/adr/0001-acceptance-evidence.md)。

## 12. API 与 SSE

所有业务 API 位于 `/api`，认证使用 HttpOnly Cookie。主要接口：

| 方法 | 路径 | 用途 |
|---|---|---|
| POST | `/api/auth/register` | 注册并登录 |
| POST | `/api/auth/login` | 登录 |
| POST | `/api/auth/refresh` | Refresh Token 轮换 |
| POST | `/api/auth/logout` | 注销 Refresh Token |
| GET/POST | `/api/conversations` | 会话列表/创建 |
| GET/DELETE | `/api/conversations/:id` | 会话详情/级联删除 |
| POST | `/api/conversations/:id/messages` | SSE Agent 对话 |
| POST | `/api/conversations/:id/runs/:runId/abort` | 服务端中止 |
| POST | `/api/conversations/:id/files` | 上传 PDF/TXT |
| GET/DELETE | `/api/files/:id` | 下载/删除文件 |
| GET | `/api/conversations/:id/meetings` | 会议结果 |
| POST | `/api/conversations/:id/meetings/reanalyze` | 强制重新分析 |
| GET | `/api/todos` | 筛选待办 |
| PATCH/DELETE | `/api/todos/:id` | 修改/删除待办 |
| GET | `/api/memories` | 记忆及历史 |
| PATCH | `/api/memories/facts/:id` | 修正当前事实 |
| DELETE | `/api/memories/:id` | 删除记忆实体 |
| POST | `/api/conversations/:id/presentations` | 创建 PPT 任务 |
| GET/POST | `/api/presentations/:id/versions` | 查看/保存版本 |
| GET | `/api/presentation-versions/:id/download` | 下载 PPTX |

SSE 事件包括：

- `run.started`
- `message.delta`
- `message.completed`
- `tool.started`
- `tool.completed`
- `artifact.created`
- `run.completed`
- `run.failed`
- `run.aborted`

完整请求和响应说明见 [`doc/api.md`](doc/api.md)。

## 13. 安全要求

- 密码必须使用 Argon2id；
- Refresh Token 数据库只保存 SHA-256 哈希；
- Access/Refresh Token 使用 HttpOnly、SameSite Cookie；
- 所有资源查询必须包含当前用户 Scope；
- 上传必须同时校验扩展名、MIME、大小、PDF 签名和 TXT UTF-8；
- 文件磁盘名必须使用随机 UUID；
- 日志不得写入密码、Cookie、Token、API Key、完整提示词或完整用户文件；
- Provider 原始错误不得直接返回给浏览器；
- `.env` 权限建议保持 `0600`；
- 如果密钥曾通过聊天、截图或其他非密钥渠道暴露，必须轮换。

## 14. 扩展点

### 新模型 Provider

在 `PiModelsService` 中通过 Pi AI 的 `createModels()` / `createProvider()` 注册，并保持 `AgentRuntimePort` 接口不变。为 Provider 增加成功、超时、限流、认证失败和畸形响应契约测试。

### 新搜索 Provider

扩展 `SearchService`，返回统一的 `title/url/snippet/retrievedAt`。必须过滤非 HTTP(S) URL，并确保搜索仅在用户手动开启时调用。

### 新邮件 Provider

扩展 `MailService` Adapter，不要把供应商特例写进会议领域服务。必须保留固定收件地址、有限重试、错误脱敏和投递状态。

### 新 Agent 工具

工具必须：

1. 使用 TypeBox 声明参数；
2. 在执行前校验用户和资源边界；
3. 对结果进行长度限制与脱敏；
4. 明确是否有副作用；
5. 有副作用时提供幂等键并串行执行；
6. 添加 Pi Faux 契约测试和跨用户安全测试。

## 15. 故障排查

### API 不健康

```bash
docker compose ps
docker compose logs api postgres redis
curl -i http://localhost:3001/api/health/ready
```

### Worker 没有处理任务

```bash
docker compose logs worker redis
```

确认 API 与 Worker 使用同一镜像：

```bash
docker inspect out-brain-api-1 out-brain-worker-1 \
  --format '{{.Name}} {{.Image}} {{.State.Status}}'
```

### 文件一直处于 PROCESSING

检查 Worker、Redis 和上传 Volume；确认 API 与 Worker 都挂载到 `/app/data/uploads`。

### 模型请求失败

核对 `LLM_BASE_URL`、`LLM_MODEL` 和本机 `.env` 中的 Key。根据页面参考编号查询结构化日志，不要把真实 Key 粘贴到终端输出、Issue 或聊天中。

### 数据库 Schema 不一致

```bash
pnpm --filter @nbboss/api exec prisma migrate status
pnpm --filter @nbboss/api exec prisma migrate deploy
pnpm db:generate
```

### 清理失败任务（仅开发环境）

优先检查错误原因和修复代码，不要在生产环境直接清队列。开发环境确认数据可丢弃后，可通过 BullMQ API 或删除对应 Redis Volume 重置。

## 16. 演示数据

会议分析示例位于：

```text
demo/meeting-files/
```

使用说明见 [`demo/meeting-files/README.md`](demo/meeting-files/README.md)。

## 17. 许可证注意事项

项目使用的主要第三方组件及许可证见 [`doc/third-party-licenses.md`](doc/third-party-licenses.md)。PPTist 相关方案允许采用 AGPL-3.0 组件，但进入正式产品前必须由法务或开源治理团队确认分发和网络服务义务。
