# 数据模型说明

PostgreSQL 是业务数据与 Pi Agent transcript 的唯一权威来源；Redis 只承担 BullMQ 和短期分布式锁。

- **User / RefreshToken**：账号与 Refresh Token 哈希。
- **Conversation**：用户归属、不可变模式、会议处理状态。
- **Message**：可见对话及隐藏的 Pi assistant/toolResult transcript；`metadata.piMessage` 用于精确恢复。
- **AgentRun / AgentEvent / ToolExecution**：Run 状态、事件顺序、工具审计、Token 用量和耗时。
- **FileAsset / DocumentPage / DocumentChunk**：随机路径原件、按页文本、带页码和字符偏移的分块、可选 pgvector。
- **Meeting / MeetingDocument / Risk / Todo / EmailDelivery**：会议聚合、缓存键、证据风险、AI 待办与邮件结果。
- **MemoryEntity / MemoryFact**：实体-属性-值事实链；`supersededById` 保留版本，`observedAt` 防止异步旧任务覆盖新值，`userEdited` 保护人工修正。
- **SearchRun**：一次回答可对应多次查询，保存查询、检索时间和来源。
- **Presentation / PresentationVersion**：异步 Artifact 状态；Slide JSON 为源数据，PPTX 为每版不可变导出物。

所有用户资源通过 User→Conversation 或显式 `userId` 形成租户边界。除服务层所有查询都带用户范围外，数据库触发器还会拒绝 AgentRun/FileAsset/Todo 的冗余 `userId` 与父资源不一致，以及 MeetingDocument 跨会话关联。外键使用级联删除；会话删除后还会递归删除对应随机存储目录。重新分析或删除会议来源时，会同步移除相应自动记忆并重建剩余历史链，用户手工修正不被静默删除。
