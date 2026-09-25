import { Controller, Delete, Get, Param, Post, Res, UploadedFile, UseGuards, UseInterceptors } from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import type { Response } from "express";
import { CurrentUser, type AuthUser } from "../../common/current-user.js";
import { JwtAuthGuard } from "../auth/jwt-auth.guard.js";
import { FilesService } from "./files.service.js";

@Controller() @UseGuards(JwtAuthGuard)
export class FilesController {
  constructor(private readonly files: FilesService) {}

  @Post("conversations/:conversationId/files") @UseInterceptors(FileInterceptor("file", { limits: { fileSize: 20 * 1024 * 1024 } }))
  async upload(@CurrentUser() user: AuthUser, @Param("conversationId") conversationId: string, @UploadedFile() file: Express.Multer.File) {
    const asset = await this.files.save(user.id, conversationId, file);
    return { id: asset.id, conversationId: asset.conversationId, kind: asset.kind, originalName: asset.originalName, mimeType: asset.mimeType, size: asset.size, status: asset.status, errorMessage: asset.errorMessage, createdAt: asset.createdAt };
  }

  @Get("files/:id")
  async download(@CurrentUser() user: AuthUser, @Param("id") id: string, @Res() res: Response) {
    const file = await this.files.get(user.id, id);
    res.download(file.storagePath, file.originalName);
  }

  @Delete("files/:id") remove(@CurrentUser() user: AuthUser, @Param("id") id: string) { return this.files.remove(user.id, id); }
}
