import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { HealthController } from "./health.controller.js";
import { PrismaService } from "./infra/prisma.service.js";
import { AuthController } from "./modules/auth/auth.controller.js";
import { AuthService } from "./modules/auth/auth.service.js";
import { JwtAuthGuard } from "./modules/auth/jwt-auth.guard.js";
import { ConversationsController } from "./modules/conversations/conversations.controller.js";
import { ConversationsService } from "./modules/conversations/conversations.service.js";
import { FilesController } from "./modules/files/files.controller.js";
import { FilesService } from "./modules/files/files.service.js";
import { RetrievalService } from "./modules/files/retrieval.service.js";
import { AgentRuntimeService } from "./modules/agent/agent-runtime.service.js";
import { AGENT_RUNTIME_PORT } from "./modules/agent/agent-runtime.port.js";
import { MemoriesController } from "./modules/memories/memories.controller.js";
import { MemoriesService } from "./modules/memories/memories.service.js";
import { TodosController } from "./modules/todos/todos.controller.js";
import { TodosService } from "./modules/todos/todos.service.js";
import { MeetingsController } from "./modules/meetings/meetings.controller.js";
import { MeetingsService } from "./modules/meetings/meetings.service.js";
import { PresentationsController } from "./modules/presentations/presentations.controller.js";
import { PresentationsService } from "./modules/presentations/presentations.service.js";
import { SearchService } from "./modules/search/search.service.js";
import { MailService } from "./modules/mail/mail.service.js";
import { PiModelsService } from "./modules/agent/pi-models.service.js";
import { EmbeddingService } from "./modules/files/embedding.service.js";
import { RedisService } from "./infra/redis.service.js";
import { JobsService } from "./infra/jobs.service.js";
import { JobsProcessor } from "./infra/jobs.processor.js";

@Module({
  imports: [ConfigModule.forRoot({ isGlobal: true, envFilePath: [".env", "../../.env"] })],
  controllers: [
    HealthController,
    AuthController,
    ConversationsController,
    FilesController,
    MemoriesController,
    TodosController,
    MeetingsController,
    PresentationsController,
  ],
  providers: [
    PrismaService,
    AuthService,
    JwtAuthGuard,
    ConversationsService,
    FilesService,
    RetrievalService,
    AgentRuntimeService,
    { provide: AGENT_RUNTIME_PORT, useExisting: AgentRuntimeService },
    MemoriesService,
    TodosService,
    MeetingsService,
    PresentationsService,
    SearchService,
    MailService,
    PiModelsService,
    EmbeddingService,
    RedisService,
    JobsService,
    JobsProcessor,
  ],
})
export class AppModule {}
