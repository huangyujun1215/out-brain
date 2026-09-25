# ADR-0001：NBBOSS AI 外脑 Demo 产品边界与技术方案

- **状态**：已接受（Accepted，Revision 1）
- **日期**：2026-09-24
- **最近修订**：2026-09-24（Agent Runtime 统一采用 Pi Agent）
- **决策参与者**：项目需求方、实现团队
- **需求来源**：`doc/requirement/init_requirement.txt`
- **品牌参考**：`doc/requirement/NBBOSS产品宣传册(1).pdf`

## 1. 决策摘要

建设一个面向内部员工、运行于本机 `localhost` 的多用户 Web Demo，产品名暂定为 **NBBOSS AI 外脑**。首期必须同时完成并稳定通过以下四条 P0 链路：

1. 多轮流式对话；
2. 基于当前会话 PDF 的知识问答与页码引用；
3. 会议 TXT 分析、承诺未闭环风险识别、自动生成待办及可配置邮件通知；
4. 基于会话上下文生成、预览、简单编辑并下载可编辑 PPTX。

长期记忆、联网搜索、账号隔离、文件持久化是上述链路的组成部分，不作为可随意裁减的附加项。若进度与质量冲突，应调整工期和资源，不得通过删除核心能力降级交付。

总体技术栈采用 TypeScript/Node.js：Vue 3 + Vite 前端、NestJS 后端、Pi Agent Runtime、PostgreSQL + pgvector、Redis + BullMQ、Prisma、PPTist/PptxGenJS，并使用 Docker Compose 一键启动。所有需要模型自主决策、工具调用、流式事件和多轮执行的能力统一运行在 Pi Agent 上，不再自建另一套 Agent Loop。

## 2. 背景与目标

### 2.1 背景

初始需求要求系统具备聊天、文件知识背景、会议风险闭环、跨会话长记忆、联网检索和 PPT 生成能力。产品宣传册进一步强调：

- 捕捉碎片化商机和口头承诺；
- 自动形成责任人与闭环节点；
- 主动发现信息不对称、承诺遗忘及方案漏洞；
- 追溯历史讨论和决策依据；
- 从“信息整理工具”升级为“决策外脑”。

因此，本方案把会议风险收敛为可验证、可追踪的“承诺未闭环风险”，而不是让模型泛化判断财务、法律或合规风险。

### 2.2 当前阶段目标

- 面向内部员工提供完整、可信的桌面 Web Demo；
- 支持真实多用户注册登录和严格数据隔离；
- 核心数据与产物持久化，可关闭浏览器后继续使用；
- 关键能力采用可替换接口，为后续产品化保留演进空间；
- 提供一键启动、环境变量示例、自动化测试和演示数据；
- 以达到验收标准为目标，当前不以研发成本作为范围约束。

### 2.3 非目标

首期明确不做：

- 公网部署、域名、HTTPS、集群高可用和大规模横向扩容；
- 企业 SSO、邮箱验证、手机号登录、管理员后台和复杂 RBAC；
- 移动端专项适配；
- 实体硬件接入、麦克风录音、实时会议转写和机器人控制；
- 扫描版 PDF OCR；
- 财务、法律、合规等专业风险判断；
- 飞书、Jira 等外部任务系统同步；
- PPT 动画、母版编辑、复杂图表编辑和多人协作；
- PPT 模板市场；
- PDF 图片和图表理解作为硬性验收项。

## 3. 用户、部署与容量边界

### 3.1 用户

- 核心用户：内部员工；
- 账号：用户名 + 密码，用户名唯一；
- 不采集邮箱、手机号和真实姓名；
- 每个用户只能访问自己的会话、文件、会议、风险、待办、记忆和 PPT；
- Demo 目标并发：10 个用户。

### 3.2 部署

- 仅要求本机通过 `localhost` 访问；
- 使用 Docker Compose 编排 PostgreSQL、Redis、API、Worker 和 Web；
- 原始文件保存在本机持久化目录/Volume 中；
- 文件访问必须经过鉴权接口，禁止把用户文件目录直接暴露为公共静态目录。

### 3.3 浏览器

- 支持最新版 Chrome 和 Edge；
- 只要求桌面端体验；
- 页面可具备基础响应式能力，但不为手机端单独设计交互。

## 4. UI/UX 决策

### 4.1 Dify 风格参考

页面信息架构和交互密度参考 Dify，但不复制其品牌资产或源代码：

- 左侧固定导航：新建会话、历史会话、待办中心、记忆管理；
- 主区域为对话流，顶部显示会话标题和不可变的会话模式；
- 输入区固定在底部，集中放置附件、联网搜索开关、发送/停止生成；
- 文件、引用、会议结果、待办和 PPT 等产物使用卡片呈现；
- 需要深入操作时使用右侧 Artifact 面板，避免离开对话上下文；
- 空状态直接给出示例动作，不展示无意义的配置项；
- 异步任务显示排队、处理中、完成、失败等清晰状态。

