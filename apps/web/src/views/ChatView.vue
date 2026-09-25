<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { marked } from "marked"; import DOMPurify from "dompurify";
import { api, streamMessage } from "../api";
import { Bot, Download, FileText, Globe2, Paperclip, Plus, Presentation, Send, Square, Trash2, Users } from "lucide-vue-next";

type Conversation = { id:string; title:string; mode:"CHAT"|"MEETING"; updatedAt:string };
type SearchSource = { title:string; url:string; snippet:string; retrievedAt:string };
type Message = { id:string; role:string; content:string; status:string; searchRuns?:Array<{id:string;query:string;searchedAt:string;sources:SearchSource[]}> };
type FileItem = { id:string; originalName:string; kind:string; status:string; errorMessage?:string };
type Meeting = { id:string; title:string; analysis:any; risks:Array<{id:string;severity:string;description:string;evidence:Array<{quote:string;fileName:string;page?:number}>}>; todos:Array<{id:string;title:string;owner:string;dueAt?:string}>; emails:Array<{id:string;status:string;errorCode?:string;sentAt?:string}> };
type PresentationItem = { id:string; title:string; status:"PENDING"|"PROCESSING"|"READY"|"FAILED"; progress:number; errorMessage?:string; versions:any[] };
type Detail = { id:string; title:string; mode:string; meetingStatus?:"PROCESSING"|"READY"|"FAILED"; meetingErrorMessage?:string; messages:Message[]; files:FileItem[]; meetings:Meeting[]; presentations:PresentationItem[] };

const route = useRoute(); const router = useRouter();
const conversations = ref<Conversation[]>([]); const detail = ref<Detail|null>(null); const content = ref(""); const webSearch = ref(false); const streaming = ref(false); const streamText = ref(""); const runId = ref(""); const error = ref(""); const fileInput = ref<HTMLInputElement>(); const scroll = ref<HTMLElement>(); const artifactOpen = ref(true); let aborter: AbortController | null = null;
const capabilities=ref({search:false,smtp:false,embedding:false,vision:false});

