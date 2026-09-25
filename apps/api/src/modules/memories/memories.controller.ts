import { Body, Controller, Delete, Get, Param, Patch, UseGuards } from "@nestjs/common";
import { z } from "zod";
import { CurrentUser, type AuthUser } from "../../common/current-user.js";
import { JwtAuthGuard } from "../auth/jwt-auth.guard.js";
import { MemoriesService } from "./memories.service.js";

@Controller("memories") @UseGuards(JwtAuthGuard)
export class MemoriesController {
  constructor(private readonly memories: MemoriesService) {}
  @Get() list(@CurrentUser() user: AuthUser) { return this.memories.list(user.id); }
  @Patch("facts/:id") update(@CurrentUser() user: AuthUser, @Param("id") id: string, @Body() body: unknown) {
    return this.memories.update(user.id, id, z.object({ value: z.string().trim().min(1).max(2000) }).parse(body).value);
  }
  @Delete(":id") remove(@CurrentUser() user: AuthUser, @Param("id") id: string) { return this.memories.remove(user.id, id); }
}
