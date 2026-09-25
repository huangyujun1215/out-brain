# NBBOSS AI 外脑 API

所有路径以 `/api` 为前缀。除健康检查和注册登录外，接口均要求同源 HttpOnly Cookie；服务端在每次查询中同时约束 `userId`，对无权资源统一返回 404，避免资源枚举。

## 认证

| 方法 | 路径 | 请求体 | 说明 |
|---|---|---|---|
| POST | `/auth/register` | `{username,password}` | 注册并签发 Access/Refresh Cookie |
| POST | `/auth/login` | `{username,password}` | 登录 |
| POST | `/auth/refresh` | - | Refresh Token 轮换 |
| POST | `/auth/logout` | - | 吊销 Refresh Token 并清 Cookie |

## 会话与 Agent

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/conversations` | 当前用户会话列表 |
| POST | `/conversations` | 创建 `{mode:"CHAT"|"MEETING",title?}`；模式不可修改 |
| GET | `/conversations/:id` | 可见消息（含已持久化联网来源）、文件状态、会议结果和 PPT 任务 |
| DELETE | `/conversations/:id` | 中止活跃 Agent 后级联删除数据库及存储目录 |
| POST | `/conversations/:id/messages` | 请求 `{content,webSearch}`，响应为 SSE |
| POST | `/conversations/:id/runs/:runId/abort` | 显式停止 Pi Agent Run |

SSE 的稳定内部事件为：`run.started`、`message.delta`、`message.completed`、`tool.started`、`tool.completed`、`run.completed`、`run.failed`、`run.aborted`。前端不依赖 Pi Agent 原始事件类型。

## 文件与 RAG

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/conversations/:id/files` | `multipart/form-data` 的 `file`；PDF 20 MB/200 页，TXT 5 MB |
| GET | `/files/:id` | 鉴权下载原始文件 |
| DELETE | `/files/:id` | 删除文件、页、分块和索引；会议来源变化时重新分析 |

处理状态通过会话详情中的 `files[].status` 获取：`PROCESSING`、`READY`、`FAILED`。扫描 PDF 返回 `FAILED` 及可理解原因。

## 会议、待办与记忆

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/conversations/:id/meetings` | 固定结构、风险证据、待办和邮件状态 |
| POST | `/conversations/:id/meetings/reanalyze` | 忽略文件级缓存完整重跑 |
| GET | `/todos?status=&owner=&dueFrom=&dueTo=` | 按状态、责任人和截止日期筛选 |
| PATCH | `/todos/:id` | 编辑标题、说明、责任人、截止时间或四态状态 |
| DELETE | `/todos/:id` | 删除待办 |
| GET | `/memories` | 实体、当前事实及历史版本 |
| PATCH | `/memories/facts/:id` | 创建用户修正版并保留旧版本 |
| DELETE | `/memories/:entityId` | 删除实体及全部事实历史 |

## PPT

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/conversations/:id/presentations` | 创建异步任务 `{prompt,idempotencyKey?}`，立即返回 PENDING Artifact；重复幂等键返回同一任务 |
| GET | `/presentations/:id/versions` | 任务及全部可编辑 Slide JSON 版本 |
| POST | `/presentations/:id/versions` | 保存 `{prompt,document}` 为不可变新版本 |
| GET | `/presentation-versions/:id/download` | 下载可编辑 PPTX |

会话详情中的 PPT 状态为 `PENDING`、`PROCESSING`、`READY`、`FAILED`，并包含 `progress`。

## 健康与能力

- `GET /health/live`
- `GET /health/ready`：同时检查 PostgreSQL 和 Redis
- `GET /health/capabilities`：返回 Search/SMTP/Embedding/Vision 是否可用，不泄露配置值

## 错误格式

```json
{"statusCode":400,"code":"VALIDATION_ERROR","message":["..."],"traceId":"uuid"}
```

未知内部错误只返回通用文案及 `traceId`；Provider 原始错误、密钥、Token、完整提示词和文件正文不会返回浏览器。