const currentId = computed(() => route.params.id as string | undefined);
const activeTools = ref<Array<{ id:string; name:string; status:"RUNNING"|"COMPLETED"|"FAILED" }>>([]);
function toolLabel(name:string) { return ({ retrieve_documents:"检索会话文件", retrieve_memory:"检索长期记忆", search_web:"联网搜索", analyze_meeting:"分析会议", create_todos:"创建待办", generate_presentation:"生成 PPT" } as Record<string,string>)[name] ?? name; }
async function loadList() { conversations.value = await api<Conversation[]>("/conversations"); }
async function loadDetail() { if (!currentId.value) { detail.value = null; return; } detail.value = await api<Detail>(`/conversations/${currentId.value}`); await nextTick(); scroll.value?.scrollTo({ top: scroll.value.scrollHeight }); }
async function create(mode:"CHAT"|"MEETING") { const value = await api<Conversation>("/conversations", { method:"POST", body:JSON.stringify({ mode }) }); await loadList(); router.push(`/chat/${value.id}`); }
async function remove(id:string) { if (!confirm("删除后聊天、文件、索引、会议待办、PPT 及该会话来源的自动记忆均不可恢复；用户手工修正的记忆保留。确认删除？")) return; await api(`/conversations/${id}`, { method:"DELETE" }); await loadList(); if (currentId.value === id) router.push("/"); }
async function send() {
  if (!content.value.trim() || !currentId.value || streaming.value) return;
  const text = content.value; content.value = ""; streaming.value = true; streamText.value = ""; error.value = ""; runId.value = ""; activeTools.value = []; aborter = new AbortController();
  detail.value?.messages.push({ id:crypto.randomUUID(), role:"USER", content:text, status:"COMPLETED" });
  try { await streamMessage(currentId.value, text, webSearch.value, (event) => { if (event.runId) runId.value = event.runId; if (event.type === "message.delta") streamText.value += event.delta; if (event.type === "message.completed") streamText.value = event.content; if(event.type === "tool.started") activeTools.value.push({id:event.toolCallId,name:event.toolName,status:"RUNNING"}); if(event.type === "tool.completed"){const tool=activeTools.value.find(item=>item.id===event.toolCallId);if(tool)tool.status=event.isError?"FAILED":"COMPLETED";} if(event.type === "run.failed") error.value=event.message??"生成失败"; nextTick(() => scroll.value?.scrollTo({ top: scroll.value!.scrollHeight, behavior:"smooth" })); }, aborter.signal); await loadDetail(); await loadList(); }
  catch (e) { if ((e as Error).name !== "AbortError") error.value = e instanceof Error ? e.message : "生成失败"; }
  finally { streaming.value = false; streamText.value = ""; aborter = null; }
}
async function stop() { if (runId.value && currentId.value) await api(`/conversations/${currentId.value}/runs/${runId.value}/abort`, { method:"POST" }).catch(()=>{}); aborter?.abort(); streaming.value = false; }
async function upload(event:Event) { const input = event.target as HTMLInputElement; if (!input.files?.length || !currentId.value) return; error.value=""; try { for (const file of [...input.files]) { const form = new FormData(); form.append("file", file); await api(`/conversations/${currentId.value}/files`, { method:"POST", body:form }); } await loadDetail(); for(let i=0;i<180;i++){const busy=detail.value?.files.some(f=>f.status==='PENDING'||f.status==='PROCESSING')||detail.value?.meetingStatus==='PROCESSING';if(!busy)break;await new Promise(r=>setTimeout(r,1000));await loadDetail();} } catch(e) { error.value=e instanceof Error?e.message:"上传失败"; } finally { input.value=""; } }
async function removeFile(id:string) { if(!confirm("删除文件后将同步清理索引，会议文件变化还会触发重新分析。确认删除？"))return; await api(`/files/${id}`,{method:"DELETE"});await loadDetail(); }
async function reanalyze() { if (!currentId.value) return; error.value=""; try { await api(`/conversations/${currentId.value}/meetings/reanalyze`, { method:"POST" }); await loadDetail(); artifactOpen.value=true; for(let i=0;i<180&&detail.value?.meetingStatus==='PROCESSING';i++){await new Promise(r=>setTimeout(r,1000));await loadDetail();} } catch(e) { error.value=e instanceof Error?e.message:"分析失败"; } }
async function generatePpt() { if (!currentId.value) return; const prompt=window.prompt("请输入 PPT 要求", "基于当前会话生成一份专业汇报 PPT"); if (!prompt) return; try { await api(`/conversations/${currentId.value}/presentations`, { method:"POST", body:JSON.stringify({prompt,idempotencyKey:crypto.randomUUID()}) }); await loadDetail(); artifactOpen.value=true; void pollPresentations(); } catch(e){error.value=e instanceof Error?e.message:"生成失败";} }
async function pollPresentations(){for(let i=0;i<180;i++){if(!detail.value?.presentations.some(p=>p.status==='PENDING'||p.status==='PROCESSING'))return;await new Promise(r=>setTimeout(r,2000));await loadDetail();}}
function html(text:string) { return DOMPurify.sanitize(marked.parse(text) as string); }
function safeLink(value:string) { try { const url=new URL(value); return url.protocol==='http:'||url.protocol==='https:'?url.href:undefined; } catch { return undefined; } }
watch(currentId, async()=>{await loadDetail();if(detail.value?.presentations.some(p=>p.status==='PENDING'||p.status==='PROCESSING'))void pollPresentations();}); onMounted(async()=>{if(window.innerWidth<=1100)artifactOpen.value=false;capabilities.value=await api("/health/capabilities");await loadList(); await loadDetail();if(detail.value?.presentations.some(p=>p.status==='PENDING'||p.status==='PROCESSING'))void pollPresentations();});
</script>