视觉使用 NBBOSS 宣传册的白色基底、深蓝主文字和紫色渐变作为品牌强调色。界面应保持克制、专业、高信息密度，避免过多拟物或娱乐化动效。

### 4.2 主要页面

1. **注册/登录页**：用户名和密码；
2. **对话页**：普通对话、会议分析两种模式；
3. **待办中心**：列表、筛选、编辑、状态更新、删除；
4. **记忆管理**：查看当前记忆及历史版本，支持修改和删除；
5. **PPT Artifact 编辑器**：预览、简单编辑、保存新版本、下载；
6. **历史会话页/侧栏**：重新进入会话并恢复消息、文件和产物。

### 4.3 会话模式

- 创建会话时选择“普通对话”或“会议分析”；
- 模式创建后不可切换；
- 两种模式都可上传 PDF；
- 会议分析模式额外支持多个 TXT；
- 删除会话必须级联删除消息、文件、解析文本、索引、会议分析缓存和会话内 PPT；由该会话产生的记忆与待办应弹出明确的删除影响说明，并按产品规则级联清理其来源关联数据。

## 5. 功能决策

### 5.1 对话

- 支持多轮对话和历史会话恢复；
- 对话执行统一由 Pi Agent Runtime 驱动；
- 将 Pi Agent 的 `message_update`、工具执行和生命周期事件转换为 SSE 输出；
- 用户可停止当前生成，服务端调用对应 Agent 的 `abort()`，而不是只断开浏览器连接；
- 会话、Agent transcript、工具调用、工具结果和模型调用状态持久化；
- 模型由 Pi AI 的 Provider/Model 注册机制驱动，并支持自定义 OpenAI-compatible Provider；
- 当前首选模型通过环境变量配置，禁止在仓库中保存真实 API Key。

### 5.2 PDF 知识问答

#### 范围

- PDF 只对其所属会话生效，不进入用户级全局知识库；
- 同一会话允许多个 PDF，并可跨文件联合检索；
- 历史会话重新打开后仍可继续检索已上传 PDF；
- 原始 PDF、解析文本、分块、索引和引用元数据需要持久化；
- 单 PDF 不超过 20 MB、200 页；
- 不支持扫描版 PDF OCR；无法提取文字时必须给出明确提示。

#### 检索

- 使用 `pdfjs-dist` 按页抽取文本，并保存页码边界；
- 分块必须携带 `file_id`、文件名、页码范围和字符偏移；
- 配置 Embedding 服务时：向量检索 + BM25 混合召回，以 RRF 等稳定策略融合；
- 未配置 Embedding 时：自动降级为纯 BM25；
- BM25 可在 Node.js Worker 中对单会话语料建立轻量索引，并缓存索引结果；
- Embedding 服务拥有独立的 Base URL、API Key 和模型配置，不与聊天模型硬绑定。

#### 回答和引用

- 文件事实必须标注文件名和页码；
- 多文件综合回答必须区分每条证据来自哪个文件；
- 文件中没有足够依据时，先明确说明“资料中没有相关信息”；
- 允许继续提供通用知识补充，但必须与“文件结论”视觉分区，不得伪造 PDF 引用；
- 如果额外配置了支持视觉输入的模型，可增强图片/图表分析；该能力默认关闭且不进入首期硬验收。

### 5.3 会议分析

#### 输入和聚合

- 会议分析会话允许上传多个 UTF-8 TXT，每个不超过 5 MB；
- LLM 判断多个 TXT 是同一会议的分段还是不同会议；
- 同一会议合并为一个分析单元，不同会议分别生成会议记录；
- 新上传文件只执行增量分析，并结合旧文件的缓存结果重新综合；
- 文件级缓存键至少包含文件 SHA-256、分析提示词版本和模型版本；
- 提供“重新分析”按钮，强制忽略缓存并完整重跑当前会议会话。

#### 输出结构

输出采用“固定结构 + AI 自由洞察”：

- 会议摘要；
- 参与人；
- 时间与地点；
- 讨论主题；
- 关键结论/决策；
- 承诺事项；
- 承诺未闭环风险；
- 自动生成的待办；
- AI 洞察：商机、分歧、隐含关系或其他值得关注的信息。

固定结构使用 JSON Schema/Zod 校验；自由洞察不得改变风险和待办的机器可执行字段。

#### 风险边界

首期唯一业务风险类型为 **承诺未闭环风险**，包括：

- 没有明确责任人；
- 没有明确截止时间；
- 承诺描述含糊，无法验收；
- 同一事项存在冲突说法；
- 已承诺事项存在延期或遗忘信号；
- 对方方案存在与该承诺直接相关、但尚未处理的明显漏洞。

每个风险必须包含严重程度、风险描述、证据片段和来源文件；若依赖 PDF 背景，还需给出 PDF 文件名和页码。禁止把一般讨论或模型猜测包装成确定风险。

### 5.4 待办

