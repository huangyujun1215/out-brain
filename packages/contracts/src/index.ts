import { z } from "zod";

export const conversationModeSchema = z.enum(["CHAT", "MEETING"]);
export type ConversationMode = z.infer<typeof conversationModeSchema>;

export const createConversationSchema = z.object({
  mode: conversationModeSchema,
  title: z.string().trim().min(1).max(100).optional(),
});

export const sendMessageSchema = z.object({
  content: z.string().trim().min(1).max(50_000),
  webSearch: z.boolean().default(false),
});

export const todoStatusSchema = z.enum(["PENDING", "IN_PROGRESS", "COMPLETED", "CANCELLED"]);

export const updateTodoSchema = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  description: z.string().max(10_000).optional(),
  owner: z.string().trim().min(1).max(100).optional(),
  dueAt: z.string().datetime().nullable().optional(),
  status: todoStatusSchema.optional(),
});

export const memoryTypeSchema = z.enum(["PERSON", "TIME", "LOCATION", "TOPIC", "RELATION"]);

export const memoryFactSchema = z.object({
  entityType: memoryTypeSchema,
  entityName: z.string().trim().min(1).max(200),
  attribute: z.string().trim().min(1).max(100),
  value: z.string().trim().min(1).max(2_000),
  confidence: z.number().min(0).max(1).default(0.7),
  effectiveAt: z.string().datetime().nullable().optional(),
});

export const meetingEvidenceSchema = z.object({
  fileId: z.string().uuid(),
  fileName: z.string(),
  quote: z.string().min(1),
  page: z.number().int().positive().optional(),
});

export const meetingTodoSchema = z.object({
  title: z.string().min(1).max(200),
  description: z.string().max(10_000),
  owner: z.string().default("待确认"),
  dueAt: z.string().datetime().nullable().optional(),
});

export const meetingRiskSchema = z.object({
  severity: z.enum(["LOW", "MEDIUM", "HIGH"]),
  description: z.string().min(1),
  evidence: z.array(meetingEvidenceSchema).min(1),
  todo: meetingTodoSchema,
});

export const meetingAnalysisSchema = z.object({
  sourceFileIds: z.array(z.string().uuid()).default([]),
  title: z.string().min(1),
  summary: z.string(),
  participants: z.array(z.string()),
  time: z.string().nullable(),
  location: z.string().nullable(),
  topics: z.array(z.string()),
  decisions: z.array(z.string()),
  commitments: z.array(z.string()),
  risks: z.array(meetingRiskSchema),
  insights: z.array(z.string()),
  grouping: z.enum(["SAME_MEETING", "DIFFERENT_MEETINGS", "UNKNOWN"]).default("UNKNOWN"),
});

export const slideElementSchema = z.object({
  id: z.string(),
  type: z.enum(["text", "shape"]),
  text: z.string().default(""),
  x: z.number().min(0).max(13.333),
  y: z.number().min(0).max(7.5),
  w: z.number().positive().max(13.333),
  h: z.number().positive().max(7.5),
  fontSize: z.number().min(8).max(72).default(20),
  color: z.string().regex(/^[0-9A-Fa-f]{6}$/).default("111827"),
  fill: z.string().regex(/^[0-9A-Fa-f]{6}$/).optional(),
  bold: z.boolean().default(false),
}).superRefine((element, context) => {
  if (element.x + element.w > 13.3331) context.addIssue({ code: "custom", message: "元素超出演示文稿横向画布", path: ["w"] });
  if (element.y + element.h > 7.5001) context.addIssue({ code: "custom", message: "元素超出演示文稿纵向画布", path: ["h"] });
});

export const slideSchema = z.object({
  id: z.string(),
  title: z.string(),
  elements: z.array(slideElementSchema),
  notes: z.string().default(""),
});

export const presentationSchema = z.object({
  title: z.string().min(1),
  slides: z.array(slideSchema).min(1).max(30),
});

export type MeetingAnalysis = z.infer<typeof meetingAnalysisSchema>;
export type PresentationDocument = z.infer<typeof presentationSchema>;

export type AgentEvent =
  | { type: "run.started"; runId: string }
  | { type: "message.delta"; runId: string; delta: string }
  | { type: "message.completed"; runId: string; messageId: string; content: string }
  | { type: "tool.started"; runId: string; toolCallId: string; toolName: string }
  | { type: "tool.completed"; runId: string; toolCallId: string; toolName: string; isError: boolean }
  | { type: "artifact.created"; runId: string; artifactType: "presentation" | "meeting"; artifactId: string }
  | { type: "run.completed"; runId: string }
  | { type: "run.failed"; runId: string; code: string; message: string }
  | { type: "run.aborted"; runId: string };
