# 开源组件与许可证清单

本文件覆盖当前直接运行时依赖；精确版本由 `pnpm-lock.yaml` 锁定。发布前应执行 `pnpm licenses list --prod` 生成完整传递依赖清单并由法务复核。

| 组件 | 版本 | 许可证 |
|---|---:|---|
| @earendil-works/pi-agent-core / pi-ai | 0.87.1 | MIT |
| NestJS | 11.1.x | MIT |
| Vue / Vue Router / Pinia | 3.5.22 / 4.6.3 / 3.0.3 | MIT |
| Prisma Client | 6.19.0 | Apache-2.0 |
| BullMQ / ioredis | 5.61.2 / 5.8.2 | MIT |
| pdfjs-dist | 5.4.394 | Apache-2.0 |
| PptxGenJS | 4.0.1 | MIT |
| DOMPurify | 3.3.0 | MPL-2.0 OR Apache-2.0 |
| Zod / TypeBox | 4.1.11 / 1.0.64 | MIT |
| Argon2 | 0.44.0 | MIT |
| Nodemailer | 7.0.10 | MIT-0 |
| Lucide Vue Next | 0.552.0 | ISC |
| marked | 16.4.1 | MIT |
| RxJS | 7.8.2 | Apache-2.0 |

PPTist 目前仅作为交互和数据结构参考，**未复制、打包或分发其源码**，因此当前构建不引入其 AGPL-3.0 代码。若后续实际集成 PPTist，必须在合并前单独完成 AGPL 网络服务与源码提供义务评审。