- 识别到风险后自动创建待办，无需人工确认；
- 待办必须标记为“AI 生成”；
- 固定字段：标题、事项说明、责任人、截止时间、来源会议、关联风险、状态、创建时间；
- 原文未给出责任人或截止时间时填写“待确认”，禁止模型编造；
- 状态固定为：待处理、进行中、已完成、已取消；
- 用户可以查看、编辑、完成和删除待办；
- 独立待办中心支持按状态、责任人和截止时间筛选；
- 所有待办严格按用户隔离。

### 5.5 邮件

- 邮件使用通用 SMTP Adapter；
- SMTP 和固定收件地址只通过服务端环境变量配置；
- 默认关闭；缺少配置时不应导致会议分析失败；
- 一次会议的所有风险和待办汇总为一封邮件；
- 开启时，会议分析成功并完成待办落库后自动发送；
- 保存发送状态、时间和脱敏错误信息；
- 外部发送错误由系统内部有限重试，最终失败不回滚已生成的会议结果和待办。

### 5.6 长期记忆

#### 范围与隔离

- 自动从聊天和会议中抽取人物、时间、地点、主题及必要的关系事实；
- 抽取和更新异步执行，不阻塞聊天或会议分析；
- 记忆严格按用户隔离；
- 不跨账号共享；
- 提供记忆管理页面，允许查看、修改和删除。

#### 分层调用

1. 使用轻量判断器判断当前请求是否需要长期记忆；
2. 仅在需要时检索当前用户记忆；
3. 将相关记忆注入模型上下文；
4. 对话页不显示记忆引用，来源和历史只在记忆管理页中查看。

#### 更新机制

- 记忆采用实体-属性-值模型，并记录来源、有效时间、抽取时间和置信度；
- 新旧事实冲突时，以较新信息作为当前有效值；
- 旧值不物理覆盖，标记为已被新版本取代；
- 用户手工修改的值优先级高于模型抽取值，后续自动更新不得静默覆盖用户修正；
- 删除记忆时同时删除其历史版本和索引。

### 5.7 联网搜索

- 仅由用户手动开启联网搜索，不自动触发；
- 搜索服务通过 Provider Adapter 接入；
- 未配置 Provider/Key 时功能显示为不可用，但不影响普通对话；
- 回答必须展示可点击来源链接和检索时间；
- 搜索查询、摘要、来源 URL 和最终回答随消息持久化；
- 搜索结果只能作为外部信息来源，不能伪装成用户 PDF 或长期记忆。

### 5.8 PPT 生成、预览和编辑

#### 内容与生成

- 用户明确要求生成 PPT 时，系统可使用当前会话聊天、PDF 内容及本次联网搜索结果；
- 用户可指定页数；未指定时默认 8 页，AI 可在 6-12 页内调整；
- 首期只提供一套 NBBOSS 风格模板；
- 输出必须是真正可编辑的 `.pptx`，不得用全页图片或 PDF 冒充；
- 生成过程为异步任务，界面显示进度。

#### 编辑器技术决策

- PPTist 用作在线演示文稿编辑能力的主要参考/集成基础；
- 演示文稿内部以可编辑的 Slide JSON 作为源数据；
- 模型先生成受约束的 Slide JSON，再由渲染层预览并导出 PPTX；
- PptxGenJS 负责或辅助 `.pptx` 导出，最终实现应以 PoC 验证的 PPTist 数据兼容路径为准；
- 不采用“先生成任意 PPTX，再无损导入 PPTist”的不可靠链路作为架构前提；
- 首期编辑能力限定为修改文字、移动/缩放元素、删除元素、调整字号与颜色、新增文本框；
- 在线保存始终创建新版本，不覆盖原版本；
- 每个版本保存生成时间、用户要求、Slide JSON、缩略图/预览和 `.pptx` 文件；
- 所有历史版本均可查看和下载。

#### 开源许可证

允许采用 AGPL-3.0 组件。PPTist 或其他 AGPL 组件在进入正式产品前必须完成许可证合规评审，并记录源码修改、分发方式和网络服务义务。

### 5.9 Agent Runtime

#### 统一运行时

- Agent Runtime 采用 Pi Agent 体系，基线包为 `@earendil-works/pi-agent-core` 和 `@earendil-works/pi-ai`；
- 初始实现锁定并共同升级两个包的相同版本，设计修订时验证版本为 `0.87.1`；
- 运行时要求 Node.js `>=22.19.0`，项目 Docker 镜像与本地开发统一使用 Node.js 24；
- 使用高层 `Agent` 类，不直接以低层 `agentLoop()` 作为业务主入口，确保异步订阅者、消息持久化和工具调用屏障具有明确语义；
- NestJS 只负责认证、资源边界、事务、队列和传输；模型循环、工具执行、steering/follow-up 语义及事件生命周期由 Pi Agent 负责；
- 业务代码通过自有 `AgentRuntimePort` 包装 Pi API，防止 Pi 的包名、事件类型或版本变化扩散到 Controller 和领域层。

#### 模型接入

