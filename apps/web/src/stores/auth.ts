import { defineStore } from "pinia";
import { api } from "../api";

export const useAuthStore = defineStore("auth", {
  state: () => ({ user: JSON.parse(localStorage.getItem("nbboss-user") ?? "null") as null | { id: string; username: string } }),
  actions: {
    async login(username: string, password: string, register = false) {
      const result = await api<{ user: { id: string; username: string } }>(`/auth/${register ? "register" : "login"}`, { method: "POST", body: JSON.stringify({ username, password }) });
      this.user = result.user; localStorage.setItem("nbboss-user", JSON.stringify(result.user));
    },
    async logout() { await api("/auth/logout", { method: "POST" }); this.user = null; localStorage.removeItem("nbboss-user"); },
  },
});
