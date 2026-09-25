import { Body, Controller, Delete, Get, Param, Patch, Query, UseGuards } from "@nestjs/common";
import { updateTodoSchema } from "@nbboss/contracts";
import { CurrentUser, type AuthUser } from "../../common/current-user.js";
import { JwtAuthGuard } from "../auth/jwt-auth.guard.js";
import { TodosService } from "./todos.service.js";

@Controller("todos") @UseGuards(JwtAuthGuard)
export class TodosController {
  constructor(private readonly todos: TodosService) {}
  @Get() list(@CurrentUser() user: AuthUser, @Query("status") status?: string, @Query("owner") owner?: string, @Query("dueFrom") dueFrom?: string, @Query("dueTo") dueTo?: string) {
    return this.todos.list(user.id, { status, owner, dueFrom, dueTo });
  }
  @Patch(":id") update(@CurrentUser() user: AuthUser, @Param("id") id: string, @Body() body: unknown) {
    const value = updateTodoSchema.parse(body);
    return this.todos.update(user.id, id, { ...value, dueAt: value.dueAt === undefined ? undefined : value.dueAt === null ? null : new Date(value.dueAt) });
  }
  @Delete(":id") remove(@CurrentUser() user: AuthUser, @Param("id") id: string) { return this.todos.remove(user.id, id); }
}