- 使用 `@earendil-works/pi-ai` 的 `createModels()` 和 `createProvider()` 注册智谱等 OpenAI-compatible 服务；
- 自定义模型显式声明 API 类型、Base URL、模型 ID、上下文窗口及兼容性参数；
- 当前服务若不支持 `developer` role、`reasoning_effort` 或严格工具 Schema，必须通过模型 `compat` 配置关闭，而不是在业务代码里拼接厂商特例；
- API Key 由服务端运行时动态解析，不放入 Agent transcript、工具结果或前端配置；
- Embedding 仍通过独立 Adapter 处理，不强行纳入 Pi Agent 的聊天模型接口。

#### 会话恢复与上下文组装

- PostgreSQL 是会话与 transcript 的唯一权威来源，不使用 Pi 的 SQLite Session Backend 作为第二份业务真相；
- 每次运行按 `conversation_id + user_id` 加载规范化 transcript，重建 Agent；活跃运行仅在内存中保存；
- `prepareRequest` 在每次 Provider 请求前重新加载规范上下文，并完成 Token 预算、长期记忆按需注入、PDF 检索结果和联网搜索结果注入；
- `transformContext` 只负责裁剪/压缩，不允许绕过租户范围补充数据；
- `convertToLlm` 过滤 UI-only、Artifact 状态等自定义消息，只把合法的 system/user/assistant/toolResult 内容发送给模型；
- 系统提示词和工具集的变更以 Pi transcript 中的 system patch 方式记录，保证回放时可解释。

#### 工具模型

Pi Agent 工具使用 TypeBox 声明参数，首期工具集合为：

| 工具 | 用途 | 暴露条件 |
|---|---|---|
| `retrieve_documents` | 检索当前会话 PDF 并返回带页码证据 | 当前会话存在 Ready PDF |
| `retrieve_memory` | 检索当前用户长期记忆 | Need-Memory 判断为需要 |
| `search_web` | 联网搜索并返回 URL 与检索时间 | 用户本轮手动开启联网且 Provider 可用 |
| `analyze_meeting` | 对当前会议材料执行结构化分析 | 会议分析模式 |
| `create_todos` | 持久化经校验的风险待办 | 仅会议分析内部流程 |
| `generate_presentation` | 创建 PPT 后台任务并返回 Artifact | 用户明确要求生成 PPT |

- 所有工具参数先由 Pi/TypeBox 校验，再进入领域服务；
- `beforeToolCall` 强制校验当前用户、会话模式、资源归属、功能开关和工具调用额度，可阻止越权或不允许的调用；
- `afterToolCall` 对结果脱敏，记录审计元数据，并确保返回给模型的内容满足 Token 上限；
- 文件系统、数据库和任意代码执行能力不直接暴露给 Agent；Agent 只能调用上述受限领域工具；
- `create_todos` 等有副作用工具使用幂等键，防止模型重试造成重复写入或重复发信；
- 工具默认并行执行；涉及会议落库、待办创建和邮件排程的同一批副作用工具强制顺序执行。

#### 事件、取消与并发

- 订阅 `agent_start`、`turn_start/end`、`message_start/update/end`、`tool_execution_start/update/end` 和 `agent_end`；
- Runtime 将 Pi 事件映射为稳定的内部事件协议，再由 SSE 推送给浏览器；前端不得直接依赖 Pi 包的事件类型；
- `message_end` 后持久化完整消息，`tool_execution_end` 后持久化工具调用及结果，`agent_end` 作为本次运行最终落盘屏障；
- 同一会话同一时间只允许一个活跃 Agent Run，使用 Redis 分布式锁避免并发 transcript 分叉；
- 浏览器断线不等于自动取消；用户显式停止时调用 `abort()`，记录 `aborted` 状态并释放锁；
- 服务重启后，未完成 Run 标为 interrupted；可在下一次用户输入时基于最后一个已完成事件恢复，不伪造成功结果；
- steering 和 follow-up 能力由 Runtime 保留，但首期 UI 只开放“停止当前生成”，不暴露复杂排队交互。

## 6. 系统架构

### 6.1 逻辑架构

```text
Browser (Vue 3)
  |-- REST: auth, CRUD, upload, artifacts
  |-- SSE: normalized Agent events, chat stream, job progress
  v
NestJS API
  |-- Auth / Conversation / File / Meeting / Task / Memory / PPT modules
  |-- AgentRuntimePort -> Pi Agent Core
  |     |-- Pi AI Models + custom OpenAI-compatible Provider
  |     |-- guarded domain tools
  |     |-- event bridge / abort / transcript recovery
  |-- Provider adapters: Embedding, Search, SMTP, Storage
  |-- Prisma -> PostgreSQL + pgvector
  |-- Redis conversation lock
  |-- enqueue -> Redis/BullMQ
  v
NestJS Worker
  |-- PDF parse/chunk/index
  |-- meeting analysis/cache/aggregation
  |-- memory extraction/update
  |-- PPT generation/render/export
  |-- email delivery
  v
Local Storage Volume
```

### 6.2 Monorepo 建议

