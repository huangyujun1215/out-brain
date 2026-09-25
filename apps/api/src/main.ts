import "reflect-metadata";
import cookieParser from "cookie-parser";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module.js";
import { HttpExceptionFilter } from "./common/http-exception.filter.js";

if (process.env.WORKER_MODE === "true") {
  const worker = await NestFactory.createApplicationContext(AppModule);
  worker.enableShutdownHooks();
} else {
  const app = await NestFactory.create(AppModule, { cors: false });
  app.setGlobalPrefix("api");
  app.use(cookieParser());
  app.useGlobalFilters(new HttpExceptionFilter());
  app.enableCors({ origin: process.env.WEB_ORIGIN ?? "http://localhost:3000", credentials: true });
  app.enableShutdownHooks();
  await app.listen(Number(process.env.API_PORT ?? 3001), "0.0.0.0");
}
