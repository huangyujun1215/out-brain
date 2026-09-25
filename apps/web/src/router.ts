import { createRouter, createWebHistory } from "vue-router";
import LoginView from "./views/LoginView.vue";
import ChatView from "./views/ChatView.vue";
import TodosView from "./views/TodosView.vue";
import MemoriesView from "./views/MemoriesView.vue";
import PresentationView from "./views/PresentationView.vue";

export const router = createRouter({ history: createWebHistory(), routes: [
  { path: "/login", component: LoginView },
  { path: "/", component: ChatView },
  { path: "/chat/:id", component: ChatView },
  { path: "/todos", component: TodosView },
  { path: "/memories", component: MemoriesView },
  { path: "/presentations/:id", component: PresentationView },
] });

router.beforeEach((to) => {
  const loggedIn = Boolean(localStorage.getItem("nbboss-user"));
  if (!loggedIn && to.path !== "/login") return "/login";
  if (loggedIn && to.path === "/login") return "/";
});