```text
apps/
  web/                 # Vue 3 + Vite
  api/                 # NestJS HTTP/SSE API
  worker/              # NestJS/BullMQ workers
packages/
  contracts/           # Zod schemas, DTO and event contracts
  agent-runtime/       # AgentRuntimePort + Pi Agent implementation
  ai-providers/        # Pi AI provider registration + Embedding/Search adapters
  agent-tools/         # TypeBox tool schemas and guarded domain tool adapters
  retrieval/           # chunking, BM25, vector, RRF
  ppt/                 # slide schema, theme, exporter bridge
  shared/              # logging, errors, utilities
docker-compose.yml
.env.example
```

推荐使用 pnpm workspace。前端状态分为：Pinia 管理本地交互状态，TanStack Query 管理服务端状态；UI 可采用 Tailwind CSS + shadcn-vue/Radix Vue，以便实现接近 Dify 的简洁桌面布局。

### 6.3 核心技术栈

| 层次 | 决策 |
|---|---|
| Web | Vue 3、TypeScript、Vite、Vue Router、Pinia、TanStack Query |
| UI | Tailwind CSS、shadcn-vue/Radix Vue，PPTist 编辑能力 |
| API | Node.js 24、NestJS、TypeScript、REST + SSE |
| Agent Runtime | `@earendil-works/pi-agent-core`，通过 `AgentRuntimePort` 封装 |
| Model Runtime | `@earendil-works/pi-ai`，自定义 OpenAI-compatible Provider |
| Tool Schema | TypeBox（Agent 工具）；Zod（应用 DTO/领域输出） |
| Worker | NestJS、BullMQ |
| Database | PostgreSQL + pgvector |
| ORM | Prisma；pgvector 特殊查询允许受控 Raw SQL |
| Cache/Queue | Redis |
| PDF | pdfjs-dist；视觉解析为可选 Provider |
| Retrieval | Node.js BM25 + pgvector + RRF |
| PPT | PPTist Slide JSON + PptxGenJS/经 PoC 验证的导出层 |
| Auth | JWT Access/Refresh Token、Argon2id |
| Test | Vitest、Supertest、Playwright、Provider Mock |
| Local Ops | Docker Compose、结构化日志、Health Check |

## 7. 数据模型

所有业务表必须直接或通过不可绕过的父级关联到 `user_id`。建议核心实体如下：

| 实体 | 关键字段 |
|---|---|
| User | id, username, password_hash, created_at |
| RefreshToken | id, user_id, token_hash, expires_at, revoked_at |
| Conversation | id, user_id, mode, title, created_at, updated_at |
| Message | id, conversation_id, role, content, status, model_meta, created_at |
| AgentRun | id, user_id, conversation_id, status, model, started_at, ended_at, abort_reason |
| AgentEvent | id, run_id, sequence, event_type, payload_redacted, created_at |
| ToolExecution | id, run_id, tool_call_id, tool_name, arguments_redacted, result_redacted, status |
| FileAsset | id, user_id, conversation_id, kind, path, sha256, size, status |
| DocumentPage | id, file_id, page_no, text |
| DocumentChunk | id, file_id, page range, text, embedding, token_count |
| Meeting | id, conversation_id, title, occurred_at, status, analysis_version |
| MeetingDocument | id, meeting_id/file_id, grouping_key, cache_key, analysis_json |
| Risk | id, meeting_id, type, severity, description, evidence_json |
| Todo | id, user_id, meeting_id, risk_id, title, owner, due_at, status, ai_generated |
| MemoryEntity | id, user_id, entity_type, canonical_name |
| MemoryFact | id, entity_id, attribute, value, valid_from, superseded_by, source |
| SearchRun | id, message_id, query, searched_at, sources_json |
| Presentation | id, conversation_id, title |
| PresentationVersion | id, presentation_id, prompt, slide_json, pptx_path, preview_meta |
| EmailDelivery | id, meeting_id, recipient_masked, status, attempts, error_code |
| JobRun | id, user_id, type, resource_id, status, progress, error_code |

数据库约束必须防止跨用户关联；服务层所有查询必须带当前认证用户范围。删除会话采用事务标记删除 + 后台清理文件/索引，避免数据库成功而文件清理失败导致状态不一致。

## 8. 关键流程

### 8.1 PDF 上传与问答

1. 鉴权并校验类型、大小、页数；
2. 文件写入临时区，计算 SHA-256；
3. 原子移动到用户隔离的持久化目录；
4. Worker 按页解析、分块并建立 BM25；
5. 若配置 Embedding，异步补充向量；
6. 文件状态变为 Ready；
7. Pi Agent 仅在当前会话存在可用 PDF 时获得 `retrieve_documents` 工具；
8. 工具强制限定当前用户和当前会话文件集合检索；
9. 生成带文件名和页码的结构化引用；
10. Pi Agent 事件桥通过 SSE 输出回答、工具状态和引用，并持久化最终 transcript。

### 8.2 会议分析闭环

