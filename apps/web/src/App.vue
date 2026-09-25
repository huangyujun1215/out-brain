<script setup lang="ts">
import { RouterView, useRoute, useRouter } from "vue-router";
import { MessageSquarePlus, CheckSquare, Brain, LogOut, Sparkles } from "lucide-vue-next";
import { useAuthStore } from "./stores/auth";
const auth = useAuthStore(); const route = useRoute(); const router = useRouter();
async function logout() { await auth.logout(); router.push("/login"); }
</script>

<template>
  <RouterView v-if="route.path === '/login'" />
  <div v-else class="app-shell">
    <aside class="sidebar">
      <div class="brand"><span class="brand-mark"><Sparkles :size="18"/></span><div><strong>NBBOSS</strong><small>AI 外脑</small></div></div>
      <button class="new-chat" @click="router.push('/')"><MessageSquarePlus :size="17"/> 新建会话</button>
      <nav>
        <button :class="{active: route.path.startsWith('/chat') || route.path === '/'}" @click="router.push('/')"><MessageSquarePlus :size="17"/>对话</button>
        <button :class="{active: route.path === '/todos'}" @click="router.push('/todos')"><CheckSquare :size="17"/>待办中心</button>
        <button :class="{active: route.path === '/memories'}" @click="router.push('/memories')"><Brain :size="17"/>记忆管理</button>
      </nav>
      <div class="sidebar-footer"><span class="avatar">{{ auth.user?.username?.slice(0, 1).toUpperCase() }}</span><span>{{ auth.user?.username }}</span><button title="退出" @click="logout"><LogOut :size="16"/></button></div>
    </aside>
    <main class="main"><RouterView /></main>
  </div>
</template>