<template>
<div class="workspace">
  <section class="history-pane">
    <div class="pane-title">会话记录</div>
    <div class="history-list"><button v-for="item in conversations" :key="item.id" :class="['history-item',{selected:item.id===currentId}]" @click="router.push(`/chat/${item.id}`)"><span class="mode-dot" :class="item.mode.toLowerCase()"></span><span>{{ item.title }}</span><Trash2 :size="14" @click.stop="remove(item.id)"/></button></div>
  </section>
  <section class="chat-pane">
    <template v-if="!detail">
      <div class="empty-create"><span class="hero-icon"><Bot/></span><h1>今天想一起推进什么？</h1><p>选择一种固定会话模式开始。模式创建后不可切换。</p><div class="mode-cards"><button @click="create('CHAT')"><Plus/><strong>普通对话</strong><small>聊天、PDF 问答、联网搜索与 PPT</small></button><button @click="create('MEETING')"><Users/><strong>会议分析</strong><small>上传会议 TXT，识别风险并生成待办</small></button></div></div>
    </template>
    <template v-else>
      <header class="chat-header"><div><h2>{{ detail.title }}</h2><span class="badge">{{ detail.mode === 'MEETING' ? '会议分析' : '普通对话' }}</span></div><button class="ghost" @click="artifactOpen=!artifactOpen">{{ artifactOpen?'隐藏':'显示' }}产物</button></header>
      <div ref="scroll" class="messages">
        <div v-if="!detail.messages.length" class="conversation-empty"><Bot :size="30"/><h3>{{ detail.mode==='MEETING'?'上传会议原文开始分析':'开始你的第一个问题' }}</h3><p>{{ detail.mode==='MEETING'?'支持多个 UTF-8 TXT，也可以上传 PDF 作为背景。':'可以上传 PDF 作为本次会话的知识背景。' }}</p></div>
        <article v-for="message in detail.messages.filter(m=>m.role==='USER'||m.role==='ASSISTANT')" :key="message.id" :class="['message',message.role.toLowerCase()]">
          <div class="message-avatar">{{ message.role==='USER'?'你':'AI' }}</div><div class="message-body"><div v-html="html(message.content)"></div><div v-if="message.searchRuns?.length" class="search-sources"><b>联网来源</b><template v-for="run in message.searchRuns" :key="run.id"><small>{{new Date(run.searchedAt).toLocaleString()}} · {{run.query}}</small><a v-for="source in run.sources.filter(item=>safeLink(item.url))" :key="source.url" :href="safeLink(source.url)" target="_blank" rel="noopener noreferrer">{{source.title}}</a></template></div></div>
        </article>
        <article v-if="streaming && streamText" class="message assistant"><div class="message-avatar">AI</div><div class="message-body" v-html="html(streamText)"></div></article>
        <div v-if="activeTools.length" class="tool-activity" aria-live="polite"><div v-for="tool in activeTools" :key="tool.id" :class="['tool-state',tool.status.toLowerCase()]"><span class="tool-dot"></span><b>{{toolLabel(tool.name)}}</b><span>{{tool.status==='RUNNING'?'执行中…':tool.status==='COMPLETED'?'已完成':'执行失败'}}</span></div></div>
        <p v-if="error" class="error callout">{{ error }}</p>
      </div>
      <div class="composer-wrap">
        <div v-if="detail.files.length" class="attachment-row"><span v-for="file in detail.files" :key="file.id" :class="['file-chip',file.status.toLowerCase()]" :title="file.errorMessage"><FileText :size="14"/>{{ file.originalName }} · {{ file.status }}</span></div>
        <div class="composer"><textarea v-model="content" rows="2" placeholder="输入消息，Shift + Enter 换行" @keydown.enter.exact.prevent="send"></textarea><div class="composer-actions"><div><input ref="fileInput" hidden type="file" multiple :accept="detail.mode==='MEETING'?'.pdf,.txt':'.pdf'" @change="upload"/><button title="上传文件" @click="fileInput?.click()"><Paperclip :size="18"/></button><button :class="{enabled:webSearch}" :disabled="!capabilities.search" :title="capabilities.search?'联网搜索':'联网搜索未配置'" @click="webSearch=!webSearch"><Globe2 :size="18"/> {{capabilities.search?'联网':'联网未配置'}}</button><button title="生成 PPT" @click="generatePpt"><Presentation :size="18"/> PPT</button><button v-if="detail.mode==='MEETING'" :disabled="detail.meetingStatus==='PROCESSING'" @click="reanalyze"><Users :size="18"/> {{detail.meetingStatus==='PROCESSING'?'分析中':'重新分析'}}</button></div><button v-if="streaming" class="send" @click="stop"><Square :size="17"/></button><button v-else class="send" :disabled="!content.trim()" @click="send"><Send :size="17"/></button></div></div>
        <small>AI 可能犯错。文件引用和行动项请结合原文核对；对话与上传内容会发送至已配置的外部模型服务处理。</small>
      </div>
    </template>
  </section>
  <aside v-if="detail && artifactOpen" class="artifact-pane"><div class="pane-title">会话产物</div><div class="artifact-content">
    <section><h3>文件</h3><div v-if="!detail.files.length" class="muted">暂无文件</div><div v-for="file in detail.files" :key="file.id" class="artifact-card"><FileText :size="18"/><div><strong>{{file.originalName}}</strong><small>{{file.kind}} · {{file.status}}</small></div><a class="icon" :href="`/api/files/${file.id}`" target="_blank" title="下载"><Download :size="15"/></a><button class="icon danger" title="删除" @click="removeFile(file.id)"><Trash2 :size="15"/></button></div></section>
    <section v-if="detail.mode==='MEETING'"><h3>会议分析</h3><div v-if="detail.meetingStatus==='PROCESSING'" class="muted">会议材料正在后台分析…</div><div v-else-if="detail.meetingStatus==='FAILED'" class="error callout">{{detail.meetingErrorMessage}}</div><div v-for="meeting in detail.meetings" :key="meeting.id" class="analysis-card"><strong>{{meeting.title}}</strong><p>{{meeting.analysis.summary}}</p><details><summary>结构化纪要</summary><small>参与人：{{meeting.analysis.participants?.join('、')||'待确认'}}</small><small>时间：{{meeting.analysis.time||'待确认'}} · 地点：{{meeting.analysis.location||'待确认'}}</small><p><b>主题：</b>{{meeting.analysis.topics?.join('；')||'无'}}</p><p><b>结论：</b>{{meeting.analysis.decisions?.join('；')||'无'}}</p><p><b>承诺：</b>{{meeting.analysis.commitments?.join('；')||'无'}}</p><p><b>AI 洞察：</b>{{meeting.analysis.insights?.join('；')||'无'}}</p></details><div v-for="risk in meeting.risks" :key="risk.id" class="risk"><span>{{risk.severity}}</span>{{risk.description}}<small v-for="e in risk.evidence" :key="e.quote">证据：{{e.quote}}（{{e.fileName}}{{e.page?` 第${e.page}页`:''}}）</small></div><div v-for="todo in meeting.todos" :key="todo.id" class="meeting-todo">待办：{{todo.title}} · {{todo.owner||'待确认'}} · {{todo.dueAt?new Date(todo.dueAt).toLocaleString():'待确认'}}</div><small v-for="mail in meeting.emails" :key="mail.id" class="mail-state">邮件：{{mail.status==='DISABLED'?'未发送（SMTP 未配置）':mail.status==='SENT'?'已发送':mail.status==='FAILED'?'发送失败':'发送中'}}</small></div></section>
    <section v-if="detail.presentations?.length"><h3>PPT</h3><button v-for="ppt in detail.presentations" :key="ppt.id" :class="['artifact-card',{clickable:ppt.status==='READY'}]" :disabled="ppt.status!=='READY'" @click="ppt.status==='READY'&&router.push(`/presentations/${ppt.id}`)"><Presentation :size="18"/><div><strong>{{ppt.title}}</strong><small v-if="ppt.status==='READY'">{{ppt.versions.length}} 个版本 · 可预览编辑</small><small v-else-if="ppt.status==='FAILED'" class="error">生成失败：{{ppt.errorMessage}}</small><small v-else>后台生成中 · {{ppt.progress}}%</small></div></button></section>
  </div></aside>
</div>
</template>