1. 上传一个或多个 TXT，逐个建立文件级缓存；
2. 新文件先独立解析并提取会议线索；
3. 与已有会议摘要比较，判断合并或新建会议；
4. 会议模式 Pi Agent 获得受限的 `analyze_meeting`、`retrieve_documents` 和 `create_todos` 工具；
5. 基于 TXT 原文和当前会话 PDF 背景生成结构化分析；
6. 校验 JSON Schema，校验每个风险至少有一条有效证据；
7. `create_todos` 以分析版本为幂等键，在事务内保存会议结果、风险和自动待办；
8. 提交后台记忆抽取任务；
9. 邮件开启时，提交一封汇总邮件任务；
10. 通过标准化 Agent SSE 事件/任务事件更新 UI 状态。

### 8.3 长期记忆调用

1. 对当前用户请求执行 Need-Memory 分类；
2. 若不需要，不向本轮 Pi Agent 暴露 `retrieve_memory`；
3. 若需要，注册受当前用户约束的 `retrieve_memory` 工具，并在 `prepareRequest` 中提供必要的检索提示；
4. 工具按实体、主题、时间和语义召回，只返回当前有效版本并控制 Token 预算；
5. 回答完成后由 `agent_end` 订阅处理器提交异步记忆抽取；
6. 对冲突事实执行“较新优先、历史保留”的版本更新。

### 8.4 PPT 生成与编辑

1. 汇总当前会话允许使用的上下文和引用；
2. Pi Agent 在用户明确要求时调用 `generate_presentation`，生成大纲和受 Schema 约束的 Slide JSON；
3. 应用唯一 NBBOSS 模板并完成布局校验；
4. 生成浏览器预览和可编辑 PPTX；
5. 保存版本 1；
6. 用户在 PPTist 编辑器内执行限定编辑；
7. 保存时新建不可变版本并重新导出 PPTX。

## 9. API 边界（建议）

```text
POST   /auth/register
POST   /auth/login
POST   /auth/refresh
POST   /auth/logout

GET    /conversations
POST   /conversations
GET    /conversations/:id
DELETE /conversations/:id
POST   /conversations/:id/messages
GET    /conversations/:id/events              # SSE
POST   /conversations/:id/runs/:runId/abort

POST   /conversations/:id/files
GET    /files/:id
DELETE /files/:id

GET    /conversations/:id/meetings
POST   /conversations/:id/meetings/reanalyze

GET    /todos
PATCH  /todos/:id
DELETE /todos/:id

GET    /memories
PATCH  /memories/:id
DELETE /memories/:id

POST   /conversations/:id/presentations
GET    /presentations/:id/versions
POST   /presentations/:id/versions
GET    /presentation-versions/:id/download
```

API 必须使用统一错误码，而不是把模型或基础设施的原始错误直接返回给浏览器。

## 10. 安全与隐私

- 密码使用 Argon2id 哈希，禁止明文或可逆加密；
- Access/Refresh Token 优先使用 HttpOnly、SameSite Cookie；Refresh Token 服务端只保存哈希；
- 上传文件进行 MIME、扩展名、大小和内容签名校验；
- 文件名在磁盘上改为随机 ID，原始名只存数据库；
- 防止路径穿越、越权下载、跨会话检索和跨用户向量召回；
- API Key、SMTP 密码等只存在 `.env`/Secret 中，日志统一脱敏；
- 用户已确认允许把对话、PDF 和 TXT 内容发送给配置的外部模型服务；
- 页面应提示外部处理事实，后续产品化需补充隐私政策与供应商数据协议；
- 日志不得记录完整文件、完整提示词、密码、Token 或 API Key；
- 用户在讨论阶段提供过真实 API Key，上线或共享 Demo 前必须轮换；文档和代码中不得复写该 Key。

## 11. 配置设计

`.env.example` 只提供空值和说明，至少包含：

```dotenv
APP_URL=http://localhost:3000
DATABASE_URL=
REDIS_URL=
JWT_ACCESS_SECRET=
JWT_REFRESH_SECRET=
STORAGE_ROOT=

LLM_BASE_URL=
LLM_API_KEY=
LLM_MODEL=
PI_AGENT_THINKING_LEVEL=medium
PI_AGENT_MAX_TOOL_TURNS=8
PI_AGENT_TOOL_EXECUTION=parallel
PI_AGENT_VERSION=0.87.1

EMBEDDING_BASE_URL=
EMBEDDING_API_KEY=
EMBEDDING_MODEL=

VISION_ENABLED=false
VISION_BASE_URL=
VISION_API_KEY=
VISION_MODEL=

SEARCH_ENABLED=false
SEARCH_PROVIDER=
SEARCH_API_KEY=

SMTP_ENABLED=false
SMTP_HOST=
SMTP_PORT=
SMTP_USER=
SMTP_PASSWORD=
SMTP_FROM=
SMTP_TO=
```

Pi Agent 通过 `AgentRuntimePort` 隔离；模型 Provider、Embedding、搜索、邮件和存储均通过 Adapter 隔离，业务层不得依赖具体厂商 SDK 或 Pi 事件结构。

## 12. 错误处理与可观测性

