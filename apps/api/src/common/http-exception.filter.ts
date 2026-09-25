import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus } from "@nestjs/common";
import type { Response } from "express";
import { ZodError } from "zod";
import { randomUUID } from "node:crypto";
import { safeErrorMeta } from "./safe-error.js";

@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  catch(error: unknown, host: ArgumentsHost) {
    const response = host.switchToHttp().getResponse<Response>();
    const traceId = randomUUID();
    if (error instanceof ZodError) return response.status(HttpStatus.BAD_REQUEST).json({ statusCode: 400, code: "VALIDATION_ERROR", message: error.issues.map((issue) => issue.message), traceId });
    if (error instanceof Error && error.name === "MulterError") {
      const code = (error as Error & { code?: string }).code;
      return response.status(HttpStatus.BAD_REQUEST).json({ statusCode: 400, code: code === "LIMIT_FILE_SIZE" ? "FILE_TOO_LARGE" : "UPLOAD_INVALID", message: code === "LIMIT_FILE_SIZE" ? "文件超过允许的大小限制" : "上传文件无效", traceId });
    }
    if (error instanceof HttpException) {
      if (error.getStatus() === HttpStatus.PAYLOAD_TOO_LARGE) {
        return response.status(HttpStatus.PAYLOAD_TOO_LARGE).json({ statusCode: 413, code: "FILE_TOO_LARGE", message: "文件超过允许的大小限制（PDF 20 MB，TXT 5 MB）", traceId });
      }
      const body = error.getResponse();
      return response.status(error.getStatus()).json(typeof body === "string" ? { statusCode: error.getStatus(), message: body, traceId } : { ...(body as object), traceId });
    }
    console.error(JSON.stringify({ level: "error", traceId, ...safeErrorMeta(error) }));
    return response.status(500).json({ statusCode: 500, code: "INTERNAL_ERROR", message: "系统暂时不可用，请稍后再试", traceId });
  }
}