- BullMQ 任务采用按错误类型配置的有限自动重试与指数退避；
- Pi Agent 的 provider error、tool error、aborted 和 interrupted 必须映射为不同内部状态；
- Agent 工具失败必须抛出错误，由 Pi Agent 形成标准 tool error，禁止把失败伪装成成功文本；
- `agent_end` 订阅处理器是本次 Run 的持久化屏障，必须等待消息与审计状态落盘；
- 达到最大工具轮次时终止 Run 并返回明确错误，避免 Agent 无限循环；
- 参数错误、文件不支持、内容不可解析不进行无意义重试；
- 外部服务超时、限流和临时网络错误可自动重试；
- 最终失败显示面向用户的可理解状态，并记录 `trace_id`；
- 不提供通用手动重试按钮；会议业务保留“重新分析”；
- 提供 `/health/live` 和 `/health/ready`；
- 结构化日志包含 trace、user（不可逆标识）、resource、job type、耗时和错误码；
- 记录模型耗时与 Token 用量，但不得记录敏感正文。

## 13. 性能目标

外部模型、搜索服务异常耗时不计入本地系统性能目标：

- 普通页面操作响应不超过 1 秒；
- 对话请求在 5 秒内开始流式输出；
- 文件上传后立即展示处理状态；
- 200 页以内 PDF 在 60 秒内完成文本解析；
- 默认 8 页 PPT 在 3 分钟内完成生成与预览；
- 支持 10 个并发用户完成核心流程。

性能测试必须把本地处理耗时与外部 Provider 耗时分开记录。

## 14. 测试与验收

### 14.1 自动化测试

- **单元测试**：风险 Schema、记忆冲突更新、分块、引用、RRF、权限 Scope、Pi 事件映射、工具策略；
- **集成测试**：数据库、BullMQ、文件生命周期、会话级联删除、SMTP/Search Adapter、Pi 自定义 Provider；
- **Agent Runtime 测试**：使用 Pi Faux Provider 覆盖文本流、工具调用、工具失败、abort、最大轮次、上下文恢复和 `agent_end` 落盘屏障；
- **端到端测试**：Playwright 覆盖注册登录、会话、上传、对话、会议、待办、记忆和 PPT；
- **契约测试**：所有外部 Provider 使用 Mock 响应验证成功、超时、限流、无配置和畸形响应；
- **安全测试**：跨用户 IDOR、路径穿越、恶意文件名、Token 失效和日志脱敏。

### 14.2 P0 验收场景

#### A. 对话与历史

1. 两名用户分别注册登录；
2. 用户 A 完成多轮流式对话并中止一次生成；
3. SSE 同时正确呈现文本增量和工具执行状态；
4. 重新打开历史会话后 Pi transcript 与界面消息完整恢复；
5. 用户 B 无法访问用户 A 的任何资源或调用绑定用户 A 资源的工具。

#### B. PDF 问答

1. 上传可提取文本的 PDF；
2. 状态从解析中变为可用；
3. 回答正确给出文件名和页码；
4. 多 PDF 可联合回答且引用可区分；
5. 无 Embedding 配置时 BM25 降级链路仍通过；
6. 无依据问题明确区分文件结论与常识补充；
7. 删除会话后原文件、解析内容和索引均不可再访问。

#### C. 会议风险闭环

1. 上传多个 UTF-8 TXT 和可选 PDF 背景；
2. 系统判断 TXT 合并或拆分为会议；
3. 输出固定结构与 AI 洞察；
4. 识别承诺未闭环风险并给出原文证据；
5. 自动生成字段完整的待办，缺失项为“待确认”；
6. 待办中心可筛选并更新四种状态；
7. SMTP 关闭时会议流程成功且显示未发送原因；
8. SMTP Mock 开启时每场会议只发送一封汇总邮件；
9. 新增 TXT 使用缓存增量分析，重新分析可绕过缓存。

#### D. 长期记忆

1. 对话和会议完成后异步生成用户记忆；
2. 需要记忆的问题自动触发检索，不需要的问题不检索；
3. 新事实覆盖当前值但保留旧版本；
4. 用户可查看、修改和删除；
5. 不同用户记忆严格隔离。

#### E. 联网搜索

1. 未开启开关时不调用 Provider；
2. 手动开启后回答包含链接和检索时间；
3. Provider 未配置时明确显示不可用；
4. 搜索来源随历史消息恢复。

#### F. PPT

1. 使用当前会话聊天、PDF 和搜索结果生成默认 8 页演示文稿；
2. 浏览器可逐页预览；
3. 下载文件为可编辑 PPTX；
4. 网页可修改文字、位置、尺寸、字号、颜色并新增文本框；
5. 保存编辑后创建新版本；
6. 所有历史版本均可查看和下载；
7. 导出文件不存在全页图片冒充可编辑内容的问题。

任一 P0 验收场景失败即视为不可交付。

## 15. 一键启动与交付物

项目必须提供：

- `docker compose up` 一键启动；
- 根目录 README：依赖、启动、配置、测试、演示流程、故障排查；
- `.env.example`，不包含真实凭据；
- 数据库迁移和可选演示数据；
- 自动化测试命令；
- Provider Mock 模式，使无搜索/邮件 Key 时仍可验证流程；
- 架构图、数据模型说明和 API 文档；
- 开源组件及许可证清单。

## 16. 关键风险与缓解

| 风险 | 影响 | 缓解措施 |
|---|---|---|
| PPTist 与 PptxGenJS 数据模型不完全兼容 | 在线编辑后导出失真 | 开发前做字体、图片、形状、文本框的双向 PoC；Slide JSON 作为源数据 |
| AGPL 合规 | 后续闭源产品化受限 | 正式产品化前法务/开源治理审查，保留修改记录 |
| LLM 结构化输出不稳定 | 风险、待办无法落库 | JSON Schema、Zod 校验、有限修复重试、证据强校验 |
| 多 TXT 会议归组误判 | 结果合并错误 | 保存归组置信度和线索；重新分析时允许模型重新归组 |
| 记忆污染 | 后续回答被错误事实影响 | 来源追踪、置信度、版本化、用户修正优先、按需召回 |
| 模型或搜索不可用 | 核心功能波动 | Adapter、超时、退避、明确状态；测试使用 Mock |
| 引用页码错误 | 用户不信任回答 | 按页解析、块携带页码、回答后执行引用一致性校验 |
| 本地文件泄漏 | 跨用户数据暴露 | 随机路径、鉴权下载、数据库用户范围、IDOR 自动化测试 |
| API Key 已在讨论中暴露 | 凭据被滥用 | 立即轮换；仅通过 `.env` 注入；日志和文档永不复写 |
| Pi Agent 上游 API/包名变化 | 构建或运行时行为漂移 | 锁定精确版本；只通过 `AgentRuntimePort` 使用；升级执行契约测试 |
| Agent 重复调用副作用工具 | 重复待办、邮件或 PPT 任务 | TypeBox 校验、`beforeToolCall` 策略、领域幂等键、顺序执行 |
| Agent Run 并发导致 transcript 分叉 | 历史错乱、重复工具执行 | 会话级 Redis 锁、单活 Run、事件序号唯一约束 |
| Agent 上下文过长 | 延迟和费用失控 | `prepareRequest` 统一预算、`transformContext` 压缩、工具结果截断 |

## 17. 实施顺序（不代表功能可裁减）

实施顺序只用于降低集成风险，所有 P0 能力仍须全部通过后才能交付：

1. Monorepo、Docker Compose、认证、数据库和用户隔离；
2. Pi Agent Runtime Port、Pi AI Provider、会话 transcript、事件桥和 SSE；
3. 文件存储、PDF 解析、BM25/向量检索和引用；
4. 会议增量分析、风险、待办和邮件；
5. 长期记忆抽取、版本更新和分层检索；
6. 联网搜索 Adapter 与来源展示；
7. PPT Slide JSON、模板、预览、简单编辑、导出和版本化；
8. Dify 风格整体 UI 打磨；
9. 完整 E2E、安全、性能测试与交付验收。

## 18. 必须先完成的技术 Spike

正式进入大规模实现前，必须用最小代码验证以下高风险点：

1. Pi AI 自定义 OpenAI-compatible Provider 能否通过当前服务完成 SSE、工具调用和所需结构化响应；
2. PPTist Slide JSON 到可编辑 PPTX 的导出保真度；
3. 保存网页编辑后生成新 PPTX 版本的链路；
4. `pdfjs-dist` 对中文 PDF 的逐页文本与页码映射；
5. 无 Embedding 时 Node.js BM25 在 200 页 PDF 上的构建和查询耗时；
6. pgvector 混合召回和用户/会话过滤不会跨租户泄漏；
7. 多 TXT 增量缓存与强制重分析的缓存失效策略。
8. Pi Agent `prepareRequest`、`beforeToolCall`、`afterToolCall`、abort 和 `agent_end` 持久化屏障是否满足当前事务语义。

Spike 不改变产品范围；若某方案验证失败，应替换实现方式并更新本 ADR，而不是删除对应能力。

## 19. 决策结果

本 ADR 作为当前 Demo 的正式范围与架构基线。后续如果变更会话模式、风险类型、数据隔离、PPT 编辑范围、外部 Provider 或部署形态，必须新增 ADR 或对本 ADR 形成显式修订记录，不能仅在代码中隐式改变行为。

## 20. 修订记录与参考

### Revision 1 - Pi Agent Runtime

- Agent 相关运行时统一改为 Pi Agent Core；
- 模型接入统一使用 Pi AI Provider/Model 机制；
- 新增 Agent transcript 恢复、工具策略、事件桥、取消、并发锁和幂等约束；
- NestJS 保留业务与基础设施职责，不再自建 Agent Loop；
- 设计验证基于 2026-09-24 可用的 `@earendil-works/pi-agent-core@0.87.1` 与 `@earendil-works/pi-ai@0.87.1`；实施时必须锁定精确版本。

参考：

- Pi Agent Core：<https://github.com/earendil-works/pi/tree/main/packages/agent>
- Pi AI：<https://github.com/earendil-works/pi/tree/main/packages/ai>
